import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, authUsers, agentWakeupRequests, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { seedReviewerIntent } from "./helpers/reviewer-intent.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createReviewerAssignmentIntent } from "../services/heartbeat/reviewer-assignment-continuation.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("queued comments around reviewer intent", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-inline-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Review sponsor", email: "review-sponsor@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE TABLE companies CASCADE`);
  }); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  it.each([false, true])("preserves queued comment input around a real reviewer intent (ordinary first=%s)", async ordinaryFirst => {
    const f = await seedReviewerIntent(db, false);
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const dir = await mkdtemp(join(tmpdir(), "reviewer-inline-"));
    const marker = join(dir, "inputs.jsonl");
    const command = join(dir, "provider.cjs");
    await writeFile(command, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  require("node:fs").appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID, input }) + "\\n");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Synthetic completion", session_id: "reviewer-inline" }));
});`, { mode: 0o700 });
    await db.update(agents).set({ adapterType: "claude_local", adapterConfig: { command, engine: "cli", cwd: dir, timeoutSec: 20 } }).where(eq(agents.id, f.agentId));
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const comments: Array<{ id: string; body: string }> = [];
    const commentWake = async (body: string) => {
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorUserId: "board", body }).returning();
      comments.push(comment);
      return service.wakeup(f.agentId, { source: "automation", reason: "issue_commented",
        payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" }, contextSnapshot: { source: "issue.comment" },
        requestedByActorType: "user", requestedByActorId: "board" });
    };
    try {
      const first = ordinaryFirst ? await commentWake("REVIEWER_FIRST_INLINE_178") : null;
      const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
        sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
      expect(receipt).toBeTruthy();
      const sourceBefore = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.source.id)))[0];
      await service.reconcileReviewerAssignments();
      const [admitted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id));
      expect(admitted).toMatchObject({ status: "coalesced", payload: receipt!.payload,
        requestedByActorId: receipt!.requestedByActorId, requestedByActorType: receipt!.requestedByActorType });
      if (first) expect(admitted.runId).toBe(first.id);
      else expect(await commentWake("REVIEWER_FIRST_INLINE_178")).toBeNull();
      const second = await commentWake("REVIEWER_SECOND_INLINE_178");
      if (first) expect(second?.id).toBe(first.id);
      else expect(second).toBeNull();
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await service.resumeQueuedRuns();
      await service.drainActiveRunExecutions();
      const inputs: Array<{ runId: string; input: string }> = (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(inputs).toHaveLength(ordinaryFirst ? 1 : 2);
      const envelopes = inputs.map(item => JSON.parse(item.input.match(/```text\n(\{[^\n]+\})\n```/)![1]));
      expect(envelopes.flatMap(envelope => envelope.originCommentIds)).toEqual(comments.map(comment => comment.id));
      for (const [index, envelope] of envelopes.entries()) {
        for (const comment of comments.filter(comment => envelope.originCommentIds.includes(comment.id))) {
          expect(inputs[index].input.split(comment.body)).toHaveLength(2);
        }
      }
      const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id));
      expect(after).toEqual(admitted);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.source.id)))[0]).toEqual(sourceBefore);
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue.executionPolicy).toEqual(f.issue.executionPolicy);
      expect(issue.executionState).toEqual(f.issue.executionState);
    } finally { await service.drainActiveRunExecutions(); await rm(dir, { recursive: true, force: true }); }
  });

});
