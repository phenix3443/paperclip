import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armShutdownWatchdog,
  createShutdownBudget,
  resolveShutdownWorkDeadlineMs,
} from "./shutdown-budget.js";

function stubLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
}

const never = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveShutdownWorkDeadlineMs", () => {
  it("defaults to the maximum and only lets the environment lower it", () => {
    const log = stubLogger();
    expect(resolveShutdownWorkDeadlineMs(undefined, log)).toBe(200_000);
    expect(resolveShutdownWorkDeadlineMs("60000", log)).toBe(60_000);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("clamps values outside 10 s to 200 s and logs it", () => {
    const log = stubLogger();
    expect(resolveShutdownWorkDeadlineMs("500000", log)).toBe(200_000);
    expect(resolveShutdownWorkDeadlineMs("500", log)).toBe(10_000);
    expect(resolveShutdownWorkDeadlineMs("soon", log)).toBe(200_000);
    expect(log.warn).toHaveBeenCalledTimes(3);
  });
});

describe("createShutdownBudget", () => {
  it("cuts every hung work step at the deadline and still starts every teardown step", async () => {
    const log = stubLogger();
    const budget = createShutdownBudget({ signal: "SIGTERM", workDeadlineMs: 200_000, log, now: () => Date.now() });
    const started: Record<string, number> = {};
    const t0 = Date.now();
    const mark = (phase: string) => {
      started[phase] = Date.now() - t0;
    };

    const sequence = (async () => {
      for (const [phase, cap] of [["scheduler_idle", 60_000], ["run_drain", 90_000], ["finalizers", 30_000], ["mirror_flush", 15_000], ["late", 5_000]] as const) {
        await budget.workStep(phase, cap, async () => {
          mark(phase);
          return never();
        });
      }
      budget.endWorkStage();
      await budget.teardownStep("http_close", 5_000, async () => mark("http_close"));
      await budget.teardownStep("database_close", 10_000, async () => mark("database_close"));
      await budget.teardownStep("embedded_postgres_stop", 45_000, async () => mark("embedded_postgres_stop"));
    })();

    await vi.advanceTimersByTimeAsync(200_000);
    await sequence;

    expect(started).toEqual({
      scheduler_idle: 0,
      run_drain: 60_000,
      // Each step runs to its own cap; the last one is cut at W = 200 s.
      finalizers: 150_000,
      mirror_flush: 180_000,
      late: 195_000,
      http_close: 200_000,
      database_close: 200_000,
      embedded_postgres_stop: 200_000,
    });
    expect(log.error.mock.calls.filter(([, msg]) => msg === "shutdown deadline reached")).toHaveLength(1);
    expect(budget.exitCode()).toBe(1);
    expect(budget.abandonedPhases()).toEqual(["scheduler_idle", "run_drain", "finalizers", "mirror_flush", "late"]);
  });

  it("skips a work step that would start after the deadline", async () => {
    const log = stubLogger();
    const budget = createShutdownBudget({ signal: "SIGTERM", workDeadlineMs: 10_000, log, now: () => Date.now() });
    const first = budget.workStep("scheduler_idle", 60_000, never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await first).outcome).toBe("deadline");
    const run = vi.fn(async () => "ran");
    const second = await budget.workStep("run_drain", 90_000, run);
    expect(second.outcome).toBe("skipped");
    expect(run).not.toHaveBeenCalled();
  });

  it("aborts a step's signal at its own cap, before the deadline", async () => {
    const log = stubLogger();
    const budget = createShutdownBudget({ signal: "SIGTERM", workDeadlineMs: 200_000, log, now: () => Date.now() });
    let stepSignal: AbortSignal | null = null;
    const step = budget.workStep("scheduler_idle", 60_000, (signal) => {
      stepSignal = signal;
      return never();
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(stepSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stepSignal!.aborted).toBe(true);
    expect((await step).outcome).toBe("timed_out");
    expect(budget.stageSignal.aborted).toBe(false);
  });

  it("caps each teardown step on its own and runs the next as soon as the cap expires", async () => {
    const log = stubLogger();
    const budget = createShutdownBudget({ signal: "SIGTERM", workDeadlineMs: 200_000, log, now: () => Date.now() });
    budget.endWorkStage();
    const t0 = Date.now();
    const started: number[] = [];
    const sequence = (async () => {
      for (const cap of [5_000, 15_000, 10_000, 10_000, 45_000, 5_000]) {
        await budget.teardownStep(`step_${cap}`, cap, async () => {
          started.push(Date.now() - t0);
          return never();
        });
      }
    })();
    await vi.advanceTimersByTimeAsync(90_000);
    await sequence;
    expect(started).toEqual([0, 5_000, 20_000, 30_000, 40_000, 85_000]);
    expect(budget.exitCode()).toBe(1);
  });

  it("runs the fast path in order and exits 0", async () => {
    const log = stubLogger();
    const budget = createShutdownBudget({ signal: "SIGTERM", workDeadlineMs: 200_000, log, now: () => Date.now() });
    const order: string[] = [];
    const drain = await budget.workStep("run_drain", 90_000, async () => {
      order.push("drain");
      return { interrupted: 2 };
    });
    budget.endWorkStage();
    await budget.teardownStep("database_close", 10_000, async () => {
      order.push("db");
    });
    expect(drain).toEqual({ outcome: "done", value: { interrupted: 2 } });
    expect(order).toEqual(["drain", "db"]);
    expect(budget.exitCode()).toBe(0);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "run_drain", outcome: "done" }),
      "shutdown phase done",
    );
  });

  it("logs a failed step, continues, and does not count it as a timeout", async () => {
    const log = stubLogger();
    const budget = createShutdownBudget({ signal: "SIGTERM", workDeadlineMs: 200_000, log, now: () => Date.now() });
    const result = await budget.workStep("run_drain", 90_000, async () => {
      throw new Error("boom");
    });
    expect(result.outcome).toBe("failed");
    expect(budget.exitCode()).toBe(0);
  });

  it("logs a result that settles after its cap once as late, never as an unhandled rejection", async () => {
    const log = stubLogger();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const budget = createShutdownBudget({ signal: "SIGTERM", workDeadlineMs: 200_000, log, now: () => Date.now() });
      let rejectLate!: (err: Error) => void;
      const step = budget.workStep("run_drain", 90_000, () => new Promise((_, reject) => {
        rejectLate = reject;
      }));
      await vi.advanceTimersByTimeAsync(90_000);
      expect((await step).outcome).toBe("timed_out");
      rejectLate(new Error("pool ended"));
      await vi.advanceTimersByTimeAsync(0);
      const late = log.warn.mock.calls.filter(([, msg]) => msg === "shutdown phase settled late");
      expect(late).toHaveLength(1);
      expect(late[0]![0]).toMatchObject({ phase: "run_drain", outcome: "rejected" });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("logs the embedded PostgreSQL stop timeout at fatal through the step's timeout hook", async () => {
    const log = stubLogger();
    const budget = createShutdownBudget({ signal: "SIGTERM", workDeadlineMs: 200_000, log, now: () => Date.now() });
    budget.endWorkStage();
    const step = budget.teardownStep("embedded_postgres_stop", 45_000, never, {
      onTimeout: () => log.fatal({}, "embedded PostgreSQL did not stop within 45000ms"),
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await step).outcome).toBe("timed_out");
    expect(log.fatal).toHaveBeenCalledWith({}, "embedded PostgreSQL did not stop within 45000ms");
  });
});

describe("armShutdownWatchdog", () => {
  it("exits with 1 at its deadline and names the current phase", async () => {
    const log = stubLogger();
    const exit = vi.fn();
    armShutdownWatchdog({ timeoutMs: 290_000, currentPhase: () => "embedded_postgres_stop", exit, log });
    await vi.advanceTimersByTimeAsync(289_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.fatal).toHaveBeenCalledWith({ phase: "embedded_postgres_stop" }, "shutdown watchdog fired");
  });

  it("does nothing once disarmed", async () => {
    const exit = vi.fn();
    const disarm = armShutdownWatchdog({ timeoutMs: 290_000, currentPhase: () => null, exit, log: stubLogger() });
    disarm();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(exit).not.toHaveBeenCalled();
  });
});
