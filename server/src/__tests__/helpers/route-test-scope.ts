import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import type request from "supertest";

type HttpResource = {
  server: ReturnType<typeof createServer>;
  sockets: Set<Socket>;
  request?: request.Test;
  stop: () => void;
  closed: Promise<void>;
};
type RouteTestScope = {
  mocks: unknown[];
  resources: HttpResource[];
  pending: number;
  assertActive(): void;
  track<T>(promise: Promise<T>, reportLate?: boolean): Promise<T>;
  dispose(): Promise<void>;
  request(handler: RequestListener, build: (url: string) => request.Test): Promise<request.Response>;
};

export function createRouteTestRuntime(drainMs = 5000) {
  const storage = new AsyncLocalStorage<RouteTestScope>();
  const factories: Array<() => unknown> = [];
  let poison: unknown;
  const captures = new WeakMap<object, () => unknown>();

  function active() {
    const scope = storage.getStore();
    if (!scope) throw new Error("No active route test scope");
    scope.assertActive();
    return scope;
  }

  function facade<T>(factory: () => T): T {
    const index = factories.push(factory) - 1;
    function proxy(template: unknown, path: PropertyKey[], fixed?: RouteTestScope): unknown {
      return new Proxy(typeof template === "function" ? function () {} : template as object, {
        has(_target, key) { return key in (template as object); },
        get(_target, key) {
          const value = Reflect.get(template as object, key);
          if (value === undefined) return undefined;
          if (typeof value === "function" || (value && typeof value === "object" && key !== "mock")) return proxy(value, [...path, key], fixed);
          const scope = fixed ?? active();
          scope.assertActive();
          let owner = scope.mocks[index] as object;
          for (const part of path) owner = Reflect.get(owner, part);
          return Reflect.get(owner, key);
        },
        apply(_target, _thisArg, args) {
          const scope = fixed ?? active();
          scope.assertActive();
          let owner = scope.mocks[index] as object;
          let value: unknown = owner;
          for (const key of path) {
            owner = value as object;
            value = Reflect.get(owner, key);
          }
          const result = Reflect.apply(value as (...args: unknown[]) => unknown, owner, args);
          return result instanceof Promise ? scope.track(result, true) : result;
        },
      });
    }
    const template = factory();
    const value = proxy(template, []) as T;
    captures.set(value as object, () => proxy(template, [], active()));
    return value;
  }

  function createScope(signal: AbortSignal): RouteTestScope {
    if (poison) throw new Error("Route test runtime poisoned", { cause: poison });
    const mocks = factories.map((factory) => factory());
    const pending = new Set<Promise<unknown>>();
    const resources: HttpResource[] = [];
    let closed = signal.aborted;
    let disposal: Promise<void> | undefined;
    const cleanupErrors: unknown[] = [];
    const lateErrors: unknown[] = [];
    function assertActive() {
      if (closed || signal.aborted) throw new Error("Route test scope closed");
    }
    function track<T>(promise: Promise<T>, reportLate = false): Promise<T> {
      pending.add(promise);
      const settle = () => pending.delete(promise);
      void promise.then(settle, (error) => {
        if (reportLate && closed) lateErrors.push(error);
        settle();
      });
      return promise;
    }
    function fence() {
      closed = true;
      for (const resource of resources) {
        try { resource.stop(); }
        catch (error) { cleanupErrors.push(error); poison ??= error; }
      }
    }
    function dispose(): Promise<void> {
      if (disposal) return disposal;
      fence();
      disposal = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await Promise.all(resources.map((resource) => resource.closed));
              while (pending.size) await Promise.allSettled([...pending]);
              if (cleanupErrors.length) throw cleanupErrors[0];
            })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(`Route test cleanup deadline: pending=${pending.size}`)), drainMs);
            }),
          ]);
        } catch (error) {
          poison ??= error;
          throw cleanupErrors[0] ?? error;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
        if (lateErrors.length) throw new AggregateError(lateErrors, "Late route test work failed");
      })();
      return disposal;
    }
    function abort() {
      void dispose().catch(() => {});
    }
    const scope: RouteTestScope = {
      mocks, resources, assertActive, track, dispose,
      get pending() { return pending.size; },
      async request(handler: RequestListener, build: (baseUrl: string) => request.Test) {
        assertActive();
        const server = createServer((req, res) => storage.run(scope, () => {
          if (closed) { req.socket.destroy(); return; }
          handler(req, res);
        }));
        const sockets = new Set<Socket>();
        server.on("connection", (socket) => {
          sockets.add(socket);
          if (closed) socket.destroy();
        });
        let settleClose!: () => void;
        let failClose!: (error: Error) => void;
        const closing = new Promise<void>((resolve, reject) => { settleClose = resolve; failClose = reject; });
        void closing.catch(() => {});
        let listeningSettled = false;
        let closingStarted = false;
        let cancel: (() => void) | undefined;
        const resource = {
          server, sockets, request: undefined as request.Test | undefined, closed: closing,
          stop() {
            cancel?.();
            try { resource.request?.abort(); } catch (error) { cleanupErrors.push(error); }
            for (const socket of sockets) socket.destroy();
            if (!listeningSettled || closingStarted) return;
            closingStarted = true;
            try { server.close((error) => {
              if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") failClose(error);
              else settleClose();
            }); } catch (error) { failClose(error as Error); }
          },
        };
        resources.push(resource);
        try {
          await track(new Promise<void>((resolve, reject) => {
            cancel = () => reject(new Error("Route test scope closed"));
            server.once("error", (error) => {
              listeningSettled = true;
              settleClose();
              reject(error);
            });
            server.listen(0, "127.0.0.1", () => {
              listeningSettled = true;
              if (closed) { resource.stop(); reject(new Error("Route test scope closed")); }
              else resolve();
            });
          }));
          assertActive();
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected HTTP server to listen on a TCP port");
          resource.request = build(`http://127.0.0.1:${address.port}`);
          assertActive();
          return await track(new Promise<request.Response>((resolve, reject) => {
            cancel = () => reject(new Error("Route test scope closed"));
            resource.request!.end((error, response) => error ? reject(error) : resolve(response));
          }));
        } finally {
          resource.stop();
          await closing;
        }
      },
    };
    signal.addEventListener("abort", abort, { once: true });
    return scope;
  }
  const capture = <T extends object>(value: T): T => captures.get(value)!() as T;
  return { facade, capture, createScope, active, run: <T>(scope: ReturnType<typeof createScope>, body: () => T) => storage.run(scope, body) };
}
