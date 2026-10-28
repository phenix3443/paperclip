import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GitExpirationBudgetExceeded, GIT_EXPIRATION_BUDGETS } from "./services/git-expiration-budget.js";
import { gitExpirationEvidenceContract } from "./services/git-expiration-evidence.js";
import { inspectGitExpirationRound, GIT_EXPIRATION_ROUND_MODE, type GitExpirationRoundEvent, type GitExpirationRoundJournal,
  type GitExpirationRoundStatus, type GitExpirationRoundStopReason } from "./services/git-expiration-round.js";

export class GitExpirationRoundUsageError extends Error {}

export type GitExpirationRoundCliArgs = {
  roundId: string;
  evidenceDir: string;
  databaseUrl: string;
  companyId?: string;
  maxRows?: number;
  deadlineSeconds: number;
};

const FIXED_FLAGS: Record<string, string> = { "--enabled": "true", "--dry-run": "true", "--expire-base": "false" };
const FIXED_ENV: Record<string, string> = {
  PAPERCLIP_GIT_CACHE_EXPIRATION_ENABLED: "true",
  PAPERCLIP_GIT_CACHE_EXPIRATION_DRY_RUN: "true",
  PAPERCLIP_GIT_BASE_EXPIRATION_ENABLED: "false",
};
const VALUE_FLAGS = new Set(["--round-id", "--evidence-dir", "--company-id", "--max-rows", "--deadline-seconds"]);

function boundedInteger(name: string, value: string, max: number) {
  if (!/^[1-9][0-9]{0,8}$/.test(value) || Number(value) > max) throw new GitExpirationRoundUsageError(`${name} must be an integer from 1 to ${max}`);
  return Number(value);
}

export function parseGitExpirationRoundArgs(argv: string[], env: NodeJS.ProcessEnv): GitExpirationRoundCliArgs {
  for (const [name, expected] of Object.entries(FIXED_ENV)) {
    if (env[name] !== undefined && env[name] !== expected) throw new GitExpirationRoundUsageError(`${name} conflicts with the fixed mode (${expected})`);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name in FIXED_FLAGS) {
      if (eq === -1 || arg.slice(eq + 1) !== FIXED_FLAGS[name]) throw new GitExpirationRoundUsageError(`${name} only accepts ${FIXED_FLAGS[name]}`);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new GitExpirationRoundUsageError(`unknown argument ${name}`);
    if (values.has(name)) throw new GitExpirationRoundUsageError(`${name} given twice`);
    const value = eq === -1 ? argv[++index] : arg.slice(eq + 1);
    if (value === undefined || value === "") throw new GitExpirationRoundUsageError(`${name} requires a value`);
    values.set(name, value);
  }
  const roundId = values.get("--round-id");
  if (!roundId || !/^[A-Za-z0-9._-]{1,64}$/.test(roundId)) throw new GitExpirationRoundUsageError("--round-id must match [A-Za-z0-9._-]{1,64}");
  const evidenceDir = values.get("--evidence-dir");
  if (!evidenceDir || !path.isAbsolute(evidenceDir) || path.normalize(evidenceDir) !== evidenceDir) {
    throw new GitExpirationRoundUsageError("--evidence-dir must be a normalized absolute path");
  }
  const companyId = values.get("--company-id");
  if (companyId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    throw new GitExpirationRoundUsageError("--company-id must be a UUID");
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new GitExpirationRoundUsageError("DATABASE_URL is required");
  const maxRows = values.has("--max-rows") ? boundedInteger("--max-rows", values.get("--max-rows")!, GIT_EXPIRATION_BUDGETS.selectedRows) : undefined;
  const deadlineSeconds = values.has("--deadline-seconds")
    ? boundedInteger("--deadline-seconds", values.get("--deadline-seconds")!, GIT_EXPIRATION_BUDGETS.roundSeconds) : GIT_EXPIRATION_BUDGETS.roundSeconds;
  return { roundId, evidenceDir, databaseUrl, companyId, maxRows, deadlineSeconds };
}

export type GitExpirationRoundJournalFile = {
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  datasync(): Promise<void>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
};

export const GIT_EXPIRATION_JOURNAL_TERMINAL_RESERVE_BYTES = 64 * 1024;
const TERMINAL_EVENTS = new Set<GitExpirationRoundEvent["type"]>(["round_finished", "round_committed"]);

export function fileGitExpirationRoundJournal(file: GitExpirationRoundJournalFile,
  limitBytes: number = GIT_EXPIRATION_BUDGETS.evidenceBytes): GitExpirationRoundJournal & { close(): Promise<void> } {
  let size = 0;
  return {
    async append(event: GitExpirationRoundEvent) {
      const line = Buffer.from(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
      if (!TERMINAL_EVENTS.has(event.type) && size + line.length > limitBytes - GIT_EXPIRATION_JOURNAL_TERMINAL_RESERVE_BYTES) {
        throw new GitExpirationBudgetExceeded("evidence", limitBytes, size + line.length);
      }
      try {
        for (let written = 0; written < line.length;) {
          const { bytesWritten } = await file.write(line, written, line.length - written, size + written);
          if (bytesWritten <= 0) throw new Error("journal_write_stalled");
          written += bytesWritten;
        }
        await file.datasync();
      } catch (error) {
        await file.truncate(size).then(() => file.datasync()).catch(() => undefined);
        throw error;
      }
      size += line.length;
    },
    bytes: () => size,
    close: () => file.close(),
  };
}

export async function openGitExpirationRoundJournal(evidenceDir: string): Promise<GitExpirationRoundJournal & { close(): Promise<void> }> {
  await fs.mkdir(evidenceDir, { mode: 0o700 });
  return fileGitExpirationRoundJournal(await fs.open(path.join(evidenceDir, "events.jsonl"), "wx", 0o600));
}

export function readGitExpirationRoundJournal(content: string): { status: GitExpirationRoundStatus; stopReason: GitExpirationRoundStopReason } {
  const lines = content.split("\n");
  if (lines.pop() !== "") return { status: "partial", stopReason: "evidence_lost" };
  const events: GitExpirationRoundEvent[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line) as GitExpirationRoundEvent); } catch { return { status: "partial", stopReason: "evidence_lost" }; }
  }
  const [first, pending, last] = [events[0], events.at(-2), events.at(-1)];
  if (last?.type === "round_committed" && first?.type === "round_started" && first.roundId === last.roundId
    && pending?.type === "round_finished" && pending.status === "pending_commit" && pending.roundId === last.roundId) {
    return { status: "complete", stopReason: null };
  }
  if (last?.type === "round_finished" && last.status === "partial") return { status: "partial", stopReason: last.stopReason };
  return { status: "partial", stopReason: "evidence_lost" };
}

export function gitExpirationRoundExitCode(summary: { status: GitExpirationRoundStatus }) {
  return summary.status === "complete" ? 0 : 3;
}

export const PRINT_EVIDENCE_CONTRACT_FLAG = "--print-evidence-contract";

export async function runGitExpirationRoundCli(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  // Reads no environment, opens no database, spawns no child and writes no file.
  if (argv.length === 1 && argv[0] === PRINT_EVIDENCE_CONTRACT_FLAG) {
    process.stdout.write(`${JSON.stringify(gitExpirationEvidenceContract())}\n`);
    return 0;
  }
  let args: GitExpirationRoundCliArgs;
  try {
    args = parseGitExpirationRoundArgs(argv, env);
  } catch (error) {
    if (!(error instanceof GitExpirationRoundUsageError)) throw error;
    process.stderr.write(`git-expiration-round: ${error.message}\n`);
    return 2;
  }
  const journal = await openGitExpirationRoundJournal(args.evidenceDir);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  let undrained: Promise<void> | undefined;
  try {
    let summary;
    try {
      summary = await inspectGitExpirationRound({
        databaseUrl: args.databaseUrl, mode: GIT_EXPIRATION_ROUND_MODE, roundId: args.roundId, journal, companyId: args.companyId, signal: controller.signal,
        maxRows: args.maxRows, deadline: new Date(Date.now() + args.deadlineSeconds * 1000),
        onUndrainedRow: released => { undrained = released.catch(() => undefined); },
      });
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } finally {
      await journal.close();
    }
    return gitExpirationRoundExitCode(summary);
  } finally {
    await undrained;
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGitExpirationRoundCli(process.argv.slice(2), process.env).then(code => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`git-expiration-round: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
