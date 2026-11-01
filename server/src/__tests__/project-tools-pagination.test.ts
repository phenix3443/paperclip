import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";
import { projectToolRoutes } from "../routes/project-tools.js";
import { logger } from "../middleware/logger.js";

const failCreateProjectSchema = vi.hoisted(() => ({ enabled: false }));
vi.mock("@paperclipai/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@paperclipai/shared")>();
  return { ...actual, createProjectToolInputJsonSchema: () => {
    if (failCreateProjectSchema.enabled) throw new Error("schema conversion failed");
    return actual.createProjectToolInputJsonSchema();
  } };
});
vi.mock("../services/project-tool-context.js", () => ({
  projectToolContext: vi.fn(async () => ({ run: { companyId: "company", agentId: "agent" }, issue: { id: "issue", workMode: "standard", conversationAgentId: null } })),
}));
vi.mock("../routes/authz.js", () => ({ assertCompanyAccess: vi.fn() }));

const input = {
  name: "list_projects", arguments: {}, apiUrl: "http://paperclip.test", token: "test-token",
  companyId: "company", issueId: "issue", agentId: "agent", conversation: false,
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); failCreateProjectSchema.enabled = false; });

describe("project discovery result bounds", () => {
  it("requests bounded summaries and normalizes continuation cursors", async () => {
    const page = { projects: [{ id: "abcdefab-0000-4000-8000-000000000001", name: "Project", status: "in_progress", description: "Summary", descriptionTruncated: true }], nextCursor: "abcdefab-0000-4000-8000-000000000001" };
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => page }));
    vi.stubGlobal("fetch", fetch);
    expect(await callProjectTool(input)).toEqual(page);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://paperclip.test/api/companies/company/projects?view=summary&limit=50");
    await callProjectTool({ ...input, arguments: { limit: 3, cursor: page.nextCursor.toUpperCase() } });
    expect(fetch.mock.calls[1]?.[0]).toBe(`http://paperclip.test/api/companies/company/projects?view=summary&limit=3&cursor=${page.nextCursor}`);
    expect(projectToolDefinitions("standard").find(t => t.name === "list_projects")?.inputSchema)
      .toMatchObject({ properties: { cursor: expect.any(Object), limit: expect.any(Object) } });
  });

  it.each([{ limit: 0 }, { limit: 51 }, { cursor: "invalid" }])("rejects invalid paging arguments %j before fetching", async (arguments_) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(callProjectTool({ ...input, arguments: arguments_ })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("project creation receipt recovery", () => {
  const create = { ...input, name: "create_project", arguments: { name: "Recovered project", idempotencyKey: "project" }, receiptOnly: true };

  it("asks the project owner for a saved result and accepts an absent receipt without parsing an empty response", async () => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    expect(await callProjectTool(create)).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("http://paperclip.test/api/companies/company/projects", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ "X-Paperclip-Receipt-Only": "true" }),
      body: expect.any(String),
    }));
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toMatchObject(create.arguments);
  });

  it("returns the saved project and preserves owner validation failures", async () => {
    const project = { id: "saved-project", name: create.arguments.name };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(project))
      .mockResolvedValueOnce(Response.json({ error: "Project idempotency key was used with different inputs" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    expect(await callProjectTool(create)).toEqual(project);
    await expect(callProjectTool(create)).rejects.toThrow(/different inputs/);
  });

  it("rejects receipt-only requests for other operations before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(callProjectTool({ ...input, receiptOnly: true })).rejects.toThrow(/receipt/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("project tool definitions", () => {
  it("lists create_project in standard mode with the required idempotency key", () => {
    const createProject = projectToolDefinitions("standard", true).find(t => t.name === "create_project");
    expect(createProject?.inputSchema).toMatchObject({
      type: "object",
      properties: { idempotencyKey: { type: "string", minLength: 1, maxLength: 255 }, name: expect.any(Object) },
      required: expect.arrayContaining(["idempotencyKey"]),
    });
  });

  it("skips only the tool whose definition fails and reports its name", () => {
    failCreateProjectSchema.enabled = true;
    expect(() => projectToolDefinitions("standard", true)).toThrow("schema conversion failed");
    const onToolError = vi.fn();
    const names = projectToolDefinitions("standard", true, onToolError).map(t => t.name);
    expect(names).not.toContain("create_project");
    expect(names).toEqual(expect.arrayContaining(["list_projects", "list_project_repositories", "create_task", "set_task_title"]));
    expect(onToolError).toHaveBeenCalledExactlyOnceWith("create_project", expect.any(Error));
  });

  it("answers tools/list with the remaining tools and a warning when one definition fails", async () => {
    failCreateProjectSchema.enabled = true;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const app = express().use(express.json()).use((req, _res, next) => { req.actor = { type: "agent" } as never; next(); }).use(projectToolRoutes({} as never));
    const response = await request(app).post("/mcp/project-tools").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
    const names = response.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("create_project");
    expect(names).toContain("list_projects");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tool: "create_project" }), expect.any(String));
  });
});
