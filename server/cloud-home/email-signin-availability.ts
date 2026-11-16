import { z } from "zod";

/** Thirty seconds bounds how long a lost supervisor update can keep the offer visible. */
export const EMAIL_SIGNIN_TTL_MS = 30_000;
export const EMAIL_SIGNIN_AVAILABILITY = "murage:email-owner-signin-availability";
export const emailSigninAvailability = z.object({
  type: z.literal(EMAIL_SIGNIN_AVAILABILITY), available: z.boolean(),
  ttlMs: z.number().int().min(0).max(EMAIL_SIGNIN_TTL_MS),
}).strict().refine(value => value.available ? value.ttlMs > 0 : value.ttlMs === 0);

/** The private port is the only input. A stale, absent or malformed report cannot open the offer. */
export function createCloudEmailAvailability(now: () => number = () => performance.now(), onChange: () => void = () => {}) {
  let until = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    receive(message: unknown): boolean {
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== EMAIL_SIGNIN_AVAILABILITY) return false;
      const parsed = emailSigninAvailability.safeParse(message);
      if (timer) clearTimeout(timer);
      until = parsed.success && parsed.data.available ? now() + parsed.data.ttlMs : 0;
      if (until > now()) {
        timer = setTimeout(() => { until = 0; onChange(); }, until - now()); timer.unref?.();
      }
      onChange();
      return true;
    },
    available: () => until > now(),
    remainingMs: () => Math.max(0, Math.floor(until - now())),
    dispose() { if (timer) clearTimeout(timer); until = 0; },
  };
}
