import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

const INVENTORIED_PACKAGES = ["postgres", "drizzle-orm"] as const;

type PayloadScan = { links: string[]; packages: Record<(typeof INVENTORIED_PACKAGES)[number], string[]> };

function packageNameAt(directory: string): string | null {
  const parent = path.basename(path.dirname(directory));
  if (parent === "node_modules") return path.basename(directory);
  if (parent.startsWith("@") && path.basename(path.dirname(path.dirname(directory))) === "node_modules") return `${parent}/${path.basename(directory)}`;
  return null;
}

function declaredPackageName(directory: string): string | null {
  const manifest = path.join(directory, "package.json");
  if (!fs.lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) return null;
  try {
    const name = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

const POSTGRES_SOURCE_SIGNATURE = ["connection.js", "query.js", "queue.js", "subscribe.js", "large.js"] as const;

function postgresCopyRootOf(sourceDirectory: string): string {
  const parent = path.dirname(sourceDirectory);
  if (path.basename(sourceDirectory) !== "src") return sourceDirectory;
  return ["cjs", "cf"].includes(path.basename(parent)) ? path.dirname(parent) : parent;
}

function scanPayload(payloadRoot: string): PayloadScan {
  const scan: PayloadScan = { links: [], packages: { postgres: [], "drizzle-orm": [] } };
  const pending = [payloadRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (directory !== payloadRoot) {
      const names = [packageNameAt(directory), declaredPackageName(directory)];
      for (const name of INVENTORIED_PACKAGES) {
        if (names.includes(name) && !scan.packages[name].includes(directory)) scan.packages[name].push(directory);
      }
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (POSTGRES_SOURCE_SIGNATURE.every((file) => files.has(file))) {
      const copy = postgresCopyRootOf(directory);
      if (!scan.packages.postgres.includes(copy)) scan.packages.postgres.push(copy);
    }
    for (const entry of entries) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(location);
      else if (entry.isSymbolicLink()) {
        const binLink = path.basename(directory) === ".bin" && path.basename(path.dirname(directory)) === "node_modules";
        const target = fs.existsSync(location) ? fs.realpathSync(location) : null;
        const allowed = target !== null && fs.statSync(location).isFile()
          && (path.dirname(target) === fs.realpathSync(directory) || (binLink && inside(payloadRoot, target)));
        if (!allowed) scan.links.push(location);
      }
    }
  }
  return scan;
}

export async function verifyPostgresDriverPayload(payloadPath: string): Promise<PostgresDriverResolution[]> {
  const payloadRoot = fs.realpathSync(payloadPath);
  const nodeModules = path.join(payloadRoot, "node_modules");
  const scan = scanPayload(payloadRoot);
  if (scan.links.length > 0) {
    throw new Error(`Payload must not contain linked files or packages; found ${scan.links.slice(0, 10).map((link) => path.relative(payloadRoot, link)).join(", ")}.`);
  }
  const copies = scan.packages.postgres;
  if (copies.length === 0) throw new Error(`Payload ${payloadPath} contains no postgres driver.`);
  const rootCopy = path.join(nodeModules, "postgres");
  const extra = copies.filter((copy) => copy !== rootCopy);
  if (extra.length > 0 || !copies.includes(rootCopy)) {
    throw new Error(`Payload must contain exactly one postgres driver at node_modules/postgres; found ${copies.map((copy) => path.relative(payloadRoot, copy)).join(", ")}.`);
  }
  assertPatchedDriver(rootCopy, "Payload driver node_modules/postgres");
  const callers: { caller: string; directory: string }[] = POSTGRES_DRIVER_CALLERS.map((caller) => ({ caller, directory: path.join(nodeModules, caller) }));
  for (const caller of callers) {
    if (!fs.existsSync(path.join(caller.directory, "package.json"))) throw new Error(`Payload is missing postgres caller ${caller.caller}.`);
  }
  const drizzleDrivers = scan.packages["drizzle-orm"]
    .map((copy) => path.join(copy, "postgres-js"))
    .filter((directory) => fs.existsSync(path.join(directory, "driver.js")));
  if (drizzleDrivers.length === 0) throw new Error(`Payload ${payloadPath} contains no drizzle-orm postgres-js driver.`);
  for (const directory of drizzleDrivers) callers.push({ caller: path.relative(payloadRoot, path.join(directory, "driver.js")), directory });
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const expectedRoot = fs.realpathSync(rootCopy);
  const resolutions: PostgresDriverResolution[] = [];
  for (const { caller, directory } of callers) {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", RESOLVE_SCRIPT], { cwd: directory, env, encoding: "utf8", timeout: 30_000 });
    const resolved = JSON.parse(stdout) as { import: string; require: string };
    const importPath = fs.realpathSync(new URL(resolved.import));
    const requirePath = fs.realpathSync(resolved.require);
    if (!inside(payloadRoot, importPath) || !inside(payloadRoot, requirePath)) {
      throw new Error(`${caller} resolves postgres outside the payload: ${importPath}, ${requirePath}.`);
    }
    if (importPath !== path.join(expectedRoot, "src", "index.js") || requirePath !== path.join(expectedRoot, "cjs", "src", "index.js")) {
      throw new Error(`${caller} does not resolve the payload's patched postgres driver ESM and CommonJS entrypoints: ${importPath}, ${requirePath}.`);
    }
    resolutions.push({ caller, import: importPath, require: requirePath, packageRoot: expectedRoot });
  }
  return resolutions;
}
