import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { closeHttpListenerForShutdown } from "../shutdown.js";

// Graceful-stop plan, rule 1: requests are served through the work stage,
// teardown 1 refuses new connections, and a request that reaches the database
// after the pool started closing gets 503, never 500.

function endedPoolQueryError() {
  const driverError = Object.assign(new Error("write CONNECTION_ENDED db.example:5432"), { code: "CONNECTION_ENDED" });
  return new Error('Failed query: select "id" from "issues"', { cause: driverError });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function request(port: number, path: string, agent?: http.Agent) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

describe("HTTP admission during shutdown", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.closeAllConnections?.();
  });

  async function start() {
    const app = express();
    const slow = deferred();
    const reachedSlow = deferred();
    app.get("/ok", (_req, res) => { res.json({ ok: true }); });
    app.get("/slow", async (_req, _res, next) => {
      reachedSlow.resolve();
      await slow.promise;
      // The pool is ending: this models the route's query failing on it.
      next(endedPoolQueryError());
    });
    app.use(errorHandler);
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { app, server, port: (server.address() as AddressInfo).port, slow, reachedSlow };
  }

  it("serves the work stage, refuses new connections after teardown 1, and answers 503 after the pool closes", async () => {
    const { app, server, port, slow, reachedSlow } = await start();
    const log = { info: vi.fn(), error: vi.fn() };

    expect(await request(port, "/ok")).toMatchObject({ status: 200 });
    // Opened before teardown 1; without keep-alive the listener closes as soon
    // as this response ends (a keep-alive socket would wait for the cap).
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const inFlight = request(port, "/slow", agent);
    await reachedSlow.promise;

    const closing = closeHttpListenerForShutdown({ server, signal: "SIGTERM", timeoutMs: 5_000, log });
    await expect(request(port, "/ok")).rejects.toMatchObject({ code: "ECONNREFUSED" });

    (app.locals as { paperclipDatabaseClosing?: boolean }).paperclipDatabaseClosing = true;
    slow.resolve();
    const response = await inFlight;
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "Server is shutting down" });
    expect(await closing).toBe("closed");
    agent.destroy();
  });

  it("closes a request that outlives the teardown 1 cap without answering 500", async () => {
    const { server, port, slow, reachedSlow } = await start();
    const log = { info: vi.fn(), error: vi.fn() };
    const inFlight = request(port, "/slow").then(
      (response) => ({ status: response.status }),
      (error: NodeJS.ErrnoException) => ({ error: error.code ?? error.message }),
    );
    await reachedSlow.promise;

    expect(await closeHttpListenerForShutdown({ server, signal: "SIGTERM", timeoutMs: 50, log })).toBe("timed_out");
    await expect(request(port, "/ok")).rejects.toMatchObject({ code: "ECONNREFUSED" });
    slow.resolve();

    const outcome = await inFlight;
    expect(outcome).not.toEqual({ status: 500 });
    expect(outcome).toEqual({ error: "ECONNRESET" });
  });
});
