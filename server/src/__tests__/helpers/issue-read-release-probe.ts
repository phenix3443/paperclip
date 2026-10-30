import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import {
  agents, companies, companySkills, createDb, executionWorkspaces, issues,
  startEmbeddedPostgresTestDatabase, workspaceRuntimeServices,
} from "../../../../packages/db/src/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { agentRoutes } from "../../routes/agents.js";
import { executionWorkspaceRoutes } from "../../routes/execution-workspaces.js";
import { executionWorkspaceService } from "../../services/execution-workspaces.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { createStorageService } from "../../storage/service.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";

const run = promisify(execFile);
const manifest = JSON.parse(await fs.readFile(new URL("../../../../scripts/issue-read-release-gate/manifest.json", import.meta.url), "utf8"));
const arm = process.env.RELEASE_EVIDENCE_ARM;
assert.ok(arm === "baseline" || arm === "candidate");
const sha = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
assert.equal(sha, manifest[arm], "probe must run in the pinned runtime checkout");
const output = path.resolve(process.env.RELEASE_EVIDENCE_OUTPUT!);
await fs.mkdir(output, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-read-gate-"));
const originalPath = process.env.PATH;
const originalTrace = process.env.GIT_TRACE;
const trace = path.join(root, "git.trace");
const report: Record<string, unknown> = {
  arm, sha, node: process.version, platform: process.platform, arch: process.arch,
  cpus: os.availableParallelism(), totalMemoryBytes: os.totalmem(), manifest,
  batches: [], coverage: [], close: [], passed: false,
};
const batches = report.batches as Record<string, unknown>[];
const coverage = report.coverage as Record<string, unknown>[];
const close = report.close as Record<string, unknown>[];
const database = await startEmbeddedPostgresTestDatabase("issue-read-gate-");
const db = createDb(database.connectionString);
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args], { timeout: 20000 });
const traceCounts = async () => {
  const text = await fs.readFile(trace, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return {
    commands: text.split("\n").filter(line => line.includes("built-in: git ")).length,
    scans: text.split("\n").filter(line => /built-in: git status /.test(line)).length,
  };
};
const cpu = async () => {
  const fields = (await fs.readFile("/proc/self/stat", "utf8")).split(") ").at(-1)!.split(" ");
  return { selfMicros: process.cpuUsage(), childTicks: Number(fields[13]) + Number(fields[14]) };
};
const ticks = Number((await run("getconf", ["CLK_TCK"])).stdout.trim());
try {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Release fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await fs.mkdir(path.join(repo, "files"));
  for (let index = 0; index < manifest.trackedFiles - 1; index++) {
    await fs.writeFile(path.join(repo, "files", String(index)), "");
  }
  await fs.writeFile(path.join(repo, "README"), "fixture\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "Fixture");
  assert.equal((await git(repo, "ls-files")).stdout.trim().split("\n").length, manifest.trackedFiles);
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values([
    { id: companyId, name: "Release fixture", issuePrefix: "GATE" },
    { id: otherCompanyId, name: "Foreign fixture", issuePrefix: "OTHER" },
  ]);
  const desiredSkills: string[] = [];
  for (let index = 0; index < manifest.skills; index++) {
    const slug = `fixture-${index}`;
    const source = path.join(root, "skills", slug);
    const markdown = `---\nname: ${slug}\ndescription: Synthetic release fixture\n---\n\nFixture instructions.\n`;
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), markdown);
    const key = `release-fixture/${slug}`;
    desiredSkills.push(key);
    await db.insert(companySkills).values({ companyId, key, slug, name: slug, markdown, sourceLocator: source });
  }
  await db.insert(agents).values({
    id: agentId, companyId, name: "Fixture reader", adapterType: "codex_local", status: "paused",
    adapterConfig: { cwd: repo, paperclipSkillSync: { desiredSkills } },
  });
  const records: { issueId: string; workspaceId: string; cwd: string; serviceId: string }[] = [];
  for (let index = 0; index < manifest.workspaces; index++) {
    const cwd = path.join(root, `workspace-${index}`);
    const branch = `fixture-${index}`;
    await git(repo, "worktree", "add", "-b", branch, cwd);
    const workspaceId = randomUUID();
    const issueId = randomUUID();
    const serviceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId, companyId, name: branch, mode: "isolated_workspace", strategyType: "git_worktree",
      providerType: "git_worktree", providerRef: cwd, cwd, branchName: branch, baseRef: "main",
      metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: branch, identifier: `GATE-${index + 1}`, issueNumber: index + 1,
      status: "in_progress", assigneeAgentId: agentId, executionWorkspaceId: workspaceId,
    });
    await db.insert(workspaceRuntimeServices).values({
      id: serviceId, companyId, executionWorkspaceId: workspaceId, issueId,
      serviceName: "fixture-web", scopeType: "execution_workspace", scopeId: workspaceId,
      status: "running", lifecycle: "persistent", provider: "local_process", healthStatus: "healthy",
      url: "http://127.0.0.1:1",
    });
    records.push({ issueId, workspaceId, cwd, serviceId });
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = req.headers["x-foreign-company"]
      ? { type: "agent", agentId, companyId: otherCompanyId, source: "agent_key" }
      : { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };
    next();
  });
  app.use("/api", issueRoutes(db, createStorageService(createLocalDiskStorageProvider(path.join(root, "storage")))));
  app.use("/api", agentRoutes(db));
  app.use("/api", executionWorkspaceRoutes(db));
  app.use(errorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const urls = {
    detail: (index: number) => `/api/issues/${records[index % records.length].issueId}`,
    context: (index: number) => `/api/issues/${records[index % records.length].issueId}/heartbeat-context`,
    list: () => `/api/companies/${companyId}/issues?assigneeAgentId=${agentId}&status=in_progress&limit=75`,
    skills: () => `/api/agents/${agentId}/skills`,
  };
  const request = async (url: string, signal = AbortSignal.timeout(12000)) => {
    const response = await fetch(origin + url, { signal });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ url, status: response.status, body }));
    return body;
  };
  process.env.GIT_TRACE = trace;
  const checkWorkspace = (body: Record<string, any>, index: number) => {
    assert.equal(body.currentExecutionWorkspace.id, records[index].workspaceId);
    const runtime = body.currentExecutionWorkspace.runtimeServices.find((row: { id: string }) => row.id === records[index].serviceId);
    assert.ok(runtime);
    if (arm === "candidate") {
      assert.equal(runtime.status, "running");
      assert.equal(runtime.healthStatus, "healthy");
      assert.equal(runtime.url, "http://127.0.0.1:1");
    }
  };
  for (let warmup = 0; warmup < manifest.warmups; warmup++) {
    for (const name of ["detail", "context"] as const) {
      for (let index = 0; index < records.length; index++) checkWorkspace(await request(urls[name](index)), index);
    }
    await request(urls.list());
    const skills = await request(urls.skills());
    assert.equal(skills.supported, true, "exercise a real skills adapter");
    report.skillCatalogEntries = skills.entries.length;
    assert.ok(skills.entries.length >= manifest.skills, "seeded catalog must be visible");
  }
  for (const phase of ["warm", "past-cache-ttl"]) {
    if (phase === "past-cache-ttl") await new Promise(resolve => setTimeout(resolve, manifest.cacheExpiryWaitMs));
    for (const concurrency of manifest.concurrency) {
      for (const name of ["detail", "context", "list", "skills"] as const) {
        const start = performance.now();
        const cpuBefore = await cpu();
        const gitBefore = await traceCounts();
        const samples: Record<string, unknown>[] = [];
        let next = 0;
        const signal = AbortSignal.timeout(manifest.batchDeadlineMs);
        await Promise.all(Array.from({ length: concurrency }, async () => {
          while (next < manifest.requests) {
            const index = next++;
            const requestStart = performance.now();
            try {
              await request(urls[name](index), signal);
              samples.push({ index, ms: performance.now() - requestStart, ok: true });
            } catch (error) {
              samples.push({ index, ms: performance.now() - requestStart, ok: false, error: String(error) });
            }
          }
        }));
        const cpuAfter = await cpu();
        const gitAfter = await traceCounts();
        const times = samples.map(sample => Number(sample.ms)).sort((a, b) => a - b);
        const result = { phase, path: name, concurrency, samples,
          medianMs: (times[9] + times[10]) / 2, p95Ms: times[18], maxMs: times[19],
          wallMs: performance.now() - start, scans: gitAfter.scans - gitBefore.scans,
          gitCommands: gitAfter.commands - gitBefore.commands,
          cpuSeconds: (cpuAfter.selfMicros.user + cpuAfter.selfMicros.system - cpuBefore.selfMicros.user - cpuBefore.selfMicros.system) / 1e6,
          childCpuSeconds: (cpuAfter.childTicks - cpuBefore.childTicks) / ticks,
          maxRssKiB: process.resourceUsage().maxRSS };
        batches.push(result);
        assert.ok(samples.every(sample => sample.ok), "retain failed batch samples");
        assert.ok(result.wallMs < manifest.batchDeadlineMs);
        if (arm === "candidate" && (name === "detail" || name === "context")) assert.equal(result.gitCommands, 0);
      }
    }
    const before = await traceCounts();
    const coverageSignal = AbortSignal.timeout(manifest.batchDeadlineMs);
    for (const name of ["detail", "context"] as const) {
      for (let index = 0; index < records.length; index++) checkWorkspace(await request(urls[name](index), coverageSignal), index);
    }
    const after = await traceCounts();
    const result = { phase, distinctWorkspaces: records.length, requests: records.length * 2,
      scans: after.scans - before.scans, commands: after.commands - before.commands };
    coverage.push(result);
    if (arm === "candidate") assert.equal(result.commands, 0, "metadata reads must cause no Git work");
  }
  if (arm === "baseline") {
    assert.ok((await traceCounts()).scans > 0, "baseline must reproduce actual Git scan cost");
  }
  const foreign = await fetch(origin + urls.detail(0), { headers: { "x-foreign-company": "1" } });
  assert.ok([403, 404].includes(foreign.status), "foreign company cannot read task metadata");
  report.companyIsolationHttpStatus = foreign.status;
  const service = executionWorkspaceService(db);
  await assert.rejects(service.getStoredById(otherCompanyId, records[0].workspaceId, { includeRuntimeServices: true }));
  const workspace = records[0];
  await db.$client`update issues set status = 'done' where id = ${workspace.issueId}`;
  await db.$client`update workspace_runtime_services set status = 'stopped' where execution_workspace_id = ${workspace.workspaceId}`;
  const readiness = async (label: string, predicate: (value: any) => boolean) => {
    await request(urls.detail(0));
    const before = await traceCounts();
    const value = await service.getCloseReadiness(workspace.workspaceId);
    const after = await traceCounts();
    close.push({ label, value, scans: after.scans - before.scans });
    assert.ok(predicate(value), `${label}: ${JSON.stringify(value)}`);
    assert.ok(after.scans > before.scans, "explicit readiness must scan afresh");
  };
  await readiness("clean", value => value.isDestructiveCloseAllowed && !value.git.hasDirtyTrackedFiles && !value.git.hasUntrackedFiles && value.git.aheadCount === 0);
  await request(urls.detail(0));
  await fs.writeFile(path.join(workspace.cwd, "README"), "dirty\n");
  await readiness("dirty", value => value.git.hasDirtyTrackedFiles);
  await git(workspace.cwd, "restore", "README");
  await request(urls.detail(0));
  await fs.writeFile(path.join(workspace.cwd, "untracked"), "untracked\n");
  await readiness("untracked", value => value.git.hasUntrackedFiles);
  await fs.rm(path.join(workspace.cwd, "untracked"));
  await request(urls.detail(0));
  await fs.writeFile(path.join(workspace.cwd, "README"), "local commit\n");
  await git(workspace.cwd, "add", "README");
  await git(workspace.cwd, "commit", "-m", "Local fixture commit");
  await readiness("local-commit", value => value.git.aheadCount === 1 && !value.git.isMergedIntoBase);
  const remote = path.join(root, "remote.git");
  await git(repo, "init", "--bare", remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "origin", "main");
  await git(workspace.cwd, "branch", "--set-upstream-to=origin/main");
  await readiness("unpushed-commit", value => value.git.aheadCount === 1 && !value.git.isMergedIntoBase);
  const realGit = (await run("which", ["git"])).stdout.trim();
  const shim = path.join(root, "shim");
  await fs.mkdir(shim);
  await fs.writeFile(path.join(shim, "git"), `#!/bin/sh\ncase " $* " in\n*" status "*) sleep 2; exit 124;;\nesac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${shim}:${originalPath}`;
  const uncertain = await service.getCloseReadiness(workspace.workspaceId);
  close.push({ label: "timeout", value: uncertain });
  assert.equal(uncertain?.isDestructiveCloseAllowed, false, "timeout must block destructive close");
  assert.ok(uncertain?.blockingReasons.some(reason => reason.includes("could not verify")), "timeout must be the blocking reason");
  const archiveResponse = await fetch(origin + `/api/execution-workspaces/${workspace.workspaceId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "archived" }),
    signal: AbortSignal.timeout(12000),
  });
  const archiveBody = await archiveResponse.json();
  close.push({ label: "archive-timeout", status: archiveResponse.status, value: archiveBody });
  assert.equal(archiveResponse.status, 409, JSON.stringify(archiveBody));
  assert.equal((await service.getStoredById(companyId, workspace.workspaceId))?.status, "active");
  await fs.access(workspace.cwd);
  process.env.PATH = originalPath;
  await readiness("recovery", value => value.git.aheadCount === 1 && !value.git.hasDirtyTrackedFiles);
  const cleanWorkspace = records[1];
  await db.$client`update issues set status = 'done' where id = ${cleanWorkspace.issueId}`;
  await db.$client`update workspace_runtime_services set status = 'stopped' where execution_workspace_id = ${cleanWorkspace.workspaceId}`;
  const archived = await fetch(origin + `/api/execution-workspaces/${cleanWorkspace.workspaceId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "archived" }),
    signal: AbortSignal.timeout(12000),
  });
  const archivedBody = await archived.json();
  close.push({ label: "archive-clean", status: archived.status, value: archivedBody });
  assert.equal(archived.status, 200, JSON.stringify(archivedBody));
  assert.equal((await service.getStoredById(companyId, cleanWorkspace.workspaceId))?.status, "archived");
  report.passed = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  process.env.PATH = originalPath;
  if (originalTrace === undefined) delete process.env.GIT_TRACE;
  else process.env.GIT_TRACE = originalTrace;
  await fs.copyFile(trace, path.join(output, `${arm}.git.trace`)).catch(() => {});
  server?.closeAllConnections();
  for (const cleanup of [
    async () => { if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); },
    async () => { await db.$client.end({ timeout: 0 }); },
    async () => { await database.cleanup(); },
    async () => { await fs.rm(root, { recursive: true, force: true }); },
  ]) {
    try { await cleanup(); }
    catch (error) {
      report.passed = false;
      report.cleanupError = `${report.cleanupError ?? ""}\n${String(error)}`;
      process.exitCode = 1;
    }
  }
  await fs.writeFile(path.join(output, `${arm}.json`), JSON.stringify(report, null, 2));
}
