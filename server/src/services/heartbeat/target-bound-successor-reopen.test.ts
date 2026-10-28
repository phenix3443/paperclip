import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { captureDirectorySnapshot, directorySnapshotSha256, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { activityLog, agentWakeupRequests, agents, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, executionWorkspaces, executionWorkspaceRepositoryAccess, heartbeatRuns, issues, issueAccessGrants, plugins, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import { environmentService } from "../environments.js";
import { executionWorkspaceService, readExecutionWorkspaceLifecycleGeneration, toExecutionWorkspace } from "../execution-workspaces.js";
import { CROSS_TASK_CONTINUATION_COMMITTER_ID, crossTaskContinuationDispatchKey, crossTaskContinuationIntentKey } from "../cross-task-continuation.js";
import { reopenTargetBoundSuccessorWorkspace } from "./target-bound-successor-reopen.js";
import { crossTaskContinuationTestHooks, issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";
import { instanceSettingsService } from "../instance-settings.js";
import { heartbeatService } from "../heartbeat.js";
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

describe.skipIf(!support.supported)("target-bound successor workspace reopen", () => {
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

  const readIssue = (id: string) => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);
  const readRun = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  const leases = (id: string) => db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, id));

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

  function successorStep(run: typeof heartbeatRuns.$inferSelect, executionWorkspacesSvc = executionWorkspaceService(db), responsibleUserId: string | null = null) {
    return reopenTargetBoundSuccessorWorkspace(db, {
      run: { id: run.id, companyId: run.companyId, agentId: run.agentId, wakeupRequestId: run.wakeupRequestId,
        issueId: run.issueId, nativeIssueId: run.nativeIssueId, contextSnapshot: run.contextSnapshot as Record<string, unknown> },
      responsibleUserId, externalProvider: false, hasPersistedNativeExecutionInput: false,
      freshIsolatedWorkspaceRequested: false, executionWorkspacesSvc,
    });
  }

  it("R2-P / E1: a run that is not the dispatch of a committed intent does not reopen, and preparation fails as before", async () => {
    const f = await archivedContinuationTarget();
    const reuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: f.target.executionWorkspaceId,
      issueExecutionWorkspacePreference: f.target.executionWorkspacePreference, existingExecutionWorkspaceStatus: f.workspace.status });
    expect(reuseRequest).toEqual({ requestedExecutionWorkspaceId: f.workspace.id, requestedShouldReuseExisting: true, existingExecutionWorkspaceAvailable: false });
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
    await expect(access(f.workspace.cwd!)).resolves.toBeUndefined();
  });

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
      expect(eagerResult).toMatchObject({ ok: false, code: "rebuild_failed" });
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

  async function eagerReopen(f: Awaited<ReturnType<typeof archivedContinuationTarget>>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.issue.companyId, agentId: f.input.agent.id,
      issueId: f.issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy",
      contextSnapshot: { issueId: f.issue.id, taskId: f.issue.id } }).returning();
    return executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId: f.workspace.id, issue: { id: f.issue.id, companyId: f.issue.companyId, projectId: f.issue.projectId },
      actor: { agentId: f.input.agent.id, actorType: "agent" },
      authorizationActor: { type: "agent", agentId: f.input.agent.id, companyId: f.issue.companyId, source: "agent_jwt", runId: run!.id, onBehalfOfUserId: null },
    });
  }

  it.each(["F1", "F2", "F3"] as const)("V3-repair after %s: fixing the cause and reopening eagerly restores the row", async (kind) => {
    const f = await archivedContinuationTarget();
    const successor = await dispatchedContinuationRun(f);
    const runtime = await import("../workspace-runtime.js");
    const activity = await import("../activity-log.js");
    const realLogActivity = activity.logActivity;
    if (kind === "F1") {
      await db.update(executionWorkspaces).set({
        metadata: sql`coalesce(${executionWorkspaces.metadata}, '{}'::jsonb) || '{"gitCacheRestoration":{"schema":"malformed"}}'::jsonb` })
        .where(eq(executionWorkspaces.id, f.workspace.id));
    } else if (kind === "F3") {
      vi.spyOn(runtime, "ensurePersistedExecutionWorkspaceAvailable").mockRejectedValueOnce(new Error("fixture rebuild failure"));
    } else {
      vi.spyOn(activity, "logActivity").mockImplementationOnce(async (database, entry) => {
        if (entry.action === "execution_workspace.reopened") throw new Error("fixture activity failure");
        return realLogActivity(database, entry);
      });
    }
    await expect(successorStep(successor)).rejects.toThrow(/^Cross-task continuation could not reopen the target workspace: /);
    const failedGeneration = (await closedRowFacts(f.workspace.id)).generation;
    expect(failedGeneration).toBe(kind === "F3" ? f.generation + 1 : f.generation);
    const inodeAfterFailure = kind === "F2" ? (await stat(f.workspace.cwd!)).ino : null;
    vi.restoreAllMocks();
    if (kind === "F1") {
      await db.update(executionWorkspaces).set({ metadata: sql`${executionWorkspaces.metadata} - 'gitCacheRestoration'` })
        .where(eq(executionWorkspaces.id, f.workspace.id));
    }
    const repaired = await eagerReopen(f);
    expect(repaired).toMatchObject({ ok: true, reopened: true, generation: failedGeneration + 1 });
    expect(await closedRowFacts(f.workspace.id)).toMatchObject({ status: "active", generation: failedGeneration + 1 });
    if (inodeAfterFailure !== null) expect((await stat(f.workspace.cwd!)).ino).toBe(inodeAfterFailure);
    expect(await branchHead(f.workspace.cwd!)).toEqual({ branch: f.workspace.branchName, head: f.headBeforeArchive });
  });

  async function crossTaskRoute(f: Awaited<ReturnType<typeof archivedContinuationTarget>>) {
    await db.execute(sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) values ('k5-user', 'K5', 'k5@example.test', true, now(), now()) on conflict do nothing`);
    await db.insert(companyMemberships).values({ companyId: f.issue.companyId, principalType: "user", principalId: "k5-user", status: "active", membershipRole: "member" });
    await db.update(issues).set({ status: "done", responsibleUserId: "k5-user" }).where(eq(issues.id, f.issue.id));
    f.workspace = (await executionWorkspaceService(db).getStoredById(f.issue.companyId, f.workspace.id))!;
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.input.agent.id));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.agentId, f.input.agent.id));
    const [source] = await db.insert(issues).values({ companyId: f.issue.companyId, title: "Source task", identifier: "WSP-2",
      projectId: f.issue.projectId, status: "in_progress", assigneeAgentId: f.input.agent.id }).returning();
    const [sourceRun] = await db.insert(heartbeatRuns).values({ companyId: f.issue.companyId, agentId: f.input.agent.id,
      status: "running", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: source!.id, taskId: source!.id } }).returning();
    await instanceSettingsService(db).updateExperimental({ enableCrossTaskDeferredContinuation: true });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: f.input.agent.id, companyId: f.issue.companyId, runId: sourceRun!.id, source: "agent_key" } as never;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    const post = () => request(app).post(`/api/issues/${f.issue.id}/comments`)
      .send({ body: "Child finished, please continue", resume: true, clientRequestId: randomUUID() });
    const successorRun = async () => {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.input.agent.id));
      return runs.filter(run => run.id !== sourceRun!.id && run.status === "queued");
    };
    return { post, successorRun, sourceRun: sourceRun! };
  }

  it("K5: the real route and consumer dispatch one target-bound successor whose step reopens the workspace and whose preparation reuses it", async () => {
    const f = await archivedContinuationTarget();
    const route = await crossTaskRoute(f);
    const res = await route.post();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await closedRowFacts(f.workspace.id)).toMatchObject({ status: "archived", generation: f.generation });
    const intents = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.requestedByActorId, CROSS_TASK_CONTINUATION_COMMITTER_ID));
    expect(intents).toHaveLength(1);
    expect(intents[0]!.idempotencyKey).toMatch(/^issue_cross_task_continuation:/);
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, crossTaskContinuationDispatchKey(intents[0]!.id)));
    expect(receipts).toHaveLength(1);
    const [successor, ...others] = await route.successorRun();
    expect(others).toHaveLength(0);
    expect(successor).toMatchObject({ wakeupRequestId: receipts[0]!.id, contextSnapshot: { issueId: f.issue.id } });
    expect(intents[0]).toMatchObject({ status: "coalesced", runId: successor!.id });
    await expect(successorStep(successor!, executionWorkspaceService(db), "k5-user")).resolves.toMatchObject({ kind: "reopened", reopened: true, generation: f.generation + 1 });
    const active = (await executionWorkspaceService(db).getStoredById(f.issue.companyId, f.workspace.id))!;
    f.input.run = successor!;
    f.input.task.responsibleUserId = "k5-user";
    f.input.task.issueRef = await readIssue(f.issue.id);
    f.input.reuse.requestedShouldReuseExisting = true;
    f.input.reuse.existingExecutionWorkspace = active;
    f.input.reuse.reusableExistingExecutionWorkspace = active;
    f.input.reuse.workspaceReuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: f.workspace.id,
      issueExecutionWorkspacePreference: "reuse_existing", existingExecutionWorkspaceStatus: active.status });
    const prepared = await prepareHeartbeatWorkspace(db, f.input);
    expect(prepared.persistedExecutionWorkspace!.id).toBe(f.workspace.id);
    expect(await branchHead(f.workspace.cwd!)).toEqual({ branch: f.workspace.branchName, head: f.headBeforeArchive });
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(1);
  });

  it("L2e: an eager reopen waiting behind the deferred route transaction reopens after the commit, and the successor then makes no service call", async () => {
    const f = await archivedContinuationTarget();
    const route = await crossTaskRoute(f);
    const h = await raceHarness(f);
    let releaseRoute!: () => void;
    const routeHeld = new Promise<void>(resolve => { releaseRoute = resolve; });
    let routeReached!: () => void;
    const routeAtCommit = new Promise<void>(resolve => { routeReached = resolve; });
    crossTaskContinuationTestHooks.beforeCommit = async () => { routeReached(); await routeHeld; };
    const responseDone = route.post().then(res => res);
    await h.holderReached;
    h.release();
    await routeAtCommit;
    const eagerDone = h.eager();
    await h.settle();
    releaseRoute();
    const res = await responseDone;
    crossTaskContinuationTestHooks.beforeCommit = undefined;
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expect(eagerDone).resolves.toMatchObject({ ok: true, reopened: true });
    expect(h.rebuilds).toEqual({ eager: 1 });
    const [successor] = await route.successorRun();
    const svc = executionWorkspaceService(db);
    const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
    await expect(successorStep(successor!, svc, "k5-user")).resolves.toEqual({ kind: "already_active", workspaceId: f.workspace.id });
    expect(reopen).not.toHaveBeenCalled();
    expect(await closedRowFacts(f.workspace.id)).toMatchObject({ status: "active", generation: f.generation + 1 });
  });

  it.each(["L2f-1", "L2f-2"] as const)("%s: while a target-bound run holds execution, the intent still gets exactly one run", async (variant) => {
    const f = await archivedContinuationTarget();
    const route = await crossTaskRoute(f);
    const [holding] = await db.insert(heartbeatRuns).values({ companyId: f.issue.companyId, agentId: f.input.agent.id,
      issueId: f.issue.id, scopeKind: "issue", status: "running", invocationSource: "assignment", triggerDetail: "system",
      responsibleUserId: "k5-user", contextSnapshot: { issueId: f.issue.id, taskId: f.issue.id } }).returning();
    crossTaskContinuationTestHooks.beforeCommit = async (tx) => {
      await tx.update(issues).set({ executionRunId: holding!.id, executionLockedAt: new Date() }).where(eq(issues.id, f.issue.id));
    };
    const res = await route.post().then(r => r, e => { throw e; });
    crossTaskContinuationTestHooks.beforeCommit = undefined;
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const heartbeat = heartbeatService(db);
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.issue.companyId });
    const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.requestedByActorId, CROSS_TASK_CONTINUATION_COMMITTER_ID));
    const dispatchKey = crossTaskContinuationDispatchKey(intent!.id);
    const deferred = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, dispatchKey));
    expect(deferred).toHaveLength(1);
    expect(["queued", "deferred_issue_execution"]).toContain(deferred[0]!.status);
    if (variant === "L2f-2") {
      const eager = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({
        workspaceId: f.workspace.id, issue: { id: f.issue.id, companyId: f.issue.companyId, projectId: f.issue.projectId },
        actor: { agentId: f.input.agent.id, actorType: "agent" },
        authorizationActor: { type: "agent", agentId: f.input.agent.id, companyId: f.issue.companyId, source: "agent_jwt", runId: holding!.id, onBehalfOfUserId: "k5-user" },
      });
      expect(eager).toMatchObject({ ok: true, reopened: true });
    }
    await heartbeat.cancelRun(holding!.id, "fixture holding run ends");
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.issue.companyId });
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, dispatchKey));
    expect(receipts).toHaveLength(1);
    const promoted = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, receipts[0]!.id)));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.contextSnapshot).toMatchObject({ issueId: f.issue.id });
    const svc = executionWorkspaceService(db);
    const reopen = vi.spyOn(svc, "reopenClosedIsolatedExecutionWorkspaceForIssue");
    const outcome = await successorStep(promoted[0]!, svc, "k5-user");
    if (variant === "L2f-1") {
      expect(outcome).toMatchObject({ kind: "reopened", reopened: true, generation: f.generation + 1 });
      expect(reopen).toHaveBeenCalledTimes(1);
    } else {
      expect(outcome).toEqual({ kind: "already_active", workspaceId: f.workspace.id });
      expect(reopen).not.toHaveBeenCalled();
    }
    expect(await closedRowFacts(f.workspace.id)).toMatchObject({ status: "active", generation: f.generation + 1 });
    expect(await workspaceActivity("execution_workspace.reopened")).toHaveLength(1);
    expect(await branchHead(f.workspace.cwd!)).toEqual({ branch: f.workspace.branchName, head: f.headBeforeArchive });
  });

});
