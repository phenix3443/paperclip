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
    for (const dir of ["server/dist", "scripts", "skills/paperclip", "dependency", "server/node_modules/@paperclipai/plugin-sdk"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ pnpm: {} }));
    writeFileSync(join(root, "server/node_modules/@paperclipai/plugin-sdk/package.json"), JSON.stringify({ name: "@paperclipai/plugin-sdk", version: "1.0.0" }));
    writeFileSync(join(root, "dependency/package.json"), JSON.stringify({ name: "asset-fixture", version: "1.0.0" }));
    writeFileSync(join(root, "server/package.json"), JSON.stringify({
      name: "@paperclipai/server", version: "0.3.1",
      files: ["dist", "ui-dist", "skills"],
      scripts: { prepack: "node -e 'process.exit(42)'", postpack: "node -e 'process.exit(43)'" },
      dependencies: { "asset-fixture": `file:${join(root, "dependency")}`, "@paperclipai/plugin-sdk": "workspace:*" },
      bundleDependencies: ["asset-fixture"],
    }));
    writeFileSync(join(root, "server/dist/index.js"), "export {};\n");
    writeFileSync(join(root, "skills/paperclip/SKILL.md"), "Runtime skill\n");
    writeFileSync(join(root, "scripts/prepare-server-ui-dist.sh"),
      'set -eu\nmkdir -p server/ui-dist\nprintf "Built UI" > server/ui-dist/index.html\n');
    const destination = join(root, "staged");
    // Real bundled dependencies come from the registry and install as directories.
    // npm links a `file:` fixture by default, and the esbuild graph check refuses links.
    const previousInstallLinks = process.env.npm_config_install_links;
    process.env.npm_config_install_links = "true";
    try {
      prepareBundledPackage(join(root, "server"), destination, { sourceRoot: root });
    } finally {
      if (previousInstallLinks === undefined) delete process.env.npm_config_install_links;
      else process.env.npm_config_install_links = previousInstallLinks;
    }
    const stagedManifest = JSON.parse(readFileSync(join(destination, "package.json"), "utf8"));
    assert.equal(stagedManifest.dependencies["@paperclipai/plugin-sdk"], "1.0.0");
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
