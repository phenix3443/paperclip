import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// The runtime read must finish its directory walks and content hashes before it takes the company-wide skill cache
// lock, and a read of an unchanged directory must not read file contents at all.
const lockAcquiredAt: number[] = [];
vi.mock("../services/skill-version-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/skill-version-cache.js")>();
  return {
    ...actual,
    withSkillVersionCacheLock: (db: unknown, companyId: string, action: () => Promise<unknown>, tryOnly?: boolean) =>
      actual.withSkillVersionCacheLock(db as never, companyId, async () => {
        lockAcquiredAt.push(performance.now());
        return action();
      }, tryOnly),
  };
});
const { companySkillService } = await import("../services/company-skills.js");

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("runtime skill reads and the skill cache lock", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runtime-skill-lock-scope-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-skill-lock-scope-"));
    process.env.PAPERCLIP_HOME = home;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it("hashes an installed skill before the lock and reads no contents again while the directory is unchanged", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lock scope readers", issuePrefix: `LS${companyId.slice(0, 6)}` });
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Lock scope skill" });
    const locator = path.resolve(skill.sourceLocator!);
    const directory = path.basename(locator) === "SKILL.md" ? path.dirname(locator) : locator;
    await fs.writeFile(path.join(directory, "notes.md"), "first\n");
    const inDirectory = (target: unknown) => typeof target === "string" && target.startsWith(directory + path.sep);
    const originalReadFile = fs.readFile.bind(fs);
    const readsAt: number[] = [];
    vi.spyOn(fs, "readFile").mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
      if (inDirectory(args[0])) readsAt.push(performance.now());
      return originalReadFile(...args);
    }) as typeof fs.readFile);
    const read = () => service.listRuntimeSkillEntries(companyId, { onlyKeys: new Set([skill.key]), snapshotLatest: true });
    try {
      lockAcquiredAt.length = 0;
      const [first] = await read();
      expect(first).toMatchObject({ key: skill.key, sourceStatus: "available" });
      expect(first!.versionId).toBeTruthy();
      expect(readsAt.length).toBeGreaterThan(0);
      expect(lockAcquiredAt.length).toBeGreaterThan(0);
      expect(Math.max(...readsAt)).toBeLessThan(Math.min(...lockAcquiredAt));

      readsAt.length = 0;
      const [second] = await read();
      expect(second!.versionId).toBe(first!.versionId);
      expect(readsAt).toEqual([]);

      await fs.writeFile(path.join(directory, "notes.md"), "second\n");
      const [third] = await read();
      expect(third!.versionId).not.toBe(first!.versionId);
      expect(readsAt.length).toBeGreaterThan(0);
    } finally {
      vi.restoreAllMocks();
    }
  }, 60_000);
});
