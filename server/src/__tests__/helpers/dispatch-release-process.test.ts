import { writeSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";

const url = process.env.DISPATCH_EVIDENCE_CHILD_DATABASE_URL;

describe.skipIf(!url)("isolated release process fixture", () => {
  it("releases only the synthetic source supplied by its owning test", async () => {
    const companyId = process.env.DISPATCH_EVIDENCE_CHILD_COMPANY_ID;
    const runId = process.env.DISPATCH_EVIDENCE_CHILD_RUN_ID;
    expect(companyId).toMatch(/^[a-f0-9-]{36}$/);
    expect(runId).toMatch(/^[a-f0-9-]{36}$/);
    const db = createDb(url!);
    const crashing = process.env.DISPATCH_EVIDENCE_CHILD_CRASH === "before-commit";
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction" || !crashing) return Reflect.get(target, key);
      const transaction: typeof db.transaction = (callback, options) => target.transaction(async tx => {
        await callback(tx);
        writeSync(1, "DISPATCH_CHILD_BEFORE_COMMIT SIGKILL\n");
        process.kill(process.pid, "SIGKILL");
        return await new Promise<never>(() => {});
      }, options);
      return transaction;
    } });
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(observed, {
      resolveResponsibleUserId: async () => "release-operator",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: {
      escalateStrandedAssignedIssue: async () => { throw new Error("Unexpected child escalation"); },
      escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("Unexpected child escalation"); },
    } });
    try {
      const result = await release({ companyId: companyId!, runId: runId!, now: new Date(), suppressImmediateRecovery: true });
      expect(result.outcome.kind).toBe("promoted");
      process.stdout.write("DISPATCH_CHILD_AFTER_COMMIT\n");
    } finally { writeSync(1, "DISPATCH_CHILD_FINALLY\n"); await db.$client.end(); }
  }, 30_000);
});
