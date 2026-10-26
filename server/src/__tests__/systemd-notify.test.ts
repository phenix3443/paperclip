import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile };
});

describe("systemd notify socket", () => {
  const original = process.env.NOTIFY_SOCKET;

  beforeEach(() => {
    vi.resetModules();
    execFile.mockReset();
    execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NOTIFY_SOCKET;
    else process.env.NOTIFY_SOCKET = original;
  });

  it("removes the socket from the environment so children do not inherit it", async () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    const { captureSystemdNotifySocket } = await import("../services/systemd-notify.js");

    captureSystemdNotifySocket();

    expect(process.env.NOTIFY_SOCKET).toBeUndefined();
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.NOTIFY_SOCKET))"], {
      encoding: "utf8",
    });
    expect(child.stdout).toBe("undefined");
  });

  it("still notifies systemd with the captured socket and a timeout", async () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    const { captureSystemdNotifySocket, systemdNotify } = await import("../services/systemd-notify.js");
    captureSystemdNotifySocket();

    await expect(systemdNotify(["--stopping"])).resolves.toBe(true);

    expect(execFile).toHaveBeenCalledOnce();
    const [file, args, options] = execFile.mock.calls[0];
    expect(file).toBe("systemd-notify");
    expect(args).toEqual(["--stopping"]);
    expect(options).toMatchObject({ timeout: 5000, env: { NOTIFY_SOCKET: "/run/user/1000/systemd/notify" } });
    expect(process.env.NOTIFY_SOCKET).toBeUndefined();
  });

  it("sends nothing when there was no socket at start", async () => {
    delete process.env.NOTIFY_SOCKET;
    const { captureSystemdNotifySocket, systemdNotify } = await import("../services/systemd-notify.js");
    captureSystemdNotifySocket();

    await expect(systemdNotify(["--ready"])).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("keeps the first captured socket when capture runs again", async () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    const { captureSystemdNotifySocket, systemdNotify } = await import("../services/systemd-notify.js");
    captureSystemdNotifySocket();
    captureSystemdNotifySocket();

    await systemdNotify(["--ready"]);
    expect(execFile.mock.calls[0][2]).toMatchObject({ env: { NOTIFY_SOCKET: "/run/user/1000/systemd/notify" } });
  });
});
