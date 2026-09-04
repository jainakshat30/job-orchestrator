import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { jobs, steps, stepAttempts } from "./db/schema";
import { handlers } from "./handlers";
import { claimJob, LEASE_SECONDS } from "./claim";
import { timeout } from "./timeout";
import { backoff } from "./backoff";

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

          console.log("Running step:", step.stepKey);
          const startedAt = new Date();
          // Everything that can fail *because of the step* goes in here: an
          // unknown handler, a handler that throws, a handler that runs long.
          // The persist below stays outside, or a DB failure would read as a
          // step failure and retry work that already succeeded.
          let result: Awaited<ReturnType<(typeof handlers)[keyof typeof handlers]>>;
          try {
            const handler = handlers[step.handler as keyof typeof handlers];
            if (!handler) throw new Error(`Unknown handler: ${step.handler}`);

            result = await Promise.race([
              handler(step.input),
              timeout(step.timeoutMs),
            ]);
          } catch (err) {
            // Anything is throwable in JS, so narrow before reaching for .message.
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Step failed: ${step.stepKey}`, err);

            // max_attempts counts total tries, not retries after the first, so
            // `<` is what makes maxAttempts=3 mean three executions.
            const attemptNo = step.attempts + 1;
            const retry = attemptNo < step.maxAttempts;
            const delay = backoff(attemptNo);

            // Both writes or neither. Split them and you either retry forever
            // with a counter stuck at 0, or lose the history behind a count.
            // ponytail: a throw in here escapes the step loop and takes the
            // worker with it -- a catch block does not catch itself. Left that
            // way on purpose: if the DB is unreachable, exiting loudly beats
            // dropping the history quietly.
            await db.transaction(async (tx) => {
              await tx.insert(stepAttempts).values({
                stepId: step.id,
                attemptNo,
                workerId,
                status: "FAILED",
                error: message,
                startedAt,
                finishedAt: new Date(),
              });

              // state is already PENDING -- steps never get marked RUNNING here,
              // the job's lease is what keeps a second worker off them. Set it
              // anyway: free inside this UPDATE, and right if that ever changes.
              await tx
                .update(steps)
                .set({
                  state: "PENDING",
                  attempts: attemptNo,
                  nextRunAt: retry ? new Date(Date.now() + delay) : null,
                })
                .where(eq(steps.id, step.id));
            });

            if (retry) {
              console.log(
                `Retrying ${step.stepKey} in ${delay}ms (attempt ${attemptNo}/${step.maxAttempts} failed)`,
              );
              // next_run_at is the durable copy of this wait; the sleep is just
              // this worker staying on the job instead of dropping the lease.
              // ponytail: parks the worker for the whole backoff. Release the
              // lease and re-claim instead if worker utilisation starts to bite.
              await sleep(delay);
              continue;
            }

            // Attempts exhausted. 5.3 turns this into DEAD_LETTER; until then
            // the lease just lapses and the job replays -- a poison pill, but
            // one with a full attempt history behind it now.
            console.error(
              `Step exhausted ${step.maxAttempts} attempts: ${step.stepKey}`,
            );
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
