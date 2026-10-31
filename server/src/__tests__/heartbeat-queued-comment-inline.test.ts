import { randomUUID } from "node:crypto";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createQueuedCommentQueue } from "../modules/wake-queue/index.js";
import { queuedCommentQueueRevision } from "../services/issue-queued-comment-queue.js";
import { heartbeatService } from "../services/heartbeat.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("coalesced queued comment input", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("review-submission-generation-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Review sponsor", email: "sponsor@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE TABLE companies CASCADE`);
  }); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Consumer fixture", issuePrefix: "C" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board",
      membershipRole: "operator", status: "active" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review",
      responsibleUserId: "board", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId: authorId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2,
        reviewRequest: { instructions: "Review the same submission" } } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: authorId, status: "cancelled",
      errorCode: "issue_reassigned", finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: { issueId },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true } }).returning();
    return { companyId, agentId, issueId, source, issue };
  }

  it.each([
    { locked: false, count: 2, immutable: false, resume: "same" },
    { locked: true, count: 2, immutable: false, resume: "same" },
    { locked: false, count: 2, immutable: false, resume: "changed" },
    { locked: true, count: 2, immutable: false, resume: "incoming" },
    { locked: false, count: 2, immutable: false, resume: "changed-followup" },
    { locked: false, count: 2, immutable: true, interaction: true },
    { locked: false, count: 2, immutable: true, interaction: true, immutableIncoming: true },
    { locked: false, count: 2, immutable: false, routed: true },
    { locked: true, count: 2, immutable: false, routed: true },
    { locked: false, count: 2, immutable: false, claimFirst: true },
    { locked: false, count: 2, immutable: false, mergeFirst: true },
    { locked: false, count: 3, immutable: false, sameTask: true },
    { locked: false, count: 3, immutable: false, duplicate: true },
    { locked: false, count: 2, immutable: true, immutableIncoming: true },
    { locked: true, count: 2, immutable: true, immutableIncoming: true },
    { locked: false, count: 3, immutable: false, edited: true },
    { locked: true, count: 3, immutable: false, edited: true },
    { locked: false, count: 3, immutable: false, deleted: true },
    { locked: true, count: 3, immutable: false, deleted: true },
    { locked: false, count: 2, immutable: false, scheduled: true },
    { locked: true, count: 2, immutable: false, scheduled: true },
    { locked: false, count: 3, immutable: false, reordered: true },
    { locked: true, count: 3, immutable: false, reordered: true },
    { locked: false, count: 2, immutable: false },
    { locked: true, count: 2, immutable: false },
    { locked: false, count: 3, immutable: false },
    { locked: true, count: 3, immutable: false },
    { locked: false, count: 2, immutable: true },
    { locked: true, count: 2, immutable: true },
  ])("preserves provider input ($locked, $count comments, immutable=$immutable, reordered=$reordered, scheduled=$scheduled, edited=$edited, deleted=$deleted, sameTask=$sameTask, duplicate=$duplicate, immutableIncoming=$immutableIncoming, claimFirst=$claimFirst, mergeFirst=$mergeFirst, routed=$routed, interaction=$interaction, resume=$resume)", async ({ locked, count, immutable, reordered, scheduled, edited, deleted, sameTask, duplicate, immutableIncoming, claimFirst, mergeFirst, routed, interaction, resume }) => {
    const f = await seed();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const dir = await mkdtemp(join(tmpdir(), "queued-inline-"));
    const marker = join(dir, "input.jsonl");
    const providerRelease = join(dir, "release");
    const separate = immutable || scheduled || claimFirst || Boolean(resume && resume !== "same");
    const entered = deferred();
    const attempted = deferred();
    const release = deferred();
    let resumed: Promise<unknown> | undefined;
    let pendingSecond: ReturnType<typeof commentWake> | undefined;
    let restore: (() => void) | undefined;
    const command = join(dir, "provider.cjs");
    await writeFile(command, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  require("node:fs").appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID, input }) + "\\n");
  const finish = () => console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Synthetic completion", session_id: "synthetic-session" }));
  if (${Boolean(claimFirst)} && !require("node:fs").existsSync(${JSON.stringify(providerRelease)})) {
    const watcher = require("node:fs").watch(${JSON.stringify(dir)}, () => {
      if (require("node:fs").existsSync(${JSON.stringify(providerRelease)})) { watcher.close(); finish(); }
    });
  } else finish();
});
`, { mode: 0o700 });
    await db.update(agents).set({ adapterType: "claude_local", adapterConfig: { command, engine: "cli", cwd: dir, timeoutSec: 20 } }).where(eq(agents.id, f.agentId));
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    async function commentWake(body: string, later = false) {
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: "board", body }).returning();
      let interactionContext: Record<string, unknown> = {};
      if (interaction && Boolean(immutableIncoming) === later) {
        const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          status: "succeeded", finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: {
            issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id],
          } }).returning();
        const [answer] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
          kind: "request_confirmation", status: "accepted", createdByAgentId: f.agentId,
          sourceRunId: source.id, sourceCommentId: comment.id, originCommentIds: [comment.id],
          payload: { version: 1, prompt: "Continue the synthetic task?" }, result: { outcome: "accepted" },
          resolvedByUserId: "board", resolvedAt: new Date(),
        }).returning();
        interactionContext = { interactionId: answer.id, interactionKind: answer.kind, interactionStatus: answer.status,
          sourceRunId: source.id, sourceCommentId: comment.id, source: "issue.interaction.respond" };
      }
      const resumeContext = resume && (resume === "same" || resume === "changed-followup" || (resume === "incoming" ? later : !later))
        ? { resumeIntent: true, followUpRequested: !(resume === "changed-followup" && later) } : {};
      const run = await service.wakeup(f.agentId, { source: "automation", reason: "issue_commented",
        payload: { ...(sameTask && later ? {} : { issueId: f.issueId }), commentId: comment.id, ...(routed ? { mutation: "comment" } : {}), ...resumeContext, ...interactionContext },
        contextSnapshot: { wakeCommentId: comment.id, ...(routed ? { source: "issue.comment" } : {}), ...(sameTask && later ? { taskKey: f.issueId } : {}), ...resumeContext, ...interactionContext },
        ...(immutableIncoming && later ? { idempotencyKey: "immutable-incoming" } :
          interaction && !immutableIncoming && !later ? { idempotencyKey: "immutable-root" } : {}),
        requestedByActorType: "user", requestedByActorId: "board" });
      return { run, comment };
    }
    try {
      const first = await commentWake("FIRST_INLINE_BODY_177");
      expect(first.run).toBeTruthy();
      if (locked) await db.update(issues).set({ executionRunId: first.run!.id }).where(eq(issues.id, f.issueId));
      if (immutable && !immutableIncoming) await db.update(agentWakeupRequests).set({ idempotencyKey: "immutable-root" })
        .where(eq(agentWakeupRequests.id, first.run!.wakeupRequestId!));
      if (scheduled) {
        const [parent] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
          finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: { issueId: f.issueId }, errorCode: "adapter_failed" }).returning();
        await db.update(heartbeatRuns).set({ status: "scheduled_retry", retryOfRunId: parent.id,
          scheduledRetryAt: new Date(Date.now() + 3_600_000), scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1 })
          .where(eq(heartbeatRuns.id, first.run!.id));
      }
      if (claimFirst || mergeFirst) {
        const transaction = db.transaction.bind(db);
        const spy = vi.spyOn(db, "transaction").mockImplementation((callback, options) => transaction(async tx => {
          if (mergeFirst && resumed) attempted.resolve();
          const value = await callback(tx);
          const result = value as { kind?: string; run?: { id: string } } | undefined;
          if (result?.run?.id === first.run!.id && result.kind === (claimFirst ? "claimed" : "coalesced")) {
            entered.resolve();
            await release.promise;
          }
          return value;
        }, options));
        restore = () => spy.mockRestore();
        if (claimFirst) {
          await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
          resumed = service.resumeQueuedRuns();
          await Promise.race([entered.promise, resumed.then(() => { throw new Error("Claim missed transaction barrier"); })]);
          pendingSecond = commentWake("SECOND_INLINE_BODY_177", true);
        } else {
          pendingSecond = commentWake("SECOND_INLINE_BODY_177", true);
          await Promise.race([entered.promise, pendingSecond.then(() => { throw new Error("Merge missed transaction barrier"); })]);
          await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
          resumed = service.resumeQueuedRuns();
          await Promise.race([attempted.promise, resumed.then(() => { throw new Error("Claim missed queued merge"); })]);
        }
        release.resolve();
      }
      const second = await (pendingSecond ?? commentWake("SECOND_INLINE_BODY_177", true));
      await writeFile(providerRelease, "release");
      await resumed;
      restore?.();
      restore = undefined;
      if (duplicate) {
        const again = await service.wakeup(f.agentId, { source: "automation", reason: "issue_commented",
          payload: { issueId: f.issueId, commentId: second.comment.id },
          requestedByActorType: "user", requestedByActorId: "board" });
        expect(again?.id).toBe(first.run!.id);
      }
      const third = count === 3 ? await commentWake("THIRD_INLINE_BODY_177", true) : null;
      const comments = [first.comment, second.comment, ...(third ? [third.comment] : [])];
      if (separate) expect(second.run).toBeNull();
      else expect(second.run?.id).toBe(first.run!.id);
      if (edited || deleted) {
        const queue = createQueuedCommentQueue(db, {
          syncCommentReferences: async () => {}, deleteCommentReferenceSource: async () => {}, syncCommentExternalObjectsSafely: async () => {},
        });
        const target = { issue: { ...f.issue, executionRunId: locked ? first.run!.id : null },
          actor: { actorType: "user" as const, actorId: "board", agentId: null, runId: null, agentApiKeyId: null },
          queueId: first.run!.wakeupRequestId!, commentId: second.comment.id,
          revision: queuedCommentQueueRevision({ queueId: first.run!.wakeupRequestId!, comments }), now: new Date() };
        if (edited) {
          await queue.editQueuedComment({ ...target, body: "EDITED_INLINE_BODY_178" });
          second.comment.body = "EDITED_INLINE_BODY_178";
        } else {
          await queue.discardQueuedComment(target);
          comments.splice(1, 1);
        }
      }
      if (reordered) {
        const queue = createQueuedCommentQueue(db, {
          syncCommentReferences: async () => {}, deleteCommentReferenceSource: async () => {}, syncCommentExternalObjectsSafely: async () => {},
        });
        comments.reverse();
        await queue.reorderQueuedComments({ issue: { ...f.issue, executionRunId: locked ? first.run!.id : null },
          actor: { actorType: "user", actorId: "board", agentId: null, runId: null, agentApiKeyId: null },
          queueId: first.run!.wakeupRequestId!,
          revision: queuedCommentQueueRevision({ queueId: first.run!.wakeupRequestId!, comments: [...comments].reverse() }),
          orderedCommentIds: comments.map(comment => comment.id), now: new Date(),
        });
      }
      const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.run!.id));
      const [root] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, first.run!.wakeupRequestId!));
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      const sourceReceipt = immutable
        ? wakes.find(wake => wake.idempotencyKey === (immutableIncoming ? "immutable-incoming" : "immutable-root"))
        : undefined;
      if (immutable) expect(sourceReceipt).toBeTruthy();
      if (!separate) expect(wakes.find(w => w.payload?.commentId === second.comment.id)?.runId).toBe(first.run!.id);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      if (scheduled) await service.retryScheduledRetryNow({ issueId: f.issueId, actor: { actorType: "user", actorId: "board" } });
      await service.resumeQueuedRuns(); await service.drainActiveRunExecutions();
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.run!.id));
      expect(finished.status).toBe("succeeded");
      if (sourceReceipt) {
        const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, sourceReceipt.id));
        expect(after).toMatchObject({ payload: sourceReceipt.payload, idempotencyKey: sourceReceipt.idempotencyKey,
          requestedByActorType: sourceReceipt.requestedByActorType, requestedByActorId: sourceReceipt.requestedByActorId,
          source: sourceReceipt.source, reason: immutableIncoming ? "issue_execution_promoted" : sourceReceipt.reason });
      }
      const inputs: Array<{runId: string; input: string}> = (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const envelopes = inputs.map(item => {
        const match = item.input.match(/```text\n(\{[^\n]+\})\n```/);
        expect(match).toBeTruthy();
        return JSON.parse(match![1]);
      });
      const expectedIds = comments.map(comment => comment.id);
      expect.soft(envelopes.flatMap(envelope => envelope.originCommentIds)).toEqual(expectedIds);
      expect(inputs).toHaveLength(separate ? 2 : 1);
      for (const [index, input] of inputs.entries()) {
        if (edited || deleted) expect(input.input).not.toContain("SECOND_INLINE_BODY_177");
        if (reordered) {
          expect(envelopes[index].coverage.throughCommentId).toBe(third!.comment.id);
          expect(envelopes[index].objectiveSource.id).toBe(third!.comment.id);
        }
        const pendingIds = envelopes[index].originCommentIds;
        const delivered = envelopes[index].messages.filter((message: {id: string}) => pendingIds.includes(message.id));
        expect.soft(delivered.map((message: {id: string}) => message.id)).toEqual(pendingIds);
        expect.soft(delivered.map((message: {body: string}) => message.body)).toEqual(
          comments.filter(comment => pendingIds.includes(comment.id)).map(comment => comment.body));
        for (const comment of comments.filter(comment => pendingIds.includes(comment.id))) expect(input.input.split(comment.body)).toHaveLength(2);
      }
      if (!separate) {
        expect(root.payload?._paperclipWakeContext).toMatchObject({ wakeCommentIds: expectedIds });
        expect(queued.contextSnapshot?.wakeCommentIds).toEqual(expectedIds);
        expect(finished.contextSnapshot?.wakeCommentIds).toEqual(expectedIds);
      }
    } finally { release.resolve(); await writeFile(providerRelease, "release"); restore?.(); await pendingSecond; await resumed; await service.drainActiveRunExecutions(); await rm(dir, { recursive: true, force: true }); }
  });
});
