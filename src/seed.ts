import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { jobs, steps } from "./db/schema";

const definition = {
  name: "user-onboarding",
  steps: [
    {
      id: "create_account",
      handler: "createAccount",
      input: { email: "sam@example.com" },
      dependsOn: [],
      maxAttempts: 3,
      timeoutMs: 5000,
    },
    {
      id: "send_welcome_email",
      handler: "sendEmail",
      input: { template: "welcome" },
      dependsOn: ["create_account"],
      maxAttempts: 5,
      timeoutMs: 10000,
    },
    {
      id: "add_to_crm",
      handler: "addToCrm",
      input: {},
      dependsOn: ["create_account"],
      maxAttempts: 3,
      timeoutMs: 8000,
    },
  ],
};

async function seed() {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/postgres",
  });
  await client.connect();
  const db = drizzle(client);

  const [job] = await db
    .insert(jobs)
    .values({ name: definition.name, definition })
    .returning();

  await db.insert(steps).values(
    definition.steps.map((s) => ({
      jobId: job.id,
      stepKey: s.id,
      handler: s.handler,
      input: s.input,
      dependsOn: s.dependsOn,
      maxAttempts: s.maxAttempts,
      timeoutMs: s.timeoutMs,
    })),
  );

  console.log("Seeded job:", job.id);
  await client.end();
}

seed();
