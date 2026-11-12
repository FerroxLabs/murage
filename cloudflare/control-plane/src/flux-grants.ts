// SPDX-License-Identifier: AGPL-3.0-or-later
// Murage Cloud B4 WP5-P4, control-plane half (design b4/GRANTS-DESIGN.md r9, sections 2, 3, 7, 9): the frozen grant body (D1), the grants
// client for the router's P3 routes (D2 statuses, D3 secret), and the issuance preflight. A LEAF of the billing code: it imports only the
// B4 plan catalogue (b4-flux-config.ts) and the shared Flux link lookup (flux-link.ts), so b5-billing.ts can import it and re-export
// FluxHookRetry without a cycle, and the stub-era cutover CLI loads it under Node's type stripping.
//
// ROUTES (the Flux router's cloud grants route, bearer FLUX_CLOUD_GRANTS_TOKEN only):
//   POST {FLUX_CLOUD_GRANTS_URL}/internal/cloud-home/credit-grants          frozen body (+ optional initial_target: grantWithTarget, Astra A-8 #2)
//   POST {FLUX_CLOUD_GRANTS_URL}/internal/cloud-home/credit-grants/reverse  {grant_id, invoice_id, kind, home_id, reason}
//   POST {FLUX_CLOUD_GRANTS_URL}/internal/cloud-home/credit-grants/reversal-target  {grant_id, invoice_id, kind, home_id, reason,
//        target_removed_microcents, revision}  (lanes/cloud-v2/b4/FLUX-REVERSAL-TARGET-CONTRACT.md; NOT in the live router yet: only ever
//        dispatched by hooks that advertise capabilities.reversalTargets, which these do only when built with { reversalTargets: true })
//   GET  {FLUX_CLOUD_GRANTS_URL}/internal/cloud-home/credit-grants/usage    ?home_id&period_start&period_end  (usage page only)
// TOKEN GUARD (D3): with FLUX_CLOUD_GRANTS_TOKEN absent NOTHING is dispatched, whatever FLUX_CLOUD_GRANTS_URL says: no router call and no
// pre-B4 stub (the stub's grant/reversal path is not reachable from the default hooks any more), and ONE alert says why. The URL set with
// the token absent is the quiesced state of the stub-era cutover (design section 7 (a)): claims are written with their frozen body, nothing
// is sent anywhere.
import { fluxCredentialsMissing, fluxRoutesEnabled, fluxServing, readFluxConfig, usdToMicrocents } from "./b4-flux-config.ts";
import { ensureOwnerLinked, fluxRecipientOf, homeOwnerOf, linkRowOf, STALE, UNPROVEN } from "./flux-link.ts";
import { type AllocationDecision, abandonFenceRevision, allocateFenceRevision, claimGrantFence, fenceDue, fencesToReconcile, logicalOf, reconcileOne, releaseGrantFence, settleFenceRevision,
  type FenceOp, type FenceOutcome, type RemoteGrantState } from "./flux-grant-fence.ts";

declare global {
  interface Env { FLUX_CLOUD_GRANTS_URL?: string; FLUX_CLOUD_GRANTS_TOKEN?: string }
  namespace Cloudflare { interface Env { FLUX_CLOUD_GRANTS_URL?: string; FLUX_CLOUD_GRANTS_TOKEN?: string } }
}

/** The ONE way a grant/revoke hook says "B4 cannot apply this now" (Astra STUB-2 #1): recorded as a failed attempt with `code` as
 *  last_error and retried by the sweep. Every other error a hook throws is an infrastructure failure and propagates (no attempt recorded). */
// (No parameter properties: scripts/flux-grants-cutover.mjs loads this file under Node's type stripping.)
export class FluxHookRetry extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; this.name = "FluxHookRetry"; } }
/** The router answered 409 (recipient_mismatch, account_not_fresh, idempotency_conflict, grant_mismatch): a retry, plus a review alert from
 *  askGrant. Nothing is stamped. */
/** A top-up grant the router refused for good (422 ceiling) or answered 409 account_not_fresh after the charge was taken: never retried as if it
 *  were transient. askGrant suppresses the claim with this reason and raises an alert; the charge stays and ops decide. */
export class FluxGrantPermanent extends Error {
  constructor(readonly reason: "topup_ceiling" | "account_not_fresh") { super(`grant_permanent_${reason}`); this.name = "FluxGrantPermanent"; }
}
/** The router refused a reversal for good: 422 on /reverse or /reversal-target (its removal ceiling). Never retried; the caller records it and alarms. */
export class FluxReversalPermanent extends Error {
  readonly code: string;
  constructor(code: string) { super(`reversal_permanent_${code}`); this.code = code; this.name = "FluxReversalPermanent"; }
}
export class FluxGrantHeld extends FluxHookRetry {
  readonly routerCode: string;
  constructor(routerCode: string) { super(`router_409_${routerCode}`.slice(0, 80)); this.routerCode = routerCode; this.name = "FluxGrantHeld"; }
}

/** Astra JOURNEY-A-8 #1: NOTHING reached the router (the token guard, a missing or corrupt frozen body, the stub's fail-closed grant): a
 *  definitive "not delivered" for this ask. Every other FluxHookRetry of a grant ask (a 503 above all: the router may have committed the
 *  grant and lost its COMMIT acknowledgement) leaves the grant's delivery AMBIGUOUS. */
export class FluxNotDispatched extends FluxHookRetry { constructor(code: string) { super(code); this.name = "FluxNotDispatched"; } }
/** Astra JOURNEY-A-8 #2: a grant that must carry its initial reversal target could not be published WITH it: the router does not advertise
 *  capabilities.grantWithTarget right now (checked on every publish, nothing sent), or it refused the request with 400 (a router that does
 *  not know initial_target refuses the unknown field before any state change: nothing applied). The grant is HELD locally, never sent alone. */
export class FluxGrantTargetUnsupported extends FluxHookRetry { constructor(code: string) { super(code); this.name = "FluxGrantTargetUnsupported"; } }

/** Router 409 stale_revision / revision_conflict on a reversal target (wp5-p5): the router holds `latestRevision` for the grant. A retry,
 *  carrying what the caller needs to refresh its revision above the router's and re-send its latest target. */
export class FluxTargetStale extends FluxHookRetry {
  readonly latestRevision: number;
  constructor(routerCode: string, latestRevision: number) { super(`router_409_${routerCode}`.slice(0, 80)); this.latestRevision = latestRevision; this.name = "FluxTargetStale"; }
}

/** Lane H1 (the grant fence, flux-grant-fence.ts): Flux holds a newer revision of this grant than the request carried (409 stale_revision):
 *  the request was SUPERSEDED (a later mutation already applied). Recorded, never retried; the grant is read back (GET state). A reversal
 *  target refreshes its own revision above it (FluxTargetStale) and the latest target goes out later as a NEW mutation. */
export class FluxStaleRevision extends FluxTargetStale {
  readonly appliedRevision: number;
  constructor(latestRevision: number, appliedRevision: number) { super("stale_revision", latestRevision); this.appliedRevision = appliedRevision; this.name = "FluxStaleRevision"; }
}
/** Lane H1: Flux holds this very revision with ANOTHER body (409 idempotency_mismatch, legacy revision_conflict): a control-plane bug.
 *  Alerted (high), never re-sent at that revision, reconciled with GET state. A reversal target refreshes its own revision above it like a
 *  stale answer (the frozen contract's revision_conflict rule); the latest target then goes out as a new mutation. */
export class FluxRevisionMismatch extends FluxTargetStale {
  readonly appliedRevision: number;
  constructor(routerCode: string, latestRevision: number, appliedRevision: number) { super(routerCode, latestRevision); this.appliedRevision = appliedRevision; this.name = "FluxRevisionMismatch"; }
}
/** Lane H1: the Flux account could not be ensured for an owner with no link: 4xx (a refusal, alerted; nothing is dispatched for the owner)
 *  or a retry (5xx, timeout: the existing backoff). */
export class FluxEnsureRefused extends FluxHookRetry {
  readonly status: number;
  /** Flux's error string on a 4xx, when it sent one (409 "link_email_mismatch": the id is linked at Flux under another email). */
  readonly reason: string | null;
  /** The address revision the call was asked on (set by flux-link.ts ensureOwnerLinked). */
  revision?: number;
  constructor(status: number, reason: string | null = null) {
    super(`ensure_account_${status}`); this.status = status; this.reason = reason; this.name = "FluxEnsureRefused";
  }
}
/** Contract (c): a 409 whose error is this means the Murage id is already linked at Flux to a DIFFERENT email (M-d). */
export const LINK_EMAIL_MISMATCH = "link_email_mismatch";

/** FLUX-ENSURE-EMAIL-VERIFIED (design-ev3 section 4, Grok r3 High 1): Flux answered 202 {status: "pending_verification"}: an existing Flux account
 *  matches the owner's address and the address is not proven. A TYPED HOLD, deliberately NOT a FluxHookRetry (no failure counted, no retry
 *  backoff) and NOT a FluxEnsureRefused (no refusal alert): ensureOwnerAccount turns it into "email_unverified" before any link row is written.
 *  Control-plane name: email_unverified everywhere; "pending_verification" is only Flux's HTTP body string. */
export class FluxEmailUnverified extends Error {
  /** The address revision the 202 answered (set by flux-link.ts ensureOwnerLinked): its hold is written only while it is still current. */
  revision?: number;
  constructor() { super("email_unverified"); this.name = "FluxEmailUnverified"; }
}
/** The ensure-account outcomes (b5-billing.ts FluxEntitlementHooks.ensureAccount, b4-flux.ts issueKeyChecked). "stale": Flux answered, but the
 *  state it was asked on moved in flight (flux-link.ts STALE): nothing linked, no failure, asked again on the next sweep through the hold below. */
/** ITEM4-PROOF-CURRENT, the wake path only (opts.wake): "verified_refused" (Flux answered 202 to a TRUE call) and "link_email_mismatch" (a 409
 *  link_email_mismatch, or its alert open) are TERMINAL there. Every other caller gets "email_unverified" and "refused" for them. */
export type EnsureOutcome = "linked" | "held" | "unavailable" | "refused" | "email_unverified" | "stale" | "verified_refused" | "link_email_mismatch";
/** M1: the account-level hold after a 202 (flux_email_hold, migration 0143): Flux is asked again at most every 15 minutes, whichever path asks. */
export const EMAIL_HOLD_MS = 15 * 60_000;
/** True while the account's hold deadline is in the future for its CURRENT address revision. */
export async function emailHoldStanding(env: Env, accountId: string, now: number): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 AS x FROM flux_email_hold h JOIN supabase_identities s ON s.user_id=h.account_id
    WHERE h.account_id=? AND h.until_at>? AND h.email_revision=s.email_revision`).bind(accountId, now).first());
}

export const GRANT_PATH = "/internal/cloud-home/credit-grants";
/** Lane H1 (FluxMain's confirmed contract): POST {FLUX_APP_BASE}/api/internal/cloud-home/accounts/ensure {murage_account_id, email} ->
 *  {flux_account_id, created}, idempotent on murage_account_id, Bearer FLUX_CLOUD_SERVICE_TOKEN (never the grants token). */
export const ENSURE_ACCOUNT_PATH = "/api/internal/cloud-home/accounts/ensure";
/** Flux's staging app sits behind Vercel SSO. The bypass header goes to this host only, only from a staging Worker, never to the proxy or to prod. */
export const STAGING_FLUX_APP_HOST = "app-staging.fluxrouter.ai";
/** Lane H1: a 409 that names the revision fence: its code (stale_revision, or idempotency_mismatch / legacy revision_conflict) and the
 *  revision Flux holds (applied_revision, else latest_revision). Null for any other answer. */
export function revisionRefusal(http: number, j: Record<string, unknown>): { code: "stale_revision" | "idempotency_mismatch"; routerCode: string; applied: number | null } | null {
  if (http !== 409) return null;
  const e = (j.error ?? {}) as Record<string, unknown>;
  const codes = [e.code, j.code, j.status, j.legacy_code, e.legacy_code].filter((c): c is string => typeof c === "string");
  const code = codes.includes("stale_revision") ? "stale_revision"
    : codes.some((c) => c === "idempotency_mismatch" || c === "revision_conflict") ? "idempotency_mismatch" : null;
  if (!code) return null;
  const n = [j.applied_revision, e.applied_revision, j.latest_revision, e.latest_revision].find((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  const routerCode = code === "stale_revision" ? "stale_revision" : codes.find((c) => c === "idempotency_mismatch" || c === "revision_conflict")!;
  return { code, routerCode, applied: (n as number | undefined) ?? null };
}
/** Lane H1: the Flux GET state answer of one grant (state includes "expired"; unknown extra fields are accepted). */
export function parseGrantState(http: number, j: Record<string, unknown>): RemoteGrantState | null {
  if (http !== 200 || typeof j.state !== "string") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
  return { state: j.state, appliedRevision: num(j.applied_revision) ?? 0, remainingMicrocents: num(j.remaining_microcents) };
}
/** wp5-p5: the router advertises what it implements (GET, grants token): {capabilities: {reversalTargets: true, grantWithTarget: true}}. */
export const CAPABILITIES_PATH = `${GRANT_PATH}/capabilities`;
const present = (v: string | undefined): boolean => (v ?? "").trim() !== "";
/** The grants client is configured: claims are frozen with a body. */
export const grantsConfigured = (env: Pick<Env, "FLUX_CLOUD_GRANTS_URL">): boolean => present(env.FLUX_CLOUD_GRANTS_URL);
/** The grants client may dispatch: URL and token both set. */
export const grantsReady = (env: Pick<Env, "FLUX_CLOUD_GRANTS_URL" | "FLUX_CLOUD_GRANTS_TOKEN">): boolean =>
  present(env.FLUX_CLOUD_GRANTS_URL) && present(env.FLUX_CLOUD_GRANTS_TOKEN);

// ---- frozen body (D1) ----------------------------------------------------------------------------------------------------------------

/** The facts a claim records (credit_grants: invoice_id, kind, home_id, plan, period_start, period_end, previous_plan). For an upgrade the
 *  period is the invoice's PRORATED interval (the debit line's period: from the quote's proration_date to the subscription period's end). */
/** period: the monthly credit; upgrade_delta: the prorated credit of a plan upgrade; topup: credit bought by an auto top-up charge (no period). */
export type GrantKind = "period" | "upgrade_delta" | "topup";
export const grantKindOf = (k: string | null | undefined): GrantKind => (k === "upgrade_delta" || k === "topup" ? k : "period");
export interface GrantFacts { homeId: string; plan: string; invoiceId: string; kind?: GrantKind; periodStart: number;
  periodEnd: number; previousPlan?: string }
export interface FrozenBody { json: string; sha256: string }
/** Why no body can be frozen now. The claim is HELD (kept, never sent): `recipient_unlinked` clears once the owner links Flux; the others
 *  are for ops. */
export type BodyHold = { held: "recipient_unlinked" | "plan_not_in_catalogue" | "flux_config_invalid" | "grant_input_invalid"
  | "plan_change_missing" | "proration_unverifiable" | "amount_not_positive" };

/** ISO-8601 with a UTC offset, no fraction when it is zero (the router parses both; it hashes the normalized value, not these bytes). */
export const isoUtc = (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/, "Z").replace(/Z$/, "+00:00");
/** period_end plus one calendar month in UTC, the day clamped to the target month (router add_one_month_utc). */
export function addOneMonthUtc(ms: number): number {
  const d = new Date(ms);
  const y = d.getUTCMonth() === 11 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1) % 12;
  const day = Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
  return Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One period's included credit of `plan`, in router microcents, from THE plan catalogue (b4-flux-config.ts, FLUX_B4_CONFIG, its own
 *  validated USD -> microcents conversion): the same numbers the keys client uses. A pooled or unknown plan has no per-home grant. A
 *  set-but-invalid FLUX_B4_CONFIG is never replaced by defaults: the claim is held. */
export function planCreditMicrocents(env: Pick<Env, "FLUX_B4_CONFIG">, plan: string): number | BodyHold {
  let plans;
  try { plans = readFluxConfig(env).plans; } catch { return { held: "flux_config_invalid" }; }
  const p = Object.prototype.hasOwnProperty.call(plans, plan) ? plans[plan] : undefined;
  if (!p || p.pooled) return { held: "plan_not_in_catalogue" };
  const mc = usdToMicrocents(p.creditsUsd);
  return Number.isSafeInteger(mc) && mc > 0 ? mc : { held: "plan_not_in_catalogue" };
}

/** floor(delta x (end - prorationDate) / (end - start)), exact: integer arithmetic throughout, rounded ONCE (down). This is the share Stripe
 *  charged for: the subscription period [start, end) prorated at the quote's own proration_date (members-api.ts planQuote/changePlan). */
export function proratedShare(deltaMicrocents: number, prorationDateMs: number, periodStartMs: number, periodEndMs: number): number {
  const num = BigInt(deltaMicrocents) * BigInt(periodEndMs - prorationDateMs);
  return Number(num / BigInt(periodEndMs - periodStartMs));
}

/** An upgrade's amount from the facts the customer was charged on: the plan change recorded for THIS invoice, its quote's proration_date and
 *  the subscription period that quote was prorated over. Never the processing time: a delayed delivery grants the same amount. */
async function upgradeAmount(env: Pick<Env, "DB" | "FLUX_B4_CONFIG">, f: GrantFacts, to: number): Promise<number | BodyHold> {
  if (f.previousPlan === undefined) return { held: "grant_input_invalid" };
  const from = planCreditMicrocents(env, f.previousPlan);
  if (typeof from !== "number") return from;
  const pc = await env.DB.prepare(`SELECT c.from_plan,c.to_plan,q.proration_date,q.sub_period_start,q.sub_period_end FROM plan_changes c
    JOIN plan_quotes q ON q.id=c.quote_id WHERE c.invoice_id=? AND c.home_id=?`).bind(f.invoiceId, f.homeId)
    .first<{ from_plan: string; to_plan: string; proration_date: number; sub_period_start: number | null; sub_period_end: number | null }>();
  if (!pc || pc.to_plan !== f.plan || pc.from_plan !== f.previousPlan) return { held: "plan_change_missing" };
  const pd = pc.proration_date * 1000;
  let start: number; let end: number;
  if (pc.sub_period_start !== null && pc.sub_period_end !== null) { start = pc.sub_period_start * 1000; end = pc.sub_period_end * 1000; }
  else {
    // A quote from before migration 0090: the recorded billing period, only when it is provably the period the quote was prorated over.
    const s = await env.DB.prepare("SELECT current_period_start AS s,current_period_end AS e FROM billing_subscriptions WHERE home_id=?").bind(f.homeId)
      .first<{ s: number | null; e: number | null }>();
    if (!s || s.s === null || s.e === null || s.e !== f.periodEnd) return { held: "proration_unverifiable" };
    start = s.s; end = s.e;
  }
  // The invoice's prorated interval IS [proration_date, period end]: anything else is not the proration the quote charged.
  if (!(start <= pd && pd < end) || f.periodStart !== pd || f.periodEnd !== end) return { held: "proration_unverifiable" };
  const amount = proratedShare(to - from, pd, start, end);
  return amount > 0 && Number.isSafeInteger(amount) ? amount : { held: "amount_not_positive" };
}

/** The canonical body from the claim's recorded facts: fixed key order, the exact bytes the claim stores and every attempt resends. The
 *  recipient is the Flux account the keys client mints for (flux-link.ts: the owner's UNFENCED link), never the CP owner id; no link, no
 *  body (held). Deterministic: no clock is read. */
export async function composeFrozenBody(env: Pick<Env, "DB" | "FLUX_B4_CONFIG">, f: GrantFacts): Promise<FrozenBody | BodyHold> {
  const kind = f.kind ?? "period";
  if (kind === "topup") return composeTopupGrantBody(env, f);
  if (!Number.isSafeInteger(f.periodStart) || !Number.isSafeInteger(f.periodEnd) || f.periodEnd <= f.periodStart) return { held: "grant_input_invalid" };
  const to = planCreditMicrocents(env, f.plan);
  if (typeof to !== "number") return to;
  const amount = kind === "period" ? to : await upgradeAmount(env, f, to);
  if (typeof amount !== "number") return amount;
  const accountId = await fluxRecipientOf(env as Env, f.homeId);
  if (accountId === null) return { held: "recipient_unlinked" };
  const json = JSON.stringify({ grant_id: `${f.invoiceId}:${kind}`, invoice_id: f.invoiceId, kind, home_id: f.homeId, account_id: accountId, plan: f.plan,
    amount_microcents: amount, period_start: isoUtc(f.periodStart), period_end: isoUtc(f.periodEnd), expires_at: isoUtc(addOneMonthUtc(f.periodEnd)) });
  return { json, sha256: await sha256Hex(json) };
}
/** The router's answer to "would a grant to this account be accepted" (GET .../credit-grants/eligibility?account_id=, grants token). Only 200 with
 *  eligible exactly true is "eligible". Everything else leaves a decision to the caller and means NO CHARGE: "ineligible" (200 eligible false,
 *  with the router's reason), "refused" (400), "transient" (capability absent, 503, any other status, malformed JSON, a timeout, a network error,
 *  Flux off or the token absent). It is a prediction; a grant refused after a charge goes through the failed-grant path. */
export type GrantEligibility = { r: "eligible" } | { r: "ineligible"; reason: string } | { r: "refused" } | { r: "transient"; why: string };
export const ELIGIBILITY_PATH = `${GRANT_PATH}/eligibility`;
export async function readGrantEligibility(env: Env, accountId: string, doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<GrantEligibility> {
  if (!fluxRoutesEnabled(env)) return { r: "transient", why: "flux_off" };
  // PRODFLUX r4 A: switched on with EITHER Flux credential missing (fluxServing false) a grant cannot be sent, so nothing may be charged:
  // transient, which the top-up machine treats as any transient (no invoice made; an open one voided; the claim released).
  if (!fluxServing(env)) return { r: "transient", why: "flux_not_ready" };
  if ((await grantsGuard(env, "readGrantEligibility", Date.now())) !== null) return { r: "transient", why: "grants_unconfigured" };
  try {
    const caps = await call(env, doFetch, "GET", CAPABILITIES_PATH);
    if (caps.http !== 200 || ((caps.json.capabilities ?? {}) as Json).grantEligibility !== true) return { r: "transient", why: "capability_absent" };
    const { http, json } = await call(env, doFetch, "GET", `${ELIGIBILITY_PATH}?${new URLSearchParams({ account_id: accountId })}`);
    if (http === 400) return { r: "refused" };
    if (http !== 200) return { r: "transient", why: `http_${http}` };
    if (json.eligible === true) return { r: "eligible" };
    if (json.eligible === false) return { r: "ineligible", reason: typeof json.reason === "string" && json.reason !== "" ? json.reason.slice(0, 60) : "unknown" };
    return { r: "transient", why: "malformed" };
  } catch { return { r: "transient", why: "unreachable" }; }
}

/** Microcents of router credit per cent paid (1 USD = 1,000,000 microcents). */
const MICROCENTS_PER_CENT = 10_000;
/** THE top-up grant body (draft Flux contract, cloud-b: kind "topup"; period_start, period_end and expires_at MUST be absent, Flux answers 400
 *  otherwise). One function so a contract change is one edit. The amount is the charged amount before tax, read from the attempt that
 *  bought it (topup_attempts by invoice), never from a clock or the plan catalogue. Same bytes on every replay. */
export async function composeTopupGrantBody(env: Pick<Env, "DB">, f: { homeId: string; invoiceId: string }): Promise<FrozenBody | BodyHold> {
  const a = await env.DB.prepare("SELECT amount_cents FROM topup_attempts WHERE invoice_id=? AND home_id=? AND state IN ('paid','done')").bind(f.invoiceId, f.homeId).first<{ amount_cents: number }>();
  if (!a || !(a.amount_cents > 0)) return { held: "amount_not_positive" };
  const accountId = await fluxRecipientOf(env as Env, f.homeId);
  if (accountId === null) return { held: "recipient_unlinked" };
  const json = JSON.stringify({ grant_id: `${f.invoiceId}:topup`, invoice_id: f.invoiceId, kind: "topup", home_id: f.homeId, account_id: accountId, plan: "topup",
    amount_microcents: a.amount_cents * MICROCENTS_PER_CENT });
  return { json, sha256: await sha256Hex(json) };
}
export const isHold = (b: FrozenBody | BodyHold): b is BodyHold => "held" in b;

// ---- preflight (runbook) -------------------------------------------------------------------------------------------------------------

/** RUNBOOK PREFLIGHT, run before the server-side rollout flag is turned on at the router (design section 7): the router may issue only
 *  when the control plane can send a valid frozen body to it. Fails (ok false, every problem listed) when the CP lacks grant config: the
 *  URL is missing or not https, the token is missing, shorter than 32 characters, reserved-prefixed or the keys token, or the plan
 *  catalogue is invalid or has no per-home plan. Never prints a secret. */
export function grantsIssuancePreflight(env: Pick<Env, "FLUX_CLOUD_GRANTS_URL" | "FLUX_CLOUD_GRANTS_TOKEN" | "FLUX_B4_CONFIG" | "FLUX_CLOUD_SERVICE_TOKEN">):
  { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const url = (env.FLUX_CLOUD_GRANTS_URL ?? "").trim();
  if (!url) problems.push("FLUX_CLOUD_GRANTS_URL unset");
  else { try { if (new URL(url).protocol !== "https:") problems.push("FLUX_CLOUD_GRANTS_URL not https"); } catch { problems.push("FLUX_CLOUD_GRANTS_URL invalid"); } }
  const token = (env.FLUX_CLOUD_GRANTS_TOKEN ?? "").trim();
  if (!token) problems.push("FLUX_CLOUD_GRANTS_TOKEN unset");
  else {
    if (token.length < 32) problems.push("FLUX_CLOUD_GRANTS_TOKEN shorter than 32");
    if (token.startsWith("sk-flux-")) problems.push("FLUX_CLOUD_GRANTS_TOKEN reserved prefix");
    if (token === (env.FLUX_CLOUD_SERVICE_TOKEN ?? "").trim()) problems.push("FLUX_CLOUD_GRANTS_TOKEN equals the keys token");
  }
  try {
    const plans = readFluxConfig(env).plans;
    if (!Object.values(plans).some((p) => !p.pooled)) problems.push("FLUX_B4_CONFIG has no per-home plan");
  } catch { problems.push("FLUX_B4_CONFIG invalid"); }
  return { ok: problems.length === 0, problems };
}

// ---- the client (D2 statuses, D3 secret) ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const BLOCKS = ["monthly credit grants", "credit reversal", "credit reversal target", "usage page"];

/** One open alert (home "billing"), whatever the number of asks. PRODFLUX r4 D: one the healthy Flux sweep resolved (the secret came back)
 *  opens again, as a new page, when the secret goes missing again. */
async function configAlert(env: Env, kind: string, hook: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET resolved_at=NULL,resolve_notice_due=NULL,delivered_at=NULL,delivery_attempts=0,raised_at=excluded.raised_at
    WHERE cloud_alerts.resolved_at IS NOT NULL`)
    .bind(`alert:${kind}`, "billing", kind, "high", JSON.stringify({ hook, blocks: BLOCKS }), now).run();
}
/** D3, before ANY dispatch: the token absent (whatever the URL says), or the URL absent. Returns the retry code, or null when ready. */
export async function grantsGuard(env: Env, hook: string, now: number): Promise<string | null> {
  if (!present(env.FLUX_CLOUD_GRANTS_TOKEN)) { await configAlert(env, "credit.grants_token_absent", hook, now); return "grants_token_absent"; }
  if (!present(env.FLUX_CLOUD_GRANTS_URL)) { await configAlert(env, "credit.grants_url_absent", hook, now); return "grants_url_absent"; }
  return null;
}
/** PRODFLUX (Astra HIGH 2): Flux switched on with a credential missing. Raises ONE config alert naming the missing secret (never a value)
 *  and returns its code; null when Flux is off or both credentials are set. Callers hold their work BEFORE claiming or counting it. */
export async function fluxCredentialsAlert(env: Env, hook: string, now: number): Promise<string | null> {
  if (!fluxRoutesEnabled(env)) return null;
  const missing = fluxCredentialsMissing(env);
  if (missing === "flux_service_token_absent") await configAlert(env, "credit.flux_service_token_absent", hook, now);
  else if (missing === "grants_token_absent") await configAlert(env, "credit.grants_token_absent", hook, now);
  return missing;
}
const errorCode = (j: Json): string => {
  const e = (j.error ?? {}) as Json;
  return String(e.code ?? j.status ?? "error").slice(0, 60);
};
const retryCode = (j: Json): string => {
  const e = (j.error ?? {}) as Json;
  const reason = e.reason ?? j.reason;
  return (reason ? `${errorCode(j)}:${String(reason)}` : errorCode(j)).slice(0, 80);
};
async function call(env: Env, doFetch: FetchLike, method: "GET" | "POST", path: string, body?: string): Promise<{ http: number; json: Json }> {
  const res = await doFetch(`${(env.FLUX_CLOUD_GRANTS_URL ?? "").trim().replace(/\/+$/, "")}${path}`, {
    method, headers: { authorization: `Bearer ${(env.FLUX_CLOUD_GRANTS_TOKEN ?? "").trim()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(15_000) });
  let json: Json = {};
  try { const j = await res.json(); if (j && typeof j === "object") json = j as Json; } catch { /* a body-less answer is classified by its status */ }
  return { http: res.status, json };
}

/** H2: the B5 billing lease is still held (binds: home, holder, generation), checked by the allocation statement itself. */
const LEASE_HELD = `EXISTS (SELECT 1 FROM billing_home_leases WHERE home_id=? AND holder=? AND generation=? AND lease_until>=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))`;
/** H3 (Astra H2 #4): a B5 grant publication's allocation guard: the lease is held and the grant's current target intent is the one being
 *  published. With an initial target at `revision`: the reversal row's current target is that revision (the publication stamps it with
 *  MAX(1, target_revision)). Without one: the grant still has no covered refund target (one that appeared meanwhile must travel with it). */
function grantIntentGuard(invoiceId: string, kind: string, revision: number | null, lease: { homeId: string; holder: string; generation: number }) {
  return revision !== null
    ? { sql: `EXISTS (SELECT 1 FROM credit_reversals WHERE invoice_id=? AND kind=? AND scope='target' AND COALESCE(covered_cents,0)>0
          AND MAX(1,target_revision)=? AND reversed_at IS NULL) AND ${LEASE_HELD}`, binds: [invoiceId, kind, revision, lease.homeId, lease.holder, lease.generation] }
    : { sql: `NOT EXISTS (SELECT 1 FROM credit_reversals WHERE invoice_id=? AND kind=? AND scope='target' AND COALESCE(covered_cents,0)>0) AND ${LEASE_HELD}`,
        binds: [invoiceId, kind, lease.homeId, lease.holder, lease.generation] };
}

/** Lane H1: Flux's account of one grant (GET state: state, applied_revision, remaining_microcents; extra fields ignored), or null. */
export async function readGrantState(env: Env, doFetch: FetchLike, grantId: string, homeId?: string | null): Promise<RemoteGrantState | null> {
  const qs = new URLSearchParams({ grant_id: grantId, ...(homeId ? { home_id: homeId } : {}) });
  const { http, json } = await call(env, doFetch, "GET", `${GRANT_PATH}/state?${qs}`);
  return parseGrantState(http, json);
}

/** Lane H1: ONE FENCED GRANT MUTATION (flux-grant-fence.ts F1-F4), shared by the B5 hooks below and the B4 client (b4-flux.ts): the grant's
 *  owner row is claimed (compare-and-set) BEFORE any I/O, a grant whose last outcome is unknown or superseded is read back first (GET state;
 *  `settled` may answer from it without sending anything), the request's revision is allocated under the claim and sent as a TOP-LEVEL
 *  field (never part of the frozen body or its hash), and the answer is recorded before the owner row is released. A busy owner row is a
 *  definitive "nothing dispatched" (FluxNotDispatched). 409 stale_revision: FluxStaleRevision; 409 idempotency_mismatch (or the legacy
 *  revision_conflict): FluxRevisionMismatch (alerted high). Both are recorded and never re-sent at that revision. */
export interface FencedAnswer { http: number; json: Record<string, unknown>; wire: number; remote: RemoteGrantState | null }
export async function fencedMutation(env: Env, doFetch: FetchLike, a: { grantId: string; homeId: string; op: FenceOp; path: string; frozen: string;
  ownerKind: string; floor?: number; logical?: number; guard?: { sql: string; binds: unknown[] }; extra?: (wire: number) => Record<string, unknown>; onRevision?: (wire: number) => Promise<void>;
  settled?: (remote: RemoteGrantState) => Record<string, unknown> | null }): Promise<FencedAnswer> {
  const claim = await claimGrantFence(env.DB, { grantId: a.grantId, kind: a.ownerKind, homeId: a.homeId });
  if (!claim) throw new FluxNotDispatched("grant_owner_busy");
  let wire: number | null = null;
  let remote: RemoteGrantState | null = null;
  try {
    if (await fenceDue(env.DB, a.grantId)) {
      // H3: the snapshot is fenced by the row's state_seq read before the GET (a delayed read never overwrites newer state).
      try { remote = await reconcileOne(env.DB, a.grantId, a.homeId, (id) => readGrantState(env, doFetch, id, a.homeId)); } catch { remote = null; }
      const answer = remote && a.settled ? a.settled(remote) : null;
      if (answer) { await releaseGrantFence(env.DB, claim); return { http: 200, json: answer, wire: 0, remote }; }
    }
    const decision: AllocationDecision = {};
    wire = await allocateFenceRevision(env.DB, claim, { op: a.op, bodySha: await sha256Hex(a.frozen), floor: a.floor, logical: a.logical, guard: a.guard, homeId: a.homeId, decision });
    // H2: a superseded logical revision (or a lapsed billing lease / a newer target journaled) is refused AT the allocation: nothing is sent.
    // DISPUTE-FENCE-ACCOUNT: so is a credit grant for an account with an open email-proof dispute (the grant stays owed and is held, not lost).
    if (wire === null) {
      const why = decision.refusal ?? "owner_lost"; // decided by the refusing batch itself (Opus L2), never by a later re-read
      throw new FluxNotDispatched(why === "superseded" ? "logical_revision_superseded" : why === "account_disputed" ? "account_disputed" : "grant_owner_lost");
    }
    if (a.onRevision) await a.onRevision(wire);
  } catch (e) {
    if (wire !== null) await abandonFenceRevision(env.DB, claim, wire).catch(() => undefined);
    await releaseGrantFence(env.DB, claim).catch(() => undefined);
    throw e;
  }
  const extra = { ...(a.extra ? a.extra(wire) : {}), revision: wire };
  const body = `${a.frozen.replace(/\}\s*$/, "")}${Object.entries(extra).map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`).join("")}}`;
  let res: { http: number; json: Json };
  try { res = await call(env, doFetch, "POST", a.path, body); } catch (e) {
    await settleFenceRevision(env.DB, claim, { revision: wire, outcome: "unknown", homeId: a.homeId });
    throw e;
  }
  const rc = revisionRefusal(res.http, res.json);
  const outcome: FenceOutcome = res.http === 200 ? "applied" : rc?.code === "stale_revision" ? "superseded" : rc ? "mismatch"
    : res.http >= 500 ? "unknown" : "refused";
  await settleFenceRevision(env.DB, claim, { revision: wire, outcome, ...(rc?.applied != null ? { appliedRevision: rc.applied } : {}), homeId: a.homeId,
    detail: { op: a.op } });
  if (rc) {
    const latest = rc.applied != null ? (await logicalOf(env.DB, a.grantId, rc.applied)) ?? a.logical ?? rc.applied : a.logical ?? wire;
    if (rc.code === "stale_revision") throw new FluxStaleRevision(latest, rc.applied ?? 0);
    throw new FluxRevisionMismatch(rc.routerCode, latest, rc.applied ?? 0);
  }
  return { http: res.http, json: res.json, wire, remote };
}

/** Lane H1, item 1: THE ensure-account gate, shared by the keys client (first mint), the B4 grant delivery and the B5 grant ask. An owner
 *  with no link row gets its Flux account ensured and the link written (flux-link.ts ensureOwnerLinked). FluxMain's answers:
 *   200: linked. 503 (ensure_disabled while Flux's switch is off, unbound, any 5xx) or a timeout: HELD, retried with the existing backoff, no
 *   alert. 409 (a known Murage account with a different email: never sent again for it), 422 (a disposable email) and any other 4xx: HELD
 *   with ONE high alert (flux.ensure_account_refused) and NO automatic retry while it is open (ops resolves it). 401/403: a configuration
 *   alert (flux.ensure_account_unauthorized), nothing dispatched for anyone, no retry loop while it is open.
 *  Returns "linked" (a link row exists now), "held" (no stored email: nothing called), "unavailable"
 *  (retry later), "refused", "email_unverified" (unproven: nothing called; a 202, a standing hold deadline, or an open dispute) or "stale" (answered in flight on a state
 *  that moved: nothing linked, asked again next sweep). `opts.wake`: the wake-up after a proof, the one caller not stopped by the deadline. */
export async function ensureOwnerAccount(env: Env, ownerId: string, homeId: string,
  call: (a: { murageAccountId: string; email: string; emailVerified: boolean }) => Promise<{ fluxAccountId: string; created?: boolean }>, now = Date.now(),
  opts: { wake?: boolean } = {}): Promise<EnsureOutcome> {
  // M-d: an open flux.link_email_mismatch_unlinked blocks this ONE account (the wake included) until Flux re-points the link and ops resolves it.
  const blocked = await env.DB.prepare(`SELECT kind FROM cloud_alerts WHERE resolved_at IS NULL AND ((kind='flux.ensure_account_refused' AND subject=?1)
    OR (kind='flux.ensure_account_unauthorized' AND subject='ensure:config') OR (kind='flux.link_email_mismatch_unlinked' AND subject=?2))
    ORDER BY kind='flux.link_email_mismatch_unlinked' DESC LIMIT 1`).bind(`ensure:${ownerId}`, `account:${ownerId}`).first<{ kind: string }>();
  if (blocked) return opts.wake && blocked.kind === "flux.link_email_mismatch_unlinked" ? "link_email_mismatch" : "refused";
  // H2 (astra-code1): an open email-proof dispute for the account means no call to Flux at all, whatever the address now is: a hold, until
  // support's dispute-clear. The same fence is in the link INSERT (flux-link.ts ensureOwnerLinked) for an ensure already in flight.
  if (await env.DB.prepare("SELECT 1 AS x FROM flux_email_proof_disputes WHERE account_id=?").bind(ownerId).first()) return "email_unverified";
  // M1: ONE account-level hold deadline (flux_email_hold), read by every caller (first key, B5 ask, B4 delivery) before Flux is asked. Only the
  // wake-up after a proof asks through it (it carries the proof Flux waits for). Only a deadline for the CURRENT address revision holds.
  if (!opts.wake && await emailHoldStanding(env, ownerId, now)) return "email_unverified";
  try {
    const r = await ensureOwnerLinked(env, ownerId, call);
    // (P-call): unproven means Flux was not called. A LOCAL hold: no failure, no deadline, no alert (under flow A every new buyer starts here,
    // so a page per buyer would page for every sale; the 24 h page is flux-email-proof.ts sweepFluxEmailStuck).
    if (r === UNPROVEN) return "email_unverified";
    return r === STALE ? "stale" : r ? "linked" : "held";
  } catch (e) {
    // Caught BEFORE ensureOwnerLinked's insert (the throw comes out of `call`): no flux_links row, no failure counted, no refusal alert.
    const rev = (e as { revision?: number } | null)?.revision ?? -1;
    const fresh = `NOT EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=?1) AND EXISTS (SELECT 1 FROM supabase_identities WHERE user_id=?1 AND email_revision=?2)`;
    if (e instanceof FluxEmailUnverified) {
      // Every call carries email_verified: true (P-call), so a 202 is Flux refusing a PROVEN address. M1: the deadline moves ONLY on an actual
      // 202, to now + 15 min, and only while the revision that got the 202 is still current and no link exists: a late 202 (the wake-up linked
      // meanwhile, or the address moved) is discarded. ONE paging alert per account and revision (flux.ensure_verified_refused), under the same
      // condition, resolved when the account links (flux-link.ts LINK_RESOLVES_SQL).
      const [held] = await env.DB.batch([
        env.DB.prepare(`INSERT INTO flux_email_hold (account_id,email_revision,until_at,updated_at) SELECT ?1,?2,?3+${EMAIL_HOLD_MS},?3 WHERE ${fresh}
          ON CONFLICT(account_id) DO UPDATE SET email_revision=excluded.email_revision,until_at=excluded.until_at,updated_at=excluded.updated_at`)
          .bind(ownerId, rev, now),
        env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) SELECT ?3,?4,'flux.ensure_verified_refused','high',?5,?6,?7
          WHERE ${fresh} ON CONFLICT DO NOTHING`).bind(ownerId, rev, `alert:ensure_verified_refused:${ownerId}:${rev}`, homeId,
          JSON.stringify({ accountId: ownerId, revision: rev, rule: "Flux answered pending_verification to an ensure that carried a proven email. No key is minted and no credit sent for this account until it links." }),
          now, `account:${ownerId}`),
      ]);
      if ((held.meta.changes ?? 0) > 0) return opts.wake ? "verified_refused" : "email_unverified";
      return (await linkRowOf(env, ownerId)) ? "linked" : "stale";
    }
    if (e instanceof FluxEnsureRefused && e.status === 409 && e.reason === LINK_EMAIL_MISMATCH) {
      // M-d: the id is linked at Flux under another email and no Cloud link row exists (the accepted residual: a TRUE ensure committed at Flux and
      // its local INSERT lost to an address move). ONE distinct page per account, the account id only; only this account is blocked (above).
      await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) SELECT ?2,?3,'flux.link_email_mismatch_unlinked','high',?4,?5,?6
        WHERE NOT EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=?1) ON CONFLICT DO NOTHING`)
        .bind(ownerId, `alert:link_email_mismatch_unlinked:${ownerId}`, homeId, JSON.stringify({ accountId: ownerId }), now, `account:${ownerId}`).run();
      if (await linkRowOf(env, ownerId)) return "linked";
      return opts.wake ? "link_email_mismatch" : "refused";
    }
    if (e instanceof FluxEnsureRefused) {
      const auth = e.status === 401 || e.status === 403;
      await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) VALUES (?,?,?,'high',?,?,?) ON CONFLICT DO NOTHING`)
        .bind(auth ? "alert:flux_ensure_account_unauthorized" : `alert:flux_ensure_account:${ownerId}`, auth ? "billing" : homeId,
          auth ? "flux.ensure_account_unauthorized" : "flux.ensure_account_refused", JSON.stringify({ homeId, status: e.status,
            rule: auth ? "Flux refused the service credential on ensure-account: fix FLUX_CLOUD_SERVICE_TOKEN; nothing is dispatched until this alert is resolved"
              : "Flux refused to ensure this owner's account (409: the account is known with another email; 422: disposable email): no key is minted and no grant dispatched for this owner, and ensure-account is not called again until a person resolves it and this alert" }),
          now, auth ? "ensure:config" : `ensure:${ownerId}`).run();
      return "refused";
    }
    if (e instanceof FluxHookRetry) return "unavailable";
    throw e;
  }
}

/** Lane H1, item 1: ensure the owner's Flux account (FluxMain's ensure-account), Bearer FLUX_CLOUD_SERVICE_TOKEN. 4xx: FluxEnsureRefused;
 *  5xx, a timeout or an unusable answer: FluxHookRetry (retried with the existing backoff). The email is sent, never logged. */
export async function ensureFluxAccount(env: Env, doFetch: FetchLike, input: { murageAccountId: string; email: string; emailVerified: boolean }): Promise<{ fluxAccountId: string; created: boolean }> {
  const token = (env.FLUX_CLOUD_SERVICE_TOKEN ?? "").trim();
  if (!token) throw new FluxNotDispatched("service_token_absent");
  let base: string;
  try {
    const u = new URL((env.FLUX_APP_BASE ?? "").trim() || "https://fluxrouter.ai");
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("bad");
    base = u.origin;
  } catch { throw new FluxNotDispatched("flux_app_base_invalid"); }
  const bypass = (env.FLUX_STAGING_VERCEL_BYPASS ?? "").trim();
  const stagingApp = bypass !== "" && (env as { MURAGE_ENV?: string }).MURAGE_ENV === "staging" && new URL(base).hostname === STAGING_FLUX_APP_HOST;
  let res: Response;
  try {
    res = await doFetch(`${base}${ENSURE_ACCOUNT_PATH}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", ...(stagingApp ? { "x-vercel-protection-bypass": bypass } : {}) },
      // email_verified is exactly true only for a proven address (flux-link.ts ownerEmailProofOf); anything else is false, never omitted.
      body: JSON.stringify({ murage_account_id: input.murageAccountId, email: input.email, email_verified: input.emailVerified === true }) });
  } catch { throw new FluxHookRetry("ensure_account_unavailable"); }
  let j: Json = {};
  try { const v = await res.json(); if (v && typeof v === "object") j = v as Json; } catch { /* classified by status */ }
  if (res.status === 200 && typeof j.flux_account_id === "string" && j.flux_account_id.trim() !== "" && j.flux_account_id.length <= 128) {
    return { fluxAccountId: j.flux_account_id, created: j.created === true };
  }
  // The typed hold: ONLY a 202 whose body status is exactly "pending_verification". Any other 202 stays a retry (below).
  if (res.status === 202 && j.status === "pending_verification") throw new FluxEmailUnverified();
  if (res.status >= 400 && res.status < 500) {
    const reason = typeof j.error === "string" ? j.error : typeof j.code === "string" ? j.code : null;
    throw new FluxEnsureRefused(res.status, reason);
  }
  throw new FluxHookRetry("ensure_account_unavailable");
}

/** The three hooks that talk to the router. Each runs the token guard first. 200 with a status of the design's table resolves; 409 is a
 *  held retry (review); 503 (credit_grants_retry busy|unavailable, issuance_paused, unbound, misconfigured) is a retry; ANY other answer
 *  (400, 401, 404, 413, 422 ceiling, a 5xx, a network error, a timeout) THROWS A PLAIN ERROR (an infrastructure failure that escapes, nothing
 *  recorded as an attempt); a lost response is simply asked again with the same bytes. */
/** `reversalTargets`: the router this client talks to has been QUALIFIED against the reversal-target contract (the cutover checklist): only
 *  then do the hooks advertise capabilities.reversalTargets, and only then does billing dispatch a versioned target. Off by default. */
export function grantsHooks(doFetch: FetchLike = (u, i) => fetch(u, i), options: { reversalTargets?: boolean } = {}) {
  // wp5-p5 / Astra JOURNEY-A-8 #2: the router itself is asked (GET capabilities) before EVERY target and every grant that carries an initial
  // target: never cached, so a router downgraded meanwhile receives nothing it cannot apply atomically (a retry or a hold, nothing sent).
  /** The router's own capability answer. Any fault or a missing route reads as nothing advertised. */
  type Caps = { reversalTargets: boolean; grantWithTarget: boolean; grantState: boolean; adoptLegacyReversal: boolean; topupGrants: boolean };
  const NONE: Caps = { reversalTargets: false, grantWithTarget: false, grantState: false, adoptLegacyReversal: false, topupGrants: false };
  /** Astra JOURNEY-A-10 #1: Flux is OFF at launch. Before ANY grant or reversal request (and the capability read), Flux must be explicitly
   *  switched on (the Flux route switch "1") AND this client built for a qualified router ({ reversalTargets: true }); otherwise nothing
   *  is sent, whatever token and URL are configured, and ONE alert says why. Then the token guard (D3). */
  const dispatchGuard = async (env: Env, hook: string, now: number): Promise<string | null> => {
    if (!fluxRoutesEnabled(env) || options.reversalTargets !== true) { await configAlert(env, "credit.flux_off", hook, now); return "flux_off"; }
    // PRODFLUX (Astra HIGH 2): both Flux credentials, not just the grants token (grantsGuard checks that one and the URL).
    if (fluxCredentialsMissing(env) === "flux_service_token_absent") { await configAlert(env, "credit.flux_service_token_absent", hook, now); return "flux_service_token_absent"; }
    return grantsGuard(env, hook, now);
  };
  const readCapabilities = async (env: Env): Promise<Caps> => {
    if (await dispatchGuard(env, "readCapabilities", Date.now())) return NONE;
    try {
      const { http, json } = await call(env, doFetch, "GET", CAPABILITIES_PATH);
      const caps = (json.capabilities ?? {}) as Json;
      const has = (k: string) => http === 200 && caps[k] === true;
      return { reversalTargets: has("reversalTargets"), grantWithTarget: has("grantWithTarget"), grantState: has("grantState"), adoptLegacyReversal: has("adoptLegacyReversal"), topupGrants: has("topupGrants") };
    } catch { return NONE; }
  };
  /** A receipt's echoed held target (Astra JOURNEY-A-9 #1), when the router says it. */
  const echoed = (t: Json): number | undefined => typeof t.target_removed_microcents === "number" && Number.isSafeInteger(t.target_removed_microcents)
    && t.target_removed_microcents >= 0 ? t.target_removed_microcents : undefined;
  return {
    capabilities: options.reversalTargets === true ? { reversalTargets: true } : {},
    readCapabilities,
    /** Sends the claim's frozen bytes. Resolves the router's answer ({status: granted | already_granted | not_applied_reversed}).
     *  Astra JOURNEY-A-8 #2: `initialTarget` (the grant's pending refund target) goes IN THE SAME REQUEST (`initial_target`, applied by the
     *  router in the grant's own transaction: the grant is never live without it); the frozen bytes are unchanged (initial_target is outside
     *  the body hash). Sent only after the router advertised grantWithTarget on this very publish; the answer's target receipt is returned. */
    async grantMonthlyCredits(env: Env, input: { homeId: string; invoiceId: string; kind?: GrantKind;
      initialTarget?: { targetRemovedMicrocents: number; revision: number } },
      /** H3 (Astra H2 #4): the B5 billing lease the caller holds. The wire revision is allocated only while it is held AND the grant's CURRENT
       *  intent is still the one published (one atomic statement): with an initial target, the reversal row's current target revision is still
       *  that target's; without one, the grant still has no refund target to carry. A superseded publication is refused, nothing sent. */
      fence?: { lease?: { homeId: string; holder: string; generation: number } }): Promise<{ status: string; state?: string;
      target?: { grantId: string; revision: number; removedMicrocents: number; targetRemovedMicrocents?: number } }> {
      const refused = await dispatchGuard(env, "grantMonthlyCredits", Date.now());
      if (refused) throw new FluxNotDispatched(refused);
      const kind = input.kind ?? "period";
      const row = await env.DB.prepare("SELECT body_json,body_sha256 FROM credit_grants WHERE invoice_id=? AND kind=?").bind(input.invoiceId, kind)
        .first<{ body_json: string | null; body_sha256: string | null }>();
      if (!row?.body_json || !row.body_sha256) throw new FluxNotDispatched("grant_body_missing");
      if ((await sha256Hex(row.body_json)) !== row.body_sha256) throw new FluxNotDispatched("grant_body_corrupt");
      // A top-up is sent only to a router that advertises topupGrants on this very call; otherwise it is held and retried (alarmed after 2 hours).
      if (kind === "topup" && !(await readCapabilities(env)).topupGrants) throw new FluxHookRetry("router_topup_grants_absent");
      const it = input.initialTarget;
      if (it && !(await readCapabilities(env)).grantWithTarget) throw new FluxGrantTargetUnsupported("router_grant_with_target_absent");
      const grantId = `${input.invoiceId}:${kind}`;
      // Lane H1: the frozen bytes plus TOP-LEVEL fields (the revision, and the initial target at the same revision), sent under the grant's
      // fence. A grant read back as existing at Flux (after an unknown or superseded ask) is answered from that read, never sent again.
      const ans = await fencedMutation(env, doFetch, { grantId, homeId: input.homeId, op: "grant", path: GRANT_PATH, frozen: row.body_json, ownerKind: "b5_grant",
        ...(fence?.lease ? { guard: grantIntentGuard(input.invoiceId, kind, it?.revision ?? null, fence.lease) } : {}),
        ...(it ? { floor: it.revision, logical: it.revision,
          extra: (w: number) => ({ initial_target: { target_removed_microcents: it.targetRemovedMicrocents, revision: w } }) } : {}),
        settled: (r) => it || r.state === "not_found" ? null : r.state === "tombstoned" ? { status: "not_applied_reversed" } : { status: "already_granted", state: r.state } });
      const { http, json } = ans;
      const status = String(json.status ?? "");
      if (http === 200 && ["granted", "already_granted", "not_applied_reversed"].includes(status)) {
        const t = (json.target ?? null) as Json | null;
        const tRev = t && typeof t.revision === "number" && Number.isSafeInteger(t.revision) && t.revision > 0
          ? (t.revision === ans.wire && it ? it.revision : (await logicalOf(env.DB, grantId, t.revision)) ?? t.revision) : null;
        const target = it && t && t.grant_id === grantId && tRev !== null
          && typeof t.removed_microcents === "number" && Number.isSafeInteger(t.removed_microcents) && t.removed_microcents >= 0
          // Astra JOURNEY-A-9 #1: the held target only as the router states it (a replay may answer an older or conflicting held receipt).
          ? { grantId, revision: tRev, removedMicrocents: t.removed_microcents, ...(echoed(t) !== undefined ? { targetRemovedMicrocents: echoed(t) } : {}) } : undefined;
        return { status, ...(typeof json.state === "string" ? { state: json.state } : {}), ...(target ? { target } : {}) };
      }
      // A router that does not implement initial_target refuses the unknown field (400) before any state change: nothing applied, held.
      if (it && http === 400) throw new FluxGrantTargetUnsupported(`router_400_${errorCode(json)}`.slice(0, 80));
      // A top-up is paid before it is granted: a 409 account_not_fresh is reachable here. It is alarmed, never retried as a transient error.
      if (kind === "topup" && http === 409 && errorCode(json) === "account_not_fresh") throw new FluxGrantPermanent("account_not_fresh");
      if (http === 409) throw new FluxGrantHeld(errorCode(json));
      if (http === 503) throw new FluxHookRetry(retryCode(json));
      // 422 on a top-up: the router's ceiling refused credit the customer already paid for. One alert per grant, then the plain error as before.
      if (kind === "topup" && http === 422) {
        await env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .bind(`alert:topup_ceiling:${grantId}`, "billing", "credit.topup_ceiling", "high", JSON.stringify({ homeId: input.homeId, grantId, code: errorCode(json) }), Date.now()).run();
        throw new FluxGrantPermanent("topup_ceiling"); // permanent: the claim is suppressed, never asked again
      }
      throw new Error(`grants_router_${http}_${errorCode(json)}`);
    },
    async revokeCredits(env: Env, input: { homeId: string; invoiceId: string; kind: GrantKind; grantId: string; reason: string }): Promise<{ status: string }> {
      const refused = await dispatchGuard(env, "revokeCredits", Date.now());
      if (refused) throw new FluxHookRetry(refused);
      const body = JSON.stringify({ grant_id: input.grantId, invoice_id: input.invoiceId, kind: input.kind, home_id: input.homeId, reason: input.reason.slice(0, 500) });
      const { http, json } = await fencedMutation(env, doFetch, { grantId: input.grantId, homeId: input.homeId, op: "reverse", path: `${GRANT_PATH}/reverse`,
        frozen: body, ownerKind: "b5_reverse" });
      const status = String(json.status ?? "");
      if (http === 200 && ["reversed", "already_reversed", "no_grant"].includes(status)) return { status };
      if (http === 409) throw new FluxHookRetry(`router_409_${errorCode(json)}`.slice(0, 80));
      if (http === 503) throw new FluxHookRetry(retryCode(json));
      if (http === 422) throw new FluxReversalPermanent(errorCode(json));
      throw new Error(`grants_router_${http}_${errorCode(json)}`);
    },
    /** Astra JOURNEY-A-6 #2: sets ONE grant's cumulative removal target at a revision (the contract file). Resolves only with a receipt the
     *  router answered for exactly this grant: {grantId, revision, removedMicrocents} (the caller applies it only if the revision is still its
     *  latest). 409 stale_revision (the router holds a newer revision) and every other 409, 404 grant_not_found (the grant has not landed at the
     *  router) and 503 are retries; anything else throws (infrastructure). */
    async setReversalTarget(env: Env, input: { homeId: string; invoiceId: string; kind: GrantKind; grantId: string; reason: string;
      targetRemovedMicrocents: number; revision: number; adoptLegacyReversal?: boolean },
      /** H2: the B5 billing lease the caller holds: the wire revision is allocated only while it is held AND the reversal row's current target
       *  revision is still `revision` (one atomic statement), so an obsolete target never receives a newer wire revision. */
      fence?: { lease?: { homeId: string; holder: string; generation: number } }): Promise<{ grantId: string; revision: number; removedMicrocents: number;
      targetRemovedMicrocents?: number }> {
      const refused = await dispatchGuard(env, "setReversalTarget", Date.now());
      if (refused) throw new FluxHookRetry(refused);
      const caps = await readCapabilities(env);
      if (!caps.reversalTargets) throw new FluxHookRetry("router_capability_absent");
      if (input.adoptLegacyReversal && !caps.adoptLegacyReversal) throw new FluxHookRetry("router_adopt_capability_absent");
      // Lane H1: the target's own revision (credit_reversals.target_revision) is the FLOOR of the wire revision allocated under the grant's
      // fence (one revision space per grant: grant, reverse and target alike); receipts are read back in the target's own revision.
      const body = JSON.stringify({ grant_id: input.grantId, invoice_id: input.invoiceId, kind: input.kind, home_id: input.homeId, reason: input.reason.slice(0, 500),
        target_removed_microcents: input.targetRemovedMicrocents, ...(input.adoptLegacyReversal ? { adopt_legacy_reversal: true } : {}) });
      const ans = await fencedMutation(env, doFetch, { grantId: input.grantId, homeId: input.homeId, op: "target", path: `${GRANT_PATH}/reversal-target`,
        frozen: body, ownerKind: "b5_target", floor: input.revision, logical: input.revision,
        ...(fence?.lease ? { guard: {
          sql: `EXISTS (SELECT 1 FROM credit_reversals WHERE invoice_id=? AND kind=? AND scope='target' AND target_revision=? AND reversed_at IS NULL)
            AND ${LEASE_HELD}`,
          binds: [input.invoiceId, input.kind, input.revision, fence.lease.homeId, fence.lease.holder, fence.lease.generation] } } : {}) });
      const { http, json } = ans;
      const removed = json.removed_microcents;
      const wireRev = json.revision;
      const revision = typeof wireRev === "number" && Number.isSafeInteger(wireRev) && wireRev > 0
        ? (wireRev === ans.wire ? input.revision : (await logicalOf(env.DB, input.grantId, wireRev)) ?? wireRev) : wireRev;
      if (http === 200 && json.grant_id === input.grantId && typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
        && typeof removed === "number" && Number.isSafeInteger(removed) && removed >= 0) {
        // Astra JOURNEY-A-9 #1: the target held at that revision. The route answers 200 for the asked revision ONLY when it holds it with this
        // target (another target is 409 revision_conflict), so an unechoed receipt for the asked revision holds the asked target; any echo is
        // taken as said (a different one is a conflict for the caller), and an unechoed receipt of another revision states no target.
        const held = echoed(json) ?? (revision === input.revision ? input.targetRemovedMicrocents : undefined);
        return { grantId: input.grantId, revision, removedMicrocents: removed, ...(held !== undefined ? { targetRemovedMicrocents: held } : {}) };
      }
      const latest = json.latest_revision;
      if (http === 409 && ["stale_revision", "revision_conflict"].includes(errorCode(json)) && typeof latest === "number" && Number.isSafeInteger(latest) && latest > 0) {
        throw new FluxTargetStale(errorCode(json), latest);
      }
      if (http === 409) throw new FluxHookRetry(`router_409_${errorCode(json)}`.slice(0, 80));
      if (http === 404 && errorCode(json) === "grant_not_found") throw new FluxHookRetry("router_grant_not_found");
      if (http === 503) throw new FluxHookRetry(retryCode(json));
      if (http === 422) throw new FluxReversalPermanent(errorCode(json));
      throw new Error(`grants_router_${http}_${errorCode(json)}`);
    },
    /** Lane H1, item 1: before the FIRST grant of an owner with no Flux link, the owner's Flux account is ensured (FluxMain's ensure-account,
     *  idempotent on the Murage account id) and the link row written (link_id = the Flux account id, version 1) through flux-link.ts, so keys
     *  and grants resolve the same account. Flux off, or a token absent: nothing is called. A refusal (4xx) throws FluxEnsureRefused (the
     *  caller alerts; nothing is dispatched for the owner); a 5xx/timeout throws FluxHookRetry (retried with the existing backoff). */
    async ensureAccount(env: Env, input: { homeId: string }): Promise<EnsureOutcome | void> {
      if (await dispatchGuard(env, "ensureAccount", Date.now())) return;
      if (!present(env.FLUX_CLOUD_SERVICE_TOKEN)) return;
      const owner = await homeOwnerOf(env, input.homeId);
      if (owner === null || (await linkRowOf(env, owner)) !== null) return;
      // The typed result reaches askGrant: "email_unverified" is a LOCAL hold there (grant_held:email_unverified), before any router call.
      return ensureOwnerAccount(env, owner, input.homeId, (a) => ensureFluxAccount(env, doFetch, a));
    },
    /** Lane H1, item 3 (F4): reads back every grant whose last fenced outcome is unknown, superseded or a mismatch (bounded). Flux off: nothing. */
    async reconcileFences(env: Env, limit = 20): Promise<number> {
      if (await dispatchGuard(env, "reconcileFences", Date.now())) return 0;
      const rows = await fencesToReconcile(env.DB, limit); // H2: unknown/superseded outcomes AND orphan revisions of gone owners
      let n = 0;
      for (const r of rows) {
        try { if (await reconcileOne(env.DB, r.grant_id, r.home_id, (id) => readGrantState(env, doFetch, id, r.home_id))) n++; }
        catch { /* stays due */ }
      }
      return n;
    },
    /** Astra JOURNEY-A-9 #2: the router's account of ONE grant (GET state, capability grantState), read before a legacy refund-backed /reverse
     *  row is converted. Resolves {state: active | reversed | tombstoned | not_found, removedMicrocents, consumedMicrocents}; no capability,
     *  a 409 or a 503 is a retry (the row stays pending); anything else throws. */
    async grantReversalState(env: Env, input: { homeId: string; invoiceId: string; kind: GrantKind; grantId: string }): Promise<{
      state: "active" | "reversed" | "tombstoned" | "not_found"; removedMicrocents: number; consumedMicrocents: number }> {
      const refused = await dispatchGuard(env, "grantReversalState", Date.now());
      if (refused) throw new FluxHookRetry(refused);
      if (!(await readCapabilities(env)).grantState) throw new FluxHookRetry("router_grant_state_absent");
      const qs = new URLSearchParams({ grant_id: input.grantId, home_id: input.homeId });
      const { http, json } = await call(env, doFetch, "GET", `${GRANT_PATH}/state?${qs}`);
      const state = json.state; const removed = json.removed_microcents; const consumed = json.consumed_microcents;
      if (http === 200 && json.grant_id === input.grantId && (state === "active" || state === "reversed" || state === "tombstoned" || state === "not_found")
        && typeof removed === "number" && Number.isSafeInteger(removed) && removed >= 0 && typeof consumed === "number" && Number.isSafeInteger(consumed) && consumed >= 0) {
        return { state, removedMicrocents: removed, consumedMicrocents: consumed };
      }
      if (http === 409) throw new FluxHookRetry(`router_409_${errorCode(json)}`.slice(0, 80));
      if (http === 503) throw new FluxHookRetry(retryCode(json));
      throw new Error(`grants_router_${http}_${errorCode(json)}`);
    },
    /** Usage page only, never money. Grants whose period_end is in (start, end]. Any fault throws; never a 0. */
    async usedIncludedCreditMicrocents(env: Env, input: { homeId: string; periodStart: number; periodEnd: number; usedThrough: number }): Promise<{ usedMicrocents: number }> {
      // Flux off (Astra JOURNEY-A-10 #1): not even a read reaches the router; the page shows "unavailable".
      if (await dispatchGuard(env, "usedIncludedCreditMicrocents", Date.now())) throw new Error("included_credit_unavailable");
      const q = new URLSearchParams({ home_id: input.homeId, period_start: isoUtc(input.periodStart), period_end: isoUtc(input.periodEnd) });
      const { http, json } = await call(env, doFetch, "GET", `${GRANT_PATH}/usage?${q}`);
      const used = json.consumed_microcents;
      if (http !== 200 || typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) throw new Error("included_credit_unavailable");
      return { usedMicrocents: used };
    },
  };
}
