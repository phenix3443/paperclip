import { describe, expect, it, vi } from "vitest";
import { createRouteTestRuntime } from "./helpers/route-test-scope.js";

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
});
