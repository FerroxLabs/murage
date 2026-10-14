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
  if (/\b5\d\d\b|provider|upstream|server error|internal error|unavailable|bad gateway/.test(text)) return "provider_error";
  return "other";
}
