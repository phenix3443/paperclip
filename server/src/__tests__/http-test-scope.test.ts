import request from "supertest";
import { Server } from "node:http";
import { createConnection } from "node:net";
import { aroundEach, describe, expect, it, vi } from "vitest";
import { createRouteTestRuntime } from "./helpers/route-test-scope.js";

const fault = process.env.PAPERCLIP_ROUTE_TEST_FAULT;

describe("route test scope", () => {
  it("rejects calls outside a case and retains each case's mock queue", async () => {
    const runtime = createRouteTestRuntime();
    const service = runtime.facade(() => ({ read: vi.fn(() => "default") }));
    expect(() => service.read()).toThrow("No active route test scope");
    const first = runtime.createScope(new AbortController().signal);
    await runtime.run(first, async () => {
      service.read.mockReturnValueOnce("first");
      expect(service.read()).toBe("first");
      expect(service.read).toHaveBeenCalledTimes(1);
    });
    await first.dispose();
    const second = runtime.createScope(new AbortController().signal);
    await runtime.run(second, async () => {
      expect(service.read).not.toHaveBeenCalled();
      expect(service.read()).toBe("default");
    });
    await second.dispose();
    expect(first.pending).toBe(0);
    expect(second.pending).toBe(0);
  });

  it("binds HTTP handlers to their server's case across two warm constructions", async () => {
    const runtime = createRouteTestRuntime();
    const ports: number[] = [];
    for (const value of ["first", "second"]) {
      const scope = runtime.createScope(new AbortController().signal);
      await runtime.run(scope, async () => {
        const response = await scope.request((_req, res) => {
          expect(runtime.active()).toBe(scope);
          res.end(value);
        }, (url) => {
          ports.push(Number(new URL(url).port));
          return request(url).get("/");
        });
        expect(response.text).toBe(value);
      });
      await scope.dispose();
      expect(scope.pending).toBe(0);
      for (const resource of scope.resources) {
        expect(resource.server.listening).toBe(false);
        expect([...resource.sockets].every((socket) => socket.destroyed)).toBe(true);
      }
    }
    for (const port of ports) await expectPortClosed(port);
  });

  it("fences an old mock promise without consuming the new case's once queue", async () => {
    const runtime = createRouteTestRuntime();
    const service = runtime.facade(() => ({ read: vi.fn(async () => "default") }));
    const controller = new AbortController();
    const old = runtime.createScope(controller.signal);
    let release!: () => void;
    const result = runtime.run(old, () => {
      service.read.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return service.read();
      });
      return service.read();
    });
    const rejected = expect(result).rejects.toThrow("scope closed");
    controller.abort();
    const next = runtime.createScope(new AbortController().signal);
    await runtime.run(next, async () => {
      service.read.mockResolvedValueOnce("sentinel");
      release();
      await rejected;
      expect(service.read).not.toHaveBeenCalled();
      expect(await service.read()).toBe("sentinel");
      expect(service.read).toHaveBeenCalledTimes(1);
      expect(await service.read()).toBe("default");
    });
    await expect(old.dispose()).rejects.toThrow("Late route test work failed");
    await next.dispose();
    expect(old.pending).toBe(0);
  });

  it("closes a listener that becomes ready after abort", async () => {
    const runtime = createRouteTestRuntime();
    const controller = new AbortController();
    const scope = runtime.createScope(controller.signal);
    const original = Server.prototype.listen;
    let release!: () => void;
    const spy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (...args: any[]) {
      release = () => Reflect.apply(original, this, args);
      return this;
    });
    try {
      const response = runtime.run(scope, () => scope.request((_req, res) => res.end("late"), (url) => request(url).get("/")));
      const rejected = expect(response).rejects.toThrow("scope closed");
      controller.abort();
      release();
      await rejected;
      await scope.dispose();
      expect(scope.resources[0].server.listening).toBe(false);
      expect(scope.resources[0].request).toBeUndefined();
      expect(scope.pending).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it("aborts a hanging response and destroys accepted sockets", async () => {
    const runtime = createRouteTestRuntime();
    const controller = new AbortController();
    const scope = runtime.createScope(controller.signal);
    let received!: () => void;
    const ready = new Promise<void>((resolve) => { received = resolve; });
    const response = runtime.run(scope, () => scope.request(() => received(), (url) => request(url).get("/")));
    const rejected = expect(response).rejects.toThrow("scope closed");
    await ready;
    const port = (scope.resources[0].server.address() as { port: number }).port;
    const abort = vi.spyOn(scope.resources[0].request!, "abort");
    controller.abort();
    await rejected;
    await scope.dispose();
    expect(scope.pending).toBe(0);
    expect(abort).toHaveBeenCalled();
    expect([...scope.resources[0].sockets].every((socket) => socket.destroyed)).toBe(true);
    expect(scope.resources[0].server.listening).toBe(false);
    await expectPortClosed(port);
  });

  it("never clears poison after late cleanup settles", async () => {
    const runtime = createRouteTestRuntime(10);
    const scope = runtime.createScope(new AbortController().signal);
    let release!: () => void;
    scope.track(new Promise<void>((resolve) => { release = resolve; }));
    await expect(scope.dispose()).rejects.toThrow("cleanup deadline");
    release();
    await Promise.resolve();
    expect(scope.pending).toBe(0);
    expect(() => runtime.createScope(new AbortController().signal)).toThrow("runtime poisoned");
  });
});

if (fault === "timeout") describe("legacy shared-mock negative control", () => {
  const shared = vi.fn(async () => "default");
  let release!: () => void;
  it("times out while retaining an old continuation", async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    await shared();
  });
  it("detects the old continuation consuming the next case's queue", async () => {
    vi.clearAllMocks();
    shared.mockResolvedValueOnce("sentinel");
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shared).not.toHaveBeenCalled();
    expect(await shared()).toBe("sentinel");
  });
});

async function expectPortClosed(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); reject(new Error(`Port ${port} remains open`)); });
    socket.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
}

if (fault) describe(`route scope negative control: ${fault}`, () => {
  const runtime = createRouteTestRuntime();
  const service = runtime.facade(() => ({ read: vi.fn(async () => "fresh") }));
  let expired = false;
  aroundEach(async (runTest, context) => {
    const scope = runtime.createScope(context.signal);
    await runtime.run(scope, async () => {
      try { await runTest(); }
      finally { await scope.dispose(); }
    });
  });
  it("retains the injected failure", async ({ signal }) => {
    if (fault === "timeout") {
      const owner = runtime.active();
      signal.addEventListener("abort", () => {
        const next = runtime.createScope(new AbortController().signal);
        owner.track(runtime.run(next, async () => {
          service.read.mockResolvedValueOnce("sentinel");
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          expect(expired).toBe(true);
          expect(service.read).not.toHaveBeenCalled();
          expect(await service.read()).toBe("sentinel");
          expect(await service.read()).toBe("fresh");
          await next.dispose();
        }), true);
      }, { once: true });
      service.read.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 16000));
        expired = true;
        return service.read();
      });
      await service.read();
    } else if (fault === "drain") {
      runtime.active().track(new Promise(() => {}));
    } else if (fault === "close") {
      await runtime.active().request((_req, res) => res.end("ok"), (url) => {
        const server = runtime.active().resources[0].server;
        const close = server.close.bind(server);
        server.close = ((callback: (error?: Error) => void) => close(() => callback(new Error("injected close failure")))) as typeof server.close;
        return request(url).get("/");
      });
    } else throw new Error(`Unknown fault: ${fault}, aborted=${signal.aborted}`);
  });
  it("fails before creating a later scope when cleanup is poisoned", async () => {
    expect(fault).toBe("timeout");
    expect(expired).toBe(true);
    expect(service.read).not.toHaveBeenCalled();
    expect(await service.read()).toBe("fresh");
  });
});
