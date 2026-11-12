// SPDX-License-Identifier: AGPL-3.0-or-later
// B4: Murage Cloud <-> Flux.
//
//  * Link a Murage account to a Flux account. Proof of BOTH sessions: the owner
//    holds a Murage session (the Bearer on these routes) AND a Flux session, which
//    Flux turns into a short-lived Ed25519-signed proof bound to this link's
//    one-time state. Never an email match.
//  * Issue each home its own Flux key (capped, expiring, bound to the home's IPs,
//    with a generation). The owner's primary Flux key never reaches a home.
//  * Stop: revoke every key of a home. Cap: change its monthly limit.
//  * Monthly included credits (called by Billing, B5): one entitlement per home and
//    subscription period (an upgrade adds only the delta), idempotent on the Stripe
//    invoice id, delivered to the Flux account linked when it was created, expiring
//    one month after the period ends. Refund, dispute or cancel holds the home and
//    cancels delivery of pending grants; credit itself follows the money actually
//    returned, through the grant ledger (b4-flux-ledger.ts).
//  * Versions close every race. A link has an identity and a version; unlink FENCES it
//    before any home is stopped. A mint is bound to the link, the billing state, a monotonic
//    lifecycle version and a cap version (all sent to the router), and its final D1 commit is
//    conditional on the link, billing and lifecycle version. A mint that may have published a key is
//    covered by a durable compensate op that revokes THAT generation (scope "key"), retried by the cron.
//  * ONE serializer per home. Every lifecycle request writes its intent (flux_home_ops) in the same
//    D1 batch as its state change, before any network call; router calls then run one op at a time, in
//    order, under a per-home lease (see "Per-home operation journal and lease"). Nothing is undone on a
//    failure: the op is retried until the router answers.
//  * Credits: invoice, entitlement (amount already granted in the period) and delivery outbox
//    commit in ONE D1 batch. Delivery is claimed durably before any network call, and a
//    revocation is a tombstone: only a definitive 200 ends it.
//
// No Flux secret is stored here. The home key is returned once to the caller.
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ControlPlaneAuth } from "./auth";
import { boundCustomer } from "./customer-identity";
import { commitStatement, heldFluxHolder, journalDispatch, pinnedHomeGeneration, pinnedLinkRevision, pinnedTargetHolds, reserveStatement } from "./step-up-op";
import { LEASE_FRESH_MS, machine } from "./b3-control";
import { alertStatement } from "./ops-monitor";
import { firstKeyRetryDelayMs, fluxRenewalStatus, neverKeyed, paidLiveSql, readRenewalState, renewalHeldBack, renewalOpId, RENEWAL_WINDOW_MS, unacknowledged, unadopted } from "./b4-flux-renewal";
import { ackRequest, renewalDueRequest, subkeyRequest } from "../../../shared/flux-renewal-wire";
import {
  defaultCapUsd,
  fluxCredentialsMissing,
  fluxReadiness,
  fluxResumeViaPoller,
  fluxRevokeOnlyConfigured,
  fluxRoutesEnabled,
  fluxServing,
  fluxSweepConfigured,
  microcentsToUsd,
  readFluxConfig,
  usdToMicrocents,
  type FluxConfig,
} from "./b4-flux-config";
import { HTTPError, json, readBoundedJSON } from "./http";
import {
  cancellationJournalStatements, claimDispatch, completeDelivery, completeRevoke, DB_NOW_MS, DEFINITIVE_REFUSALS, DISPUTE_OPEN_HOLD, grantScope,
  homeScope, ledgerPage, listScope, operatorApplied, operatorClaim, REVOKE_AUTO, refreshStatements, syncAlertStatements, type DeliverResult,
  type RevokeResult, type Scope,
} from "./b4-flux-ledger";
import { homeOwnerOf as defaultOwnerOf, linkFenceSql, linkOf, linkRowOf, type LinkRow } from "./flux-link";
import { addOneMonthUtc, EMAIL_HOLD_MS, ensureFluxAccount, ensureOwnerAccount, fencedMutation, fluxCredentialsAlert, FluxHookRetry, FluxNotDispatched, FluxRevisionMismatch, FluxStaleRevision,
  GRANT_PATH, grantsReady, isoUtc, readGrantState } from "./flux-grants";
import { reconcileFences, type RemoteGrantState } from "./flux-grant-fence";
import { sha256 } from "./installations";
import { fluxEmailProofOperatorRoute, OPERATOR_ROUTE as PROOF_OPERATOR_ROUTE } from "./flux-email-proof";
import { accountDisputeOpen, accountDisputeOpenSql, capRaiseFence, homeDisputeOpen, homeDisputeOpenSql } from "./flux-dispute-fence";
import type { TransactionalEmailSender } from "./email";
import { fluxDispatchEnabled, stubFluxHooks, type FluxEntitlementHooks } from "./b5-billing";

const LINK_AUDIENCE = "murage-cloud-link";
const PROOF_MAX_AGE_S = 600;
const FLUX_TIMEOUT_MS = 10_000;
const GRANT_MAX_ATTEMPTS = 20;
const GRANT_RETRY_AFTER_MS = 10 * 60 * 1000;
const HOME_ID = /^[\w-]{1,128}$/;

// ── Flux, as this control plane talks to it ──────────────────────────────────

export interface FluxMint {
  accountId: string;
  homeId: string;
  generation: number;
  boundIps: string[];
  capMicrocents: number;
  ttlSeconds: number;
  /** The monotonic operation version of this mint (an owner resume advances it first). */
  lifecycleVersion: number;
  /** The link this mint is bound to (identity and monotonic version). */
  linkId: string;
  linkVersion: number;
  /** Monotonic per home; bumped on every cap change, including the one at issue. */
  capVersion: number;
  /** The router refuses "held". */
  billingState: "ok" | "held";
  /** Sent as owner_resume. True only on the poller's resume mint (a lifecycle the owner's resume wrote, until one key at it is acked) and on the
   *  test-only legacy owner mint; an ordinary renewal sends false. The router lifts a Stop only for a true one. */
  ownerResume: boolean;
  opId: string;
}
export interface FluxMinted {
  key: string;
  expiresAt: string;
  generation: number;
  capMicrocents: number;
}
export interface FluxGrant {
  grantId: string;
  entitlementKey: string;
  recipientFluxAccountId: string;
  homeId: string;
  plan: string;
  amountMicrocents: number;
  /** ISO-8601 */
  periodStart: string;
  periodEnd: string;
  expiresAt: string;
  /** One per delivery attempt (the durable claim id). */
  deliveryId: string;
  /** Lane H1: the invoice and kind the Flux grant id is made of (`invoice_id:kind`, the router's grant routes). */
  invoiceId?: string | null;
  kind?: string;
  /** Lane H1 (R11): told the fenced revision BEFORE the request leaves (the dispatch records it). */
  onRevision?: (wireGrantId: string, revision: number) => Promise<void>;
  /** H3 (Astra H2 #5): the local dispatch this request belongs to (the ledger's claim token). The wire revision is allocated only while that
   *  dispatch is still open and unexpired (checked in the allocation statement itself): a superseded dispatch never gets a fresh revision. */
  dispatchToken?: string;
}
export interface FluxHomeStatus {
  state: string;
  generation?: number;
  capMicrocents?: number;
  spentMicrocents?: number;
  resetsAt?: string;
  expiresAt?: string;
  /** Consumed-adjusted spendable balance of the account. null = unknown. */
  accountSpendableMicrocents?: number | null;
  /** The account's real recharge setting. null = unknown, never assumed true. */
  accountAutoTopUpEnabled?: boolean | null;
}

/** Raised for any Flux answer that is not a success; `status` is Flux's. */
export class FluxError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly code: string = "",
  ) {
    super(`flux ${status}`);
  }
}

export interface FluxClient {
  mint(input: FluxMint): Promise<FluxMinted>;
  /** scope "home": raises the lifecycle floor, stops the home and kills all its keys. */
  stop(homeId: string, lifecycleVersion: number, options?: { linkVersion?: number; reason?: string }): Promise<void>;
  /** scope "key": revokes ONLY that generation's key (compensation of a mint). Idempotent. */
  revokeKey(homeId: string, generation: number, lifecycleVersion: number, reason: string): Promise<void>;
  setCap(homeId: string, capMicrocents: number, capVersion: number): Promise<void>;
  status(homeId: string): Promise<FluxHomeStatus>;
  grant(input: FluxGrant): Promise<void>;
  /** Ask the Flux app to revoke the unspent remainder of a grant. It ALWAYS writes a tombstone;
   *  only a 200 {status: "revoked" | "tombstoned"} is definitive. */
  revokeGrant(grantId: string, reason: string, ctx?: { invoiceId: string | null; kind: string; homeId: string;
    onRevision?: (wireGrantId: string, revision: number) => Promise<void>; dispatchToken?: string }): Promise<"revoked" | "tombstoned">;
  /** Lane H1 (fence F4): Flux's GET state of one grant (by its Flux grant id), or null when it cannot be read. */
  grantState?(wireGrantId: string): Promise<RemoteGrantState | null>;
  /** Lane H1, item 1: FluxMain's ensure-account (idempotent on the Murage account id). */
  ensureAccount?(input: { murageAccountId: string; email: string; emailVerified: boolean }): Promise<{ fluxAccountId: string; created: boolean }>;
  /** INTEGRATED-12 (ledger R8c): Flux's OWN record of an operator's hand adjustment (by its issued reference): what the grant holds after it,
   *  or null when Flux has no such entry. Optional: the Flux read API is the Flux lane's; without it every receipt stays pending
   *  verification (never applied on an operator's word). Read only while Flux is on (through b4RouterClient, the one gate). */
  verifyAdjustment?(input: { grantId: string; adjustmentRef: string; appliedMicrocents: number }): Promise<{ appliedMicrocents: number } | null>;
}

function httpsBase(value: string | undefined, fallback: string): string {
  const url = new URL(value?.trim() || fallback);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
    throw new HTTPError(503, "flux_misconfigured");
  }
  return url.origin;
}

/** R7 (b4-flux-ledger.ts): the definitive evidence of a delivery: HTTP 200 and a JSON body naming this grant id, this amount and an
 *  applied status. Exported for its test. */
export function deliveryConfirmed(r: { status: number; body: Record<string, unknown>; empty: boolean }, input: Pick<FluxGrant, "grantId" | "amountMicrocents">): boolean {
  return r.status === 200 && !r.empty && r.body.grant_id === input.grantId && r.body.amount_microcents === input.amountMicrocents
    && (r.body.status === "applied" || r.body.status === "already_applied");
}

export function createFluxClient(env: Env, fetcher: typeof fetch = fetch): FluxClient {
  const token = env.FLUX_CLOUD_SERVICE_TOKEN?.trim();
  if (!token || token.length < 32) {
    // Not configured: every call fails closed rather than going out unauthenticated.
    const refuse = async (): Promise<never> => { throw new HTTPError(503, "flux_not_configured"); };
    return { mint: refuse, stop: refuse, revokeKey: refuse, setCap: refuse, status: refuse, grant: refuse, revokeGrant: refuse };
  }
  const api = httpsBase(env.FLUX_API_BASE, "https://api.fluxrouter.ai");
  async function call(base: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    return (await callRaw(base, method, path, body)).body;
  }
  async function callRaw(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; empty: boolean }> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(FLUX_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new FluxError(0, "unreachable");
    }
    const text = await response.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = text ? JSON.parse(text) : {};
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch { /* a non-JSON body is treated as empty */ }
    if (!response.ok) {
      const error = parsed.error as { message?: unknown; code?: unknown } | undefined;
      const topCode = typeof parsed.code === "string" ? parsed.code : "";
      throw new FluxError(
        response.status,
        typeof error?.message === "string" ? error.message.slice(0, 200) : "",
        typeof error?.code === "string" ? error.code.slice(0, 64) : topCode.slice(0, 64),
      );
    }
    return { status: response.status, body: parsed, empty: text.trim() === "" };
  }
  return {
    async mint(input) {
      // A link identity the router would refuse is never sent: link_id 1..128 characters, link_version an integer of at least 1.
      if (input.linkId.length < 1 || input.linkId.length > 128 || !Number.isInteger(input.linkVersion) || input.linkVersion < 1) throw new FluxError(400, "invalid_link", "invalid_link");
      const result = await call(api, "POST", "/internal/cloud-home/subkeys", {
        account_id: input.accountId,
        home_id: input.homeId,
        generation: input.generation,
        bound_ips: input.boundIps,
        cap_microcents: Math.max(input.capMicrocents, ROUTER_MIN_CAP_MICROCENTS),
        ttl_seconds: input.ttlSeconds,
        lifecycle_version: input.lifecycleVersion,
        link_id: input.linkId,
        link_version: input.linkVersion,
        cap_version: input.capVersion,
        billing_state: input.billingState,
        // billing_customer_id stays local bookkeeping: the mint body never carries it.
        owner_resume: input.ownerResume,
        op_id: input.opId,
      });
      const minted = z.object({
        key: z.string().min(20).max(512),
        expires_at: z.string(),
        generation: z.number().int(),
        cap_microcents: z.number().int(),
      }).safeParse(result);
      if (!minted.success) throw new FluxError(502, "bad_mint_response");
      return { key: minted.data.key, expiresAt: minted.data.expires_at, generation: minted.data.generation, capMicrocents: minted.data.cap_microcents };
    },
    async stop(homeId, lifecycleVersion, options = {}) {
      await call(api, "POST", "/internal/cloud-home/subkeys/revoke", {
        home_id: homeId,
        lifecycle_version: lifecycleVersion,
        scope: "home",
        ...(options.linkVersion === undefined ? {} : { link_version: options.linkVersion }),
        reason: options.reason ?? "stop",
      });
    },
    async revokeKey(homeId, generation, lifecycleVersion, reason) {
      await call(api, "POST", "/internal/cloud-home/subkeys/revoke", {
        home_id: homeId, lifecycle_version: lifecycleVersion, scope: "key", generation, reason,
      });
    },
    async setCap(homeId, capMicrocents, capVersion) {
      await call(api, "POST", "/internal/cloud-home/cap", { home_id: homeId, cap_microcents: Math.max(capMicrocents, ROUTER_MIN_CAP_MICROCENTS), cap_version: capVersion });
    },
    async status(homeId) {
      const r = await call(api, "GET", `/internal/cloud-home/homes/${encodeURIComponent(homeId)}/status`);
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      return {
        state: typeof r.state === "string" ? r.state : "none",
        generation: num(r.generation),
        capMicrocents: num(r.cap_microcents),
        spentMicrocents: num(r.spent_microcents),
        resetsAt: typeof r.resets_at === "string" ? r.resets_at : undefined,
        expiresAt: typeof r.expires_at === "string" ? r.expires_at : undefined,
        accountSpendableMicrocents: typeof r.account_spendable_microcents === "number" ? r.account_spendable_microcents : null,
        accountAutoTopUpEnabled: typeof r.account_auto_topup_enabled === "boolean" ? r.account_auto_topup_enabled : null,
      };
    },
    async grant(input) {
      // Lane H1 (coordinator's binding update): grants go to the ROUTER's grant route (flux-grants.ts, FLUX_CLOUD_GRANTS_URL, Bearer
      // FLUX_CLOUD_GRANTS_TOKEN), never to the Flux app route (/api/internal/cloud/credit-grants does not exist). The frozen body shape is
      // the router's; the request carries the grant's fenced revision (R11) as a top-level field. R7: only a 200 granted/already_granted
      // (for this amount, when it says one) confirms; not_applied_reversed is R5 (tombstoned); anything else is classified by status.
      if (!grantsReady(env)) throw new FluxError(503, "grants_not_configured", "grants_not_configured");
      if (!input.invoiceId) throw new FluxError(400, "grant_invoice_missing", "grant_invoice_missing");
      const kind = input.kind ?? "period";
      const grantId = `${input.invoiceId}:${kind}`;
      const periodEnd = Date.parse(input.periodEnd);
      const frozen = JSON.stringify({ grant_id: grantId, invoice_id: input.invoiceId, kind, home_id: input.homeId, account_id: input.recipientFluxAccountId,
        plan: input.plan, amount_microcents: input.amountMicrocents, period_start: isoUtc(Date.parse(input.periodStart)), period_end: isoUtc(periodEnd),
        expires_at: isoUtc(addOneMonthUtc(periodEnd)) });
      const ans = await routed(() => fencedMutation(env, (u, i) => fetcher(u, i), { grantId, homeId: input.homeId, op: "grant", path: GRANT_PATH, frozen,
        ownerKind: "b4_deliver", ...(input.onRevision ? { onRevision: (w: number) => input.onRevision!(grantId, w) } : {}),
        ...(input.dispatchToken ? { guard: dispatchLive(input.dispatchToken) } : {}),
        settled: (r) => r.state === "not_found" ? null : r.state === "tombstoned" || r.state === "reversed" ? { status: "not_applied_reversed" }
          : { status: "already_granted", amount_microcents: input.amountMicrocents } }));
      const status = ans.json.status;
      if (ans.http === 200 && (status === "granted" || status === "already_granted")
        && (ans.json.amount_microcents === undefined || ans.json.amount_microcents === input.amountMicrocents)) return;
      if (ans.http === 200 && status === "not_applied_reversed") throw new FluxError(409, "not_applied_reversed", "revoked"); // R5
      // R7: any other 2xx is never evidence of a delivery (ambiguous, 502 unconfirmed_delivery); other statuses are classified as they are.
      if (ans.http >= 200 && ans.http < 300) throw new FluxError(502, "unconfirmed_delivery", "unconfirmed_delivery");
      throw routerError(ans.http, ans.json, "unconfirmed_delivery");
    },
    async revokeGrant(grantId, reason, ctx) {
      // Lane H1: the router's /reverse (never the app route), with the grant's fenced revision. R2/R7: only a 200 reversed / already_reversed
      // (revoked) or no_grant (tombstoned) is definitive.
      if (!grantsReady(env)) throw new FluxError(503, "grants_not_configured", "grants_not_configured");
      if (!ctx?.invoiceId) throw new FluxError(400, "revoke_context_missing", "revoke_context_missing");
      const wire = `${ctx.invoiceId}:${ctx.kind}`;
      const frozen = JSON.stringify({ grant_id: wire, invoice_id: ctx.invoiceId, kind: ctx.kind, home_id: ctx.homeId, reason: reason.slice(0, 500) });
      const ans = await routed(() => fencedMutation(env, (u, i) => fetcher(u, i), { grantId: wire, homeId: ctx.homeId, op: "reverse", path: `${GRANT_PATH}/reverse`,
        frozen, ownerKind: "b4_revoke", ...(ctx.onRevision ? { onRevision: (w: number) => ctx.onRevision!(wire, w) } : {}),
        ...(ctx.dispatchToken ? { guard: dispatchLive(ctx.dispatchToken) } : {}),
        settled: (r) => r.state === "reversed" ? { status: "already_reversed" } : r.state === "tombstoned" ? { status: "no_grant" } : null }));
      const status = ans.json.status;
      if (ans.http === 200 && (status === "reversed" || status === "already_reversed")) return "revoked";
      if (ans.http === 200 && status === "no_grant") return "tombstoned";
      void grantId;
      if (ans.http >= 200 && ans.http < 300) throw new FluxError(502, "bad_revoke_response");
      throw routerError(ans.http, ans.json, "bad_revoke_response");
    },
    async grantState(wireGrantId) {
      if (!grantsReady(env)) return null;
      return readGrantState(env, (u, i) => fetcher(u, i), wireGrantId);
    },
    async ensureAccount(input) {
      // Throws the grants client's own classes (FluxEnsureRefused 4xx, FluxHookRetry otherwise): ensureOwnerAccount classifies them.
      return ensureFluxAccount(env, (u, i) => fetcher(u, i), input);
    },
  };
}
/** Lane H1: a fenced router call's failure as the ledger classifies it: the fence's own answers (stale, mismatch, nothing dispatched) pass
 *  through; a network failure is unreachable (ambiguous). */
async function routed<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (e) {
    if (e instanceof FluxHookRetry || e instanceof FluxError) throw e;
    throw new FluxError(0, "unreachable");
  }
}
function routerError(status: number, body: Record<string, unknown>, fallback: string): FluxError {
  const e = (body.error ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : typeof body.code === "string" ? body.code : typeof body.status === "string" ? body.status : fallback;
  return new FluxError(status, typeof e.message === "string" ? e.message.slice(0, 200) : fallback, code.slice(0, 64));
}

export class FluxCapabilityPending extends FluxError {
  constructor() { super(503, "pending_capability", "flux_pending_capability"); }
}
export const FLUX_PENDING_CAPABILITY_ALERT = "flux.pending_capability";
/** One deduplicated ops alert per home: B4 work for it is retained, waiting for the router capability. */
export async function fluxPendingCapabilityAlert(env: Env, homeId: string, now: number, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET resolved_at=NULL WHERE cloud_alerts.resolved_at IS NOT NULL`)
      .bind(`alert:flux_pending_capability:${homeId}`, homeId, FLUX_PENDING_CAPABILITY_ALERT, "high", JSON.stringify({ reason: "pending_capability", ...detail }), now).run();
  } catch { /* the alert is advisory: the work itself stays journaled */ }
}
/** THE launch gate for B4, the same semantics as billing's fluxDispatchEnabled: the Flux switch (the Flux route switch) AND real
 *  (non-stub) billing hooks AND the advertised router capability. */
export function b4DispatchEnabled(env: Env, deps: Pick<FluxDependencies, "billingFlux"> = {}): boolean {
  return fluxRoutesEnabled(env) && fluxDispatchEnabled(deps.billingFlux ?? stubFluxHooks);
}
/** THE FLUX-OFF GATE (Astra INTEGRATED-10). Flux is ON only when the switch is exactly "1" (the Flux route switch), the service token
 *  and an explicit https API base are configured (fluxSweepConfigured) AND the billing hooks are real and advertise the qualified router
 *  capability (b4DispatchEnabled). At launch it is OFF for every caller (the switch is unset on staging and production). OFF means:
 *  - no router call is ever made (grant, revoke, or anything else): no dispatch row is ever opened (sendGrant / sendRevoke return first);
 *  - the sweep only keeps the ledger's ACCOUNTING (accounts, causes, desired, debt, its alerts), bounded by the cursor;
 *  - INTEGRATED-11 (ledger R9): the B4 operator endpoints (/claim, /applied) make no router call: they WORK while off, so an existing
 *    obligation (a migrated revoke or delivery included) can be claimed and its receipt recorded with evidence of what was done by hand in
 *    the Flux admin. INTEGRATED-12 (R8c): while off that receipt stays PENDING VERIFICATION (no stored balance moves, the alert stays). The B5
 *    dispute-credit /claim and /applied still answer 503 {error:"flux_off"} without reading or writing anything (one writer per grant while
 *    off: the B4 ledger). */
export function fluxOn(env: Env, deps: Pick<FluxDependencies, "billingFlux"> = {}): boolean {
  return fluxReadiness(env).issue && b4DispatchEnabled(env, deps); // PRODFLUX r3 (1'): every issuance reads readiness.issue
}
/** PRODFLUX (MurageMain): a Stop never depends on a token it does not use. Flux is not on (fluxOn) only because FLUX_CLOUD_GRANTS_TOKEN is
 *  missing: the switch is on, the real billing hooks are selected (never the stub), FLUX_CLOUD_SERVICE_TOKEN and an explicit https API base
 *  are set (fluxRevokeOnlyConfigured). Then the key REVOCATIONS go out (createFluxClient's stop and revokeKey send the service token only):
 *  a home Stop (owner, billing or cancellation), an unlink's Stops and a mint's compensation (a crashed mint included). Nothing that issues is
 *  sent (mint, cap push, status, grant, grant revoke, ensure-account) and every activation route stays as Flux off. With the service token
 *  missing too, nothing at all is sent: the revocations stay journaled and go out once it is back. */
export function fluxRevokeOnly(env: Env, deps: Pick<FluxDependencies, "billingFlux"> = {}): boolean {
  // PRODFLUX r3 (1'): a revocation is SENT on readiness.revoke; this is the part of it where issuing is not ready.
  const ready = fluxReadiness(env);
  return !fluxOn(env, deps) && ready.revoke && !ready.issue && fluxSwitchedOnLive(env, deps);
}
/** PRODFLUX r4 C: switched on ("1") with the REAL billing hooks selected (never the stub), whatever the secrets. Then a Stop (owner, billing,
 *  cap OFF) is always journaled and always needs the owner's step-up; it is sent when readiness.revoke allows, else once it does. */
export function fluxSwitchedOnLive(env: Env, deps: Pick<FluxDependencies, "billingFlux"> = {}): boolean {
  return fluxRoutesEnabled(env) && (deps.billingFlux ?? stubFluxHooks).stub !== true;
}
/** The clients b4RouterClient built for fluxRevokeOnly: runOps drains only their revocations (a held cap push never stands in front of one). */
const REVOKE_ONLY_CLIENTS = new WeakSet<FluxClient>();
/** The op kinds a revoke-only drain runs: Stops, compensations, and a crashed caller's mint (turned into the compensation of its generation,
 *  no router call). */
const REVOCATION_KINDS = "kind IN ('stop','compensate','mint')";
/** Astra INTEGRATED-1 #7: THE shared B4 dispatch boundary. Every B4 route, hook and cron path gets its router client HERE and nowhere else
 *  (a source-scan test holds that). Gate closed: a client that sends NOTHING, raises the pending-capability alert for the home and throws
 *  FluxCapabilityPending, so every caller's journal (ops, grants, reversals) stays pending exactly as it was. */
export function b4RouterClient(env: Env, deps: Pick<FluxDependencies, "fluxClient" | "billingFlux" | "now"> = {}, options: { stoppedStatus?: boolean } = {}): FluxClient {
  if (fluxOn(env, deps)) return (deps.fluxClient ?? createFluxClient)(env); // THE FLUX-OFF GATE: one predicate for every router call
  // PRODFLUX (MurageMain): only the grants token missing: the revocations (service token only) go out, everything else is held below.
  const revoker = fluxRevokeOnly(env, deps) ? (deps.fluxClient ?? createFluxClient)(env) : null;
  const now = () => (deps.now ?? Date.now)();
  const held = async (homeId: string | null, call: string): Promise<never> => {
    if (homeId) await fluxPendingCapabilityAlert(env, homeId, now(), { call });
    throw new FluxCapabilityPending();
  };
  const client: FluxClient = {
    mint: (input) => held(input.homeId, "mint"),
    stop: revoker ? (homeId, lifecycleVersion, options) => revoker.stop(homeId, lifecycleVersion, options) : (homeId) => held(homeId, "stop"),
    revokeKey: revoker ? (homeId, generation, lifecycleVersion, reason) => revoker.revokeKey(homeId, generation, lifecycleVersion, reason)
      : (homeId) => held(homeId, "revokeKey"),
    setCap: (homeId) => held(homeId, "setCap"),
    // 8b fix r1 (Astra H2): `stoppedStatus` (sweepStoppedLive only) lets the revoke-only client make the ONE read the stopped-live repair needs: the
    // status of a home whose row is stopped at the moment of the call, sent with the service token like a Stop. Any other status read stays held.
    status: revoker && options.stoppedStatus === true ? async (homeId) => {
      const row = await env.DB.prepare("SELECT state FROM flux_home_keys WHERE home_id=?").bind(homeId).first<{ state: string }>();
      return row?.state === "stopped" ? revoker.status(homeId) : held(homeId, "status");
    } : (homeId) => held(homeId, "status"),
    grant: (input) => held(input.homeId, "grant"),
    revokeGrant: async (grantId) => held((await env.DB.prepare("SELECT home_id FROM flux_grants WHERE grant_id=?").bind(grantId)
      .first<{ home_id: string }>().catch(() => null))?.home_id ?? null, "revokeGrant"),
  };
  if (revoker) REVOKE_ONLY_CLIENTS.add(client);
  return client;
}

export interface FluxDependencies {
  currentAccount?: (request: Request, auth: ControlPlaneAuth) => Promise<{ id: string } | null>;
  ownerOf?: (env: Env, homeId: string) => Promise<string | null>;
  fluxClient?: (env: Env) => FluxClient;
  /** The billing hooks this worker runs with (index.ts: billing's deps.flux, else stubFluxHooks). The B4 dispatch gate (b4RouterClient)
   *  sends to the router only when they are real and advertise the qualified capability (billing's fluxDispatchEnabled). Absent: the stub. */
  billingFlux?: FluxEntitlementHooks;
  now?: () => number;
  /** The fresh trusted second factor for this request (index.ts passes the worker's check). A raise of the monthly spend limit needs it;
   *  absent, nothing is stepped up (only a change that cannot raise spending goes through). */
  stepUp?: (request: Request) => Promise<boolean>;
  /** Support's email-proof resend (flux-email-proof.ts): the mail sender. Default: the Worker's transactional sender. */
  emailSender?: (env: Env) => TransactionalEmailSender;
}

// ── Small helpers ────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function adminOnly(request: Request, env: Env) {
  if (!env.CLOUD_ADMIN_TOKEN) throw new HTTPError(401, "unauthorized");
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const [a, b] = await Promise.all([sha256(token), sha256(env.CLOUD_ADMIN_TOKEN)]);
  if (!timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b))) throw new HTTPError(401, "unauthorized");
}

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

/** Stage A: the limit Flux enforces, never below the router's $5 floor. Spending switched off (spending_off=1) is a home-scope revoke at the router (no cap is sent); the
 *  stored cap_microcents keeps the owner's last limit (the table requires it positive) for the status page only. */
/** The router refuses a cap below $5 (400) on mint and /cap: no call ever sends less. */
const ROUTER_MIN_CAP_MICROCENTS = 5_000_000;
const EFFECTIVE_CAP = "MAX(cap_microcents, 5000000)"; // Stage A: the router refuses a cap below $5; "off" is a home-scope revoke, never cap 0

interface HomeRow {
  home_id: string; plan: string; generation: number; state: string;
  cap_microcents: number; cap_custom: number; spending_off: number; spending_off_at: number | null; billing_hold: number; billing_hold_at: number | null;
  lifecycle_version: number; key_expires_at: number | null; updated_at: number;
  cap_version: number; gen_floor: number; stop_version: number | null; stop_link_version: number | null;
  link_id: string | null; link_version: number | null; billing_customer_id: string | null;
  op_holder: string | null; op_lease_until: number | null;
  /** 8b (migration 0150): see SPENDING-RESUME-VIA-POLLER 2.1. */
  pending_lifecycle_version: number | null; acked_lifecycle_version: number | null; acked_generation: number | null;
  resume_lv: number | null; resume_from_generation: number | null; resume_at: number | null; stop_checked_at: number | null;
}

async function ensureHomeRow(env: Env, config: FluxConfig, homeId: string, now: number): Promise<HomeRow> {
  // DISPUTE-FENCE-ACCOUNT: a row created while the owner's account has an open dispute starts held (proof_hold), decided in the INSERT itself.
  await env.DB.prepare(`INSERT OR IGNORE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at,proof_hold)
    SELECT ?1,?2,0,'none',?3,0,?4,CASE WHEN ${homeDisputeOpenSql("?1")} THEN 1 ELSE 0 END`)
    .bind(homeId, config.defaultPlan, usdToMicrocents(defaultCapUsd(config, config.defaultPlan)), now).run();
  const row = await env.DB.prepare("SELECT * FROM flux_home_keys WHERE home_id=?").bind(homeId).first<HomeRow>();
  if (!row) throw new HTTPError(500, "internal_error");
  return row;
}

/** Turn a Flux failure into the control plane's own stable error. */
function fluxFailure(error: unknown): HTTPError {
  if (error instanceof HTTPError) return error;
  if (error instanceof FluxError) {
    if (error.status === 409) {
      const reason = [error.code, error.detail].find((v) => v === "stale_lifecycle" || v === "home_stopped" || v === "stale_cap" || v === "stale_link");
      return new HTTPError(409, reason ?? "flux_conflict");
    }
    if (error.status === 403 && (error.code === "billing_hold" || error.detail === "billing_hold")) return new HTTPError(409, "billing_hold");
    if (error.status === 503 && (error.code === "billing_identity_unavailable" || error.detail === "billing_identity_unavailable")) {
      return new HTTPError(503, "billing_identity_unavailable"); // retryable: Flux could not read the billing identity
    }
    if (error.status === 404) return new HTTPError(409, "flux_not_ready");
    return new HTTPError(502, "flux_unavailable");
  }
  return new HTTPError(502, "flux_unavailable");
}

// ── Link ─────────────────────────────────────────────────────────────────────

const completeSchema = z.strictObject({
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  proof: z.string().min(20).max(2048),
});
const proofPayload = z.object({
  v: z.literal(1),
  aud: z.literal(LINK_AUDIENCE),
  flux_account_id: z.string().regex(/^[0-9a-fA-F-]{36}$/),
  state: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8).max(64),
});

/** Stage A: the browser redirect link flow is retired. An owner's link is made by ensureOwnerLinked (link_id = the Flux account id, version 1).
 *  Nothing builds an authorize URL, so /v1/flux/link/start answers 404 and writes no challenge. linkComplete, verifyProof, the challenge
 *  table and the FLUX_LINK_PUBLIC_KEY path are dead while this is false. */
const LINK_REDIRECT_ENABLED = false;
/** Tests only (design-pc2 "Second writer"): flips the retired flow on, to prove its INSERT keeps the email fence. Nothing in src/ sets it. */
export const linkRedirectForTests = { enabled: LINK_REDIRECT_ENABLED };

async function linkStart(env: Env, config: FluxConfig, ownerId: string, now: number): Promise<Response> {
  if (!linkRedirectForTests.enabled) throw new HTTPError(404, "not_found");
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM flux_link_challenges WHERE expires_at<?").bind(now),
    env.DB.prepare("INSERT INTO flux_link_challenges (state_hash,owner_user_id,expires_at) VALUES (?,?,?)")
      .bind(await sha256(state), ownerId, now + config.linkChallengeMinutes * 60_000),
  ]);
  const authorize = new URL(env.FLUX_AUTHORIZE_URL?.trim() || "https://fluxrouter.ai/cloud/link");
  if (authorize.protocol !== "https:" || authorize.username || authorize.password) throw new HTTPError(503, "flux_misconfigured");
  authorize.search = "";
  authorize.hash = "";
  authorize.searchParams.set("state", state);
  return json({ state, authorizeUrl: authorize.toString(), expiresInSeconds: config.linkChallengeMinutes * 60 });
}

async function verifyProof(env: Env, proof: string, state: string, now: number) {
  const key = env.FLUX_LINK_PUBLIC_KEY?.trim();
  if (!key) throw new HTTPError(503, "flux_not_configured");
  const [encoded, signature, extra] = proof.split(".");
  if (!encoded || !signature || extra !== undefined) throw new HTTPError(400, "invalid_proof");
  let ok = false;
  try {
    const publicKey = await crypto.subtle.importKey("raw", unb64url(key), { name: "Ed25519" }, false, ["verify"]);
    ok = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, unb64url(signature), new TextEncoder().encode(encoded));
  } catch { ok = false; }
  if (!ok) throw new HTTPError(400, "invalid_proof");
  let payload: z.infer<typeof proofPayload>;
  try {
    payload = proofPayload.parse(JSON.parse(new TextDecoder().decode(unb64url(encoded))));
  } catch { throw new HTTPError(400, "invalid_proof"); }
  const nowS = Math.floor(now / 1000);
  if (payload.state !== state || payload.exp <= nowS || payload.iat > nowS + 60 || nowS - payload.iat > PROOF_MAX_AGE_S) {
    throw new HTTPError(400, "invalid_proof");
  }
  return payload;
}

async function linkComplete(request: Request, env: Env, ownerId: string, now: number): Promise<Response> {
  // ITEM4-PROOF-CURRENT: retired with /start, on the same constant, before any read.
  if (!linkRedirectForTests.enabled) throw new HTTPError(404, "not_found");
  const input = await body(request, completeSchema);
  const stateHash = await sha256(input.state);
  const payload = await verifyProof(env, input.proof, input.state, now);
  const account = payload.flux_account_id.toLowerCase();
  const existing = await linkRowOf(env, ownerId);
  if (existing !== null && existing.flux_account_id.toLowerCase() !== account) throw new HTTPError(409, "already_linked");
  if (existing !== null && existing.fenced === 1) throw new HTTPError(409, "unlink_in_progress");
  // An emailed step-up approval was frozen at one link revision (absence included): the link is created only while the owner's revision
  // is STILL that one, checked inside the inserting statement itself (Astra STEPUP-EMAIL-4 #2: an unlink that completes between the claim
  // and this write must not turn the approval into a relink).
  const pinned = pinnedLinkRevision(env);
  // ONE transaction (Astra STEPUP-EMAIL-5 #4): the single-use challenge of the signed-in owner, the proof's jti, and the link itself
  // (revision-checked) all happen, or none does. A step-up operation commits in that same transaction, only with the link: consuming the
  // challenge alone is never its completed effect. Guard rows (CHECK ok=1) roll the whole batch back when a step did not happen.
  const g = `flux-link-${crypto.randomUUID()}`;
  const linkId = crypto.randomUUID().replaceAll("-", "");
  const revision = pinned === undefined ? "" : ` AND ${linkRevisionSql("?")} IS ?`;
  const revisionBinds = pinned === undefined ? [] : [ownerId, ownerId, ownerId, ownerId, pinned];
  // The link that must exist afterwards: the owner's live link to this account; under a step-up approval, the one just inserted or one
  // that was already there at the approved revision (nothing moved).
  const linked = `SELECT COUNT(*) FROM flux_links WHERE owner_user_id=? AND lower(flux_account_id)=? AND fenced=0${pinned === undefined ? "" : ` AND (link_id=? OR ${linkRevisionSql("?")} IS ?)`}`;
  const commit = commitStatement(env, "flux_link");
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE flux_link_challenges SET used_at=? WHERE state_hash=? AND owner_user_id=? AND used_at IS NULL AND expires_at>?")
        .bind(now, stateHash, ownerId, now),
      env.DB.prepare("INSERT OR IGNORE INTO flux_link_proofs (jti,used_at) SELECT ?,? WHERE changes()=1").bind(payload.jti, now),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?, changes())").bind(`${g}-proof`),
      // A new link has a new identity and a version above every version this owner ever had. (P-link): the same fence as ensureOwnerLinked
      // (flux-link.ts linkFenceSql), on the identity's CURRENT address and revision, read in this statement: a TRUE stamp, no dispute, no link.
      env.DB.prepare(`INSERT OR IGNORE INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced)
        SELECT ?,?,?,?,COALESCE((SELECT version FROM flux_link_floor WHERE owner_user_id=?),0)+1,0
        WHERE ${linkFenceSql("?", "lower(trim(s.contact_email))", "s.email_revision")}${revision}`)
        .bind(ownerId, account, now, linkId, ownerId, ownerId, ownerId, ownerId, ...revisionBinds),
      env.DB.prepare(`INSERT INTO cloud_write_guards VALUES (?, (${linked}))`).bind(`${g}-link`, ownerId, account, ...(pinned === undefined ? [] : [linkId, ...revisionBinds])),
      ...(commit ? [commit] : []),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id IN (?,?)").bind(`${g}-proof`, `${g}-link`),
    ]);
  } catch (error) {
    // Nothing happened. Why, in the order the steps run: the challenge or the proof was not usable; the approval's revision moved; or
    // the Flux account is linked to somebody else. Anything else (D1 unavailable) is not a refusal: it is rethrown, and a step-up
    // operation stays resumable, uncommitted.
    const challenge = await env.DB.prepare("SELECT 1 AS x FROM flux_link_challenges WHERE state_hash=? AND owner_user_id=? AND used_at IS NULL AND expires_at>?")
      .bind(stateHash, ownerId, now).first();
    const jti = await env.DB.prepare("SELECT 1 AS x FROM flux_link_proofs WHERE jti=?").bind(payload.jti).first();
    if (!challenge || jti) throw new HTTPError(400, "invalid_proof");
    if (pinned !== undefined) {
      const now2 = await env.DB.prepare(`SELECT ${linkRevisionSql("?")} AS r`).bind(ownerId, ownerId, ownerId, ownerId).first<{ r: number }>();
      if (now2?.r !== pinned) throw new HTTPError(403, "step_up_required");
    }
    const taken = await env.DB.prepare("SELECT 1 AS x FROM flux_links WHERE lower(flux_account_id)=? AND owner_user_id<>?").bind(account, ownerId).first();
    if (taken) throw new HTTPError(409, "flux_account_in_use");
    // The email fence refused it: the owner's address is not proven now, or a dispute is open.
    const fenced = await env.DB.prepare(`SELECT 1 AS x WHERE ${linkFenceSql("?", "lower(trim(s.contact_email))", "s.email_revision")}`)
      .bind(ownerId, ownerId, ownerId).first();
    if (!fenced) throw new HTTPError(409, "flux_email_unverified");
    throw error;
  }
  return json({ linked: true, fluxAccountHint: payload.flux_account_id.slice(-4) });
}

async function linkStatus(env: Env, ownerId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT flux_account_id,linked_at FROM flux_links WHERE owner_user_id=?")
    .bind(ownerId).first<{ flux_account_id: string; linked_at: number }>();
  return json(row ? { linked: true, linkedAt: row.linked_at, fluxAccountHint: row.flux_account_id.slice(-4) } : { linked: false });
}

async function homesOf(env: Env, ownerId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT id FROM cloud_homes WHERE owner_id=? AND desired_state<>'deleted'")
    .bind(ownerId).all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

// ── Per-home operation journal and lease (the ONE serializer) ────────────────
//
// Every lifecycle request (Stop, billing stop, unlink, cap change, mint, key compensation) writes
// an intent row in flux_home_ops in the SAME D1 batch as its durable state change, before any
// network call. Router calls for a home run only while holding the home's lease
// (flux_home_keys.op_holder / op_lease_until), one op at a time, in seq order, each op idempotent
// and its state persisted after its network step. A worker that cannot get the lease returns:
// the holder re-checks the queue after releasing, and the cron sweep finishes anything left.
// D1 plus a lease is used instead of a Durable Object: the control plane has no DO binding and its
// tests run D1 as in-memory SQLite.

const LEASE_MS = 2 * 60_000;
/** Current time. Lease decisions always read it afresh (round 4: renewing with the request's original
 *  timestamp let a caller whose lease had expired keep acting as the holder). */
type Clock = () => number;
type RunResult = "clean" | "failed" | "lost";
type OpKind = "mint" | "stop" | "cap" | "compensate";
type OpPayload = {
  version?: number; linkVersion?: number | null; linkId?: string | null; ownerId?: string | null; reason?: string;
  generation?: number; lifecycleVersion?: number;
  /** A compensation of an owner key committed but never delivered (its step-up operation, by id): revoke exactly that generation even
   *  though it is the committed one. */
  undelivered?: string;
};
interface OpRow { op_id: string; seq: number; kind: OpKind; payload: string; attempts: number }

/** An INSERT of one journal row. `payload` is a JSON value, or SQL that yields the JSON text
 *  (so a Stop can carry the lifecycle version the SAME batch just wrote). `where` makes the row
 *  exist only if the condition holds when the statement runs inside its batch. */
function opStmt(
  env: Env, homeId: string, kind: OpKind, now: number,
  payload: { json: OpPayload } | { sql: string; binds: unknown[] },
  options: { opId?: string; state?: "queued" | "running"; where?: { sql: string; binds: unknown[] } } = {},
): { stmt: D1PreparedStatement; opId: string } {
  const opId = options.opId ?? crypto.randomUUID();
  const sql = "json" in payload ? "?" : payload.sql;
  const binds = "json" in payload ? [JSON.stringify(payload.json)] : payload.binds;
  const stmt = env.DB.prepare(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
    SELECT ?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),?,${sql},?,?,? ${options.where ? `WHERE ${options.where.sql}` : ""}`)
    .bind(opId, homeId, kind, ...binds, options.state ?? "queued", now, now, ...(options.where?.binds ?? []));
  return { stmt, opId };
}

/** A Stop intent. Its version is whatever lifecycle_version the batch has just written. An unlink
 *  Stop also carries the (just fenced) link's version and identity. */
function stopOpStmt(env: Env, homeId: string, now: number, reason: string, unlink?: { ownerId: string; linkId: string | null },
  where?: { sql: string; binds: unknown[] }) {
  return opStmt(env, homeId, "stop", now, {
    sql: `(SELECT json_object('version', h.lifecycle_version,
        'linkVersion', (SELECT link_version FROM flux_links WHERE owner_user_id = ?),
        'linkId', ?, 'ownerId', ?, 'reason', ?) FROM flux_home_keys h WHERE h.home_id = ?)`,
    binds: [unlink?.ownerId ?? null, unlink?.linkId ?? null, unlink?.ownerId ?? null, reason, homeId],
  }, where ? { where } : {});
}

const STOPPING = "state=CASE WHEN state='stopped' THEN state ELSE 'stopping' END,lifecycle_version=lifecycle_version+1";

async function acquireLease(env: Env, homeId: string, holder: string, now: number): Promise<boolean> {
  // Re-entrant for the same holder: a claimed step-up operation already holds the lease its claim took (step-up-op.ts).
  const r = await env.DB.prepare(`UPDATE flux_home_keys SET op_holder=?,op_lease_until=?
    WHERE home_id=? AND (op_holder IS NULL OR op_lease_until<? OR op_holder=?)`).bind(holder, now + LEASE_MS, homeId, now, holder).run();
  return r.meta.changes === 1;
}
/** The holder a request acts as on this home: the step-up claim's (held since the claim, released by its finalization), else a fresh one. */
const holderFor = (env: Env, homeId: string) => {
  const held = heldFluxHolder(env, homeId);
  return held ? { holder: held, release: false } : { holder: crypto.randomUUID(), release: true };
};
/** For the step-up claim (step-up-email.ts): the home's key row (as ensureHomeRow makes it) and its lease, taken by `holder` in the SAME
 *  batch that consumes the approval, applied only when `cond` (the claim took) holds. The lease is free, or held by `previous` (a
 *  superseded runner of the same operation, past its execution lease). */
export function fluxClaimLeaseStatements(env: Env, homeId: string, holder: string, now: number, cond: { sql: string; binds: unknown[] }): D1PreparedStatement[] {
  const config = readFluxConfig(env);
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at,proof_hold)
      SELECT ?,?,0,'none',?,0,?,CASE WHEN ${homeDisputeOpenSql("?")} THEN 1 ELSE 0 END WHERE ${cond.sql}`)
      .bind(homeId, config.defaultPlan, usdToMicrocents(defaultCapUsd(config, config.defaultPlan)), now, homeId, ...cond.binds),
    env.DB.prepare(`UPDATE flux_home_keys SET op_holder=?,op_lease_until=? WHERE home_id=? AND ${cond.sql}`).bind(holder, now + LEASE_MS, homeId, ...cond.binds),
  ];
}
/** Is the home's Flux lease free (or held by `previous`)? SQL for the claiming statement. */
export const fluxLeaseFree = (homeId: string, now: number, previous: string | null) => ({
  sql: "NOT EXISTS (SELECT 1 FROM flux_home_keys k WHERE k.home_id=? AND k.op_holder IS NOT NULL AND k.op_lease_until>=? AND k.op_holder IS NOT ?)",
  binds: [homeId, now, previous] as unknown[] });
export const releaseFluxLeaseStatement = (env: Env, homeId: string, holder: string) =>
  env.DB.prepare("UPDATE flux_home_keys SET op_holder=NULL,op_lease_until=NULL WHERE home_id=? AND op_holder=?").bind(homeId, holder);
/** The sweep's compensation of an owner key committed but never delivered (its step-up operation `intentId`, now 'compensating'): a
 *  DISTINCT compensation (Astra STEPUP-EMAIL-4 #3) that revokes exactly that generation even when it is the home's committed one (an
 *  ordinary compensation never touches the committed generation). Applied only when `cond` holds (the sweep won that operation). */
export function undeliveredKeyCompensation(env: Env, homeId: string, generation: number, intentId: string, now: number, cond: { sql: string; binds: unknown[] }): D1PreparedStatement {
  return opStmt(env, homeId, "compensate", now, {
    sql: "(SELECT json_object('generation', ?, 'lifecycleVersion', lifecycle_version, 'undelivered', ?) FROM flux_home_keys WHERE home_id = ?)",
    binds: [generation, intentId, homeId],
  }, { opId: `undelivered:${intentId}`, where: cond }).stmt;
}
/** The owner's Flux link REVISION as SQL (`owner`: an SQL expression for the owner id): monotonic over the account's whole link history,
 *  absence included (Astra STEPUP-EMAIL-4 #2). From what link, unlink and relink already maintain: a link's version is above every version
 *  this owner ever had (flux_link_floor + 1), an unlink fences it one version up, its finalization moves that version into the floor and
 *  removes the row. Revision = 2 x (the live link's version, else the floor, else 0), plus 1 while absent after a link existed. So:
 *  never linked 0; linked v 2v; unlinking 2(v+1); unlinked 2(v+1)+1; relinked 2(v+2). Every transition moves it strictly up. */
export const linkRevisionSql = (owner: string) => `(2 * COALESCE((SELECT link_version FROM flux_links WHERE owner_user_id=${owner}),
    (SELECT version FROM flux_link_floor WHERE owner_user_id=${owner}), 0)
  + CASE WHEN NOT EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=${owner}) AND EXISTS (SELECT 1 FROM flux_link_floor WHERE owner_user_id=${owner})
    THEN 1 ELSE 0 END)`;
/** Extend the lease; false when it was lost (expired and taken over). */
async function renewLease(env: Env, homeId: string, holder: string, now: number): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE flux_home_keys SET op_lease_until=? WHERE home_id=? AND op_holder=?")
    .bind(now + LEASE_MS, homeId, holder).run();
  return r.meta.changes === 1;
}
async function releaseLease(env: Env, homeId: string, holder: string): Promise<void> {
  await env.DB.prepare("UPDATE flux_home_keys SET op_holder=NULL,op_lease_until=NULL WHERE home_id=? AND op_holder=?").bind(homeId, holder).run();
}
async function hasOpenOps(env: Env, homeId: string, revokeOnly = false): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 AS x FROM flux_home_ops WHERE home_id=? AND state IN ('queued','running')${revokeOnly ? ` AND ${REVOCATION_KINDS}` : ""} LIMIT 1`)
    .bind(homeId).first()) !== null;
}

/** The holder still owns an unexpired lease (SQL fragment + binds, for conditional writes). */
const HOLDS = "EXISTS (SELECT 1 FROM flux_home_keys WHERE home_id=? AND op_holder=? AND op_lease_until>=?)";

/** Run the home's queued ops while holding the lease: Stops first (a billing Stop before any other),
 *  then everything else in seq order. A Stop only ever closes the home, so running it ahead of a cap
 *  push or a key compensation is always safe, and a failing earlier op can never hold a Stop back.
 *  "clean" when the queue ended empty; "failed" when an op failed (it stays queued); "lost" when the
 *  lease was lost (expired or taken over): nothing more is done, and no completion is recorded. */
async function runOps(env: Env, flux: FluxClient, homeId: string, holder: string, clock: Clock): Promise<RunResult> {
  // PRODFLUX (MurageMain): a revoke-only client (fluxRevokeOnly) runs the revocations only; a held cap push stays queued for later.
  const revocationsOnly = REVOKE_ONLY_CLIENTS.has(flux) ? ` AND ${REVOCATION_KINDS}` : "";
  for (let guard = 0; guard < 200; guard++) {
    const op = await env.DB.prepare(`SELECT op_id,seq,kind,payload,attempts FROM flux_home_ops
      WHERE home_id=? AND state IN ('queued','running')${revocationsOnly}
      ORDER BY CASE WHEN kind='stop' AND json_extract(payload,'$.reason')='billing_stop' THEN 0 WHEN kind='stop' THEN 1 ELSE 2 END, seq
      LIMIT 1`).bind(homeId).first<OpRow>();
    if (!op) return "clean";
    if (!(await renewLease(env, homeId, holder, clock()))) return "lost";
    const payload = JSON.parse(op.payload) as OpPayload;
    let result: "done" | "superseded" | "again";
    try {
      result = await executeOp(env, flux, homeId, op, payload, clock(), holder);
    } catch (error) {
      if (error instanceof LeaseLost) return "lost";
      // PRODFLUX r3 (4'): a HELD client (a Flux secret missing, so nothing was sent) is not an attempt: attempts stays as it is (0 for a fresh
      // Stop, so the caller reads it as pending, not failed) and only the reason is written. It goes out once the client can send it.
      if (error instanceof FluxCapabilityPending) {
        await env.DB.prepare("UPDATE flux_home_ops SET last_error=? WHERE op_id=?").bind("flux_pending_capability", op.op_id).run();
        return "failed";
      }
      const code = error instanceof FluxError ? `flux_${error.status}` : "op_error";
      const at = clock();
      await env.DB.prepare("UPDATE flux_home_ops SET attempts=attempts+1,last_error=?,updated_at=? WHERE op_id=?").bind(code, at, op.op_id).run();
      await pageStoppedLiveRepair(env, homeId, op, payload, `failed:${code}`, at);
      return "failed";
    }
    if (result === "again") continue;
    if (result === "superseded") await pageStoppedLiveRepair(env, homeId, op, payload, "superseded", clock());
    const at = clock();
    if (op.kind === "stop" && payload.linkId && payload.ownerId) {
      // The last Stop of an unlink completes AND the link is finalized in one batch: a crash cannot
      // leave every Stop done with the link still fenced (the sweep also repairs such links).
      const finished = await env.DB.batch([
        env.DB.prepare(`UPDATE flux_home_ops SET state=?,last_error=NULL,updated_at=? WHERE op_id=? AND ${HOLDS}`)
          .bind(result, at, op.op_id, homeId, holder, at),
        ...finalizeUnlinkStmts(env, payload.ownerId, payload.linkId),
      ]);
      if (finished[0].meta.changes !== 1) return "lost";
      continue;
    }
    const marked = await env.DB.prepare(`UPDATE flux_home_ops SET state=?,last_error=NULL,updated_at=? WHERE op_id=? AND ${HOLDS}`)
      .bind(result, at, op.op_id, homeId, holder, at).run();
    if (marked.meta.changes !== 1) return "lost"; // a later holder re-runs it (every op is idempotent)
  }
  return "failed";
}

/** 8b fix r1 (Grok Low): a stopped_live_repair Stop that ends failed or superseded pages flux.stopped_key_live WHEREVER it is drained (the repair's
 *  own drain may have seen it pending, and the stopped-live selector skips a home while its Stop is open). One open incident per home: the insert
 *  conflicts on cloud_alerts_open while one is open. Advisory: a failed insert never changes the op's outcome. */
async function pageStoppedLiveRepair(env: Env, homeId: string, op: OpRow, payload: OpPayload, stop: string, at: number): Promise<void> {
  if (op.kind !== "stop" || payload.reason !== "stopped_live_repair") return;
  try {
    await alertStatement(env.DB, { homeId, kind: STOPPED_KEY_LIVE_ALERT, severity: "high", detail: JSON.stringify({ stop, opId: op.op_id }) }, at).run();
  } catch { /* the sweep re-sends the Stop; the next outcome pages again */ }
}

class LeaseLost extends Error {}

/** One op, idempotent. Throws when the router did not give a definitive answer. */
async function executeOp(
  env: Env, flux: FluxClient, homeId: string, op: OpRow, payload: OpPayload, now: number, holder: string,
): Promise<"done" | "superseded" | "again"> {
  if (op.kind === "mint") {
    // A mint op is run only by its caller, who marks it done before it drains. One found here belongs
    // to a caller that crashed or lost its lease: the key may exist, so it becomes a compensation of
    // that generation. Never completed.
    const turned = await env.DB.prepare(`UPDATE flux_home_ops SET kind='compensate',state='queued',updated_at=? WHERE op_id=? AND ${HOLDS}`)
      .bind(now, op.op_id, homeId, holder, now).run();
    if (turned.meta.changes !== 1) throw new LeaseLost();
    return "again";
  }
  if (op.kind === "stop") {
    try {
      await flux.stop(homeId, payload.version!, {
        ...(typeof payload.linkVersion === "number" ? { linkVersion: payload.linkVersion } : {}), reason: payload.reason ?? "stop",
      });
    } catch (error) {
      if (error instanceof FluxError && error.status === 409 && [error.code, error.detail].includes("stale_lifecycle")) return "superseded"; // a resume owns it
      throw error;
    }
    await env.DB.prepare("UPDATE flux_home_keys SET state='stopped',updated_at=? WHERE home_id=? AND state IN ('stopping','stopped') AND lifecycle_version=? AND op_holder=?")
      .bind(now, homeId, payload.version!, holder).run();
    return "done";
  }
  if (op.kind === "cap") {
    // ALWAYS push the database's current cap and cap version (never what the request carried), so a
    // cap changed while a mint was in flight is republished after it. Nothing exists at the router for
    // a home that never held a key; the mint carries the cap then.
    const row = await env.DB.prepare(`SELECT state,${EFFECTIVE_CAP} AS cap_microcents,cap_version,
        (resume_lv=lifecycle_version AND acked_lifecycle_version IS NOT lifecycle_version AND pending_lifecycle_version IS NOT lifecycle_version) AS resume_open
      FROM flux_home_keys WHERE home_id=?`)
      .bind(homeId).first<{ state: string; cap_microcents: number; cap_version: number; resume_open: number | null }>();
    const off = await env.DB.prepare("SELECT spending_off AS o FROM flux_home_keys WHERE home_id=?").bind(homeId).first<{ o: number }>();
    if (!row || row.state === "none" || row.state === "stopped" || row.state === "stopping" || off?.o === 1) return "done"; // a stopped home takes its cap from the next mint // an off home is revoked at home scope: no cap is sent for it
    if (row.resume_open === 1) return "done"; // 8b (2.4): a resumed home is still stopped at the router until the poller's mint, which carries the newest cap
    try {
      await flux.setCap(homeId, row.cap_microcents, row.cap_version);
    } catch (error) {
      if (!(error instanceof FluxError && error.status === 409 && [error.code, error.detail].includes("stale_cap"))) throw error; // stale = a newer version is there
    }
    await env.DB.prepare(`UPDATE flux_home_ops SET state='done',updated_at=? WHERE home_id=? AND kind='cap' AND state='queued' AND seq<? AND ${HOLDS}`)
      .bind(now, homeId, op.seq, homeId, holder, now).run(); // the push above covered every older cap change
    return "done";
  }
  if (payload.undelivered) {
    // An owner key committed but never delivered: revoke THAT generation, committed or not, as the current lease holder (runOps renewed
    // it just before this op). Only once the router confirmed the revocation, in ONE batch fenced by the lease: the key row stops being
    // active if it is still that generation, and the step-up operation is recorded 'compensated'. A failure leaves the op queued and the
    // operation 'compensating': the sweep retries it.
    await flux.revokeKey(homeId, payload.generation!, payload.lifecycleVersion!, "undelivered");
    const [held] = await env.DB.batch([
      // 8b (3): never on a generation a resume left behind (resume_from_generation), so a late compensation of a pre-deploy key never stops a resumed row.
      env.DB.prepare(`UPDATE flux_home_keys SET state=CASE WHEN generation=? AND state='active' AND generation IS NOT resume_from_generation THEN 'stopped' ELSE state END,
          key_expires_at=CASE WHEN generation=? AND state='active' AND generation IS NOT resume_from_generation THEN NULL ELSE key_expires_at END, updated_at=?
        WHERE home_id=? AND op_holder=? AND op_lease_until>=?`).bind(payload.generation, payload.generation, now, homeId, holder, now),
      env.DB.prepare(`UPDATE cloud_stepup_intents SET phase='compensated' WHERE id=? AND phase='compensating' AND ${HOLDS}`)
        .bind(payload.undelivered, homeId, holder, now),
      // The escalation (step-up-email.ts escalateUnrevoked, Astra STEPUP-EMAIL-5 #6) is resolved by the confirmed revocation, once no
      // other undelivered key of this home is still waiting for its own.
      env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=? WHERE home_id=? AND kind='flux.undelivered_key_unrevoked' AND resolved_at IS NULL AND ${HOLDS}
          AND NOT EXISTS (SELECT 1 FROM flux_home_ops WHERE home_id=? AND substr(op_id,1,12)='undelivered:' AND state IN ('queued','running') AND op_id<>?)`)
        .bind(now, homeId, homeId, holder, now, homeId, op.op_id),
    ]);
    if (held.meta.changes !== 1) throw new LeaseLost();
    return "done";
  }
  // compensate: revoke ONE generation's key. Never the generation the home committed, never any other.
  const home = await env.DB.prepare("SELECT generation FROM flux_home_keys WHERE home_id=?").bind(homeId).first<{ generation: number }>();
  if (home?.generation !== payload.generation) {
    await flux.revokeKey(homeId, payload.generation!, payload.lifecycleVersion!, "mint_raced");
  }
  return "done";
}

/** Run everything queued for a home, if the lease can be had. Never throws for a router failure. */
async function drainHome(env: Env, flux: FluxClient, homeId: string, clock: Clock): Promise<RunResult | "busy"> {
  let last: RunResult | "busy" = "busy";
  for (let round = 0; round < 3; round++) {
    const { holder, release } = holderFor(env, homeId);
    if (!(await acquireLease(env, homeId, holder, clock()))) return last;
    try { last = await runOps(env, flux, homeId, holder, clock); } finally { if (release) await releaseLease(env, homeId, holder); }
    if (last !== "clean" || !(await hasOpenOps(env, homeId, REVOKE_ONLY_CLIENTS.has(flux)))) return last; // an op landed while we released: go round again
  }
  return last;
}

/** What happened to an op after a drain. */
async function opOutcome(env: Env, opId: string): Promise<"done" | "superseded" | "failed" | "pending"> {
  const row = await env.DB.prepare("SELECT state,attempts FROM flux_home_ops WHERE op_id=?").bind(opId).first<{ state: string; attempts: number }>();
  if (row?.state === "done" || row?.state === "superseded") return row.state;
  return row && row.attempts > 0 ? "failed" : "pending";
}

/** An unlink is finished when every Stop it queued is done: only then is the link row removed
 *  (its version is remembered so a relink starts above it). Called by whoever completes the last one. */
async function finalizeUnlink(env: Env, ownerId: string, linkId: string): Promise<void> {
  await env.DB.batch(finalizeUnlinkStmts(env, ownerId, linkId));
}

/** The finalization as statements, each conditional on "the link is fenced and none of its Stops is
 *  still open" evaluated when it runs, so they can share a batch with the last Stop's completion. */
function finalizeUnlinkStmts(env: Env, ownerId: string, linkId: string): D1PreparedStatement[] {
  const ready = `EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=? AND link_id=? AND fenced=1)
    AND NOT EXISTS (SELECT 1 FROM flux_home_ops WHERE kind='stop' AND state IN ('queued','running') AND json_extract(payload,'$.linkId')=?)`;
  return [
    env.DB.prepare(`INSERT INTO flux_link_floor (owner_user_id,version)
      SELECT owner_user_id,link_version FROM flux_links WHERE owner_user_id=? AND link_id=? AND fenced=1 AND ${ready}
      ON CONFLICT(owner_user_id) DO UPDATE SET version=MAX(flux_link_floor.version,excluded.version)`)
      .bind(ownerId, linkId, ownerId, linkId, linkId),
    env.DB.prepare(`DELETE FROM flux_links WHERE owner_user_id=? AND link_id=? AND fenced=1 AND ${ready}`)
      .bind(ownerId, linkId, ownerId, linkId, linkId),
  ];
}

/** Cancel DELIVERY of the home's pending grants (statements, for the caller's batch): only the named invoice's when the stop names one (a
 *  refund or dispute of THAT payment never reaches another invoice's pending grant), every pending grant of the home otherwise (a
 *  suspension, a cancellation). Astra INTEGRATED-9 (KNOWN a): the retained paid entitlement of each one is JOURNALED first, in the same batch
 *  (b4-flux-ledger.ts cancellationJournalStatements): cancelling delivery never forfeits paid credit; what is still owed is the account's debt,
 *  alerted by the ledger. A grant whose payment (its invoice, or its contract) is disputed is marked redeliver='held': re-delivered under the
 *  same id once the dispute returned nothing (releaseDisputeHeld). Nothing is revoked here: only money actually returned removes credit. */
function cancelPendingStmts(env: Env, homeId: string, ref: string, now: number, options: { invoiceId?: string; keepRedeliveries?: boolean } = {}): D1PreparedStatement[] {
  const where = (t: string) => `${t}.home_id=? AND ${t}.status='pending'${options.invoiceId === undefined ? "" : ` AND ${t}.invoice_id=?`}${
    options.keepRedeliveries === true ? ` AND ${t}.redeliver IS NOT 'due'` : ""}`;
  const binds = [homeId, ...(options.invoiceId === undefined ? [] : [options.invoiceId])];
  return [
    ...refreshStatements(env.DB, homeScope(homeId), now), // the entitlement retained is the one the payment's records give NOW
    ...cancellationJournalStatements(env.DB, where("g"), binds, ref, now),
    env.DB.prepare(`UPDATE flux_grants SET status='cancelled',claim_id=NULL,redeliver=CASE WHEN ${DISPUTE_HELD_GRANT} THEN 'held' ELSE NULL END
      WHERE ${where("flux_grants")}`).bind(...binds),
  ];
}

/** HELD, never cancelled (Astra FLUX-STEP3 #1): a paid grant whose frozen recipient is not the owner's link in force right now
 *  (unlinked, being unlinked, or linked to ANOTHER Flux account). Unlink is sign-in only and fences keys, but it never forfeits
 *  credit the customer paid for: the grant keeps its status, its recipient and its attempts (none burned), carries the marker
 *  last_error 'grant_held:<why>' (the grants client's local-hold convention, flux-grants.ts / b5-billing.ts), and is delivered
 *  to that same recipient once a link to it is in force again. A relink to a different account never moves it: it stays held
 *  (recipient_mismatch) for operator review. Only billing (refund, dispute, non-payment) cancels or reverses a grant. */
const GRANT_HELD = "grant_held:";
type GrantHoldReason = "recipient_unlinked" | "recipient_mismatch" | "account_disputed";
function holdPendingStmt(env: Env, homeId: string, reason: GrantHoldReason): D1PreparedStatement {
  return env.DB.prepare("UPDATE flux_grants SET last_error=? WHERE home_id=? AND status='pending'").bind(GRANT_HELD + reason, homeId);
}
/** The home's ONE open flux.grant_held alert, reconciled from flux_grants (the shape of b5-billing.ts heldAlertSync, its own kind
 *  so the two reconcilers never resolve each other's alert): detail lists the grants held NOW, a changed list is delivered again,
 *  and it is resolved once none is held (delivered, expired, or cancelled by billing). */
const FLUX_HELD_WITH = `WITH h AS (SELECT grant_id AS id,substr(last_error,${GRANT_HELD.length + 1}) AS reason FROM flux_grants
    WHERE home_id=?1 AND status='pending' AND substr(COALESCE(last_error,''),1,${GRANT_HELD.length})='${GRANT_HELD}' ORDER BY created_at,grant_id),
  hd AS (SELECT COUNT(*) AS n,json_group_array(json_object('grantId',id,'reason',reason)) AS items,
    (SELECT id FROM h LIMIT 1) AS fid,(SELECT reason FROM h LIMIT 1) AS freason FROM h)`;
function heldAlertStmts(env: Env, homeId: string, now: number): D1PreparedStatement[] {
  return [
    env.DB.prepare(`${FLUX_HELD_WITH} UPDATE cloud_alerts SET detail=(SELECT json_object('grantId',fid,'reason',freason,'grants',json(items)) FROM hd),
      delivered_at=NULL,delivery_attempts=0 WHERE home_id=?1 AND kind='flux.grant_held' AND resolved_at IS NULL AND (SELECT n FROM hd)>0
      AND COALESCE(json_extract(detail,'$.grants'),'')<>(SELECT items FROM hd)`).bind(homeId),
    env.DB.prepare(`${FLUX_HELD_WITH} UPDATE cloud_alerts SET resolved_at=?2 WHERE home_id=?1 AND kind='flux.grant_held' AND resolved_at IS NULL
      AND (SELECT n FROM hd)=0`).bind(homeId, now),
    env.DB.prepare(`${FLUX_HELD_WITH} INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
      SELECT ?3,?1,'flux.grant_held','high',json_object('grantId',fid,'reason',freason,'grants',json(items)),?2 FROM hd
      WHERE n>0 AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=?1 AND a.kind='flux.grant_held' AND a.resolved_at IS NULL)`)
      .bind(homeId, now, `alert:flux_grant_held:${homeId}:${crypto.randomUUID()}`),
  ];
}
async function syncHeldAlert(env: Env, homeId: string, now: number): Promise<void> {
  await env.DB.batch(heldAlertStmts(env, homeId, now));
}

async function unlink(env: Env, config: FluxConfig, flux: FluxClient, ownerId: string, clock: Clock): Promise<Response> {
  const now = clock();
  // ONE batch: fence the link (version up, no new key can be issued under it, any mint in flight can no
  // longer commit) AND, per home, the lifecycle bump, the Stop intent and the grant HOLD. A fenced link
  // therefore always has its Stops recorded. The link row goes only when every one of them is done.
  // Fencing keys is cancellation-like (sign-in only); forfeiting paid credit is not: pending grants keep
  // their frozen recipient and are held, never cancelled or reversed because of an unlink (Astra FLUX-STEP3 #1).
  const link = await linkRowOf(env, ownerId);
  const homes = await homesOf(env, ownerId);
  for (const homeId of homes) await ensureHomeRow(env, config, homeId, now);
  const ops: string[] = [];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE flux_links SET link_version=link_version+1,fenced=1 WHERE owner_user_id=?").bind(ownerId),
  ];
  for (const homeId of homes) {
    const stop = stopOpStmt(env, homeId, now, "unlink", { ownerId, linkId: link?.link_id ?? null });
    ops.push(stop.opId);
    statements.push(
      env.DB.prepare(`UPDATE flux_home_keys SET ${STOPPING},updated_at=? WHERE home_id=?`).bind(now, homeId),
      stop.stmt,
      holdPendingStmt(env, homeId, "recipient_unlinked"), // paid credit stays the customer's; delivered only to its frozen recipient
      ...heldAlertStmts(env, homeId, now),
    );
  }
  await env.DB.batch(statements);
  for (const homeId of homes) await drainHome(env, flux, homeId, clock);
  if (link && await linkRowOf(env, ownerId)) {
    await finalizeUnlink(env, ownerId, link.link_id);
    if (await linkRowOf(env, ownerId)) {
      const outcomes = await Promise.all(ops.map((id) => opOutcome(env, id)));
      throw outcomes.includes("failed") ? new HTTPError(502, "flux_unavailable") : new HTTPError(409, "home_busy");
    }
  }
  return json({ linked: false, stoppedHomes: homes.length });
}

// ── Keys, Stop, cap ──────────────────────────────────────────────────────────

async function machineNetwork(env: Env, homeId: string): Promise<{ boundIps: string[]; generation: number }> {
  const row = await env.DB.prepare("SELECT generation,state,bound_ips FROM cloud_machines WHERE id=?")
    .bind(homeId).first<{ generation: number; state: string; bound_ips: string | null }>();
  if (!row) throw new HTTPError(404, "not_found");
  if (row.state !== "active") throw new HTTPError(409, "home_inactive");
  const ips = row.bound_ips ? (JSON.parse(row.bound_ips) as unknown) : null;
  if (!Array.isArray(ips) || ips.length === 0 || !ips.every((ip) => typeof ip === "string")) {
    throw new HTTPError(409, "unbound_machine");
  }
  return { boundIps: ips as string[], generation: row.generation };
}

type MintMode = { kind: "renewal"; machineGeneration: number; opId?: string; onFirstKey?: () => Promise<void> };

/** The machine mint's own guards, in the SAME statements as the reservation and the commit (nothing between the request's first read and
 *  the commit can be trusted): the machine is still the active one at the generation the request authenticated with (a delete or a re-key
 *  fences it), the home is not deleted, and a FIRST key still sees a paid, live, owned home (a payment-failed webhook that landed during
 *  ensure-account or the mint ends the claim). Owner mints carry none of these. */
function machineGuard(homeId: string, machineGeneration: number | null, firstKey: boolean): { sql: string; binds: unknown[] } {
  if (machineGeneration === null) return { sql: "", binds: [] };
  return {
    sql: ` AND EXISTS (SELECT 1 FROM cloud_machines WHERE id=? AND generation=? AND state='active')
      AND NOT EXISTS (SELECT 1 FROM cloud_homes WHERE id=? AND desired_state='deleted')${firstKey ? ` AND ${paidLiveSql("?")} = 1` : ""}`,
    binds: [homeId, machineGeneration, homeId, ...(firstKey ? [homeId] : [])],
  };
}

/** Why a machine mint was refused by its guards, in the plain words the poller already knows; null when they all still hold. */
async function machineRefusal(env: Env, homeId: string, machineGeneration: number | null, firstKey: boolean): Promise<HTTPError | null> {
  if (machineGeneration === null) return null;
  const m = await env.DB.prepare("SELECT generation,state FROM cloud_machines WHERE id=?").bind(homeId).first<{ generation: number; state: string }>();
  if (!m || m.generation !== machineGeneration || m.state !== "active") return new HTTPError(401, "unauthorized");
  const h = await env.DB.prepare("SELECT desired_state FROM cloud_homes WHERE id=?").bind(homeId).first<{ desired_state: string }>();
  if (h?.desired_state === "deleted") return new HTTPError(409, "home_not_active");
  if (firstKey && (await env.DB.prepare(`SELECT ${paidLiveSql("?")} AS paid`).bind(homeId).first<{ paid: number | null }>())?.paid !== 1) return new HTTPError(409, "home_not_active");
  return null;
}

/** One more consecutive wait on the bound table: a failed first key, or a machine mint that has not been acked yet (cleared by the ack). */
const retryBumpSql = (afterCommit: boolean): string => `INSERT INTO flux_first_key_retry (home_id,failures,next_at,updated_at)
  ${afterCommit ? "SELECT" : "VALUES ("}?1,1,?2+${firstKeyRetryDelayMs(1)},?2${afterCommit ? " WHERE changes()=1" : ")"}
  ON CONFLICT(home_id) DO UPDATE SET failures=failures+1,next_at=?2+MIN(600000,60000*(1<<MIN(failures,4))),updated_at=?2,hold=NULL`;

/** FLUX-ENSURE-EMAIL-VERIFIED (design-ev3 section 4, Grok r3 High 1): the email_unverified HOLD on the bound table. failures 0 on a new row and
 *  UNCHANGED on an existing one (migration 0142 allows 0 with a hold). M1 (astra-code1): next_at is the ACCOUNT's one hold deadline
 *  (flux_email_hold, moved only by an actual 202, flux-grants.ts ensureOwnerAccount), never now + 15 min per home, so homes of one account can
 *  never renew each other's hold; with no deadline row (an open dispute) it is now + 15 min. The poller asks at most 4 times an hour. On
 *  conflict only next_at and hold move. The wake-up (flux-email-proof.ts) deletes hold rows once linked; a real failure clears the hold
 *  (retryBumpSql above). ?1 home, ?2 now, ?3 account. */
export const EMAIL_UNVERIFIED_HOLD_MS = EMAIL_HOLD_MS;
/** M-a (design-pc2): ONE conditional statement. Written only while no link exists and the revision captured before the ensure (?4) is still
 *  current, so a stale continuation after the wake linked (or after an address move) writes nothing. */
const emailHoldSql = `INSERT INTO flux_first_key_retry (home_id,failures,next_at,updated_at,hold)
    SELECT ?1,0,MAX(?2+60000,COALESCE((SELECT until_at FROM flux_email_hold WHERE account_id=?3),?2+${EMAIL_HOLD_MS})),?2,'email_unverified'
    WHERE NOT EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=?3) AND EXISTS (SELECT 1 FROM supabase_identities WHERE user_id=?3 AND email_revision=?4)
  ON CONFLICT(home_id) DO UPDATE SET next_at=excluded.next_at,hold=excluded.hold`;
/** DISPUTE-FENCE-ACCOUNT: the same typed hold row for a first key refused by an open dispute (the account may be linked, so no link condition). */
// Astra Low 4: written ONLY while the dispute is still open in the same statement, so a clear that committed after the read leaves no fresh wait behind.
export const writeDisputeFirstKeyHold = (env: Env, homeId: string, now: number) =>
  env.DB.prepare(`INSERT INTO flux_first_key_retry (home_id,failures,next_at,updated_at,hold)
    SELECT ?1,0,?2+${EMAIL_HOLD_MS},?2,'email_unverified' WHERE ${homeDisputeOpenSql("?1")}
    ON CONFLICT(home_id) DO UPDATE SET next_at=excluded.next_at,hold=excluded.hold`).bind(homeId, now).run();
/** The first-key email_unverified hold row (M-a), exported for its test. */
export const writeFirstKeyHold = (env: Env, homeId: string, ownerId: string, revision: number, now: number) =>
  env.DB.prepare(emailHoldSql).bind(homeId, now, ownerId, revision).run();

/** The machine route only (the owner mint is retired: POST /v1/homes/:id/flux/subkey answers 410). RENEWAL only. The home must be active and its key due, or (the FIRST key) never keyed and paid and live
 *  (b4-flux-renewal.ts); it can never undo an owner Stop, a billing hold or spending off, and it never touches a stopped or stopping home. */
async function issueKey(
  env: Env, config: FluxConfig, flux: FluxClient, ownerId: string, homeId: string, clock: Clock, mode: MintMode,
): Promise<Response> {
  const now = clock();
  // The machine route's FIRST KEY (a home that never had one, paid and live: b4-flux-renewal.ts): decided from ONE read BEFORE anything is
  // called, so an ineligible home never causes an ensure-account call. Every refusal is the plain reason; the retry bound is on D1.
  let firstKey = false;
  if (mode.kind === "renewal") {
    const state = await readRenewalState(env, homeId);
    if (state !== null && neverKeyed(state)) {
      if (state.billing_hold === 1) throw new HTTPError(409, "billing_hold");
      if (state.spending_off === 1) throw new HTTPError(409, "spending_off", { message: SPENDING_OFF_WORDS });
      if (state.paid !== 1) throw new HTTPError(409, "home_not_active");
      if (state.retry_at !== null && state.retry_at > now) throw new HTTPError(429, "first_key_retry_later");
      firstKey = true;
    } else if (state !== null && state.state !== "active") {
      if (state.billing_hold === 1) throw new HTTPError(409, "billing_hold");
      throw new HTTPError(409, "home_not_active", state.spending_off === 1 ? { message: SPENDING_OFF_WORDS } : undefined); // stopped, stopping: never resumed here
    } else if (state !== null && renewalHeldBack(state.retry_at, state.key_expires_at, now)
      && (state.key_expires_at === null || state.key_expires_at - now <= RENEWAL_WINDOW_MS || unadopted(state) || unacknowledged(state))) { // (a key that is not due is answered renewal_not_due below)
      throw new HTTPError(429, "renewal_retry_later"); // a minted key not yet acked: the same 1, 2, 4, 8, 10 minute bound as the first key
    }
  }
  try {
    return await issueKeyChecked(env, config, flux, ownerId, homeId, clock, mode, firstKey);
  } catch (error) {
    // A failed first key (ensure unavailable or refused, not linked, router 5xx, a lost lease) is counted: the poller asks again, but
    // never sooner than the bound allows. Recorded on D1, so it holds across Worker instances.
    // Refusals decided without calling Flux (a replayed or foreign op, a lost state) are not counted: only attempts that reached ensure or mint.
    // renewal_retry_later (a Stop of this home still open, G5) is a hold-back, not a failed attempt: the mint waits for the Stop, not the bound.
    // flux_email_unverified: the typed hold, already written by issueKeyChecked (failures unchanged, next_at = now + 15 min): never a failure.
    const uncounted = error instanceof HTTPError && ["renewal_replayed", "renewal_op_mismatch", "renewal_not_due", "home_not_active", "billing_hold",
      "spending_off", "home_inactive", "unbound_machine", "not_found", "unauthorized", "flux_email_unverified", "flux_link_stale", "renewal_retry_later"].includes(error.code);
    // 8b fix r1 (Astra M5): every failed machine attempt that reached ensure, the lease or the router is counted on the same bound table: the first
    // key, a resume (NULL expiry), an ordinary renewal inside the window and a retry of an unadopted or unacked one outside it. The wait after the
    // nth consecutive failure is 1, 2, 4, 8, then 10 minutes, so the cue never hands the poller a mint on every poll.
    if (mode.kind === "renewal" && !uncounted) {
      await env.DB.prepare(retryBumpSql(false)).bind(homeId, now).run();
    }
    throw error;
  }
}

async function issueKeyChecked(
  env: Env, config: FluxConfig, flux: FluxClient, ownerId: string, homeId: string, clock: Clock, mode: MintMode, firstKey: boolean,
): Promise<Response> {
  const now = clock();
  let link = await linkRowOf(env, ownerId);
  // Lane H1, item 1: before the FIRST mint of an owner with no link row, the owner's Flux account is ensured and the link written (link_id =
  // the Flux account id, version 1). Flux off: the gated client has no ensureAccount, nothing is called. A refusal is alerted.
  if (link === null && flux.ensureAccount) {
    // M-a: the address revision the ensure is asked on, captured BEFORE it; the hold below is written only while it is still current.
    const revision = (await env.DB.prepare("SELECT email_revision AS r FROM supabase_identities WHERE user_id=?").bind(ownerId).first<{ r: number }>())?.r ?? -1;
    const ensured = await ensureOwnerAccount(env, ownerId, homeId, (a) => flux.ensureAccount!(a), now);
    if (ensured === "unavailable") throw new HTTPError(502, "flux_unavailable");
    if (ensured === "email_unverified") {
      // No link was written (ensureOwnerAccount caught the hold before the insert). The machine first key records the typed hold row, then
      // answers 409 flux_email_unverified, which the catch in issueKey does not count.
      if (firstKey) await writeFirstKeyHold(env, homeId, ownerId, revision, now);
      throw new HTTPError(409, "flux_email_unverified");
    }
    // H1: Flux answered on a state that moved in flight (the address, the proof, a dispute): nothing linked, not a failure, asked again.
    if (ensured === "stale") throw new HTTPError(409, "flux_link_stale");
    link = await linkRowOf(env, ownerId);
  }
  if (link === null || link.fenced === 1) throw new HTTPError(409, "flux_not_linked");
  // DISPUTE-FENCE-ACCOUNT: an open account-level dispute holds the key even for a LINKED account (the claim and the commit below re-check it
  // inside their own statements). The first key records the typed 15-minute hold, so the poller does not ask every poll; never a failure.
  if (await accountDisputeOpen(env, ownerId)) {
    if (firstKey || mode.kind === "renewal") await writeDisputeFirstKeyHold(env, homeId, now); // a refused renewal is not asked again every poll
    throw new HTTPError(409, "flux_email_unverified");
  }
  const { boundIps } = await machineNetwork(env, homeId);
  const row = await ensureHomeRow(env, config, homeId, now);
  if (row.billing_hold === 1) throw new HTTPError(409, "billing_hold");
  let opId = "";
  if (mode.kind === "renewal") {
    // The row as it stands now: a first key needs it still never-keyed, un-held and spending on (a Stop or a hold that landed while
    // ensure-account ran leaves it stopping, stopped or held, and is refused here as everywhere).
    if (firstKey ? !(row.state === "none" && row.generation === 0) : row.state !== "active") {
      throw new HTTPError(409, "home_not_active", row.spending_off === 1 ? { message: SPENDING_OFF_WORDS } : undefined);
    }
    if (firstKey && row.spending_off === 1) throw new HTTPError(409, "spending_off", { message: SPENDING_OFF_WORDS });
    // 8b fix r1 (Astra H1): an adopted generation the home never acked keeps the renewal due, as in renewalDueOf.
    if (row.key_expires_at !== null && row.key_expires_at - now > RENEWAL_WINDOW_MS && !unadopted(row) && !unacknowledged(row)) throw new HTTPError(409, "renewal_not_due");
    opId = renewalOpId(homeId, mode.machineGeneration, row.generation);
    // The poller names the attempt it was told about; a stale or foreign name is not this renewal.
    if (mode.opId !== undefined && mode.opId !== opId) throw new HTTPError(409, "renewal_op_mismatch");
    const claimed = await env.DB.prepare("INSERT OR IGNORE INTO flux_mint_ops (op_id,home_id,created_at) VALUES (?,?,?)")
      .bind(opId, homeId, now).run();
    if (claimed.meta.changes !== 1) throw new HTTPError(409, "renewal_replayed");
  }
  try {
    const response = await mintAndCommit(env, config, flux, ownerId, link, homeId, clock, boundIps, row, opId, firstKey, mode.kind === "renewal" ? mode.machineGeneration : null);
    // The key landed: its commit recorded the next wait on the bound table (cleared by the ack). The plan grant goes out now, so a paid
    // customer does not wait for the sweep; its failure never touches the key response (the sweep stays the backstop).
    if (firstKey && mode.kind === "renewal" && mode.onFirstKey) { try { await mode.onFirstKey(); } catch { /* the sweep retries the grant */ } }
    return response;
  } catch (error) {
    // A mint that did not land may be retried with the same operation identity.
    if (mode.kind === "renewal") await env.DB.prepare("DELETE FROM flux_mint_ops WHERE op_id=?").bind(opId).run();
    throw error;
  }
}

/** True when the router may have published the key although we got no clean answer. */
function mayHavePublished(error: unknown): boolean {
  if (!(error instanceof FluxError)) return true;
  if (error instanceof FluxCapabilityPending) return false; // the gate sent nothing
  if (error.status === 0) return true;
  if (error.status === 503 && (error.code === "billing_identity_unavailable" || error.detail === "billing_identity_unavailable")) return false;
  return error.status >= 500;
}

/** A mint runs only while it holds the home's lease, so a compensation, Stop or cap push for the same
 *  home can never overlap it at the router. Whatever those queued meanwhile runs right after. */
async function mintAndCommit(
  env: Env, config: FluxConfig, flux: FluxClient, ownerId: string, link: LinkRow, homeId: string, clock: Clock,
  boundIps: string[], row: HomeRow, opId: string, firstKey = false, machineGeneration: number | null = null,
): Promise<Response> {
  const { holder, release } = holderFor(env, homeId);
  if (!(await acquireLease(env, homeId, holder, clock()))) throw new HTTPError(409, "home_busy"); // retryable
  let outcome: { response: Response } | { error: unknown };
  let after: RunResult = "failed";
  try {
    // Ops queued ahead of this request go first. If one of them fails, or the lease is lost while
    // they run, STOP: minting now would act without ownership or ahead of an unfinished Stop
    // (round 4: a caller that lost its lease went on to publish a generation above a later
    // caller's successful mint, which the compensation then tombstoned).
    const before = await runOps(env, flux, homeId, holder, clock);
    if (before !== "clean") {
      // 8b (2.3, G5): a Stop of this home that is queued, running or failed holds the poller's resume mint back; it asks again later.
      if (before === "failed" && machineGeneration !== null && await stopOpOpen(env, homeId)) throw new HTTPError(429, "renewal_retry_later");
      throw before === "lost" ? new HTTPError(409, "home_busy") : new HTTPError(502, "flux_unavailable");
    }
    try { outcome = { response: await mintLocked(env, config, flux, ownerId, link, homeId, clock, boundIps, row, opId, holder, firstKey, machineGeneration) }; }
    catch (error) { outcome = { error }; }
    after = await runOps(env, flux, homeId, holder, clock); // Stop / cap / compensation queued meanwhile
  } finally {
    if (release) await releaseLease(env, homeId, holder);
  }
  if (after === "clean" && await hasOpenOps(env, homeId)) await drainHome(env, flux, homeId, clock);
  if ("error" in outcome) throw outcome.error;
  return outcome.response;
}

/** 8b (G5): one indexed point check (flux_home_ops_by_home): is a Stop of this home queued, running or failed (a failed one stays queued)? */
const stopOpOpen = async (env: Env, homeId: string): Promise<boolean> =>
  (await env.DB.prepare("SELECT 1 AS x FROM flux_home_ops WHERE home_id=? AND state IN ('queued','running') AND kind='stop' LIMIT 1").bind(homeId).first()) !== null;

async function mintLocked(
  env: Env, config: FluxConfig, flux: FluxClient, ownerId: string, link: LinkRow, homeId: string, clock: Clock,
  boundIps: string[], row: HomeRow, opId: string, holder: string, firstKey = false, machineGeneration: number | null = null,
): Promise<Response> {
  const now = clock();
  const ttlSeconds = config.subkeyTtlDays * 86_400;
  // 8b (2.4): the poller's mint at a lifecycle the owner's resume wrote, until one key at it is acked. The router reads it (PR 624) and lifts a Stop
  // only for this mint; an ordinary renewal sends false. The claim keeps machine semantics (no state bypass, no lifecycle bump).
  const routerResume = machineGeneration !== null && row.resume_lv !== null && row.resume_lv === row.lifecycle_version && row.acked_lifecycle_version !== row.lifecycle_version;
  if (routerResume && await stopOpOpen(env, homeId)) throw new HTTPError(429, "renewal_retry_later");
  // 1. CLAIM, durably, before Flux is called: advance the monotonic versions (an owner resume
  //    advances the lifecycle version, so a delayed Stop retry is stale), take the next generation
  //    above every one ever attempted, and re-check billing and the link in the same statement.
  //    The mint's journal row is written in the same batch (only if the claim took).
  const mintOp = opStmt(env, homeId, "mint", now, {
    sql: `(SELECT json_object('generation', gen_floor, 'lifecycleVersion', lifecycle_version) FROM flux_home_keys WHERE home_id = ?)`,
    binds: [homeId],
  }, { state: "running", where: { sql: "changes() = 1", binds: [] } });
  // Under an emailed approval the claim also requires the WHOLE target to be exactly the one the approval pinned (the home's generation
  // and state, the key, the cap, the link: step-up-email.ts targetSpec), in the same statement, before anything is reserved (Astra
  // STEPUP-EMAIL-7 #2): a change somebody else made after the approval is never absorbed into this operation's own reservation.
  const pinned = pinnedTargetHolds(env);
  const guard = machineGuard(homeId, machineGeneration, firstKey);
  const [claimed] = await env.DB.batch<{ lifecycle_version: number; cap_version: number; gen_floor: number; cap_microcents: number; billing_customer_id: string | null }>([
    env.DB.prepare(`UPDATE flux_home_keys SET lifecycle_version = lifecycle_version + CASE WHEN ? = 1 AND state <> 'active' THEN 1 ELSE 0 END, cap_version = cap_version + 1,
      gen_floor = MAX(generation, gen_floor) + 1, updated_at = ?
    WHERE home_id = ? AND billing_hold = 0 AND (lifecycle_version = ? AND (state = 'active' OR (? = 1 AND state = 'none' AND generation = 0))) AND spending_off = 0
      AND op_holder = ? AND op_lease_until >= ?
      AND EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id = ? AND link_id = ? AND link_version = ? AND fenced = 0)
      AND NOT ${accountDisputeOpenSql("?")}${guard.sql}${pinned ? ` AND ${pinned.sql}` : ""}
    RETURNING lifecycle_version, cap_version, gen_floor, ${EFFECTIVE_CAP} AS cap_microcents, billing_customer_id`)
      .bind(firstKey ? 1 : 0, now, homeId, row.lifecycle_version, firstKey ? 1 : 0, holder, clock(), ownerId, link.link_id, link.link_version, ownerId,
        ...guard.binds, ...(pinned?.binds ?? [])),
    mintOp.stmt,
    // A step-up operation records the versions THIS reservation moved its frozen target to, in this same transaction (Astra
    // STEPUP-EMAIL-4 #4): resumed after an interruption, it recognises its own change instead of voiding itself; an intervening Stop
    // still moves the target past both and is refused.
    ...[reserveStatement(env)].filter((x): x is D1PreparedStatement => x !== null),
  ]);
  const claim = claimed.results[0];
  if (!claim) {
    // The machine's own guards first: a fenced machine, a deleted home or a first key that is no longer paid is refused plainly (nothing was minted).
    const machineRefused = await machineRefusal(env, homeId, machineGeneration, firstKey);
    if (machineRefused) throw machineRefused;
    // The approval's target moved (anything, the home generation included): the approval is void, a fresh intent is asked for.
    if (pinned && (await env.DB.prepare(`SELECT ${pinned.sql} AS holds`).bind(...pinned.binds).first<{ holds: number }>())?.holds !== 1) {
      throw new HTTPError(403, "step_up_required");
    }
    throw await mintRefusal(env, ownerId, homeId, holder);
  }
  // The home generation the approval was pinned at, fenced again at the commitment (an own reservation never moves it).
  const homeGeneration = pinnedHomeGeneration(env);

  const finishMint = () => env.DB.prepare("UPDATE flux_home_ops SET state='done',updated_at=? WHERE op_id=?").bind(now, mintOp.opId).run();
  const enqueueCompensation = (generation: number) => opStmt(env, homeId, "compensate", now, { json: { generation, lifecycleVersion: claim.lifecycle_version } }).stmt.run();
  let generation = claim.gen_floor;
  let minted: FluxMinted | null = null;
  for (let attempt = 0; attempt < 2 && minted === null; attempt++) {
    // The journal row names the generation that may be published: a crash from here on leaves a mint op
    // that the sweep turns into a compensation of exactly this generation.
    await env.DB.prepare("UPDATE flux_home_ops SET payload=json_set(payload,'$.generation',?),updated_at=? WHERE op_id=?").bind(generation, now, mintOp.opId).run();
    // Only the current holder of an unexpired lease may dispatch (fresh time, renewed right here).
    if (!(await renewLease(env, homeId, holder, clock()))) {
      await finishMint();
      throw new HTTPError(409, "home_busy");
    }
    // A step-up operation journals this dispatch first, under its stable identity (step-up-op.ts): a superseded runner stops here.
    await journalDispatch(env, `flux:${homeId}:${generation}`);
    try {
      minted = await flux.mint({
        accountId: link.flux_account_id, homeId, generation, boundIps, capMicrocents: claim.cap_microcents, ttlSeconds,
        lifecycleVersion: claim.lifecycle_version, ownerResume: routerResume, opId,
        linkId: link.link_id, linkVersion: link.link_version, capVersion: claim.cap_version, billingState: "ok",
      });
    } catch (error) {
      // Ambiguous: the key may exist. A compensation revokes this exact generation, retried by the sweep.
      if (mayHavePublished(error)) await enqueueCompensation(generation);
      // Flux already holds a newer generation than we recorded (a mint that landed but whose
      // answer we lost). Move past it once. Every other 409 is final.
      // 8b (required test): a 409 stale_generation (by its code, or the router's words) says a key at that generation or higher already landed (a
      // lost answer). It is treated as landed: moved past once, nothing compensated (it published nothing new), the retry mints above it.
      const behind = error instanceof FluxError && error.status === 409 && (/generation must be greater than/i.test(error.detail) || error.code === "stale_generation")
        ? /(\d+)\s*$/.exec(error.detail)?.[1] ?? String(generation) : undefined;
      if (attempt === 0 && behind !== undefined) {
        generation = Number(behind) + 1;
        await env.DB.prepare("UPDATE flux_home_keys SET gen_floor=MAX(gen_floor,?) WHERE home_id=?").bind(generation, homeId).run();
        continue;
      }
      await finishMint();
      throw fluxFailure(error);
    }
  }
  if (minted === null) { await finishMint(); throw new HTTPError(502, "flux_unavailable"); }
  const published = minted;
  // 2. CAP SYNC (round 4): the key is never handed out while the router enforces a cap other than the
  //    one the control plane holds. The mint published the claim's cap; if the owner changed the cap
  //    since, push the database's current cap and version now, while we still hold the lease. If that
  //    cannot be done, the key is never returned: its generation is compensated (revoked) and the
  //    caller gets a retryable 503. The commit below then requires that same cap version.
  let enforced = { capMicrocents: claim.cap_microcents, capVersion: claim.cap_version };
  const refuseUnsynced = async (): Promise<never> => {
    await env.DB.batch([
      env.DB.prepare("UPDATE flux_home_ops SET state='done',updated_at=? WHERE op_id=?").bind(clock(), mintOp.opId),
      opStmt(env, homeId, "compensate", clock(), { json: { generation: published.generation, lifecycleVersion: claim.lifecycle_version } }).stmt,
    ]);
    throw new HTTPError(503, "cap_sync_pending");
  };
  for (let round = 0; ; round++) {
    const current = await env.DB.prepare(`SELECT ${EFFECTIVE_CAP} AS cap_microcents,cap_version FROM flux_home_keys WHERE home_id=?`)
      .bind(homeId).first<{ cap_microcents: number; cap_version: number }>();
    if (!current || current.cap_version === enforced.capVersion) break;
    if (round >= 3 || !(await renewLease(env, homeId, holder, clock()))) await refuseUnsynced();
    try {
      await flux.setCap(homeId, current!.cap_microcents, current!.cap_version);
      enforced = { capMicrocents: current!.cap_microcents, capVersion: current!.cap_version };
    } catch {
      await refuseUnsynced(); // includes 409 stale_cap: the router's cap is not the one we hold
    }
  }
  // 3. COMMIT: only if we still hold an unexpired lease, the link is the same unfenced link, billing is
  //    still ok, no later lifecycle operation (Stop, billing stop, unlink, resume) happened while Flux
  //    was working, and the cap version is the one the router now enforces. In the same batch the mint
  //    op is finished and, if the commit did not adopt the key, a compensation of THIS generation is
  //    queued.
  const newExpiry = Date.parse(minted.expiresAt) || now + ttlSeconds * 1000;
  const commitAt = clock();
  const [committed] = await env.DB.batch([
    // Hole 11: a machine RENEWAL is delivered through the poller: its expiry waits in pending_* until the poller's ack
    // (ackSubkey, the only runtime writer of a non-NULL key_expires_at), so an undelivered replacement never makes renewal look "not due".
    env.DB.prepare(`UPDATE flux_home_keys SET generation=?,state='active',
        pending_op_id=?,pending_generation=?,pending_expires_at=?,pending_lifecycle_version=?,
        link_id=?,link_version=?,stop_version=NULL,stop_link_version=NULL,updated_at=?
      WHERE home_id=? AND op_holder=? AND op_lease_until>=? AND lifecycle_version=? AND billing_hold=0 AND generation<? AND cap_version=?
        AND EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=? AND link_id=? AND link_version=? AND fenced=0)
        AND NOT ${accountDisputeOpenSql("?")}${guard.sql}${homeGeneration
          ? " AND EXISTS (SELECT 1 FROM cloud_homes WHERE id=? AND generation=? AND desired_state<>'deleted')" : ""}`)
      .bind(minted.generation,
        opId, minted.generation, newExpiry, claim.lifecycle_version,
        link.link_id, link.link_version, now,
        homeId, holder, commitAt, claim.lifecycle_version, minted.generation, enforced.capVersion, ownerId, link.link_id, link.link_version, ownerId,
        ...guard.binds, ...(homeGeneration ? [homeGeneration.homeId, homeGeneration.generation] : [])),
    // A machine mint is delivered through the poller: until its ack the next mint waits the bound (1, 2, 4, 8, then 10 minutes), so a key
    // whose response or ack was lost is never re-minted every poll. Same transaction as the commit, only if the commit took.
    ...(machineGeneration === null ? [] : [env.DB.prepare(retryBumpSql(true)).bind(homeId, commitAt)]),
    // A step-up operation's commitment, in the same transaction as the key it adopts (delivery is its finalization; an undelivered
    // committed key is compensated by the step-up sweep, by phase).
    ...[commitStatement(env, `flux:${homeId}:${minted.generation}`)].filter((x): x is D1PreparedStatement => x !== null),
    env.DB.prepare("UPDATE flux_home_ops SET state='done',updated_at=? WHERE op_id=?").bind(now, mintOp.opId),
    opStmt(env, homeId, "compensate", now, { json: { generation: minted.generation, lifecycleVersion: claim.lifecycle_version } }, {
      where: { sql: "NOT EXISTS (SELECT 1 FROM flux_home_keys WHERE home_id = ? AND generation = ?)", binds: [homeId, minted.generation] },
    }).stmt,
  ]);
  if (committed.meta.changes !== 1) {
    // Never returned; compensation queued (the batch above revokes any generation the commit did not adopt: the existing revoke path).
    const machineRefused = await machineRefusal(env, homeId, machineGeneration, firstKey);
    if (machineRefused) throw machineRefused;
    // A home generation that moved after the approval voids it (403, a fresh intent); a Stop that
    // landed during the provider call (the lifecycle moved, the generation did not) answers 409 stale_lifecycle (STEP-UP-EMAIL-OTP.md 1).
    if (homeGeneration && (await env.DB.prepare("SELECT 1 AS x FROM cloud_homes WHERE id=? AND generation=? AND desired_state<>'deleted'")
      .bind(homeGeneration.homeId, homeGeneration.generation).first()) === null) throw new HTTPError(403, "step_up_required");
    throw await mintRefusal(env, ownerId, homeId, holder, claim.lifecycle_version);
  }
  const response = json({
    key: minted.key,
    generation: minted.generation,
    expiresAt: minted.expiresAt,
    capUsd: microcentsToUsd(enforced.capMicrocents), // what the router enforces, which equals what we hold
  });
  response.headers.set("cache-control", "no-store");
  return response;
}

/** Why a mint was refused after the fact: the most specific stable reason. */
async function mintRefusal(env: Env, ownerId: string, homeId: string, holder?: string, lifecycleVersion?: number): Promise<HTTPError> {
  const link = await linkRowOf(env, ownerId);
  if (link === null || link.fenced === 1) return new HTTPError(409, "flux_not_linked");
  if (await accountDisputeOpen(env, ownerId)) return new HTTPError(409, "flux_email_unverified"); // DISPUTE-FENCE-ACCOUNT
  const row = await env.DB.prepare("SELECT billing_hold,spending_off,op_holder,lifecycle_version FROM flux_home_keys WHERE home_id=?")
    .bind(homeId).first<{ billing_hold: number; spending_off: number; op_holder: string | null; lifecycle_version: number }>();
  if (row?.billing_hold === 1) return new HTTPError(409, "billing_hold");
  if (row?.spending_off === 1) return new HTTPError(409, "spending_off", { message: SPENDING_OFF_WORDS });
  if (holder !== undefined && row && row.op_holder !== holder) return new HTTPError(409, "home_busy"); // lease lost: retryable
  if (lifecycleVersion !== undefined && row?.lifecycle_version === lifecycleVersion) return new HTTPError(503, "cap_sync_pending"); // only the cap moved
  return new HTTPError(409, "stale_lifecycle");
}

/** The owner Stop's writes: the lifecycle bump with 'stopping', and the Stop intent carrying the version just written. Always committed
 *  in ONE batch: ownerStop's own, cap OFF's (setCap, together with spending_off), or the sweep's repair (repairSpendingOffStop).
 *  `onlyIfOffActive` (CAPOFF-REPAIR-RACE): both writes apply only while, at write time, spending is off, the key is active and no Stop is
 *  open for the home; otherwise the bump changes no row and the Stop insert (conditioned on it, changes()=1) writes nothing. */
function ownerStopStatements(env: Env, homeId: string, now: number, onlyIfOffActive = false): { stmts: D1PreparedStatement[]; opId: string } {
  const stop = stopOpStmt(env, homeId, now, "stop", undefined, onlyIfOffActive ? { sql: "changes()=1", binds: [] } : undefined);
  const when = onlyIfOffActive
    ? " AND spending_off=1 AND state='active' AND NOT EXISTS (SELECT 1 FROM flux_home_ops WHERE home_id=? AND kind='stop' AND state IN ('queued','running'))" : "";
  return {
    stmts: [env.DB.prepare(`UPDATE flux_home_keys SET ${STOPPING},updated_at=? WHERE home_id=?${when}`).bind(now, homeId, ...(onlyIfOffActive ? [homeId] : [])), stop.stmt],
    opId: stop.opId,
  };
}

/** CAPOFF-REPAIR-RACE: the sweep's repair of an OFF home still active with no Stop open. ONE conditional batch (ownerStopStatements with
 *  onlyIfOffActive): a cap ON or another sweep's repair landing after the eligibility read leaves it writing nothing. Returns the Stop's op
 *  id when it was journaled, null when the condition no longer held. Throws when the batch fails (nothing committed). */
async function repairSpendingOffStop(env: Env, homeId: string, now: number): Promise<string | null> {
  const stop = ownerStopStatements(env, homeId, now, true);
  const [bumped] = await env.DB.batch(stop.stmts);
  return bumped.meta.changes === 1 ? stop.opId : null;
}

/** Owner Stop: ONE batch (lifecycle bump, 'stopping', the Stop intent), then the drain. */
async function ownerStop(env: Env, config: FluxConfig, flux: FluxClient, homeId: string, clock: Clock): Promise<Response> {
  const now = clock();
  await ensureHomeRow(env, config, homeId, now);
  const stop = ownerStopStatements(env, homeId, now);
  await env.DB.batch(stop.stmts);
  await drainHome(env, flux, homeId, clock);
  switch (await opOutcome(env, stop.opId)) {
    case "done": return json({ state: "stopped" });
    case "superseded": throw new HTTPError(409, "stale_lifecycle"); // a resume owns the home now
    case "failed": throw new HTTPError(502, "flux_unavailable");
    default: return json({ state: "stopping" }, 202); // queued behind the op that holds the home; it finishes it
  }
}

/** Change the cap (and optionally the plan): the new value, the next cap version and the push intent
 *  commit together. The push always sends the database's current cap and version and is retried until
 *  the router answers, so there is nothing to undo. Returns false while the router has not got it yet.
 *  `notRaising`: the change is written only if it does not raise the cap stored AT THAT MOMENT (journey A8: a sign-in-only change, checked
 *  in the same atomic write that makes it, so a concurrent lowering can never turn it into an unstepped raise); "refused" if it would.
 *  `pinned`: an emailed approval's frozen target (Astra STEPUP-EMAIL-6 #2). The cap UPDATE applies only while the home is still exactly
 *  that target (its cap_version among it), and a guard in the SAME transaction rolls the push back with it when it did not: a newer cap
 *  change (another writer) supersedes the approval, which is refused (403 step_up_required) with the cap and the push queue untouched.
 *  `withStatements`: further writes committed in the SAME batch (cap OFF's owner Stop), so they land together with the cap change or not at all. */
async function changeCap(
  env: Env, flux: FluxClient, row: HomeRow, next: { plan: string; capMicrocents: number; custom: number; off?: 0 | 1; planDerived?: boolean }, push: boolean, clock: Clock,
  notRaising = false, pinned: { sql: string; binds: unknown[] } | null = null, withStatements: D1PreparedStatement[] = [],
  gate: { hold?: boolean; resume?: boolean } = {}, retried = false,
): Promise<boolean | "refused" | "resume_won"> {
  const now = clock();
  const op = opStmt(env, row.home_id, "cap", now, { json: {} });
  const guard = `cap-${crypto.randomUUID()}`;
  // 8b (2.3, 2.3a): `gate.resume` (a stopped home coming back on) and `gate.hold` (every other ON: an active or never-keyed row) make the cap UPDATE itself refuse a row
  // under a billing hold or in the wrong state; the write guard then aborts the WHOLE batch (cap, cap_version, spending_off, the push, the resume).
  // DISPUTE-FENCE-ACCOUNT, THE CHOKE POINT FOR CAPS (flux-dispute-fence.ts capRaiseFence): EVERY write through here carries the fence inside its
  // UPDATE, so while the owner's account has an open dispute NO write can raise the effective limit (spending switched on, a higher limit, a
  // plan's higher cap, the catch-up); lowering, switching off and re-sending the stored limit pass. A plan change keeps recording the plan: its
  // derived cap is clamped to what is stored while the dispute stands.
  const disputeCap = next.planDerived
    ? { sql: `CASE WHEN cap_custom=1 THEN cap_microcents WHEN ${homeDisputeOpenSql("?")} THEN MIN(cap_microcents,?) ELSE ? END`,
      binds: [row.home_id, next.capMicrocents, next.capMicrocents] }
    : { sql: "?", binds: [next.capMicrocents] };
  const fence = capRaiseFence(row.home_id, disputeCap, { sql: "COALESCE(?,spending_off)", binds: [next.off ?? null] });
  // A plan-derived cap is clamped INSIDE the write (never refused by the fence), so it needs no guard: a key row that vanished (a home deleted in flight) is a
  // no-op for a plan change, as before the dispute fence (Opus Low 3). Every other write is guarded so a refusal is detected and answered.
  const guarded = !next.planDerived || notRaising || pinned !== null || gate.hold === true || gate.resume === true;
  // Astra JOURNEY-A-3 #9: a plan-derived cap (a plan change) is chosen IN the write, against the customization stored at that moment: a
  // limit the owner set (or kept while switching spending off) after the plan change read its row is never overwritten nor un-customized.
  const capSql = next.planDerived ? `cap_microcents=${disputeCap.sql},cap_custom=cap_custom` : "cap_microcents=?,cap_custom=?";
  const capBinds = next.planDerived ? disputeCap.binds : [next.capMicrocents, next.custom];
  try {
    await env.DB.batch([
      // (A sign-in-only write never switches spending back on: it requires spending to be on already, and a write that sets a limit while
      // spending is off is a raise from zero, only after the step-up. `off` unset leaves the switch as it is, e.g. a plan change.)
      // Astra JOURNEY-A-4 #6: when spending was (first) switched off, kept while it stays off and cleared when it is switched back on: the
      // status's pending duration and the sweep's escalation of an unconfirmed switch-off are measured from it.
      env.DB.prepare(`UPDATE flux_home_keys SET plan=?,${capSql},spending_off=COALESCE(?,spending_off),
        spending_off_at=CASE WHEN ?=1 THEN CASE WHEN spending_off=1 THEN COALESCE(spending_off_at,?) ELSE ? END WHEN ?=0 THEN NULL ELSE spending_off_at END,
        cap_version=cap_version+1,updated_at=?
        WHERE home_id=?${notRaising ? " AND cap_microcents>=? AND spending_off=0 AND state NOT IN ('stopped','stopping')" : ""}${
          gate.resume ? " AND billing_hold=0 AND state IN ('stopped','stopping')" : gate.hold ? " AND billing_hold=0 AND state IN ('none','active')" : ""}${pinned ? ` AND ${pinned.sql}` : ""} AND ${fence.sql}`)
        .bind(next.plan, ...capBinds, next.off ?? null, next.off ?? null, now, now, next.off ?? null, now, row.home_id,
          ...(notRaising ? [next.capMicrocents] : []), ...(pinned?.binds ?? []), ...fence.binds),
      ...(guarded ? [env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guard)] : []),
      ...(push ? [op.stmt] : []),
      ...withStatements,
      ...(guarded ? [env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guard)] : []),
    ]);
  } catch (error) {
    if (!guarded) throw error;
    const fenced = gate.hold === true || gate.resume === true;
    const after = fenced ? await env.DB.prepare("SELECT billing_hold,state,lifecycle_version,resume_lv FROM flux_home_keys WHERE home_id=?").bind(row.home_id)
      .first<{ billing_hold: number; state: string; lifecycle_version: number; resume_lv: number | null }>() : null;
    // A hold is tested first: it never becomes a stepped-up retry or a refusal.
    if (after?.billing_hold === 1) throw new HTTPError(409, "billing_hold");
    // The approval's target moved first: the approval is superseded (never absorbed into a sign-in-only answer).
    if (pinned && (await env.DB.prepare(`SELECT ${pinned.sql} AS holds`).bind(...pinned.binds).first<{ holds: number }>())?.holds !== 1) {
      throw new HTTPError(403, "step_up_required");
    }
    // A concurrent ON already resumed this home (active at the lifecycle its resume wrote): this press changes nothing.
    if (gate.resume && after?.state === "active" && after.resume_lv === after.lifecycle_version) return "resume_won";
    if (gate.hold && after && (after.state === "stopped" || after.state === "stopping")) return "refused"; // a Stop landed: the caller re-reads and takes the resume branch
    // DISPUTE-FENCE-ACCOUNT (Opus Low 2): the 409 is only for a write the fence can have refused: the key row exists and the write RAISES the effective limit.
    // Any other failure keeps its own error (never mislabelled as a dispute). A dispute that was cleared between the refusal and this read does not
    // fail the owner (a 500) nor the sweep: the write is simply made again, once.
    // Release 8b merge: only a write-guard failure (the CHECK on cloud_write_guards) is read as a refusal by the fence; any other failure (a worker that fell over
    // mid-write) keeps its own error and is never retried or labelled a dispute.
    const guardRefused = /CHECK constraint failed/i.test(error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error));
    if (!notRaising && guardRefused) {
      const cur = await env.DB.prepare("SELECT cap_microcents AS c,spending_off AS off FROM flux_home_keys WHERE home_id=?").bind(row.home_id).first<{ c: number; off: number }>();
      const raises = cur !== null && !next.planDerived && (next.off ?? cur.off) !== 1 && next.capMicrocents > (cur.off === 1 ? 0 : cur.c);
      if (raises) {
        if (await homeDisputeOpen(env, row.home_id)) throw new HTTPError(409, "flux_email_unverified"); // nothing written
        if (!retried) return changeCap(env, flux, row, next, push, clock, notRaising, pinned, withStatements, gate, true);
      }
    }
    if (notRaising) {
      const current = await env.DB.prepare("SELECT cap_microcents AS c,spending_off AS off,state FROM flux_home_keys WHERE home_id=?").bind(row.home_id).first<{ c: number; off: number; state: string }>();
      // A Stop that committed after the row was read also fails the write (a stopped home is a resume, not a lowering): refused, not a 500.
      if (current && (current.c < next.capMicrocents || current.off === 1 || current.state === "stopped" || current.state === "stopping")) return "refused";
    }
    throw error;
  }
  if (!push) return true;
  await drainHome(env, flux, row.home_id, clock);
  const outcome = await opOutcome(env, op.opId);
  return outcome === "done" || outcome === "superseded";
}

/** The lowest monthly limit the router accepts, in dollars. */
const MIN_CAP_USD = ROUTER_MIN_CAP_MICROCENTS / 1_000_000;

/** Journey A8: true when this monthly spend limit cannot raise spending (no higher than the limit stored now), so it needs sign-in only.
 *  A home with no stored limit yet has nothing to compare with: not exempt. */
export async function fluxCapLowers(env: Env, homeId: string, capUsd: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT cap_microcents AS c,spending_off AS off,state FROM flux_home_keys WHERE home_id=?").bind(homeId).first<{ c: number; off: number; state: string }>();
  if (row === null || !Number.isFinite(capUsd)) return false;
  if (capUsd === 0) return true; // switching spending off never raises it
  if (capUsd < MIN_CAP_USD) return false; // below the floor is refused by the write, never a quiet "lowering"
  // switching it back on (from off) is a raise, and so is a write that would resume a stopped home (it mints a key: same step-up as /subkey)
  return row.off === 0 && row.state !== "stopped" && row.state !== "stopping" && usdToMicrocents(capUsd) <= row.c;
}
/** The worker gate's question for POST /v1/homes/{id}/flux/cap and, while Flux is off, /flux/stop (index.ts), from the buffered body: is
 *  this change exempt from step-up? Only a limit no higher than today's, on the caller's own home; anything it cannot read or resolve is "no"
 *  (the route-level step-up applies). setCap enforces the same rule again in the write itself. */
export async function fluxCapStepUpExempt(request: Request, env: Env, auth: ControlPlaneAuth, dependencies: FluxDependencies = {}): Promise<boolean> {
  try {
    const path = new URL(request.url).pathname;
    const m = HOME_ROUTE.exec(path);
    if (!m) return false;
    // PRODFLUX r4 C: switched on with the real hooks, the owner's Stop and cap OFF always journal a real Stop (sent now, or once the secrets
    // are back), so neither is ever step-up exempt, serving or not.
    if (fluxSwitchedOnLive(env, dependencies) && request.method === "POST" && (m[2] === "/stop" || (m[2] === "/cap" && await capOffBody(request)))) return false;
    if (!fluxServing(env)) {
      // PRODFLUX (MurageMain): only the grants token missing: the owner's Stop really revokes (fluxRevokeOnly), so it is stepped up as when on.
      if (fluxRevokeOnlyConfigured(env) && fluxRevocationRoute(request.method, path)) return false;
      // Flux off (Astra JOURNEY-A-10 #4, JOURNEY-A-11 #1): both spending-Off routes (cap and stop) only say Flux is unavailable and change
      // nothing, so the owner's sign-in is enough. Not signed in, or not the owner: "no" (the gate's own refusal stands).
      if (!fluxOffStubRoute(request.method, path)) return false;
      const owner = await (dependencies.currentAccount ?? defaultAccount)(request, auth);
      return !!owner && await (dependencies.ownerOf ?? defaultOwnerOf)(env, m[1]) === owner.id;
    }
    if (request.method !== "POST" || m[2] !== "/cap") return false;
    const parsed = capSchema.safeParse(await request.clone().json());
    if (!parsed.success) return false;
    const want = capRequest(parsed.data);
    if (want === "default") return false; // switching on (or back to the default) is treated as a raise here; setCap decides exactly
    const account = await (dependencies.currentAccount ?? defaultAccount)(request, auth);
    if (!account || await (dependencies.ownerOf ?? defaultOwnerOf)(env, m[1]) !== account.id) return false;
    return await fluxCapLowers(env, m[1], want === "off" ? 0 : want);
  } catch { return false; }
}

/** PRODFLUX r4 C: the buffered body of POST /cap is a VALID switch-off ({enabled:false} or {capUsd:0}). Anything unreadable is "no". */
export async function capOffBody(request: Request): Promise<boolean> {
  try {
    const parsed = capSchema.safeParse(await request.clone().json());
    return parsed.success && capRequest(parsed.data) === "off";
  } catch { return false; }
}
/** The step-up prompt for spending off (approved copy): shown with its step_up_required refusal, at the worker gate and at the write. */
export const SPENDING_OFF_STEP_UP_WORDS = "To turn spending off, we'll email you a code. This also pauses your bots' Flux key until you turn spending back on.";

/** The monthly spend limit. Lowering it (or leaving it) needs sign-in only; raising it needs the fresh second factor (journey A8). The rule
 *  is checked here, after the worker gate, against the limit stored at the moment of the write: a sign-in-only change is written only if it
 *  does not raise the stored limit (one atomic write), so a concurrent lowering can never make it an unstepped raise. */
async function setCap(env: Env, config: FluxConfig, flux: FluxClient, ownerId: string, homeId: string, request: CapBody, clock: Clock,
  steppedUp: () => Promise<boolean>, live = false, siteCompat = false): Promise<Response> {
  const now = clock();
  const want = capRequest(request);
  // PRODFLUX r4 C: switched on with the real hooks, OFF journals a real Stop: the step-up is checked again here, at the write.
  if (want === "off" && live && !await steppedUp()) throw new HTTPError(403, "step_up_required", { message: SPENDING_OFF_STEP_UP_WORDS });
  if (typeof want === "number" && want < Math.max(config.minCapUsd, MIN_CAP_USD) && want > 0) {
    throw new HTTPError(400, "cap_too_low", { message: `The lowest monthly limit is $${MIN_CAP_USD}. Enter $${MIN_CAP_USD} or more, or switch spending off.` });
  }
  if (typeof want === "number" && (!Number.isFinite(want) || want < config.minCapUsd || want > config.maxCapUsd)) throw new HTTPError(400, "invalid_cap");
  const row = await ensureHomeRow(env, config, homeId, now);
  // Under an emailed approval every write applies only to the exact target it was frozen at (pinnedTargetHolds; null otherwise).
  const pinned = pinnedTargetHolds(env);
  if (want === "off") {
    // Off keeps the owner's limit stored (for switching back on) and makes Flux enforce zero. It journals a real Stop of the key, so with
    // Flux switched on live it needs the step-up (checked above, and at the worker gate). Cap 0 is never sent to the router.
    // Astra r3 HIGH: spending_off, the lifecycle change ('stopping') and the owner's Stop intent commit in ONE batch (changeCap's, with its
    // approval guard): a failed write throws (5xx) and nothing is committed, so an OFF is never recorded without its Stop.
    const stop = ownerStopStatements(env, homeId, now);
    await changeCap(env, flux, row, { plan: row.plan, capMicrocents: row.cap_microcents, custom: 1, off: 1 }, false, clock, false, pinned, stop.stmts);
    // The Stop is journaled. Sending it now may still not finish (router down, home busy, a secret missing): that is pending, and the
    // sweep (full or revoke-only) sends it. A failure here is logged, never answered as a failed OFF.
    let outcome: "done" | "superseded" | "failed" | "pending" = "pending";
    try {
      await drainHome(env, flux, homeId, clock);
      outcome = await opOutcome(env, stop.opId);
    } catch (error) {
      console.warn(JSON.stringify({ message: "flux cap off: Stop journaled, sending it is left to the sweep", error: error instanceof Error ? error.name : "unknown" }));
    }
    // runOps records a failed send on the op (attempts, last_error) without throwing: log it too, so a failed send is never silent.
    if (outcome === "failed") console.error(JSON.stringify({ message: "flux cap off: sending the Stop failed, the sweep sends it", homeId }));
    return json(outcome === "done" ? { capUsd: 0, enabled: false } : { capUsd: 0, enabled: false, pending: true });
  }
  const capUsd = want === "default" ? defaultCapUsd(config, row.plan) : want;
  // Anything above the stored limit, and switching spending back on from off, needs the step-up.
  const next = { plan: row.plan, capMicrocents: usdToMicrocents(capUsd), custom: 1, off: 0 as const };
  // 8b (SPENDING-RESUME-VIA-POLLER 2.3, 2.3a). ON never mints a key here (the owner mint is closed): a stopped home is resumed in ONE hold-guarded
  // batch and the home's own poller takes its key; every other ON is hold-fenced. A second pass re-reads the row once (a Stop or a hold that landed).
  for (let pass = 0; pass < 2; pass++) {
    const current = pass === 0 ? row : await ensureHomeRow(env, config, homeId, clock());
    if (current.billing_hold === 1) throw new HTTPError(409, "billing_hold");
    if (current.state === "stopped" || current.state === "stopping") {
      if (await accountDisputeOpen(env, ownerId)) throw new HTTPError(409, "flux_email_unverified"); // DISPUTE-FENCE-ACCOUNT: no step-up prompt for a refused raise
      if (!await steppedUp()) throw new HTTPError(403, "step_up_required");
      if (!(fluxResumeViaPoller(env) && siteCompat)) {
        throw new HTTPError(410, "resume_unavailable", { message: "Spending cannot come back on just now. Please try again in a few minutes." });
      }
      const resumed = await changeCap(env, flux, current, next, false, clock, false, pinned, resumeStatements(env, homeId, clock()), { resume: true });
      // "resume_won": a concurrent ON resumed this home first and nothing more was written. 8b fix r3 (Grok Low): the answer carries the cap
      // stored by that resume, read after the batch, never this request's.
      const stored = resumed === "resume_won"
        ? await env.DB.prepare("SELECT cap_microcents AS c FROM flux_home_keys WHERE home_id=?").bind(homeId).first<{ c: number }>() : null;
      return json({ capUsd: stored ? microcentsToUsd(stored.c) : capUsd, enabled: true, resume: "pending" });
    }
    // 8b fix r1 (Astra M4): EVERY ON write is hold-fenced, a never-keyed row (state none) included: a billing Stop landing after this read makes the
    // cap UPDATE change 0 rows and the guard aborts the whole batch (cap, cap_version, the cap op), answered 409 billing_hold.
    const fence = { hold: true };
    let synced: boolean | "refused" | "resume_won" = current.spending_off === 0 && next.capMicrocents <= current.cap_microcents
      ? await changeCap(env, flux, current, next, true, clock, true, pinned, [], fence) : "refused";
    if (synced === "refused") {
      if (await accountDisputeOpen(env, ownerId)) throw new HTTPError(409, "flux_email_unverified"); // DISPUTE-FENCE-ACCOUNT: no step-up prompt for a refused raise
      if (!await steppedUp()) throw new HTTPError(403, "step_up_required");
      // The stepped-up retry uses the row as it stands now, never the stale one.
      const fresh = await ensureHomeRow(env, config, homeId, clock());
      if (fresh.billing_hold === 1) throw new HTTPError(409, "billing_hold");
      if (fresh.state === "stopped" || fresh.state === "stopping") {
        if (pass === 0) continue; // a Stop landed meanwhile: take the resume branch once
        throw new HTTPError(409, "stale_lifecycle");
      }
      synced = await changeCap(env, flux, fresh, next, true, clock, false, pinned, [], { hold: true });
      if (synced === "refused") { if (pass === 0) continue; throw new HTTPError(409, "stale_lifecycle"); }
    }
    return json({ capUsd, enabled: true, ...(synced === true ? {} : { pending: true }) });
  }
  throw new HTTPError(409, "stale_lifecycle");
}

/** 8b (2.3): the resume itself, appended to the cap UPDATE in the same batch. Everything is hold-guarded: a row changed by nothing (a hold landed, a
 *  concurrent ON won) aborts the whole batch through the write guard. A queued Stop (`stopping`) stays in the journal and is sent first. */
function resumeStatements(env: Env, homeId: string, now: number): D1PreparedStatement[] {
  const g2 = `resume-${crypto.randomUUID()}`;
  return [
    env.DB.prepare(`UPDATE flux_home_keys SET state='active',lifecycle_version=lifecycle_version+1,key_expires_at=NULL,
        pending_op_id=NULL,pending_generation=NULL,pending_expires_at=NULL,pending_lifecycle_version=NULL,
        resume_lv=lifecycle_version+1,resume_from_generation=generation,resume_at=?,updated_at=?
      WHERE home_id=? AND state IN ('stopped','stopping') AND billing_hold=0 AND spending_off=0`).bind(now, now, homeId),
    env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(g2),
    env.DB.prepare("DELETE FROM flux_first_key_retry WHERE home_id=? AND hold IS NULL").bind(homeId), // typed holds stay
    env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(g2),
  ];
}

/** Astra JOURNEY-A-4 #6: a switch-off the router has not confirmed for this long is escalated: ops alert (sweepFlux) and a support action. */
export const SPENDING_OFF_ESCALATE_MS = 60 * 60_000;
export const SPENDING_OFF_ALERT = "flux.spending_off_unconfirmed";
const SPENDING_OFF_SUPPORT_TEXT = "If you need Flux spending stopped right now, contact support and we will stop it for you.";
/** The router's state words are not part of the answer: ok | capped | unfunded | paused | none | unavailable. */
function publicFluxState(state: string | undefined): "ok" | "capped" | "unfunded" | "paused" | "none" {
  if (state === undefined) return "none";
  return state === "ok" || state === "capped" || state === "unfunded" ? state : "paused";
}

/** What a customer reads when spending is off: it is off, and how to turn it on. No key, router or error words. */
export const SPENDING_OFF_WORDS = `Spending is switched off on this home. To turn it on, set a monthly limit of $${MIN_CAP_USD} or more.`;

function describe(state: string, flux: FluxHomeStatus | null, capUsd: number, offPending = false, offOverdue = false): { paused: boolean; message: string | null } {
  const signIns = "Your Claude and ChatGPT sign-ins keep working.";
  // Astra JOURNEY-A-3 #8: requested, not yet confirmed: never "switched off" while spending can still happen.
  if (offPending) {
    // Astra JOURNEY-A-4 #6: still unconfirmed after SPENDING_OFF_ESCALATE_MS: our team is alerted, and the customer is given a way to act now.
    const tail = offOverdue ? ` We have been trying to confirm this for over an hour and our team has been alerted. ${SPENDING_OFF_SUPPORT_TEXT}` : "";
    return { paused: false, message: `Spending is switching off on this home (pending). Until that is confirmed, the current $${capUsd.toFixed(2)} monthly limit still applies.${tail} ${signIns}` };
  }
  if (capUsd === 0) return { paused: true, message: `${SPENDING_OFF_WORDS} ${signIns}` };
  if (state === "none") return { paused: true, message: "Flux is not set up on this home yet. " + signIns };
  if (state === "stopped" || state === "stopping") return { paused: true, message: `Flux use on this home is stopped. ${signIns}` };
  if (flux?.state === "unfunded") return { paused: true, message: `Your credits are used up or not added yet. Add credits to keep going. ${signIns}` };
  if (flux === null) return { paused: false, message: null };
  if (flux.state === "capped") {
    return { paused: true, message: `This home has used its $${capUsd.toFixed(2)} monthly Flux limit. Flux models are paused until it resets or you raise the limit. ${signIns}` };
  }
  // Every other refusal state the router reports (stopped, revoked, ip_refused, unavailable,
  // state_lost, invalid, unfunded, fenced, ...) pauses the home. Only "ok" does not.
  if (flux.state !== "ok") {
    return { paused: true, message: `Spending is paused on this home right now. It resumes by itself when the cause clears. ${signIns}` };
  }
  if (flux.accountSpendableMicrocents !== null && flux.accountSpendableMicrocents !== undefined
    && flux.accountSpendableMicrocents <= 0 && flux.accountAutoTopUpEnabled === false) {
    return { paused: false, message: "Flux credit is low and automatic top-up is off. Turn on automatic top-up in your Flux account so Flux models never stop." };
  }
  return { paused: false, message: null };
}

/** Astra JOURNEY-A-5 #7: see homeStatus. Returns whether this read requeued the switch-off. One batch: the guard (cloud_write_guards'
 *  CHECK ok=1) aborts all of it unless the home row moved, i.e. spending is still off, nobody requeued it since this read, and no cap op is
 *  queued or running. */
async function recordSpendingDrift(env: Env, flux: FluxClient, homeId: string, row: HomeRow, observedCap: number, now: number): Promise<boolean> {
  const guard = crypto.randomUUID();
  const op = stopOpStmt(env, homeId, now, "stop");
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE flux_home_keys SET spending_off_at=?,updated_at=? WHERE home_id=? AND spending_off=1
        AND spending_off_at IS ? AND NOT EXISTS (SELECT 1 FROM flux_home_ops o WHERE o.home_id=? AND o.kind IN ('cap','stop') AND o.state IN ('queued','running'))`)
        .bind(now, now, homeId, row.spending_off_at, homeId),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guard),
      op.stmt,
      env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=? WHERE home_id=? AND kind='${SPENDING_OFF_ALERT}' AND resolved_at IS NULL`).bind(now, homeId),
      env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
        VALUES (?,?,'${SPENDING_OFF_ALERT}','high',json_object('requestedAt',?,'drift',1,'observedCapMicrocents',?,'previousSince',?),?) ON CONFLICT DO NOTHING`)
        .bind(`alert:spending_off:${homeId}:${now}`, homeId, now, observedCap, row.spending_off_at, now),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guard),
    ]);
  } catch { return false; } // raced (requeued or switched on meanwhile), or a write failed: nothing was written
  try { await drainHome(env, flux, homeId, () => now); } catch { /* queued: the sweep retries it */ }
  return true;
}

async function homeStatus(env: Env, config: FluxConfig, flux: FluxClient, homeId: string, now: number): Promise<Response> {
  let row = await ensureHomeRow(env, config, homeId, now);
  let live: FluxHomeStatus | null = null;
  let fluxReachable = true;
  if (row.state !== "none") {
    try { live = await flux.status(homeId); } catch { fluxReachable = false; }
  }
  // Astra JOURNEY-A-3 #8: the stored off is what the owner REQUESTED; it is switched off only once the router confirms a zero limit. Until
  // then the status shows the live cap (or, Flux unreachable, the last limit Flux was given) and says the switch-off is pending.
  const off = row.spending_off === 1;
  const routerCap = live?.capMicrocents;
  const routerLive = live?.state === "ok" || live?.state === "capped"; // Stage A: an off home must be revoked at the router, not at cap 0
  // Astra JOURNEY-A-5 #7: spending is off here but the router reports a POSITIVE limit and no switch-off is queued any more (it was
  // confirmed, or its op finished): enforcement drift. Zero is enforced again (a new cap op, at a new cap version so the router never
  // treats it as stale), the switch-off is pending again from now (spending_off_at, so the status says so and its escalation is measured
  // from the drift), and a NEW incident is raised at once (its id carries the new spending_off_at: a resolved earlier one is never in the
  // way), resolved by the sweep only once that op lands. All in one batch, guarded so two concurrent reads requeue once.
  if (off && routerLive && row.state === "stopped") {
    try { if (await recordSpendingDrift(env, flux, homeId, row, routerCap ?? 0, now)) row = await ensureHomeRow(env, config, homeId, now); }
    catch { /* the next status read (or the sweep's retries) tries again */ }
  }
  const offConfirmed = off && row.state === "stopped" && fluxReachable && !routerLive;
  const offPending = off && !offConfirmed;
  const capUsd = offConfirmed ? 0 : microcentsToUsd(routerCap ?? row.cap_microcents);
  // Astra JOURNEY-A-4 #6: how long the switch-off has waited for the router, and, past SPENDING_OFF_ESCALATE_MS, what the customer can do.
  const pendingSince = offPending ? row.spending_off_at : null;
  const pendingForMs = pendingSince === null ? null : Math.max(0, now - pendingSince);
  const offOverdue = pendingForMs !== null && pendingForMs >= SPENDING_OFF_ESCALATE_MS;
  const verdict = describe(row.state, live, capUsd, offPending, offOverdue);
  // 8b (2.6): what the owner's screen may say about spending, from the row and the router status read above, plus ONE point read for the home's heartbeat.
  const beat = await env.DB.prepare("SELECT heartbeat_at FROM cloud_homes WHERE id=?").bind(homeId).first<{ heartbeat_at: number | null }>();
  const homeOnline = beat === null ? null : beat.heartbeat_at !== null && beat.heartbeat_at + 2 * LEASE_FRESH_MS > now;
  const stopConfirmed = row.state === "stopped" && fluxReachable && !routerLive;
  const isOn = row.state === "active" && row.acked_lifecycle_version === row.lifecycle_version && row.acked_generation === row.generation
    && row.gen_floor === row.generation && row.key_expires_at !== null && row.key_expires_at > now;
  const delivery = row.billing_hold === 1 ? "held" : off ? "off" : isOn ? "on"
    : row.state === "stopped" || row.state === "stopping" ? (stopConfirmed ? "stopped" : "stopping") : "pending";
  return json({
    state: row.state,
    flux: fluxReachable ? publicFluxState(live?.state) : "unavailable",
    plan: row.plan,
    includedCreditsUsd: config.plans[row.plan]?.creditsUsd ?? null,
    capUsd,
    spendingEnabled: !off,
    spendingOff: { requested: off, confirmed: offConfirmed, pending: offPending, pendingSince, pendingForMs,
      supportAction: offOverdue ? { action: "contact_support", message: SPENDING_OFF_SUPPORT_TEXT } : null },
    defaultCapUsd: defaultCapUsd(config, row.plan),
    capIsCustom: row.cap_custom === 1,
    spentUsd: live?.spentMicrocents === undefined ? null : microcentsToUsd(live.spentMicrocents),
    resetsAt: live?.resetsAt ?? null,
    keyExpiresAt: row.key_expires_at,
    spendingDelivery: { state: delivery, stopConfirmed, homeOnline,
      pendingSince: delivery === "pending" ? (row.resume_lv !== null && row.resume_lv === row.lifecycle_version ? row.resume_at : row.updated_at) : null },
    accountSpendableUsd: live?.accountSpendableMicrocents == null ? null : microcentsToUsd(live.accountSpendableMicrocents),
    autoTopUpOn: live?.accountAutoTopUpEnabled ?? null,
    paused: fluxReachable ? verdict.paused : true,
    message: fluxReachable ? verdict.message : "Flux cannot be reached right now, so Flux models are paused. They resume by themselves. Your Claude and ChatGPT sign-ins keep working.",
  });
}

// ── Monthly included credits (called by Billing) ─────────────────────────────

const PLAN_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const grantSchema = z.strictObject({
  homeId: z.string().regex(HOME_ID),
  plan: z.string().regex(PLAN_ID),
  invoiceId: z.string().regex(/^[A-Za-z0-9_:-]{4,128}$/),
  /** The paid subscription period, epoch milliseconds. */
  periodStart: z.number().int().positive(),
  periodEnd: z.number().int().positive(),
  kind: z.enum(["period", "upgrade_delta"]).default("period"),
  /** Required for an upgrade_delta: the plan being upgraded from. */
  previousPlan: z.string().regex(PLAN_ID).optional(),
}).refine((input) => input.periodEnd > input.periodStart, { path: ["periodEnd"] });
export type GrantInput = z.input<typeof grantSchema>;
type GrantStatus = "pending" | "done" | "failed" | "cancelled" | "reversed" | "expired";

/** Credits last until one month after their period ends (one month of carryover); then the unspent remainder expires. */
function addMonthUtc(ms: number): number {
  // Lane H1: the router's own rule (flux-grants.ts addOneMonthUtc: the day clamped to the target month), so a grant's expiry is the one the
  // router recomputes.
  return addOneMonthUtc(ms);
}

async function grantStatus(env: Env, grantId: string): Promise<GrantStatus> {
  const row = await env.DB.prepare("SELECT status FROM flux_grants WHERE grant_id=?").bind(grantId).first<{ status: GrantStatus }>();
  return row?.status ?? "failed";
}

/** H3 (Astra H2 #5): the allocation guard of a B4 dispatch's request: its local dispatch is still open and unexpired (binds: the token). */
function dispatchLive(token: string): { sql: string; binds: unknown[] } {
  return { sql: `EXISTS (SELECT 1 FROM flux_grant_dispatches WHERE dispatch_id=? AND state='open' AND expires_at>${DB_NOW_MS})`, binds: [token] };
}
/** Lane H1 (R11): the Flux grant id and fenced revision a dispatch's request carries, recorded BEFORE it leaves (only while it is open).
 *  H3 (Astra H2 #5): a recording that changes nothing (the dispatch was superseded or expired after the allocation) REFUSES the send:
 *  FluxNotDispatched, so the revision is abandoned as never sent and nothing leaves. */
export async function recordRemoteRevision(env: Env, token: string, wire: string, revision: number): Promise<void> {
  const r = await env.DB.prepare(`UPDATE flux_grant_dispatches SET wire_grant_id=?,remote_revision=? WHERE dispatch_id=? AND state='open' AND expires_at>${DB_NOW_MS}`)
    .bind(wire, revision, token).run();
  if (r.meta.changes !== 1) throw new FluxNotDispatched("dispatch_superseded");
}
/** Deliver one pending grant (the ledger's DELIVER, b4-flux-ledger.ts L4/L6). The delivery is CLAIMED as a dispatch before any network call:
 *  its token is the delivery id the router sees, its claim time is the database's at the claim, and the claim re-checks in the same batch the
 *  outbox (still pending, its frozen recipient still the owner's unfenced link, no billing hold unless it is a re-delivery), the account
 *  refreshed from the payment's records (nothing returned: D = A; nothing but this grant id can be at the router) and no OPEN dispute on its
 *  payment. A Stop that lands after the claim does not undo it: the credit the call creates is the customer's unless money was returned,
 *  which the ledger then removes (a full return) or alerts (a partial one). The completion applies only while the token owns the claim. */
async function sendGrant(env: Env, flux: FluxClient, grantId: string, clock: Clock, live: boolean): Promise<GrantStatus> {
  const now = clock();
  const row = await env.DB.prepare("SELECT * FROM flux_grants WHERE grant_id=?").bind(grantId).first<{
    grant_id: string; entitlement_key: string; home_id: string; recipient_flux_account_id: string | null; plan: string;
    amount_microcents: number; period_start: number; period_end: number; expires_at: number; status: GrantStatus; attempts: number;
    last_error: string | null; invoice_id: string | null; kind: string;
  }>();
  if (!row) return "failed";
  if (row.status !== "pending") return row.status;
  // THE FLUX-OFF GATE (fluxOn): nothing is claimed and nothing is sent; the grant stays pending exactly as it is (journal only).
  if (!live) {
    if (fluxRoutesEnabled(env)) {
      try { await fluxCredentialsAlert(env, "sendGrant", now); } catch { /* advisory: the grant stays pending, nothing counted */ }
      await fluxPendingCapabilityAlert(env, row.home_id, now, { call: "grant" });
    }
    return "pending";
  }
  if (row.expires_at <= now) { // Undelivered past its original expiry: never delivered (its value is gone at Flux too: R6).
    // Astra INTEGRATED-11 P2: an expired grant whose dispatch is still open cannot expire yet; it is STAMPED anyway (scheduling only, never
    // ownership), so it waits its retry interval and never monopolizes the delivery page.
    await env.DB.batch([
      env.DB.prepare(`UPDATE flux_grants SET status='expired' WHERE grant_id=? AND status='pending'
        AND NOT EXISTS (SELECT 1 FROM flux_grant_dispatches d WHERE d.grant_id=flux_grants.grant_id AND d.state='open')`).bind(grantId),
      env.DB.prepare("UPDATE flux_grants SET last_attempt_at=? WHERE grant_id=? AND status='pending'").bind(now, grantId),
    ]);
    return grantStatus(env, grantId);
  }
  const owner = await defaultOwnerOf(env, row.home_id);
  // Lane H1, item 1: an owner with NO link row gets its Flux account ensured and the link written (flux-link.ts) before its first grant.
  // A refusal (4xx) is alerted and the grant stays held (unbound); a 5xx or timeout leaves it held until its retry interval.
  if (owner !== null && flux.ensureAccount && (await linkRowOf(env, owner)) === null) {
    await ensureOwnerAccount(env, owner, row.home_id, (a) => flux.ensureAccount!(a), now);
  }
  const current = owner === null ? null : await linkOf(env, owner);
  let recipient = row.recipient_flux_account_id;
  if (recipient === null) {
    if (current === null) {
      // Paid before linking: held, not lost. Astra INTEGRATED-10 P2: stamped like every examined grant, so unbound holds wait their retry
      // interval and never monopolize the delivery page; the ledger pages the debt once it is overdue (blockedBy recipient_unbound).
      await env.DB.prepare("UPDATE flux_grants SET last_attempt_at=? WHERE grant_id=? AND status='pending' AND recipient_flux_account_id IS NULL")
        .bind(now, grantId).run();
      return "pending";
    }
    const bound = await env.DB.prepare("UPDATE flux_grants SET recipient_flux_account_id=? WHERE grant_id=? AND status='pending' AND recipient_flux_account_id IS NULL")
      .bind(current, grantId).run();
    if (bound.meta.changes !== 1) return sendGrant(env, flux, grantId, clock, live);
    recipient = current;
  } else if (current !== recipient) {
    // Unlinked, or linked to a different Flux account since the grant was made: HELD for its frozen recipient (no attempt
    // burned, nothing cancelled or reversed). A different account never receives it; that case waits for an operator.
    const reason: GrantHoldReason = current === null ? "recipient_unlinked" : "recipient_mismatch";
    await env.DB.batch([
      env.DB.prepare("UPDATE flux_grants SET last_error=?,last_attempt_at=? WHERE grant_id=? AND status='pending' AND claim_id IS NULL")
        .bind(GRANT_HELD + reason, now, grantId),
      ...heldAlertStmts(env, row.home_id, now),
    ]);
    return grantStatus(env, grantId);
  }
  // DISPUTE-FENCE-ACCOUNT (Opus Low 1): an open dispute holds the grant, and says so, so ops does not chase a ghost. No attempt is burned. The
  // claim below and the grant allocation re-check the dispute inside their own statements (this read only names the reason early).
  if (owner !== null && await accountDisputeOpen(env, owner)) {
    await env.DB.batch([
      env.DB.prepare("UPDATE flux_grants SET last_error=?,last_attempt_at=? WHERE grant_id=? AND status='pending' AND claim_id IS NULL")
        .bind(GRANT_HELD + "account_disputed", now, grantId),
      ...heldAlertStmts(env, row.home_id, now),
    ]);
    return grantStatus(env, grantId);
  }
  // PRODFLUX (Astra HIGH 2): BEFORE the claim below (which counts an attempt): a missing grants credential holds the grant as it is, with
  // ONE alert. Nothing is claimed, no attempt is consumed, and the obligation stays pending for the sweep once the secret is put.
  if (fluxCredentialsMissing(env) !== null) {
    try { await fluxCredentialsAlert(env, "sendGrant", now); } catch { /* advisory: the grant stays pending, nothing counted */ }
    await fluxPendingCapabilityAlert(env, row.home_id, now, { call: "grant", reason: "credentials" });
    return "pending";
  }
  const wasHeld = (row.last_error ?? "").startsWith(GRANT_HELD);
  const eligible = `g.status='pending' AND g.recipient_flux_account_id=?
    AND (g.redeliver IS 'due' OR NOT EXISTS (SELECT 1 FROM flux_home_keys h WHERE h.home_id=g.home_id AND h.billing_hold=1))
    AND EXISTS (SELECT 1 FROM flux_links l WHERE l.owner_user_id=? AND l.flux_account_id=? AND l.fenced=0)
    AND a.sized=1 AND a.desired_microcents=a.amount_microcents AND a.router_state IN ('none','maybe') AND NOT ${DISPUTE_OPEN_HOLD}
    AND NOT ${accountDisputeOpenSql("?")}`; // DISPUTE-FENCE-ACCOUNT: an open account-level email-proof dispute holds delivery (the grant stays pending)
  const claim = await claimDispatch(env.DB, { grantId, kind: "deliver", eligible, binds: [recipient, owner, recipient, owner], now: clock(),
    extra: (token) => [env.DB.prepare(`UPDATE flux_grants SET claim_id=?1,claimed_at=(SELECT claimed_at FROM flux_grant_dispatches WHERE dispatch_id=?1),
      attempts=attempts+1,last_attempt_at=?2 WHERE grant_id=?3 AND EXISTS (SELECT 1 FROM flux_grant_dispatches WHERE dispatch_id=?1 AND state='open')`)
      .bind(token, now, grantId)] });
  if (!claim) {
    // Not deliverable now (a billing hold, money returned of its payment, an open dispute, or another dispatch holds it): it stays pending,
    // never cancelled here (a hold set for ANOTHER invoice never reaches this grant), and waits its retry interval so it never crowds others.
    // INTEGRATED-11 P2: stamped whoever holds a dispatch of it (the stamp is scheduling only, independent of dispatch ownership).
    await env.DB.prepare("UPDATE flux_grants SET last_attempt_at=? WHERE grant_id=? AND status='pending'").bind(now, grantId).run();
    return grantStatus(env, grantId);
  }
  const attempts = row.attempts + 1;
  let result: DeliverResult;
  try {
    await flux.grant({
      grantId: row.grant_id, entitlementKey: row.entitlement_key, recipientFluxAccountId: recipient, homeId: row.home_id,
      plan: row.plan, amountMicrocents: row.amount_microcents,
      periodStart: new Date(row.period_start).toISOString(), periodEnd: new Date(row.period_end).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(), deliveryId: claim.token, invoiceId: row.invoice_id, kind: row.kind,
      onRevision: (wire, revision) => recordRemoteRevision(env, claim.token, wire, revision), dispatchToken: claim.token,
    });
    result = { kind: "applied" };
  } catch (error) {
    const code = error instanceof FluxError ? `flux_${error.status}` : "flux_error";
    // R11: a later revision of this grant already applied at Flux (or this revision is held with another body): never retried.
    if (error instanceof FluxStaleRevision) result = { kind: "superseded", code: "stale_revision" };
    else if (error instanceof FluxRevisionMismatch) result = { kind: "superseded", code: "idempotency_mismatch" };
    else if (error instanceof FluxNotDispatched) result = { kind: "refused", code: `not_dispatched:${error.code}`.slice(0, 64) }; // nothing sent
    // Lane H1 (d): the recipient account is not fresh at Flux: held with an alert, no automatic retry.
    else if (error instanceof FluxError && error.status === 409 && error.code === "account_not_fresh") result = { kind: "refused", code: "flux_409_account_not_fresh" };
    else if (error instanceof FluxError && error.status === 409 && error.code === "revoked") result = { kind: "tombstoned" }; // R5
    else if (error instanceof FluxCapabilityPending || (error instanceof FluxError && DEFINITIVE_REFUSALS.has(error.status))) result = { kind: "refused", code }; // R3
    else result = { kind: "ambiguous", code }; // R4/R6
  }
  const owns = "EXISTS (SELECT 1 FROM flux_grant_dispatches WHERE dispatch_id=? AND state='open')";
  const done = clock();
  // DISPUTE-FENCE-ACCOUNT (Astra M1): a dispute that lands between the claim and the grant allocation refuses at the allocation with nothing sent. That is a HOLD,
  // not a failed try: the attempt this claim counted is taken back, the grant stays pending, and it says why. The sweep delivers it after the clear.
  const disputeHold = result.kind === "refused" && result.code === "not_dispatched:account_disputed";
  const grantStmts = disputeHold
    ? [env.DB.prepare(`UPDATE flux_grants SET claim_id=NULL,last_error=?,attempts=MAX(attempts-1,0) WHERE grant_id=? AND status='pending' AND ${owns}`)
        .bind(GRANT_HELD + "account_disputed", grantId, claim.token)]
    : result.kind === "applied"
    ? [env.DB.prepare(`UPDATE flux_grants SET claim_id=NULL,last_error=NULL,status=CASE WHEN status='pending' THEN 'done' ELSE status END,delivered_at=?,redeliver=NULL
        WHERE grant_id=? AND ${owns}`).bind(done, grantId, claim.token)]
    : result.kind === "tombstoned"
      ? [env.DB.prepare(`UPDATE flux_grants SET claim_id=NULL,last_error='flux_revoked',status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,redeliver=NULL
          WHERE grant_id=? AND ${owns}`).bind(grantId, claim.token)]
      // Retry exhaustion stops automatic delivery only: the account keeps its debt and the sweep alerts it (credit.delivery_owed).
      // Lane H1: a superseded delivery (R11) and an account Flux says is not fresh stop it at once: never retried automatically.
      : [env.DB.prepare(`UPDATE flux_grants SET claim_id=NULL,last_error=?,status=CASE WHEN status='pending' AND ?=1 THEN 'failed' ELSE status END
          WHERE grant_id=? AND ${owns}`).bind(result.code, attempts >= GRANT_MAX_ATTEMPTS || result.kind === "superseded"
            || result.code === "flux_409_account_not_fresh" ? 1 : 0, grantId, claim.token)];
  await completeDelivery(env.DB, { grantId, token: claim.token, result, now: done, grantStmts });
  if (disputeHold) {
    await env.DB.batch(heldAlertStmts(env, row.home_id, done));
    return grantStatus(env, grantId);
  }
  if (result.kind === "refused" && result.code === "flux_409_account_not_fresh") {
    await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) VALUES (?,?,'flux.account_not_fresh','high',?,?,?)
      ON CONFLICT DO NOTHING`).bind(`alert:flux_account_not_fresh:${grantId}`, row.home_id, JSON.stringify({ grantId,
        rule: "Flux refused the grant: the recipient account is not fresh. Held, never retried automatically; a person resolves it and re-queues the grant" }),
        done, grantId).run();
  }
  // The 20th try failed and the grant is now 'failed': the customer has paid with no credit and nothing will retry it. ONE page per grant
  // (credit.undelivered), its id fixed by the grant so a repeat never raises another. An account Flux called not fresh has its own alert.
  if ((result.kind === "ambiguous" || result.kind === "refused") && result.code !== "flux_409_account_not_fresh" && attempts >= GRANT_MAX_ATTEMPTS
    && (await grantStatus(env, grantId)) === "failed") {
    await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) VALUES (?,?,'credit.grant_exhausted','high',?,?,?)
      ON CONFLICT DO NOTHING`).bind(`alert:grant_exhausted:${grantId}`, row.home_id, JSON.stringify({ grantId, attempts, lastError: result.code,
        rule: "The grant's automatic delivery tries ran out: the customer has paid and has no credit. Deliver it by hand or refund the payment" }), done, grantId).run();
  }
  if (wasHeld) await syncHeldAlert(env, row.home_id, done);
  return grantStatus(env, grantId);
}

/** After a home's FIRST key: its pending grants (the plan grant a paid customer is waiting for) are delivered now rather than at the next sweep.
 *  Each is isolated: sendGrant's own refusals stay with the grant, and one grant failing never stops the next or reaches the caller. */
async function grantPendingNow(env: Env, flux: FluxClient, homeId: string, clock: Clock, live: boolean): Promise<void> {
  const pending = await env.DB.prepare("SELECT grant_id FROM flux_grants WHERE home_id=? AND status='pending' ORDER BY created_at LIMIT 5")
    .bind(homeId).all<{ grant_id: string }>();
  for (const { grant_id } of pending.results) {
    try { await sendGrant(env, flux, grant_id, clock, live); } catch { /* the sweep retries it */ }
  }
}

/** The ledger's REVOKE of one grant (b4-flux-ledger.ts L6): only when its payment was FULLY returned (D = 0, from the refunds and lost
 *  disputes as they stand at the claim) and something of it may be at the router; never while an open dispute holds the payment. Claimed
 *  before the call; its answer settles it only while the token owns the claim (R2: revoked/tombstoned). Anything else stays 'revoking' and
 *  is retried; MAX_REVOKES unconfirmed attempts make it an alerted obligation (never discharged). */
async function sendRevoke(env: Env, flux: FluxClient, grantId: string, clock: Clock, live: boolean): Promise<void> {
  if (!live) return; // THE FLUX-OFF GATE: no revoke is ever claimed or sent.
  const claim = await claimDispatch(env.DB, { grantId, kind: "revoke", eligible: `${REVOKE_AUTO} AND NOT ${DISPUTE_OPEN_HOLD}`, binds: [], now: clock() });
  if (!claim) return;
  const g = await env.DB.prepare("SELECT invoice_id,kind,home_id FROM flux_grants WHERE grant_id=?").bind(grantId)
    .first<{ invoice_id: string | null; kind: string; home_id: string }>();
  let result: RevokeResult;
  try {
    result = { kind: "applied", outcome: await flux.revokeGrant(grantId, "returned_money", g ? { invoiceId: g.invoice_id, kind: g.kind, homeId: g.home_id,
      onRevision: (wire, revision) => recordRemoteRevision(env, claim.token, wire, revision), dispatchToken: claim.token } : undefined) };
  } catch (error) {
    // R11: superseded (a later revision applied, or this one is held with another body): recorded, never retried. Nothing sent: refused.
    result = error instanceof FluxStaleRevision ? { kind: "superseded", code: "stale_revision" }
      : error instanceof FluxRevisionMismatch ? { kind: "superseded", code: "idempotency_mismatch" }
      : error instanceof FluxNotDispatched ? { kind: "refused", code: `not_dispatched:${error.code}`.slice(0, 64) }
      : { kind: "ambiguous", code: error instanceof FluxError ? `flux_${error.status}` : "flux_error" }; // R6
  }
  await completeRevoke(env.DB, { grantId, token: claim.token, result, now: clock() });
}

async function sendHomeRevokes(env: Env, flux: FluxClient, homeId: string, clock: Clock, live: boolean): Promise<void> {
  const now = clock();
  await env.DB.batch(refreshStatements(env.DB, homeScope(homeId), now));
  const rows = await env.DB.prepare(`SELECT a.grant_id FROM flux_grant_accounts a JOIN flux_grants g ON g.grant_id=a.grant_id
    WHERE a.home_id=? AND ${REVOKE_AUTO} AND NOT ${DISPUTE_OPEN_HOLD}`).bind(homeId).all<{ grant_id: string }>();
  if (live) for (const { grant_id } of rows.results) await sendRevoke(env, flux, grant_id, clock, live);
  await env.DB.batch(syncAlertStatements(env.DB, homeScope(homeId), clock(), live));
}

/** Round 8b (owner's decision): RE-DELIVERY after a dispute that returned nothing. A grant the dispute's own Stop cancelled (redeliver='held')
 *  goes back to 'pending' under the SAME grant id (R1: deduped where it already arrived) once no open dispute holds its payment and its
 *  account says nothing was returned (D = A) and nothing but this grant id can be at the router. Delivery passes the billing hold
 *  (redeliver='due', sendGrant): the hold stops service, not credit already paid for and kept. Anything else (a refund, a lost share) leaves it
 *  cancelled with its debt alerted by the ledger: the unrefunded share is never forgotten. */
async function releaseDisputeHeld(env: Env, now: number): Promise<void> {
  const held: Scope = { sql: "a.grant_id IN (SELECT grant_id FROM flux_grants WHERE status='cancelled' AND redeliver='held' LIMIT 100)", binds: [] };
  await env.DB.batch([
    ...refreshStatements(env.DB, held, now),
    env.DB.prepare(`UPDATE flux_grants SET status='pending',redeliver='due',claim_id=NULL,last_attempt_at=NULL,last_error=NULL
      WHERE status='cancelled' AND redeliver='held'
        -- Astra INTEGRATED-10 P1: an open DELIVERY (a crashed or ambiguous one) never blocks the release: the re-delivery under the same id
        -- supersedes it once expired (R1). Any other open dispatch (a revoke, an operator) does.
        AND NOT EXISTS (SELECT 1 FROM flux_grant_dispatches d WHERE d.grant_id=flux_grants.grant_id AND d.state='open' AND d.kind<>'deliver')
        AND EXISTS (SELECT 1 FROM flux_grant_accounts a WHERE a.grant_id=flux_grants.grant_id AND a.sized=1 AND a.desired_microcents=a.amount_microcents
          AND a.router_state IN ('none','maybe') AND NOT ${DISPUTE_OPEN_HOLD})`),
  ]);
}

/** Round 8b (Astra TAXCOUNTRY-7 P1-a, a replacement contract): which paid invoice ?4 of home ?2 may lift a hold that its period rule does not.
 *  ONLY the hold-lift changes here; grants and reversals are untouched. All of:
 *  - the invoice belongs to the home's CURRENT contract (its B5 grant claim credit_grants.subscription_id is billing_subscriptions'
 *    subscription for the home, and that contract is not ended or disputed);
 *  - the invoice itself has no open or lost dispute (payment_disputes);
 *  - every cause of the hold belongs to ANOTHER contract:
 *    - its stops that named an invoice: the home has a reversed invoice, and EVERY reversed invoice of the home belongs to another,
 *      attributed contract (a reversal of the current contract's own invoice, or one whose contract is unknown, keeps the hold);
 *    - round 9b: its stops that named no invoice (billing_hold_unattributed=1: a suspension or cancellation) were all made for ONE known
 *      payment line (billing_hold_line, stopForBilling `line`) that is not the current contract's. A line that is the current contract's own,
 *      unknown (NULL), or mixed (two lines: NULL) keeps the hold. */
const REPLACEMENT_LIFTS_HOLD = `EXISTS (SELECT 1 FROM credit_grants g JOIN billing_subscriptions s ON s.home_id=g.home_id AND s.subscription_id=g.subscription_id
    WHERE g.invoice_id=?4 AND g.home_id=?2 AND s.status NOT IN ('canceled','disputed','incomplete_expired'))
  AND NOT EXISTS (SELECT 1 FROM payment_disputes d WHERE d.invoice_id=?4 AND (d.closed_at IS NULL OR d.outcome='lost'))
  AND ((COALESCE(billing_hold_unattributed,0)=0 AND EXISTS (SELECT 1 FROM flux_invoices r WHERE r.home_id=?2 AND r.reversed_at IS NOT NULL))
    OR (billing_hold_unattributed=1 AND billing_hold_line IS NOT NULL
      AND billing_hold_line<>(SELECT s.subscription_id FROM billing_subscriptions s WHERE s.home_id=?2 AND s.subscription_id IS NOT NULL)))
  AND NOT EXISTS (SELECT 1 FROM flux_invoices r WHERE r.home_id=?2 AND r.reversed_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM credit_grants rg JOIN billing_subscriptions s ON s.home_id=rg.home_id
    WHERE rg.invoice_id=r.invoice_id AND rg.subscription_id IS NOT NULL AND rg.subscription_id<>s.subscription_id))`;

/** Record this period's included credits and try to deliver them.
 *  - Invoice record, period entitlement and the delivery outbox row are written in ONE D1 batch,
 *    so a crash never leaves an invoice without its grant. A replay of an invoice whose processing
 *    did not finish (outcome still empty) resumes it; a finished one returns its first answer and
 *    never touches the billing hold.
 *  - The entitlement is the AMOUNT ALREADY GRANTED in the subscription period. A new invoice grants
 *    only max(0, planAmount - alreadyGranted), so plan cycling can never exceed the highest plan.
 *  - Amounts come from config, never from the caller.
 *  - A billing hold is lifted only by a NEW invoice whose period starts after the hold, or by the current contract's paid invoice when the
 *    hold was set only by another contract's reversed invoices (REPLACEMENT_LIFTS_HOLD). */
export async function grantMonthlyCredits(
  env: Env,
  rawInput: GrantInput,
  deps: Pick<FluxDependencies, "fluxClient" | "billingFlux" | "now"> = {},
): Promise<{ grantId: string; status: string; amountUsd: number }> {
  const input = grantSchema.parse(rawInput);
  const config = readFluxConfig(env);
  const plan = config.plans[input.plan];
  if (!plan) throw new HTTPError(400, "unknown_plan");
  if (plan.pooled) throw new HTTPError(400, "pooled_plan_not_supported_yet"); // pooled plan not supported yet
  if (input.kind === "upgrade_delta") {
    const previous = input.previousPlan === undefined ? undefined : config.plans[input.previousPlan];
    if (!previous || previous.pooled) throw new HTTPError(400, "unknown_plan");
    if (plan.creditsUsd - previous.creditsUsd <= 0) throw new HTTPError(400, "not_an_upgrade");
  }
  const now = (deps.now ?? Date.now)();
  const flux = b4RouterClient(env, deps);
  const grantId = `inv:${input.invoiceId}`;
  const target = usdToMicrocents(plan.creditsUsd);
  const reply = (status: string, usd: number) => ({ grantId, status, amountUsd: usd });
  const grantOf = () => env.DB.prepare("SELECT status,amount_microcents FROM flux_grants WHERE grant_id=?")
    .bind(grantId).first<{ status: GrantStatus; amount_microcents: number }>();
  const settle = async (first: { status: GrantStatus; amount_microcents: number }) =>
    reply(first.status === "pending" ? await sendGrant(env, flux, grantId, deps.now ?? Date.now, fluxOn(env, deps)) : first.status, microcentsToUsd(first.amount_microcents));

  const seen = await env.DB.prepare("SELECT home_id,plan,kind,period_start,period_end,reversed_at,outcome FROM flux_invoices WHERE invoice_id=?")
    .bind(input.invoiceId).first<{ home_id: string; plan: string; kind: string; period_start: number; period_end: number; reversed_at: number | null; outcome: string | null }>();
  if (seen) { // A replay. Never touches the hold.
    if (seen.reversed_at !== null) return reply("reversed", 0);
    if (seen.home_id !== input.homeId || seen.plan !== input.plan || seen.kind !== input.kind
      || seen.period_start !== input.periodStart || seen.period_end !== input.periodEnd) {
      throw new HTTPError(409, "idempotency_conflict");
    }
    if (seen.outcome !== null) {
      const first = await grantOf();
      if (first) return settle(first); // also resumes a delivery that has not completed
      return reply(seen.outcome === "granted" ? "duplicate_period" : seen.outcome, 0);
    }
    // outcome is empty: processing never finished. Fall through and run it again.
  }
  await ensureHomeRow(env, config, input.homeId, now);
  const owner = await defaultOwnerOf(env, input.homeId);
  const recipient = owner === null ? null : await linkOf(env, owner);
  const periodKey = `home:${input.homeId}:period:${input.periodStart}`;
  const deltaKey = `${periodKey}:delta:${input.plan}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO flux_invoices (invoice_id,home_id,plan,kind,period_start,period_end,created_at)
      VALUES (?,?,?,?,?,?,?)`).bind(input.invoiceId, input.homeId, input.plan, input.kind, input.periodStart, input.periodEnd, now),
    // A new paid invoice lifts a billing stop only if its period starts after the hold (and it is not reversed), OR (round 8b/9b, the
    // replacement contract) it is the paid invoice of the home's CURRENT contract and every stop of this hold was made for ANOTHER contract
    // (a reversed invoice of it, or a suspension of its payment line). The grant below is keyed by the period's entitlement: never twice.
    env.DB.prepare(`UPDATE flux_home_keys SET billing_hold=0,billing_hold_unattributed=0,billing_hold_line=NULL,updated_at=?1
      WHERE home_id=?2 AND billing_hold=1
        AND NOT EXISTS (SELECT 1 FROM flux_invoices WHERE invoice_id=?4 AND reversed_at IS NOT NULL)
        AND (COALESCE(billing_hold_at,0)<?3 OR (${REPLACEMENT_LIFTS_HOLD}))`)
      .bind(now, input.homeId, input.periodStart, input.invoiceId),
    env.DB.prepare("INSERT OR IGNORE INTO flux_entitlements (home_id,period_start,granted_microcents) VALUES (?,?,0)").bind(input.homeId, input.periodStart),
    // The outbox row: the positive difference between the plan amount and what the period already has.
    env.DB.prepare(`INSERT OR IGNORE INTO flux_grants
      (grant_id,entitlement_key,home_id,invoice_id,kind,recipient_flux_account_id,plan,amount_microcents,period_start,period_end,expires_at,created_at)
      SELECT ?, CASE WHEN e.granted_microcents = 0 THEN ? ELSE ? END, ?, ?, ?, ?, ?, ? - e.granted_microcents, ?, ?, ?, ?
      FROM flux_entitlements e
      WHERE e.home_id = ? AND e.period_start = ? AND e.granted_microcents < ?
        AND NOT EXISTS (SELECT 1 FROM flux_home_keys h WHERE h.home_id = ? AND h.billing_hold = 1)
        AND NOT EXISTS (SELECT 1 FROM flux_invoices i WHERE i.invoice_id = ? AND i.reversed_at IS NOT NULL)`)
      .bind(grantId, periodKey, deltaKey, input.homeId, input.invoiceId, input.kind, recipient, input.plan, target,
        input.periodStart, input.periodEnd, addMonthUtc(input.periodEnd), now,
        input.homeId, input.periodStart, target, input.homeId, input.invoiceId),
    env.DB.prepare(`UPDATE flux_entitlements SET granted_microcents=?
      WHERE home_id=? AND period_start=? AND granted_microcents<? AND EXISTS (SELECT 1 FROM flux_grants WHERE grant_id=?)`)
      .bind(target, input.homeId, input.periodStart, target, grantId),
    // Astra INTEGRATED-9: the grant's ledger account, in the same batch as the outbox row (nothing delivered yet: D = A, applied 0).
    ...refreshStatements(env.DB, grantScope(grantId), now),
    env.DB.prepare(`UPDATE flux_invoices SET outcome=CASE
        WHEN EXISTS (SELECT 1 FROM flux_grants WHERE grant_id=?) THEN 'granted'
        WHEN reversed_at IS NOT NULL THEN 'reversed'
        WHEN EXISTS (SELECT 1 FROM flux_home_keys WHERE home_id=? AND billing_hold=1) THEN 'held_by_billing_hold'
        ELSE 'duplicate_period' END
      WHERE invoice_id=?`).bind(grantId, input.homeId, input.invoiceId),
  ]);
  const grant = await grantOf();
  if (grant) return settle(grant);
  const outcome = await env.DB.prepare("SELECT outcome FROM flux_invoices WHERE invoice_id=?").bind(input.invoiceId).first<{ outcome: string | null }>();
  return reply(outcome?.outcome ?? "duplicate_period", 0);
}

/** Billing says the plan changed. A cap the owner never touched follows the plan. */
export async function changePlan(
  env: Env, input: { homeId: string; plan: string; billingCustomerId?: string }, deps: Pick<FluxDependencies, "fluxClient" | "billingFlux" | "now"> = {},
): Promise<{ plan: string; capUsd: number }> {
  const config = readFluxConfig(env);
  if (!config.plans[input.plan]) throw new HTTPError(400, "unknown_plan");
  const clock: Clock = deps.now ?? Date.now;
  const now = clock();
  const row = await ensureHomeRow(env, config, input.homeId, now);
  const planCap = usdToMicrocents(defaultCapUsd(config, input.plan));
  const capMicrocents = row.cap_custom === 1 ? row.cap_microcents : planCap;
  if (input.billingCustomerId !== undefined) {
    await env.DB.prepare("UPDATE flux_home_keys SET billing_customer_id=? WHERE home_id=?").bind(input.billingCustomerId, input.homeId).run();
  }
  // The plan's cap applies only if the limit is still not customized when written (Astra JOURNEY-A-3 #9); the push sends whatever is stored.
  await changeCap(env, b4RouterClient(env, deps), row, { plan: input.plan, capMicrocents: planCap, custom: row.cap_custom, planDerived: true },
    capMicrocents !== row.cap_microcents, clock);
  const stored = await env.DB.prepare("SELECT cap_microcents AS c FROM flux_home_keys WHERE home_id=?").bind(input.homeId).first<{ c: number }>();
  return { plan: input.plan, capUsd: microcentsToUsd(stored?.c ?? capMicrocents) };
}

export type CapRaise = "raised" | "repaired" | "not_needed" | "skipped" | "owner_cap" | "raced" | "unknown";
/** Cap catch-up: homes are re-read at most this often, 25 per sweep, so a flush of the router's cap store is repaired within about an hour. */
export const CAP_CATCHUP_EVERY_MS = 30 * 60_000;
export const CAP_CATCHUP_HOMES = 25;
/**
 * Credit a home can spend must not sit behind a cap that is lower than what its balance allows. Reads the router (status), then raises the
 * stored cap to spent + spendable under a guard that holds only while the home is exactly as read (same cap_version and customization, spending
 * on, no billing hold, active): an owner cap, an owner stop and spending off are never overridden, and a change in between is "raced" and left to
 * the next pass. An owner-set cap is never raised (reported "owner_cap"), but when the router reports a lower cap than we store (a flush, a restore)
 * the stored cap is pushed again at a higher cap_version, which is a repair and not an override. The balance read is not assumed fresh.
 */
export async function raiseCapToCover(env: Env, homeId: string, deps: Pick<FluxDependencies, "fluxClient" | "billingFlux" | "now"> = {}): Promise<CapRaise> {
  const clock: Clock = deps.now ?? Date.now;
  const row = await env.DB.prepare("SELECT * FROM flux_home_keys WHERE home_id=?").bind(homeId).first<HomeRow>();
  if (!row || row.state !== "active" || row.spending_off === 1 || row.billing_hold === 1) return "skipped";
  const client = b4RouterClient(env, deps);
  let live: FluxHomeStatus;
  try { live = await client.status(homeId); } catch { return "unknown"; }
  const spendable = live.accountSpendableMicrocents;
  if (typeof spendable !== "number" || typeof live.spentMicrocents !== "number") return "unknown";
  const need = live.spentMicrocents + spendable;
  const raising = need > row.cap_microcents;
  if (raising && row.cap_custom === 1) {
    const stale = typeof live.capMicrocents === "number" && live.capMicrocents < row.cap_microcents;
    if (!stale) return "owner_cap";
  }
  const repair = !raising || row.cap_custom === 1;
  if (repair && !(typeof live.capMicrocents === "number" && live.capMicrocents < row.cap_microcents)) return "not_needed";
  const target = repair ? row.cap_microcents : need;
  const pinned = {
    sql: "(SELECT COUNT(*) FROM flux_home_keys f WHERE f.home_id=? AND f.cap_version=? AND f.cap_custom=? AND f.spending_off=0 AND f.billing_hold=0 AND f.state='active')=1",
    binds: [homeId, row.cap_version, row.cap_custom],
  };
  try {
    await changeCap(env, client, row, { plan: row.plan, capMicrocents: target, custom: row.cap_custom }, true, clock, false, pinned);
  } catch (e) {
    if (e instanceof HTTPError && e.status === 403) return "raced";
    if (e instanceof HTTPError && e.status === 409 && e.code === "flux_email_unverified") return "skipped"; // DISPUTE-FENCE-ACCOUNT: no automatic raise while disputed
    throw e;
  }
  return repair ? "repaired" : "raised";
}
/** One bounded pass of the cap catch-up over every home with an active key: least recently checked first, stamped before the router is asked. */
export async function sweepCapCatchUp(env: Env, deps: Pick<FluxDependencies, "fluxClient" | "billingFlux" | "now"> = {}): Promise<number> {
  const clock: Clock = deps.now ?? Date.now;
  const now = clock();
  const homes = await env.DB.prepare(`SELECT home_id FROM flux_home_keys WHERE state='active' AND spending_off=0 AND billing_hold=0
    AND COALESCE(cap_checked_at,0)<=? ORDER BY COALESCE(cap_checked_at,0),home_id LIMIT ?`).bind(now - CAP_CATCHUP_EVERY_MS, CAP_CATCHUP_HOMES).all<{ home_id: string }>();
  let changed = 0;
  for (const h of homes.results) {
    try {
      await env.DB.prepare("UPDATE flux_home_keys SET cap_checked_at=? WHERE home_id=?").bind(now, h.home_id).run();
      const r = await raiseCapToCover(env, h.home_id, deps);
      if (r === "raised" || r === "repaired") changed++;
    } catch { /* isolated: checked again on its next turn */ }
  }
  return changed;
}

/** A grant whose payment is disputed (row `flux_grants`): its own invoice has an OPEN or LOST dispute, or its invoice belongs (B5's grant
 *  claim, credit_grants) to a contract with an OPEN dispute. A pending grant cancelled while this holds is marked redeliver='held'. */
const disputeHeldGrant = `EXISTS (SELECT 1 FROM payment_disputes pd WHERE pd.home_id=flux_grants.home_id AND (
    (pd.invoice_id=flux_grants.invoice_id AND (pd.closed_at IS NULL OR pd.outcome='lost'))
    OR (pd.closed_at IS NULL AND pd.subscription_id IS NOT NULL
      AND pd.subscription_id=(SELECT cg.subscription_id FROM credit_grants cg WHERE cg.invoice_id=flux_grants.invoice_id AND cg.subscription_id IS NOT NULL LIMIT 1))))`;
export const DISPUTE_HELD_GRANT = disputeHeldGrant;
/** Billing says stop (cancelled, suspended, refunded, charged back). Holds the home, cancels DELIVERY of its pending grants (only the named
 *  invoice's when `invoiceId` is given, their retained entitlement journaled first), and revokes the keys. `invoiceId`, when Billing knows
 *  which invoice was reversed, marks it so it can never lift a hold. Astra INTEGRATED-9: a stop removes NO credit by itself: the B4 ledger
 *  (b4-flux-ledger.ts) removes credit only for money actually returned (a refund's succeeded coverage, a lost dispute), read when it acts;
 *  `keepGrants` is kept for the callers and changes nothing any more. */
export async function stopForBilling(
  env: Env, homeId: string, deps: Pick<FluxDependencies, "fluxClient" | "billingFlux" | "now"> = {},
  options: { invoiceId?: string; keepGrants?: boolean; line?: string | null } = {},
): Promise<{ state: string; opId: string }> {
  const config = readFluxConfig(env);
  const clock: Clock = deps.now ?? Date.now;
  const now = clock();
  const flux = b4RouterClient(env, deps);
  await ensureHomeRow(env, config, homeId, now);
  // ONE batch, before any network call: the hold, the invoice marker, the cancellation of pending deliveries (their retained entitlement
  // journaled first), the lifecycle bump with 'stopping', and the Stop intent. A crash after it leaves the sweep able to finish the router
  // Stop; the ledger re-derives every credit adjustment from the money returned, whenever it runs.
  const stop = stopOpStmt(env, homeId, now, "billing_stop");
  await env.DB.batch([
    // billing_hold_unattributed (round 8b): whether this hold includes a stop that named no invoice (a fresh hold starts from this stop alone).
    // billing_hold_line (round 9b, Astra TAXCOUNTRY-8 P1-2): the ONE payment line every stop without an invoice in this hold was made for
    // (`line`); unknown or mixed lines leave NULL, and NULL never lets another contract's invoice lift the hold (REPLACEMENT_LIFTS_HOLD).
    // SQLite evaluates every SET expression against the row as read, so billing_hold/billing_hold_unattributed below are the old values.
    env.DB.prepare(`UPDATE flux_home_keys SET billing_hold=1,billing_hold_at=MAX(COALESCE(billing_hold_at,0),?1),
      billing_hold_unattributed=CASE WHEN ?2=1 THEN 1 WHEN billing_hold=0 THEN 0 ELSE billing_hold_unattributed END,
      billing_hold_line=CASE WHEN ?2=0 THEN (CASE WHEN billing_hold=0 THEN NULL ELSE billing_hold_line END)
        WHEN billing_hold=0 OR COALESCE(billing_hold_unattributed,0)=0 THEN ?3
        WHEN billing_hold_line IS ?3 THEN billing_hold_line ELSE NULL END,
      ${STOPPING},updated_at=?1 WHERE home_id=?4`)
      .bind(now, options.invoiceId === undefined ? 1 : 0, options.line ?? null, homeId),
    ...(options.invoiceId === undefined ? [] : [
      env.DB.prepare(`INSERT OR IGNORE INTO flux_invoices (invoice_id,home_id,plan,kind,period_start,period_end,reversed_at,outcome,created_at)
        VALUES (?,?,'','period',0,0,?,'reversed',?)`).bind(options.invoiceId, homeId, now, now),
      env.DB.prepare("UPDATE flux_invoices SET reversed_at=COALESCE(reversed_at,?) WHERE invoice_id=? AND home_id=?").bind(now, options.invoiceId, homeId),
    ]),
    ...cancelPendingStmts(env, homeId, `${options.keepGrants === true ? "refund_or_dispute" : "billing"}:${options.invoiceId ?? "home"}:${now}`, now,
      options.invoiceId === undefined ? {} : { invoiceId: options.invoiceId }),
    stop.stmt,
  ]);
  await drainHome(env, flux, homeId, clock);
  try { await sendHomeRevokes(env, flux, homeId, clock, fluxOn(env, deps)); } catch { /* the cron retries */ }
  const outcome = await opOutcome(env, stop.opId);
  if (outcome === "failed") throw new HTTPError(502, "flux_unavailable");
  // CH1 P2: opId is this Stop's own operation identity, so a caller that is told "stopping" (queued) can read ITS terminal outcome later.
  if (outcome === "pending") return { state: "stopping", opId: stop.opId }; // queued behind the op that holds the home; recorded, it finishes
  return { state: "stopped", opId: stop.opId };
}

/** Cron: finish every home's open ops (Stops, cap pushes, key compensations), deliver held grants,
 *  expire stale ones, and run the grant ledger (refresh, revokes, obligations' alerts). */
export async function sweepFlux(env: Env, deps: Pick<FluxDependencies, "fluxClient" | "billingFlux" | "now"> = {}): Promise<void> {
  const clock: Clock = deps.now ?? Date.now;
  const now = clock();
  // PRODFLUX r4 D: both Flux secrets set again: the two token-absent pages end here (sweepMonitoring sends the resolve notice, once).
  if (fluxCredentialsMissing(env) === null) {
    try {
      await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE id IN (?,?) AND resolved_at IS NULL")
        .bind(now, "alert:credit.flux_service_token_absent", "alert:credit.grants_token_absent").run();
    } catch { /* retried next sweep */ }
  }
  // THE FLUX-OFF GATE (Astra INTEGRATED-10, fluxOn): off, the sweep keeps only the ledger's ACCOUNTING (causes, desired, debt and its alerts:
  // refunds, disputes and cancellations still change what is owed), bounded by the cursor. No claim, no attempt, no router call, no
  // delivery-state change, no op drained (Astra B4-PORT P2 / INTEGRATED-1 #7).
  if (!fluxOn(env, deps)) {
    try { await ledgerAccounting(env, now, false, []); } catch { /* retried next sweep */ }
    // PRODFLUX (Astra HIGH 2): switched on with a Flux credential missing: nothing is claimed or sent, ONE alert names the secret.
    try { await fluxCredentialsAlert(env, "sweepFlux", now); } catch { /* advisory */ }
    // PRODFLUX (MurageMain): only the grants token missing: the revocations (Stops, compensations) are still drained, nothing else.
    if (fluxRevokeOnly(env, deps)) { await sweepRevocations(env, deps, clock); return; }
    if (!fluxSweepConfigured(env)) return;
    // Astra INTEGRATED-1 #7: the launch gate closed (stub hooks or no capability): every open operation and pending grant stays as it is,
    // and each home holding such work is alerted (pending capability).
    const waiting = await env.DB.prepare(`SELECT home_id FROM flux_home_ops WHERE state IN ('queued','running')
      UNION SELECT home_id FROM flux_grants WHERE status='pending'
      UNION SELECT a.home_id FROM flux_grant_accounts a JOIN flux_grants g ON g.grant_id=a.grant_id WHERE ${REVOKE_AUTO} LIMIT 50`).all<{ home_id: string }>();
    for (const w of waiting.results) await fluxPendingCapabilityAlert(env, w.home_id, now, { call: "sweep" });
    return;
  }
  const flux = b4RouterClient(env, deps);
  const config = readFluxConfig(env);
  // Homes with an open op (a lease that expired with its holder is taken over here; a mint op left by a
  // crashed caller becomes a compensation of its generation). Selection is FAIR and failures are
  // ISOLATED. A home whose last attempt failed waits an exponential backoff (5 min doubling to 1 h;
  // 1 min for a billing Stop); a home whose lease is held by a live holder is skipped. Round 5: the two
  // priority classes are selected SEPARATELY, each least-recently-attempted first. Billing homes take
  // at most SWEEP_HOMES - SWEEP_RESERVED slots; at least SWEEP_RESERVED slots (more when billing work
  // does not fill its share) go to the oldest eligible non-billing homes. So failing billing Stops can
  // never starve another home's ordinary Stop, nor the reverse, and each sweep's work is bounded.
  const billingHomes = await sweepCandidates(env, now, 1, SWEEP_HOMES);
  const otherHomes = await sweepCandidates(env, now, 0, SWEEP_HOMES);
  const otherTake = Math.min(otherHomes.length, Math.max(SWEEP_RESERVED, SWEEP_HOMES - billingHomes.length));
  const picked = [...billingHomes.slice(0, SWEEP_HOMES - otherTake), ...otherHomes.slice(0, otherTake)];
  const homes = { results: picked.map((home_id) => ({ home_id })) };
  await sweepSpendingOff(env, config, flux, clock, now, false);
  await sweepStoppedLive(env, flux, clock, now);
  await sweepResumeUndelivered(env, now);
  for (const { home_id } of homes.results) {
    try { await drainHome(env, flux, home_id, clock); } catch { /* isolated: retried after its backoff */ }
  }
  // Astra JOURNEY-A-4 #6: a switch-off the router has not confirmed (its cap op still queued: every drain failed) for SPENDING_OFF_ESCALATE_MS
  // raises an ops alert, one per switch-off; the retries above go on. Resolved once the op is done (or spending is switched back on).
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at)
        SELECT 'alert:spending_off:'||k.home_id||':'||k.spending_off_at,k.home_id,'${SPENDING_OFF_ALERT}','high',
          json_object('requestedAt',k.spending_off_at,'pendingForMs',?1-k.spending_off_at,
            'lastError',(SELECT o.last_error FROM flux_home_ops o WHERE o.home_id=k.home_id AND o.kind IN ('cap','stop') AND o.state IN ('queued','running') ORDER BY o.seq DESC LIMIT 1)),?1
        FROM flux_home_keys k WHERE k.spending_off=1 AND k.spending_off_at IS NOT NULL AND k.spending_off_at<=?2
          AND EXISTS (SELECT 1 FROM flux_home_ops o WHERE o.home_id=k.home_id AND o.kind IN ('cap','stop') AND o.state IN ('queued','running'))
        LIMIT 50`).bind(now, now - SPENDING_OFF_ESCALATE_MS),
      env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?1 WHERE kind='${SPENDING_OFF_ALERT}' AND resolved_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM flux_home_keys k WHERE k.home_id=cloud_alerts.home_id AND k.spending_off=1
          AND 'alert:spending_off:'||k.home_id||':'||k.spending_off_at=cloud_alerts.id
          AND EXISTS (SELECT 1 FROM flux_home_ops o WHERE o.home_id=k.home_id AND o.kind IN ('cap','stop') AND o.state IN ('queued','running')))`).bind(now),
    ]);
  } catch { /* retried next sweep */ }
  // A fenced link whose Stops are all done is finalized here too, whatever interrupted its last Stop.
  const fenced = await env.DB.prepare("SELECT owner_user_id,link_id FROM flux_links WHERE fenced=1 LIMIT 50")
    .all<{ owner_user_id: string; link_id: string }>();
  for (const { owner_user_id, link_id } of fenced.results) {
    try { await finalizeUnlink(env, owner_user_id, link_id); } catch { /* retried next sweep */ }
  }
  await env.DB.prepare("DELETE FROM flux_home_ops WHERE state IN ('done','superseded') AND updated_at<?").bind(now - 60 * 86_400_000).run();
  await env.DB.prepare("UPDATE flux_grants SET status='expired' WHERE status='pending' AND claim_id IS NULL AND expires_at<=?").bind(now).run();
  // A held grant may have expired or been cancelled by billing since: its open alert is reconciled.
  // Only alerts whose held-grant count no longer matches the alert's own list are selected, so unchanged holds can never
  // fill the batch and starve a later home (each reconciled alert then matches and drops out of the next selection).
  const heldAlerts = await env.DB.prepare(`SELECT a.home_id FROM cloud_alerts a WHERE a.kind='flux.grant_held' AND a.resolved_at IS NULL
    AND (SELECT COUNT(*) FROM flux_grants g WHERE g.home_id=a.home_id AND g.status='pending'
      AND substr(COALESCE(g.last_error,''),1,${GRANT_HELD.length})='${GRANT_HELD}')<>COALESCE(json_array_length(json_extract(a.detail,'$.grants')),-1)
    ORDER BY a.raised_at,a.id LIMIT 50`).all<{ home_id: string }>();
  for (const { home_id } of heldAlerts.results) {
    try { await syncHeldAlert(env, home_id, now); } catch { /* retried next sweep */ }
  }
  await env.DB.prepare("DELETE FROM flux_mint_ops WHERE created_at<?").bind(now - 60 * 86_400_000).run();
  try { await releaseDisputeHeld(env, now); } catch { /* retried next sweep */ }
  // Cap catch-up: credit bought, here or at the router's own billing page (the route for buyers outside the auto top-up path), or granted must
  // not sit behind a lower cap, and a cap lost in a flush is pushed again. Runs with the Flux routes, not with auto top-up charging.
  if (fluxRoutesEnabled(env)) { try { await sweepCapCatchUp(env, deps); } catch { /* retried next sweep */ } }
  // Lane H1 (fence F4): grants whose last fenced request has an unknown, superseded or mismatched outcome are read back (GET state).
  try { await reconcileFences(env.DB, async (id) => (flux.grantState ? flux.grantState(id) : null)); } catch { /* retried next sweep */ }
  // Astra INTEGRATED-9/10: THE LEDGER. A bounded page of accounts re-derived from its payment's records (all causes together; the revoke
  // claim re-reads each one again), then the full returns revoked, least recently tried first, from the partial index of revoke candidates
  // (an account that legitimately waits, an open dispute, can never starve the others).
  const touched: string[] = [];
  const page = await ledgerAccounting(env, now, true, null).catch(() => null);
  const revokes = await env.DB.prepare(`SELECT a.grant_id FROM flux_grant_accounts a JOIN flux_grants g ON g.grant_id=a.grant_id
    WHERE ${REVOKE_AUTO} AND NOT ${DISPUTE_OPEN_HOLD} AND (a.last_tried_at IS NULL OR a.last_tried_at<?)
    ORDER BY COALESCE(a.last_tried_at,0),a.grant_id LIMIT 50`).bind(now - GRANT_RETRY_AFTER_MS).all<{ grant_id: string }>();
  for (const { grant_id } of revokes.results) {
    touched.push(grant_id);
    try { await sendRevoke(env, flux, grant_id, clock, true); } catch { /* retried next sweep */ }
  }
  const due = await env.DB.prepare(`SELECT grant_id FROM flux_grants WHERE status='pending'
    AND (last_attempt_at IS NULL OR last_attempt_at<?) ORDER BY COALESCE(last_attempt_at,0),created_at LIMIT 50`)
    .bind(now - GRANT_RETRY_AFTER_MS).all<{ grant_id: string }>();
  for (const { grant_id } of due.results) {
    touched.push(grant_id);
    try { await sendGrant(env, flux, grant_id, clock, true); } catch { /* retried next sweep */ }
  }
  // Every open obligation of the page and of the grants this sweep touched is alerted, one alert per grant, re-delivered when its revision
  // changes; settled ones are resolved. The page moves on only once its alerts are written.
  try {
    await env.DB.batch([...syncAlertStatements(env.DB, listScope([...new Set([...touched, ...(page?.ids ?? [])])]), clock(), true), ...(page ? [page.advance] : [])]);
  } catch { /* retried next sweep */ }
}

/** Astra INTEGRATED-10 (L7): one bounded step of the ledger's accounting: the next cursor page of accounts refreshed (causes, desired,
 *  returned, paid) and, when `advanceNow` is given (Flux off: nothing else will run), its alerts synced and the cursor moved in the same
 *  batch. Live, the caller syncs the page together with the grants it touched and moves the cursor itself. */
async function ledgerAccounting(env: Env, now: number, live: boolean, advanceNow: string[] | null): Promise<{ ids: string[]; advance: D1PreparedStatement }> {
  const page = await ledgerPage(env.DB, now);
  await env.DB.batch([
    ...refreshStatements(env.DB, page.scope, now),
    ...(advanceNow ? [...syncAlertStatements(env.DB, page.scope, now, live), page.advance] : []),
  ]);
  return { ids: page.ids, advance: page.advance };
}

/** Astra JOURNEY-A-6 #6: switched-off homes are polled for cap drift in turn, whether or not they have an operation open: the ones least
 *  recently checked (spending_off_checked_at, stamped BEFORE the router is asked, whatever it answers; for a repair, after its batch) first, each at most every
 *  SPENDING_OFF_POLL_MS. A positive router limit with no cap op queued is drift: zero enforcement is requeued at a new cap version and a new
 *  incident raised (recordSpendingDrift), as a status read would. Run before the drains, so a home whose zero is still queued is skipped.
 *  Astra r3 HIGH: the same pass repairs a home whose OFF is recorded while its key is still active with no Stop open (the owner's Stop is
 *  journaled and sent). `revokeOnly` (sweepRevocations): only that repair runs, over the active homes with no Stop open (a held cap push
 *  never hides one), and no status read is made. */
async function sweepSpendingOff(env: Env, config: FluxConfig, flux: FluxClient, clock: Clock, now: number, revokeOnly: boolean): Promise<void> {
  try {
    // The batch follows the size of the switched-off cohort (spendingOffPollBatch): every home is re-read within spendingOffMaxStalenessMs.
    const cohort = (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_keys WHERE spending_off=1 AND state<>'none'").first<{ n: number }>())?.n ?? 0;
    const off = await env.DB.prepare(`SELECT k.home_id,k.spending_off_at FROM flux_home_keys k WHERE k.spending_off=1 AND k.state${revokeOnly ? "='active'" : "<>'none'"}
        AND COALESCE(k.spending_off_checked_at,0)<=? AND (k.op_holder IS NULL OR k.op_lease_until<?)
        AND NOT EXISTS (SELECT 1 FROM flux_home_ops o WHERE o.home_id=k.home_id AND o.kind IN (${revokeOnly ? "'stop'" : "'cap','stop'"}) AND o.state IN ('queued','running'))
      ORDER BY COALESCE(k.spending_off_checked_at,0),k.home_id LIMIT ?`).bind(now - SPENDING_OFF_POLL_MS, now, spendingOffPollBatch(cohort))
      .all<{ home_id: string; spending_off_at: number | null }>();
    for (const h of off.results) {
      try {
        const stamp = () => env.DB.prepare("UPDATE flux_home_keys SET spending_off_checked_at=? WHERE home_id=?").bind(now, h.home_id).run();
        // Off recorded but the revoke never started (a crash between the two writes, or a race): finish it. The stop is the revoke.
        const current = await env.DB.prepare("SELECT spending_off AS o, state AS s FROM flux_home_keys WHERE home_id=?").bind(h.home_id).first<{ o: number; s: string }>();
        if (current?.o === 1 && current.s === "active") {
          // CAPOFF-REPAIR-RACE: the Stop is written only if the home is still OFF, active and without an open Stop at write time, and the
          // home is stamped only AFTER that batch: a batch that throws is logged and left unstamped, so the next sweep (not this one) retries it.
          let opId: string | null;
          try {
            opId = await repairSpendingOffStop(env, h.home_id, clock());
          } catch (error) {
            console.error(JSON.stringify({ message: "flux spending off repair: writing the Stop failed, the next sweep retries it", homeId: h.home_id,
              error: error instanceof Error ? error.name : "unknown" }));
            continue;
          }
          await stamp();
          if (opId === null) continue; // a cap ON or another sweep landed first: nothing written
          await drainHome(env, flux, h.home_id, clock);
          if (await opOutcome(env, opId) === "failed") {
            console.error(JSON.stringify({ message: "flux spending off repair: sending the Stop failed, the sweep sends it", homeId: h.home_id }));
          }
          continue;
        }
        await stamp();
        if (revokeOnly) continue;
        const live = await flux.status(h.home_id);
        if (live?.state === "ok" || live?.state === "capped") {
          const row = await env.DB.prepare("SELECT * FROM flux_home_keys WHERE home_id=?").bind(h.home_id).first<HomeRow>();
          if (row && row.spending_off === 1 && row.state === "stopped") await recordSpendingDrift(env, flux, h.home_id, row, live.capMicrocents ?? 0, now);
        }
      } catch { /* isolated: polled again on its turn */ }
    }
  } catch { /* retried next sweep */ }
}

/** 8b (2.6a): a row with `state='stopped'` whose router status says LIVE means money can move while the screen says stopped. The sweep also selects
 *  stopped rows (spending on or off, any hold) with no Stop open and no lease held, least recently `stop_checked_at` first, with its OWN cohort count
 *  and batch (the spending-off class keeps its slots), stamps BEFORE asking, and when the router reports the key live journals a Stop (reason
 *  stopped_live_repair) conditional on the row still being stopped with no Stop open, then drains it. A router 409 stale_lifecycle (it is ahead of the
 *  CP) or a failed Stop leaves the row for the next pass and raises flux.stopped_key_live (PAGE): one open incident per home (cloud_alerts_open),
 *  resolved only by an operator (POST /v1/internal/alerts/:id/resolve). Nothing here resolves it. */
export const STOPPED_KEY_LIVE_ALERT = "flux.stopped_key_live";
async function sweepStoppedLive(env: Env, flux: FluxClient, clock: Clock, now: number): Promise<void> {
  try {
    const cohort = (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_keys WHERE state='stopped'").first<{ n: number }>())?.n ?? 0;
    const due = await env.DB.prepare(`SELECT k.home_id FROM flux_home_keys k WHERE k.state='stopped'
        AND COALESCE(k.stop_checked_at,0)<=? AND (k.op_holder IS NULL OR k.op_lease_until<?)
        AND NOT EXISTS (SELECT 1 FROM flux_home_ops o WHERE o.home_id=k.home_id AND o.kind='stop' AND o.state IN ('queued','running'))
      ORDER BY COALESCE(k.stop_checked_at,0),k.home_id LIMIT ?`).bind(now - SPENDING_OFF_POLL_MS, now, spendingOffPollBatch(cohort)).all<{ home_id: string }>();
    for (const h of due.results) {
      try {
        await env.DB.prepare("UPDATE flux_home_keys SET stop_checked_at=? WHERE home_id=?").bind(now, h.home_id).run();
        const live = await flux.status(h.home_id);
        if (live?.state !== "ok" && live?.state !== "capped") continue;
        // The CAPOFF-REPAIR-RACE shape: written only if, at write time, the row is still stopped and no Stop is open.
        const stop = stopOpStmt(env, h.home_id, clock(), "stopped_live_repair", undefined, { sql: "changes()=1", binds: [] });
        const [bumped] = await env.DB.batch([
          env.DB.prepare(`UPDATE flux_home_keys SET ${STOPPING},updated_at=? WHERE home_id=? AND state='stopped'
            AND NOT EXISTS (SELECT 1 FROM flux_home_ops WHERE home_id=? AND kind='stop' AND state IN ('queued','running'))`).bind(clock(), h.home_id, h.home_id),
          stop.stmt,
        ]);
        if (bumped.meta.changes !== 1) continue; // a resume or another sweep landed first: nothing written
        await drainHome(env, flux, h.home_id, clock);
        const outcome = await opOutcome(env, stop.opId);
        if (outcome === "failed" || outcome === "superseded") {
          await alertStatement(env.DB, { homeId: h.home_id, kind: STOPPED_KEY_LIVE_ALERT, severity: "high",
            detail: JSON.stringify({ routerState: live.state, stop: outcome }) }, clock()).run();
        }
      } catch { /* isolated: polled again on its turn */ }
    }
  } catch { /* retried next sweep */ }
}

/** 8b (2.7): a resume the home never took. Raise (rows with no incident yet, oldest first, 25 a pass) and resolve (only incidents resolvable now,
 *  each against its OWN lifecycle, `subject`). Offline homes get no alert. Both read through partial indexes (migration 0150). */
export const RESUME_UNDELIVERED_ALERT = "flux.resume_undelivered";
async function sweepResumeUndelivered(env: Env, now: number): Promise<void> {
  try {
    const stuck = await env.DB.prepare(`SELECT k.home_id,k.resume_lv FROM flux_home_keys k JOIN cloud_homes h ON h.id=k.home_id
      WHERE k.resume_lv IS NOT NULL AND k.acked_lifecycle_version IS NOT k.resume_lv AND k.resume_lv=k.lifecycle_version
        AND k.state='active' AND k.billing_hold=0 AND k.spending_off=0 AND k.resume_at < ?
        AND h.heartbeat_at > ?
        AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.id='alert:resume:'||k.home_id||':'||k.resume_lv)
      ORDER BY k.resume_at LIMIT 25`).bind(now - 3_600_000, now - 2 * LEASE_FRESH_MS).all<{ home_id: string; resume_lv: number }>();
    if (stuck.results.length > 0) {
      await env.DB.batch(stuck.results.map((r) => env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
        VALUES (?,?,'${RESUME_UNDELIVERED_ALERT}','high',?,?,?) ON CONFLICT DO NOTHING`)
        .bind(`alert:resume:${r.home_id}:${r.resume_lv}`, r.home_id, JSON.stringify({ resumeLifecycle: r.resume_lv }), now, String(r.resume_lv))));
    }
  } catch { /* retried next sweep */ }
  try {
    const done = await env.DB.prepare(`SELECT a.id FROM cloud_alerts a LEFT JOIN flux_home_keys k ON k.home_id=a.home_id
      WHERE a.kind='${RESUME_UNDELIVERED_ALERT}' AND a.resolved_at IS NULL
        AND (k.home_id IS NULL OR k.acked_lifecycle_version >= CAST(a.subject AS INTEGER) OR k.lifecycle_version > CAST(a.subject AS INTEGER))
      ORDER BY a.raised_at LIMIT 100`).all<{ id: string }>();
    if (done.results.length > 0) {
      await env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=? WHERE id IN (${done.results.map(() => "?").join(",")}) AND resolved_at IS NULL`)
        .bind(now, ...done.results.map((r) => r.id)).run();
    }
  } catch { /* retried next sweep */ }
}

/** Astra JOURNEY-A-6 #6 / A-7: drift polling of switched-off homes is BOUNDED. The sweep runs every SWEEP_INTERVAL_MS (wrangler cron
 *  "*\/5 * * * *"); one home is polled at most every SPENDING_OFF_POLL_MS; each sweep polls spendingOffPollBatch(N) of the N eligible homes,
 *  least recently checked first: ceil(N / 12) (one full round of the cohort per hour), at least SPENDING_OFF_POLLS_MIN, at most
 *  SPENDING_OFF_POLLS_MAX (bounded router calls per sweep). MAXIMUM STALENESS with healthy sweeps (spendingOffMaxStalenessMs):
 *  max(15 min, 5 min x ceil(N / batch)): 15 min up to 30 homes, <= 60 min for every N <= 1,200 (1,000 homes: batch 84, 60 min), and
 *  5 min x ceil(N / 100) beyond (2,000 homes: 100 min). A missed sweep adds its 5 minutes. */
const SPENDING_OFF_POLL_MS = 15 * 60_000;
export const SWEEP_INTERVAL_MS = 5 * 60_000;
export const SPENDING_OFF_POLLS_MIN = 10;
export const SPENDING_OFF_POLLS_MAX = 100;
export const spendingOffPollBatch = (eligible: number): number =>
  Math.min(SPENDING_OFF_POLLS_MAX, Math.max(SPENDING_OFF_POLLS_MIN, Math.ceil(eligible / Math.round(3_600_000 / SWEEP_INTERVAL_MS))));
export const spendingOffMaxStalenessMs = (homes: number): number =>
  Math.max(SPENDING_OFF_POLL_MS, SWEEP_INTERVAL_MS * Math.ceil(Math.max(homes, 1) / spendingOffPollBatch(homes)));
/** Homes a sweep drains at most (each op is one bounded router call). */
const SWEEP_HOMES = 25;
/** Slots of every sweep reserved for the oldest eligible non-billing homes (round 5 fairness). */
const SWEEP_RESERVED = 5;

/** Eligible homes of one priority class (billing = 1: has a billing Stop open), least recently
 *  attempted first: an open op, no live lease, and past its per-home backoff. */
async function sweepCandidates(env: Env, now: number, billing: 0 | 1, limit: number, revokeOnly = false): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT home_id FROM (SELECT o.home_id,
      MAX(CASE WHEN o.kind='stop' AND json_extract(o.payload,'$.reason')='billing_stop' THEN 1 ELSE 0 END) AS billing,
      MAX(o.attempts) AS attempts, MAX(o.updated_at) AS touched
    FROM flux_home_ops o LEFT JOIN flux_home_keys k ON k.home_id=o.home_id
    WHERE o.state IN ('queued','running') AND (k.op_holder IS NULL OR k.op_lease_until<?)${revokeOnly ? ` AND o.${REVOCATION_KINDS}` : ""}
    GROUP BY o.home_id)
    WHERE billing=? AND (attempts=0 OR touched + (CASE WHEN billing=1
        THEN 60000 ELSE MIN(3600000, 300000 * (1 << MIN(attempts-1, 4))) END) <= ?)
    ORDER BY touched ASC, home_id ASC
    LIMIT ?`).bind(now, billing, now, limit).all<{ home_id: string }>();
  return rows.results.map((r) => r.home_id);
}

/** PRODFLUX (MurageMain): the revoke-only sweep (fluxRevokeOnly). The same fair, backed-off selection as the full sweep, over the homes
 *  holding a revocation (Stop, compensation, crashed mint) only, each drained with the revoke-only client; failures isolated. Astra r3 HIGH:
 *  first, as the full sweep, an OFF home whose key is still active with no Stop open gets its Stop (sweepSpendingOff), and (8b 2.6a) a stopped
 *  row whose key is live gets its repair Stop and incident (sweepStoppedLive). */
async function sweepRevocations(env: Env, deps: Pick<FluxDependencies, "fluxClient" | "billingFlux" | "now">, clock: Clock): Promise<void> {
  const now = clock();
  const flux = b4RouterClient(env, deps);
  await sweepSpendingOff(env, readFluxConfig(env), flux, clock, now, true);
  // 8b fix r1 (Astra H2): a stopped row whose key the router reports live gets its repair Stop here too (2.6a): the Stop needs only the service
  // token, so it never waits for the grants token. Its client reads status only for a stopped row and drains only revocations.
  await sweepStoppedLive(env, b4RouterClient(env, deps, { stoppedStatus: true }), clock, now);
  const billingHomes = await sweepCandidates(env, now, 1, SWEEP_HOMES, true);
  const otherHomes = await sweepCandidates(env, now, 0, SWEEP_HOMES, true);
  const otherTake = Math.min(otherHomes.length, Math.max(SWEEP_RESERVED, SWEEP_HOMES - billingHomes.length));
  for (const homeId of [...billingHomes.slice(0, SWEEP_HOMES - otherTake), ...otherHomes.slice(0, otherTake)]) {
    try { await drainHome(env, flux, homeId, clock); } catch { /* isolated: retried after its backoff */ }
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

const LINK_ROUTE = /^\/v1\/flux\/link(\/start|\/complete)?$/;
const HOME_ROUTE = /^\/v1\/homes\/([\w-]{1,128})\/flux(\/subkey|\/cap|\/stop)?$/;
/** Astra JOURNEY-A-10 #4: Flux is OFF at launch (the Flux route switch unset). The owner's spending Off (POST cap or stop) still gets a
 *  plain answer instead of a 404: Flux is not available, nothing was changed. Flux is never contacted and nothing is written. */
export const fluxOffStubRoute = (method: string, path: string): boolean => {
  const m = HOME_ROUTE.exec(path);
  return method === "POST" && !!m && (m[2] === "/cap" || m[2] === "/stop");
};
/** PRODFLUX (MurageMain): the routes that only revoke (the owner's Stop, the operator's billing Stop). Served while fluxRevokeOnly. */
/** 8b (2.2): the owner's POST /flux/subkey, retired. index.ts lets it past the step-up gate so the answer is the 410, with no intent written. */
export const fluxOwnerSubkeyRoute = (method: string, path: string): boolean => method === "POST" && HOME_ROUTE.exec(path)?.[2] === "/subkey";
export const fluxRevocationRoute = (method: string, path: string): boolean =>
  method === "POST" && (HOME_ROUTE.exec(path)?.[2] === "/stop" || ADMIN_ROUTE.exec(path)?.[1] === "stop");
export const FLUX_OFF_MESSAGE = "Flux is not available yet. There is no Flux spending to turn off, and nothing was changed.";
const MACHINE_ROUTE = /^\/v1\/machines\/([\w-]{1,128})\/flux\/(subkey\/ack|subkey|renewal-due)$/;
const ADMIN_ROUTE = /^\/v1\/internal\/flux\/(grant|plan|stop)$/;
/** 8b (2.6a iii): the operator's resolve of a flux.stopped_key_live incident. Admin credential only; no router call; works while Flux is off. */
const ALERT_RESOLVE_ROUTE = /^\/v1\/internal\/alerts\/([^/]{1,200})\/resolve$/;
export const FLUX_ALERT_RESOLVE_ROUTE = ALERT_RESOLVE_ROUTE;
const alertResolveSchema = z.strictObject({ by: z.string().trim().min(1).max(80), reason: z.string().trim().min(1).max(500) });
/** Astra INTEGRATED-9 (L6): the operator's claim on one grant's ledger account, and the receipt that completes it. */
const LEDGER_ROUTE = /^\/v1\/internal\/flux\/grants\/(inv:[A-Za-z0-9_:-]{4,128})\/(claim|applied)$/;
export const FLUX_LEDGER_ROUTE = LEDGER_ROUTE;
/** `tombstone`: the operator WROTE the grant's tombstone at the router (R2), which subsumes an expired automatic dispatch (L5); evidence required. */
const ledgerClaimSchema = z.strictObject({ by: z.string().trim().min(1).max(200), evidence: z.string().trim().min(1).max(2000).optional(),
  tombstone: z.literal(true).optional() }).refine((b) => b.tombstone !== true || b.evidence !== undefined, { path: ["evidence"] });
const ledgerAppliedSchema = z.strictObject({
  token: z.string().uuid(),
  /** R8: the receipt names its grant and the claim's revision. */
  grantId: z.string().min(1).max(160),
  revision: z.number().int().min(1),
  /** H2: the Flux wire revision the claim allocated (the claim's wireRevision), which the hand adjustment carried at Flux. */
  wireRevision: z.number().int().min(1).optional(),
  appliedMicrocents: z.number().int().min(0),
  /** R8: the Flux ledger entry of this grant's hand adjustment (unique across all receipts). */
  adjustmentRef: z.string().trim().min(3).max(200),
  evidence: z.string().trim().min(8).max(2000),
  by: z.string().trim().min(1).max(200),
  /** L2b: only for an account whose payment's amount is unknown (sized 0): the payment's amount and where it was read. */
  sizing: z.strictObject({ paidCents: z.number().int().min(1), evidence: z.string().trim().min(8).max(2000) }).optional(),
});

/** POST /v1/homes/{id}/flux/cap. `{capUsd}` sets the monthly spend limit (`{capUsd: 0}` switches spending off, the same as `{enabled: false}`);
 *  `{enabled: true}` switches it back on at the plan's default limit (or `{enabled: true, capUsd}` at that limit). Journey A8 (Astra
 *  JOURNEY-A-2): off is an explicit state, stored as a limit of zero (cap_custom, so a plan change never switches it back on), pushed to Flux
 *  like any limit (the router then refuses all spend). Lowering: sign-in only. Off: sign-in only while Flux is not switched on live; with
 *  Flux switched on live it journals a real Stop, so it needs the fresh second factor, as switching on or raising does. */
const capSchema = z.union([
  z.strictObject({ capUsd: z.number().finite() }),
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({ enabled: z.literal(true), capUsd: z.number().finite().optional() }),
]);
type CapBody = z.infer<typeof capSchema>;
/** What a cap body asks for: "off" (switched off), "default" (on, at the plan's default limit) or a limit in USD. */
function capRequest(b: CapBody): "off" | "default" | number {
  if ("enabled" in b && !b.enabled) return "off";
  const capUsd = "capUsd" in b ? b.capUsd : undefined;
  if (capUsd === undefined) return "default";
  return capUsd === 0 ? "off" : capUsd;
}
const planSchema = z.strictObject({
  homeId: z.string().regex(HOME_ID),
  plan: z.string().regex(PLAN_ID),
  /** Optional Stripe customer id, passed on to the router when known. Never required. */
  billingCustomerId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/).optional(),
});
const stopSchema = z.strictObject({
  homeId: z.string().regex(HOME_ID),
  reason: z.enum(["cancelled", "suspended", "refunded", "chargeback"]),
  invoiceId: z.string().regex(/^[A-Za-z0-9_:-]{4,128}$/).optional(),
});

export async function fluxRoute(
  request: Request, env: Env, auth: ControlPlaneAuth, dependencies: FluxDependencies = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const link = LINK_ROUTE.exec(path);
  const homeMatch = HOME_ROUTE.exec(path);
  const machineMatch = MACHINE_ROUTE.exec(path);
  const adminMatch = ADMIN_ROUTE.exec(path);
  const ledgerMatch = LEDGER_ROUTE.exec(path);
  const proofMatch = PROOF_OPERATOR_ROUTE.exec(path);
  const resolveMatch = ALERT_RESOLVE_ROUTE.exec(path);
  if (!link && !homeMatch && !machineMatch && !adminMatch && !ledgerMatch && !proofMatch && !resolveMatch) return null;
  if (resolveMatch) {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    await adminOnly(request, env);
    return resolveStoppedKeyLive(env, decodeURIComponent(resolveMatch[1]), await body(request, alertResolveSchema), (dependencies.now ?? Date.now)());
  }
  // FLUX-ENSURE-EMAIL-VERIFIED (grok-runbook.md CRITICAL): support's email-proof routes, admin credential only, Flux on or off. There is NO
  // operator stamp: resend mails a normal challenge to the STORED address; dispute clears a proof and blocks stamp and wake (a linked account
  // only pages); dispute-clear lifts the block. Only the challenge consume (flux-email-proof.ts verifyProof) ever records a proof.
  if (proofMatch) {
    await adminOnly(request, env);
    return fluxEmailProofOperatorRoute(request, env, proofMatch[1], { emailSender: dependencies.emailSender, now: dependencies.now });
  }
  // Astra INTEGRATED-11 (ledger R9): the operator's evidenced recovery makes NO router call (no client is even built): it works whether Flux
  // is on or off. Admin credential only.
  if (ledgerMatch) {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    await adminOnly(request, env);
    const now = (dependencies.now ?? Date.now)();
    const grantId = ledgerMatch[1];
    if (ledgerMatch[2] === "claim") {
      const b = await body(request, ledgerClaimSchema);
      const r = await operatorClaim(env.DB, { grantId, by: b.by, evidence: b.evidence, tombstone: b.tombstone, now });
      if (!r.account) throw new HTTPError(404, "not_found");
      if (!r.claimed) return json({ error: "dispatch_in_flight", open: r.open }, 409);
      const acc = r.account;
      return json({ token: r.token, revision: acc.revision, adjustmentRef: r.adjustmentRef, wireGrantId: r.wireGrantId, wireRevision: r.wireRevision,
        amountMicrocents: acc.amount_microcents,
        desiredMicrocents: acc.desired_microcents, appliedMicrocents: acc.applied_microcents, debtMicrocents: acc.desired_microcents - acc.applied_microcents,
        routerState: acc.router_state, sized: acc.sized === 1 });
    }
    const b = await body(request, ledgerAppliedSchema);
    if (b.grantId !== grantId) throw new HTTPError(409, "grant_mismatch");
    // INTEGRATED-12 (R8c): the receipt is verified against Flux's own record of the adjustment only while Flux is on (no Flux read, no
    // router call, while off); unverified it is kept PENDING VERIFICATION and moves no stored balance.
    const live = fluxOn(env, dependencies);
    const reader = live ? b4RouterClient(env, dependencies) : null;
    const verified = reader?.verifyAdjustment
      ? await reader.verifyAdjustment({ grantId, adjustmentRef: b.adjustmentRef, appliedMicrocents: b.appliedMicrocents }).catch(() => null)
      : null;
    const result = await operatorApplied(env.DB, { grantId, token: b.token, revision: b.revision, wireRevision: b.wireRevision, appliedMicrocents: b.appliedMicrocents,
      adjustmentRef: b.adjustmentRef, evidence: b.evidence, by: b.by, sizing: b.sizing, now, live, verified });
    if (result === "pending_verification") return json({ applied: false, pendingVerification: true, receivedAt: now }, 202);
    if (result !== "applied") throw new HTTPError(409, result);
    return json({ applied: true, appliedAt: now });
  }
  // Defence in depth: the Worker already answered 404 before auth (index.ts). Off means not found, whoever asks, except the owner's spending
  // Off (Astra JOURNEY-A-10 #4): signed in and the home's owner, it is told plainly that Flux is unavailable. No Flux call, no write.
  // PRODFLUX (Astra HIGH 2): switched on with a Flux credential missing serves exactly as off (fluxServing): nothing new is activated.
  // PRODFLUX (MurageMain): with only the grants token missing (fluxRevokeOnly) a Stop is a revocation and is served; nothing else is.
  // PRODFLUX r4 C: switched on with the real hooks (fluxSwitchedOnLive), the Stops (owner, operator billing Stop) and a VALID cap OFF are
  // served in every readiness state: journaled (owner step-up already enforced by the gate, cap OFF again in setCap), sent now when
  // readiness.revoke allows, else answered pending and sent once the secret is back. Cap enable or raise stays the unavailable answer.
  const live = fluxSwitchedOnLive(env, dependencies);
  const revocation = live && (fluxRevocationRoute(request.method, path) || (request.method === "POST" && homeMatch?.[2] === "/cap" && await capOffBody(request)));
  if (!fluxServing(env) && !revocation) {
    if (!homeMatch || !fluxOffStubRoute(request.method, path)) throw new HTTPError(404, "not_found");
    const account = await (dependencies.currentAccount ?? defaultAccount)(request, auth);
    if (!account) throw new HTTPError(401, "unauthorized");
    const owner = await (dependencies.ownerOf ?? defaultOwnerOf)(env, homeMatch[1]);
    if (owner === null || owner !== account.id) throw new HTTPError(404, "not_found");
    return json({ state: "flux_unavailable", fluxAvailable: false, changed: false, message: FLUX_OFF_MESSAGE });
  }
  const clock: Clock = dependencies.now ?? Date.now;
  const now = clock();
  const config = readFluxConfig(env);
  const flux = b4RouterClient(env, dependencies);

  if (adminMatch) {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    await adminOnly(request, env);
    if (adminMatch[1] === "grant") return json(await grantMonthlyCredits(env, await body(request, grantSchema), dependencies));
    if (adminMatch[1] === "plan") return json(await changePlan(env, await body(request, planSchema), dependencies));
    const stop = await body(request, stopSchema);
    return json({ state: (await stopForBilling(env, stop.homeId, dependencies, { invoiceId: stop.invoiceId })).state });
  }

  if (machineMatch) {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    const homeId = machineMatch[1];
    const row = await env.DB.prepare("SELECT generation FROM cloud_machines WHERE id=?").bind(homeId).first<{ generation: number }>();
    if (!row) throw new HTTPError(401, "unauthorized");
    // Machine credential, its generation, and a source IP in the machine's bound list. One wire schema per route (shared/flux-renewal-wire.ts).
    const route = machineMatch[2];
    const input = route === "renewal-due" ? await body(request, renewalDueRequest)
      : route === "subkey/ack" ? await body(request, ackRequest) : await body(request, subkeyRequest);
    await machine(request, env, { id: homeId, generation: input.generation });
    if (route === "renewal-due") return json(await fluxRenewalStatus(env, homeId, input.generation, now));
    if (route === "subkey/ack") return json(await ackSubkey(env, homeId, input as z.infer<typeof ackRequest>));
    const owner = await (dependencies.ownerOf ?? defaultOwnerOf)(env, homeId);
    if (owner === null) throw new HTTPError(404, "not_found");
    // Renewal only: it can never resume a stopped home or undo a billing hold.
    return issueKey(env, config, flux, owner, homeId, clock, { kind: "renewal", machineGeneration: input.generation, opId: (input as z.infer<typeof subkeyRequest>).op_id,
      onFirstKey: () => grantPendingNow(env, flux, homeId, clock, fluxOn(env, dependencies)) });
  }

  const account = await (dependencies.currentAccount ?? defaultAccount)(request, auth);
  if (!account) throw new HTTPError(401, "unauthorized");

  if (link) {
    const step = link[1];
    if (step === "/start") {
      if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
      return linkStart(env, config, account.id, now);
    }
    if (step === "/complete") {
      if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
      return linkComplete(request, env, account.id, now);
    }
    if (request.method === "GET") return linkStatus(env, account.id);
    if (request.method === "DELETE") return unlink(env, config, flux, account.id, clock);
    throw new HTTPError(405, "method_not_allowed");
  }

  const homeId = homeMatch![1];
  const action = homeMatch![2];
  // 8b (2.2): the owner mint is closed for every home, before any read or write (no lease, no op, no step-up intent). Every key a home holds came
  // through its own poller. Not behind the flag: no deployed version from the first 8b deploy on can mint an owner key.
  if (action === "/subkey" && request.method === "POST") {
    throw new HTTPError(410, "owner_mint_retired", { message: "Your Cloud takes its own Flux key. Nothing to do here." });
  }
  // Same answer for an unknown home and somebody else's.
  const owner = await (dependencies.ownerOf ?? defaultOwnerOf)(env, homeId);
  if (owner === null || owner !== account.id) throw new HTTPError(404, "not_found");
  if (action === undefined) {
    if (request.method !== "GET") throw new HTTPError(405, "method_not_allowed");
    return homeStatus(env, config, flux, homeId, now);
  }
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  if (action === "/cap") {
    const stepUp = dependencies.stepUp;
    return setCap(env, config, flux, account.id, homeId, await body(request, capSchema), clock, async () => stepUp ? stepUp(request) : false,
      fluxSwitchedOnLive(env, dependencies), request.headers.get("x-murage-site-compat") === "spending-2");
  }
  return ownerStop(env, config, flux, homeId, clock);
}

/** 8b (2.6a iii): ONE D1 batch; both statements bind the SAME `at` (resolved_at = the audit row's at), so the Monday page review counts the action. The
 *  answer is decided by a read AFTER the batch: 404 no such alert, 409 wrong_kind, 409 already_resolved, 200 this batch resolved it. */
async function resolveStoppedKeyLive(env: Env, alertId: string, input: { by: string; reason: string }, at: number): Promise<Response> {
  const [resolved] = await env.DB.batch([
    env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE id=? AND kind='${STOPPED_KEY_LIVE_ALERT}' AND resolved_at IS NULL`).bind(at, alertId),
    env.DB.prepare(`INSERT INTO selfservice_audit (id,home_id,actor,action,outcome,detail,at)
      SELECT ?,a.home_id,'operator','alert_resolve','resolved',json_object('alertId',a.id,'kind',a.kind,'by',?,'reason',?),? FROM cloud_alerts a
      WHERE a.id=? AND a.kind='${STOPPED_KEY_LIVE_ALERT}' AND a.resolved_at=? AND changes() = 1`).bind(crypto.randomUUID(), input.by, input.reason, at, alertId, at),
  ]);
  const row = await env.DB.prepare("SELECT kind,resolved_at FROM cloud_alerts WHERE id=?").bind(alertId).first<{ kind: string; resolved_at: number | null }>();
  if (row === null) throw new HTTPError(404, "not_found");
  if (row.kind !== STOPPED_KEY_LIVE_ALERT) throw new HTTPError(409, "wrong_kind");
  if (resolved.meta.changes === 1) {
    const audit = await env.DB.prepare("SELECT 1 AS x FROM selfservice_audit WHERE action='alert_resolve' AND at=? AND json_extract(detail,'$.alertId')=?").bind(at, alertId).first();
    if (audit !== null) return json({ resolved: true, alertId, resolvedAt: at });
    console.error(JSON.stringify({ message: "alert resolve: the alert closed but its audit row is missing", alertId }));
    throw new HTTPError(500, "internal_error");
  }
  throw new HTTPError(409, "already_resolved");
}

/**
 * Hole 11: the poller's delivery acknowledgement. Only this moves the recorded key expiry to the
 * renewed key's; until then the old expiry stands and renewal stays due. A repeat of an applied ack
 * answers 200 again (a lost response); an ack for anything but the latest unacknowledged mint is refused.
 */
async function ackSubkey(env: Env, homeId: string, input: z.infer<typeof ackRequest>): Promise<{ acked: true }> {
  // 8b (2.5): the ack also records WHICH lifecycle and generation the home took (acked_*), the only delivery proof the "On" answer reads. A row
  // minted before the migration has no pending_lifecycle_version (the NULL arm). SET reads the old row, so the pending_* clears do not race the copies.
  const applied = await env.DB.prepare(`UPDATE flux_home_keys SET key_expires_at=pending_expires_at, last_acked_op_id=pending_op_id,
      acked_lifecycle_version=COALESCE(pending_lifecycle_version,lifecycle_version), acked_generation=pending_generation,
      pending_op_id=NULL, pending_generation=NULL, pending_expires_at=NULL, pending_lifecycle_version=NULL
    WHERE home_id=? AND pending_op_id=? AND state='active' AND billing_hold=0 AND pending_generation=generation
      AND (pending_lifecycle_version IS NULL OR pending_lifecycle_version=lifecycle_version)
      AND (? IS NULL OR pending_generation=?)`)
    .bind(homeId, input.op_id, input.key_generation ?? null, input.key_generation ?? null).run();
  if (applied.meta.changes === 1) {
    await env.DB.prepare("DELETE FROM flux_first_key_retry WHERE home_id=?").bind(homeId).run(); // delivered: the next renewal is due by its own clock
    return { acked: true };
  }
  const prior = await env.DB.prepare("SELECT last_acked_op_id FROM flux_home_keys WHERE home_id=?").bind(homeId).first<{ last_acked_op_id: string | null }>();
  if (prior?.last_acked_op_id === input.op_id) return { acked: true };
  throw new HTTPError(409, "ack_unknown");
}

/** The owner of a Flux owner route: the Supabase member bound to this request (customer-identity.ts), as their MAPPED Cloud
 *  account id (supabase_identities.user_id, the id cloud_homes.owner_id, flux_links.owner_user_id and the grants' homeOwnerOf
 *  use). Never a Better Auth companion id: an unbound request (not Cloud scope) or one without a verified member is null (401),
 *  and there is no fallback to the companion session (Astra B4-PORT P1, ruling A of ASTRA-WP5-P4-CP-2). */
async function defaultAccount(request: Request, _auth: ControlPlaneAuth): Promise<{ id: string } | null> {
  const customer = boundCustomer(request);
  if (!customer) return null;
  const session = await customer.resolve();
  return session ? { id: session.user.id } : null;
}
