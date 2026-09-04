import {
    pgTable,
    uuid,
    text,
    jsonb,
    integer,
    timestamp,
    index,
    unique,
} from "drizzle-orm/pg-core";

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    name: text("name").notNull(),

    definition: jsonb("definition").notNull(),

    state: text("state").notNull().default("PENDING"),

    lockedBy: text("locked_by"),

    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_jobs_claimable").on(table.state, table.leaseExpiresAt),
  ],
);

export const steps = pgTable(
  "steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, {
        onDelete: "cascade",
      }),

    stepKey: text("step_key").notNull(),

    handler: text("handler").notNull(),

    input: jsonb("input")
      .notNull()
      .default({}),

    dependsOn: jsonb("depends_on")
      .notNull()
      .default([]),

    state: text("state")
      .notNull()
      .default("PENDING"),

    result: jsonb("result"),

    attempts: integer("attempts")
      .notNull()
      .default(0),

    maxAttempts: integer("max_attempts")
      .notNull()
      .default(3),

    timeoutMs: integer("timeout_ms")
      .notNull()
      .default(5000),

    nextRunAt: timestamp("next_run_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    unique("steps_job_id_step_key_unique").on(
      table.jobId,
      table.stepKey,
    ),

    index("idx_steps_job").on(
      table.jobId,
      table.state,
    ),
  ],
);

export const stepAttempts = pgTable(
  "step_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    stepId: uuid("step_id")
      .notNull()
      .references(() => steps.id, {
        onDelete: "cascade",
      }),

    attemptNo: integer("attempt_no").notNull(),

    workerId: text("worker_id").notNull(),

    status: text("status").notNull(),

    error: text("error"),

    startedAt: timestamp("started_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    finishedAt: timestamp("finished_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    index("idx_attempts_step").on(table.stepId),
  ],
);

/**
 * Stand-in for an external payment gateway's own storage. Lives in our database
 * for convenience, but the point is that it sits on the far side of a boundary:
 * the UNIQUE constraint below is what refuses a double charge, not anything the
 * orchestrator remembers about its own retries.
 */
export const charges = pgTable("charges", {
  id: uuid("id").primaryKey().defaultRandom(),

  idempotencyKey: text("idempotency_key").notNull().unique(),

  amountCents: integer("amount_cents").notNull(),

  createdAt: timestamp("created_at", {
    withTimezone: true,
  })
    .notNull()
    .defaultNow(),
});
