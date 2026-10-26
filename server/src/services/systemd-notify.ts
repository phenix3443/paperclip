import { execFile } from "node:child_process";

const SYSTEMD_NOTIFY_TIMEOUT_MS = 5000;

let capturedSocket: string | undefined;
let captured = false;

// Agents and embedded PostgreSQL are children of this process. If they inherit
// NOTIFY_SOCKET, any of them can send STOPPING=1 and put the unit into
// stop-sigterm without signalling this process. Keep the socket for our own
// notifications only.
export function captureSystemdNotifySocket(): void {
  if (!captured) {
    capturedSocket = process.env.NOTIFY_SOCKET?.trim() || undefined;
    captured = true;
  }
  delete process.env.NOTIFY_SOCKET;
}

export async function systemdNotify(args: string[]): Promise<boolean> {
  const socket = captured ? capturedSocket : process.env.NOTIFY_SOCKET?.trim();
  if (!socket) return false;
  return await new Promise<boolean>((resolve) => {
    execFile(
      "systemd-notify",
      args,
      { windowsHide: true, timeout: SYSTEMD_NOTIFY_TIMEOUT_MS, env: { ...process.env, NOTIFY_SOCKET: socket } },
      (error) => resolve(!error),
    );
  });
}
