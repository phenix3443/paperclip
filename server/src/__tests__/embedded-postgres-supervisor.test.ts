import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedPostgresSupervisor, type SupervisedEmbeddedPostgres } from "../embedded-postgres-supervisor.js";

function createInstance(startError?: Error) {
  const process = new EventEmitter();
  const instance: SupervisedEmbeddedPostgres = {
    process,
    start: vi.fn(async () => { if (startError) throw startError; }),
    stop: vi.fn(async () => undefined),
  };
  return { instance, process };
}

describe("embedded PostgreSQL supervisor", () => {
  it("restarts PostgreSQL after its managed child exits unexpectedly", async () => {
    const initial = createInstance();
    const replacement = createInstance();
    const onRestarted = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => replacement.instance,
      restartDelaysMs: [0],
      onRestarted,
    });
    initial.process.emit("exit", 137, "SIGKILL");
    await supervisor.waitForRecovery();
    expect(replacement.instance.start).toHaveBeenCalledOnce();
    expect(supervisor.current()).toBe(replacement.instance);
    expect(onRestarted).toHaveBeenCalledWith(1);
  });

  it("does not restart PostgreSQL during orderly shutdown", async () => {
    const initial = createInstance();
    const createReplacement = vi.fn(() => createInstance().instance);
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [0],
    });
    await supervisor.shutdown();
    expect(initial.instance.stop).toHaveBeenCalledOnce();
    expect(createReplacement).not.toHaveBeenCalled();
  });

  it("bounds recovery attempts and reports the final failure", async () => {
    const initial = createInstance();
    const failures = [new Error("first"), new Error("second"), new Error("third")];
    const onRecoveryExhausted = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => createInstance(failures.shift()).instance,
      restartDelaysMs: [0, 0, 0],
      onRecoveryExhausted,
    });
    initial.process.emit("exit", 1, null);
    await supervisor.waitForRecovery();
    expect(onRecoveryExhausted).toHaveBeenCalledOnce();
    expect(onRecoveryExhausted).toHaveBeenCalledWith(expect.objectContaining({ message: "third" }));
  });
  it("does not restart PostgreSQL that exits after shutdown began, and still stops it once", async () => {
    const initial = createInstance();
    const createReplacement = vi.fn(() => createInstance().instance);
    const onExitDuringShutdown = vi.fn();
    const onUnexpectedExit = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [0],
      onUnexpectedExit,
      onExitDuringShutdown,
    });

    supervisor.beginShutdown();
    initial.process.emit("exit", 0, "SIGTERM");
    await supervisor.waitForRecovery();

    expect(createReplacement).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(onExitDuringShutdown).toHaveBeenCalledWith(0, "SIGTERM");
    await supervisor.shutdown();
    expect(initial.instance.stop).not.toHaveBeenCalled();
  });

  it("stops the live instance when shutdown follows beginShutdown", async () => {
    const initial = createInstance();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => createInstance().instance,
      restartDelaysMs: [0],
    });

    supervisor.beginShutdown();
    await supervisor.shutdown();
    await supervisor.shutdown();

    expect(initial.instance.stop).toHaveBeenCalledOnce();
  });

  it("still recovers an exit that happens before beginShutdown", async () => {
    const initial = createInstance();
    const replacement = createInstance();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => replacement.instance,
      restartDelaysMs: [0],
    });

    initial.process.emit("exit", 137, "SIGKILL");
    await supervisor.waitForRecovery();
    supervisor.beginShutdown();

    expect(replacement.instance.start).toHaveBeenCalledOnce();
    expect(supervisor.current()).toBe(replacement.instance);
  });
});
