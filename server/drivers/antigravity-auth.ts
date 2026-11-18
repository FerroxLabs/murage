// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One classifier for "agy refused for its sign-in" (AGY-ON-CLOUD design section 4 item 4), two tiers.
//
// Tier 1, the structured result path: only a provider-owned code or status decides. `error.code`, `error.status` or `error.type`
// equal to UNAUTHENTICATED or invalid_grant, or an HTTP status of 401, on the error or on any entry of `error.details[]`. The `message`
// of a result is prose and is never matched. PERMISSION_DENIED is not tier 1 until a fixture from the pinned CLI names a specific reason.
//
// Tier 2, stderr of an early exit that sent no structured result: a phrase matcher anchored on word boundaries. Bare `oauth`, `401`,
// `403` and `unauthorized` are dropped on purpose (a tool's own HTTP 401 or 403 is not a sign-in failure). Assistant and tool prose
// never reaches this function.
const PROVIDER_AUTH_CODES = new Set(["unauthenticated", "invalid_grant"]);
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const ownedAuthCode = (entry: Record<string, unknown> | undefined): boolean => {
  if (!entry) return false;
  for (const key of ["code", "status", "type", "reason"] as const) {
    const value = entry[key];
    if (typeof value === "string" && PROVIDER_AUTH_CODES.has(value.trim().toLowerCase())) return true;
    if (key !== "reason" && value === 401) return true;
  }
  return entry.http_status === 401 || entry.httpStatus === 401 || entry.status_code === 401;
};

/** Tier 1. `payload` is agy's structured `result` line. */
export function agyAuthFromResult(payload: unknown): boolean {
  const error = record(record(payload)?.error);
  if (!error) return false;
  if (ownedAuthCode(error)) return true;
  const details = Array.isArray(error.details) ? error.details.slice(0, 32) : [];
  return details.some(entry => ownedAuthCode(record(entry)));
}

const AGY_AUTH_REFUSED = new RegExp([
  String.raw`\bunauthenticated\b`, String.raw`\bnot logged in\b`, String.raw`\bnot signed in\b`, String.raw`\bplease (?:log|sign) ?in\b`, String.raw`\bplease login\b`,
  String.raw`\binvalid_grant\b`, String.raw`\btoken (?:is |has |was |has been )?(?:expired|invalid|revoked)\b`, String.raw`\bexpired token\b`,
  String.raw`\binvalid (?:authentication )?credentials\b`, String.raw`\bcredentials? (?:have |has )?(?:expired|invalid|missing)\b`,
  String.raw`\bauthentication required\b`, String.raw`\b(?:login|sign-?in) required\b`,
].join("|"), "i");

/** Tier 2. `stderr` is the CLI's own last words on an exit with no structured result. */
export const agyAuthFromStderr = (stderr: string | undefined): boolean => typeof stderr === "string" && AGY_AUTH_REFUSED.test(stderr.slice(-4096));

/** The event fields of a sign-in refusal: a structured 401 the card reads, and the stop reason the turn ends with. */
export const AGY_SIGNIN_STOP_REASON = "signin_required";
export const agySigninProviderError = { httpStatus: 401, kind: "authentication" } as const;
