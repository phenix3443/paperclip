import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert(process.env.TMPDIR, "Set TMPDIR to a disk-backed run directory");
const root = mkdtempSync(join(process.env.TMPDIR, "project-tool-zod-"));
const shared = join(root, "node_modules/@paperclipai/shared");
const server = join(root, "server");
const copied = new Set();

async function installZod(version, directory) {
  const metadata = await fetch(`https://registry.npmjs.org/zod/${version}`, { signal: AbortSignal.timeout(90000) });
  assert.equal(metadata.status, 200);
  const { dist } = await metadata.json();
  const response = await fetch(dist.tarball, { signal: AbortSignal.timeout(90000) });
  assert.equal(response.status, 200);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, dist.integrity);
  const archivePath = join(root, `zod-${version}.tgz`);
  writeFileSync(archivePath, archive);
  mkdirSync(directory, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", directory], { timeout: 10000 });
}

function copyModule(relative) {
  if (copied.has(relative)) return;
  copied.add(relative);
  const source = readFileSync(join(repository, "packages/shared/src", relative.replace(/\.js$/, ".ts")), "utf8");
  const javascript = stripTypeScriptTypes(source);
  const target = join(shared, "dist", relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, javascript);
  for (const match of javascript.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
    copyModule(join(dirname(relative), match[1]));
  }
}

try {
  mkdirSync(server, { recursive: true });
  mkdirSync(shared, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(repository, "packages/shared/package.json"), "utf8"));
  writeFileSync(join(shared, "package.json"), JSON.stringify({ name: manifest.name, type: "module", exports: manifest.publishConfig.exports }));
  writeFileSync(join(server, "package.json"), '{"type":"module"}');
  writeFileSync(join(server, "resolve.mjs"), "export const resolveImport = name => import.meta.resolve(name);");
  await installZod("4.6.7", join(root, "node_modules/zod"));
  await installZod("4.4.3", join(server, "node_modules/zod"));
  for (const name of ["validators/project.js", "validators/chat-github.js", "agent-avatar-upload.js"]) copyModule(name);
  const sourceIndex = readFileSync(join(repository, "packages/shared/src/index.ts"), "utf8");
  const validatorsIndex = readFileSync(join(repository, "packages/shared/src/validators/index.ts"), "utf8");
  for (const name of ["createProjectToolSchema", "createProjectToolJsonSchema"]) {
    assert.match(sourceIndex, new RegExp(`\\b${name}\\b`));
    assert.match(validatorsIndex, new RegExp(`\\b${name}\\b`));
  }
  assert.match(sourceIndex, /export \* from "\.\/validators\/chat-github\.js"/);
  assert.match(sourceIndex, /export \* from "\.\/agent-avatar-upload\.js"/);
  const serverRequire = createRequire(join(server, "package.json"));
  const sharedRequire = createRequire(join(shared, "package.json"));
  assert.equal(serverRequire("zod/package.json").version, "4.4.3");
  assert.equal(sharedRequire("zod/package.json").version, "4.6.7");
  assert.notEqual(serverRequire.resolve("zod"), sharedRequire.resolve("zod"));
  const { resolveImport } = await import(pathToFileURL(join(server, "resolve.mjs")));
  const project = await import(resolveImport("@paperclipai/shared/validators/project"));
  const github = await import(resolveImport("@paperclipai/shared/validators/chat-github"));
  const avatar = await import(resolveImport("@paperclipai/shared/agent-avatar-upload"));
  const old = serverRequire("zod");
  const controlPath = join(server, "node_modules/@paperclipai/shared");
  cpSync(shared, controlPath, { recursive: true });
  const control = await import(pathToFileURL(join(controlPath, "dist/validators/project.js")));
  assert.equal(createRequire(join(controlPath, "package.json"))("zod/package.json").version, "4.4.3");
  assert(old.z.toJSONSchema(control.createProjectSchema).properties.name);
  assert.throws(() => old.z.toJSONSchema(project.createProjectSchema.extend({ idempotencyKey: old.z.string().min(1).max(255) })), /push|deferred/);
  const schema = project.createProjectToolJsonSchema();
  assert(schema.required.includes("idempotencyKey"));
  assert.equal(schema.properties.idempotencyKey.minLength, 1);
  assert.equal(schema.properties.idempotencyKey.maxLength, 255);
  assert(schema.properties.executionWorkspacePolicy);
  assert(project.createProjectToolSchema.safeParse({ name: "Project", idempotencyKey: "key", executionWorkspacePolicy: { enabled: true, branchPolicy: { nested: { enabled: true } } } }).success);
  for (const idempotencyKey of [undefined, "", "x".repeat(256)]) {
    assert.equal(project.createProjectToolSchema.safeParse({ name: "Project", idempotencyKey }).success, false);
  }
  assert.equal(project.createProjectToolSchema.safeParse({ name: "", idempotencyKey: "key" }).success, false);
  schema.required.length = 0;
  assert(project.createProjectToolJsonSchema().required.includes("idempotencyKey"));
  assert.equal(github.githubReviewAssessmentJsonSchema().properties.findings.maxItems, 300);
  assert.equal(github.githubReviewAssessmentJsonSchema().$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(github.githubReviewAssessmentSchema.safeParse({ reviewedCommit: "invalid" }).success, false);
  assert.equal(avatar.setAgentAvatarJsonSchema().additionalProperties, false);
  assert(avatar.setAgentAvatarSchema.safeParse({ imageBase64: null }).success);
  assert.equal(avatar.setAgentAvatarSchema.safeParse({ imageBase64: "invalid" }).success, false);
  console.log(JSON.stringify({ status: "PASS", serverZod: "4.4.3", sharedZod: "4.6.7", copiedModules: [...copied],
    sameVersionControl: "4.4.3 passes", foreignConverter: "throws", definingConverters: "pass", invalidInputs: "rejected", cacheMutation: "isolated",
    scope: "isolated source module-resolution fixture; full package build is a separate CI gate" }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
