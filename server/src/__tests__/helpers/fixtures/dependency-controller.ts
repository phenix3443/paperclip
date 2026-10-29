import { createDb, heartbeatRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { heartbeatService } from "../../../services/heartbeat.js";
import { legacyControllerBootId } from "../../../services/legacy-controller-lease.js";

const db = createDb(process.env.PAPERCLIP_TEST_CONTROLLER_DATABASE_URL!);
const mode = process.env.PAPERCLIP_TEST_CONTROLLER_MODE;
const service = heartbeatService(db);
process.send?.({ type: "ready", bootId: legacyControllerBootId });
try {
  if (mode === "recover") {
    await service.reapOrphanedRuns({ staleThresholdMs: 0 });
    console.info("DEPENDENCY_RECOVERY_STATE", JSON.stringify(await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, result: heartbeatRuns.resultJson, retryOf: heartbeatRuns.retryOfRunId, stage: heartbeatRuns.executionStage, retryAt: heartbeatRuns.scheduledRetryAt }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, process.env.PAPERCLIP_TEST_CONTROLLER_COMPANY_ID!))));
    // Elapse only this fixture company's existing retry delay; preserve all admission gates.
    if (process.env.PAPERCLIP_TEST_ELAPSE_RETRY_DELAY === "true") {
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(and(
        eq(heartbeatRuns.companyId, process.env.PAPERCLIP_TEST_CONTROLLER_COMPANY_ID!), eq(heartbeatRuns.status, "scheduled_retry")));
      const promoted = await service.promoteDueScheduledRetries();
      for (const runId of promoted.runIds) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        if (run) await service.resumeQueuedRunsForAgent(run.companyId, run.agentId);
      }
    }
  }
  else await service.dispatchPendingNativeStatusWakeups({ companyId: process.env.PAPERCLIP_TEST_CONTROLLER_COMPANY_ID });
  await service.drainActiveRunExecutions();
  if (mode === "recover") {
    await service.reapOrphanedRuns({ staleThresholdMs: 0 });
    await service.drainActiveRunExecutions();
  }
  await db.$client.end();
  process.send?.({ type: "drained" }, () => process.exit(0));
} catch (error) {
  process.send?.({ type: "failed", message: String(error) }, () => process.exit(1));
}
