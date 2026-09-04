/**
 * A promise that never resolves and rejects after `ms`.
 *
 * Meant to be raced against the real work:
 *   await Promise.race([handler(step.input), timeout(step.timeoutMs)])
 *
 * Typed `Promise<never>` on purpose: the race then takes its type from the
 * handler alone instead of widening to a union with this one's result.
 *
 * Keep `timeoutMs` shorter than LEASE_SECONDS (ARCHITECTURE §3C), or a step
 * can outlive its own lease.
 */
export function timeout(ms: number): Promise<never> {
  // ponytail: Promise.race abandons the loser but does not cancel it, so this
  // timer stays armed until it fires even when the handler wins the race.
  // Harmless at one step per worker; return the handle and clearTimeout it if
  // the pending timers ever pile up.
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Step timed out after ${ms}ms`)), ms),
  );
}
