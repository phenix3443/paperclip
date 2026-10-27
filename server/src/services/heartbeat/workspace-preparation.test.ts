import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { captureDirectorySnapshot, directorySnapshotSha256, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { activityLog, agentWakeupRequests, agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, executionWorkspaces, executionWorkspaceRepositoryAccess, heartbeatRuns, issues, issueAccessGrants, plugins, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import { environmentService } from "../environments.js";
import { executionWorkspaceService, readExecutionWorkspaceLifecycleGeneration, toExecutionWorkspace } from "../execution-workspaces.js";
import { CROSS_TASK_CONTINUATION_COMMITTER_ID, crossTaskContinuationDispatchKey, crossTaskContinuationIntentKey } from "../cross-task-continuation.js";
import { reopenTargetBoundSuccessorWorkspace } from "./target-bound-successor-reopen.js";
import { instanceSettingsService } from "../instance-settings.js";
import { workspaceOperationService } from "../workspace-operations.js";
import { nativeWorkspaceSyncInternals, prepareNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { createHeartbeatWorkspaceResolver, prepareProjectRepositoryWorkspaces, resolveExecutionWorkspaceReuseRequestForIssue } from "./workspaces.js";
import { prepareHeartbeatWorkspace, type HeartbeatWorkspacePreparationInput } from "./workspace-preparation.js";
import { buildNativeExecutionInput } from "../native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import * as managedRepositoryCheckout from "../managed-repository-checkout.js";
import { isolatedRemoteSourcePath } from "../isolated-remote-workspace-source.js";
import { cleanupExecutionWorkspaceArtifacts } from "../workspace-runtime.js";
import { buildProjectMentionHref } from "@paperclipai/shared";
import { trace } from "@opentelemetry/api";
import { buildExecutionWorkspaceAdapterConfig } from "../execution-workspace-policy.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

const execFile = promisify(execFileCallback);
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("heartbeat workspace preparation boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paperclip-workspace-preparation-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    database = await startEmbeddedPostgresTestDatabase("paperclip-workspace-preparation");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.execute(sql`truncate table companies restart identity cascade`);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  });

  async function fixture(isolated = false) {
    const [company] = await db.insert(companies).values({ name: "Workspace preparation", issuePrefix: "WSP" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Workspace agent", status: "running", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Source project" }).returning();
    const source = join(home, project.id);
    await mkdir(source);
    await execFile("git", ["init", "--initial-branch=main", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Workspace test"]);
    await writeFile(join(source, "README.md"), "source content\n");
    await execFile("git", ["-C", source, "add", "."]);
    await execFile("git", ["-C", source, "commit", "-m", "Source"]);
    const [projectWorkspace] = await db.insert(projectWorkspaces).values({ companyId: company.id, projectId: project.id, name: "Source", cwd: source, isPrimary: true }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Prepare this workspace", identifier: "WSP-1", projectId: project.id, projectWorkspaceId: projectWorkspace.id, assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    const localEnvironment = await environmentService(db).ensureLocalEnvironment(company.id);
    const envOrchestrator = environmentRunOrchestrator(db);
    const resolver = createHeartbeatWorkspaceResolver(db);
    const input: HeartbeatWorkspacePreparationInput = {
      run, agent,
      task: { issueRef: issue, issueId: issue.id, context: { issueId: issue.id, projectId: project.id }, responsibleUserId: null, previousSessionParams: null },
      policy: {
        trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: isolated ? "isolated_workspace" : "shared_workspace",
        requestedExecutionWorkspaceMode: isolated ? "isolated_workspace" : "shared_workspace",
        useIsolatedTaskDirectory: false, nativeChatWorkspaceScope: null,
        projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null, environmentExecutionWorkspaceSettings: null,
        executionPolicy: { executionMode: "any" },
      },
      environment: { selectedEnvironmentId: localEnvironment.id, localEnvironment, selectedEnvironmentForConfig: localEnvironment, environmentResolution: { environmentId: localEnvironment.id, source: "default" }, resolvedInstanceSettings: await instanceSettingsService(db).get() },
      config: { mergedConfig: isolated ? { workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "test-{{issue.identifier}}" } } : {}, configSnapshot: null, secretManifest: [] },
      reuse: { requestedShouldReuseExisting: false, existingExecutionWorkspace: null, reusableExistingExecutionWorkspace: null, workspaceReuseRequest: resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: null, issueExecutionWorkspacePreference: null, existingExecutionWorkspaceStatus: null }), nativeRecoveryExecutionWorkspaceId: null, persistedNativeExecutionInput: null, isDotRun: false, runOptions: {} },
      services: { envOrchestrator, executionWorkspacesSvc: executionWorkspaceService(db), workspaceOperationsSvc: workspaceOperationService(db), ...resolver, appendRunEvent: vi.fn() },
      controllerLease: { assertOwned: vi.fn(async () => {}) }, nativeRunnerPreparationSpans: [],
    };
    return { input, source, issue, run, envOrchestrator };
  }
  it("prepares managed storage before acquisition without touching a Core checkout", async () => {
    const { input, source, issue } = await fixture(true);
    const [plugin] = await db.insert(plugins).values({ pluginKey: "test.managed-storage", packageName: "test-storage", version: "1.0.0", apiVersion: 1, status: "ready", categories: ["workspace"],
      manifestJson: { id: "test.managed-storage", apiVersion: 1, version: "1.0.0", displayName: "Storage", description: "Storage", author: "Test", categories: ["workspace"],
        workspaceProvider: { modes: ["isolated_workspace", "operator_branch"], strategies: ["git_worktree"] }, capabilities: ["workspaces.manage", "events.subscribe"], resourceLifecycle: ["project"], entrypoints: { worker: "./worker.js" } } }).returning();
    await db.update(projects).set({ executionWorkspacePolicy: { enabled: true, storageProviderPluginId: plugin.id } }).where(eq(projects.id, issue.projectId!));
    await db.update(projectWorkspaces).set({ cwd: null, sourceType: "remote_managed", repoUrl: "https://github.com/example/repo.git" }).where(eq(projectWorkspaces.id, issue.projectWorkspaceId!));
    await rm(source, { recursive: true });
    const sequence: string[] = [];
    input.services.workspaceWorkers = { getWorker: () => ({ supportedMethods: ["workspaceOperation"] }), call: async (_: string, __: string, params: any) => {
      sequence.push("prepare");
      return { kind: "prepared", binding: { pluginId: plugin.id, projectId: issue.projectId, executionWorkspaceId: params.executionWorkspaceId,
        projectWorkspaceId: issue.projectWorkspaceId, sourceRevision: params.operation.source.revision, workspaceRef: "provider:checkout" },
        branchName: params.operation.branchName, baseSha: "a".repeat(40), created: true, branchCreatedByRuntime: true };
    } } as any;
    const acquire = input.services.envOrchestrator.acquireForRun;
    vi.spyOn(input.services.envOrchestrator, "acquireForRun").mockImplementation(async args => {
      sequence.push("acquire"); expect(args.persistedExecutionWorkspace).toMatchObject({ providerType: "plugin", cwd: null });
      return acquire(args);
    });
    vi.spyOn(input.services.envOrchestrator, "realizeForRun").mockImplementation(async args => {
      expect(args.executionWorkspace.providerBinding?.workspaceRef).toBe("provider:checkout");
      throw new Error("reached execution handoff");
    });
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("reached execution handoff");
    expect(sequence).toEqual(["prepare", "acquire"]);
    await expect(access(source)).rejects.toThrow();
    const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, task.executionWorkspaceId!));
    expect(workspace).toMatchObject({ providerType: "plugin", cwd: null, branchName: "test-WSP-1" });
  });
  const readIssue = (id: string) => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);
  const readRun = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  const leases = (id: string) => db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, id));

  it("keeps plugin-owned storage untouched when a fresh attempt cannot import preserved files", async () => {
    const { input, source, issue } = await fixture(true);
    await db.update(projects).set({ executionWorkspacePolicy: {
      enabled: true, storageProviderPluginId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    } }).where(eq(projects.id, issue.projectId!));
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    const call = vi.fn();
    input.services.workspaceWorkers = { getWorker: () => ({ supportedMethods: ["workspaceOperation"] }), call } as any;
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
      resultJson: { reason: "fresh_workspace_storage_unsupported" },
    });
    expect(call).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toHaveLength(0);
    expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("source content\n");
  });

  it("a fresh retry creates independent files and Git storage instead of reopening a configured task branch", async () => {
    const { input, source, issue } = await fixture(true);
    const original = await prepareHeartbeatWorkspace(db, input);
    await writeFile(join(original.executionWorkspace.cwd, "unpublished.txt"), "keep the old work\n");
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: input.run.companyId,
      agentId: input.agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: nextRun.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    input.run = nextRun;
    input.task.issueRef = { ...issue, executionWorkspaceId: null, executionWorkspacePreference: "create_new" };
    const replacement = await prepareHeartbeatWorkspace(db, input);
    expect(replacement.persistedExecutionWorkspace!.id).not.toBe(original.persistedExecutionWorkspace!.id);
    expect(replacement.executionWorkspace.cwd).not.toBe(original.executionWorkspace.cwd);
    expect(replacement.executionWorkspace.cwd).not.toBe(source);
    expect(await readFile(join(replacement.executionWorkspace.cwd, "README.md"), "utf8")).toBe("source content\n");
    expect(await readFile(join(original.executionWorkspace.cwd, "unpublished.txt"), "utf8")).toBe("keep the old work\n");
    const common = await execFile("git", ["-C", replacement.executionWorkspace.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    expect(common.stdout.trim()).toBe(join(replacement.executionWorkspace.cwd, ".git"));
    await expect(access(join(replacement.executionWorkspace.cwd, "unpublished.txt"))).rejects.toThrow();
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(replacement.persistedExecutionWorkspace!.id);
  }, 30_000);

  it("starts a fresh clean task directory without treating it as a Git source", async () => {
    const { input, source, issue } = await fixture();
    input.policy.useIsolatedTaskDirectory = true;
    input.policy.effectiveExecutionWorkspaceMode = "isolated_workspace";
    input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
    input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    const prepared = await prepareHeartbeatWorkspace(db, input);
    expect(prepared.executionWorkspace.cwd).toContain("/isolated-workspace-attempts/");
    expect(prepared.executionWorkspace.cwd).toContain(`/${input.run.id}`);
    expect(prepared.executionWorkspace.cwd).not.toBe(source);
    await expect(access(join(prepared.executionWorkspace.cwd, "README.md"))).rejects.toThrow();
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("source content\n");
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(prepared.persistedExecutionWorkspace!.id);
  });

  async function reuse(input: HeartbeatWorkspacePreparationInput, workspace: NonNullable<Awaited<ReturnType<typeof prepareHeartbeatWorkspace>>["persistedExecutionWorkspace"]>) {
    input.reuse.requestedShouldReuseExisting = true;
    input.reuse.existingExecutionWorkspace = workspace;
    input.reuse.reusableExistingExecutionWorkspace = workspace;
    input.reuse.workspaceReuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: workspace.id, issueExecutionWorkspacePreference: "reuse_existing", existingExecutionWorkspaceStatus: workspace.status });
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: input.run.companyId, agentId: input.agent.id, issueId: input.task.issueId, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    input.run = run;
  }

  async function persistRecoveryInput(input: HeartbeatWorkspacePreparationInput, workspaceId: string, cwd: string) {
    const issue = await readIssue(input.task.issueId!);
    const admitted = buildNativeExecutionInput({ companyId: input.agent.companyId, agentId: input.agent.id,
      runId: input.run.id, provider: "codex",
      issue: { id: issue.id, identifier: issue.identifier, title: issue.title, description: null, workMode: "standard" },
      taskPrompt: "Continue admitted task", normalizedSessionId: null,
      workspace: { id: workspaceId, cwd, repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: input.run.id, sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Continue admitted task", criteria: [{ id: "objective", requirement: "Finish" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    input.run.runtimeMode = "native";
    input.run.nativeIssueId = issue.id;
    input.run.runnerProfileJson = { nativeExecutionInput: admitted };
    input.reuse.persistedNativeExecutionInput = admitted;
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id,
      runnerProfileJson: input.run.runnerProfileJson }).where(eq(heartbeatRuns.id, input.run.id));
    return admitted;
  }

  it.each(["muse", "openai_dot", "grok_bot"] as const)("uses private %s controller storage without rebinding task files or preparing repositories", async provider => {
    const { input, issue } = await fixture();
    input.agent.adapterType = "paperclip_runner";
    input.config.mergedConfig = { provider, cwd: "/task/source/must-not-be-read", workspaceStrategy: { type: "git_worktree" } };
    input.reuse.isDotRun = true;
    const resolve = vi.spyOn(input.services, "resolveWorkspaceForRun").mockRejectedValue(new Error("Task files must not be adopted"));
    const bind = vi.spyOn(input.services.executionWorkspacesSvc, "bindTaskWorkspace").mockRejectedValue(new Error("Task binding must not change"));
    const repos = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission").mockRejectedValue(new Error("Repositories must not be prepared"));
    try {
      const result = await prepareHeartbeatWorkspace(db, input);
      expect(result.executionWorkspace.cwd).toContain(provider === "muse" ? "muse-controllers" : "dot-controllers");
      expect(result.persistedExecutionWorkspace).toBeNull();
      expect(result.projectRepositoryPaths).toEqual([]);
      expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      expect(repos).not.toHaveBeenCalled();
      const binding = { companyId: input.agent.companyId, agentId: input.agent.id, bindingId: input.run.id,
        bindingGeneration: 1, acceptByUnixMs: Date.now() + 60_000, expiresAtUnixMs: Date.now() + 600_000 };
      const admitted = buildNativeExecutionInput({ companyId: input.agent.companyId, agentId: input.agent.id,
        runId: input.run.id, provider, ...(provider === "muse" ? { museBinding: binding } : { dotBinding: binding }),
        issue: { id: issue.id, identifier: null, title: issue.title, description: null, workMode: "standard" },
        taskPrompt: "Preserve the admitted controller", normalizedSessionId: input.run.id,
        workspace: { id: input.run.id, cwd: result.executionWorkspace.cwd, repoUrl: null, repoRef: null, branchName: null },
        completionContract: { id: input.run.id, sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
          contract: { revision: "1", objective: "Preserve the controller", criteria: [{ id: "objective", requirement: "Preserve the original checkpoint path" }] } },
        runtimeContext: nativeRuntimeContextFixture(),
      });
      input.reuse.persistedNativeExecutionInput = admitted;
      input.run.runtimeMode = "native";
      input.run.runnerProfileJson = { nativeExecutionInput: admitted };
      input.config.mergedConfig = { provider: "codex" };
      const recovered = await prepareHeartbeatWorkspace(db, input);
      expect(recovered.executionWorkspace.cwd).toBe(result.executionWorkspace.cwd);
      expect(recovered.persistedExecutionWorkspace).toBeNull();
      expect(bind).not.toHaveBeenCalled();
      expect(repos).not.toHaveBeenCalled();

    } finally { resolve.mockRestore(); bind.mockRestore(); repos.mockRestore(); }
  });

  it("persists the workspace and issue binding before acquiring its environment", async () => {
    const { input, source, issue, envOrchestrator } = await fixture();
    const acquire = envOrchestrator.acquireForRun;
    vi.spyOn(envOrchestrator, "acquireForRun").mockImplementation(async args => {
      expect((await readIssue(issue.id)).executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
      expect((await readRun(input.run.id)).contextSnapshot?.executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
      return acquire(args);
    });
    const result = await prepareHeartbeatWorkspace(db, input);
    expect(result.executionWorkspace.cwd).toBe(source);
    expect(result.persistedExecutionWorkspace).toMatchObject({ companyId: issue.companyId, projectId: issue.projectId, projectWorkspaceId: issue.projectWorkspaceId, mode: "shared_workspace" });
    expect(await leases(input.run.id)).toMatchObject([{ status: "active", executionWorkspaceId: result.persistedExecutionWorkspace!.id }]);
    expect(input.nativeRunnerPreparationSpans.map(span => span.name)).toEqual(["environment.acquire", "environment.workspace.realize"]);
    expect(input.nativeRunnerPreparationSpans.every(span => span.parentName === "task.provider_session")).toBe(true);
    expect(input.controllerLease.assertOwned).toHaveBeenCalledTimes(2);
  });

  it("records workspace steps around real persistence before environment acquisition", async () => {
    const { input, source, issue, envOrchestrator } = await fixture();
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    const acquire = envOrchestrator.acquireForRun;
    vi.spyOn(envOrchestrator, "acquireForRun").mockImplementation(async args => {
      const names = exporter.getFinishedSpans().map(span => span.name);
      expect(names).toContain("heartbeat.prepare.workspace_record_create");
      expect(names).toContain("heartbeat.prepare.workspace_binding");
      expect((await readIssue(issue.id)).executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
      return acquire(args);
    });
    try {
      const result = await prepareHeartbeatWorkspace(db, input);
      expect(result.executionWorkspace.cwd).toBe(source);
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans.map(span => span.name)).toEqual(expect.arrayContaining([
        "heartbeat.prepare.workspace_source_resolution",
        "heartbeat.prepare.workspace_provision_policy",
        "heartbeat.prepare.workspace_base_validation",
        "heartbeat.prepare.workspace_provision",
        "heartbeat.prepare.workspace_operation_binding",
        "heartbeat.prepare.workspace_config_recording",
        "heartbeat.prepare.workspace_repository_admission",
        "heartbeat.prepare.workspace_project_repositories",
      ]));
      for (const span of spans) {
        expect(Object.keys(span.attributes)).toEqual(["paperclip.task.run.run_id"]);
        expect(JSON.stringify(span.attributes)).not.toContain(source);
      }
    } finally {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      trace.disable();
      await provider.shutdown();
    }
  });

  it("prepares, reuses, and reopens a selected source containing an inaccessible private worktree", async () => {
    const { input, source, issue } = await fixture(true);
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const [privateIssue] = await db.insert(issues).values({ companyId: issue.companyId,
      title: "Private historical task", visibility: "private", projectId: issue.projectId }).returning();
    const privateCwd = join(source, "private-work");
    await execFile("git", ["-C", source, "worktree", "add", "-b", "historical-private", privateCwd, "main"]);
    await writeFile(join(privateCwd, "confidential.txt"), "Shared OS storage is not task authorization");
    const [privateWorkspace] = await db.insert(executionWorkspaces).values({ companyId: issue.companyId,
      name: "Private workspace", sourceIssueId: privateIssue.id, cwd: privateCwd,
      mode: "isolated_workspace", strategyType: "git_worktree", providerType: "git_worktree",
      providerRef: privateCwd, branchName: "historical-private", status: "idle" }).returning();
    await db.update(issues).set({ executionWorkspaceId: privateWorkspace.id }).where(eq(issues.id, privateIssue.id));
    const clone = vi.spyOn(managedRepositoryCheckout, "materializeManagedProjectWorkspace");
    const result = await prepareHeartbeatWorkspace(db, input);
    expect(result.executionWorkspace.baseCwd).toBe(source);
    expect(result.persistedExecutionWorkspace!.metadata?.isolatedRemoteSource).toBeUndefined();
    expect(await readFile(join(result.executionWorkspace.cwd, "README.md"), "utf8")).toBe("source content\n");
    expect(clone).not.toHaveBeenCalled();
    await expect(access(isolatedRemoteSourcePath(issue.companyId, issue.id))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(result.executionWorkspace.cwd, "unpublished-work.txt"), "Keep current task edits\n");
    await reuse(input, result.persistedExecutionWorkspace!);
    const resumed = await prepareHeartbeatWorkspace(db, input);
    expect(resumed.persistedExecutionWorkspace!.id).toBe(result.persistedExecutionWorkspace!.id);
    expect(await readFile(join(resumed.executionWorkspace.cwd, "unpublished-work.txt"), "utf8")).toBe("Keep current task edits\n");
    const workspace = resumed.persistedExecutionWorkspace!;
    const cleanup = await cleanupExecutionWorkspaceArtifacts({ workspace,
      projectWorkspace: { cwd: source, cleanupCommand: null }, runCleanupCommands: false });
    expect(cleanup.warnings).toEqual([]);
    await db.update(executionWorkspaces).set({ status: "archived" }).where(eq(executionWorkspaces.id, workspace.id));
    const reopened = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId: workspace.id,
      issue: { id: issue.id, companyId: issue.companyId, projectId: issue.projectId },
      actor: { agentId: input.agent.id, actorType: "agent" },
      authorizationActor: { type: "agent", source: "agent_jwt", agentId: input.agent.id, companyId: issue.companyId, runId: input.run.id },
    });
    expect(reopened).toMatchObject({ ok: true });
    expect(await readFile(join(workspace.cwd!, "README.md"), "utf8")).toBe("source content\n");
    expect(await readFile(join(privateCwd, "confidential.txt"), "utf8")).toContain("OS storage");
  });

  it("cleans up a new local worktree after workspace persistence fails", async () => {
    const { input, source, issue } = await fixture(true);
    vi.spyOn(input.services.executionWorkspacesSvc, "create").mockRejectedValueOnce(new Error("Workspace persistence failed"));
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("Workspace persistence failed");
    const worktrees = (await execFile("git", ["-C", source, "worktree", "list", "--porcelain"])).stdout;
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
    await expect(execFile("git", ["-C", source, "rev-parse", "--verify", `refs/heads/test-${issue.identifier}`])).rejects.toBeDefined();
    expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
  });

  it.each(["sandbox", "ssh", "plugin", "local", null] as const)("uses the selected %s placement for controller provisioning", async driver => {
    const { input, source, issue, envOrchestrator } = await fixture(true);
    const marker = join(source, "host-provision-ran");
    const provisionCommand = `printf host > '${marker}'`;
    input.config.mergedConfig = { workspaceStrategy: { type: "git_worktree", provisionCommand, runtimeProvisionCommand: "printf runtime" } };
    const originalConfig = structuredClone(input.config.mergedConfig);
    input.environment.selectedEnvironmentForConfig = driver === null ? null : { ...input.environment.localEnvironment, driver };
    const stopped = new Error("Fixture stops before transport acquisition");
    vi.spyOn(envOrchestrator, "acquireForRun").mockRejectedValue(stopped);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    const bound = await readIssue(issue.id);
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
    expect(await readFile(join(workspace.cwd!, "README.md"), "utf8")).toBe("source content\n");
    if (driver === "sandbox" || driver === "ssh" || driver === "plugin") await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(marker, "utf8")).toBe("host");
    expect(input.config.mergedConfig).toEqual(originalConfig);
  });

  it("keeps a plugin workspace ledger across runs without preparing Core repositories", async () => {
    const { input, issue, envOrchestrator, source } = await fixture();
    input.agent.adapterType = "paperclip_runner";
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    const guestOnly = join(home, "guest-only", issue.projectId!);
    await db.update(projectWorkspaces).set({ cwd: guestOnly }).where(eq(projectWorkspaces.id, issue.projectWorkspaceId!));
    const copy = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission").mockRejectedValue(new Error("Core must not prepare repositories"));
    const restoredCopy = vi.spyOn(input.services.executionWorkspacesSvc, "prepareConfiguredRepositoryCopy").mockRejectedValue(new Error("Core must not restore repositories"));
    const stopped = new Error("Plugin realization boundary");
    const realize = vi.spyOn(envOrchestrator, "realizeForRun").mockRejectedValue(stopped);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    const firstId = (await readIssue(issue.id)).executionWorkspaceId!;
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, firstId));
    expect(workspace).toMatchObject({ cwd: `/workspaces/${issue.projectWorkspaceId}`, strategyType: "project_primary", providerType: "adapter_managed" });
    await reuse(input, toExecutionWorkspace(workspace));
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(firstId);
    expect(realize).toHaveBeenCalledTimes(2);
    expect(copy).not.toHaveBeenCalled(); expect(restoredCopy).not.toHaveBeenCalled();
    await expect(access(guestOnly)).rejects.toMatchObject({ code: "ENOENT" });
    input.environment.selectedEnvironmentForConfig = input.environment.localEnvironment;
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
      resultJson: { reason: "plugin_workspace_owner_mismatch" },
    });
    expect(realize).toHaveBeenCalledTimes(2);
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    const [localWorkspace] = await db.update(executionWorkspaces).set({ providerType: "local_fs", cwd: source, metadata: {} })
      .where(eq(executionWorkspaces.id, firstId)).returning();
    await reuse(input, toExecutionWorkspace(localWorkspace));
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
      resultJson: { reason: "plugin_workspace_owner_mismatch" },
    });
    expect(realize).toHaveBeenCalledTimes(2);
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("source content\n");
  });

  it.each(["services", "fresh"] as const)("rejects unsupported %s before plugin workspace preparation or acquisition", async mode => {
    const { input, envOrchestrator } = await fixture();
    input.agent.adapterType = "paperclip_runner";
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    if (mode === "services") input.config.mergedConfig.workspaceRuntime = { services: [{ name: "preview", command: "must-not-run-on-core" }] };
    else input.task.freshWorkspace = { mode: "fresh_isolated_workspace", retryIntentId: input.run.id,
      sourceRunId: input.run.id, retainedSourceIds: [] };
    const acquire = vi.spyOn(envOrchestrator, "acquireForRun");
    const resolve = vi.spyOn(input.services, "resolveWorkspaceForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
      resultJson: { reason: mode === "services" ? "plugin_workspace_services_unsupported" : "fresh_workspace_storage_unsupported" },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("admits the metadata-only agent-default strategy for a plugin workspace", async () => {
    const { input, envOrchestrator } = await fixture();
    input.agent.adapterType = "paperclip_runner";
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    input.policy.requestedExecutionWorkspaceMode = "agent_default";
    input.policy.effectiveExecutionWorkspaceMode = "agent_default";
    const stopped = new Error("Plugin agent-default admission reached");
    const realize = vi.spyOn(envOrchestrator, "realizeForRun").mockRejectedValue(stopped);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
    expect(realize).toHaveBeenCalledWith(expect.objectContaining({ executionWorkspace: expect.objectContaining({ strategy: "adapter_managed", cwd: `/workspaces/${input.task.issueId}` }),
      persistedExecutionWorkspace: expect.objectContaining({ strategyType: "adapter_managed", providerType: "adapter_managed" }) }));
  });

  it("rejects Core Git worktree preparation for a plugin-owned workspace", async () => {
    const { input, envOrchestrator } = await fixture(true);
    input.agent.adapterType = "paperclip_runner";
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    const acquire = vi.spyOn(envOrchestrator, "acquireForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({
      code: "workspace_validation_failed", resultJson: { reason: "plugin_workspace_strategy_unsupported" },
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([true, false])("forwards only authorized plugin project IDs without staging (remote enabled: %s)", async enabled => {
    const { input, issue, envOrchestrator } = await fixture();
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "true");
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", String(enabled));
    input.agent = { ...input.agent, adapterType: "paperclip_runner" };
    input.environment.selectedEnvironmentForConfig = { ...input.environment.localEnvironment, driver: "plugin" };
    const [readable, privateProject] = await db.insert(projects).values([
      { companyId: issue.companyId, name: "Readable reference" },
      { companyId: issue.companyId, name: "Private reference", visibility: "private" },
    ]).returning();
    const unavailableCwd = join(home, readable.id, "must-not-stage");
    await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: readable.id, name: "Provider-only storage", cwd: unavailableCwd });
    await db.update(issues).set({ description: [readable, privateProject].map(project => `[project](${buildProjectMentionHref(project.id)})`).join(" ") }).where(eq(issues.id, issue.id));
    const stopped = new Error("Fixture reached plugin realization");
    const realize = vi.spyOn(envOrchestrator, "realizeForRun").mockRejectedValue(stopped);
    try {
      await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(stopped);
      expect(realize).toHaveBeenCalledWith(expect.objectContaining({
        runnerTaskProjectIds: enabled ? [issue.projectId, readable.id] : undefined,
        executionWorkspace: expect.objectContaining({ additionalWorkspaces: [] }),
      }));
      await expect(access(unavailableCwd)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "true");
      vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", "true");
    }
  });

  it("checks current repository admission before publishing configured sibling repositories", async () => {
    const { input, source, issue } = await fixture();
    await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: issue.projectId!,
      name: "Sibling repository", repoUrl: pathToFileURL(source).href });
    vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission")
      .mockRejectedValue(new Error("Current run identity is unavailable"));
    const acquire = vi.spyOn(input.services.envOrchestrator, "acquireForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("Current run identity is unavailable");
    await expect(access(join(source, ".paperclip-repositories"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("rechecks current binding after configured clone and before publication", async () => {
    const { input, source, issue } = await fixture();
    await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: issue.projectId!,
      name: "Sibling repository", repoUrl: pathToFileURL(source).href });
    const namespace = join(source, ".paperclip-repositories");
    const guard = vi.spyOn(input.services.executionWorkspacesSvc, "assertTaskRepositoryPublicationAllowed")
      .mockImplementation(async () => {
        const candidates = await readdir(namespace);
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toContain(".clone-");
        expect(await readFile(join(namespace, candidates[0]!, "README.md"), "utf8")).toBe("source content\n");
        throw new Error("Task binding changed during clone");
      });
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("Task binding changed during clone");
    expect(guard).toHaveBeenCalledOnce();
    expect(await readdir(namespace)).toEqual([]);
    expect(await leases(input.run.id)).toEqual([]);
  });

  it("rejects a configured sibling copy when its source disappears before publication", async () => {
    const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const { input, source, issue } = await fixture();
      const sibling = source + "-private-sibling";
      await execFile("git", ["clone", "--no-hardlinks", source, sibling]);
      await writeFile(join(sibling, "private.txt"), "PRIVATE_SIBLING_STAGING_BYTES");
      const [privateIssue] = await db.insert(issues).values({ companyId: issue.companyId, title: "Private sibling owner",
        visibility: "private", responsibleUserId: "private-owner" }).returning();
      const [privateWorkspace] = await db.insert(executionWorkspaces).values({ companyId: issue.companyId,
        name: "Private sibling", projectId: null, sourceIssueId: privateIssue.id, cwd: sibling,
        providerType: "local_fs", strategyType: "project_primary", mode: "shared_workspace", status: "active" }).returning();
      await db.insert(issueAccessGrants).values({ issueId: privateIssue.id, subjectType: "agent", subjectId: input.agent.id, source: "explicit" });
      const [configured] = await db.insert(projectWorkspaces).values({ companyId: issue.companyId, projectId: issue.projectId!,
        name: "Private sibling", cwd: sibling, repoUrl: pathToFileURL(sibling).href }).returning();
      const namespace = join(source, ".paperclip-repositories");
      const originalPrepare = input.services.executionWorkspacesSvc.prepareConfiguredRepositoryCopy;
      const prepare = vi.spyOn(input.services.executionWorkspacesSvc, "prepareConfiguredRepositoryCopy").mockImplementation(async args => {
        const recheck = await originalPrepare(args);
        return async () => {
          const candidates = await readdir(namespace);
          expect(candidates).toHaveLength(1);
          expect(candidates[0]).toContain(".clone-");
          expect(await readFile(join(namespace, candidates[0]!, "private.txt"), "utf8")).toBe("PRIVATE_SIBLING_STAGING_BYTES");
          const retained = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, issue.companyId));
          expect(retained).toEqual([]);
          await rename(sibling, sibling + "-moved");
          await db.update(projectWorkspaces).set({ cwd: sibling + "-moved" }).where(eq(projectWorkspaces.id, configured.id));
          await recheck();
        };
      });
      await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow(/ENOENT|unavailable|inaccessible|no longer/i);
      expect(prepare).toHaveBeenCalledOnce();
      expect(await readdir(namespace)).toEqual([]);
      expect(await leases(input.run.id)).toEqual([]);
      await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, privateIssue.id));

    } finally {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", previousPrivacyMode);
    }
  });

  it.each(["file://untrusted-host/private/repository", "file:///private%2Frepository", "file:///private/repository?other", "file:///private/repository#other"])("rejects malformed local repository URL before source access: %s", async repoUrl => {
    const { source, issue } = await fixture();
    const prepareLocalSource = vi.fn();
    await expect(prepareProjectRepositoryWorkspaces({ cwd: source, anchorRepoUrl: null,
      workspaces: [{ id: issue.projectWorkspaceId!, repoUrl, repoRef: null, cwd: null }], prepareLocalSource })).rejects.toThrow();
    expect(prepareLocalSource).not.toHaveBeenCalled();
    expect(await readdir(join(source, ".paperclip-repositories"))).toEqual([]);
  });

  it("persists and reuses task-owned files without adopting the organizational project as their source", async () => {
    const { input, issue } = await fixture();
    await db.update(issues).set({ projectWorkspaceId: null,
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "task_directory" } },
    }).where(eq(issues.id, issue.id));
    input.task.issueRef = await readIssue(issue.id);
    const bind = vi.spyOn(input.services.executionWorkspacesSvc, "bindTaskWorkspace");
    const first = await prepareHeartbeatWorkspace(db, input);
    expect(first.persistedExecutionWorkspace).toMatchObject({ projectId: null, projectWorkspaceId: null, sourceIssueId: issue.id });
    expect(bind).toHaveBeenCalled();
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(first.persistedExecutionWorkspace!.id);
    await writeFile(join(first.executionWorkspace.cwd, "retained.txt"), "task files");
    const [organization] = await db.insert(projects).values({ companyId: issue.companyId, name: "New organization" }).returning();
    await db.update(issues).set({ projectId: organization.id }).where(eq(issues.id, issue.id));
    input.task.issueRef = await readIssue(issue.id);
    await reuse(input, first.persistedExecutionWorkspace!);
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.persistedExecutionWorkspace).toMatchObject({ id: first.persistedExecutionWorkspace!.id, projectId: null });
    expect(next.executionWorkspace.cwd).toBe(first.executionWorkspace.cwd);
    expect(await readFile(join(next.executionWorkspace.cwd, "retained.txt"), "utf8")).toBe("task files");
    expect((await readIssue(issue.id)).projectId).toBe(organization.id);
  });

  it("retains task-directory provenance through shared workspace preparation", async () => {
    const { input, issue, source } = await fixture();
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null,
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "task_directory" } },
    }).where(eq(issues.id, issue.id));
    input.task.issueRef = await readIssue(issue.id);
    input.task.context = { issueId: issue.id };
    const first = await prepareHeartbeatWorkspace(db, input);
    expect(first.executionWorkspace.source).toBe("task_session");
    expect(first.persistedExecutionWorkspace).toMatchObject({ mode: "shared_workspace", strategyType: "project_primary",
      sourceIssueId: issue.id, projectId: null, projectWorkspaceId: null, repoUrl: null, metadata: { source: "task_session" } });
    await mkdir(join(first.executionWorkspace.cwd, ".git", "info"), { recursive: true });
    await writeFile(join(first.executionWorkspace.cwd, ".git", "info", "exclude"), "/.paperclip-repositories/\n");
    await writeFile(join(first.executionWorkspace.cwd, "original-context.txt"), "Preserve the original task bytes\n");
    await db.update(issues).set({ executionRunId: input.run.id }).where(eq(issues.id, issue.id));
    const taskRepositories = executionWorkspaceService(db);
    const receipt = await taskRepositories.requestTaskRepository({ companyId: issue.companyId, issueId: issue.id,
      actor: { type: "board", source: "local_implicit", userId: "local-board" },
      request: { repository: { kind: "url", url: "https://github.com/public/source" }, requestKey: "retained-task-directory" } });
    const materialize = managedRepositoryCheckout.materializeManagedProjectWorkspace;
    vi.spyOn(managedRepositoryCheckout, "materializeManagedProjectWorkspace").mockImplementation((cwd, options) =>
      materialize(cwd, { ...options, localSource: source }));
    await reuse(input, first.persistedExecutionWorkspace!);
    await db.update(issues).set({ executionRunId: input.run.id }).where(eq(issues.id, issue.id));
    input.task.issueRef = await readIssue(issue.id);
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.executionWorkspace.source).toBe("task_session");
    expect(next.persistedExecutionWorkspace!.metadata?.source).toBe("task_session");
    expect(next.persistedExecutionWorkspace!.id).toBe(first.persistedExecutionWorkspace!.id);
    expect(await readFile(join(next.executionWorkspace.cwd, "original-context.txt"), "utf8")).toBe("Preserve the original task bytes\n");
    const [repository] = await taskRepositories.listTaskRepositories(issue.companyId, next.persistedExecutionWorkspace!.id);
    expect(repository).toMatchObject({ id: receipt.operationId, state: "ready" });
    expect(await readFile(join(next.executionWorkspace.cwd, repository.relativePath, "README.md"), "utf8")).toBe("source content\n");
  });

  it("creates a real isolated worktree and reuses its recorded workspace", async () => {
    const { input, source, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    expect(first.executionWorkspace.cwd).not.toBe(source);
    expect(await readFile(join(first.executionWorkspace.cwd, "README.md"), "utf8")).toBe("source content\n");
    expect(await readIssue(issue.id)).toMatchObject({ executionWorkspaceId: first.persistedExecutionWorkspace!.id, executionWorkspacePreference: "reuse_existing" });
    await writeFile(join(first.executionWorkspace.cwd, "retained.txt"), "keep this work");
    await reuse(input, first.persistedExecutionWorkspace!);
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.reusedExecutionWorkspace).toMatchObject({ cwd: first.executionWorkspace.cwd });
    expect(next.persistedExecutionWorkspace!.id).toBe(first.persistedExecutionWorkspace!.id);
    expect(await readFile(join(next.executionWorkspace.cwd, "retained.txt"), "utf8")).toBe("keep this work");
  });

  // Archive a real git_worktree with an unmerged commit, as the real cleanup does,
  // and move the target to `todo` with its binding unchanged, as the deferred
  // continuation commit does.
  async function archivedContinuationTarget(closedStatus: "archived" | "cleanup_failed" = "archived") {
    const { input, source, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    const workspace = first.persistedExecutionWorkspace!;
    await writeFile(join(workspace.cwd!, "archived-branch-work.txt"), "work on the archived branch\n");
    await execFile("git", ["-C", workspace.cwd!, "add", "."]);
    await execFile("git", ["-C", workspace.cwd!, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "Archived work"]);
    const headBeforeArchive = (await execFile("git", ["-C", workspace.cwd!, "rev-parse", "HEAD"])).stdout.trim();
    const cleanup = await cleanupExecutionWorkspaceArtifacts({ workspace,
      projectWorkspace: { cwd: source, cleanupCommand: null }, runCleanupCommands: false });
    // Archiving keeps the unmerged branch; only the worktree directory is removed.
    expect(cleanup.warnings).toEqual([expect.stringContaining("not fully merged")]);
    await expect(access(workspace.cwd!)).rejects.toMatchObject({ code: "ENOENT" });
    await db.update(executionWorkspaces).set({ status: closedStatus, closedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issue.id));
    const target = await readIssue(issue.id);
    expect(target).toMatchObject({ executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" });
    const stored = (await executionWorkspaceService(db).getStoredById(issue.companyId, workspace.id))!;
    return { input, issue, target, workspace: stored, headBeforeArchive,
      generation: readExecutionWorkspaceLifecycleGeneration(stored.metadata as Record<string, unknown> | null) };
  }

  // The committed intent and the consumer's dispatch receipt, with the keys and
  // actor ids that the route and the queue write.
  async function dispatchedContinuationRun(f: Awaited<ReturnType<typeof archivedContinuationTarget>>,
    overrides: { payloadIssueId?: string; workspaceGeneration?: number } = {}) {
    const commentId = randomUUID();
    const [intent] = await db.insert(agentWakeupRequests).values({
      companyId: f.issue.companyId, agentId: f.input.agent.id, source: "automation", triggerDetail: "system",
      reason: "issue_reopened_via_comment", status: "coalesced",
      requestedByActorType: "system", requestedByActorId: CROSS_TASK_CONTINUATION_COMMITTER_ID,
      idempotencyKey: crossTaskContinuationIntentKey(overrides.payloadIssueId ?? f.issue.id, commentId),
      payload: { issueId: overrides.payloadIssueId ?? f.issue.id, commentId, crossTaskContinuation: {
        workspaceId: f.workspace.id, workspaceGeneration: overrides.workspaceGeneration ?? f.generation,
        expectedAssigneeAgentId: f.input.agent.id, expectedResponsibleUserId: null } },
    }).returning();
    const dispatchKey = crossTaskContinuationDispatchKey(intent!.id);
    const [receipt] = await db.insert(agentWakeupRequests).values({
      companyId: f.issue.companyId, agentId: f.input.agent.id, source: "automation", triggerDetail: "system",
      reason: "issue_reopened_via_comment", status: "claimed",
      requestedByActorType: "system", requestedByActorId: dispatchKey, idempotencyKey: dispatchKey,
      payload: { issueId: f.issue.id },
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.issue.companyId, agentId: f.input.agent.id,
      issueId: f.issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy", wakeupRequestId: receipt!.id,
      contextSnapshot: { issueId: f.issue.id, taskId: f.issue.id, source: "cross_task_continuation", crossTaskContinuationIntentId: intent!.id } }).returning();
    await db.update(agentWakeupRequests).set({ runId: run!.id }).where(eq(agentWakeupRequests.id, intent!.id));
    return run!;
  }

  function successorStep(run: typeof heartbeatRuns.$inferSelect, executionWorkspacesSvc = executionWorkspaceService(db)) {
    return reopenTargetBoundSuccessorWorkspace(db, {
      run: { id: run.id, companyId: run.companyId, agentId: run.agentId, wakeupRequestId: run.wakeupRequestId,
        issueId: run.issueId, nativeIssueId: run.nativeIssueId, contextSnapshot: run.contextSnapshot as Record<string, unknown> },
      responsibleUserId: null, externalProvider: false, hasPersistedNativeExecutionInput: false,
      freshIsolatedWorkspaceRequested: false, executionWorkspacesSvc,
    });
  }

  it("R2-P / E1: a run that is not the dispatch of a committed intent does not reopen, and preparation fails as before", async () => {
    const f = await archivedContinuationTarget();
    const reuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: f.target.executionWorkspaceId,
      issueExecutionWorkspacePreference: f.target.executionWorkspacePreference, existingExecutionWorkspaceStatus: f.workspace.status });
    // Same inputs as environment-selection.ts: restore is requested, but an archived row is not "available".
    expect(reuseRequest).toEqual({ requestedExecutionWorkspaceId: f.workspace.id, requestedShouldReuseExisting: true, existingExecutionWorkspaceAvailable: false });
    // The context claims a continuation, but the wakeup row is not a dispatch receipt.
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.issue.companyId, agentId: f.input.agent.id, issueId: f.issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy",
      contextSnapshot: { issueId: f.issue.id, source: "cross_task_continuation" } }).returning();
    const svc = executionWorkspaceService(db);
    const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
    await expect(successorStep(successor!, svc)).resolves.toEqual({ kind: "not_eligible" });
    expect(reopen).not.toHaveBeenCalled();
    f.input.run = successor!;
    f.input.task.issueRef = f.target;
    f.input.reuse.requestedShouldReuseExisting = true;
    f.input.reuse.existingExecutionWorkspace = f.workspace;
    f.input.reuse.reusableExistingExecutionWorkspace = null;
    f.input.reuse.workspaceReuseRequest = reuseRequest;
    await expect(prepareHeartbeatWorkspace(db, f.input)).rejects.toThrow(/could not be restored/);
    expect((await executionWorkspaceService(db).getStoredById(f.issue.companyId, f.workspace.id))?.status).toBe("archived");
  });

  it.each(["archived", "cleanup_failed"] as const)("R2: the target-bound successor reopens a %s git_worktree with its own identity and ordinary preparation reuses it", async (closedStatus) => {
    const f = await archivedContinuationTarget(closedStatus);
    const successor = await dispatchedContinuationRun(f);
    const svc = executionWorkspaceService(db);
    const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
    const access = await import("../task-workspace-access.js");
    const guard = vi.spyOn(access, "assertTaskWorkspaceExecutionAccess");
    const outcome = await successorStep(successor, svc);
    expect(outcome).toEqual({ kind: "reopened", workspaceId: f.workspace.id, generation: f.generation + 1, reopened: true });
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(reopen.mock.calls[0]![0]).toMatchObject({ workspaceId: f.workspace.id, expectedClosedGeneration: f.generation,
      issue: { id: f.issue.id }, authorizationActor: { type: "agent", agentId: f.input.agent.id, runId: successor.id } });
    expect(guard).toHaveBeenCalled();
    for (const call of guard.mock.calls) expect(call[1]).toMatchObject({ runId: successor.id });
    const active = (await executionWorkspaceService(db).getStoredById(f.issue.companyId, f.workspace.id))!;
    expect(active.status).toBe("active");
    expect(readExecutionWorkspaceLifecycleGeneration(active.metadata as Record<string, unknown> | null)).toBe(f.generation + 1);
    const reopened = await db.select().from(activityLog).where(eq(activityLog.action, "execution_workspace.reopened"));
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.details).toMatchObject({ issueId: f.issue.id });
    // Ordinary preparation, with the inputs environment selection builds for an active row (R2-C: no in-place restore of a cleanup_failed row).
    const reuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: f.workspace.id,
      issueExecutionWorkspacePreference: "reuse_existing", existingExecutionWorkspaceStatus: active.status });
    expect(reuseRequest).toMatchObject({ requestedShouldReuseExisting: true, existingExecutionWorkspaceAvailable: true });
    f.input.run = successor;
    f.input.task.issueRef = await readIssue(f.issue.id);
    f.input.reuse.requestedShouldReuseExisting = true;
    f.input.reuse.existingExecutionWorkspace = active;
    f.input.reuse.reusableExistingExecutionWorkspace = active;
    f.input.reuse.workspaceReuseRequest = reuseRequest;
    const prepared = await prepareHeartbeatWorkspace(db, f.input);
    expect(prepared.persistedExecutionWorkspace!.id).toBe(f.workspace.id);
    expect(prepared.executionWorkspace.cwd).toBe(f.workspace.cwd);
    expect((await execFile("git", ["-C", f.workspace.cwd!, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe(f.workspace.branchName);
    expect((await execFile("git", ["-C", f.workspace.cwd!, "rev-parse", "HEAD"])).stdout.trim()).toBe(f.headBeforeArchive);
    expect(await readFile(join(f.workspace.cwd!, "archived-branch-work.txt"), "utf8")).toBe("work on the archived branch\n");
  });

  const failClosedCases: Array<{ name: string; arrange: (f: Awaited<ReturnType<typeof archivedContinuationTarget>>) => Promise<{ payloadIssueId?: string; workspaceGeneration?: number } | void> }> = [
    { name: "E2 the intent names another issue", arrange: async () => ({ payloadIssueId: randomUUID() }) },
    { name: "E3 the assignee changed after the commit", arrange: async (f) => {
      const [other] = await db.insert(agents).values({ companyId: f.issue.companyId, name: "Other agent", status: "idle", adapterType: "process" }).returning();
      await db.update(issues).set({ assigneeAgentId: other!.id }).where(eq(issues.id, f.issue.id));
    } },
    { name: "E3 the responsible user changed after the commit", arrange: async (f) => {
      await db.execute(sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) values ('e3-user', 'E3', 'e3@example.test', true, now(), now()) on conflict do nothing`);
      await db.update(issues).set({ responsibleUserId: "e3-user" }).where(eq(issues.id, f.issue.id));
    } },
    { name: "E4 the binding was cleared", arrange: async (f) => {
      await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issue.id));
    } },
    { name: "E5 the row became a plugin provider", arrange: async (f) => {
      await db.update(executionWorkspaces).set({ providerType: "plugin" }).where(eq(executionWorkspaces.id, f.workspace.id));
    } },
    { name: "E5 the row has another strategy", arrange: async (f) => {
      await db.update(executionWorkspaces).set({ strategyType: "project_primary" }).where(eq(executionWorkspaces.id, f.workspace.id));
    } },
    { name: "E7 the generation differs from the intent", arrange: async (f) => ({ workspaceGeneration: f.generation + 5 }) },
  ];
  it.each(failClosedCases)("$name: the successor fails closed without calling the reopen service", async ({ arrange }) => {
    const f = await archivedContinuationTarget();
    const overrides = (await arrange(f)) ?? {};
    const successor = await dispatchedContinuationRun(f, overrides);
    const before = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id)))[0];
    const svc = executionWorkspaceService(db);
    const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
    await expect(successorStep(successor, svc)).rejects.toThrow(/^Cross-task continuation could not reopen the target workspace: /);
    expect(reopen).not.toHaveBeenCalled();
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id)))[0]).toEqual(before);
    await expect(access(f.workspace.cwd!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("E5: a deleted workspace row fails closed", async () => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issue.id));
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
    const svc = executionWorkspaceService(db);
    const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
    await expect(successorStep(successor, svc)).rejects.toThrow(/^Cross-task continuation could not reopen the target workspace: /);
    expect(reopen).not.toHaveBeenCalled();
  });

  it("E6: an already active row makes no service call and leaves ordinary restore to preparation", async () => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    await db.update(executionWorkspaces).set({ status: "active", closedAt: null }).where(eq(executionWorkspaces.id, f.workspace.id));
    const svc = executionWorkspaceService(db);
    const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
    await expect(successorStep(successor, svc)).resolves.toEqual({ kind: "already_active", workspaceId: f.workspace.id });
    expect(reopen).not.toHaveBeenCalled();
  });

  it("E8: the successor still reopens after the setting is turned off", async () => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    await instanceSettingsService(db).updateExperimental({ enableCrossTaskDeferredContinuation: false });
    await expect(successorStep(successor)).resolves.toMatchObject({ kind: "reopened", reopened: true });
  });

  it.each([
    { name: "an external-provider run", externalProvider: true, hasPersistedNativeExecutionInput: false, freshIsolatedWorkspaceRequested: false },
    { name: "a same-run native resume", externalProvider: false, hasPersistedNativeExecutionInput: true, freshIsolatedWorkspaceRequested: false },
    { name: "a fresh isolated workspace request", externalProvider: false, hasPersistedNativeExecutionInput: false, freshIsolatedWorkspaceRequested: true },
  ])("E9 / E0: $name is not eligible", async (e0) => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const svc = executionWorkspaceService(db);
    const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
    await expect(reopenTargetBoundSuccessorWorkspace(db, {
      run: { id: successor.id, companyId: successor.companyId, agentId: successor.agentId, wakeupRequestId: successor.wakeupRequestId,
        issueId: successor.issueId, nativeIssueId: successor.nativeIssueId, contextSnapshot: successor.contextSnapshot as Record<string, unknown> },
      responsibleUserId: null, executionWorkspacesSvc: svc, ...e0,
    })).resolves.toEqual({ kind: "not_eligible" });
    expect(reopen).not.toHaveBeenCalled();
  });

  // V3: the step's single service call returns rebuild_failed. The kinds differ
  // in whether a rebuild call ran and whether the failure bookkeeping committed.
  async function closedRowFacts(workspaceId: string) {
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    return { status: row!.status, cleanupReason: row!.cleanupReason, cleanupEligibleAt: row!.cleanupEligibleAt,
      generation: readExecutionWorkspaceLifecycleGeneration(row!.metadata as Record<string, unknown> | null), metadata: row!.metadata };
  }
  const workspaceActivity = (action: string) => db.select().from(activityLog).where(eq(activityLog.action, action));

  it("V3-F1: a failure before any rebuild call fails the successor closed and leaves the row byte-identical", async () => {
    const f = await archivedContinuationTarget();
    await db.update(executionWorkspaces).set({ cleanupEligibleAt: new Date("2030-01-01T00:00:00Z"),
      metadata: sql`coalesce(${executionWorkspaces.metadata}, '{}'::jsonb) || '{"gitCacheRestoration":{"schema":"malformed"}}'::jsonb` })
      .where(eq(executionWorkspaces.id, f.workspace.id));
    const successor = await dispatchedContinuationRun(f);
    const before = await closedRowFacts(f.workspace.id);
    expect(before.generation).toBe(f.generation);
    const runtime = await import("../workspace-runtime.js");
    const rebuild = vi.spyOn(runtime, "ensurePersistedExecutionWorkspaceAvailable");
    await expect(successorStep(successor)).rejects.toThrow(/^Cross-task continuation could not reopen the target workspace: /);
    expect(rebuild).not.toHaveBeenCalled();
    expect(await closedRowFacts(f.workspace.id)).toEqual(before);
    expect(await workspaceActivity("execution_workspace.reopen_failed")).toHaveLength(0);
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(0);
  });

  it("V3-F3: a rebuild call that fails commits the failure bookkeeping and fails the successor closed", async () => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const runtime = await import("../workspace-runtime.js");
    const rebuild = vi.spyOn(runtime, "ensurePersistedExecutionWorkspaceAvailable").mockRejectedValueOnce(new Error("fixture rebuild failure"));
    await expect(successorStep(successor)).rejects.toThrow(/^Cross-task continuation could not reopen the target workspace: /);
    expect(rebuild).toHaveBeenCalledTimes(1);
    const after = await closedRowFacts(f.workspace.id);
    expect(after).toMatchObject({ status: "archived", cleanupEligibleAt: null, generation: f.generation + 1 });
    expect(after.cleanupReason).toBeTruthy();
    expect(await workspaceActivity("execution_workspace.reopen_failed")).toHaveLength(1);
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(0);
  });

  it("V3-F2: a rebuild call that succeeds and then loses its bookkeeping leaves the row closed at the same generation", async () => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const before = await closedRowFacts(f.workspace.id);
    const runtime = await import("../workspace-runtime.js");
    const rebuild = vi.spyOn(runtime, "ensurePersistedExecutionWorkspaceAvailable");
    const activity = await import("../activity-log.js");
    const realLogActivity = activity.logActivity;
    vi.spyOn(activity, "logActivity").mockImplementation(async (database, entry) => {
      if (entry.action === "execution_workspace.reopened") throw new Error("fixture activity failure");
      return realLogActivity(database, entry);
    });
    await expect(successorStep(successor)).rejects.toThrow(/^Cross-task continuation could not reopen the target workspace: /);
    expect(rebuild).toHaveBeenCalledTimes(1);
    const after = await closedRowFacts(f.workspace.id);
    expect({ ...after, metadata: undefined }).toEqual({ ...before, metadata: undefined });
    expect(await workspaceActivity("execution_workspace.reopen_failed")).toHaveLength(0);
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(0);
    // The rebuilt worktree is not rolled back.
    await expect(access(f.workspace.cwd!)).resolves.toBeUndefined();
  });

  // L2: an eager reopen (the same service call the comment, PATCH and checkout
  // routes make, without the fence, by a run bound to the target) races the
  // successor step. A barrier holds the first caller right after it takes the
  // lifecycle lock; rebuild calls are counted per caller.
  async function raceHarness(f: Awaited<ReturnType<typeof archivedContinuationTarget>>) {
    const caller = new AsyncLocalStorage<string>();
    const rebuilds: Record<string, number> = {};
    const runtime = await import("../workspace-runtime.js");
    const realRebuild = runtime.ensurePersistedExecutionWorkspaceAvailable;
    const failRebuildFor = new Set<string>();
    vi.spyOn(runtime, "ensurePersistedExecutionWorkspaceAvailable").mockImplementation(async (...args) => {
      const who = caller.getStore() ?? "other";
      rebuilds[who] = (rebuilds[who] ?? 0) + 1;
      if (failRebuildFor.has(who)) throw new Error("fixture rebuild failure");
      return realRebuild(...args);
    });
    const lifecycle = await import("../execution-workspace-lifecycle-lock.js");
    const realAcquire = lifecycle.acquireExecutionWorkspaceLifecycleLock;
    // Gates for the first and second lifecycle-lock acquisitions on this row.
    const gates = [0, 1].map(() => {
      let reached!: () => void;
      let release!: () => void;
      return { reached: new Promise<void>(resolve => { reached = resolve; }), onReached: () => reached(),
        released: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
    });
    let acquisitions = 0;
    let holdSecond = false;
    vi.spyOn(lifecycle, "acquireExecutionWorkspaceLifecycleLock").mockImplementation(async (tx, workspaceId) => {
      await realAcquire(tx, workspaceId);
      if (workspaceId !== f.workspace.id) return;
      const gate = gates[acquisitions++];
      if (!gate || (gate === gates[1] && !holdSecond)) return;
      gate.onReached();
      await gate.released;
    });
    const [eagerRun] = await db.insert(heartbeatRuns).values({ companyId: f.issue.companyId, agentId: f.input.agent.id,
      issueId: f.issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy",
      contextSnapshot: { issueId: f.issue.id, taskId: f.issue.id } }).returning();
    const eager = () => caller.run("eager", () => executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId: f.workspace.id, issue: { id: f.issue.id, companyId: f.issue.companyId, projectId: f.issue.projectId },
      actor: { agentId: f.input.agent.id, actorType: "agent" },
      authorizationActor: { type: "agent", agentId: f.input.agent.id, companyId: f.issue.companyId, source: "agent_jwt", runId: eagerRun!.id, onBehalfOfUserId: null },
    }));
    const step = (run: typeof heartbeatRuns.$inferSelect) => caller.run("step", () => successorStep(run).then(
      outcome => ({ outcome, error: null as Error | null }), (error: Error) => ({ outcome: null, error })));
    // Give the waiting caller time to reach its lock wait before the holder goes on.
    const settle = () => new Promise(resolve => setTimeout(resolve, 300));
    return { rebuilds, failRebuildFor, holderReached: gates[0]!.reached, release: gates[0]!.release,
      holdSecond: () => { holdSecond = true; }, secondReached: gates[1]!.reached, releaseSecond: gates[1]!.release,
      eager, step, settle };
  }
  const branchHead = async (cwd: string) => ({
    branch: (await execFile("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(),
    head: (await execFile("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim(),
  });

  it("L2a: successor first, then an eager reopen that finds the row active", async () => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const h = await raceHarness(f);
    const stepDone = h.step(successor);
    await h.holderReached;
    const eagerDone = h.eager();
    await h.settle();
    h.release();
    const [stepResult, eagerResult] = await Promise.all([stepDone, eagerDone]);
    expect(stepResult.error).toBeNull();
    expect(stepResult.outcome).toMatchObject({ kind: "reopened", reopened: true });
    expect(eagerResult).toMatchObject({ ok: true, reopened: false });
    expect(h.rebuilds).toEqual({ step: 1 });
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(1);
    expect(await closedRowFacts(f.workspace.id)).toMatchObject({ status: "active", generation: f.generation + 1 });
    expect(await branchHead(f.workspace.cwd!)).toEqual({ branch: f.workspace.branchName, head: f.headBeforeArchive });
  });

  it("L2b: eager first, then the successor finds the row active and makes no rebuild call", async () => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const h = await raceHarness(f);
    const eagerDone = h.eager();
    await h.holderReached;
    const stepDone = h.step(successor);
    await h.settle();
    h.release();
    const [eagerResult, stepResult] = await Promise.all([eagerDone, stepDone]);
    expect(eagerResult).toMatchObject({ ok: true, reopened: true });
    expect(stepResult.error).toBeNull();
    expect(stepResult.outcome).toMatchObject({ kind: "reopened", reopened: false });
    expect(h.rebuilds).toEqual({ eager: 1 });
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(1);
    expect(await closedRowFacts(f.workspace.id)).toMatchObject({ status: "active", generation: f.generation + 1 });
    expect(await branchHead(f.workspace.cwd!)).toEqual({ branch: f.workspace.branchName, head: f.headBeforeArchive });
  });

  it("L2c-F3: an eager rebuild failure with committed bookkeeping stops the waiting successor at the fence", async () => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const h = await raceHarness(f);
    h.failRebuildFor.add("eager");
    const eagerDone = h.eager();
    await h.holderReached;
    const stepDone = h.step(successor);
    await h.settle();
    h.release();
    const [eagerResult, stepResult] = await Promise.all([eagerDone, stepDone]);
    expect(eagerResult).toMatchObject({ ok: false, code: "rebuild_failed" });
    expect(stepResult.error?.message).toMatch(/^Cross-task continuation could not reopen the target workspace: Execution workspace changed after the continuation request/);
    expect(h.rebuilds).toEqual({ eager: 1 });
    expect(await workspaceActivity("execution_workspace.reopen_failed")).toHaveLength(1);
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(0);
    expect(await closedRowFacts(f.workspace.id)).toMatchObject({ status: "archived", cleanupEligibleAt: null, generation: f.generation + 1 });
    await expect(access(f.workspace.cwd!)).rejects.toMatchObject({ code: "ENOENT" });
    // A step that starts after the failure committed stops at the unlocked pre-check.
    const svc = executionWorkspaceService(db);
    const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
    await expect(successorStep(successor, svc)).rejects.toThrow(/changed after the continuation request/);
    expect(reopen).not.toHaveBeenCalled();
  });

  it.each(["activity", "update"] as const)("L2g-%s: an eager rebuild whose transaction rolls back lets the successor make the one allowed second rebuild call on the same worktree", async (fault) => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const h = await raceHarness(f);
    if (fault === "activity") {
      const activity = await import("../activity-log.js");
      const realLogActivity = activity.logActivity;
      let failed = false;
      vi.spyOn(activity, "logActivity").mockImplementation(async (database, entry) => {
        if (!failed && entry.action === "execution_workspace.reopened") { failed = true; throw new Error("fixture activity failure"); }
        return realLogActivity(database, entry);
      });
    } else {
      // Fails the first update that publishes this row as active. A sequence is
      // not rolled back, so only the eager call's update fails.
      await db.execute(sql.raw(`create sequence if not exists l2g_fault_seq;
        select setval('l2g_fault_seq', 1, false);
        create or replace function l2g_fault() returns trigger language plpgsql as $$
        begin
          if new.id = '${f.workspace.id}' and new.status = 'active' and old.status <> 'active' and nextval('l2g_fault_seq') = 1 then
            raise exception 'fixture update failure';
          end if;
          return new;
        end $$;
        drop trigger if exists l2g_fault on execution_workspaces;
        create trigger l2g_fault before update on execution_workspaces for each row execute function l2g_fault();`));
    }
    try {
      h.holdSecond();
      const eagerDone = h.eager();
      await h.holderReached;
      const stepDone = h.step(successor);
      await h.settle();
      h.release();
      const eagerResult = await eagerDone;
      // The step now holds the lifecycle lock and waits at the second gate.
      expect(eagerResult).toMatchObject({ ok: false, code: "rebuild_failed" });
      // After the eager call: the row is unchanged at g and the rebuilt worktree stays on disk.
      expect(await closedRowFacts(f.workspace.id)).toMatchObject({ status: "archived", generation: f.generation });
      expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(0);
      expect(await workspaceActivity("execution_workspace.reopen_failed")).toHaveLength(0);
      const inodeAfterEager = (await stat(f.workspace.cwd!)).ino;
      await h.secondReached;
      h.releaseSecond();
      const stepResult = await stepDone;
      expect(stepResult.error).toBeNull();
      expect(stepResult.outcome).toMatchObject({ kind: "reopened", reopened: true });
      expect(h.rebuilds).toEqual({ eager: 1, step: 1 });
      expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(1);
      expect(await workspaceActivity("execution_workspace.reopen_failed")).toHaveLength(0);
      expect(await closedRowFacts(f.workspace.id)).toMatchObject({ status: "active", generation: f.generation + 1 });
      expect((await stat(f.workspace.cwd!)).ino).toBe(inodeAfterEager);
      expect(await branchHead(f.workspace.cwd!)).toEqual({ branch: f.workspace.branchName, head: f.headBeforeArchive });
    } finally {
      if (fault === "update") await db.execute(sql.raw("drop trigger if exists l2g_fault on execution_workspaces"));
    }
  });

  it("L2c-F1: an eager call and the successor that both fail before any rebuild call leave the row unchanged", async () => {
    const f = await archivedContinuationTarget();
    await db.update(executionWorkspaces).set({
      metadata: sql`coalesce(${executionWorkspaces.metadata}, '{}'::jsonb) || '{"gitCacheRestoration":{"schema":"malformed"}}'::jsonb` })
      .where(eq(executionWorkspaces.id, f.workspace.id));
    const successor = await dispatchedContinuationRun(f);
    const before = await closedRowFacts(f.workspace.id);
    const h = await raceHarness(f);
    await expect(h.eager()).resolves.toMatchObject({ ok: false, code: "rebuild_failed" });
    const stepResult = await h.step(successor);
    expect(stepResult.error?.message).toMatch(/^Cross-task continuation could not reopen the target workspace: /);
    expect(h.rebuilds).toEqual({});
    expect(await closedRowFacts(f.workspace.id)).toEqual(before);
    expect(await workspaceActivity("execution_workspace.reopen_failed")).toHaveLength(0);
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(0);
    await expect(access(f.workspace.cwd!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["null", "other workspace"] as const)("L2d: a rebind to %s while the successor holds the lifecycle lock gives not_reopenable with no writes", async (rebind) => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const [other] = rebind === "other workspace" ? await db.insert(executionWorkspaces).values({
      companyId: f.issue.companyId, projectId: f.issue.projectId, sourceIssueId: f.issue.id, mode: "isolated_workspace",
      strategyType: "git_worktree", name: "Other workspace", status: "archived", providerType: f.workspace.providerType,
    }).returning() : [null];
    const before = await closedRowFacts(f.workspace.id);
    const otherBefore = other ? await closedRowFacts(other.id) : null;
    const h = await raceHarness(f);
    const stepDone = h.step(successor);
    await h.holderReached;
    await db.update(issues).set({ executionWorkspaceId: other?.id ?? null }).where(eq(issues.id, f.issue.id));
    h.release();
    const stepResult = await stepDone;
    expect(stepResult.error?.message).toMatch(/^Cross-task continuation could not reopen the target workspace: Execution workspace is not reopenable/);
    expect(h.rebuilds).toEqual({});
    expect(await closedRowFacts(f.workspace.id)).toEqual(before);
    if (other) expect(await closedRowFacts(other.id)).toEqual(otherBefore);
    expect((await readIssue(f.issue.id)).executionWorkspaceId).toBe(other?.id ?? null);
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(0);
  });

  it("E7 in-lock: a generation change while the successor holds the lifecycle lock is caught by the fence", async () => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const h = await raceHarness(f);
    const stepDone = h.step(successor);
    await h.holderReached;
    await db.update(executionWorkspaces).set({
      metadata: sql`jsonb_set(coalesce(${executionWorkspaces.metadata}, '{}'::jsonb), '{lifecycleGeneration}', to_jsonb(${f.generation + 1}::int))` })
      .where(eq(executionWorkspaces.id, f.workspace.id));
    const changed = await closedRowFacts(f.workspace.id);
    h.release();
    const stepResult = await stepDone;
    expect(stepResult.error?.message).toMatch(/^Cross-task continuation could not reopen the target workspace: Execution workspace changed after the continuation request/);
    expect(h.rebuilds).toEqual({});
    expect(await closedRowFacts(f.workspace.id)).toEqual(changed);
  });

  it("keeps the admitted recovery workspace when the issue now points elsewhere", async () => {
    const { input, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, first.persistedExecutionWorkspace!);
    await db.update(issues).set({ executionWorkspaceId: null, projectWorkspaceId: null }).where(eq(issues.id, issue.id));
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: null, projectWorkspaceId: null };
    input.reuse.nativeRecoveryExecutionWorkspaceId = first.persistedExecutionWorkspace!.id;
    await persistRecoveryInput(input, first.persistedExecutionWorkspace!.id, first.executionWorkspace.cwd);
    const anchor = vi.spyOn(input.services, "resolveReusedGitWorkspaceAnchor");
    const prepareRepositories = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission");
    const reserveRoot = vi.spyOn(input.services.executionWorkspacesSvc, "assertTaskRepositoryRecoveryBinding");
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(reserveRoot).toHaveBeenCalledWith({ companyId: issue.companyId, issueId: issue.id,
      workspaceId: first.persistedExecutionWorkspace!.id, cwd: first.executionWorkspace.cwd,
      agentId: input.agent.id, runId: input.run.id });
    expect(prepareRepositories).not.toHaveBeenCalled();
    expect(next.persistedExecutionWorkspace!.id).toBe(first.persistedExecutionWorkspace!.id);
    expect(anchor).toHaveBeenCalledWith(expect.objectContaining({ immutableNativeBinding: true, explicitProjectWorkspaceId: first.persistedExecutionWorkspace!.projectWorkspaceId }));
    expect(await readIssue(issue.id)).toMatchObject({ executionWorkspaceId: null, projectWorkspaceId: null });
  });

  it.each([
    { transport: "local", descriptor: "absent" },
    { transport: "ssh", descriptor: "absent" },
    { transport: "task", descriptor: "absent" },
    { transport: "daytona", descriptor: "valid" },
    { transport: "daytona", descriptor: "absent" },
    { transport: "daytona", descriptor: "corrupt" },
  ] as const)("validates the admitted host binding for $transport recovery with $descriptor descriptor", async ({ transport, descriptor }) => {
    const { input, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, first.persistedExecutionWorkspace!);
    await db.update(issues).set({ executionWorkspaceId: null, projectWorkspaceId: null }).where(eq(issues.id, issue.id));
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: null, projectWorkspaceId: null };
    input.reuse.nativeRecoveryExecutionWorkspaceId = first.persistedExecutionWorkspace!.id;
    const admittedRoot = join(home, `admitted-${input.run.id}`);
    await mkdir(admittedRoot);
    const remoteCwd = "/remote/admitted-task";
    await persistRecoveryInput(input, first.persistedExecutionWorkspace!.id, transport === "local" ? admittedRoot : remoteCwd);
    const target: AdapterExecutionTarget = transport === "local" ? { kind: "local" }
      : transport === "ssh" ? { kind: "remote", transport: "ssh", remoteCwd,
        spec: { host: "fixture.invalid", port: 22, username: "fixture", remoteWorkspacePath: remoteCwd,
          privateKey: null, knownHosts: null, strictHostKeyChecking: true, remoteCwd } }
      : { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd,
          ...(transport === "task" ? { runnerTask: vi.fn() } : {}) };
    const realize = input.services.envOrchestrator.realizeForRun;
    vi.spyOn(input.services.envOrchestrator, "realizeForRun").mockImplementation(async args => ({
      ...await realize(args), executionTarget: target,
    }));
    if (descriptor !== "absent") {
      const baseline = await captureDirectorySnapshot(admittedRoot);
      const reference = await nativeWorkspaceSyncInternals.writeDescriptor({
        schema: "paperclip.native-workspace-sync/v1", state: "prepared",
        binding: { companyId: issue.companyId, runId: input.run.id, workspaceId: first.persistedExecutionWorkspace!.id,
          leaseId: "admitted-lease", providerLeaseId: "admitted-provider", localCwd: admittedRoot, remoteCwd },
        baseline: serializeDirectorySnapshot(baseline), baselineSha256: directorySnapshotSha256(baseline),
        gitSnapshot: null, seed: null, createdAt: new Date().toISOString(), finalizedAt: null, finalHostSha256: null, resourceDisposition: null,
      });
      input.run.runnerProfileJson = { ...input.run.runnerProfileJson, nativeWorkspaceSync: reference };
      await db.update(heartbeatRuns).set({ runnerProfileJson: input.run.runnerProfileJson }).where(eq(heartbeatRuns.id, input.run.id));
      if (descriptor === "corrupt") {
        await writeFile(nativeWorkspaceSyncInternals.descriptorPath(input.run.id, reference.descriptorSha256), "{}");
      }
    }
    const reserve = vi.spyOn(input.services.executionWorkspacesSvc, "assertTaskRepositoryRecoveryBinding");
    const prepare = vi.spyOn(input.services.executionWorkspacesSvc, "prepareTaskRepositoriesForAdmission");
    if (transport !== "daytona" || descriptor === "valid") {
      const result = await prepareHeartbeatWorkspace(db, input);
      expect(result.executionTarget).toEqual(target);
      if (transport === "ssh" || transport === "task") expect(reserve).not.toHaveBeenCalled();
      else expect(reserve).toHaveBeenCalledWith({ companyId: issue.companyId, issueId: issue.id,
        workspaceId: first.persistedExecutionWorkspace!.id, cwd: admittedRoot, agentId: input.agent.id, runId: input.run.id });
      if (transport !== "daytona") {
        await expect(prepareNativeWorkspaceSync({ db, runId: input.run.id, companyId: issue.companyId,
          workspaceId: first.persistedExecutionWorkspace!.id, workspaceLocalDir: first.executionWorkspace.cwd,
          target, lease: result.activeEnvironmentLease.lease })).resolves.toBeNull();
      }
      expect(admittedRoot).not.toBe(first.executionWorkspace.cwd);
    } else {
      await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow(descriptor === "absent"
        ? "native_workspace_sync_descriptor_binding_missing" : "native_workspace_sync_descriptor_digest_mismatch");
      expect(reserve).not.toHaveBeenCalled();
      expect(await leases(input.run.id)).toMatchObject([{ status: "active" }]);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect((await readIssue(issue.id)).executionWorkspaceId).toBeNull();
  });

  it("removes a newly created worktree when persistence fails and preserves the original error", async () => {
    const { input, source } = await fixture(true);
    const error = new Error("workspace persistence unavailable");
    let createdCwd = "";
    vi.spyOn(input.services.executionWorkspacesSvc, "create").mockImplementation(async args => { createdCwd = args.cwd!; throw error; });
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(error);
    expect(createdCwd).not.toBe("");
    await expect(access(createdCwd)).rejects.toThrow();
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("source content\n");
    expect(await leases(input.run.id)).toHaveLength(0);
  });

  it("preserves a reused worktree when its metadata update fails", async () => {
    const { input } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, first.persistedExecutionWorkspace!);
    await writeFile(join(first.executionWorkspace.cwd, "retained.txt"), "unsaved work");
    const error = new Error("workspace update unavailable");
    vi.spyOn(input.services.executionWorkspacesSvc, "update").mockRejectedValueOnce(error);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(error);
    expect(await readFile(join(first.executionWorkspace.cwd, "retained.txt"), "utf8")).toBe("unsaved work");
    expect(await leases(input.run.id)).toHaveLength(0);
  });

  it.each(["acquire", "realize", "ownership"] as const)("preserves %s errors and durable lease state for outer cleanup", async failure => {
    const { input, envOrchestrator } = await fixture();
    const error = new Error(`${failure} failed`);
    if (failure === "acquire") vi.spyOn(envOrchestrator, "acquireForRun").mockRejectedValueOnce(error);
    if (failure === "realize") vi.spyOn(envOrchestrator, "realizeForRun").mockRejectedValueOnce(error);
    if (failure === "ownership") vi.mocked(input.controllerLease.assertOwned).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(error);
    expect(input.nativeRunnerPreparationSpans.at(-1)).toMatchObject({ name: failure === "realize" ? "environment.workspace.realize" : "environment.acquire", outcome: "failed" });
    expect((await readRun(input.run.id)).status).toBe("running");
    expect(await leases(input.run.id)).toHaveLength(failure === "acquire" ? 0 : 1);
    if (failure !== "acquire") {
      expect(await leases(input.run.id)).toMatchObject([{ status: "active" }]);
      // The production executor terminalizes first, then releases by durable run ID.
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, input.run.id));
      await envOrchestrator.releaseForRun({ heartbeatRunId: input.run.id, companyId: input.run.companyId, agentId: input.agent.id, status: "released" });
      expect(await leases(input.run.id)).toMatchObject([{ status: "released" }]);
    }
  });

  it("checks the acquired environment allowlist before realization", async () => {
    const { input, envOrchestrator } = await fixture();
    input.policy.executionPolicy = { managedSandboxOnly: true };
    const realize = vi.spyOn(envOrchestrator, "realizeForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("forbids local execution");
    expect(realize).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toMatchObject([{ status: "active" }]);
  });

  it("rejects low-trust local execution before resolving or provisioning a workspace", async () => {
    const { input } = await fixture(true);
    input.policy.trustPreset = {
      kind: "low_trust_review", preset: "low_trust_review", sourcePresets: {},
      boundary: { mode: "low_trust_review", companyId: input.agent.companyId, rootIssueId: input.task.issueId! },
    };
    const resolve = vi.spyOn(input.services, "resolveWorkspaceForRun");
    const create = vi.spyOn(input.services.executionWorkspacesSvc, "create");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("requires a sandbox environment");
    expect(resolve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toHaveLength(0);
  });

  it("rejects remote recovery without its retained sync binding before acquiring a lease", async () => {
    const { input, envOrchestrator } = await fixture();
    input.reuse.runOptions.nativeRestartRecovery = {
      kind: "reattach_remote_runner", runId: input.run.id, leaseOwner: "controller",
      controllerGeneration: 1, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null,
      remote: { providerLeaseId: "original-provider-lease", remoteCwd: "/original" },
    };
    const acquire = vi.spyOn(envOrchestrator, "acquireForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("native_remote_recovery_lease_mismatch");
    expect(acquire).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toHaveLength(0);
    expect(input.nativeRunnerPreparationSpans).toMatchObject([{ name: "environment.acquire", outcome: "failed" }]);
  });

  it("binds a replacement workspace from realization and snapshots the restore lease", async () => {
    const { input, envOrchestrator, issue } = await fixture();
    const realize = envOrchestrator.realizeForRun;
    vi.spyOn(envOrchestrator, "realizeForRun").mockImplementation(async args => {
      const result = await realize(args);
      const workspace = await input.services.executionWorkspacesSvc.create({ companyId: issue.companyId, projectId: issue.projectId!, projectWorkspaceId: issue.projectWorkspaceId, sourceIssueId: issue.id, name: "Realized workspace", mode: "shared_workspace", strategyType: "project_primary", cwd: args.executionWorkspace.cwd });
      return { ...result, persistedExecutionWorkspace: workspace, lease: { ...result.lease, metadata: { remoteCwd: "/original" } } };
    });
    const result = await prepareHeartbeatWorkspace(db, input);
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(result.persistedExecutionWorkspace!.id);
    expect(result.persistedExecutionWorkspace!.name).toBe("Realized workspace");
    result.activeEnvironmentLease.lease.metadata!.remoteCwd = "/rebound";
    expect(result.workspaceRestoreSource.metadata?.remoteCwd).toBe("/original");
  });
});
