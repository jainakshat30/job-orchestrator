import assert from "node:assert";
import { backoff } from "./backoff";

const RUNS = 500;

// [attempt, floor] -- ceiling is floor + 500 (the jitter window).
for (const [attempt, floor] of [[1, 1000], [2, 2000], [3, 4000], [4, 8000]]) {
  const seen = new Set<number>();
  for (let i = 0; i < RUNS; i++) {
    const d = backoff(attempt);
    assert.ok(
      d >= floor && d < floor + 501,
      `backoff(${attempt}) = ${d}, expected [${floor}, ${floor + 500}]`,
    );
    seen.add(d);
  }
  assert.ok(seen.size > 1, `backoff(${attempt}) never varied - jitter is a no-op`);
}

// The overflow regression: a huge attempt must hit the cap, not wrap to ~0.
for (const attempt of [22, 50, 1000]) {
  const d = backoff(attempt);
  assert.ok(
    d >= 30_000 && d <= 30_500,
    `backoff(${attempt}) = ${d}, expected the 30s cap - 2**n overflowed setTimeout`,
  );
}

console.log("ok - exponential curve, jitter within 500ms, capped at 30s");
