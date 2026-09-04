import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * How long a claim is good for. Must stay LONGER than any single step's
 * timeoutMs (ARCHITECTURE §3C) or the lease expires mid-run and a second
 * worker walks in on a step that is still executing.
 */
export const LEASE_SECONDS = 30;

export type ClaimedJob = { id: string; name: string };

/**
 * Claim one runnable job for `workerId`, atomically.
 *
 * FOR UPDATE SKIP LOCKED takes a row-level write lock on the chosen row and
 * steps over rows other workers already hold, so N concurrent workers claim N
 * different jobs instead of fighting over one. The stamp runs in the same
 * transaction as the select, so the row is never observable as
 * selected-but-unclaimed: both statements commit, or neither does.
 */
export async function claimJob(
  db: NodePgDatabase,
  workerId: string,
): Promise<ClaimedJob | null> {
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      SELECT id, name FROM jobs
      -- Whitelist on purpose. A dead-lettered job has its lease cleared, so
      -- the lease predicate below waves it through; this list is the only
      -- thing keeping it out. Never loosen to state <> something.
      WHERE state IN ('PENDING', 'RUNNING')
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);

    const job = found.rows[0] as ClaimedJob | undefined;
    if (!job) return null;

    await tx.execute(sql`
      UPDATE jobs
      SET locked_by = ${workerId},
          lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}),
          state = 'RUNNING',
          updated_at = now()
      WHERE id = ${job.id}
    `);

    return job;
  });
}
