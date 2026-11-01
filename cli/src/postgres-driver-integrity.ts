import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PostgresDriverExpectation = { version: string; files: Record<string, string> };

export const POSTGRES_DRIVER_RECORD = ".paperclip-postgres-driver.json";

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

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isPackageRelativePath(file: string): boolean {
  return file !== "" && !file.includes("\\") && !path.posix.isAbsolute(file) && path.posix.normalize(file) === file && !file.split("/").includes("..");
}

const PLAIN_START = String.raw`[^\s"'#{}\[\],&*!|>%@\x60]`;
const YAML_KEY = String.raw`(?:"([^"]*)"|'([^']*)'|(${PLAIN_START}(?:[^:]*?[^\s:])?))`;
const YAML_VALUE = String.raw`(?:"([^"]*)"|'([^']*)'|(${PLAIN_START}(?:.*?\S)?))`;
const YAML_COMMENT = String.raw`(?:\s+#.*)?\s*$`;
const YAML_HEADER = new RegExp(String.raw`^${YAML_KEY}\s*:(?:\s+([^\s#].*?))?${YAML_COMMENT}`);
const YAML_ENTRY = new RegExp(String.raw`^\s+${YAML_KEY}\s*:(?:\s+${YAML_VALUE})?${YAML_COMMENT}`);

function yamlScalar(match: RegExpExecArray, first: number): string {
  return match[first] ?? match[first + 1] ?? match[first + 2] ?? "";
}

function isPostgresPatchKey(key: string): boolean {
  return key === "postgres" || key.startsWith("postgres@");
}

function unparsedPatch(workspaceFile: string, line: string): Error {
  return new Error(`Cannot parse the patchedDependencies configuration in ${workspaceFile}: ${line.trim()}`);
}

function workspacePatchEntries(workspaceFile: string): [string, string][] {
  const entries: [string, string][] = [];
  let inPatches = false;
  for (const line of fs.readFileSync(workspaceFile, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (/^\S/.test(line)) {
      const header = YAML_HEADER.exec(line);
      inPatches = header !== null && yamlScalar(header, 1) === "patchedDependencies";
      if (inPatches && header?.[4] !== undefined && header?.[4] !== "{}") throw unparsedPatch(workspaceFile, line);
      continue;
    }
    if (!inPatches) continue;
    const entry = YAML_ENTRY.exec(line);
    if (!entry) throw unparsedPatch(workspaceFile, line);
    const key = yamlScalar(entry, 1);
    if (key === "<<") throw unparsedPatch(workspaceFile, line);
    if (isPostgresPatchKey(key)) entries.push([key, yamlScalar(entry, 4)]);
  }
  return entries;
}

function postgresPatchEntries(checkoutPath: string): [string, string][] {
  const manifest = readJson(path.join(checkoutPath, "package.json"), "checkout package.json");
  if (!isRecord(manifest)) throw new Error(`Checkout package.json in ${checkoutPath} is not an object.`);
  const patched = isRecord(manifest.pnpm) && isRecord(manifest.pnpm.patchedDependencies) ? manifest.pnpm.patchedDependencies : {};
  const entries = Object.entries(patched)
    .filter(([key]) => isPostgresPatchKey(key))
    .map(([key, value]): [string, string] => [key, typeof value === "string" ? value : ""]);
  const workspaceFile = path.join(checkoutPath, "pnpm-workspace.yaml");
  if (fs.existsSync(workspaceFile)) entries.push(...workspacePatchEntries(workspaceFile));
  return entries;
}

export function readCheckoutPostgresDriver(checkoutPath: string): PostgresDriverExpectation {
  const linkedDriver = path.join(checkoutPath, "packages", "db", "node_modules", "postgres");
  if (!fs.existsSync(linkedDriver)) throw new Error(`Checkout ${checkoutPath} has no installed postgres driver at packages/db/node_modules/postgres.`);
  const driverRoot = fs.realpathSync(linkedDriver);
  const driverManifest = readJson(path.join(driverRoot, "package.json"), "checkout postgres driver package.json");
  const version = isRecord(driverManifest) ? driverManifest.version : undefined;
  if (typeof version !== "string" || version === "") throw new Error(`Checkout postgres driver ${driverRoot} has no version.`);
  const entries = postgresPatchEntries(checkoutPath);
  if (entries.length === 0) return { version, files: {} };
  const entry = entries.find(([key]) => key === `postgres@${version}`) ?? entries.find(([key]) => key === "postgres");
  if (!entry) {
    throw new Error(`Checkout patches ${entries.map(([key]) => key).join(", ")} do not match the installed postgres@${version}.`);
  }
  const patchFile = path.resolve(checkoutPath, entry[1]);
  if (entry[1] === "" || !fs.existsSync(patchFile)) throw new Error(`Checkout patch for ${entry[0]} is missing: ${entry[1] || "no path"}.`);
  const patchedFiles = [...fs.readFileSync(patchFile, "utf8").matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((match) => match[2]);
  if (patchedFiles.length === 0) throw new Error(`Checkout patch ${entry[1]} lists no patched files.`);
  const files: Record<string, string> = {};
  for (const file of patchedFiles) {
    const location = path.join(driverRoot, file);
    if (!isPackageRelativePath(file) || !fs.existsSync(location)) throw new Error(`Checkout postgres driver is missing patched file ${file}.`);
    files[file] = sha256(location);
  }
  return { version, files };
}

export function writePostgresDriverRecord(payloadPath: string, expected: PostgresDriverExpectation): void {
  fs.writeFileSync(path.join(payloadPath, POSTGRES_DRIVER_RECORD), `${JSON.stringify({ version: expected.version, files: expected.files }, null, 2)}\n`);
}

export function readPostgresDriverRecord(payloadPath: string): PostgresDriverExpectation {
  const recordPath = path.join(payloadPath, POSTGRES_DRIVER_RECORD);
  if (!fs.existsSync(recordPath)) throw new Error(`Payload ${payloadPath} has no ${POSTGRES_DRIVER_RECORD}; it predates patched driver packaging and must be rebuilt.`);
  const record = readJson(recordPath, "postgres driver record");
  if (!isRecord(record) || Object.keys(record).sort().join(",") !== "files,version") {
    throw new Error(`Postgres driver record ${recordPath} must contain exactly version and files.`);
  }
  const { version, files } = record;
  if (typeof version !== "string" || version === "") throw new Error(`Postgres driver record ${recordPath} has no version.`);
  const installed = readJson(path.join(payloadPath, "node_modules", "postgres", "package.json"), "payload postgres driver package.json");
  if (!isRecord(installed) || installed.version !== version) {
    throw new Error(`Postgres driver record ${recordPath} names postgres@${version}, but the payload root driver differs.`);
  }
  if (!isRecord(files)) throw new Error(`Postgres driver record ${recordPath} files must be an object.`);
  for (const [file, hash] of Object.entries(files)) {
    if (!isPackageRelativePath(file)) throw new Error(`Postgres driver record ${recordPath} has unsafe file path ${file}.`);
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Postgres driver record ${recordPath} has an invalid hash for ${file}.`);
  }
  return { version, files: files as Record<string, string> };
}

function assertPatchedDriver(packageRoot: string, label: string, expected: PostgresDriverExpectation): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
  if (manifest.name !== "postgres" || manifest.version !== expected.version) {
    throw new Error(`${label} is ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"}; expected patched postgres@${expected.version}.`);
  }
  for (const [file, hash] of Object.entries(expected.files)) {
    const location = path.join(packageRoot, file);
    const actual = fs.existsSync(location) ? sha256(location) : "missing";
    if (actual !== hash) throw new Error(`${label} ${file} is ${actual}; expected patched ${hash}.`);
  }
}

type PackageInventory = { name: string; directory: string }[];

function inventoryPackages(nodeModules: string, inventory: PackageInventory = [], depth = 0): PackageInventory {
  if (depth > 32 || !fs.existsSync(nodeModules)) return inventory;
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const directory = path.join(nodeModules, entry.name);
    const packages = entry.name.startsWith("@")
      ? fs.readdirSync(directory, { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => path.join(directory, child.name))
      : [directory];
    for (const packageDirectory of packages) {
      inventory.push({ name: path.relative(nodeModules, packageDirectory), directory: packageDirectory });
      inventoryPackages(path.join(packageDirectory, "node_modules"), inventory, depth + 1);
    }
  }
  return inventory;
}

function packageRootOf(location: string): string | null {
  let directory = path.dirname(location);
  for (let parent = path.dirname(directory); parent !== directory; directory = parent, parent = path.dirname(directory)) {
    const name = path.basename(directory);
    if (name.startsWith(".") || name === "node_modules") continue;
    if (path.basename(parent) === "node_modules" && !name.startsWith("@")) return directory;
    if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") return directory;
  }
  return null;
}

function isSamePackageFileLink(payloadRoot: string, location: string, target: string): boolean {
  const owner = packageRootOf(location);
  if (!owner || !inside(payloadRoot, owner) || !inside(owner, target) || !fs.statSync(target).isFile()) return false;
  const nested = (candidate: string) => path.relative(owner, candidate).split(path.sep).includes("node_modules");
  return !nested(location) && !nested(target);
}

function findForbiddenLinks(payloadRoot: string): string[] {
  const forbidden: string[] = [];
  const pending = [payloadRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(location);
      else if (entry.isSymbolicLink()) {
        const binLink = path.basename(directory) === ".bin" && path.basename(path.dirname(directory)) === "node_modules";
        const target = fs.existsSync(location) ? fs.realpathSync(location) : null;
        const allowedBinLink = binLink && target !== null && inside(payloadRoot, target) && !fs.statSync(location).isDirectory();
        if (!allowedBinLink && !(target !== null && isSamePackageFileLink(payloadRoot, location, target))) forbidden.push(location);
      }
    }
  }
  return forbidden;
}

const copiesOf = (inventory: PackageInventory, name: string) =>
  inventory.filter((entry) => entry.name === name).map((entry) => entry.directory);

export async function verifyPostgresDriverPayload(payloadPath: string, expected: PostgresDriverExpectation): Promise<PostgresDriverResolution[]> {
  const payloadRoot = fs.realpathSync(payloadPath);
  const nodeModules = path.join(payloadRoot, "node_modules");
  const links = findForbiddenLinks(payloadRoot);
  if (links.length > 0) {
    throw new Error(`Payload must not contain linked files or packages; found ${links.slice(0, 10).map((link) => path.relative(payloadRoot, link)).join(", ")}.`);
  }
  const inventory = inventoryPackages(nodeModules);
  const copies = copiesOf(inventory, "postgres");
  if (copies.length === 0) throw new Error(`Payload ${payloadPath} contains no postgres driver.`);
  const rootCopy = path.join(nodeModules, "postgres");
  const extra = copies.filter((copy) => copy !== rootCopy);
  if (extra.length > 0 || !copies.includes(rootCopy)) {
    throw new Error(`Payload must contain exactly one postgres driver at node_modules/postgres; found ${copies.map((copy) => path.relative(payloadRoot, copy)).join(", ")}.`);
  }
  assertPatchedDriver(rootCopy, "Payload driver node_modules/postgres", expected);
  const callers: { caller: string; directory: string }[] = POSTGRES_DRIVER_CALLERS.map((caller) => ({ caller, directory: path.join(nodeModules, caller) }));
  for (const caller of callers) {
    if (!fs.existsSync(path.join(caller.directory, "package.json"))) throw new Error(`Payload is missing postgres caller ${caller.caller}.`);
  }
  const drizzleDrivers = copiesOf(inventory, "drizzle-orm")
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
