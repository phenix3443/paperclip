import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, agentWakeupRequests, createDb, heartbeatRuns } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReviewerIntent } from "./helpers/reviewer-intent.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerExecutionControlWork, executionControlSchedule } from "../services/execution-control-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer capacity release", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-capacity-");
    db = createDb(fixture.connectionString);
    directory = await mkdtemp(join(process.env.TMPDIR!, "reviewer-provider-"));
    await db.insert(authUsers).values({ id: "board", name: "Sponsor", email: "sponsor@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); await rm(directory, { recursive: true, force: true }); });
  it("drains one same-submission reviewer after real process completion releases capacity", async () => {
    const f = await seedReviewerIntent(db);
    const release = join(directory, "release"), starts = join(directory, "starts");
    const script = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(starts)},'start\\n');
      if(!fs.existsSync(${JSON.stringify(release)})){const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);process.exit(0)}},10)}`;
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script] } }).where(eq(agents.id, f.agentId));
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    try {
      const busy = await service.wakeup(f.agentId, { source: "on_demand", reason: "capacity_fixture", requestedByActorType: "user", requestedByActorId: "board" });
      expect(busy).toBeTruthy();
      await vi.waitFor(async () => expect(await readFile(starts, "utf8")).toBe("start\n"), { timeout: 15_000 });
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
      expect(receipt).toMatchObject({ status: "coalesced" });
      expect(receipt.runId).toBeTruthy();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!)))[0].status).toBe("queued");
      await writeFile(release, "complete");
      await vi.waitFor(async () => {
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, busy!.id)))[0].status).toBe("succeeded");
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!)))[0].status).toBe("succeeded");
      }, { timeout: 15_000 });
      expect(await readFile(starts, "utf8")).toBe("start\nstart\n");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally { await writeFile(release, "complete"); await c.stop(); await service.drainActiveRunExecutions(); }
  }, 45_000);
});
