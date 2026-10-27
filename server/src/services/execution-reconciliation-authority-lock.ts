import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function lockExecutionReconciliationAuthority(
  tx: DbOrTransaction,
  companyId: string,
  mode: "shared" | "exclusive",
) {
  const key = `exec-recon-authority:${companyId}`;
  await tx.execute(mode === "shared"
    ? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
    : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
