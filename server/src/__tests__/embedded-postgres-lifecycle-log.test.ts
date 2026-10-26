import { describe, expect, it } from "vitest";
import { isEmbeddedPostgresLifecycleLine } from "../embedded-postgres-lifecycle-log.js";

describe("isEmbeddedPostgresLifecycleLine", () => {
  it.each([
    "2026-10-23 02:18:49.101 EDT [1364240] LOG:  received fast shutdown request",
    "2026-10-23 02:18:49.101 EDT [1364240] LOG:  received smart shutdown request",
    "2026-10-23 02:18:49.101 EDT [1364240] LOG:  received immediate shutdown request",
    "2026-10-23 02:18:50.300 EDT [1364240] LOG:  database system is shut down",
    "2026-10-23 02:19:06.010 EDT [1364300] LOG:  database system was shut down at 2026-10-23 02:18:50 EDT",
    "2026-10-23 02:19:06.010 EDT [1364300] LOG:  database system was not properly shut down; automatic recovery in progress",
    "2026-10-23 02:19:06.010 EDT [1364300] LOG:  database system was interrupted; last known up at 2026-10-23 02:18:50 EDT",
  ])("keeps %s", (line) => {
    expect(isEmbeddedPostgresLifecycleLine(line)).toBe(true);
  });

  it.each([
    "2026-10-23 02:01:14.477 EDT [1364240] LOG:  starting PostgreSQL 18.1 on x86_64-pc-linux-gnu",
    "2026-10-23 02:01:14.500 EDT [1364240] LOG:  checkpoint complete: wrote 3 buffers",
    "",
  ])("drops %s", (line) => {
    expect(isEmbeddedPostgresLifecycleLine(line)).toBe(false);
  });
});
