import assert from "node:assert";
import { Client } from "pg";
import { chargeCard } from "./handlers";
import { closeGateway } from "./payments";

const KEY = "step-11111111-1111-1111-1111-111111111111";
const OTHER_KEY = "step-22222222-2222-2222-2222-222222222222";

async function main() {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/postgres",
  });
  await client.connect();

  const countFor = async (key: string) => {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM charges WHERE idempotency_key = $1",
      [key],
    );
    return rows[0].n as number;
  };

  await client.query("DELETE FROM charges WHERE idempotency_key = ANY($1)", [
    [KEY, OTHER_KEY],
  ]);

  // The whole point: this is what a retried step looks like from the gateway's
  // side. Same input, same key, twice.
  const first = await chargeCard({ amountCents: 4900 }, { idempotencyKey: KEY });
  const second = await chargeCard({ amountCents: 4900 }, { idempotencyKey: KEY });

  assert.equal(
    second.chargeId,
    first.chargeId,
    `retry created a different charge: ${first.chargeId} then ${second.chargeId}`,
  );
  assert.equal(second.amountCents, first.amountCents);
  assert.equal(await countFor(KEY), 1, "a second charge row was created");

  // Repeats keep returning the original rather than drifting. Sequential on
  // purpose: these share the gateway's single connection, so running them
  // through Promise.all would only look concurrent. What protects a genuine
  // race is the UNIQUE constraint -- Postgres rejects the second insert of a
  // key no matter which connection it arrives on.
  for (let i = 0; i < 5; i++) {
    const repeat = await chargeCard({ amountCents: 4900 }, { idempotencyKey: KEY });
    assert.equal(
      repeat.chargeId,
      first.chargeId,
      `repeat ${i + 1} disagreed on the charge id`,
    );
  }
  assert.equal(await countFor(KEY), 1, "repeated calls created extra rows");

  // A different step is a different key, and must still be able to charge.
  const other = await chargeCard(
    { amountCents: 4900 },
    { idempotencyKey: OTHER_KEY },
  );
  assert.notEqual(
    other.chargeId,
    first.chargeId,
    "a different key reused an existing charge - dedup is too aggressive",
  );
  assert.equal(await countFor(OTHER_KEY), 1);

  await client.query("DELETE FROM charges WHERE idempotency_key = ANY($1)", [
    [KEY, OTHER_KEY],
  ]);
  await client.end();
  await closeGateway();

  console.log(
    "ok - same key charges once across 7 calls, different key still charges",
  );
}

main();
