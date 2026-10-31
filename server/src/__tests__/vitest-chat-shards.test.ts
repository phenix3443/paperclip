import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

it.each(["absent", "present"])("runs every active nested/parameterized fixture case exactly once through the real chat shard CLI with selection variables %s", (selectionState) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pc-shards-")));
  try {
    vi.stubEnv("PAPERCLIP_CI_TEST_SELECTION", selectionState === "present" ? "fixture-parent-selection.json" : undefined);
    vi.stubEnv("PAPERCLIP_CI_SELECTION_HASH", selectionState === "present" ? "fixture-parent-selection-hash" : undefined);
    const parentSelection = () => ["PAPERCLIP_CI_TEST_SELECTION", "PAPERCLIP_CI_SELECTION_HASH"].map((key) => ({
      key, present: Object.hasOwn(process.env, key), value: process.env[key],
    }));
    const originalSelection = parentSelection();
    const assertChildSelection = `
      expect(Object.hasOwn(process.env, "PAPERCLIP_CI_TEST_SELECTION")).toBe(false);
      expect(Object.hasOwn(process.env, "PAPERCLIP_CI_SELECTION_HASH")).toBe(false);
    `;
    const tests = path.join(root, "server/src/__tests__");
    mkdirSync(tests, { recursive: true });
    mkdirSync(path.join(root, "server/scripts"), { recursive: true });
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(path.join(root, "vitest.config.mjs"), `export default {
      test: { projects: [{ test: { name: "@paperclipai/server", root: ${JSON.stringify(path.join(root, "server"))},
        include: ["src/**/*.test.ts"], pool: "forks", maxWorkers: 1 } }] }
    };`);
    const trace = path.join(root, "executed.jsonl");
    const fixture = path.join(tests, "chat-channels.integration.test.ts");
    writeFileSync(fixture, `import { appendFileSync } from "node:fs";
      import { afterEach, beforeEach, describe, expect, it } from "vitest";
      let active = false;
      beforeEach(() => { ${assertChildSelection} expect(active).toBe(false); active = true; });
      afterEach(() => { active = false; });
      function record(id) { expect(active).toBe(true); appendFileSync(${JSON.stringify(trace)}, JSON.stringify(id) + "\\n"); }
      it("top-level", () => record("top"));
      describe("nested", () => {
        it("first", () => record("nested-first"));
        it("second", () => record("nested-second"));
        it.each(["a", "b", "c", "d"])("parameter %s", (value) => record(value));
        it.skip("intentionally skipped", () => { throw new Error("must stay skipped"); });
      });`);
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", PAPERCLIP_CI_PROFILE: "false" };
    delete env.PAPERCLIP_CI_TEST_SELECTION;
    delete env.PAPERCLIP_CI_SELECTION_HASH;
    const run = (index: number, count: number) => {
      const result = spawnSync(process.execPath, [
        path.join(repoRoot, "scripts/run-vitest-stable.mjs"), "--mode", "general", "--group", "general-chat",
        "--shard-index", String(index), "--shard-count", String(count),
      ], { cwd: root, env, encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
      expect(parentSelection()).toEqual(originalSelection);
      return result;
    };
    for (const index of [0, 1]) {
      const result = run(index, 2);
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("exact filter coverage verified");
    }
    const executed = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(executed.sort()).toEqual(["a", "b", "c", "d", "nested-first", "nested-second", "top"]);

    // A real assertion failure must still fail the wrapper after successful
    // collection and filter validation.
    writeFileSync(fixture, `import { expect, it } from "vitest"; it("fails", () => {
      ${assertChildSelection}
      throw new Error("fixture failure");
    });`);
    const failed = run(0, 1);
    expect(failed.error, failed.stderr).toBeUndefined();
    expect(failed.stdout).toContain("exact filter coverage verified");
    expect(failed.status).not.toBe(0);
    expect(failed.stdout + failed.stderr).toContain("fixture failure");
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
