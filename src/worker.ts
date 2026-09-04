import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { jobs, steps, stepAttempts } from "./db/schema";
import { handlers } from "./handlers";
import { claimJob, LEASE_SECONDS } from "./claim";
import { timeout } from "./timeout";

const workerId = `worker-${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/postgres",
  });
  await client.connect();

  try {
    const db = drizzle(client);

    while (true) {
      const job = await claimJob(db, workerId);

      if (!job) {
        console.log("No job to run");
        await sleep(2000);
        continue;
      }

      console.log("Running job:", job.id, job.name);

      // Keep the lease ahead of now() while we work. Stops the instant this
      // process dies, which is exactly what lets another worker take over.
      // ponytail: shares the worker's one connection, so a renewal issued
      // mid-transaction joins that transaction and is lost on rollback. The
      // next tick re-stamps it. Give the renewer its own Client if a step ever
      // holds a transaction open for more than a tick.
      const renew = setInterval(() => {
        db.execute(sql`
          UPDATE jobs
          SET lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
          WHERE id = ${job.id} AND locked_by = ${workerId}
        `).catch((err) => console.error("Lease renewal failed:", err));
      }, (LEASE_SECONDS / 3) * 1000);

      try {
        let stepFailed = false;

        while (true) {
          // ponytail: dependency check in JS, safe only because this worker holds
          // the job's lease. Move to the SQL NOT EXISTS predicate (DATA_MODEL §5)
          // when steps within one job run in parallel.
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

          const handler = handlers[step.handler as keyof typeof handlers];
          if (!handler) throw new Error(`Unknown handler: ${step.handler}`);

          console.log("Running step:", step.stepKey);
          const startedAt = new Date();
          // Only the race is guarded. The persist below stays outside the
          // catch, or a DB failure would read as a step failure.
          let result: Awaited<ReturnType<typeof handler>>;
          try {
            result = await Promise.race([
              handler(step.input),
              timeout(step.timeoutMs),
            ]);
          } catch (err) {
            // Detect only. 5.2 owns the reaction: attempts, backoff,
            // DEAD_LETTER, and the FAILED step_attempts row. Leaving the step
            // PENDING and breaking means the lease lapses and the job is
            // reclaimed -- still a poison pill, but one that no longer takes
            // the worker down with it.
            console.error(`Step failed: ${step.stepKey}`, err);
            stepFailed = true;
            break;
          }

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

          console.log("Committed step:", step.stepKey);
        }

        if (!stepFailed) {
          await db
            .update(jobs)
            .set({
              state: "COMPLETED",
              lockedBy: null,
              leaseExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(eq(jobs.id, job.id));

          console.log("Job completed:", job.id);
        }
      } finally {
        clearInterval(renew);
      }
    }
  } finally {
    await client.end();
  }
}

run();
