import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareBundledPackage } from "./prepare-bundled-package.mjs";

test("a clean Git server package includes built UI and release runtime skills", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-server-assets-"));
  try {
    for (const dir of ["server/dist", "scripts", "skills/paperclip", "dependency"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ pnpm: {} }));
    writeFileSync(join(root, "dependency/package.json"), JSON.stringify({ name: "asset-fixture", version: "1.0.0" }));
    writeFileSync(join(root, "server/package.json"), JSON.stringify({
      name: "@paperclipai/server", version: "0.3.1",
      files: ["dist", "ui-dist", "skills"],
      scripts: { prepack: "node -e 'process.exit(42)'", postpack: "node -e 'process.exit(43)'" },
      dependencies: { "asset-fixture": `file:${join(root, "dependency")}` },
      bundleDependencies: ["asset-fixture"],
    }));
    writeFileSync(join(root, "server/dist/index.js"), "export {};\n");
    writeFileSync(join(root, "skills/paperclip/SKILL.md"), "Runtime skill\n");
    writeFileSync(join(root, "scripts/prepare-server-ui-dist.sh"),
      'set -eu\nmkdir -p server/ui-dist\nprintf "Built UI" > server/ui-dist/index.html\n');
    const destination = join(root, "staged");
    prepareBundledPackage(join(root, "server"), destination, { sourceRoot: root });
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: destination, encoding: "utf8",
    }));
    const packedFiles = packed.files.map((file) => file.path);
    assert.ok(packedFiles.includes("ui-dist/index.html"));
    assert.ok(packedFiles.includes("skills/paperclip/SKILL.md"));
    assert.equal(readFileSync(join(destination, "ui-dist/index.html"), "utf8"), "Built UI");
    assert.equal(readFileSync(join(destination, "skills/paperclip/SKILL.md"), "utf8"), "Runtime skill\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
