import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../scripts/issue-read-release-gate/", import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));

describe("issue-read release comparison", () => {
  it.each(["pass", "failed-process", "failed-request", "regression", "wrong-sha", "duplicate-batch"])(
    "preserves the %s outcome",
    async mode => {
      const output = await fs.mkdtemp(path.join(os.tmpdir(), "issue-read-comparison-"));
      try {
        for (const arm of ["baseline", "candidate"]) {
          const batches = [];
          for (const phase of ["warm", "past-cache-ttl"]) {
            for (const name of ["detail", "context", "list", "skills"]) {
              for (const concurrency of [1, 4]) {
                batches.push({ phase, path: name, concurrency, medianMs: 10, wallMs: 200, gitCommands: 0,
                  samples: Array.from({ length: 20 }, (_, index) => ({ index, ms: 10, ok: true })) });
              }
            }
          }
          const report = { arm, sha: manifest[arm], manifest, passed: true, skillCatalogEntries: 50,
            coverage: [{ distinctWorkspaces: 75 }, { distinctWorkspaces: 75 }], batches };
          if (arm === "candidate") {
            if (mode === "failed-process") await fs.writeFile(path.join(output, "candidate.failed"), "");
            if (mode === "failed-request") batches[0].samples[0].ok = false;
            if (mode === "regression") batches.find(batch => batch.path === "list")!.medianMs = 12;
            if (mode === "wrong-sha") report.sha = manifest.baseline;
            if (mode === "duplicate-batch") batches[1] = batches[0];
          }
          await fs.writeFile(path.join(output, `${arm}.json`), JSON.stringify(report));
        }
        let succeeded = true;
        try { execFileSync(process.execPath, [path.join(directory, "compare.mjs"), output], { timeout: 10000, stdio: "pipe" }); }
        catch { succeeded = false; }
        const result = JSON.parse(await fs.readFile(path.join(output, "comparison.json"), "utf8"));
        expect(succeeded).toBe(mode === "pass");
        expect(result.passed).toBe(mode === "pass");
        if (mode !== "pass") expect(result.errors.length).toBeGreaterThan(0);
      } finally {
        await fs.rm(output, { recursive: true, force: true });
      }
    },
  );
});
