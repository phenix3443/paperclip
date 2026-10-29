import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readReport } from "./reporter.mjs";
import { validateSnapshot } from "./snapshot.mjs";

const control = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const target = process.argv[4];
const validateOnly = process.argv[5] === "--validate";
const manifest = JSON.parse(readFileSync(join(control, "manifest.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: source, encoding: "utf8" });
  assert.equal(result.status, 0, "Git validation failed");
  return result.stdout.trim();
};
assert.ok([manifest.base, manifest.candidate].includes(target));
assert.equal(git("rev-parse", "HEAD"), target);
assert.equal(manifest.files.length, 103);
assert.equal(new Set(manifest.files).size, 103);
for (const file of manifest.files) {
  assert.match(file, /^server\/(?:src|scripts)\/[a-zA-Z0-9_./-]+\.test\.(?:ts|mjs)$/);
  assert.ok(!file.split("/").includes(".."));
  for (const ref of [manifest.base, manifest.candidate]) git("cat-file", "-e", `${ref}:${file}`);
}
assert.ok(!manifest.files.some((file) => file.includes("issue-blocked-cancellation-persistence")));
const observationPatch = readFileSync(join(control, "observation.patch"));
const original = "server/src/__tests__/attention-service.test.ts";
assert.equal(git("rev-parse", `${manifest.base}:${original}`), git("rev-parse", `${manifest.candidate}:${original}`));
git("apply", "--unidiff-zero", "--check", join(control, "observation.patch"));
if (validateOnly) {
  console.log(JSON.stringify({ target, files: 103, manifestSha256: hash(readFileSync(join(control, "manifest.json"))), patchSha256: hash(observationPatch) }));
  process.exit(0);
}
assert.equal(process.version, "v24.22.1");
for (const key of Object.keys(process.env)) {
  assert.ok(!((key === "DATABASE_URL" || /^PAPERCLIP.*DATABASE_URL$/.test(key)) && process.env[key]), "External database configuration is not allowed");
}
mkdirSync(evidence, { recursive: true });
const metadata = { target, actualCheckout: git("rev-parse", "HEAD"), files: manifest.files,
  manifestSha256: hash(readFileSync(join(control, "manifest.json"))), patchSha256: hash(observationPatch),
  observerSha256: hash(readFileSync(join(control, "observe-cleanup.mjs"))),
  collectorSha256: Object.fromEntries(["run.mjs", "reporter.mjs", "snapshot.mjs"].map((name) => [name, hash(readFileSync(join(control, name)))])),
  workflowSha256: process.env.CONTROL_WORKFLOW_SHA256, controlRevision: process.env.CONTROL_REVISION,
  node: process.version, cache: { policy: "disabled", hit: false, fallback: false }, databaseSelection: "isolated embedded PostgreSQL",
  runner: Object.fromEntries(["ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_NAME"].map((key) => [key, process.env[key] ?? null])),
  checkedInLockSha256: hash(spawnSync("git", ["show", `${target}:pnpm-lock.yaml`], { cwd: source }).stdout),
  installedLockSha256: hash(readFileSync(join(source, "pnpm-lock.yaml"))),
};
assert.equal(metadata.checkedInLockSha256, metadata.installedLockSha256, "Installation changed the lockfile");
const versionOf = (name, anchor = source) => {
  const localRequire = createRequire(join(anchor, "package.json"));
  let dir = dirname(localRequire.resolve(name));
  for (;;) {
    try { const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); if (pkg.name === name) return pkg.version; } catch {}
    const parent = dirname(dir); assert.notEqual(parent, dir, "Package version could not be resolved"); dir = parent;
  }
};
metadata.vitest = versionOf("vitest");
metadata.embeddedPostgres = versionOf("embedded-postgres", join(source, "packages/db"));
metadata.postgresDriver = versionOf("postgres", join(source, "packages/db"));
metadata.pnpm = spawnSync("pnpm", ["--version"], { cwd: source, encoding: "utf8" }).stdout.trim();
assert.equal(metadata.pnpm, "9.15.4");
assert.equal(metadata.vitest, "5.0.3");
writeFileSync(join(evidence, "environment.json"), JSON.stringify(metadata, null, 2));
git("apply", "--unidiff-zero", join(control, "observation.patch"));
const observerPath = join(source, ".ci-diagnostics/attention-control");
mkdirSync(observerPath, { recursive: true });
for (const name of ["observe-cleanup.mjs", "snapshot.mjs", "reporter.mjs"]) writeFileSync(join(observerPath, name), readFileSync(join(control, name)));
const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP, "attention-control-")));
const env = { ...process.env, NODE_ENV: "test", PAPERCLIP_TEST_HOST_HOME: process.env.PAPERCLIP_TEST_HOST_HOME ?? join(process.env.HOME, ".paperclip"),
  PAPERCLIP_HOME: join(root, "h"), PAPERCLIP_CONFIG: join(root, "h/config.json"), PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-1`, TMPDIR: join(root, "t"), ATTENTION_REPORT_PATH: join(evidence, "typed-report.json"), ATTENTION_MANIFEST_PATH: join(control, "manifest.json") };
mkdirSync(env.PAPERCLIP_HOME, { recursive: true }); mkdirSync(env.TMPDIR, { recursive: true });
const args = ["exec", "vitest", "run", "--project", "@paperclipai/server", "--exclude", "**/dist/**", "--pool=forks", "--isolate", "--fileParallelism", "--maxWorkers=2", ...manifest.files,
  "--reporter=default", `--reporter=${join(observerPath, "reporter.mjs")}`];
writeFileSync(join(evidence, "command.json"), JSON.stringify(["pnpm", ...args], null, 2));
const result = spawnSync("timeout", ["--signal=TERM", "--kill-after=15s", "900s", "pnpm", ...args], { cwd: source, env, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
const output = (result.stdout ?? "") + (result.stderr ?? "");
const operationNames = new Set([...observationPatch.toString().matchAll(/cleanup.run\("(\w+)"/g)].map((match) => match[1]));
const events = [];
for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
  if (!line.startsWith("[attention-control] ")) continue;
  try {
    const event = JSON.parse(line.slice("[attention-control] ".length));
    assert.ok(["postgres-version", "wait-sample", "observation-error", "sampler-deadline", "delete-start", "delete-end"].includes(event.event));
    assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && Number.isInteger(event.hook) && event.hook > 0);
    if (event.durationMs != null) assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    if (event.truncated != null) assert.equal(typeof event.truncated, "boolean");
    if (event.operation != null) assert.ok(operationNames.has(event.operation));
    if (event.version != null) assert.match(event.version, /^\d+(?:\.\d+)*$/);
    const allowed = ["event", "hook", "elapsedMs", "operation", "version", "durationMs", "truncated", "snapshot"];
    assert.ok(Object.keys(event).every((key) => allowed.includes(key)));
    if (event.event === "wait-sample") {
      const { snapshot } = event;
      assert.ok(snapshot && Object.keys(snapshot).every((key) => ["total", "returned", "lockGroupTotal", "lockGroupReturned", "missingBlockers", "complete", "records"].includes(key)));
      const verified = validateSnapshot({ total: snapshot.total, records: snapshot.records });
      assert.deepEqual(snapshot, verified);
    }
    events.push(event);
  } catch { events.push({ event: "observation-error" }); }
}
writeFileSync(join(evidence, "observations.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
writeFileSync(join(evidence, "output-redaction.json"), JSON.stringify({ stdoutLines: (result.stdout ?? "").split("\n").length, stderrLines: (result.stderr ?? "").split("\n").length, policy: "Unrestricted test console output and failure messages are omitted; only typed result metadata and allowlisted observation events are retained." }));
writeFileSync(join(evidence, "exit.json"), JSON.stringify({ status: result.status, signal: result.signal, timedOut: result.status === 124, spawnError: Boolean(result.error) }));
const collected = readReport(env.ATTENTION_REPORT_PATH, manifest.files);
writeFileSync(join(evidence, "collection.json"), JSON.stringify({ code: collected.code, moduleCount: collected.report?.modules.length ?? collected.moduleCount ?? null, expectedModuleCount: manifest.files.length }));
if (collected.report) writeFileSync(join(evidence, "results.json"), JSON.stringify(collected.report, null, 2));
const valid = collected.code === "complete" && events.some((event) => event.event === "postgres-version")
  && !events.some((event) => event.event === "observation-error" || event.event === "sampler-deadline" || (event.event === "wait-sample" && !event.snapshot.complete));
if (!valid) writeFileSync(join(evidence, "incomplete-evidence.txt"), "Typed inventory or complete PostgreSQL observation evidence could not be verified. Do not treat as a controlled sample.\n");
writeFileSync(join(evidence, "test-root-retention.json"), JSON.stringify({ root, policy: "Retain until GitHub-hosted runner disposal; child termination is not inferred from the top-level exit." }));
process.exit(valid && collected.report.reason === "passed" && collected.report.unhandledErrors === 0 ? result.status ?? 1 : 1);
