import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  POSTGRES_DRIVER_RECORD,
  readCheckoutPostgresDriver,
  readPostgresDriverRecord,
  verifyPostgresDriverPayload,
  writePostgresDriverRecord,
} from "../postgres-driver-integrity.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXPECTED = readCheckoutPostgresDriver(REPO_ROOT);
const REPO_PATCH = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { pnpm: { patchedDependencies: Record<string, string> } })
  .pnpm.patchedDependencies[`postgres@${EXPECTED.version}`];

const PATCHED_POSTGRES_SOURCE = path.resolve(
  path.dirname(createRequire(path.resolve(__dirname, "../../../packages/db/package.json")).resolve("postgres")),
  "../..",
);

describe("postgres driver payload verifier", () => {
  let payload: string;

  const rootDriver = () => path.join(payload, "node_modules", "postgres");
  const copyDriver = (target: string) => fs.cpSync(PATCHED_POSTGRES_SOURCE, target, { recursive: true, dereference: true });
  const writePackage = (directory: string, name: string) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.3.1" }));
    return directory;
  };
  const writeDrizzle = (directory: string) => {
    writePackage(directory, "drizzle-orm");
    fs.mkdirSync(path.join(directory, "postgres-js"), { recursive: true });
    fs.writeFileSync(path.join(directory, "postgres-js", "driver.js"), "import pgClient from \"postgres\";\n");
  };

  beforeEach(() => {
    payload = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-postgres-payload-"));
    writePackage(path.join(payload, "node_modules", "paperclipai"), "paperclipai");
    writePackage(path.join(payload, "node_modules", "@paperclipai", "db"), "@paperclipai/db");
    writeDrizzle(path.join(payload, "node_modules", "drizzle-orm"));
    copyDriver(rootDriver());
  });

  afterEach(() => fs.rmSync(payload, { recursive: true, force: true }));

  it("accepts a payload whose callers and drizzle driver resolve the one patched root driver", async () => {
    const resolutions = await verifyPostgresDriverPayload(payload, EXPECTED);
    const expected = fs.realpathSync(rootDriver());
    expect(resolutions.map((entry) => entry.caller)).toEqual(["paperclipai", "@paperclipai/db", path.join("node_modules", "drizzle-orm", "postgres-js", "driver.js")]);
    for (const entry of resolutions) {
      expect(entry.packageRoot).toBe(expected);
      expect(entry.import).toBe(path.join(expected, "src", "index.js"));
      expect(entry.require).toBe(path.join(expected, "cjs", "src", "index.js"));
    }
  });

  it("accepts npm .bin links that stay inside the payload", async () => {
    fs.mkdirSync(path.join(payload, "node_modules", ".bin"));
    fs.symlinkSync("../drizzle-orm/postgres-js/driver.js", path.join(payload, "node_modules", ".bin", "tool"));
    await expect(verifyPostgresDriverPayload(payload, EXPECTED)).resolves.toHaveLength(3);
  });

  describe("with files linked inside one package", () => {
    const nativeLib = () => path.join(payload, "node_modules", "@embedded-postgres", "linux-x64", "native", "lib");
    beforeEach(() => {
      writePackage(path.join(payload, "node_modules", "@embedded-postgres", "linux-x64"), "@embedded-postgres/linux-x64");
      fs.mkdirSync(nativeLib(), { recursive: true });
      fs.writeFileSync(path.join(nativeLib(), "libecpg.so.6.13"), "elf");
    });

    it("accepts shared library version links, including link chains, inside a scoped package", async () => {
      fs.symlinkSync("libecpg.so.6.13", path.join(nativeLib(), "libecpg.so.6"));
      fs.symlinkSync("libecpg.so.6", path.join(nativeLib(), "libecpg.so"));
      fs.symlinkSync("lib/libecpg.so", path.join(nativeLib(), "..", "libecpg.so"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).resolves.toHaveLength(3);
    });

    it("rejects a link to a file in a sibling package that is still inside the payload", async () => {
      fs.symlinkSync(path.join(payload, "node_modules", "drizzle-orm", "postgres-js", "driver.js"), path.join(nativeLib(), "driver.js"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*native\/lib\/driver\.js/);
    });

    it("rejects a link to a file in the same scope but another package", async () => {
      writePackage(path.join(payload, "node_modules", "@embedded-postgres", "linux-arm64"), "@embedded-postgres/linux-arm64");
      fs.writeFileSync(path.join(payload, "node_modules", "@embedded-postgres", "linux-arm64", "libpq.so.5"), "elf");
      fs.symlinkSync("../../linux-arm64/libpq.so.5", path.join(nativeLib(), "..", "libpq.so"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*linux-x64\/native\/libpq\.so/);
    });

    it("rejects a link to a file of a nested dependency", async () => {
      const nested = writePackage(path.join(payload, "node_modules", "@embedded-postgres", "linux-x64", "node_modules", "dep"), "dep");
      fs.writeFileSync(path.join(nested, "index.js"), "");
      fs.symlinkSync("../node_modules/dep/index.js", path.join(nativeLib(), "..", "dep.js"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*linux-x64\/native\/dep\.js/);
    });

    it("rejects a file link placed in a nested node_modules even when its target is in the package", async () => {
      fs.mkdirSync(path.join(payload, "node_modules", "@embedded-postgres", "linux-x64", "node_modules"));
      fs.symlinkSync("../native/lib/libecpg.so.6.13", path.join(payload, "node_modules", "@embedded-postgres", "linux-x64", "node_modules", "libecpg.so"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*linux-x64\/node_modules\/libecpg\.so/);
    });

    it("rejects a directory link inside the package", async () => {
      fs.symlinkSync("lib", path.join(nativeLib(), "..", "lib64"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*native\/lib64/);
    });

    it("rejects a broken link inside the package", async () => {
      fs.symlinkSync("libmissing.so.1", path.join(nativeLib(), "libmissing.so"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*native\/lib\/libmissing\.so/);
    });

    it("rejects looping links inside the package", async () => {
      fs.symlinkSync("libloop.b", path.join(nativeLib(), "libloop.a"));
      fs.symlinkSync("libloop.a", path.join(nativeLib(), "libloop.b"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*native\/lib\/libloop\./);
    });

    it("rejects a file link directly in node_modules", async () => {
      fs.symlinkSync("drizzle-orm/package.json", path.join(payload, "node_modules", "loose.json"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*node_modules\/loose\.json/);
    });
  });

  it("checks every installed drizzle-orm wherever npm placed it", async () => {
    writeDrizzle(path.join(payload, "node_modules", "paperclipai", "node_modules", "drizzle-orm"));
    const resolutions = await verifyPostgresDriverPayload(payload, EXPECTED);
    expect(resolutions.map((entry) => entry.caller)).toContain(path.join("node_modules", "paperclipai", "node_modules", "drizzle-orm", "postgres-js", "driver.js"));
    expect(new Set(resolutions.map((entry) => entry.packageRoot)).size).toBe(1);
  });

  it.each(Object.keys(EXPECTED.files))("rejects a reverted or changed %s", async (file) => {
    fs.appendFileSync(path.join(rootDriver(), file), "\n");
    await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(file);
  });

  it("rejects a missing driver file", async () => {
    fs.rmSync(path.join(rootDriver(), "cjs", "src", "index.js"));
    await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/cjs\/src\/index\.js is missing/);
  });

  it("accepts an unpatched checkout expectation while still checking the driver version", async () => {
    await expect(verifyPostgresDriverPayload(payload, { version: EXPECTED.version, files: {} })).resolves.toHaveLength(3);
    await expect(verifyPostgresDriverPayload(payload, { version: "0.0.0", files: {} })).rejects.toThrow(/expected patched postgres@0\.0\.0/);
  });

  it("rejects a changed driver version", async () => {
    const manifestPath = path.join(rootDriver(), "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "3.4.10" }));
    await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/postgres@3\.4\.10/);
  });

  it("rejects any second copy, even a patched one, that a caller could load instead", async () => {
    copyDriver(path.join(payload, "node_modules", "@paperclipai", "db", "node_modules", "postgres"));
    await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/exactly one postgres driver/);
  });

  it("rejects a payload whose only driver is nested instead of at the root", async () => {
    const nested = path.join(payload, "node_modules", "@paperclipai", "db", "node_modules", "postgres");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.renameSync(rootDriver(), nested);
    await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/exactly one postgres driver/);
  });

  describe("with packages linked from outside the payload", () => {
    let outside: string;
    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-postgres-outside-"));
      writeDrizzle(path.join(outside, "node_modules", "drizzle-orm"));
      copyDriver(path.join(outside, "node_modules", "postgres"));
      fs.writeFileSync(path.join(outside, "node_modules", "postgres", "src", "index.js"), "export default null;\n");
    });
    afterEach(() => fs.rmSync(outside, { recursive: true, force: true }));
    const dbModules = () => path.join(payload, "node_modules", "@paperclipai", "db", "node_modules");

    it("rejects a linked driver that a caller would load", async () => {
      fs.mkdirSync(dbModules(), { recursive: true });
      fs.symlinkSync(path.join(outside, "node_modules", "postgres"), path.join(dbModules(), "postgres"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*@paperclipai\/db\/node_modules\/postgres/);
    });

    it("rejects a linked drizzle-orm whose own driver import resolves outside the payload", async () => {
      fs.mkdirSync(dbModules(), { recursive: true });
      fs.symlinkSync(path.join(outside, "node_modules", "drizzle-orm"), path.join(dbModules(), "drizzle-orm"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*@paperclipai\/db\/node_modules\/drizzle-orm/);
    });

    it("rejects a linked nested node_modules directory", async () => {
      fs.symlinkSync(path.join(outside, "node_modules"), dbModules());
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*@paperclipai\/db\/node_modules/);
    });

    it("rejects a drizzle driver file linked to a driver outside the payload", async () => {
      const driver = path.join(payload, "node_modules", "drizzle-orm", "postgres-js", "driver.js");
      fs.rmSync(driver);
      fs.symlinkSync(path.join(outside, "node_modules", "drizzle-orm", "postgres-js", "driver.js"), driver);
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*drizzle-orm\/postgres-js\/driver\.js/);
    });

    it("rejects a driver source file linked outside the payload even when its bytes match", async () => {
      const queryFile = path.join(rootDriver(), "src", "query.js");
      fs.copyFileSync(queryFile, path.join(outside, "query.js"));
      fs.rmSync(queryFile);
      fs.symlinkSync(path.join(outside, "query.js"), queryFile);
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*postgres\/src\/query\.js/);
    });

    it("rejects a hidden node_modules entry linked outside the payload", async () => {
      fs.symlinkSync(path.join(outside, "node_modules"), path.join(payload, "node_modules", ".store"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*node_modules\/\.store/);
    });

    it("rejects a .bin link whose target is outside the payload", async () => {
      fs.mkdirSync(path.join(payload, "node_modules", ".bin"));
      fs.symlinkSync(path.join(outside, "node_modules", "drizzle-orm", "postgres-js", "driver.js"), path.join(payload, "node_modules", ".bin", "tool"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/node_modules\/\.bin\/tool/);
    });

    it("rejects a linked scoped package", async () => {
      fs.renameSync(path.join(payload, "node_modules", "@paperclipai", "db"), path.join(outside, "db"));
      fs.symlinkSync(path.join(outside, "db"), path.join(payload, "node_modules", "@paperclipai", "db"));
      await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/must not contain linked files or packages.*@paperclipai\/db/);
    });
  });

  it("rejects a payload without any postgres driver", async () => {
    fs.rmSync(rootDriver(), { recursive: true });
    await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/contains no postgres driver/);
  });

  it("rejects a payload without a drizzle-orm postgres-js driver", async () => {
    fs.rmSync(path.join(payload, "node_modules", "drizzle-orm"), { recursive: true });
    await expect(verifyPostgresDriverPayload(payload, EXPECTED)).rejects.toThrow(/no drizzle-orm postgres-js driver/);
  });

  describe("payload driver record", () => {
    const recordPath = () => path.join(payload, POSTGRES_DRIVER_RECORD);
    const writeRecord = (record: unknown) => fs.writeFileSync(recordPath(), JSON.stringify(record));
    const hash = "a".repeat(64);

    it("round-trips the checkout expectation", () => {
      writePostgresDriverRecord(payload, EXPECTED);
      expect(readPostgresDriverRecord(payload)).toEqual(EXPECTED);
    });

    it("rejects a payload built without a record", () => {
      expect(() => readPostgresDriverRecord(payload)).toThrow(/has no \.paperclip-postgres-driver\.json; it predates patched driver packaging/);
    });

    it("rejects a record that is not JSON", () => {
      fs.writeFileSync(recordPath(), "{");
      expect(() => readPostgresDriverRecord(payload)).toThrow(/Cannot read postgres driver record/);
    });

    it.each<[string, unknown]>([
      ["an array", []],
      ["extra keys", { version: EXPECTED.version, files: {}, source: "x" }],
      ["no files", { version: EXPECTED.version }],
      ["no version", { files: {} }],
    ])("rejects a record with %s", (_label, record) => {
      writeRecord(record);
      expect(() => readPostgresDriverRecord(payload)).toThrow(/must contain exactly version and files/);
    });

    it("rejects an empty version", () => {
      writeRecord({ version: "", files: {} });
      expect(() => readPostgresDriverRecord(payload)).toThrow(/has no version/);
    });

    it("rejects a version that differs from the payload root driver", () => {
      writeRecord({ version: "3.4.10", files: {} });
      expect(() => readPostgresDriverRecord(payload)).toThrow(/names postgres@3\.4\.10, but the payload root driver differs/);
    });

    it("rejects files that are not an object", () => {
      writeRecord({ version: EXPECTED.version, files: ["src/index.js"] });
      expect(() => readPostgresDriverRecord(payload)).toThrow(/files must be an object/);
    });

    it.each(["../index.js", "/src/index.js", "./src/index.js", "src//index.js", "src/../index.js", "src\\index.js", ""])("rejects the unsafe record path %j", (file) => {
      writeRecord({ version: EXPECTED.version, files: { [file]: hash } });
      expect(() => readPostgresDriverRecord(payload)).toThrow(/unsafe file path/);
    });

    it.each(["A".repeat(64), "a".repeat(63), "g".repeat(64), 42])("rejects the invalid record hash %j", (value) => {
      writeRecord({ version: EXPECTED.version, files: { "src/index.js": value } });
      expect(() => readPostgresDriverRecord(payload)).toThrow(/invalid hash for src\/index\.js/);
    });
  });
});

describe("checkout postgres driver expectation", () => {
  let checkout: string;

  const writeJson = (file: string, value: unknown) => fs.writeFileSync(path.join(checkout, file), JSON.stringify(value));
  const patchConfig = (key = `postgres@${EXPECTED.version}`) => ({ pnpm: { patchedDependencies: { [key]: REPO_PATCH } } });
  const writeWorkspace = (body: string) => fs.writeFileSync(path.join(checkout, "pnpm-workspace.yaml"), body);

  beforeEach(() => {
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-postgres-checkout-"));
    fs.mkdirSync(path.join(checkout, "patches"));
    fs.copyFileSync(path.join(REPO_ROOT, REPO_PATCH), path.join(checkout, REPO_PATCH));
    fs.mkdirSync(path.join(checkout, "packages", "db", "node_modules"), { recursive: true });
    fs.cpSync(PATCHED_POSTGRES_SOURCE, path.join(checkout, "packages", "db", "node_modules", "postgres"), { recursive: true, dereference: true });
    writeJson("package.json", patchConfig());
  });

  afterEach(() => fs.rmSync(checkout, { recursive: true, force: true }));

  it("derives the version and patched file hashes from package.json patch configuration", () => {
    const expected = readCheckoutPostgresDriver(checkout);
    expect(expected).toEqual(EXPECTED);
    expect(Object.keys(expected.files).length).toBeGreaterThan(0);
  });

  it("derives the expectation from pnpm-workspace.yaml when package.json has no postgres patch", () => {
    writeJson("package.json", { name: "paperclip" });
    writeWorkspace(`packages:\n  - packages/*\npatchedDependencies:\n  embedded-postgres@1.0.0: patches/other.patch\n  postgres@${EXPECTED.version}: ${REPO_PATCH}\n`);
    expect(readCheckoutPostgresDriver(checkout)).toEqual(EXPECTED);
  });

  it("follows the driver a checkout actually installed rather than a fixed version", () => {
    const manifestPath = path.join(checkout, "packages", "db", "node_modules", "postgres", "package.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, "utf8")), version: "3.5.0" }));
    writeJson("package.json", patchConfig("postgres@3.5.0"));
    expect(readCheckoutPostgresDriver(checkout)).toEqual({ version: "3.5.0", files: EXPECTED.files });
  });

  it("returns no patched files for a checkout that truly does not patch postgres", () => {
    writeJson("package.json", { name: "paperclip", pnpm: { patchedDependencies: { "embedded-postgres@1.0.0": "patches/other.patch" } } });
    writeWorkspace("overrides:\n  postgres@3.4.8: patches/ignored.patch\npatchedDependencies:\n  embedded-postgres@1.0.0: patches/other.patch\n");
    expect(readCheckoutPostgresDriver(checkout)).toEqual({ version: EXPECTED.version, files: {} });
  });

  it("rejects a checkout without an installed driver", () => {
    fs.rmSync(path.join(checkout, "packages", "db", "node_modules", "postgres"), { recursive: true });
    expect(() => readCheckoutPostgresDriver(checkout)).toThrow(/no installed postgres driver/);
  });

  it("rejects a missing package.json instead of treating it as unpatched", () => {
    fs.rmSync(path.join(checkout, "package.json"));
    expect(() => readCheckoutPostgresDriver(checkout)).toThrow(/Cannot read checkout package\.json/);
  });

  it("rejects an invalid package.json instead of treating it as unpatched", () => {
    fs.writeFileSync(path.join(checkout, "package.json"), "{ not json");
    expect(() => readCheckoutPostgresDriver(checkout)).toThrow(/Cannot read checkout package\.json/);
  });

  it("rejects a package.json patch for a different postgres version", () => {
    writeJson("package.json", patchConfig("postgres@3.4.8"));
    expect(() => readCheckoutPostgresDriver(checkout)).toThrow(new RegExp(`postgres@3\\.4\\.8 do not match the installed postgres@${EXPECTED.version.replaceAll(".", "\\.")}`));
  });

  it("rejects a pnpm-workspace.yaml patch for a different postgres version", () => {
    writeJson("package.json", { name: "paperclip" });
    writeWorkspace(`patchedDependencies:\n  "postgres@3.4.8": ${REPO_PATCH}\n`);
    expect(() => readCheckoutPostgresDriver(checkout)).toThrow(/postgres@3\.4\.8 do not match the installed/);
  });

  it("rejects a configured patch file that does not exist", () => {
    fs.rmSync(path.join(checkout, REPO_PATCH));
    expect(() => readCheckoutPostgresDriver(checkout)).toThrow(/Checkout patch for postgres@.* is missing/);
  });

  it("rejects a patch without any diff headers", () => {
    fs.writeFileSync(path.join(checkout, REPO_PATCH), "--- a/src/index.js\n+++ b/src/index.js\n");
    expect(() => readCheckoutPostgresDriver(checkout)).toThrow(/lists no patched files/);
  });

  it("rejects a patch naming a file the installed driver does not have", () => {
    fs.appendFileSync(path.join(checkout, REPO_PATCH), "diff --git a/src/absent.js b/src/absent.js\n");
    expect(() => readCheckoutPostgresDriver(checkout)).toThrow(/missing patched file src\/absent\.js/);
  });
});
