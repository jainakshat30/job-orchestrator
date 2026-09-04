const BASE_DELAY_MS = 1000;
// setTimeout overflows its 32-bit field past 2147483647ms and fires
// immediately, turning the longest backoff into no backoff at all. Unreachable
// at today's max_attempts, capped anyway -- nothing wants a retry in 17 days.
const MAX_DELAY_MS = 30_000;

/** Delay before retrying, given the 1-based number of the attempt that just failed. */
export function backoff(attemptNumber: number): number {
  const delay = Math.min(BASE_DELAY_MS * 2 ** (attemptNumber - 1), MAX_DELAY_MS);

  // Jitter is for the herd, not for this job: without it, every job that failed
  // in the same outage retries on the same millisecond and re-breaks whatever
  // just came back up.
  // ponytail: fixed 500ms spread stops meaning much once the delay is 30s and
  // the fleet is large. Swap to full jitter (Math.random() * delay) then.
  return Math.round(delay + Math.random() * 500);
}
