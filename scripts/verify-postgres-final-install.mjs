#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PATCHED_POSTGRES_DRIVER, verifyPostgresDriverPayload } from "../cli/src/postgres-driver-integrity.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const probe = join(repoRoot, "scripts/postgres-close-probe.mjs");
const PROBE_SHA256 = "95954494ea5d673cf945fdc77e97ff1fb0ac965de7582b603ceeaf2fe91ac48c";
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");

const [packagesArg, workArg, ...extra] = process.argv.slice(2);
if (!packagesArg || !workArg || extra.length) {
  console.error("Usage: verify-postgres-final-install.mjs <packages-dir> <empty-work-dir>");
  process.exit(2);
}
const packagesDir = resolve(packagesArg), workDir = resolve(workArg);
mkdirSync(workDir, { recursive: true });
if (readdirSync(workDir).length) throw new Error(`${workDir} must be empty`);
if (sha256(probe) !== PROBE_SHA256) throw new Error("close/live probe differs from the reviewed fixture");

const manifest = JSON.parse(readFileSync(join(packagesDir, "payload-packages.json"), "utf8"));
for (const { file, sha256: expected } of manifest.files) {
  if (sha256(join(packagesDir, file)) !== expected) throw new Error(`checksum mismatch: ${file}`);
}

const env = { ...process.env, npm_config_cache: join(workDir, "npm-cache"), npm_config_userconfig: join(workDir, "npmrc") };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
writeFileSync(env.npm_config_userconfig, "");
const prefix = join(workDir, "payload");
const npmArgs = ["install", "--prefix", prefix, ...manifest.files.map(({ file }) => join(packagesDir, file)), "--no-audit", "--no-fund"];
execFileSync("npm", npmArgs, { cwd: workDir, env, stdio: "inherit", timeout: 20 * 60_000 });

function runProbe(entry, mode) {
  const result = spawnSync(process.execPath, [probe, entry, mode], { env, encoding: "utf8", timeout: 15_000 });
  const stderr = result.stderr ?? String(result.error ?? "");
  return { entry, mode, exit: result.status, signal: result.signal, timedOut: result.error?.code === "ETIMEDOUT",
    stdout: (result.stdout ?? "").trim(), stderr: stderr.slice(0, 2000), nullWrite: /Immediate\.nextWrite|reading 'write'/.test(stderr) };
}
const failures = [];
const expect = (control, ok) => { if (!ok) failures.push(control); return control; };

const resolutions = await verifyPostgresDriverPayload(prefix);
const controls = [];
const importScript = "await import('@paperclipai/db'); await import('@paperclipai/server'); process.stdout.write('IMPORTED');";
const imported = spawnSync(process.execPath, ["--input-type=module", "-e", importScript], { cwd: prefix, env, encoding: "utf8", timeout: 120_000 });
controls.push(expect({ entry: "import @paperclipai/db and @paperclipai/server", mode: "import", exit: imported.status, signal: imported.signal,
  timedOut: imported.error?.code === "ETIMEDOUT", stdout: (imported.stdout ?? "").trim(), stderr: (imported.stderr ?? String(imported.error ?? "")).slice(0, 2000) },
  imported.status === 0 && (imported.stdout ?? "").trim() === "IMPORTED"));
const cliEntry = join(prefix, "node_modules/paperclipai/dist/index.js");
const piSetup = spawnSync(process.execPath, [cliEntry, "runtime", "setup", "pi"], { cwd: prefix, env, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
let piReceipt = null;
try { piReceipt = JSON.parse((piSetup.stdout ?? "").trim()); } catch {}
controls.push(expect({ entry: "paperclipai runtime setup pi", mode: "cli", exit: piSetup.status, signal: piSetup.signal,
  timedOut: piSetup.error?.code === "ETIMEDOUT", stdout: piReceipt?.status ?? "", receipt: piReceipt,
  stderr: (piSetup.stderr ?? String(piSetup.error ?? "")).slice(-2000) },
  piSetup.status === 0 && piReceipt?.status === "installed_verified"));
for (const { import: esm, require: cjs } of resolutions) {
  for (const entry of [esm, cjs]) {
    const closed = runProbe(entry, "closed"), live = runProbe(entry, "live");
    controls.push(expect(closed, closed.exit === 0 && closed.stdout === "CONNECTION_CLOSED" && !closed.nullWrite));
    controls.push(expect(live, live.exit === 0 && live.stdout === "OK"));
  }
}

const registryDir = join(workDir, "registry");
mkdirSync(registryDir);
execFileSync("npm", ["pack", `postgres@${PATCHED_POSTGRES_DRIVER.version}`, "--pack-destination", registryDir, "--silent"],
  { cwd: registryDir, env, stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 });
execFileSync("tar", ["-xzf", join(registryDir, `postgres-${PATCHED_POSTGRES_DRIVER.version}.tgz`), "-C", registryDir]);
for (const entry of ["src/index.js", "cjs/src/index.js"].map(file => join(registryDir, "package", file))) {
  const closed = runProbe(entry, "closed"), live = runProbe(entry, "live");
  controls.push(expect(closed, closed.exit === 1 && closed.nullWrite));
  controls.push(expect(live, live.exit === 0 && live.stdout === "OK"));
}

const report = {
  node: process.version,
  npm: execFileSync("npm", ["--version"], { env, encoding: "utf8" }).trim(),
  pnpm: execFileSync("corepack", ["pnpm", "--version"], { cwd: repoRoot, env, encoding: "utf8" }).trim(),
  toolchainNote: "Final-install node/npm versions are an experimental pin, not recovered historical host versions.",
  platform: `${process.platform}-${process.arch}`,
  source: { repo: manifest.repo, sha: manifest.sha, version: manifest.version },
  packages: manifest.files,
  patchedDriverTarball: manifest.files.find(({ file }) => file === `postgres-${PATCHED_POSTGRES_DRIVER.version}.tgz`) ?? null,
  registryDriverTarballSha256: sha256(join(registryDir, `postgres-${PATCHED_POSTGRES_DRIVER.version}.tgz`)),
  lockfileSha256: sha256(join(repoRoot, "pnpm-lock.yaml")),
  patch: { file: `patches/postgres@${PATCHED_POSTGRES_DRIVER.version}.patch`,
    sha256: sha256(join(repoRoot, `patches/postgres@${PATCHED_POSTGRES_DRIVER.version}.patch`)) },
  expectedDriver: PATCHED_POSTGRES_DRIVER,
  npmArgs: npmArgs.map(arg => arg.replace(packagesDir, "<packages>").replace(workDir, "<work>")),
  resolutions: resolutions.map(entry => ({ ...entry, import: entry.import.replace(prefix, "<payload>"),
    require: entry.require.replace(prefix, "<payload>"), packageRoot: entry.packageRoot.replace(prefix, "<payload>") })),
  controls: controls.map(control => ({ ...control, entry: control.entry.replace(prefix, "<payload>").replace(registryDir, "<registry>") })),
  failures: failures.length,
};
if (!report.patchedDriverTarball) failures.push("payload lists no patched postgres tarball");
report.failures = failures.length;
writeFileSync(join(workDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
rmSync(join(workDir, "npm-cache"), { recursive: true, force: true });
if (failures.length) {
  console.error(`${failures.length} postgres final-install controls failed`);
  process.exit(1);
}
