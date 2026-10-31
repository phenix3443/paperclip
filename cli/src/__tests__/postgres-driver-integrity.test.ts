import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PATCHED_POSTGRES_DRIVER, verifyPostgresDriverPayload } from "../postgres-driver-integrity.js";

const PATCHED_POSTGRES_SOURCE = path.resolve(
  path.dirname(createRequire(path.resolve(__dirname, "../../../packages/db/package.json")).resolve("postgres")),
  "../..",
);

describe("postgres driver payload verifier", () => {
  let payload: string;

  const copyDriver = (target: string) => fs.cpSync(PATCHED_POSTGRES_SOURCE, target, { recursive: true, dereference: true });
  const writeCaller = (name: string) => {
    const directory = path.join(payload, "node_modules", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.3.1" }));
    return directory;
  };

  beforeEach(() => {
    payload = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-postgres-payload-"));
    copyDriver(path.join(writeCaller("paperclipai"), "node_modules", "postgres"));
    copyDriver(path.join(writeCaller("@paperclipai/db"), "node_modules", "postgres"));
  });

  afterEach(() => fs.rmSync(payload, { recursive: true, force: true }));

  it("accepts a payload whose callers resolve the patched ESM and CommonJS driver", async () => {
    const resolutions = await verifyPostgresDriverPayload(payload);
    const root = fs.realpathSync(payload);
    expect(resolutions.map((entry) => entry.caller)).toEqual(["paperclipai", "@paperclipai/db"]);
    for (const entry of resolutions) {
      expect(entry.import).toBe(path.join(entry.packageRoot, "src", "index.js"));
      expect(entry.require).toBe(path.join(entry.packageRoot, "cjs", "src", "index.js"));
      expect(entry.packageRoot.startsWith(root + path.sep)).toBe(true);
    }
  });

  it.each(Object.keys(PATCHED_POSTGRES_DRIVER.files))("rejects a reverted or changed %s", async (file) => {
    fs.appendFileSync(path.join(payload, "node_modules", "paperclipai", "node_modules", "postgres", file), "\n");
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(file);
  });

  it("rejects a missing driver file", async () => {
    fs.rmSync(path.join(payload, "node_modules", "@paperclipai", "db", "node_modules", "postgres", "cjs", "src", "index.js"));
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/cjs\/src\/index\.js is missing/);
  });

  it("rejects a changed driver version", async () => {
    const manifestPath = path.join(payload, "node_modules", "paperclipai", "node_modules", "postgres", "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "3.4.10" }));
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/postgres@3\.4\.10/);
  });

  it("rejects an unpatched duplicate copy elsewhere in the payload", async () => {
    const duplicate = path.join(payload, "node_modules", "postgres");
    copyDriver(duplicate);
    fs.writeFileSync(path.join(duplicate, "src", "connection.js"), "export default null;\n");
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/Payload driver node_modules\/postgres src\/connection\.js/);
  });

  it("rejects a caller whose driver resolves outside the payload", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-postgres-outside-"));
    try {
      copyDriver(path.join(outside, "postgres"));
      const linked = path.join(payload, "node_modules", "@paperclipai", "db", "node_modules", "postgres");
      fs.rmSync(linked, { recursive: true });
      fs.symlinkSync(path.join(outside, "postgres"), linked);
      await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/outside the payload/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a payload without any postgres driver", async () => {
    fs.rmSync(path.join(payload, "node_modules", "paperclipai", "node_modules"), { recursive: true });
    fs.rmSync(path.join(payload, "node_modules", "@paperclipai", "db", "node_modules"), { recursive: true });
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/contains no postgres driver/);
  });
});
