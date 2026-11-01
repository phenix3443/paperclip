import { expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { projectToolDefinitions } from "../services/project-tools.js";
import { projectToolRoutes } from "../routes/project-tools.js";

const fault = vi.hoisted(() => ({ active: false }));
vi.mock("zod", async importOriginal => {
  const original = await importOriginal<typeof import("zod")>();
  return { ...original, z: { ...original.z, toJSONSchema: (...args: Parameters<typeof original.z.toJSONSchema>) => {
    if (fault.active) throw new Error("converter failed with private details");
    return original.z.toJSONSchema(...args);
  } } };
});
vi.mock("../services/project-tool-context.js", () => ({ projectToolContext: async () => ({
  run: { companyId: "company", agentId: "agent" }, issue: { id: "issue", workMode: "standard" },
}) }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

it("isolates an actual converter exception at discovery and transport, then retries conversion", async () => {
  fault.active = true;
  expect(() => projectToolDefinitions("standard", true)).toThrow("converter failed");
  const warning = vi.fn();
  expect(projectToolDefinitions("standard", true, warning).map(tool => tool.name)).not.toContain("create_project");
  expect(warning).toHaveBeenCalledWith("create_project", expect.any(Error));
  const app = express();
  app.use(express.json(), (req, _res, next) => { Object.assign(req, { actor: { type: "agent", companyId: "company" } }); next(); });
  app.use(projectToolRoutes({} as Db));
  const list = await request(app).post("/mcp/project-tools").send({ id: 1, method: "tools/list" });
  expect(list.status).toBe(200);
  expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("create_project");
  const denied = await request(app).post("/mcp/project-tools").send({ id: 2, method: "tools/call", params: { name: "create_project" } });
  expect(denied.body.result.isError).toBe(true);
  fault.active = false;
  expect(projectToolDefinitions("standard", true).map(tool => tool.name)).toContain("create_project");
});
