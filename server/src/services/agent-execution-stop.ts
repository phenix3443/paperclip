import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";

/** Host facts used as stop evidence. Each returns null when the platform cannot answer. */
export type HostProcessProbe = {
  bootedAt(): Date | null;
  groupMemberPids(processGroupId: number): Promise<number[] | null>;
  processStartedAt(pid: number): Promise<string | null>;
};

export const hostProcessProbe: HostProcessProbe = {
  bootedAt() {
    // Linux uptime excludes suspend, so it would place the boot too late; read btime instead.
    if (process.platform === "linux") {
      const btime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
      return btime ? new Date(Number(btime) * 1000) : null;
    }
    return process.platform === "darwin" ? new Date(Date.now() - uptime() * 1000) : null;
  },
  groupMemberPids(processGroupId) {
    if (process.platform === "win32") return Promise.resolve(null);
    return new Promise(resolve => execFile("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 1_500 },
      (error, stdout) => resolve(error ? null : stdout.split("\n").map(line => line.trim().split(/\s+/).map(Number))
        .filter(([pid, group]) => pid > 0 && group === processGroupId).map(([pid]) => pid))));
  },
  processStartedAt: pid => readProcessStartedAt(pid).catch(() => null),
};

function isReleasedSshLease(lease: typeof environmentLeases.$inferSelect) {
  return lease.provider === "ssh" && Boolean(lease.releasedAt) &&
    ["released", "expired", "failed"].includes(lease.status) && lease.cleanupStatus !== "failed";
}

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[], host: HostProcessProbe = hostProcessProbe) {
  if (!agentIds.length) return true;
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return false;
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  /** The run's recorded local process or process group still exists; a reused PID or group does not count. */
  const localProcessAlive = async (run: typeof runs[number]) => {
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await host.processStartedAt(run.processPid!);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (groupAlive && !processAlive && run.finishedAt) {
      // A group ID is reused only after every original member exited, so a group whose
      // members all started after the run ended was created by someone else.
      const members = await host.groupMemberPids(run.processGroupId!);
      const started = members?.length ? await Promise.all(members.map(pid => host.processStartedAt(pid))) : null;
      if (started?.every(at => at && new Date(at).getTime() > run.finishedAt!.getTime())) groupAlive = false;
    }
    return processAlive || groupAlive;
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return false;
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return false;
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      // The SSH driver writes no termination receipt (#16346). A released SSH lease whose run has no
      // live local process keeps the proof that applied before receipts were required.
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt) &&
          !(runLeases.every(lease => hasRemoteTerminationReceipt(lease) || isReleasedSshLease(lease)) &&
            !await localProcessAlive(run))) return false;
      continue;
    }
    // No local process outlives a host restart, and PIDs recorded before it may belong to anything now.
    // Superseded by paperclipai/paperclip#17204 once it merges.
    const bootedAt = run.finishedAt ? host.bootedAt() : null;
    if (bootedAt && run.finishedAt && bootedAt.getTime() > run.finishedAt.getTime()) continue;
    if (await localProcessAlive(run)) return false;
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
    // Legacy dispatch commits the "dispatching" stage under a live controller lease before any
    // adapter process starts. A run still preparing whose controller boot is gone never dispatched.
    const neverDispatched = run.runtimeMode === "legacy" && run.executionStage === "preparing" &&
      Boolean(run.controllerBootId && run.controllerBootId !== legacyControllerBootId &&
        run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt <= new Date());
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId && !neverDispatched &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return false;
  }
  return true;
}
