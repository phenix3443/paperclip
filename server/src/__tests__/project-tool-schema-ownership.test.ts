import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectToolInputSchema, createProjectToolInputJsonSchema,
  githubReviewAssessmentSchema, githubReviewAssessmentInputJsonSchema,
  setAgentAvatarSchema, setAgentAvatarInputJsonSchema,
} from "@paperclipai/shared";
import { projectToolDefinitions } from "../services/project-tools.js";
import { callProjectTool } from "../services/project-tools.js";
import { projectToolRoutes } from "../routes/project-tools.js";
import { projectToolContext } from "../services/project-tool-context.js";
import { logger } from "../middleware/logger.js";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
vi.mock("../services/project-tool-context.js", () => ({ projectToolContext: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
const faults = vi.hoisted(() => new Set<string>());
vi.mock("../vendor/paperclip-runner/index.js", async importOriginal => {
  const original = await importOriginal<typeof import("../vendor/paperclip-runner/index.js")>();
  return { ...original, CAPABILITY_SEMANTIC_TOOL_CATALOG: original.CAPABILITY_SEMANTIC_TOOL_CATALOG.map(tool =>
    new Proxy({ ...tool }, { get(target, key, receiver) {
      if (key === "description" && faults.has(target.operationId)) throw new Error("private provider detail");
      return Reflect.get(target, key, receiver);
    } }),
  ) };
});

afterEach(() => { faults.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("project tool input contract", () => {
  it("publishes the same required idempotency bounds that execution validates", () => {
    const schema = createProjectToolInputJsonSchema();
    expect(schema.required).toContain("idempotencyKey");
    expect(schema.properties?.idempotencyKey).toMatchObject({ type: "string", minLength: 1, maxLength: 255 });
    for (const idempotencyKey of [undefined, "", "a".repeat(256)]) {
      expect(createProjectToolInputSchema.safeParse({ name: "Project", idempotencyKey }).success).toBe(false);
    }
    for (const idempotencyKey of ["a", "a".repeat(255)]) {
      expect(createProjectToolInputSchema.safeParse({ name: "Project", idempotencyKey }).success).toBe(true);
    }
  });

  it("protects the cached schema from consumer mutations", () => {
    createProjectToolInputJsonSchema().required?.splice(0);
    expect(createProjectToolInputJsonSchema().required).toContain("idempotencyKey");
  });

  it("preserves nested assessment bounds and input validation", () => {
    const schema = githubReviewAssessmentInputJsonSchema();
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.properties?.summary).toMatchObject({ maxLength: 24000 });
    expect(schema.properties?.findings).toMatchObject({ type: "array", maxItems: 300 });
    const input = { reviewedCommit: "a".repeat(40), score: 5, complete: true, summary: "Review", rationale: "Evidence",
      coverage: { reviewedPaths: ["file.ts"], omittedPaths: [], limitations: [] }, findings: [] };
    expect(githubReviewAssessmentSchema.safeParse(input).success).toBe(true);
    expect(githubReviewAssessmentSchema.safeParse({ ...input, coverage: { ...input.coverage, reviewedPaths: [] } }).success).toBe(false);
    expect(githubReviewAssessmentSchema.safeParse({ ...input, extra: true }).success).toBe(false);
    schema.required?.splice(0);
    expect(githubReviewAssessmentInputJsonSchema().required).toContain("coverage");
  });

  it("preserves nullable, bounded, strict avatar inputs", () => {
    const schema = setAgentAvatarInputJsonSchema();
    expect(schema).toMatchObject({ additionalProperties: false, required: ["imageBase64"] });
    expect(setAgentAvatarSchema.safeParse({ imageBase64: null }).success).toBe(true);
    expect(setAgentAvatarSchema.safeParse({ imageBase64: "YQ==" }).success).toBe(true);
    for (const input of [{}, { imageBase64: "https://example.test/avatar" }, { imageBase64: null, extra: true }]) {
      expect(setAgentAvatarSchema.safeParse(input).success).toBe(false);
    }
  });

  it.each([1, 2, 5])("isolates %i failed definitions and retries on the next discovery", (count) => {
    const available = projectToolDefinitions("standard", true).map(tool => tool.name);
    const broken = available.slice(0, count);
    broken.forEach(name => faults.add(name));
    expect(() => projectToolDefinitions("standard", true)).toThrow("private provider detail");
    const warning = vi.fn();
    expect(projectToolDefinitions("standard", true, warning).map(tool => tool.name))
      .toEqual(available.filter(name => !broken.includes(name)));
    expect(warning.mock.calls.map(call => call[0])).toEqual(broken);
    faults.clear();
    expect(projectToolDefinitions("standard", true).map(tool => tool.name)).toEqual(available);
  });

  it("does not suppress a failing discovery error handler", () => {
    faults.add("create_project");
    expect(() => projectToolDefinitions("standard", true, () => { throw new Error("warning sink unavailable"); }))
      .toThrow("warning sink unavailable");
  });

  it.each(["standard", "planning", "conversation", "ask"])("keeps %s tool visibility with and without task context", mode => {
    for (const task of [false, true]) {
      const tools = projectToolDefinitions(mode, task).map(tool => tool.name);
      expect(tools.includes("create_project")).toBe(mode === "standard");
      expect(tools.includes("create_task")).toBe(mode === "standard" && task);
      expect(tools.includes("set_task_title")).toBe(task && mode !== "conversation");
    }
  });
});

describe("degraded project tool transport", () => {
  function app(mode = "standard", companyId = "company") {
    vi.mocked(projectToolContext).mockResolvedValue({ run: { companyId: "company", agentId: "agent" }, issue: { id: "issue", workMode: mode } } as Awaited<ReturnType<typeof projectToolContext>>);
    const app = express();
    app.use(express.json(), (req, _res, next) => { Object.assign(req, { actor: { type: "agent", companyId } }); next(); });
    app.use(projectToolRoutes({} as Db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    return app;
  }
  const call = (app: express.Express, name: string, args = {}) => request(app).post("/mcp/project-tools")
    .set("authorization", "Bearer fixture-token").send({ id: 1, method: "tools/call", params: { name, arguments: args } });

  it("returns partial JSON-RPC tools and a safe warning, while denying an omitted tool", async () => {
    faults.add("create_project");
    const target = app();
    const response = await request(target).post("/mcp/project-tools").send({ id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(response.body.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("create_project");
    expect(logger.warn).toHaveBeenCalledWith({ tool: "create_project", workMode: "standard" }, expect.stringContaining("degraded"));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("private provider detail");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await call(target, "create_project")).body.result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves company denials before discovery", async () => {
    faults.add("create_project");
    const response = await request(app("standard", "other")).post("/mcp/project-tools").send({ method: "tools/list" });
    expect(response.status).toBe(403);
  });

  it("preserves mode, argument and downstream permission failures", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "Permission denied" }, { status: 403 }));
    vi.stubGlobal("fetch", fetch); vi.stubEnv("PAPERCLIP_API_URL", "http://fixture.test");
    expect((await call(app("planning"), "create_project", { name: "Project", idempotencyKey: "key" })).body.result.isError).toBe(true);
    expect((await call(app(), "create_project", { name: "Project" })).body.result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    faults.add("create_project");
    expect((await call(app(), "list_projects")).body.result).toMatchObject({ isError: true, content: [{ text: "Permission denied" }] });
    await expect(callProjectTool({ name: "create_project", arguments: { name: "Project", idempotencyKey: "key" }, apiUrl: "http://fixture.test", token: "fixture-token", companyId: "company", issueId: "issue", agentId: "agent", conversation: false })).rejects.toThrow("Permission denied");
  });
});
