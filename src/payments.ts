import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { charges } from "./db/schema";

export type Charge = typeof charges.$inferSelect;

// Its own connection on purpose. This is meant to read as a service we call,
// not as more of the orchestrator's bookkeeping -- the guarantee has to hold
// even when our own records of what we ran are wrong.
// ponytail: a real gateway is a network hop with retries and timeouts of its
// own. A table and a connection is enough to make the dedup real.
let client: Client | undefined;

function gateway() {
  if (!client) {
    client = new Client({
      connectionString:
        process.env.DATABASE_URL ??
        "postgres://postgres:postgres@localhost:5432/postgres",
    });
    client.connect();
  }
  return drizzle(client);
}

/**
 * Charge a card, at most once per idempotency key.
 *
 * The insert is the whole mechanism: the UNIQUE constraint on idempotency_key
 * makes a second insert with the same key a no-op, and the select afterwards
 * returns whatever the first call created. Two callers racing on the same key
 * both leave with the same charge because only one row can ever exist.
 */
export async function charge(
  amountCents: number,
  idempotencyKey: string,
): Promise<Charge> {
  const db = gateway();

  await db
    .insert(charges)
    .values({ idempotencyKey, amountCents })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(charges)
    .where(eq(charges.idempotencyKey, idempotencyKey));

  return row;
}

/** Only needed by short-lived scripts; the worker holds this open for its life. */
export async function closeGateway() {
  await client?.end();
  client = undefined;
}
