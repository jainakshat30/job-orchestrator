import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import { jobs, steps, stepAttempts } from "./db/schema";
import { handlers } from "./handlers";

const workerId = `worker-${process.pid}`;

async function run() {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/postgres",
  });
  await client.connect();
  const db = drizzle(client);

  const [job] = await db
    .select()
    .from(jobs)
    .where(inArray(jobs.state, ["PENDING", "RUNNING"]))
    .limit(1);

  if (!job) {
    console.log("No job to run");
    await client.end();
    return;
  }

  console.log("Running job:", job.id, job.name);

  while (true) {
    // ponytail: dependency check in JS, safe only because nothing else touches
    // these rows yet. Move to the SQL NOT EXISTS predicate (DATA_MODEL §5) once
    // Phase 4 claiming lets two workers race for the same job.
    const jobSteps = await db.select().from(steps).where(eq(steps.jobId, job.id));
    const succeeded = new Set(
      jobSteps.filter((s) => s.state === "SUCCEEDED").map((s) => s.stepKey),
    );

    const step = jobSteps.find(
      (s) =>
        s.state === "PENDING" &&
        (s.dependsOn as string[]).every((dep) => succeeded.has(dep)),
    );

    if (!step) break;

    console.log("Running step:", step.stepKey);
    const startedAt = new Date();
    const result = await handlers[step.handler as keyof typeof handlers](step.input);

    await db.transaction(async (tx) => {
      await tx.insert(stepAttempts).values({
        stepId: step.id,
        attemptNo: step.attempts + 1,
        workerId,
        status: "SUCCEEDED",
        startedAt,
        finishedAt: new Date(),
      });

      await tx
        .update(steps)
        .set({ state: "SUCCEEDED", result, attempts: step.attempts + 1 })
        .where(eq(steps.id, step.id));
    });
  }

  await db
    .update(jobs)
    .set({ state: "COMPLETED", updatedAt: new Date() })
    .where(eq(jobs.id, job.id));

  console.log("Job completed:", job.id);
  await client.end();
}

run();
