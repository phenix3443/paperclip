import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { packGitPayload } from "../cli/src/commands/install.ts";
import { readCheckoutPostgresDriver, readPostgresDriverRecord, verifyPostgresDriverPayload } from "../cli/src/postgres-driver-integrity.ts";

const execFileAsync = promisify(execFile);
const repoRoot = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));

async function runCommand(file, args, options = {}) {
  console.log(`$ ${file} ${args.join(" ")}`);
  return execFileAsync(file, args, { ...options, encoding: "utf8" });
}

function packageCopies(payload, name) {
  const copies = [];
  const visit = (nodeModules) => {
    if (!fs.existsSync(nodeModules)) return;
    for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(nodeModules, entry.name);
      const packages = entry.name.startsWith("@")
        ? fs.readdirSync(directory, { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => path.join(directory, child.name))
        : [directory];
      for (const packageDirectory of packages) {
        const manifest = path.join(packageDirectory, "package.json");
        if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === name) copies.push(packageDirectory);
        visit(path.join(packageDirectory, "node_modules"));
      }
    }
  };
  visit(path.join(payload, "node_modules"));
  return copies;
}

function listCopies(payload) {
  for (const name of ["postgres", "drizzle-orm"]) {
    console.error(`${name} copies:`);
    for (const copy of packageCopies(payload, name)) console.error(`  ${path.relative(payload, copy)}`);
  }
}

const workRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "paperclip-git-payload-"));
const stagingRoot = path.join(workRoot, "staging");
const stagedPayload = path.join(workRoot, "payload");
fs.mkdirSync(stagingRoot);
fs.mkdirSync(stagedPayload);

try {
  await runCommand("bash", ["scripts/build-npm.sh", "--skip-checks", "--skip-typecheck"], { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
  await runCommand("corepack", ["pnpm", "-r", "--filter", "@paperclipai/server...", "--if-present", "run", "build"], { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
  await runCommand("bash", ["scripts/prepare-server-ui-dist.sh"], { cwd: repoRoot, env: { ...process.env, PAPERCLIP_RELEASE_REUSE_UI_DIST: "1" }, maxBuffer: 32 * 1024 * 1024 });
  const { version, expected } = await packGitPayload({ checkoutPath: repoRoot, stagingRoot, stagedPayload, runCommand });
  const checkoutExpected = readCheckoutPostgresDriver(repoRoot);
  if (JSON.stringify(expected) !== JSON.stringify(checkoutExpected)) throw new Error("packGitPayload expectation differs from the checkout driver.");
  if (JSON.stringify(readPostgresDriverRecord(stagedPayload)) !== JSON.stringify(checkoutExpected)) throw new Error("Payload driver record differs from the checkout driver.");
  console.log(`checkout driver postgres@${checkoutExpected.version}`);
  for (const [file, hash] of Object.entries(checkoutExpected.files)) console.log(`  ${file} ${hash}`);
  const resolutions = await verifyPostgresDriverPayload(stagedPayload, checkoutExpected);
  for (const resolution of resolutions) console.log(`resolved ${resolution.caller} -> ${path.relative(stagedPayload, resolution.import)}, ${path.relative(stagedPayload, resolution.require)}`);
  const postgresCopies = packageCopies(stagedPayload, "postgres");
  if (postgresCopies.length !== 1 || postgresCopies[0] !== path.join(stagedPayload, "node_modules", "postgres")) {
    throw new Error(`Expected exactly one postgres package at node_modules/postgres; found ${postgresCopies.length}.`);
  }
  const verifiedDrizzle = new Set(resolutions.map((resolution) => resolution.caller).filter((caller) => caller.endsWith(path.join("postgres-js", "driver.js"))));
  const drizzleCopies = packageCopies(stagedPayload, "drizzle-orm");
  if (drizzleCopies.length === 0) throw new Error("Payload contains no drizzle-orm.");
  for (const copy of drizzleCopies) {
    const driver = path.relative(stagedPayload, path.join(copy, "postgres-js", "driver.js"));
    if (!verifiedDrizzle.has(driver)) throw new Error(`drizzle-orm copy ${path.relative(stagedPayload, copy)} was not verified.`);
  }
  const cliVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "cli", "package.json"), "utf8")).version;
  const { stdout } = await runCommand(path.join(stagedPayload, "node_modules", ".bin", "paperclipai"), ["--version"], { cwd: workRoot });
  const reported = stdout.trim().split(/\s+/)[0];
  if (version !== cliVersion || reported !== cliVersion) throw new Error(`Installed CLI reported ${reported || "no version"}; expected ${cliVersion}.`);
  console.log(`paperclipai --version ${reported}; ${drizzleCopies.length} drizzle-orm copies verified; one postgres copy.`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  listCopies(stagedPayload);
  process.exitCode = 1;
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
}
