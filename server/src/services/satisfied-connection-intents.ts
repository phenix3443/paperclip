import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { approvals, companyMemberships, connectionIntentDeliveries, issueApprovals, issueThreadInteractions, issues, toolCatalogEntries, type Db } from "@paperclipai/db";
import { connectionIntentPayloadSchema } from "@paperclipai/shared";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { connectionIntentService } from "./connection-intents.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { logger } from "../middleware/logger.js";
import { createToolGatewayService } from "./tool-gateway.js";

type Task = Pick<typeof issues.$inferSelect, "id" | "companyId" | "projectId" | "status" | "assigneeAgentId" | "assigneeUserId">;
type Intent = Pick<typeof issueThreadInteractions.$inferSelect, "id" | "companyId" | "issueId" | "kind" | "status" | "payload" | "addresseeUserId"> & Partial<Pick<typeof issueThreadInteractions.$inferSelect, "sourceRunId">>;

/** Verify existing access only. This never installs tools, grants access, or adopts an identity. */
async function findAvailableToolConnection(db: Db, task: Task, intent: Intent, policyRunId?: string | null, retired = false) {
  if (intent.kind !== "connection_intent" || intent.status !== "pending"
    || intent.companyId !== task.companyId || intent.issueId !== task.id
    || task.assigneeUserId) return null;
  const parsed = connectionIntentPayloadSchema.safeParse(intent.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  // Provider authentication and inbox setup still need their governed
  // completion paths. Aggregator cards also name an upstream app.
  if (payload.purpose || payload.upstreamService
    || payload.requestingAgentId !== task.assigneeAgentId || !intent.addresseeUserId) return null;
  if (intent.addresseeUserId !== "local-board") {
    const [membership] = await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, task.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, intent.addresseeUserId),
    ));
    if (membership?.status !== "active" || !membership.membershipRole || membership.membershipRole === "viewer") return null;
  }
  const accessRequest = payload.accessRequest;
  const service = connectionIntentService(db);
  const lookup = { companyId: task.companyId, agentId: payload.requestingAgentId,
    responsibleUserId: intent.addresseeUserId, serviceSlug: payload.serviceSlug };
  const exact = () => service.usableConnectionForAgent({ ...lookup, connectionId: accessRequest!.connectionId });
  const connection = accessRequest && !retired ? await exact()
    : await service.usableConnectionForAgent(lookup) ?? (accessRequest ? await exact() : null);
  if (!connection) return null;
  // Use the gateway's exact descriptors and listing policy, including task,
  // project and routine context. Per-invocation approvals remain enforced.
  const access = await createToolGatewayService(db).summarizeConnectionAccessForAgent({
    companyId: task.companyId, connectionId: connection.id, agentId: payload.requestingAgentId,
    heartbeatRunId: policyRunId === undefined ? intent.sourceRunId ?? null : policyRunId,
    issueId: task.id, projectId: task.projectId,
  });
  if (!accessRequest || retired) return access.allowedCount + access.askFirstCount > 0 ? connection : null;
  const catalog = await db.select().from(toolCatalogEntries).where(and(
    eq(toolCatalogEntries.companyId, task.companyId), eq(toolCatalogEntries.connectionId, connection.id),
    inArray(toolCatalogEntries.id, accessRequest.tools.map(tool => tool.catalogEntryId)),
  ));
  const satisfied = accessRequest.tools.every((requested) => {
    const entry = catalog.find(candidate => candidate.id === requested.catalogEntryId);
    if (!entry || entry.status !== "active" || entry.entryKind !== "tool"
      || entry.toolName !== requested.toolName || entry.versionHash !== requested.versionHash) return false;
    const decisions = access.tools.filter(tool => tool.toolName === entry.toolName).map(tool => tool.decision);
    return decisions.length === 1 && (decisions[0] === "allowed" || (requested.permission === "ask_first" && decisions[0] === "ask_first"));
  });
  return satisfied ? connection : null;
}

export async function findSatisfiedToolConnection(db: Db, task: Task, intent: Intent, policyRunId?: string | null) {
  if (!["in_progress", "in_review"].includes(task.status)) return null;
  return findAvailableToolConnection(db, task, intent, policyRunId);
}

/** Recheck both live requests and system-retired cards against the next run. */
export async function connectionContinuationPendingResponse(db: Db, task: Task, responsibleUserId: string | null,
  policyRunId?: string | null): Promise<"interaction" | "approval" | null> {
  const interactions = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, task.companyId), eq(issueThreadInteractions.issueId, task.id),
    or(eq(issueThreadInteractions.status, "pending"), and(eq(issueThreadInteractions.kind, "connection_intent"), eq(issueThreadInteractions.status, "expired"))),
  ));
  for (const interaction of interactions) {
    const retired = interaction.status === "expired" && interaction.result?.outcome === "expired"
      && "connectionId" in interaction.result && typeof interaction.result.connectionId === "string";
    if (interaction.status !== "pending" && !retired) continue;
    if (retired && (interaction.payload as { requestingAgentId?: string }).requestingAgentId !== task.assigneeAgentId) continue;
    if (interaction.addresseeUserId !== responsibleUserId) return "interaction";
    const connection = await findAvailableToolConnection(db, task, { ...interaction, status: "pending" }, policyRunId, retired);
    // Historical system retirements describe a service need, not a permanent
    // binding to an account the user may later replace. Delivery and native
    // response projection still validate their own exact recorded connection.
    if (!connection) return "interaction";
  }
  const [approval] = await db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, issueApprovals.companyId),
  )).where(and(eq(issueApprovals.companyId, task.companyId), eq(issueApprovals.issueId, task.id),
    inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  return approval ? "approval" : null;
}

export function satisfiedConnectionIntentService(db: Db) {
  let afterId: string | null = null;
  return {
    async sweepPending() {
      const candidates = await db.select({ id: issueThreadInteractions.id, issueId: issues.id, companyId: issues.companyId })
        .from(issueThreadInteractions).innerJoin(issues, and(
          eq(issues.id, issueThreadInteractions.issueId), eq(issues.companyId, issueThreadInteractions.companyId),
        )).where(and(eq(issueThreadInteractions.kind, "connection_intent"), eq(issueThreadInteractions.status, "pending"),
          inArray(issues.status, ["in_progress", "in_review"]), isNull(issues.assigneeUserId),
          ...(afterId ? [gt(issueThreadInteractions.id, afterId)] : [])))
        .orderBy(asc(issueThreadInteractions.id)).limit(50);
      // Rotate past unavailable cards so they cannot starve a later ready one.
      afterId = candidates.length === 50 ? candidates[49]!.id : null;
      let satisfied = 0;
      let failed = 0;
      for (const candidate of candidates) {
        const publications: ActivityPublication[] = [];
        try {
          const updated = await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            const [task] = await tx.select().from(issues).where(and(
              eq(issues.id, candidate.issueId), eq(issues.companyId, candidate.companyId),
            )).for("update");
            const [intent] = await tx.select().from(issueThreadInteractions).where(and(
              eq(issueThreadInteractions.id, candidate.id), eq(issueThreadInteractions.companyId, candidate.companyId),
              eq(issueThreadInteractions.issueId, candidate.issueId),
            )).for("update");
            if (!task || !intent) return false;
            if (intent.addresseeUserId && intent.addresseeUserId !== "local-board") {
              await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
                eq(companyMemberships.companyId, candidate.companyId), eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.principalId, intent.addresseeUserId),
              )).for("share");
            }
            const connection = await findSatisfiedToolConnection(txDb, task, intent);
            if (!connection) return false;
            const now = new Date();
            // Retire the obsolete request without inventing a human approval.
            await tx.update(issueThreadInteractions).set({ status: "expired", resolvedAt: now, updatedAt: now,
              result: { version: 1, outcome: "expired", connectionId: connection.id,
                reason: "An already authorized connection is available to the requesting agent." },
            }).where(and(eq(issueThreadInteractions.id, intent.id), eq(issueThreadInteractions.status, "pending")));
            await tx.update(issues).set({ updatedAt: now }).where(and(eq(issues.id, task.id), eq(issues.companyId, task.companyId)));
            await tx.insert(connectionIntentDeliveries).values({ interactionId: intent.id, companyId: task.companyId }).onConflictDoNothing();
            await notifyDeliveryWork(tx, DELIVERY_QUEUES.connection);
            await logActivity(txDb, { companyId: task.companyId, actorType: "system", actorId: "connection-reconciliation",
              action: "issue.thread_interaction_resolved", entityType: "issue", entityId: task.id,
              details: { interactionId: intent.id, interactionKind: "connection_intent", status: "expired",
                connectionId: connection.id, resolutionSource: "existing_connection" },
            }, publications);
            return true;
          });
          for (const publication of publications) publishActivity(publication);
          if (updated) satisfied += 1;
        } catch (error) {
          failed += 1;
          logger.warn({ err: error, interactionId: candidate.id }, "Could not reconcile an already available connection");
        }
      }
      return { scanned: candidates.length, satisfied, failed };
    },
  };
}
