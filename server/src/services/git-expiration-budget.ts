import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";

export const GIT_EXPIRATION_BUDGETS = Object.freeze({
  roundSeconds: 600,
  stopDrainSeconds: 15,
  rowMs: 60_000,
  walkerEntries: 100_000,
  statementMs: 10_000,
  selectedRows: 10_000,
  fullPages: 200,
  dbConnections: 4,
  gitChildren: 1,
  childOutputBytes: 16 * 1024 * 1024,
  evidenceBytes: 64 * 1024 * 1024,
  scratchBytes: 256 * 1024 * 1024,
});

export const GIT_CHILD_KILL_GRACE_MS = 2_000;
export const GIT_GROUP_PROBE_INTERVAL_MS = 50;
export const ROW_DRAIN_BOUND_MS = 5_000;

const BOUNDED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["gc.auto", "0"], ["maintenance.auto", "false"], ["core.fsmonitor", "false"],
];

export class GitExpirationBudgetExceeded extends Error {
  constructor(readonly budget: string, readonly limit: number | null = null, readonly observed: number | null = null,
    options?: ErrorOptions) {
    super(budget, options);
    this.name = "GitExpirationBudgetExceeded";
  }
}

export type GitGroupProbe = (pgid: number) => boolean;

export const probeGitProcessGroup: GitGroupProbe = pgid => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export type InspectionBudgetHooks = {
  probeGroup?: GitGroupProbe;
  gitTimeoutMs?: number;
};

export class InspectionBudget {
  readonly signal: AbortSignal;
  readonly peaks = { childOutputBytes: 0, gitChildren: 0 };
  readonly probeGroup: GitGroupProbe;
  readonly gitTimeoutCapMs: number;
  private readonly controller = new AbortController();
  private readonly running = new Set<Promise<unknown>>();
  private gitChildren = 0;

  constructor(roundSignal: AbortSignal, hooks: InspectionBudgetHooks = {}) {
    this.signal = AbortSignal.any([roundSignal, this.controller.signal]);
    this.probeGroup = hooks.probeGroup ?? probeGitProcessGroup;
    this.gitTimeoutCapMs = hooks.gitTimeoutMs ?? Number.POSITIVE_INFINITY;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return budgetStore.run(this, work);
  }

  exceeded(error: GitExpirationBudgetExceeded): GitExpirationBudgetExceeded {
    if (!this.controller.signal.aborted) this.controller.abort(error);
    return error;
  }

  takeGitSlot() {
    if (this.gitChildren >= GIT_EXPIRATION_BUDGETS.gitChildren) {
      throw this.exceeded(new GitExpirationBudgetExceeded("git_children", GIT_EXPIRATION_BUDGETS.gitChildren, this.gitChildren + 1));
    }
    this.gitChildren += 1;
    this.peaks.gitChildren = Math.max(this.peaks.gitChildren, this.gitChildren);
  }

  releaseGitSlot() {
    this.gitChildren -= 1;
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    const forget = () => { this.running.delete(work); };
    work.then(forget, forget);
    return work;
  }

  get runningCount() {
    return this.running.size;
  }

  async drain() {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }
}

const budgetStore = new AsyncLocalStorage<InspectionBudget>();

export function currentInspectionBudget(): InspectionBudget | undefined {
  return budgetStore.getStore();
}

export type BoundedGitOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout: number;
  signal?: AbortSignal;
  maxBuffer: number;
  input?: string;
  okExitCodes?: number[];
};

export type BoundedGitResult = { stdout: string; stderr: string };

function execGit(args: string[], options: BoundedGitOptions) {
  return new Promise<BoundedGitResult>((resolve, reject) => {
    const child = execFile("git", args, { cwd: options.cwd, env: options.env, timeout: options.timeout,
      signal: options.signal, maxBuffer: options.maxBuffer }, (error, stdout, stderr) => {
      const exitCode = (error as { code?: unknown } | null)?.code;
      if (!error || (typeof exitCode === "number" && options.okExitCodes?.includes(exitCode))) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.stdin?.on("error", () => {});
    if (options.input === undefined) child.stdin?.end();
    else child.stdin?.end(options.input);
  });
}

const SCRATCH_ERROR_CODES = new Set(["ENOSPC", "EDQUOT"]);
const SCRATCH_STDERR = /No space left on device|Disk quota exceeded/;

export function isScratchQuotaError(error: unknown) {
  return SCRATCH_ERROR_CODES.has((error as NodeJS.ErrnoException | null)?.code ?? "");
}

function boundedGitEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...(env ?? process.env), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  const count = Number(base.GIT_CONFIG_COUNT ?? 0);
  const start = Number.isSafeInteger(count) && count > 0 ? count : 0;
  BOUNDED_GIT_CONFIG.forEach(([key, value], index) => {
    base[`GIT_CONFIG_KEY_${start + index}`] = key;
    base[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  base.GIT_CONFIG_COUNT = String(start + BOUNDED_GIT_CONFIG.length);
  return base;
}

type StopCause = "timeout" | "abort" | "output" | "max_buffer" | "survivor";

export function runBoundedGit(args: string[], options: BoundedGitOptions): Promise<BoundedGitResult> {
  const budget = currentInspectionBudget();
  if (!budget) return execGit(args, options);
  try {
    budget.takeGitSlot();
  } catch (error) {
    return Promise.reject(error);
  }
  return budget.track(runInGroup(budget, args, options).finally(() => budget.releaseGitSlot()));
}

function runInGroup(budget: InspectionBudget, args: string[], options: BoundedGitOptions) {
  return new Promise<BoundedGitResult>((resolve, reject) => {
    const signal = options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stopCause: StopCause | null = null;
    let maxBufferStream: "stdout" | "stderr" | null = null;
    let budgetError: GitExpirationBudgetExceeded | null = null;
    let leaderExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let spawnError: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let probeTimer: NodeJS.Timeout | undefined;

    const child = spawn("git", args, { cwd: options.cwd, env: boundedGitEnv(options.env), detached: true,
      stdio: ["pipe", "pipe", "pipe"] });
    const pgid = child.pid;
    const timeoutMs = Math.min(options.timeout, budget.gitTimeoutCapMs);
    const timeout = setTimeout(() => {
      if (stopCause) return;
      budgetError = budget.exceeded(new GitExpirationBudgetExceeded("git_timeout", timeoutMs));
      stop("timeout");
    }, timeoutMs);
    const onAbort = () => stop("abort");
    signal.addEventListener("abort", onAbort, { once: true });

    function signalGroup(name: NodeJS.Signals) {
      if (pgid === undefined) return;
      try { process.kill(-pgid, name); } catch {}
    }

    function stop(cause: StopCause) {
      if (stopCause) return;
      stopCause = cause;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), GIT_CHILD_KILL_GRACE_MS);
    }

    function collect(target: Buffer[], name: "stdout" | "stderr") {
      let streamBytes = 0;
      return (chunk: Buffer) => {
        outputBytes += chunk.length;
        streamBytes += chunk.length;
        budget.peaks.childOutputBytes = Math.max(budget.peaks.childOutputBytes, outputBytes);
        if (outputBytes > GIT_EXPIRATION_BUDGETS.childOutputBytes) {
          if (!stopCause) {
            budgetError = budget.exceeded(new GitExpirationBudgetExceeded("git_output", GIT_EXPIRATION_BUDGETS.childOutputBytes, outputBytes));
            stop("output");
          }
          return;
        }
        if (streamBytes > options.maxBuffer) {
          maxBufferStream ??= name;
          stop("max_buffer");
          return;
        }
        if (!stopCause) target.push(chunk);
      };
    }

    child.stdout!.on("data", collect(stdout, "stdout"));
    child.stderr!.on("data", collect(stderr, "stderr"));
    child.stdin!.on("error", () => {});
    if (options.input === undefined) child.stdin!.end();
    else child.stdin!.end(options.input);

    child.once("error", error => {
      spawnError ??= error;
      if (pgid === undefined) finish();
    });
    child.once("close", (code, closeSignal) => {
      leaderExit = { code, signal: closeSignal };
      if (pgid === undefined) {
        finish();
        return;
      }
      if (!stopCause && budget.probeGroup(pgid)) {
        budgetError = budget.exceeded(new GitExpirationBudgetExceeded("git_group_survivor"));
        stop("survivor");
      }
      waitForEmptyGroup();
    });

    function waitForEmptyGroup() {
      if (!budget.probeGroup(pgid!)) {
        finish();
        return;
      }
      probeTimer = setTimeout(waitForEmptyGroup, GIT_GROUP_PROBE_INTERVAL_MS);
      probeTimer.unref();
    }

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(probeTimer);
      signal.removeEventListener("abort", onAbort);
      settle();
    }

    function settle() {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (budgetError) return reject(budgetError);
      if (stopCause === "abort") return reject(abortError(signal));
      if (stopCause === "max_buffer") {
        return reject(Object.assign(new RangeError(`${maxBufferStream ?? "stdout"} maxBuffer length exceeded`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          stdout: out, stderr: err }));
      }
      if (spawnError) {
        if (isScratchQuotaError(spawnError)) {
          return reject(budget.exceeded(new GitExpirationBudgetExceeded("scratch", GIT_EXPIRATION_BUDGETS.scratchBytes, null, { cause: spawnError })));
        }
        return reject(spawnError);
      }
      const code = leaderExit?.code ?? null;
      if (code === 0 || (code !== null && options.okExitCodes?.includes(code))) return resolve({ stdout: out, stderr: err });
      if (SCRATCH_STDERR.test(err)) {
        return reject(budget.exceeded(new GitExpirationBudgetExceeded("scratch", GIT_EXPIRATION_BUDGETS.scratchBytes)));
      }
      reject(Object.assign(new Error(`git ${args[0] ?? ""} exited ${code ?? leaderExit?.signal}`), {
        code, killed: false, signal: leaderExit?.signal ?? null, stdout: out, stderr: err }));
    }
  });
}

function abortError(signal: AbortSignal) {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason });
}
