import { executionWorkspaces, heartbeatRuns, issues, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { preserveDetachedRepositories } from "./detached-repository-custody.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ProjectRepositoryRetention = {
  companyId: string;
  executionWorkspaceId: string;
  sourceIssueId: string;
  runId: string | null;
  generation: number;
  afterGuard?: () => Promise<void>;
  withLifecycleLock: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
};

async function assertRetentionMayMove(tx: Transaction, input: ProjectRepositoryRetention, cwd: string) {
  const [workspace] = await tx.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.executionWorkspaceId),
  ));
  const metadata = workspace?.metadata as Record<string, unknown> | null;
  const rawGeneration = metadata?.lifecycleGeneration;
  const generation = typeof rawGeneration === "number" && Number.isInteger(rawGeneration) && rawGeneration >= 0 ? rawGeneration : 0;
  if (!workspace || workspace.sourceIssueId !== input.sourceIssueId || workspace.cwd !== cwd
    || (workspace.providerRef && workspace.providerRef !== cwd)
    || !["active", "idle", "in_review"].includes(workspace.status) || workspace.closedAt
    || metadata?.reopenPendingConsumption === true || generation !== input.generation) throw new Error("Workspace retention lifecycle changed");
  const rows = await tx.execute<{ allowed: boolean }>(sql`
    WITH RECURSIVE issue_tree(id) AS (
      SELECT root.id FROM ${issues} root WHERE root.company_id = ${input.companyId} AND root.id = ${workspace.sourceIssueId}
      UNION
      SELECT child.id FROM ${issues} child JOIN issue_tree parent ON child.parent_id = parent.id WHERE child.company_id = ${input.companyId}
    )
    SELECT (
      EXISTS (SELECT 1 FROM issue_tree)
      AND NOT EXISTS (
        SELECT 1 FROM ${issues} linked_issue JOIN ${heartbeatRuns} live_run
          ON live_run.id = linked_issue.checkout_run_id OR live_run.id = linked_issue.execution_run_id
        WHERE linked_issue.company_id = ${input.companyId}
          AND (linked_issue.execution_workspace_id = ${workspace.id} OR linked_issue.id IN (SELECT id FROM issue_tree))
          AND live_run.company_id = ${input.companyId} AND live_run.status IN ('queued', 'running')
          AND (${input.runId}::uuid IS NULL OR live_run.id <> ${input.runId}::uuid)
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${heartbeatRuns} issue_run WHERE issue_run.company_id = ${input.companyId}
          AND issue_run.status IN ('queued', 'running')
          AND (${input.runId}::uuid IS NULL OR issue_run.id <> ${input.runId}::uuid)
          AND (issue_run.context_snapshot->>'executionWorkspaceId' = ${workspace.id}::text OR coalesce(issue_run.native_issue_id::text,
            nullif(issue_run.context_snapshot->>'issueId', ''), nullif(issue_run.context_snapshot->>'taskId', '')) IN (SELECT id::text FROM issue_tree))
      )
      AND NOT EXISTS (SELECT 1 FROM ${workspaceRuntimeServices} service WHERE service.company_id = ${input.companyId}
        AND service.execution_workspace_id = ${workspace.id} AND service.status <> 'stopped')
    ) AS allowed
  `);
  if (!rows[0]?.allowed) throw new Error("Workspace retention has live consumers");
}

export async function retainProjectRepositoryEntries(input: {
  cwd: string;
  active: ReadonlySet<string>;
  retention?: ProjectRepositoryRetention;
}) {
  const retention = input.retention;
  return preserveDetachedRepositories({ cwd: input.cwd, active: input.active, retention: retention ? {
    companyId: retention.companyId, executionWorkspaceId: retention.executionWorkspaceId,
    withLifecycleLock: work => retention.withLifecycleLock(tx => work(async () => { await assertRetentionMayMove(tx, retention, input.cwd); await retention.afterGuard?.(); })),
  } : undefined });
}
