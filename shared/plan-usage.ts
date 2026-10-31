// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plan usage and reset clock (GAP-PLAN-LIMITS rev 1.2, section 4): the shapes every engine's
// plan reading travels in, shared by the server service and the owner surfaces. A reading is
// only ever what an engine reported: an unknown value stays null, never a synthetic zero or a
// full bar, and a missing bucket never proves unused quota.

/** At most this many windows per subject; a report with more is unavailable, never trimmed. */
export const PLAN_WINDOWS_MAX = 32;
/** At most this many subjects per report (one page). */
export const PLAN_SUBJECTS_MAX = 32;
/** Plain-text labels are cut to this many characters. */
export const PLAN_LABEL_MAX = 80;

/** Where a reading came from. */
export type PlanSource = "native-rpc" | "native-event" | "refusal";

/** How current a subject's reading is. Independent of the engine's sign-in status. */
export type PlanStatus = "checking" | "current" | "stale" | "unavailable" | "deferred" | "not-applicable";

/** Fixed reasons. Provider error strings are never forwarded. */
export const PLAN_REASONS = [
  "awaiting-session",
  "unsupported",
  "policy-unverified",
  "identity-unresolved",
  "source-changed",
  "offline",
  "timeout",
  "schema",
  "reader-throttled",
  "queue-budget",
  "home-paused",
  "clock-uncertain",
] as const;
export type PlanReason = (typeof PLAN_REASONS)[number];

/** Which limit was met (upstream 0.1.130 `runtime.error.limit`): the whole engine account, one model's own window, or
 * prepaid credits. A model's own window holds that model alone; the account's other models stay usable. */
export type PlanLimitKind = "engine" | "model" | "credits";

/** How the chat's turn is actually billed, resolved before any reading is attributed to it. */
export type PlanRouteKind = "native-plan" | "connected-plan" | "api" | "flux" | "local" | "service";

/** One reported window of one bucket. Every measured value is nullable: unknown is not zero. */
export interface PlanWindow {
  /** The metered bucket (`codex`, a named limit id, ...): an update changes only its own bucket. */
  bucketId: string;
  /** `primary` / `secondary` within the bucket. */
  windowId: string;
  /** Bounded plain text, for owner surfaces. */
  label: string;
  scope: "account" | "model";
  /** The model a `model`-scope window belongs to, when the engine names it; else null. */
  model: string | null;
  usedPercent: number | null;
  windowSeconds: number | null;
  /** Epoch milliseconds. */
  resetsAt: number | null;
  enforcement: "hard" | "advisory" | "unknown";
  /** Set only while the engine reports this bucket's limit as reached. */
  limitKind: PlanLimitKind | null;
}

/** A limit Murage holds turns for (section 6.2), kept apart from displayed utilization. */
export interface LimitDecision {
  subjectKey: string;
  credentialRevision: string | null;
  /** `model`: only that model is held; `account`: the whole engine account. */
  scope: "account" | "model";
  model: string | null;
  bucketId: string;
  state: "unknown" | "available" | "limited" | "reset-due" | "retired";
  kind: "quota" | "throttle" | "unknown-limit";
  limitKind: PlanLimitKind;
  evidence: "reported" | "observed" | "legacy";
  /** The provider's own reset, epoch ms; null when it named none. */
  resetsAt: number | null;
  /** True when no reset was named and the retry time is Murage's own guess: it is never shown as a reset. */
  resetGuessed: boolean;
  /** When Murage may try again: the named reset, else the local fallback. */
  retryAt: number | null;
  confirmedAt: number | null;
  releaseId: string | null;
}

/** A subject's current reading. Timestamps are finite epoch milliseconds or null. */
export interface PlanObservation {
  subjectKey: string;
  credentialRevision: string;
  source: PlanSource | null;
  status: PlanStatus;
  reason: PlanReason | null;
  observedAt: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  freshUntil: number | null;
  retryAt: number | null;
  windows: PlanWindow[];
}

/** A finite percentage in 0..100, else null. */
export function planPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/** Native minutes to seconds: positive finite only, else null. */
export function planMinutesToSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 60) : null;
}

/** Native epoch seconds to epoch milliseconds: positive finite only, else null. */
export function planEpochSecondsToMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = Math.round(value * 1000);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** Bounded plain text: control characters dropped, whitespace folded, length capped. Null when nothing is left. */
export function planLabel(value: unknown, max = PLAN_LABEL_MAX): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}
