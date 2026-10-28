import { ordinaryWakeRequestPredicate } from "../modules/wake-queue/index.js";
import { and, eq, notInArray } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, toolMcpGateways, toolMcpGatewayTokens, type Db } from "@paperclipai/db";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import type { heartbeatService } from "./heartbeat.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import { resolveNativeRuntimeMcpSnapshot } from "./native-runtime/runtime-context.js";

type Heartbeat = ReturnType<typeof heartbeatService>;

export type ConnectionToolRefresh = "not_needed" | "requested" | "deduplicated" | "unavailable";

type ReadyCandidate = { state: string; interactionId: string | null; connectionId: string | null; instruction: string };

const QUEUED_INSTRUCTION = "Access is already authorized. A continuation with updated tools is queued. Finish independent work, then yield. Do not request authorization again.";
const UNAVAILABLE_INSTRUCTION = "Access is already authorized, but this run started without these tools and no continuation could be scheduled. Report this to the responsible user. Do not request authorization again.";

export async function refreshReadyConnectionTools<T extends ReadyCandidate>(
  db: Db,
  heartbeat: Pick<Heartbeat, "wakeup">,
  claims: RuntimeToolsTokenClaims,
  result: T,
): Promise<T | (T & { toolRefresh: ConnectionToolRefresh })> {
  if (result.state !== "ready" || result.interactionId !== null || !result.connectionId) return result;
  const current = await resolveNativeRuntimeMcpSnapshot({ db, agent: { id: claims.sub, companyId: claims.company_id }, runId: claims.run_id });
  if (!current.bindingId) return { ...result, toolRefresh: "not_needed" };
  const delivered = await db.select({ metadata: toolMcpGateways.metadata }).from(toolMcpGatewayTokens)
    .innerJoin(toolMcpGateways, eq(toolMcpGateways.id, toolMcpGatewayTokens.gatewayId))
    .where(and(
      eq(toolMcpGatewayTokens.companyId, claims.company_id),
      eq(toolMcpGatewayTokens.subjectType, "heartbeat_run"),
      eq(toolMcpGatewayTokens.subjectId, claims.run_id),
      eq(toolMcpGateways.agentId, claims.sub),
    ));
  if (delivered.some(row => row.metadata?.nativeRuntimeAssignmentDigest === current.digest)) {
    return { ...result, toolRefresh: "not_needed" };
  }
  const idempotencyKey = `connection-intent:tools:${claims.run_id}:${current.digest}`;
  const queued = async () => (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    ordinaryWakeRequestPredicate(), eq(agentWakeupRequests.companyId, claims.company_id),
    eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
    notInArray(agentWakeupRequests.status, ["skipped", "failed", "cancelled"]),
  )).limit(1)).length > 0;
  if (await queued()) return { ...result, toolRefresh: "deduplicated", instruction: QUEUED_INSTRUCTION };
  const [run] = await db.select({ issueId: boundRunIssueIdSql() }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, claims.run_id),
    eq(heartbeatRuns.companyId, claims.company_id),
    eq(heartbeatRuns.agentId, claims.sub),
  )).limit(1);
  const issueId = run?.issueId;
  if (!issueId) return { ...result, toolRefresh: "unavailable", instruction: UNAVAILABLE_INSTRUCTION };
  try {
    await heartbeat.wakeup(claims.sub, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId, mutation: "connection_tools_refreshed" },
      idempotencyKey,
      issueStateGuard: { statuses: ["in_progress", "in_review"], assigneeAgentId: claims.sub },
      requestedByActorType: "agent", requestedByActorId: claims.sub,
      contextSnapshot: { issueId, taskId: issueId, refreshTools: true, wakeReason: "issue_commented", source: "connection_tools.refreshed" },
    });
  } catch (error) {
    if (!(await queued())) throw error;
  }
  return await queued()
    ? { ...result, toolRefresh: "requested", instruction: QUEUED_INSTRUCTION }
    : { ...result, toolRefresh: "unavailable", instruction: UNAVAILABLE_INSTRUCTION };
}
