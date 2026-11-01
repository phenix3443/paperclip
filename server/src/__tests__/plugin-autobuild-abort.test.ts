import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLocalPluginBuildCommand } from "../services/plugin-loader.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("local plugin autobuild abort", () => {
  it("kills the build command and every process it started when the install deadline aborts it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-autobuild-abort-"));
    dirs.push(dir);
    const pidFile = path.join(dir, "grandchild.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const abort = new AbortController();

    const running = runLocalPluginBuildCommand(process.execPath, ["-e", script], {
      cwd: dir,
      timeout: 60_000,
      signal: abort.signal,
    });
    running.catch(() => undefined);
    let grandchild = 0;
    await waitFor(() => {
      try {
        grandchild = Number(readFileSync(pidFile, "utf8"));
        return grandchild > 0;
      } catch {
        return false;
      }
    });
    expect(alive(grandchild)).toBe(true);

    abort.abort();
    await expect(running).rejects.toBeTruthy();
    await waitFor(() => !alive(grandchild));
    expect(alive(grandchild)).toBe(false);
  });
});
