import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { isOwnExecutionReleaseMarker, ownExecutionReleaseMarkerSql } from "../services/run-execution-release-marker.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const runId = randomUUID();
const issueId = randomUUID();
const valid = { schema: "paperclip.run-execution-release.v1", runId, issueId, settledAt: "2026-10-28T00:00:00.000Z" };
const without = (key: keyof typeof valid) => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));

const cases: Array<[string, unknown, boolean]> = [
  ["the run's own marker", valid, true],
  ["an empty marker", {}, false],
  ["a marker without schema", without("schema"), false],
  ["a marker without runId", without("runId"), false],
  ["a marker without issueId", without("issueId"), false],
  ["a marker without settledAt", without("settledAt"), false],
  ["a JSON null marker", null, false],
  ["a marker for another run", { ...valid, runId: randomUUID() }, false],
  ["a marker for another task", { ...valid, issueId: randomUUID() }, false],
  ["a marker with another schema", { ...valid, schema: "paperclip.run-execution-release.v2" }, false],
  ["a marker with a non-string settledAt", { ...valid, settledAt: 1 }, false],
  ["a marker with an extra key", { ...valid, extra: true }, false],
  ["an array marker", [valid], false],
];

describeEmbeddedPostgres("ownExecutionReleaseMarkerSql", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-execution-release-marker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it.each(cases)("evaluates %s to a definite boolean that matches the JS check", async (_name, marker, expected) => {
    expect(isOwnExecutionReleaseMarker(marker, runId, issueId)).toBe(expected);
    const resultJson = sql`${JSON.stringify({ stopReason: "adapter_failed", executionReleased: marker })}::jsonb`;
    const [row] = await db.execute(sql`
      select ${ownExecutionReleaseMarkerSql(resultJson, sql`${runId}::uuid`, issueId)} as own,
        not exists (select 1 from jsonb_object_keys(${resultJson}) key
          where key not in ('stopReason')
            and not (key = 'executionReleased' and ${ownExecutionReleaseMarkerSql(resultJson, sql`${runId}::uuid`, issueId)})) as accepted
    `);
    expect(row).toEqual({ own: expected, accepted: expected });
  });

  it("evaluates a result without the marker to false", async () => {
    const [row] = await db.execute(sql`
      select ${ownExecutionReleaseMarkerSql(sql`'{"stopReason":"adapter_failed"}'::jsonb`, sql`${runId}::uuid`, issueId)} as own
    `);
    expect(row).toEqual({ own: false });
  });
});
