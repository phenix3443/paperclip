import { writeSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { buildHostServices } from "../../services/plugin-host-services.js";
import { createPluginEventBus } from "../../services/plugin-event-bus.js";

const url = process.env.DISPATCH_EVIDENCE_SDK_DATABASE_URL;

describe.skipIf(!url)("isolated SDK process fixture", () => {
  it("requests only the synthetic task supplied by its owning test", async () => {
    const companyId = process.env.DISPATCH_EVIDENCE_SDK_COMPANY_ID;
    const issueId = process.env.DISPATCH_EVIDENCE_SDK_ISSUE_ID;
    expect(companyId).toMatch(/^[a-f0-9-]{36}$/);
    expect(issueId).toMatch(/^[a-f0-9-]{36}$/);
    const db = createDb(url!);
    const host = buildHostServices(db, "synthetic-plugin", "synthetic.dispatch-evidence", createPluginEventBus(), undefined,
      { heartbeatRuntimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    try {
      const response = await host.issues.requestWakeup({ companyId: companyId!, issueId: issueId!,
        idempotencyKey: "synthetic:sdk-process-response-loss" });
      expect(response.queued).toBe(true);
      expect(response.runId).toBeTruthy();
      if (process.env.DISPATCH_EVIDENCE_SDK_CRASH === "after-admission") {
        writeSync(1, "DISPATCH_SDK_ACCEPTED_RESPONSE_LOST SIGKILL\n");
        process.kill(process.pid, "SIGKILL");
        return await new Promise<never>(() => {});
      }
      process.stdout.write(`DISPATCH_SDK_RESPONSE ${JSON.stringify(response)}\n`);
    } finally {
      writeSync(1, "DISPATCH_SDK_FINALLY\n");
      host.dispose();
      await db.$client.end();
    }
  }, 30_000);
});
