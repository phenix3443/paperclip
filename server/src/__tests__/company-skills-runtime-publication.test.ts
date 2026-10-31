import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companyMemberships, companySkills, companySkillSources, companies, projectAccessMembers, projects, projectSkillSources, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { withSkillActor } from "../services/skill-access.js";
import { eq, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let beforeLock: (() => Promise<void>) | undefined;
vi.mock("../services/skill-version-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/skill-version-cache.js")>();
  return { ...actual, withSkillVersionCacheLock: async (...args: Parameters<typeof actual.withSkillVersionCacheLock>) => {
    const barrier = beforeLock;
    beforeLock = undefined;
    await barrier?.();
    return actual.withSkillVersionCacheLock(...args);
  } };
});
const { companySkillService } = await import("../services/company-skills.js");
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("runtime publication revalidation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runtime-publication-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-publication-"));
    process.env.PAPERCLIP_HOME = home;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  afterEach(() => { beforeLock = undefined; });
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Runtime fixture", issuePrefix: `RF${companyId.slice(0, 6)}` });
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Runtime skill" });
    const directory = path.basename(skill.sourceLocator!) === "SKILL.md" ? path.dirname(skill.sourceLocator!) : skill.sourceLocator!;
    await fs.writeFile(path.join(directory, "notes.md"), "OLD\n");
    return { companyId, service, skill, directory, options: { onlyKeys: new Set([skill.key]), snapshotLatest: true } };
  }
  it("concurrent identical captures publish only one version", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Publication fixture", issuePrefix: `RP${companyId.slice(0, 6)}` });
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Publication skill" });
    const directory = path.basename(skill.sourceLocator!) === "SKILL.md" ? path.dirname(skill.sourceLocator!) : skill.sourceLocator!;
    await fs.writeFile(path.join(directory, "notes.md"), "OLD\n");
    const options = { onlyKeys: new Set([skill.key]), snapshotLatest: true };
    const initial = await service.listVersions(companyId, skill.id);
    let competing: Awaited<ReturnType<typeof service.listRuntimeSkillEntries>> = [];
    beforeLock = async () => { competing = await service.listRuntimeSkillEntries(companyId, options); };
    const entries = await service.listRuntimeSkillEntries(companyId, options);
    expect(entries[0]!.versionId).toBe(competing[0]!.versionId);
    expect(await service.listVersions(companyId, skill.id)).toHaveLength(initial.length + 1);
  }, 60_000);
  it("reprepares a directory changed without advancing the version", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Directory fixture", issuePrefix: `RD${companyId.slice(0, 6)}` });
    const service = companySkillService(db);
    const skill = await service.createLocalSkill(companyId, { name: "Directory skill" });
    const directory = path.basename(skill.sourceLocator!) === "SKILL.md" ? path.dirname(skill.sourceLocator!) : skill.sourceLocator!;
    await fs.writeFile(path.join(directory, "notes.md"), "OLD\n");
    const replacement = path.join(home, randomUUID());
    await fs.cp(directory, replacement, { recursive: true });
    await fs.writeFile(path.join(replacement, "notes.md"), "NEW\n");
    beforeLock = async () => { await db.update(companySkills).set({ sourceLocator: replacement }).where(eq(companySkills.id, skill.id)); };
    const [entry] = await service.listRuntimeSkillEntries(companyId, { onlyKeys: new Set([skill.key]), snapshotLatest: true });
    expect(await fs.readFile(path.join(entry!.source, "notes.md"), "utf8")).toBe("NEW\n");
  }, 60_000);

  it("keeps NEW when an OLD capture acquires the lock after NEW was published", async () => {
    const f = await fixture();
    const initial = await f.service.listVersions(f.companyId, f.skill.id);
    let latest: string | null | undefined;
    beforeLock = async () => {
      await fs.writeFile(path.join(f.directory, "notes.md"), "NEW\n");
      latest = (await f.service.listRuntimeSkillEntries(f.companyId, f.options))[0]!.versionId;
    };
    const [entry] = await f.service.listRuntimeSkillEntries(f.companyId, f.options);
    expect(entry!.versionId).toBe(latest);
    expect(await fs.readFile(path.join(entry!.source, "notes.md"), "utf8")).toBe("NEW\n");
    expect(await f.service.listVersions(f.companyId, f.skill.id)).toHaveLength(initial.length + 1);
  });

  it("reprepares source type, ref and metadata changes, including a second change", async () => {
    const f = await fixture();
    const replacement = path.join(home, randomUUID());
    await fs.cp(f.directory, replacement, { recursive: true });
    await fs.writeFile(path.join(replacement, "notes.md"), "NEW\n");
    const changeAgain = async () => {
      await db.update(companySkills).set({ sourceLocator: replacement, sourceRef: "next" }).where(eq(companySkills.id, f.skill.id));
    };
    beforeLock = async () => {
      await db.update(companySkills).set({ sourceType: "catalog", sourceRef: "changed", metadata: { sourceKind: "fixture" } }).where(eq(companySkills.id, f.skill.id));
      beforeLock = changeAgain;
    };
    const consume = vi.fn((entries: Awaited<ReturnType<typeof f.service.listRuntimeSkillEntries>>) => entries);
    const [entry] = await f.service.withRuntimeSkillEntries(f.companyId, f.options, consume);
    expect(await fs.readFile(path.join(entry!.source, "notes.md"), "utf8")).toBe("NEW\n");
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("checks public-to-restricted access for latest, unversioned and pinned selections", async () => {
    const f = await fixture();
    const readers = await db.insert(agents).values(["Allowed", "Denied"].map(name => ({ companyId: f.companyId, name, adapterType: "codex_local" }))).returning();
    await db.insert(companyMemberships).values(readers.map(reader => ({ companyId: f.companyId, principalType: "agent", principalId: reader.id, membershipRole: "member" })));
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Private", visibility: "private" }).returning();
    const [source] = await db.insert(companySkillSources).values({ companyId: f.companyId, repositoryUrl: "https://github.com/fixture/runtime", fullName: "fixture/runtime", trackingRef: "main", accessScope: "projects" }).returning();
    await db.insert(projectSkillSources).values({ companyId: f.companyId, projectId: project!.id, sourceId: source!.id, repositoryUrl: source!.repositoryUrl, trackingRef: "main", status: "ready" });
    await db.insert(projectAccessMembers).values({ companyId: f.companyId, projectId: project!.id, subjectType: "agent", subjectId: readers[0]!.id });
    const initial = await f.service.listVersions(f.companyId, f.skill.id);
    const modes = [f.options, { ...f.options, snapshotLatest: false }, { ...f.options, versionSelections: new Map([[f.skill.key, f.skill.currentVersionId!]]) }];
    for (const options of modes) {
      await db.update(companySkills).set({ accessSourceId: null }).where(eq(companySkills.id, f.skill.id));
      beforeLock = async () => { await db.update(companySkills).set({ accessSourceId: source!.id }).where(eq(companySkills.id, f.skill.id)); };
      const denied = await withSkillActor({ type: "agent", companyId: f.companyId, agentId: readers[1]!.id, source: "agent_jwt" }, () => f.service.listRuntimeSkillEntries(f.companyId, options));
      expect(denied).toEqual([]);
      expect(await f.service.listVersions(f.companyId, f.skill.id)).toHaveLength(initial.length);
    }
    const allowed = await withSkillActor({ type: "agent", companyId: f.companyId, agentId: readers[0]!.id, source: "agent_jwt" }, () => f.service.listRuntimeSkillEntries(f.companyId, f.options));
    expect(allowed.map(entry => entry.key)).toEqual([f.skill.key]);
    expect(allowed[0]!.sourceStatus).toBe("available");
  });

  it("fails after three changing preparations without partial publication or consumption", async () => {
    const f = await fixture();
    const second = await f.service.createLocalSkill(f.companyId, { name: "Second skill" });
    const initial = await f.service.listVersions(f.companyId, f.skill.id);
    let changes = 0;
    const mutate = async () => {
      await db.update(companySkills).set({ sourceRef: String(++changes) }).where(eq(companySkills.id, second.id));
      beforeLock = mutate;
    };
    beforeLock = mutate;
    const consume = vi.fn();
    try {
      await expect(f.service.withRuntimeSkillEntries(f.companyId, { ...f.options, onlyKeys: new Set([f.skill.key, second.key]) }, consume)).rejects.toMatchObject({ status: 409 });
      expect(changes).toBe(3);
      expect(consume).not.toHaveBeenCalled();
      expect(await f.service.listVersions(f.companyId, f.skill.id)).toHaveLength(initial.length);
    } finally { beforeLock = undefined; }
  });

  it("keeps company isolation, deleted and empty selections, and consumer errors", async () => {
    const f = await fixture();
    const other = await fixture();
    expect(await f.service.listRuntimeSkillEntries(other.companyId, f.options)).toEqual([]);
    expect(await f.service.listRuntimeSkillEntries(f.companyId, { onlyKeys: new Set() })).toEqual([]);
    const consume = vi.fn(() => { throw new Error("consumer failed"); });
    await expect(f.service.withRuntimeSkillEntries(f.companyId, f.options, consume)).rejects.toThrow("consumer failed");
    expect(consume).toHaveBeenCalledTimes(1);
    beforeLock = async () => { await db.delete(companySkills).where(eq(companySkills.id, f.skill.id)); };
    expect(await f.service.listRuntimeSkillEntries(f.companyId, f.options)).toEqual([]);
  });

  it("rolls back earlier snapshots if a later version publication fails", async () => {
    const f = await fixture();
    const second = await f.service.createLocalSkill(f.companyId, { name: "Second skill" });
    const directory = path.basename(second.sourceLocator!) === "SKILL.md" ? path.dirname(second.sourceLocator!) : second.sourceLocator!;
    await fs.writeFile(path.join(directory, "notes.md"), "SECOND\n");
    const initial = await f.service.listVersions(f.companyId, f.skill.id);
    await db.execute(sql`create function reject_runtime_publication() returns trigger language plpgsql as $$ begin raise exception 'fixture rejected version'; end $$`);
    await db.execute(sql.raw(`create trigger reject_runtime_publication before insert on company_skill_versions for each row when (new.company_skill_id = '${second.id}'::uuid) execute function reject_runtime_publication()`));
    const consume = vi.fn();
    try {
      await expect(f.service.withRuntimeSkillEntries(f.companyId, { ...f.options, onlyKeys: new Set([f.skill.key, second.key]) }, consume)).rejects.toMatchObject({ cause: { message: "fixture rejected version" } });
      expect(await f.service.listVersions(f.companyId, f.skill.id)).toHaveLength(initial.length);
      expect(consume).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`drop trigger reject_runtime_publication on company_skill_versions`);
      await db.execute(sql`drop function reject_runtime_publication()`);
    }
  });

  it("preserves no-current-version, missing-directory and missing-version results", async () => {
    const f = await fixture();
    await db.update(companySkills).set({ currentVersionId: null }).where(eq(companySkills.id, f.skill.id));
    const [captured] = await f.service.listRuntimeSkillEntries(f.companyId, f.options);
    expect(captured).toMatchObject({ sourceStatus: "available" });
    expect(captured!.versionId).toBeTruthy();
    await fs.rm(f.directory, { recursive: true, force: true });
    const [restored] = await f.service.listRuntimeSkillEntries(f.companyId, f.options);
    expect(restored).toMatchObject({ versionId: captured!.versionId, sourceStatus: "available" });
    const [missing] = await f.service.listRuntimeSkillEntries(f.companyId, { ...f.options, versionSelections: new Map([[f.skill.key, randomUUID()]]) });
    expect(missing).toMatchObject({ sourceStatus: "missing", missingDetail: "The selected skill version no longer exists." });
  });

});
