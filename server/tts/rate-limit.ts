// A speech service answering 429. Flux allows 60 speech requests per account
// per 60 s, so a burst gets refused; one short wait and one more try is
// usually enough, and a second refusal is the owner's to hear about.

/** Pause before the single retry after a 429. */
export const RATE_LIMIT_RETRY_MS = 700;

export class RateLimitedError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** `retry-after` (seconds) as milliseconds, capped so a hostile or odd value
 *  can never park a call for long. */
export function retryAfterMs(header: string | null | undefined): number | undefined {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, 3_000);
}

/** Run `attempt`; on a 429, wait once and run it again. Any other failure,
 *  and a second 429, pass through. `wait` is a seam for tests. */
export async function retryOnRateLimit<T>(
  attempt: () => Promise<T>,
  { wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), onRetry }: { wait?: (ms: number) => Promise<void>; onRetry?: (ms: number) => void } = {},
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error;
    const ms = error.retryAfterMs ?? RATE_LIMIT_RETRY_MS;
    onRetry?.(ms);
    await wait(ms);
    return attempt();
  }
}
