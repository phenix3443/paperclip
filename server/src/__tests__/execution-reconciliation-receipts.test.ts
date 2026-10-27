import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionReconciliationReceipts,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { expectedReconciliationStateSchema } from "@paperclipai/shared";
import { canonicalReconciliationDigest } from "@paperclipai/shared/execution-reconciliation-canonical";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildExpectedReconciliationState,
  compareExpectedReconciliationState,
  listUnstartedHoldRunIds,
  lockReconciliationKey,
  readReconciliationReceipt,
  settleReconciliationKey,
} from "../services/execution-reconciliation-receipts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("execution reconciliation receipts", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-exec-recon-receipts-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(executionReconciliationReceipts);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Receipt Co", issuePrefix: `RC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Source", status: "blocked", priority: "high", assigneeAgentId: agentId },
      { id: otherIssueId, companyId, title: "Other", status: "todo", priority: "low" },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, issueId, invocationSource: "manual", status: "failed",
      startedAt: new Date("2026-10-27T11:00:00.000Z"), finishedAt: new Date("2026-10-27T12:00:00.000Z"),
    });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active", ownerType: "board",
      returnOwnerAgentId: agentId, cause: "legacy_execution_requires_reconciliation", fingerprint: runId,
      nextAction: "Reconcile the stopped run.", evidence: { runId },
    }).returning();
    return { companyId, agentId, issueId, otherIssueId, runId, actionId: action!.id };
  }

  async function commitReceipt(fixture: Awaited<ReturnType<typeof seed>>, key: string) {
    await db.insert(executionReconciliationReceipts).values({
      companyId: fixture.companyId, issueId: fixture.issueId, actionId: fixture.actionId, runId: fixture.runId,
      idempotencyKey: key, state: "committed", requestDigest: "a".repeat(64), expectedDigest: "b".repeat(64),
      expectedSnapshot: {}, result: { status: "todo" },
    });
  }

  it("reports an unknown key as unsettled and settles it into a permanent abandoned tombstone", async () => {
    const fixture = await seed();
    const input = { companyId: fixture.companyId, issueId: fixture.issueId, idempotencyKey: "recon:unknown-key-01" };
    expect(await readReconciliationReceipt(db, input)).toEqual({ state: "unsettled" });
    const settled = await settleReconciliationKey(db, { ...input, actorUserId: "board-user" });
    expect(settled.state).toBe("abandoned");
    expect((await readReconciliationReceipt(db, input)).state).toBe("abandoned");
    // Settling again is idempotent and writes nothing new.
    expect((await settleReconciliationKey(db, { ...input, actorUserId: "board-user" })).state).toBe("abandoned");
    expect(await db.select().from(executionReconciliationReceipts)).toHaveLength(1);
  });

  it("returns a committed receipt instead of abandoning the key", async () => {
    const fixture = await seed();
    await commitReceipt(fixture, "recon:committed-key-1");
    const result = await settleReconciliationKey(db, {
      companyId: fixture.companyId, issueId: fixture.issueId, idempotencyKey: "recon:committed-key-1", actorUserId: null,
    });
    expect(result.state).toBe("committed");
  });

  it("refuses a key that belongs to another issue", async () => {
    const fixture = await seed();
    await commitReceipt(fixture, "recon:other-issue-key");
    await expect(readReconciliationReceipt(db, {
      companyId: fixture.companyId, issueId: fixture.otherIssueId, idempotencyKey: "recon:other-issue-key",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("keeps one committed receipt per action and rejects a second key for it", async () => {
    const fixture = await seed();
    await commitReceipt(fixture, "recon:first-key-0001");
    await expect(commitReceipt(fixture, "recon:second-key-001")).rejects.toThrow();
  });

  async function barrier() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return { gate, release };
  }

  it("settle waits for an in-flight resolve that holds the key and then returns its commit", async () => {
    const fixture = await seed();
    const key = "recon:in-flight-commit";
    const held = await barrier();
    const locked = await barrier();
    const inFlight = db.transaction(async (tx) => {
      await lockReconciliationKey(tx, fixture.companyId, key);
      locked.release();
      await held.gate;
      await tx.insert(executionReconciliationReceipts).values({
        companyId: fixture.companyId, issueId: fixture.issueId, actionId: fixture.actionId, runId: fixture.runId,
        idempotencyKey: key, state: "committed", requestDigest: "a".repeat(64), expectedDigest: "b".repeat(64),
        expectedSnapshot: {}, result: { status: "todo" },
      });
    });
    await locked.gate;
    const input = { companyId: fixture.companyId, issueId: fixture.issueId, idempotencyKey: key };
    // Not visible yet: unsettled is unknown, not proof of "not committed".
    expect(await readReconciliationReceipt(db, input)).toEqual({ state: "unsettled" });
    let settleDone = false;
    const settle = settleReconciliationKey(db, { ...input, actorUserId: "board-user" }).then((value) => {
      settleDone = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settleDone).toBe(false);
    held.release();
    await inFlight;
    expect((await settle).state).toBe("committed");
    expect(await db.select().from(executionReconciliationReceipts)).toHaveLength(1);
  });

  it("settle abandons the key after an in-flight resolve rolls back, and the key stays blocked", async () => {
    const fixture = await seed();
    const key = "recon:in-flight-abort";
    const held = await barrier();
    const locked = await barrier();
    const inFlight = db.transaction(async (tx) => {
      await lockReconciliationKey(tx, fixture.companyId, key);
      locked.release();
      await held.gate;
      throw new Error("injected failure before commit");
    }).catch((error: Error) => error);
    await locked.gate;
    const input = { companyId: fixture.companyId, issueId: fixture.issueId, idempotencyKey: key };
    const settle = settleReconciliationKey(db, { ...input, actorUserId: "board-user" });
    held.release();
    expect(await inFlight).toBeInstanceOf(Error);
    expect((await settle).state).toBe("abandoned");
    // The unique key index is the second guard against a late insert.
    await expect(commitReceipt(fixture, key)).rejects.toThrow();
  });

  it("builds a complete snapshot from rows and compares it by digest without leaking values", async () => {
    const fixture = await seed();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: fixture.companyId, agentId: fixture.agentId, issueId: fixture.issueId,
      invocationSource: "manual", status: "cancelled", errorCode: "execution_reconciliation_required",
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, fixture.actionId));
    const unstartedRunIds = await listUnstartedHoldRunIds(db, fixture.companyId, fixture.issueId);
    expect(unstartedRunIds).toHaveLength(1);
    const server = buildExpectedReconciliationState({ issue: issue!, run: run!, action: action!, unstartedRunIds });
    // The server snapshot satisfies the strict request schema, so a caller can echo it.
    expect(expectedReconciliationStateSchema.safeParse(server).success).toBe(true);
    const digest = canonicalReconciliationDigest(server);
    expect(compareExpectedReconciliationState(server, { expected: server, expectedDigest: digest })).toEqual({ matches: true, digest });

    const stale = structuredClone(server);
    stale.issue.monitorAttemptCount += 1;
    const mismatch = compareExpectedReconciliationState(server, { expected: stale, expectedDigest: canonicalReconciliationDigest(stale) });
    expect(mismatch).toEqual({ matches: false, digest, differingKeys: ["issue"] });
    // A client digest that does not match its own snapshot is also refused.
    expect(compareExpectedReconciliationState(server, { expected: server, expectedDigest: "0".repeat(64) }))
      .toEqual({ matches: false, digest, differingKeys: ["expectedDigest"] });
  });
});
