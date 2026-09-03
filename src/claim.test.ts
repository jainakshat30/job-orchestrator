import assert from "node:assert/strict";
import { Client } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { claimJob, type ClaimedJob } from "./claim";

const URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";

// This test TRUNCATEs jobs. Refuse to point it at anything but a local dev db.
assert.ok(
  /@(localhost|127\.0\.0\.1)[:\/]/.test(URL),
  `refusing to truncate a non-local database: ${URL}`,
);

const connect = async () => {
  const c = new Client({ connectionString: URL });
  await c.connect();
  return c;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WORKERS = 6;
const ROUNDS = 15;

async function reset(db: NodePgDatabase) {
  await db.execute(sql`TRUNCATE jobs CASCADE`);
  await db.execute(sql`
    INSERT INTO jobs (name, definition)
    SELECT 'job-' || i, '{}'::jsonb FROM generate_series(1, ${WORKERS}) AS i
  `);
}

async function main() {
  const setup = await connect();
  const db = drizzle(setup);

  // Each claimer needs its OWN connection. Row locks are held per transaction
  // and one pg Client is one connection, so sharing would serialise the claims
  // and prove nothing about concurrency.
  const clients = await Promise.all(
    Array.from({ length: WORKERS }, () => connect()),
  );

  // 1. SKIP LOCKED, deterministically: hold a lock on the oldest job in an open
  //    transaction. A correct claim steps over it and takes a different row.
  //    Without SKIP LOCKED this call blocks until the holder commits.
  await reset(db);
  const holder = await connect();
  await holder.query("BEGIN");
  const { rows: held } = await holder.query(
    "SELECT id FROM jobs ORDER BY created_at LIMIT 1 FOR UPDATE",
  );
  const blocked = await Promise.race([
    claimJob(drizzle(clients[0]), "worker-skip"),
    sleep(2000).then(() => "TIMED_OUT" as const),
  ]);
  assert.notEqual(blocked, "TIMED_OUT", "claim blocked on a locked row - SKIP LOCKED missing");
  assert.ok(blocked !== null, "claim found no job even though 5 were free");
  assert.notEqual((blocked as ClaimedJob).id, held[0].id, "claim took a row another txn had locked");
  await holder.query("ROLLBACK");
  await holder.end();

  // 2. select-and-stamp is one transaction. Claimers are staggered by ~a round
  //    trip so a split implementation's SELECT lands inside another's
  //    select->stamp window and both see the same unstamped row.
  for (let round = 0; round < ROUNDS; round++) {
    await reset(db);

    const results = await Promise.all(
      clients.map(async (c, i) => {
        await sleep(i * 0.4);
        return claimJob(drizzle(c), `worker-${i}`);
      }),
    );

    const claimed = results.filter((r): r is ClaimedJob => r !== null);
    const ids = new Set(claimed.map((j) => j.id));
    assert.equal(
      ids.size,
      claimed.length,
      `round ${round}: ${claimed.length} claims covered only ${ids.size} distinct jobs - two workers got the same job`,
    );
    assert.equal(claimed.length, WORKERS, `round ${round}: expected ${WORKERS} claims, got ${claimed.length}`);

    const { rows } = await db.execute(sql`
      SELECT locked_by, state, lease_expires_at > now() AS leased FROM jobs
    `);
    assert.ok(
      rows.every((r) => r.locked_by !== null && r.state === "RUNNING" && r.leased === true),
      `round ${round}: claim did not stamp every row: ${JSON.stringify(rows)}`,
    );
  }

  await Promise.all([...clients, setup].map((c) => c.end()));
  console.log(
    `ok - skips externally locked rows; ${WORKERS} staggered workers x ${ROUNDS} rounds claimed distinct jobs, all stamped and leased`,
  );
}

main();
