import {
  SHUTDOWN_WORK_DEADLINE_MAX_MS,
  SHUTDOWN_WORK_DEADLINE_MIN_MS,
} from "@paperclipai/shared/shutdown-budget";

type BudgetLogger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  fatal(obj: object, msg: string): void;
};

export type ShutdownStepOutcome = "done" | "failed" | "timed_out" | "deadline" | "skipped";

export type ShutdownStepResult<T> =
  | { outcome: "done"; value: T }
  | { outcome: "failed"; error: unknown }
  | { outcome: "timed_out" | "deadline" | "skipped" };

/**
 * Reads `PAPERCLIP_SHUTDOWN_WORK_DEADLINE_MS`. The value may only lower the
 * work deadline: anything above the maximum, below the minimum or not a
 * number is clamped and logged, so a typo cannot push the stop past the
 * service manager's SIGKILL.
 */
export function resolveShutdownWorkDeadlineMs(
  raw: string | undefined,
  log: Pick<BudgetLogger, "warn">,
): number {
  if (raw === undefined || raw.trim() === "") return SHUTDOWN_WORK_DEADLINE_MAX_MS;
  const parsed = Number(raw);
  let resolved = parsed;
  if (!Number.isFinite(parsed) || parsed > SHUTDOWN_WORK_DEADLINE_MAX_MS) {
    resolved = SHUTDOWN_WORK_DEADLINE_MAX_MS;
  } else if (parsed < SHUTDOWN_WORK_DEADLINE_MIN_MS) {
    resolved = SHUTDOWN_WORK_DEADLINE_MIN_MS;
  }
  if (resolved !== parsed) {
    log.warn(
      {
        configured: raw,
        resolved,
        min: SHUTDOWN_WORK_DEADLINE_MIN_MS,
        max: SHUTDOWN_WORK_DEADLINE_MAX_MS,
      },
      "PAPERCLIP_SHUTDOWN_WORK_DEADLINE_MS out of range; clamped",
    );
  }
  return resolved;
}

/**
 * Runs the shutdown as a work stage with a shared deadline and a teardown
 * stage with fixed per-step caps.
 *
 * A work step gets the smaller of its own cap and the time left until the
 * deadline, and a signal that aborts at whichever comes first. A step that
 * would start after the deadline is skipped. A teardown step always starts and
 * gets its own cap. `Promise.race` does not cancel the losing promise, so a
 * step that is cut keeps running in the background: its late result or
 * rejection is logged once and otherwise ignored.
 */
export type ShutdownTestHooks = { hangWorkStep?: string; delayPostgresStopMs?: number };

/**
 * Hooks for the isolated systemd stop tests (graceful-stop plan, T3). They do
 * nothing unless PAPERCLIP_SHUTDOWN_TEST_HOOKS=1 is set on the test unit.
 */
export function readShutdownTestHooks(env: NodeJS.ProcessEnv): ShutdownTestHooks {
  if (env.PAPERCLIP_SHUTDOWN_TEST_HOOKS !== "1") return {};
  const hooks: ShutdownTestHooks = {};
  if (env.PAPERCLIP_SHUTDOWN_TEST_HANG_STEP) hooks.hangWorkStep = env.PAPERCLIP_SHUTDOWN_TEST_HANG_STEP;
  const delay = Number(env.PAPERCLIP_SHUTDOWN_TEST_DELAY_PG_STOP_MS);
  if (Number.isFinite(delay) && delay > 0) hooks.delayPostgresStopMs = delay;
  return hooks;
}

export function createShutdownBudget(input: {
  signal: "SIGINT" | "SIGTERM";
  workDeadlineMs: number;
  log: BudgetLogger;
  /** Monotonic milliseconds. */
  now?: () => number;
  testHooks?: ShutdownTestHooks;
}) {
  const now = input.now ?? (() => performance.now());
  const log = input.log;
  const startedAt = now();
  const stage = new AbortController();
  const abandoned: string[] = [];
  let workStageEnded = false;
  let anyTimedOut = false;
  let phase: string | null = null;

  const deadlineTimer = setTimeout(() => {
    if (workStageEnded) return;
    log.error(
      { signal: input.signal, phase, workDeadlineMs: input.workDeadlineMs },
      "shutdown deadline reached",
    );
    stage.abort(new Error("shutdown work deadline reached"));
  }, input.workDeadlineMs);
  deadlineTimer.unref?.();

  const elapsedMs = () => Math.round(now() - startedAt);

  async function race<T>(
    name: string,
    capMs: number,
    signals: AbortSignal[],
    run: (signal: AbortSignal) => Promise<T>,
    capOutcome: () => "timed_out" | "deadline",
    onTimeout?: () => void,
  ): Promise<ShutdownStepResult<T>> {
    const step = new AbortController();
    const signal = AbortSignal.any([step.signal, ...signals]);
    let cut = false;
    let timer: NodeJS.Timeout | null = null;
    phase = name;
    log.info({ phase: name, elapsedMs: elapsedMs(), capMs }, "shutdown phase start");

    let work: Promise<T>;
    try {
      work = Promise.resolve(run(signal));
    } catch (err) {
      work = Promise.reject(err);
    }
    // Attach the late handler before racing, so a rejection after the cut is
    // never unhandled and never re-enters the sequence.
    const settled = work.then(
      (value) => {
        if (cut) log.warn({ phase: name, outcome: "resolved" }, "shutdown phase settled late");
        return { outcome: "done", value } as ShutdownStepResult<T>;
      },
      (error: unknown) => {
        if (cut) {
          log.warn({ phase: name, outcome: "rejected", err: error }, "shutdown phase settled late");
        }
        return { outcome: "failed", error } as ShutdownStepResult<T>;
      },
    );
    const capped = new Promise<ShutdownStepResult<T>>((resolve) => {
      const fire = () => {
        if (timer) clearTimeout(timer);
        cut = true;
        resolve({ outcome: capOutcome() });
      };
      timer = setTimeout(fire, capMs);
      timer.unref?.();
      for (const s of signals) {
        if (s.aborted) fire();
        else s.addEventListener("abort", fire, { once: true });
      }
    });

    const result = await Promise.race([settled, capped]);
    if (timer) clearTimeout(timer);
    if (result.outcome === "timed_out" || result.outcome === "deadline") {
      step.abort(new Error(`shutdown phase ${name} cut at ${result.outcome}`));
      anyTimedOut = true;
      abandoned.push(name);
      onTimeout?.();
    }
    const done = { phase: name, elapsedMs: elapsedMs(), outcome: result.outcome };
    if (result.outcome === "failed") {
      log.error({ ...done, err: (result as { error: unknown }).error }, "shutdown phase done");
    } else {
      log.info(done, "shutdown phase done");
    }
    return result;
  }

  return {
    /** Aborts at the work deadline or when the work stage ends. */
    stageSignal: stage.signal,

    remainingWorkMs: () => Math.max(0, input.workDeadlineMs - (now() - startedAt)),

    async workStep<T>(
      name: string,
      capMs: number,
      run: (signal: AbortSignal) => Promise<T>,
    ): Promise<ShutdownStepResult<T>> {
      const remaining = input.workDeadlineMs - (now() - startedAt);
      if (workStageEnded || stage.signal.aborted || remaining <= 0) {
        log.info({ phase: name, elapsedMs: elapsedMs(), outcome: "skipped" }, "shutdown phase done");
        return { outcome: "skipped" };
      }
      const limitedByDeadline = remaining <= capMs;
      const hang = input.testHooks?.hangWorkStep === name;
      return race(
        name,
        Math.min(capMs, remaining),
        [stage.signal],
        hang ? () => new Promise<never>(() => {}) : run,
        () => (stage.signal.aborted || limitedByDeadline ? "deadline" : "timed_out"),
      );
    },

    /** Ends the work stage; later work steps are skipped. */
    endWorkStage() {
      workStageEnded = true;
      clearTimeout(deadlineTimer);
      if (!stage.signal.aborted) stage.abort(new Error("shutdown work stage ended"));
    },

    teardownStep<T>(
      name: string,
      capMs: number,
      run: (signal: AbortSignal) => Promise<T>,
      options?: { onTimeout?: () => void },
    ): Promise<ShutdownStepResult<T>> {
      return race(name, capMs, [], run, () => "timed_out", options?.onTimeout);
    },

    currentPhase: () => phase,
    abandonedPhases: () => [...abandoned],
    exitCode: () => (anyTimedOut ? 1 : 0),
  };
}

export type ShutdownBudget = ReturnType<typeof createShutdownBudget>;

/**
 * Exits the process if the shutdown sequence has not by `timeoutMs`. It covers
 * asynchronous hangs (a promise that never settles). It runs on the same event
 * loop, so it cannot interrupt a synchronous stall; the service manager's stop
 * timeout covers that.
 */
export function armShutdownWatchdog(input: {
  timeoutMs: number;
  currentPhase: () => string | null;
  exit: (code: number) => void;
  log: Pick<BudgetLogger, "fatal">;
}): () => void {
  const timer = setTimeout(() => {
    input.log.fatal({ phase: input.currentPhase() }, "shutdown watchdog fired");
    input.exit(1);
  }, input.timeoutMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

const HOT_RESTART_PREPARATION_CAP_MS = 20_000;
const HOT_RESTART_FENCE_CAP_MS = 5_000;

/**
 * Runs the hot-restart preparation as a work step and, if it was abandoned
 * (its cap, the deadline, or an error), the adoption fence as a second work
 * step before the caller falls back to the drain.
 *
 * The preparation gets the smaller of 20 s and the time left to the deadline
 * minus 5 s, so the fence always has its 5 s. With less than 5 s left the
 * preparation is skipped and nothing is written. The fence first aborts the
 * preparation signal, so no publish point runs after it, then revokes adoption
 * for this process. A fence that fails or is cut is logged and the work stage
 * goes on; the next boot's process checks still keep a dead run from being
 * adopted.
 */
export async function runHotRestartPreparationStep<
  T extends { skipDrain: boolean; drainRunIds?: string[] },
>(input: {
  budget: ShutdownBudget;
  log: Pick<BudgetLogger, "warn" | "error">;
  prepare: (signal: AbortSignal) => Promise<T>;
  fence: () => Promise<boolean>;
}): Promise<T | { skipDrain: false; drainRunIds?: undefined }> {
  const { budget, log } = input;
  const remainingMs = budget.remainingWorkMs();
  const capMs = Math.min(HOT_RESTART_PREPARATION_CAP_MS, remainingMs - HOT_RESTART_FENCE_CAP_MS);
  if (capMs <= 0) {
    log.warn(
      { mode: "deadline_skipped", remainingMs },
      `hot-restart preparation skipped: less than ${HOT_RESTART_FENCE_CAP_MS}ms left before the shutdown deadline`,
    );
    return { skipDrain: false };
  }

  const preparationAbort = new AbortController();
  const prepared = await budget.workStep("hot_restart_preparation", capMs, (stepSignal) =>
    input.prepare(AbortSignal.any([stepSignal, preparationAbort.signal])),
  );
  if (prepared.outcome === "done") return prepared.value;

  preparationAbort.abort(new Error(`hot-restart preparation abandoned: ${prepared.outcome}`));
  const fence = await budget.workStep("hot_restart_adoption_fence", HOT_RESTART_FENCE_CAP_MS, () =>
    input.fence(),
  );
  if (fence.outcome !== "done") {
    log.error(
      {
        outcome: fence.outcome,
        ...(fence.outcome === "failed" ? { err: fence.error } : {}),
      },
      "hot-restart adoption fence not written",
    );
  }
  if (prepared.outcome === "failed") throw prepared.error;
  throw new Error(`hot-restart preparation abandoned: ${prepared.outcome}`);
}
