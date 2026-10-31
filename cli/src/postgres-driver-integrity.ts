import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Registry postgres@3.4.9 with patches/postgres@3.4.9.patch applied. CI
// recomputes these from the registry tarball and the patch file.
export const PATCHED_POSTGRES_DRIVER = {
  version: "3.4.9",
  files: {
    "src/connection.js": "b57261592f135d127b8e7267c78981eb2c5f4751259641b782ba621b89d939d1",
    "src/index.js": "07dee80154d83ca9163a4a8790ef0281602ffca682e2387b3487bf20395d2adf",
    "cjs/src/connection.js": "c3e6807f967203cd35eeb7632f01b419d7ed2405f657f9f5654729c3422bd98a",
    "cjs/src/index.js": "b28d16e69f28dc5d5ba9a944329f191d896f7ab80ac49300445da7ba8c594d22",
  },
} as const;

export const POSTGRES_DRIVER_CALLERS = ["paperclipai", "@paperclipai/db"] as const;

export type PostgresDriverResolution = { caller: string; import: string; require: string; packageRoot: string };

const RESOLVE_SCRIPT = [
  "import { createRequire } from 'node:module';",
  "const require = createRequire(import.meta.url);",
  "process.stdout.write(JSON.stringify({ import: import.meta.resolve('postgres'), require: require.resolve('postgres') }));",
].join("\n");

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertPatchedDriver(packageRoot: string, label: string): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
  if (manifest.name !== "postgres" || manifest.version !== PATCHED_POSTGRES_DRIVER.version) {
    throw new Error(`${label} is ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"}; expected patched postgres@${PATCHED_POSTGRES_DRIVER.version}.`);
  }
  for (const [file, expected] of Object.entries(PATCHED_POSTGRES_DRIVER.files)) {
    const location = path.join(packageRoot, file);
    const actual = fs.existsSync(location) ? sha256(location) : "missing";
    if (actual !== expected) throw new Error(`${label} ${file} is ${actual}; expected patched ${expected}.`);
  }
}

function inventoryPostgresCopies(nodeModules: string, found: string[] = [], depth = 0): string[] {
  if (depth > 32 || !fs.existsSync(nodeModules)) return found;
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const directory = path.join(nodeModules, entry.name);
    const packages = entry.name.startsWith("@")
      ? fs.readdirSync(directory, { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => path.join(directory, child.name))
      : [directory];
    for (const packageDirectory of packages) {
      if (path.basename(packageDirectory) === "postgres" && !entry.name.startsWith("@")) found.push(packageDirectory);
      inventoryPostgresCopies(path.join(packageDirectory, "node_modules"), found, depth + 1);
    }
  }
  return found;
}

// Every caller in the payload must load the patched driver through Node's real
// ESM and CommonJS resolution; any unpatched copy in the payload fails the gate.
export async function verifyPostgresDriverPayload(payloadPath: string): Promise<PostgresDriverResolution[]> {
  const payloadRoot = fs.realpathSync(payloadPath);
  const nodeModules = path.join(payloadRoot, "node_modules");
  const copies = inventoryPostgresCopies(nodeModules);
  if (copies.length === 0) throw new Error(`Payload ${payloadPath} contains no postgres driver.`);
  for (const copy of copies) assertPatchedDriver(copy, `Payload driver ${path.relative(payloadRoot, copy)}`);
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const resolutions: PostgresDriverResolution[] = [];
  for (const caller of POSTGRES_DRIVER_CALLERS) {
    const callerDirectory = path.join(nodeModules, caller);
    if (!fs.existsSync(path.join(callerDirectory, "package.json"))) throw new Error(`Payload is missing postgres caller ${caller}.`);
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", RESOLVE_SCRIPT], { cwd: callerDirectory, env, encoding: "utf8", timeout: 30_000 });
    const resolved = JSON.parse(stdout) as { import: string; require: string };
    const importPath = fs.realpathSync(new URL(resolved.import));
    const requirePath = fs.realpathSync(resolved.require);
    const packageRoot = path.dirname(path.dirname(importPath));
    if (!inside(payloadRoot, importPath) || !inside(payloadRoot, requirePath)) {
      throw new Error(`${caller} resolves postgres outside the payload: ${importPath}, ${requirePath}.`);
    }
    if (importPath !== path.join(packageRoot, "src", "index.js") || requirePath !== path.join(packageRoot, "cjs", "src", "index.js")) {
      throw new Error(`${caller} resolves postgres ESM and CommonJS entrypoints from different copies: ${importPath}, ${requirePath}.`);
    }
    assertPatchedDriver(packageRoot, `${caller} postgres driver`);
    resolutions.push({ caller, import: importPath, require: requirePath, packageRoot });
  }
  return resolutions;
}
