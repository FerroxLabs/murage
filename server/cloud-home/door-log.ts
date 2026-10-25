// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One log line per Cloud door outcome (server/cloud-request-auth.ts door routes, server/cloud-sessions.ts enterDoor, and what the door page reports). Every line is fixed text from the lists below and nothing else: no
// ticket, nonce, key, challenge, cookie or code value, no account or device id, no address. That is what lets the home's
// log runner (deploy/cloud-home/murage-commands LOG_EVENTS, shared/self-service-contract.json logEvents) send these lines
// to support instead of dropping them. Each word stays under 24 characters, so the runner's opaque-string scrubber never
// rewrites one (a rewritten line is dropped).

/** The door route a server-side outcome belongs to. */
export const DOOR_ROUTES = ["state", "enter"] as const;
export type DoorRoute = typeof DOOR_ROUTES[number];

/** Every outcome a door route can end in, derived from its code paths. */
export const DOOR_OUTCOMES = [
  // any door route
  "source_locked",          // this source failed five times in ten minutes
  "budget_closed",          // the home-wide failure budget is spent
  "internal_error",         // anything not named below
  // before any route work: the request itself
  "origin_refused",         // wrong Host or Origin
  "query_token_refused",    // a token in the query string
  "bearer_refused",         // a bearer header on a browser device
  "body_too_large",
  "body_malformed",         // the body is not JSON, or the device is not shaped right
  // /api/cloud/door-state
  "state_answered",
  "state_rate_limited",
  // /api/cloud/enter: the ticket
  "door_unconfigured",      // this home has no ticket verifier
  "home_unbound",           // the control-plane binding could not be read
  "ticket_malformed",       // not <payload>.<signature>, or claims of the wrong shape
  "ticket_wrong_type",      // a ticket of another type, such as the first door version
  "ticket_bad_signature",   // not signed by the pinned control-plane key
  "ticket_wrong_home",      // another home, generation or origin
  "ticket_expired",
  "ticket_bad_times",       // issued in the future or lives longer than 60 seconds
  "ticket_stale_step_up",
  "ticket_reused",          // its nonce was already spent
  // /api/cloud/enter: the account
  "account_suspended",
  "account_mismatch",       // the ticket's account is not this home's owner
  // /api/cloud/enter: the device
  "device_key_invalid",
  "device_bind_refused",    // the key is not the key the ticket was minted for
  "device_proof_refused",   // the key did not sign this ticket
  "assertion_proof_refused",// the assertion key did not sign this ticket (remembered-owner enrolment, §4.2)
  "device_limit",           // ten browsers are already connected
  "desktop_hold_required",  // a computer needs a completed hold claim
  "pair_hold_refused",      // the hold claim could not be spent
  // /api/cloud/enter: success
  "signed_in_first",
  "signed_in_known",
  "signed_in_added",
] as const;
export type DoorOutcome = typeof DOOR_OUTCOMES[number];

/** The steps of the door page that can go wrong (src/lib/cloud-door.ts, src/components/cloud/Door.tsx). */
export const DOOR_PAGE_STAGES = [
  "no_ticket", "device_load", "device_save", "device_forget", "refresh", "bounce", "v1_record", "unexpected", "unknown",
] as const;
export type DoorPageStage = typeof DOOR_PAGE_STAGES[number];
/** Error names a browser can raise on those steps; any other value is logged as "unknown". */
export const DOOR_PAGE_ERRORS = [
  "none", "NotAllowedError", "AbortError", "InvalidStateError", "SecurityError", "NotSupportedError", "ConstraintError",
  "UnknownError", "DataError", "QuotaExceededError", "TimeoutError", "TypeError", "NetworkError", "OperationError",
  "VersionError", "ReadOnlyError", "SyntaxError", "unknown",
] as const;
export type DoorPageError = typeof DOOR_PAGE_ERRORS[number];
/** The page's IndexedDB open that did not finish (src/lib/cloud-door.ts open()): why, and a coarse browser family. Nothing more identifying. */
export const DOOR_OPEN_CAUSES = ["timeout", "blocked", "error", "unknown"] as const;
export type DoorOpenCause = typeof DOOR_OPEN_CAUSES[number];
export const DOOR_BROWSERS = ["chrome", "safari", "firefox", "edge", "other", "unknown"] as const;
export type DoorBrowser = typeof DOOR_BROWSERS[number];
export type DoorPageReport = { stage: DoorPageStage; error: DoorPageError } | { stage: "device_open"; cause: DoorOpenCause; browser: DoorBrowser };

/** An Error that carries the door outcome it stands for. The message is whatever the code threw before, unchanged. */
export class DoorRefusal extends Error {
  readonly outcome: DoorOutcome;
  constructor(outcome: DoorOutcome, message: string) { super(message); this.name = "DoorRefusal"; this.outcome = outcome; }
}
export const doorRefusal = (outcome: DoorOutcome, message: string): DoorRefusal => new DoorRefusal(outcome, message);
/** The outcome an error stands for; anything untagged is an internal error. */
export function doorOutcomeOf(error: unknown): DoorOutcome {
  return error instanceof DoorRefusal ? error.outcome : "internal_error";
}

/** The remembered-owner factor outcomes, logged by server/cloud-sessions.ts enterDoor (§4.4). Log-only: they never reach a
 *  caller. `owner_factor_withheld` carries one reason. Every word stays under 24 characters for the runner's scrubber. */
export const OWNER_FACTOR_OUTCOMES = ["owner_factor_issued", "owner_factor_renewed", "owner_factor_withheld"] as const;
export type OwnerFactorOutcome = typeof OWNER_FACTOR_OUTCOMES[number];
export const OWNER_FACTOR_WITHHELD_REASONS = ["stale_proof", "proof_kind_after_revoke"] as const;
export type OwnerFactorWithheldReason = typeof OWNER_FACTOR_WITHHELD_REASONS[number];
/** `Cloud owner factor: <outcome>` (with the withheld reason when present); always at info. */
export function logOwnerFactor(outcome: OwnerFactorOutcome, reason?: OwnerFactorWithheldReason): void {
  console.info(`Cloud owner factor: ${outcome}${reason ? ` ${reason}` : ""}`);
}

const OK: ReadonlySet<DoorOutcome> = new Set(["state_answered", "signed_in_first", "signed_in_known", "signed_in_added"]);
/** `Cloud door <route>: <outcome>`. Successes at info, internal errors at error, every refusal at warn. */
export function logDoorOutcome(route: DoorRoute, outcome: DoorOutcome): void {
  const line = `Cloud door ${route}: ${outcome}`;
  if (OK.has(outcome)) console.info(line);
  else if (outcome === "internal_error") console.error(line);
  else console.warn(line);
}

/** Maps what the page sent to the fixed lists; anything else is "unknown". */
export function doorPageReport(body: unknown): DoorPageReport {
  const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const pick = <T extends string>(list: readonly T[], value: unknown): T =>
    typeof value === "string" && (list as readonly string[]).includes(value) ? value as T : "unknown" as T;
  if (b.stage === "device_open") return { stage: "device_open", cause: pick(DOOR_OPEN_CAUSES, b.cause), browser: pick(DOOR_BROWSERS, b.browser) };
  return { stage: pick(DOOR_PAGE_STAGES, b.stage), error: pick(DOOR_PAGE_ERRORS, b.error) };
}
/** `Cloud door page: <stage> <error>`, or `Cloud door page: device_open <cause> <browser>`; always at warn. */
export function logDoorPage(report: DoorPageReport): void {
  if (report.stage === "device_open") console.warn(`Cloud door page: device_open ${report.cause} ${report.browser}`);
  else console.warn(`Cloud door page: ${report.stage} ${report.error}`);
}

const alt = (list: readonly string[]) => `(?:${list.join("|")})`;
/** The log runner's allowed events for these lines, exactly as murage-commands and the control plane list them. */
export const DOOR_LOG_EVENTS = [
  `Cloud door ${alt(DOOR_ROUTES)}: ${alt(DOOR_OUTCOMES)}`,
  `Cloud door page: ${alt(DOOR_PAGE_STAGES)} ${alt(DOOR_PAGE_ERRORS)}`,
  `Cloud door page: device_open ${alt(DOOR_OPEN_CAUSES)} ${alt(DOOR_BROWSERS)}`,
  `Cloud owner factor: ${alt(OWNER_FACTOR_OUTCOMES)}(?: ${alt(OWNER_FACTOR_WITHHELD_REASONS)})?`,
] as const;
