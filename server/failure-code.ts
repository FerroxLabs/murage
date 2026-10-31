// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The few ways a failed or retried turn is described to a bot. A provider's own failure text (a path, a response body, a key's name) stays with
// the owner; a bot is told one of these and nothing else.

export const FAILURE_CODES = ["rate_limit", "auth", "timeout", "provider_error", "other"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Sorts a provider's failure text into a code. The text itself goes no further. */
export function failureCodeFrom(detail: string | null | undefined): FailureCode {
  const text = (detail ?? "").toLowerCase();
  if (/rate.?limit|too many requests|\b429\b|quota|overloaded/.test(text)) return "rate_limit";
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|auth|sign.?in|login|api key|credential|token (?:expired|invalid)/.test(text)) return "auth";
  if (/time.?d? ?out|deadline|\b408\b|\b504\b/.test(text)) return "timeout";
  if (/\b5\d\d\b|provider|upstream|server error|internal error|unavailable|bad gateway|the model is busy/.test(text)) return "provider_error";
  return "other";
}

/** The owner's line while an engine waits to try a turn again. Why it failed goes to the log, not here. */
export const retryLine = (attempt: number, maxAttempts: number): string => `The model is busy. Trying again (attempt ${attempt} of ${maxAttempts}).`;

/** Is this activity row a retry? Rows written before the line above read `retrying: attempt 2/3 in 5s: <reason>`. */
export const isRetryLine = (name: string): boolean => /^\s*(?:retrying\b|the model is busy\. trying again\b)/i.test(name);

/** Why a turn could not START, which is more than a provider failure: Murage's own refusals at the start (a teammate this conversation cannot reach,
 * an archived bot, sharing removed, a request that no longer fits its conversation) carry their own code on the error, so the line names the real
 * reason instead of "it did not say why". `setup` is a start that failed for any other reason; its detail goes with the line for the owner. */
export const START_REFUSAL_CODES = ["not_reachable", "archived", "sharing_removed", "team_deleted", "binding_mismatch", "shared_paused", "setup"] as const;
export type StartRefusalCode = (typeof START_REFUSAL_CODES)[number];
export type StartFailureCode = Exclude<FailureCode, "other"> | StartRefusalCode;
export const START_FAILURE_CODES: readonly StartFailureCode[] = [...FAILURE_CODES.filter((code): code is Exclude<FailureCode, "other"> => code !== "other"), ...START_REFUSAL_CODES];

/** Sorts a failed start into a code: Murage's own refusal code when the error carries one, else the provider kind, else `setup`. */
export function startFailureCodeFrom(error: unknown): StartFailureCode {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && (START_REFUSAL_CODES as readonly string[]).includes(code)) return code as StartRefusalCode;
  const kind = failureCodeFrom(error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? ""));
  return kind === "other" ? "setup" : kind;
}
