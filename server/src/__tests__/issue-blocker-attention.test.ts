import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  companyMemberships,
  issueAccessGrants,
  projects,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueReadSqlCondition, issueReadSqlProof } from "../services/authorization.js";
import { BLOCKER_ATTENTION_MAX_NODES, issueService } from "../services/issues.js";
import { buildIssueGraphLivenessIncidentKey } from "../services/recovery/origins.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue blocker attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue blocker attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocker-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "PBA") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pausedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: `${prefix} Agent`,
        role: "engineer",
        status: "idle",
      },
      {
        id: pausedAgentId,
        companyId,
        name: `${prefix} Paused`,
        role: "engineer",
        status: "paused",
      },
    ]);
    return { companyId, agentId, pausedAgentId };
  }

  async function insertIssue(input: {
    companyId: string;
    id?: string;
    identifier: string;
    title: string;
    status: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    originKind?: string | null;
    originId?: string | null;
    originFingerprint?: string | null;
    executionState?: Record<string, unknown> | null;
    description?: string | null;
    unblockDescriptor?: { owner: { agentId: string } | { userId: string } | "board"; action: string } | null;
    visibility?: "open" | "private";
    monitorNextCheckAt?: Date | null;
  }) {
    const id = input.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
      originFingerprint: input.originFingerprint ?? "default",
      executionState: input.executionState ?? null,
      description: input.description ?? null,
      unblockDescriptor: input.unblockDescriptor ?? null,
      visibility: input.visibility ?? "open",
      monitorNextCheckAt: input.monitorNextCheckAt ?? null,
    });
    return id;
  }

  async function block(input: { companyId: string; blockerIssueId: string; blockedIssueId: string }) {
    await db.insert(issueRelations).values({
      companyId: input.companyId,
      issueId: input.blockerIssueId,
      relatedIssueId: input.blockedIssueId,
      type: "blocks",
    });
  }

  async function activeRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    current?: boolean;
    scheduledRetryAt?: Date;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      contextSnapshot: { issueId: input.issueId },
      scheduledRetryAt: input.scheduledRetryAt,
    });
    if (input.current !== false) {
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, input.issueId));
    }
    return runId;
  }

  it("classifies a blocked parent as covered when its child has a running execution path", async () => {
    const { companyId, agentId } = await createCompany("PBC");
    const parentId = await insertIssue({ companyId, identifier: "PBC-1", title: "Parent", status: "blocked" });
    const childId = await insertIssue({
      companyId,
      identifier: "PBC-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: childId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: childId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBC-2",
    });
  });

  it("classifies an assigned backlog blocker leaf without a waiting path as attention-needed", async () => {
    const { companyId, agentId } = await createCompany("PBB");
    const parentId = await insertIssue({ companyId, identifier: "PBB-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBB-2",
      title: "Parked assigned blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBB-2",
    });
  });

  it("treats a human-owned backlog blocker as a covered waiting path", async () => {
    const { companyId } = await createCompany("PBU");
    const parentId = await insertIssue({ companyId, identifier: "PBU-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBU-2",
      title: "Human-owned parked blocker",
      status: "backlog",
      assigneeUserId: "board-user-1",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBU-2",
    });
  });

  it("keeps mixed blockers attention-required when any path lacks active work", async () => {
    const { companyId, agentId } = await createCompany("PBM");
    const parentId = await insertIssue({ companyId, identifier: "PBM-1", title: "Parent", status: "blocked" });
    const activeChildId = await insertIssue({
      companyId,
      identifier: "PBM-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    const idleBlockerId = await insertIssue({
      companyId,
      identifier: "PBM-3",
      title: "Idle blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: activeChildId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: idleBlockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeChildId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBM-3",
    });
  });

  it("ignores cancelled direct children when counting unresolved blocker attention", async () => {
    const { companyId, agentId } = await createCompany("PBD");
    const parentId = await insertIssue({ companyId, identifier: "PBD-1", title: "Parent", status: "blocked" });
    const activeBlockerOneId = await insertIssue({
      companyId,
      identifier: "PBD-2",
      title: "Running dependency one",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const activeBlockerTwoId = await insertIssue({
      companyId,
      identifier: "PBD-3",
      title: "Running dependency two",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await insertIssue({
      companyId,
      identifier: "PBD-4",
      title: "Cancelled child",
      status: "cancelled",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: activeBlockerOneId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: activeBlockerTwoId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeBlockerOneId });
    await activeRun({ companyId, agentId, issueId: activeBlockerTwoId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      stalledBlockerCount: 0,
      attentionBlockerCount: 0,
    });
    expect(parent?.blockerAttention?.sampleBlockerIdentifier).not.toBe("PBD-4");
  });

  it("covers recursive blocker chains when the downstream leaf has active work", async () => {
    const { companyId, agentId } = await createCompany("PBR");
    const parentId = await insertIssue({ companyId, identifier: "PBR-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({ companyId, identifier: "PBR-2", title: "Blocked dependency", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBR-3",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: blockerId });
    await activeRun({ companyId, agentId, issueId: leafId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBR-3",
    });
  });

  it("does not let another company's active run cover the blocker", async () => {
    const { companyId, agentId } = await createCompany("PBS");
    const other = await createCompany("PBT");
    const parentId = await insertIssue({ companyId, identifier: "PBS-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBS-2",
      title: "Same-company blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId: other.companyId, agentId: other.agentId, issueId: blockerId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBS-2",
    });
  });

  it("does not cover a blocker from a stale run the issue no longer owns", async () => {
    const { companyId, agentId } = await createCompany("PBX");
    const parentId = await insertIssue({ companyId, identifier: "PBX-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBX-2",
      title: "Previously running blocker",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId, current: false });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBX-2",
    });
  });

  it("flags a chain whose leaf is in_review without an action path as stalled", async () => {
    const { companyId, agentId } = await createCompany("PBV");
    const parentId = await insertIssue({ companyId, identifier: "PBV-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBV-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBV-2",
      sampleStalledBlockerIdentifier: "PBV-2",
    });
  });

  it("does not flag an in_review leaf as stalled when an active run is still progressing it", async () => {
    const { companyId, agentId } = await createCompany("PBW");
    const parentId = await insertIssue({ companyId, identifier: "PBW-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBW-2",
      title: "Active review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: reviewLeafId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      stalledBlockerCount: 0,
    });
  });

  it("flags a deep chain whose leaf is stalled in_review through multiple layers", async () => {
    const { companyId, agentId } = await createCompany("PBZ");
    const rootId = await insertIssue({ companyId, identifier: "PBZ-1", title: "Root", status: "blocked" });
    const midId = await insertIssue({ companyId, identifier: "PBZ-2", title: "Mid blocker", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBZ-3",
      title: "Stalled leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: midId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: midId });

    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);

    expect(root?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      stalledBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PBZ-3",
    });
  });

  it("returns the direct path and link details when a downstream blocker is selected", async () => {
    const { companyId, agentId } = await createCompany("PBI");
    const rootId = await insertIssue({ companyId, identifier: "PBI-1", title: "Root", status: "blocked" });
    const directId = await insertIssue({
      companyId,
      identifier: "PBI-2",
      title: "Direct blocker",
      status: "blocked",
    });
    const intermediateId = await insertIssue({
      companyId,
      identifier: "PBI-3",
      title: "Intermediate review waiting on its blocker",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBI-4",
      title: "Downstream leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: directId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: intermediateId, blockedIssueId: directId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: intermediateId });

    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);

    // The review is waiting on its own unfinished blocker, so the idle leaf is the terminal.
    expect(root?.blockerAttention).toMatchObject({
      state: "needs_attention",
      directBlockerIssueId: directId,
      terminalBlockerIssueId: leafId,
      terminalBlocker: {
        id: leafId,
        identifier: "PBI-4",
        title: "Downstream leaf",
      },
    });
  });

  it("prefers needs_attention over stalled when the chain also has a hard attention case", async () => {
    const { companyId, agentId } = await createCompany("PBQ");
    const parentId = await insertIssue({ companyId, identifier: "PBQ-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-3",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PBQ-2",
    });
  });

  it("treats open liveness escalation blockers as covered waiting paths", async () => {
    const { companyId, agentId } = await createCompany("PBL");
    const parentId = await insertIssue({ companyId, identifier: "PBL-1", title: "Parent", status: "blocked" });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBL-2",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    const incidentKey = [
      "harness_liveness",
      companyId,
      parentId,
      "blocked_by_cancelled_issue",
      cancelledLeafId,
    ].join(":");
    const escalationId = await insertIssue({
      companyId,
      identifier: "PBL-3",
      title: "Liveness escalation",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_cancelled_issue",
        cancelledLeafId,
      ].join(":"),
    });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: escalationId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked,todo" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      attentionBlockerCount: 0,
    });
  });

  it("does not treat cancelled liveness escalation issues as covered waiting paths", async () => {
    const { companyId, agentId } = await createCompany("PBLX");
    const parentId = await insertIssue({ companyId, identifier: "PBLX-1", title: "Parent", status: "blocked" });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBLX-2",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await insertIssue({
      companyId,
      identifier: "PBLX-3",
      title: "Cancelled liveness escalation",
      status: "cancelled",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: [
        "harness_liveness",
        companyId,
        parentId,
        "blocked_by_cancelled_issue",
        cancelledLeafId,
      ].join(":"),
    });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      state: "needs_attention",
      reason: "blocked_by_cancelled_issue",
      leafIssue: { id: cancelledLeafId, identifier: "PBLX-2" },
    });
  });

  it("does not treat an expired scheduled retry as actively covered work", async () => {
    const pinnedNow = new Date("2026-08-20T12:00:00.000Z");
    const expiredRetryAt = new Date(pinnedNow.getTime() - 60_000);
    const { companyId, agentId } = await createCompany("PBY");
    const parentId = await insertIssue({ companyId, identifier: "PBY-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBY-2",
      title: "Retrying blocker",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({
      companyId,
      agentId,
      issueId: blockerId,
      status: "scheduled_retry",
      scheduledRetryAt: expiredRetryAt,
    });

    const parent = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBY-2",
    });
  });

  it("returns blocked inbox attention for an unassigned blocker leaf and supports count/search", async () => {
    const { companyId } = await createCompany("BIA");
    const parentId = await insertIssue({ companyId, identifier: "BIA-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIA-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, q: "BIA-2" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(parentId);
    expect(rows[0]?.blockedBy).toEqual([
      expect.objectContaining({ id: blockerId, identifier: "BIA-2" }),
    ]);
    expect(rows[0]?.blockedInboxAttention).toMatchObject({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_unassigned_issue",
      severity: "critical",
      owner: { type: "unknown", agentId: null, userId: null },
      action: { label: "Assign blocker" },
      leafIssue: { id: blockerId, identifier: "BIA-2" },
      redaction: { secretFieldsOmitted: true },
    });
    await expect(svc.count(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).resolves.toBe(1);
  });

  it("surfaces cancelled-blocker attention on an assigned todo source", async () => {
    const { companyId, agentId } = await createCompany("BICX");
    const sourceId = await insertIssue({
      companyId,
      identifier: "BICX-1",
      title: "Dispatch-suppressed source",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BICX-2",
      title: "Cancelled dependency",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: sourceId });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    const source = rows.find((issue) => issue.id === sourceId);

    expect(source?.blockedInboxAttention).toMatchObject({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_cancelled_issue",
      owner: { type: "agent", agentId },
      action: { label: "Replace blocker" },
      leafIssue: { id: blockerId, identifier: "BICX-2" },
    });
  });

  it("names the current reviewer of a stalled chain's review leaf as its blocked inbox owner", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("BCO");
    const parentId = await insertIssue({ companyId, identifier: "BCO-1", title: "Blocked source", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "BCO-2",
      title: "Review leaf",
      status: "in_review",
      assigneeAgentId: pausedAgentId,
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId } },
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).find((row) => row.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      reason: "blocked_chain_stalled",
      owner: { type: "agent", agentId, userId: null },
    });
  });

  it("names the unblock descriptor owner of a blocked issue waiting on itself", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("BCS");
    const issueId = await insertIssue({
      companyId,
      identifier: "BCS-1",
      title: "Waiting on an upstream review",
      status: "blocked",
      assigneeAgentId: pausedAgentId,
      unblockDescriptor: { owner: { agentId }, action: "Re-check when the upstream PR is reviewed" },
    });

    const row = (await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === issueId);

    expect(row?.blockedInboxAttention).toMatchObject({
      reason: "blocked_chain_stalled",
      owner: { type: "agent", agentId },
    });
  });

  it("names the unblock descriptor owner of a stalled chain's blocked leaf", async () => {
    const { companyId, agentId } = await createCompany("BCD");
    const assigneeId = randomUUID();
    await db.insert(agents).values({ id: assigneeId, companyId, name: "BCD Assignee", role: "engineer", status: "idle" });
    const parentId = await insertIssue({ companyId, identifier: "BCD-1", title: "Blocked source", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "BCD-2",
      title: "Leaf waiting on upstream",
      status: "blocked",
      assigneeAgentId: assigneeId,
      unblockDescriptor: { owner: { agentId }, action: "Re-check after the upstream PR merges" },
    });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: parentId });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    const parent = rows.find((row) => row.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      reason: "blocked_chain_stalled",
      owner: { type: "agent", agentId },
    });
  });

  it("does not copy the owner of a private terminal blocker", async () => {
    const { companyId, agentId } = await createCompany("BCP");
    const parentId = await insertIssue({ companyId, identifier: "BCP-1", title: "Blocked source", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "BCP-2",
      title: "Private review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId } },
      visibility: "private",
    });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { attention: "blocked", readCondition: await issueReadSqlCondition(db, { type: "board", userId: "unrelated-reader", ignoreInstanceAdmin: true }) })).find((row) => row.id === parentId);

    expect(parent?.blockedInboxAttention?.owner).toEqual({ type: "unknown", agentId: null, userId: null, label: null });
  });

  it("names an external owner when the terminal blocker is an external wait", async () => {
    const { companyId, agentId } = await createCompany("BCE");
    const parentId = await insertIssue({ companyId, identifier: "BCE-1", title: "Blocked source", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "BCE-2",
      title: "Waiting on a vendor",
      status: "blocked",
      assigneeAgentId: agentId,
      description: "External owner: Vendor support\nExternal action: Restore the sandbox account",
    });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: parentId });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });

    expect(rows.find((row) => row.id === leafId)?.blockedInboxAttention).toMatchObject({ reason: "external_owner_action" });
    expect(rows.find((row) => row.id === parentId)?.blockedInboxAttention).toMatchObject({
      reason: "blocked_chain_stalled",
      owner: { type: "external", agentId: null, userId: null, label: "Vendor support" },
      action: { label: "External owner action", detail: "Restore the sandbox account" },
    });
  });

  it("names the addressee of a pending interaction as the owner", async () => {
    const { companyId, agentId } = await createCompany("BIQ");
    const toAgentId = await insertIssue({ companyId, identifier: "BIQ-1", title: "Question for an agent", status: "blocked", assigneeAgentId: agentId });
    const toUserId = await insertIssue({ companyId, identifier: "BIQ-2", title: "Question for a user", status: "blocked", assigneeAgentId: agentId });
    const toBoardId = await insertIssue({ companyId, identifier: "BIQ-3", title: "Confirmation for the board", status: "blocked", assigneeAgentId: agentId });
    await db.insert(issueThreadInteractions).values([
      { companyId, issueId: toAgentId, kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee", payload: { version: 1 }, addresseeAgentId: agentId },
      { companyId, issueId: toUserId, kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee", payload: { version: 1 }, addresseeUserId: "user-1" },
      { companyId, issueId: toBoardId, kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee", payload: { version: 1 } },
    ]);

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    const attention = (id: string) => rows.find((row) => row.id === id)?.blockedInboxAttention;

    expect(attention(toAgentId)).toMatchObject({ reason: "pending_agent_decision", owner: { type: "agent", agentId } });
    expect(attention(toUserId)).toMatchObject({ reason: "pending_user_decision", owner: { type: "user", userId: "user-1" } });
    expect(attention(toBoardId)).toMatchObject({ reason: "pending_board_decision", owner: { type: "board" } });
  });

  it("flags a stalled chain whose next owner cannot run", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("BCU");
    const issueId = await insertIssue({
      companyId,
      identifier: "BCU-1",
      title: "Waiting on a paused owner",
      status: "blocked",
      assigneeAgentId: agentId,
      unblockDescriptor: { owner: { agentId: pausedAgentId }, action: "Re-check after the upstream PR merges" },
    });

    const row = (await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === issueId);

    expect(row?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_uninvokable_assignee",
      severity: "critical",
      owner: { type: "agent", agentId: pausedAgentId },
      action: { label: "Assign active owner" },
    });
  });

  it("moves external wait details from the description into attention", async () => {
    const { companyId } = await createCompany("BIX");
    const owner = "Private Vendor Security Team";
    const action = "Send the confidential access token for customer Alpha";
    const issueId = await insertIssue({
      companyId,
      identifier: "BIX-1",
      title: "Blocked on vendor",
      status: "blocked",
      description: [
        "Public context stays visible.",
        `external owner: ${owner}`,
        `external action: ${action}`,
        "Continue after the vendor confirms receipt.",
      ].join("\n"),
    });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    const issue = rows.find((row) => row.id === issueId);

    expect(issue?.description).toContain("Public context stays visible.");
    expect(issue?.description).toContain("Continue after the vendor confirms receipt.");
    expect(issue?.description).not.toContain(owner);
    expect(issue?.description).not.toContain(action);
    expect(issue?.blockedInboxAttention).toMatchObject({
      state: "external_wait",
      reason: "external_owner_action",
      owner: { type: "external", label: owner },
      action: { label: "External owner action", detail: action },
      redaction: { externalDetailsRedacted: true, secretFieldsOmitted: true },
    });

    await expect(svc.count(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, q: owner })).resolves.toBe(1);
    await expect(svc.count(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, q: action })).resolves.toBe(1);
    await expect(svc.count(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, q: "Public context" })).resolves.toBe(1);
  });

  it("excludes healthy active blockers from blocked inbox attention", async () => {
    const { companyId, agentId } = await createCompany("BIB");
    const parentId = await insertIssue({ companyId, identifier: "BIB-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIB-2",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId });

    expect(await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).toEqual([]);
  });

  it("treats a leaf waiting on a scheduled monitor as progressing", async () => {
    const { companyId, agentId } = await createCompany("BIM");
    const parentId = await insertIssue({ companyId, identifier: "BIM-1", title: "Blocked source", status: "blocked" });
    const waitingId = await insertIssue({
      companyId,
      identifier: "BIM-2",
      title: "Waiting for CI",
      status: "in_progress",
      assigneeAgentId: agentId,
      monitorNextCheckAt: new Date(Date.now() + 10 * 60_000),
    });
    await block({ companyId, blockerIssueId: waitingId, blockedIssueId: parentId });
    const overdueParentId = await insertIssue({ companyId, identifier: "BIM-3", title: "Blocked source", status: "blocked" });
    const overdueId = await insertIssue({
      companyId,
      identifier: "BIM-4",
      title: "Monitor already due",
      status: "in_progress",
      assigneeAgentId: agentId,
      monitorNextCheckAt: new Date(Date.now() - 10 * 60_000),
    });
    await block({ companyId, blockerIssueId: overdueId, blockedIssueId: overdueParentId });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });

    expect(rows.map((row) => row.id)).toEqual([overdueParentId]);
    expect(rows[0]?.blockedInboxAttention).toMatchObject({
      reason: "blocked_chain_stalled",
      owner: { type: "agent", agentId },
    });
  });

  it("classifies assigned backlog and invalid review leaves for blocked inbox attention", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("BIC");
    const backlogParentId = await insertIssue({ companyId, identifier: "BIC-1", title: "Blocked by parked work", status: "blocked" });
    const backlogLeafId = await insertIssue({
      companyId,
      identifier: "BIC-2",
      title: "Parked blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: backlogLeafId, blockedIssueId: backlogParentId });

    const reviewId = await insertIssue({
      companyId,
      identifier: "BIC-3",
      title: "Invalid review",
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: pausedAgentId },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(backlogParentId)?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
      severity: "high",
      owner: { type: "agent", agentId },
      leafIssue: { id: backlogLeafId },
    });
    expect(byId.get(reviewId)?.blockedInboxAttention).toMatchObject({
      reason: "invalid_review_participant",
      severity: "critical",
      action: { label: "Repair review participant" },
    });
  });

  it("classifies recovery issues and missing successful-run dispositions", async () => {
    const { companyId, agentId } = await createCompany("BID");
    const sourceId = await insertIssue({ companyId, identifier: "BID-1", title: "Stopped source", status: "blocked" });
    const leafId = await insertIssue({ companyId, identifier: "BID-2", title: "Stopped leaf", status: "todo" });
    const recoveryId = await insertIssue({
      companyId,
      identifier: "BID-3",
      title: "Recovery issue",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: buildIssueGraphLivenessIncidentKey({
        companyId,
        issueId: sourceId,
        state: "blocked_by_unassigned_issue",
        blockerIssueId: leafId,
      }),
    });
    const handoffId = await insertIssue({
      companyId,
      identifier: "BID-4",
      title: "Needs disposition",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: handoffId,
      agentId,
      details: { sourceRunId: randomUUID(), detectedProgressSummary: "Progress was made" },
    });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(recoveryId)?.blockedInboxAttention).toMatchObject({
      state: "recovery_open",
      reason: "open_recovery_issue",
      sourceIssue: { id: sourceId },
      leafIssue: { id: leafId },
      recoveryIssue: { id: recoveryId },
    });
    expect(byId.get(handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
      owner: { type: "agent", agentId },
      action: { label: "Choose disposition" },
    });

    const handoffRunId = await activeRun({ companyId, agentId, issueId: handoffId, current: false });
    const liveRows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    expect(liveRows.some((row) => row.id === handoffId)).toBe(false);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, handoffRunId));
    const stoppedRows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    expect(stoppedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });

    const scheduledRetryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: scheduledRetryRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      contextSnapshot: { taskId: handoffId },
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryAttempt: 1,
    });
    const scheduledRows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    expect(scheduledRows.some((row) => row.id === handoffId)).toBe(false);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, scheduledRetryRunId));
    const exhaustedRows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    expect(exhaustedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_escalated",
      entityType: "issue",
      entityId: handoffId,
      agentId,
      details: { sourceRunId: randomUUID() },
    });
    const escalatedRows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    expect(escalatedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });

    const escalatedLiveRunId = await activeRun({ companyId, agentId, issueId: handoffId, current: false });
    const escalatedLiveRows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    expect(escalatedLiveRows.some((row) => row.id === handoffId)).toBe(false);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, escalatedLiveRunId));
    const escalatedStoppedRows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    expect(escalatedStoppedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });
  });

  it("applies assigneeAgentId='null' as an IS NULL filter on the blocked-inbox path", async () => {
    const { companyId, agentId } = await createCompany("BAN");
    const unassignedParentId = await insertIssue({
      companyId,
      identifier: "BAN-1",
      title: "Unassigned blocked parent",
      status: "blocked",
    });
    const unassignedLeafId = await insertIssue({
      companyId,
      identifier: "BAN-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: unassignedLeafId, blockedIssueId: unassignedParentId });

    const assignedParentId = await insertIssue({
      companyId,
      identifier: "BAN-3",
      title: "Assigned blocked parent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const assignedLeafId = await insertIssue({
      companyId,
      identifier: "BAN-4",
      title: "Unassigned leaf for assigned parent",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: assignedLeafId, blockedIssueId: assignedParentId });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, assigneeAgentId: "null" });
    expect(rows.map((row) => row.id)).toEqual([unassignedParentId]);

    await expect(svc.count(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, assigneeAgentId: "null" })).resolves.toBe(1);
  });

  it("applies a UUID assigneeAgentId filter on the blocked-inbox path", async () => {
    const { companyId, agentId } = await createCompany("BAU");
    const unassignedParentId = await insertIssue({
      companyId,
      identifier: "BAU-1",
      title: "Unassigned blocked parent",
      status: "blocked",
    });
    const unassignedLeafId = await insertIssue({
      companyId,
      identifier: "BAU-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: unassignedLeafId, blockedIssueId: unassignedParentId });

    const assignedParentId = await insertIssue({
      companyId,
      identifier: "BAU-3",
      title: "Assigned blocked parent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const assignedLeafId = await insertIssue({
      companyId,
      identifier: "BAU-4",
      title: "Unassigned leaf for assigned parent",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: assignedLeafId, blockedIssueId: assignedParentId });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, assigneeAgentId: agentId });
    expect(rows.map((row) => row.id)).toEqual([assignedParentId]);

    await expect(svc.count(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, assigneeAgentId: agentId })).resolves.toBe(1);
  });

  it("rejects malformed assigneeAgentId filter values on the blocked-inbox path", async () => {
    const { companyId } = await createCompany("BAM");
    await expect(
      svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
    await expect(
      svc.count(companyId, { attention: "blocked", readCondition: sql<boolean>`true`, assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
  });

  it("builds the blocked inbox blocker graph once per request and keeps each row's per-row result", async () => {
    async function seedInbox(prefix: string, chainCount: number) {
      const { companyId, agentId } = await createCompany(prefix);
      const roots: Array<{ id: string; assigneeAgentId: string }> = [];
      for (let index = 0; index < chainCount; index += 1) {
        const assigneeAgentId = randomUUID();
        await db.insert(agents).values({
          id: assigneeAgentId,
          companyId,
          name: `${prefix} Owner ${index}`,
          role: "engineer",
          status: "idle",
        });
        const rootId = await insertIssue({
          companyId,
          identifier: `${prefix}-${index * 20 + 1}`,
          title: `Blocked source ${index}`,
          status: "blocked",
          assigneeAgentId,
        });
        // The last chain is deeper than BLOCKER_ATTENTION_MAX_DEPTH; the inbox walk still reaches its leaf.
        const depth = index === chainCount - 1 ? 10 : 1;
        const covered = index % 2 === 1;
        let blockedIssueId = rootId;
        for (let level = 1; level <= depth; level += 1) {
          const isLeaf = level === depth;
          const blockerIssueId = await insertIssue({
            companyId,
            identifier: `${prefix}-${index * 20 + 1 + level}`,
            title: isLeaf ? `Leaf ${index}` : `Link ${index}.${level}`,
            status: isLeaf && !covered ? "in_review" : "todo",
            assigneeAgentId: isLeaf && !covered ? null : agentId,
            executionState:
              isLeaf && !covered ? { status: "pending", currentParticipant: { type: "agent", agentId } } : null,
          });
          await block({ companyId, blockerIssueId, blockedIssueId });
          if (isLeaf && covered) await activeRun({ companyId, agentId, issueId: blockerIssueId });
          blockedIssueId = blockerIssueId;
        }
        roots.push({ id: rootId, assigneeAgentId });
      }
      return { companyId, roots };
    }

    async function countQueries<T>(run: () => Promise<T>) {
      let count = 0;
      const debug = db.$client.options.debug;
      db.$client.options.debug = () => {
        count += 1;
      };
      try {
        return { result: await run(), count };
      } finally {
        db.$client.options.debug = debug;
      }
    }

    const small = await seedInbox("BGA", 2);
    const large = await seedInbox("BGB", 12);

    const smallList = await countQueries(() => svc.list(small.companyId, { attention: "blocked", readCondition: sql<boolean>`true` }));
    const largeList = await countQueries(() => svc.list(large.companyId, { attention: "blocked", readCondition: sql<boolean>`true` }));

    // Six covered chains, including the deep one, stay out of the inbox; six stalled chains stay in.
    expect(largeList.result).toHaveLength(6);
    expect(largeList.count - smallList.count).toBeLessThan(10);

    // Filtering by assignee leaves one candidate row, so its attention is computed from its own graph alone.
    for (const root of large.roots) {
      const alone = await svc.list(large.companyId, { attention: "blocked", readCondition: sql<boolean>`true`, assigneeAgentId: root.assigneeAgentId });
      expect(largeList.result.find((row) => row.id === root.id)?.blockedInboxAttention).toEqual(
        alone.find((row) => row.id === root.id)?.blockedInboxAttention,
      );
    }
  });
  async function seedChain(input: {
    companyId: string;
    agentId: string;
    prefix: string;
    depth: number;
    leafStatus: string;
  }) {
    const rootId = await insertIssue({
      companyId: input.companyId,
      identifier: `${input.prefix}-1`,
      title: "Blocked source",
      status: "blocked",
      assigneeAgentId: input.agentId,
    });
    let blockedIssueId = rootId;
    let leafId = rootId;
    for (let level = 1; level <= input.depth; level += 1) {
      const isLeaf = level === input.depth;
      const blockerIssueId = await insertIssue({
        companyId: input.companyId,
        identifier: `${input.prefix}-${level + 1}`,
        title: isLeaf ? "Leaf" : `Link ${level}`,
        // Links are not blocked themselves, so the root is the only blocked-inbox candidate and
        // the bounded issue-list walk cannot reach the leaf through another blocked root.
        status: isLeaf ? input.leafStatus : "todo",
        assigneeAgentId: input.agentId,
      });
      await block({ companyId: input.companyId, blockerIssueId, blockedIssueId });
      blockedIssueId = blockerIssueId;
      leafId = blockerIssueId;
    }
    return { rootId, leafId };
  }

  it("does not flag a deep chain whose leaf is running as stalled in the blocked inbox", async () => {
    const { companyId, agentId } = await createCompany("BDP");
    const { rootId, leafId } = await seedChain({
      companyId,
      agentId,
      prefix: "BDP",
      depth: 12,
      leafStatus: "in_progress",
    });
    await activeRun({ companyId, agentId, issueId: leafId });

    expect(await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).toEqual([]);

    // The issue list keeps its bounded walk, so the same chain still reads as truncated there.
    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);
    expect(root?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
    });
  });

  it("still flags a deep chain whose leaf has no waiting path", async () => {
    const { companyId, agentId } = await createCompany("BDS");
    const { rootId } = await seedChain({
      companyId,
      agentId,
      prefix: "BDS",
      depth: 12,
      leafStatus: "in_review",
    });

    // The review leaf and its direct dependent also get their own review-path rows.
    const root = (await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).find((row) => row.id === rootId);
    expect(root?.blockedInboxAttention).toMatchObject({ reason: "blocked_chain_stalled" });
  });

  it("covers an in_review leaf whose only path is a queued run not yet checked out", async () => {
    const { companyId, agentId } = await createCompany("BQR");
    const { rootId, leafId } = await seedChain({
      companyId,
      agentId,
      prefix: "BQR",
      depth: 3,
      leafStatus: "in_review",
    });
    await activeRun({ companyId, agentId, issueId: leafId, status: "queued", current: false });

    expect(await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).toEqual([]);
    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);
    expect(root?.blockerAttention).toMatchObject({ state: "covered", stalledBlockerCount: 0 });
  });

  it("covers an in_review leaf waiting on a scheduled retry that is still due", async () => {
    const { companyId, agentId } = await createCompany("BQT");
    const { rootId, leafId } = await seedChain({
      companyId,
      agentId,
      prefix: "BQT",
      depth: 2,
      leafStatus: "in_review",
    });
    await activeRun({
      companyId,
      agentId,
      issueId: leafId,
      status: "scheduled_retry",
      current: false,
      scheduledRetryAt: new Date(Date.now() + 10 * 60_000),
    });

    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);
    expect(root?.blockerAttention).toMatchObject({ state: "covered", stalledBlockerCount: 0 });
  });

  it("keeps an in_review leaf with no run or wake stalled", async () => {
    const { companyId, agentId } = await createCompany("BQN");
    const { rootId, leafId } = await seedChain({
      companyId,
      agentId,
      prefix: "BQN",
      depth: 3,
      leafStatus: "in_review",
    });
    // A finished run for the leaf is not a waiting path.
    await activeRun({ companyId, agentId, issueId: leafId, status: "succeeded", current: false });

    // The review leaf and its direct dependent also get their own review-path rows.
    const root = (await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).find((row) => row.id === rootId);
    expect(root?.blockedInboxAttention).toMatchObject({ reason: "blocked_chain_stalled" });
  });

  it("still treats a blocked inbox root as truncated when its graph exceeds the node limit", async () => {
    const { companyId, agentId } = await createCompany("BNL");
    const rootId = await insertIssue({
      companyId,
      identifier: "BNL-1",
      title: "Blocked source",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    // Human-owned children are each covered, so only the node limit can put the root in the inbox.
    await db.insert(issues).values(
      Array.from({ length: BLOCKER_ATTENTION_MAX_NODES + 1 }, (_, index) => ({
        id: randomUUID(),
        companyId,
        identifier: `BNL-${index + 2}`,
        title: `Child ${index}`,
        status: "todo",
        priority: "medium",
        parentId: rootId,
        assigneeUserId: "board-user",
        originKind: "manual",
        originFingerprint: "default",
      })),
    );

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });
    expect(rows.map((row) => row.id)).toEqual([rootId]);
  });
  async function seedReviewWaitingOnBlockers(prefix: string, leafStatus: string) {
    const { companyId, agentId } = await createCompany(prefix);
    const rootId = await insertIssue({
      companyId,
      identifier: `${prefix}-1`,
      title: "Blocked source",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const reviewId = await insertIssue({
      companyId,
      identifier: `${prefix}-2`,
      title: "Review waiting on its own blockers",
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId } },
    });
    const linkId = await insertIssue({
      companyId,
      identifier: `${prefix}-3`,
      title: "Link",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const leafId = await insertIssue({
      companyId,
      identifier: `${prefix}-4`,
      title: "Leaf",
      status: leafStatus,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: linkId, blockedIssueId: reviewId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: linkId });
    return { companyId, agentId, rootId, reviewId, leafId };
  }

  it("covers an in_review blocker whose own unfinished blockers end in a running run", async () => {
    const { companyId, agentId, rootId, leafId } = await seedReviewWaitingOnBlockers("BRR", "in_progress");
    await activeRun({ companyId, agentId, issueId: leafId });

    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);
    expect(root?.blockerAttention).toMatchObject({ state: "covered", stalledBlockerCount: 0 });
    const inboxRoot = (await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).find((row) => row.id === rootId);
    expect(inboxRoot).toBeUndefined();
  });

  it("covers an in_review blocker whose own unfinished blockers end in a queued run", async () => {
    const { companyId, agentId, rootId, leafId } = await seedReviewWaitingOnBlockers("BRQ", "in_review");
    await activeRun({ companyId, agentId, issueId: leafId, status: "queued", current: false });

    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);
    expect(root?.blockerAttention).toMatchObject({ state: "covered", stalledBlockerCount: 0 });
  });

  it("judges an in_review blocker with unfinished blockers by the stalled review at the chain end", async () => {
    const { companyId, rootId } = await seedReviewWaitingOnBlockers("BRS", "in_review");

    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);
    expect(root?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      sampleStalledBlockerIdentifier: "BRS-4",
    });
  });

  it("judges an in_review blocker with unfinished blockers by an idle leaf at the chain end", async () => {
    const { companyId, rootId, leafId } = await seedReviewWaitingOnBlockers("BRT", "todo");

    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);
    expect(root?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      terminalBlockerIssueId: leafId,
    });
  });

  it("keeps an in_review blocker with no blockers and no waiting path stalled", async () => {
    const { companyId, agentId } = await createCompany("BRN");
    const rootId = await insertIssue({ companyId, identifier: "BRN-1", title: "Blocked source", status: "blocked" });
    const reviewId = await insertIssue({
      companyId,
      identifier: "BRN-2",
      title: "Review with no path",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const doneId = await insertIssue({
      companyId,
      identifier: "BRN-3",
      title: "Finished dependency",
      status: "done",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: doneId, blockedIssueId: reviewId });

    const root = (await svc.list(companyId, { status: "blocked", readCondition: sql<boolean>`true` })).find((issue) => issue.id === rootId);
    expect(root?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      sampleStalledBlockerIdentifier: "BRN-2",
    });
  });
  it.runIf(process.env.PAPERCLIP_INBOX_COST_CAPTURE)("measures inbox read projection on a company graph with private ancestry", async () => {
    const { companyId, agentId } = await createCompany("CST");
    const rootId = await insertIssue({ companyId, identifier: "CST-1", title: "Cost root", status: "blocked", assigneeAgentId: agentId });
    const ancestry = Array.from({ length: 16 }, () => randomUUID());
    for (const [index, id] of ancestry.entries()) {
      await db.insert(issues).values({ id, companyId, title: "Private ancestor", status: "todo", visibility: "private", privacyParentIssueId: ancestry[index - 1] ?? null });
    }
    const leafId = await insertIssue({ companyId, identifier: "CST-2", title: "Private stalled leaf", status: "in_review", assigneeAgentId: agentId });
    await db.update(issues).set({ privacyParentIssueId: ancestry.at(-1) }).where(eq(issues.id, leafId));
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: rootId });
    const noise = Array.from({ length: 2050 }, () => ({ companyId, title: "Unrelated private task", status: "todo", visibility: "private", privacyParentIssueId: ancestry.at(-1) }));
    for (let index = 0; index < noise.length; index += 100) await db.insert(issues).values(noise.slice(index, index + 100));
    const readCondition = await issueReadSqlCondition(db, { type: "board", userId: "cost-reader", ignoreInstanceAdmin: true });
    const readProof = process.env.PAPERCLIP_INBOX_FIXED_POINT
      ? await issueReadSqlProof(db, { type: "board", userId: "cost-reader", ignoreInstanceAdmin: true }, { companyId })
      : undefined;
    const queries: Array<{ query: string; parameters: unknown[] }> = [];
    const previousDebug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, parameters) => { queries.push({ query, parameters }); };
    try {
      if (process.env.PAPERCLIP_INBOX_COMPARE_BASELINE) {
        const paths = [process.env.PAPERCLIP_COST_BASELINE_MODULE, process.env.PAPERCLIP_COST_WIP_MODULE, process.env.PAPERCLIP_COST_AUTH_MODULE];
        if (paths.some(path => !path)) throw new Error("Comparison requires exact baseline/WIP/auth snapshots");
        const [baseline, wip, originalAuth] = await Promise.all(paths.map(path => import(path!)));
        const variants = [
          { name: "B0", service: baseline.issueService(db), fixed: false },
          { name: "WIP", service: wip.issueService(db), fixed: false },
          { name: "A1", service: svc, fixed: true },
        ];
        const actor = { type: "board" as const, userId: "cost-reader", ignoreInstanceAdmin: true };
        const entries = Object.fromEntries(variants.map(v => [v.name, [] as number[]]));
        const graphTimes = Object.fromEntries(variants.map(v => [v.name, [] as number[]]));
        const counts = Object.fromEntries(variants.map(v => [v.name, [] as number[]]));
        const statements = new Map<string, { query: string; parameters: unknown[] }>();
        const output = new Map<string, string>();
        const entryQueries = new Map<string, Array<typeof queries>>();
        for (let iteration = 0; iteration < 12; iteration++) {
          for (const variant of iteration % 2 ? [...variants].reverse() : variants) {
            queries.length = 0;
            const started = performance.now();
            const proof = variant.fixed ? await issueReadSqlProof(db, actor, { companyId }) : undefined;
            const condition = proof?.condition ?? await originalAuth.issueReadSqlCondition(db, actor);
            const filters = { attention: "blocked", issueIds: [rootId], readCondition: condition, readProof: proof };
            const rows = process.env.PAPERCLIP_INBOX_COST_ENTRY === "count"
              ? await variant.service.count(companyId, filters)
              : await variant.service.list(companyId, filters);
            entries[variant.name]!.push(performance.now() - started);
            counts[variant.name]!.push(queries.length);
            const graph = queries.find(q => q.query.includes('"issues"."status" <>'));
            expect(graph).toBeDefined();
            statements.set(variant.name, graph!);
            const recorded = entryQueries.get(variant.name) ?? [];
            recorded.push([...queries]);
            entryQueries.set(variant.name, recorded);
            output.set(variant.name, JSON.stringify(rows));
            if (typeof rows === "number") expect(rows).toBe(1);
            else expect(rows.map((row: { id: string }) => row.id)).toEqual([rootId]);
          }
        }
        expect(output.get("A1")).toBe(output.get("WIP"));
        if (process.env.PAPERCLIP_INBOX_COST_REPORT) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(process.env.PAPERCLIP_INBOX_COST_REPORT + ".partial", JSON.stringify({ counts, entryQueries: [...entryQueries] }));
        }
        for (const variant of variants.filter(v => v.name !== "B0"))
          expect(Math.max(...counts[variant.name]!.slice(2)), variant.name).toBeLessThanOrEqual(Math.min(...counts.B0!.slice(2)));
        for (let iteration = 0; iteration < 12; iteration++) {
          for (const variant of iteration % 2 ? [...variants].reverse() : variants) {
            const statement = statements.get(variant.name)!;
            const started = performance.now();
            const rows = await db.$client.unsafe(statement.query, statement.parameters as never[]);
            graphTimes[variant.name]!.push(performance.now() - started);
            expect(rows.length).toBe(2068);
          }
        }
        const statistics = (values: number[]) => {
          const measured = values.slice(2), sorted = [...measured].sort((a, b) => a - b);
          return { medianMs: (sorted[4]! + sorted[5]!) / 2, maxMs: Math.max(...measured), warmups: values.slice(0, 2), samples: measured };
        };
        const results = [];
        for (const variant of variants) {
          const statement = statements.get(variant.name)!;
          const plan = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`, statement.parameters as never[]);
          results.push({ variant: variant.name, entry: statistics(entries[variant.name]!), graph: statistics(graphTimes[variant.name]!),
            queries: counts[variant.name], graphRows: 2068, outputBytes: Buffer.byteLength(output.get(variant.name)!),
            entryQueries: entryQueries.get(variant.name), plan });
        }
        const report = { entry: process.env.PAPERCLIP_INBOX_COST_ENTRY ?? "list", fixture: { issues: 2068, ancestryDepth: 16, reader: "cost-reader" },
          order: "forward/reverse alternating; 2 warmups and 10 measured per variant", predicateConstructionIncluded: true,
          authMiddleware: "UNMEASURED", classificationVisits: "UNMEASURED", results };
        if (process.env.PAPERCLIP_INBOX_COST_REPORT) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(process.env.PAPERCLIP_INBOX_COST_REPORT, JSON.stringify(report));
        }
        process.stdout.write(JSON.stringify({ interleavedInboxCost: results.map(({ entryQueries: _queries, plan: _plan, ...summary }) => summary) }) + "\n");
        return;
      }
      const elapsed: number[] = [];
      let queryCount = 0, outputBytes = 0;
      for (let iteration = 0; iteration < 12; iteration++) {
        queries.length = 0;
        const started = performance.now();
        const rows = await svc.list(companyId, { attention: "blocked", issueIds: [rootId], readCondition: readProof?.condition ?? readCondition, readProof });
        const duration = performance.now() - started;
        if (iteration >= 2) elapsed.push(duration);
        queryCount = queries.length;
        outputBytes = Buffer.byteLength(JSON.stringify(rows));
      }
      const graph = queries.find(({ query }) => query.includes('"issues"."status" <>'));
      expect(graph).toBeDefined();
      const query = graph!;
      const graphElapsed: number[] = [];
      let graphRows = 0;
      for (let iteration = 0; iteration < 12; iteration++) {
        const started = performance.now();
        const rows = await db.$client.unsafe(query.query, query.parameters as never[]);
        if (iteration >= 2) graphElapsed.push(performance.now() - started);
        graphRows = rows.length;
      }
      const plan = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query}`, query.parameters as never[]);
      if (readProof) {
        const recursiveLoops: number[] = [];
        const visit = (node: { [key: string]: unknown; Plans?: Array<Record<string, unknown>> }) => {
          if (node["Node Type"] === "Recursive Union") recursiveLoops.push(Number(node["Actual Loops"]));
          for (const child of node.Plans ?? []) visit(child);
        };
        visit(plan[0]["QUERY PLAN"][0].Plan);
        expect(recursiveLoops.length).toBeGreaterThan(0);
        expect(Math.max(...recursiveLoops)).toBe(1);
      }
      const statistics = (values: number[]) => ({ medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)], maxMs: Math.max(...values) });
      process.stdout.write(JSON.stringify({ inboxCost: process.env.PAPERCLIP_INBOX_COST_CAPTURE, queryCount, graphRows, ancestryDepth: 16, outputBytes, entry: statistics(elapsed), graph: statistics(graphElapsed), plan }) + "\n");
    } finally {
      db.$client.options.debug = previousDebug;
    }
  }, process.env.PAPERCLIP_INBOX_COMPARE_BASELINE ? 180_000 : 90_000);

  it("preserves unreadable blockers on public replacement and checks the effective set before starting", async () => {
    const { companyId, agentId } = await createCompany("EDP");
    const reader = "edit-reader";
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: reader, membershipRole: "member", status: "active" });
    const rootId = await insertIssue({ companyId, identifier: "EDP-1", title: "Root", status: "blocked", assigneeAgentId: agentId });
    const hiddenId = await insertIssue({ companyId, identifier: "EDP-SECRET", title: "Secret blocker", status: "todo", visibility: "private" });
    const visibleId = await insertIssue({ companyId, identifier: "EDP-2", title: "Visible blocker", status: "todo" });
    await block({ companyId, blockerIssueId: hiddenId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: visibleId, blockedIssueId: rootId });
    const readCondition = await issueReadSqlCondition(db, { type: "board", userId: reader, ignoreInstanceAdmin: true });
    const updated = await svc.updateReadable(rootId, { blockedByIssueIds: [] }, { readCondition });
    expect(updated?.blockedByIssueIds).toEqual([hiddenId]);
    expect(updated?.changes.blockedByIssueIds).toEqual({ from: [hiddenId, visibleId].sort(), to: [hiddenId] });
    expect((await svc.getRelationSummaries(rootId)).blockedBy.map(row => row.id)).toEqual([hiddenId]);
    await expect(svc.updateReadable(rootId, { status: "in_progress", blockedByIssueIds: [] }, { readCondition }))
      .rejects.toMatchObject({ status: 422, details: { unresolvedBlockerIssueIds: [], unresolvedBlockers: [] } });
    expect((await svc.getById(rootId))?.status).toBe("blocked");
    const anotherHidden = await insertIssue({ companyId, identifier: "EDP-OTHER", title: "Other secret", status: "todo", visibility: "private" });
    await expect(svc.updateReadable(rootId, { blockedByIssueIds: [anotherHidden] }, { readCondition }))
      .rejects.toMatchObject({ status: 422 });
    const noProof = await svc.updateReadable(rootId, { blockedByIssueIds: [] }, { readCondition: undefined });
    expect(noProof?.blockedByIssueIds).toEqual([hiddenId]);
    await db.insert(issueAccessGrants).values({ issueId: hiddenId, subjectType: "user", subjectId: reader, source: "explicit" });
    await svc.updateReadable(rootId, { blockedByIssueIds: [] }, { readCondition });
    expect((await svc.getRelationSummaries(rootId)).blockedBy).toEqual([]);
    await block({ companyId, blockerIssueId: hiddenId, blockedIssueId: rootId });
    await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, hiddenId));
    const afterRevoke = await svc.updateReadable(rootId, { blockedByIssueIds: [] }, { readCondition });
    expect(afterRevoke?.blockedByIssueIds).toEqual([hiddenId]);
    await svc.update(rootId, { blockedByIssueIds: [] });
    expect((await svc.getRelationSummaries(rootId)).blockedBy).toEqual([]);
  });

  it("does not restore a hidden blocker removed before the public replacement obtains the root lock", async () => {
    const { companyId } = await createCompany("ERC");
    const rootId = await insertIssue({ companyId, identifier: "ERC-1", title: "Root", status: "blocked" });
    const hiddenId = await insertIssue({ companyId, identifier: "ERC-SECRET", title: "Hidden", status: "todo", visibility: "private" });
    await block({ companyId, blockerIssueId: hiddenId, blockedIssueId: rootId });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let removed!: () => void;
    const removalReady = new Promise<void>(resolve => { removed = resolve; });
    const removing = db.transaction(async tx => {
      await svc.update(rootId, { blockedByIssueIds: [] }, tx);
      removed();
      await released;
    });
    await removalReady;
    let lockRequested!: () => void;
    const lockReady = new Promise<void>(resolve => { lockRequested = resolve; });
    const previousDebug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, parameters) => {
      if (/for update/i.test(query) && parameters.includes(rootId)) lockRequested();
    };
    try {
      const replacing = svc.updateReadable(rootId, { blockedByIssueIds: [] }, { readCondition: undefined });
      await lockReady;
      release();
      await removing;
      expect((await replacing)?.blockedByIssueIds).toEqual([]);
      expect((await svc.getRelationSummaries(rootId)).blockedBy).toEqual([]);
    } finally {
      release();
      await removing;
      db.$client.options.debug = previousDebug;
    }
  });

  it.each([false, true])("does not add service queries for public replacement with a requested target: %s", async (withTarget) => {
    const { companyId } = await createCompany("QRP");
    const rootId = await insertIssue({ companyId, identifier: "QRP-1", title: "Root", status: "blocked" });
    const hiddenId = await insertIssue({ companyId, identifier: "QRP-SECRET", title: "Hidden", status: "todo", visibility: "private" });
    const visibleId = await insertIssue({ companyId, identifier: "QRP-2", title: "Visible", status: "todo" });
    await block({ companyId, blockerIssueId: hiddenId, blockedIssueId: rootId });
    const readCondition = await issueReadSqlCondition(db, { type: "board", userId: "query-reader", ignoreInstanceAdmin: true });
    const blockedByIssueIds = withTarget ? [visibleId] : [];
    const previousDebug = db.$client.options.debug;
    const rollback = new Error("query probe rollback");
    const measure = async (publicMode: boolean, prepared = false) => {
      let queries = 0;
      db.$client.options.debug = () => { queries += 1; };
      try {
        await db.transaction(async tx => {
          if (publicMode) await svc.updateReadable(rootId, { blockedByIssueIds }, {
            readCondition, ...(prepared ? { resolveCommentReopen: () => ({}) } : {}),
          }, tx);
          else await svc.update(rootId, { blockedByIssueIds }, tx);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      } finally {
        db.$client.options.debug = previousDebug;
      }
      return queries;
    };
    const rawQueries = await measure(false);
    const publicQueries = await measure(true);
    const preparedQueries = await measure(true, true);
    expect(preparedQueries).toBeLessThanOrEqual(rawQueries);
    expect(rawQueries).toBeGreaterThan(0);
    expect(publicQueries).toBeLessThanOrEqual(rawQueries);
    process.stdout.write(JSON.stringify({ replacementQueryProbe: { withTarget, rawQueries, publicQueries, preparedQueries } }) + "\n");
  });

  it("omits unreadable direct and terminal relations while preserving raw relations", async () => {
    const { companyId, agentId } = await createCompany("RSM");
    const reader = "relation-reader";
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: reader, membershipRole: "member", status: "active" });
    const rootId = await insertIssue({ companyId, identifier: "RSM-1", title: "Public root", status: "blocked", assigneeAgentId: agentId });
    const middleId = await insertIssue({ companyId, identifier: "RSM-2", title: "Public blocker", status: "blocked" });
    const hiddenId = await insertIssue({ companyId, identifier: "RSM-SECRET", title: "Hidden terminal", status: "todo", visibility: "private" });
    await block({ companyId, blockerIssueId: middleId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: hiddenId, blockedIssueId: middleId });
    const hiddenDependentId = await insertIssue({ companyId, identifier: "RSM-DEPENDENT", title: "Hidden dependent", status: "blocked", visibility: "private" });
    await block({ companyId, blockerIssueId: rootId, blockedIssueId: hiddenDependentId });
    const readCondition = await issueReadSqlCondition(db, { type: "board", userId: reader, ignoreInstanceAdmin: true });
    const visible = await svc.getReadableRelationSummaries(rootId, { readCondition });
    expect(visible.blockedBy.map(row => row.id)).toEqual([middleId]);
    expect(visible.blocks).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain(hiddenId);
    expect(JSON.stringify(visible)).not.toContain("RSM-SECRET");
    const raw = await svc.getRelationSummaries(rootId);
    expect(raw.blockedBy[0]?.terminalBlockers?.map(row => row.id)).toEqual([hiddenId]);
    expect(raw.blocks.map(row => row.id)).toEqual([hiddenDependentId]);
    expect(await svc.getReadableRelationSummaries(rootId, { readCondition: undefined })).toEqual({ blockedBy: [], blocks: [] });
    await db.insert(issueAccessGrants).values({ issueId: hiddenId, subjectType: "user", subjectId: reader, source: "explicit" });
    const granted = await svc.getReadableRelationSummaries(rootId, { readCondition });
    expect(granted.blockedBy).toEqual(raw.blockedBy);
    expect(granted.blocks).toEqual([]);
  });

  it.each(["issue", "project", "ancestor"])("projects %s privacy through all inbox entries with and without a cycle", async (privacy) => {
    const { companyId, agentId } = await createCompany("RDP");
    const reader = "projection-reader";
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: reader, membershipRole: "member", status: "active" });
    const rootId = await insertIssue({ companyId, identifier: "RDP-1", title: "Readable root", status: "blocked", assigneeAgentId: agentId });
    const leafId = await insertIssue({ companyId, identifier: "RDP-SECRET", title: "Private review", status: "in_review", assigneeAgentId: agentId, visibility: privacy === "issue" ? "private" : "open" });
    let grantId = leafId;
    if (privacy === "project") {
      const [project] = await db.insert(projects).values({ companyId, name: "Hidden project", visibility: "private" }).returning();
      await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, leafId));
    }
    if (privacy === "ancestor") {
      grantId = await insertIssue({ companyId, identifier: "RDP-ANCESTOR", title: "Privacy ancestor", status: "todo", visibility: "private" });
      await db.update(issues).set({ privacyParentIssueId: grantId }).where(eq(issues.id, leafId));
    }
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: rootId });
    for (const cycle of [false, true]) {
      if (cycle) {
        await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, leafId));
        await block({ companyId, blockerIssueId: rootId, blockedIssueId: leafId });
      }
      for (const granted of [false, true]) {
        if (granted) await db.insert(issueAccessGrants).values({ issueId: grantId, subjectType: "user", subjectId: reader, source: "explicit" });
        for (const actor of [
          { type: "board" as const, userId: reader, ignoreInstanceAdmin: true },
          { type: "agent" as const, agentId, authorizingUserId: reader, onBehalfOfUserId: reader },
        ]) {
          const readCondition = await issueReadSqlCondition(db, actor);
          const rows = await svc.list(companyId, { attention: "blocked", readCondition });
          const attention = rows.find((row) => row.id === rootId)?.blockedInboxAttention;
          expect(attention).toMatchObject({ sourceIssue: { id: rootId }, sampleIssueIdentifier: granted ? (cycle ? "RDP-1" : "RDP-SECRET") : null });
          if (!granted) {
            expect(attention).toMatchObject({ leafIssue: null, owner: { type: "unknown", agentId: null } });
            expect(JSON.stringify(attention)).not.toContain("RDP-SECRET");
            expect(JSON.stringify(rows.find((row) => row.id === rootId))).not.toContain("RDP-SECRET");
            expect(attention?.reason).toBe(cycle ? "blocked_by_dependency_cycle" : "blocked_chain_stalled");
          } else expect(attention?.owner).toMatchObject({ type: "agent", agentId });
          const ordinary = await svc.list(companyId, { issueIds: [rootId], includeBlockedInboxAttention: true, readCondition });
          expect(ordinary[0]?.blockedInboxAttention).toEqual(attention);
          expect(await svc.count(companyId, { attention: "blocked", readCondition })).toBe(rows.length);
        }
        await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, grantId));
      }
    }
    const unproven = (await svc.list(companyId, { attention: "blocked" })).find((row) => row.id === rootId)?.blockedInboxAttention;
    expect(unproven).toMatchObject({ sourceIssue: null, sampleIssueIdentifier: null, leafIssue: null, owner: { type: "unknown" } });
  });

  it("reports a cycle through a parent waiting on its child as a dependency cycle", async () => {
    const { companyId, agentId } = await createCompany("BCY");
    const mk = (n: number, status: string, parentId: string | null = null) =>
      insertIssue({ companyId, identifier: `BCY-${n}`, title: `Issue ${n}`, status, assigneeAgentId: agentId, parentId });
    const parentId = await mk(2984, "blocked");
    const coveredChildId = await mk(3004, "blocked", parentId);
    const cycleChildId = await mk(3006, "blocked", parentId);
    const middleId = await mk(2967, "blocked");
    const leafId = await mk(4224, "in_progress");
    await block({ companyId, blockerIssueId: coveredChildId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: coveredChildId });
    await block({ companyId, blockerIssueId: middleId, blockedIssueId: cycleChildId });
    await block({ companyId, blockerIssueId: parentId, blockedIssueId: middleId });
    await activeRun({ companyId, agentId, issueId: leafId });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });

    expect(rows.map((row) => row.identifier).sort()).toEqual(["BCY-2967", "BCY-2984", "BCY-3006"]);
    for (const row of rows) {
      expect(row.blockedInboxAttention).toMatchObject({
        state: "needs_attention",
        reason: "blocked_by_dependency_cycle",
        owner: { type: "agent", agentId },
        action: { label: "Break dependency cycle" },
      });
    }
    expect(rows.find((row) => row.id === parentId)?.blockedInboxAttention).toMatchObject({
      leafIssue: { id: parentId, identifier: "BCY-2984" },
      sampleIssueIdentifier: "BCY-2984",
      action: {
        detail:
          "BCY-2984 → BCY-3006 → BCY-2967 → BCY-2984. Links: BCY-2984 → BCY-3006 parent-waits-child; " +
          "BCY-3006 → BCY-2967 blocked-by; BCY-2967 → BCY-2984 blocked-by. Remove one link to break the cycle.",
      },
    });
    // The covered child is not on the cycle, so it stays out of the inbox.
    expect(rows.some((row) => row.id === coveredChildId)).toBe(false);
  });

  it("reports a cycle made only of blocks links and names its first agent owner", async () => {
    const { companyId, agentId } = await createCompany("BCB");
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "BCB Other", role: "engineer", status: "idle" });
    const rootId = await insertIssue({ companyId, identifier: "BCB-1", title: "Root", status: "todo", assigneeAgentId: agentId });
    const firstId = await insertIssue({ companyId, identifier: "BCB-2", title: "First", status: "blocked", assigneeAgentId: otherAgentId });
    const secondId = await insertIssue({ companyId, identifier: "BCB-3", title: "Second", status: "blocked", assigneeAgentId: agentId });
    await block({ companyId, blockerIssueId: firstId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: secondId, blockedIssueId: firstId });
    await block({ companyId, blockerIssueId: firstId, blockedIssueId: secondId });

    const rows = await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` });

    expect(rows.find((row) => row.id === firstId)?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_dependency_cycle",
      owner: { type: "agent", agentId: otherAgentId },
      action: {
        label: "Break dependency cycle",
        detail:
          "BCB-2 → BCB-3 → BCB-2. Links: BCB-2 → BCB-3 blocked-by; BCB-3 → BCB-2 blocked-by. " +
          "Remove one link to break the cycle.",
      },
    });
    expect(rows.find((row) => row.id === secondId)?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_dependency_cycle",
      owner: { type: "agent", agentId },
    });
  });

  it("does not report a cycle for a diamond that reaches one blocker twice", async () => {
    const { companyId, agentId } = await createCompany("BCD");
    const rootId = await insertIssue({ companyId, identifier: "BCD-1", title: "Root", status: "blocked", assigneeAgentId: agentId });
    const leftId = await insertIssue({ companyId, identifier: "BCD-2", title: "Left", status: "todo", assigneeAgentId: agentId });
    const rightId = await insertIssue({ companyId, identifier: "BCD-3", title: "Right", status: "todo", assigneeAgentId: agentId });
    const leafId = await insertIssue({ companyId, identifier: "BCD-4", title: "Stalled review", status: "in_review", assigneeAgentId: agentId });
    await block({ companyId, blockerIssueId: leftId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: rightId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: leftId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: rightId });

    const root = (await svc.list(companyId, { attention: "blocked", readCondition: sql<boolean>`true` })).find((row) => row.id === rootId);

    expect(root?.blockedInboxAttention).toMatchObject({ reason: "blocked_chain_stalled" });
  });
});
