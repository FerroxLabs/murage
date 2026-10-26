// SPDX-License-Identifier: AGPL-3.0-or-later
import { fluxRoutesEnabled } from "./b4-flux-config";
import { fluxRenewalDue } from "./b4-flux-renewal";
import { applyServiceLogSoon, serviceLogStatement, SERVICE_ENDS, SERVICE_STARTS } from "./service-intervals";
import { exportPausesDeletion, NO_EXPORT_HOLD_SQL, queueServerReady, readyStamp } from "./legal-flows";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { alertStatement, dropHealth, healthSchema, homeChangeBump, persistResolveUnless, recordHealth } from "./ops-monitor";
import { b3Config, b3Enabled, type B3Config } from "./b3-config";
import { fakeProvider, validateVolume, type ProviderAdapter, type ProviderResource, type VolumeDescriptor, type ResourceRole } from "./b3-provider";
import { consumeDeviceProof, envelopeSchema, signPayload, type SignedEnvelope } from "./b3-signatures";
import { prepareB3Enrollment, bindB3Enrollment, deriveBackupPassword, loadProvisionToken, rotateProvisionToken } from "./cloud-machines";
import { persistAlert, resolveAlertStatement, subjectAlertStatements, UI_INSTANCE } from "./ops-monitor";
import { cloudHomeCloudflare, readConfig } from "./config";
import { allocateMachineEndpoint, expediteMachineEndpointCleanup, type ObservedMachineEndpoint, MACHINE_ENDPOINT_HELD_SQL, releaseUnclaimedMachineEndpoint,
  reopenMachineEndpoint, restoreMachineEndpoint } from "./endpoints";
import { createLiveProvider, HostError, sanitizeProviderMessage } from "./b5-provisioner";
import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";
import { requireInstallation, sha256 } from "./installations";
import { doorV2Required } from "./customer-identity";
import { notePowerHeartbeat } from "./self-service";
import { claimStatements } from "./purchase-bootstrap";
import { DB_NOW, fencedBatch, HomeBusy, LeaseLost, q, withHomeLease, type HomeLease, type Q } from "./billing-lease";
import { dbNow, isAnswered, isNotSent, refusalStatus, settleCall } from "./dispatch-ledger";
import { DELETION_BILLING_OPEN_SQL } from "./subscription-gateway";

// Home <-> control-plane wire version. The home fences any other value (or none).
export const WIRE = 1;
export const LEASE_TTL_MS = 60 * 60_000;
export const LEASE_FRESH_MS = 60_000;
export const LEASE_SKEW_MS = 2 * 60_000;
export const RECOVERY_HOLD_MS = 72 * 60 * 60_000;
export interface B3Dependencies {
  provider?: (db: D1Database) => ProviderAdapter;
  /** The automatic canary's reachability probe transport (tests stub it). Default: the Worker's global fetch. */
  probeFetch?: typeof fetch;
  /** Round 11: the bounds of provider calls (tests shorten them): a dispatched create, and a cleanup call inside the claim's lease. */
  callBoundMs?: { dispatch?: number; cleanup?: number };
  /** Tests only: runs after the admin canary's door read and before its promotion batch (Astra D1 #4's race). */
  afterDoorCheck?: () => Promise<void>;
}
export interface Home {
  id: string; installation_id: string; owner_id: string; desired_state: string; observed_state: string;
  entitlement: string; payment_version: number; generation: number; resource_generation: number;
  /** The subscription whose payment line the home's payment_version belongs to (migration 0105); null before any event named one. */
  payment_line?: string | null;
  reservation_expires_at: number | null; grace_until: number | null; delete_after: number | null;
  /** B3: when the server-ready email was queued (migration 0094); null before the first canary pass. */
  ready_at?: number | null;
  suspension_notices: number; dns_removed_at: number | null; heartbeat_at: number | null;
  /** Why the home is suspended (migration 0105, round 10): 'billing' (grace expiry), 'abuse', 'operator'; NULL for a legacy suspension. */
  suspension_cause?: string | null;
  image_digest: string; canary_json: string | null; home_key: string; created_at: number; updated_at: number;
}
interface Lease { installation_id: string; home_id: string; holder: string; generation: number;
  expires_at: number; renewed_at: number; acknowledged: number; fenced: number; }
export interface Hold { id: string; home_id: string; action: string; generation: number;
  started_at: number; completes_at: number; completed_at: number | null; canceled_at: number | null; signed_proof: string | null;
  source?: string; canceled_by?: string | null; }
const id = z.string().regex(/^[\w-]{1,128}$/);
const key = z.string().min(16).max(128);
const generationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const originSchema = z.string().max(2048).refine((v) => {
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash; }
  catch { return false; }
});
const reserveSchema = z.object({ homeId: id, installationId: id, ownerId: id,
  // With managed_endpoint the control plane allocates the hostname; without it the caller supplies the origin.
  publicOrigin: originSchema.optional(), managed_endpoint: z.boolean().optional(), idempotencyKey: key }).strict();
const paymentSchema = z.object({ eventId: id, homeId: id, version: z.number().int().nonnegative(),
  status: z.enum(["paid", "payment_problem", "canceled"]), paymentId: id,
  /** Astra TAXCOUNTRY-7 P1-a: the subscription this event belongs to (its payment line); absent on legacy entries. */
  subscriptionId: id.optional() }).strict();
const actionSchema = z.object({ generation: generationSchema, idempotencyKey: key,
  action: z.enum(["stop", "start", "delete", "start_fresh", "restore", "cancel_renewal", "pair", "quarantine"]),
  deviceProof: envelopeSchema.optional() }).strict();
const leaseSchema = z.object({ generation: generationSchema, holder: id }).strict();
const canarySchema = z.object({ generation: generationSchema,
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  checks: z.object({ authenticatedUI: z.boolean(), engineRoundTrip: z.boolean(), sandboxedBrowser: z.boolean(),
    writableState: z.boolean(), schedulerHeartbeat: z.boolean() }).strict(),
}).strict();

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}
export async function admin(request: Request, env: Env) {
  if (!env.CLOUD_ADMIN_TOKEN) throw new HTTPError(401, "unauthorized");
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const [a, b] = await Promise.all([sha256(token), sha256(env.CLOUD_ADMIN_TOKEN)]);
  if (!timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b))) throw new HTTPError(401, "unauthorized");
}
export async function home(db: D1Database, homeId: string): Promise<Home> {
  const row = await db.prepare("SELECT * FROM cloud_homes WHERE id=?").bind(homeId).first<Home>();
  if (!row) throw new HTTPError(404, "not_found");
  return row;
}
/** Route-level lookup, run before any credential check. A missing home must be
 *  indistinguishable from an existing one: only an authenticated admin may
 *  learn that it is absent; everyone else gets the same 401 as a bad credential. */
async function routeHome(env: Env, request: Request, homeId: string): Promise<Home> {
  try {
    return await home(env.DB, homeId);
  } catch (error) {
    if (!(error instanceof HTTPError) || error.status !== 404) throw error;
    await admin(request, env);
    throw error;
  }
}
export async function machine(request: Request, env: Env, h: Pick<Home, "id" | "generation">, options: { allowInactive?: boolean } = {}) {
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const row = await env.DB.prepare("SELECT credential_hash,bound_ips,generation,state FROM cloud_machines WHERE id=?")
    .bind(h.id).first<{ credential_hash: string | null; bound_ips: string | null; generation: number; state: string }>();
  const actual = await sha256(token);
  if (!row?.credential_hash || !timingSafeEqual(new TextEncoder().encode(actual), new TextEncoder().encode(row.credential_hash))
    || row.generation !== h.generation || (row.state !== "active" && !options.allowInactive)) throw new HTTPError(401, "unauthorized");
  if (!row.bound_ips || !(JSON.parse(row.bound_ips) as string[]).includes(request.headers.get("CF-Connecting-IP") ?? "")) {
    throw new HTTPError(403, "forbidden");
  }
}
async function seedCapacity(db: D1Database, config: B3Config) {
  if (!config.capacity.length) return;
  await db.batch(config.capacity.map((slot) => db.prepare(`INSERT INTO cloud_capacity
    (id,project_id,location,server_type,outcome) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
    .bind(slot.id, slot.projectId, slot.location, slot.serverType, slot.outcome)));
}
async function replay(db: D1Database, mutationId: string, input: unknown): Promise<Response | null> {
  const previous = await db.prepare("SELECT fingerprint,response FROM cloud_mutations WHERE id=?")
    .bind(mutationId).first<{ fingerprint: string; response: string }>();
  if (!previous) return null;
  if (previous.fingerprint !== await sha256(JSON.stringify(input))) throw new HTTPError(409, "idempotency_conflict");
  return json(JSON.parse(previous.response));
}
function mutation(db: D1Database, mutationId: string, h: string, fingerprint: string, response: unknown) {
  return db.prepare("INSERT INTO cloud_mutations VALUES (?,?,?,?)")
    .bind(mutationId, h, fingerprint, JSON.stringify(response));
}
export function outbox(db: D1Database, h: Home, kind: string, payload: unknown, now: number, eventId = crypto.randomUUID()) {
  return db.prepare(`INSERT INTO cloud_outbox
    (id,home_id,generation,owner_id,kind,payload,created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(eventId, h.id, h.generation, h.owner_id, kind, JSON.stringify(payload), now);
}

async function reserve(request: Request, env: Env, config: B3Config) {
  await admin(request, env);
  return reserveCore(env, config, await body(request, reserveSchema));
}

type ReserveInput = z.infer<typeof reserveSchema>;
async function reserveCore(env: Env, config: B3Config, input: ReserveInput, extra: D1PreparedStatement[] = []) {
  if (input.managed_endpoint ? input.publicOrigin !== undefined : input.publicOrigin === undefined) {
    throw new HTTPError(400, "invalid_request");
  }
  const mutationId = `reserve:${input.idempotencyKey}`;
  const cached = await replay(env.DB, mutationId, input); if (cached) return cached;
  const installation = await env.DB.prepare("SELECT id FROM installations WHERE id=? AND owner_user_id=? AND revoked_at IS NULL")
    .bind(input.installationId, input.ownerId).first();
  if (!installation) throw new HTTPError(403, "forbidden");
  if (await env.DB.prepare("SELECT id FROM cloud_homes WHERE installation_id=? AND desired_state<>'deleted'")
    .bind(input.installationId).first()) throw new HTTPError(409, "home_exists");
  if (await env.DB.prepare("SELECT id FROM cloud_machines WHERE id=?").bind(input.homeId).first()) {
    throw new HTTPError(409, "machine_exists");
  }
  await seedCapacity(env.DB, config);
  const now = Date.now();
  const managed = input.managed_endpoint
    ? allocateMachineEndpoint(env, input.homeId, cloudHomeCloudflare(readConfig(env)).companionHostSuffix, now, true)
    : null;
  const publicOrigin = managed ? managed.origin : new URL(input.publicOrigin as string).origin;
  const response = { fakeOnly: true, homeId: input.homeId, state: "payment_pending", expiresAt: now + config.reservationMs,
    ...(managed ? { publicOrigin, hostname: managed.hostname } : {}) };
  const fingerprint = await sha256(JSON.stringify(input));
  // Slot selection and the unique installation claim happen in one transaction.
  // Unavailable choices are skipped in configured fallback order.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE cloud_capacity SET home_id=?,expires_at=? WHERE id=(SELECT id FROM cloud_capacity
      WHERE outcome='available' AND (home_id IS NULL OR (expires_at IS NOT NULL AND expires_at<=?))
      ORDER BY rowid LIMIT 1) RETURNING id`).bind(input.homeId, now + config.reservationMs, now),
    env.DB.prepare(`INSERT INTO cloud_homes
      (id,installation_id,owner_id,desired_state,observed_state,reservation_expires_at,image_digest,home_key,created_at,updated_at,generation,resource_generation)
      SELECT ?,?,?,'payment_pending','reserved',?,?,?,?,?,
        (SELECT COALESCE(MAX(generation)+1,1) FROM cloud_leases WHERE installation_id=?),
        (SELECT COALESCE(MAX(generation)+1,1) FROM cloud_leases WHERE installation_id=?) WHERE changes()=1`)
      .bind(input.homeId, input.installationId, input.ownerId, now + config.reservationMs,
        config.imageDigest, crypto.randomUUID(), now, now, input.installationId, input.installationId),
    env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
      SELECT ?,id,generation,owner_id,'reserved',?,? FROM cloud_homes WHERE id=? AND changes()=1`)
      .bind(`reserve:${input.homeId}`, JSON.stringify({ publicOrigin }), now, input.homeId),
    ...(managed ? [managed.statement] : []),
    env.DB.prepare(`INSERT INTO cloud_mutations SELECT ?,?,?,? WHERE changes()=1`)
      .bind(mutationId, input.homeId, fingerprint, JSON.stringify(response)),
    // The first-purchase claim rides in this same transaction (purchase-bootstrap.ts claimStatements): its guard aborts it all.
    ...extra,
  ]).catch(async (error: unknown) => {
    const cached = await replay(env.DB, mutationId, input); if (cached) return null;
    if (await env.DB.prepare("SELECT id FROM cloud_homes WHERE installation_id=? AND desired_state<>'deleted'")
      .bind(input.installationId).first()) throw new HTTPError(409, "home_exists");
    throw error;
  });
  if (!results) return (await replay(env.DB, mutationId, input))!;
  if (results[0].meta.changes !== 1) {
    if (await env.DB.prepare("SELECT id FROM cloud_homes WHERE installation_id=? AND desired_state<>'deleted'")
      .bind(input.installationId).first()) throw new HTTPError(409, "home_exists");
    const waitlisted = { fakeOnly: true, state: "waitlisted", checkoutAllowed: false };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cloud_waitlist VALUES (?,?,?) ON CONFLICT DO NOTHING")
        .bind(input.installationId, input.ownerId, now),
      mutation(env.DB, mutationId, input.homeId, fingerprint, waitlisted),
    ]);
    return json(waitlisted, 202);
  }
  return json(response, 201);
}

/** How long a Stripe Checkout session can still complete after it was created (Stripe's default is 24 h, plus slack). */
const CHECKOUT_SESSION_LIFETIME_MS = 25 * 60 * 60_000;

/** Astra INTEGRATED-3 #5 / INTEGRATED-4 #3: what holds an otherwise lapsed reservation, as ONE predicate used by both the candidate read and the
 *  guarded expiry UPDATE (so held rows are never selected only to fail the update and starve later ones): an unresolved issuance marker or a
 *  contract awaiting its payment (a checkout that may still settle), or an open Delete hold. `t`: the cloud_homes alias. */
const EXPIRY_HELD_SQL = (t: string) => `AND NOT EXISTS (SELECT 1 FROM checkout_consents c WHERE c.home_id=${t}.id AND c.rejected_at IS NULL AND c.payment_failed_at IS NULL
            AND (c.session_inflight_at IS NOT NULL OR (c.contract_made_at IS NOT NULL AND c.paid_at IS NULL)))
          AND NOT EXISTS (SELECT 1 FROM cloud_recovery_holds dh WHERE dh.home_id=${t}.id AND dh.action='delete' AND dh.canceled_at IS NULL
            AND dh.completed_at IS NULL)`;
/** Unpaid reservations lapse: the payable home is deleted, its capacity slot and pending endpoint name are released, and the
 *  owner may reserve again. A reservation with a subscription, an unprocessed payment, or a checkout session that could still
 *  complete is left alone, so a late payment still reaches the paid/refund path instead of vanishing.
 *  `settled`: a home of a first-purchase generation whose abandonment was just reconciled completely (purchase-bootstrap.ts
 *  reconcileAbandonment: every Stripe session of its customer terminal, nothing in flight, under the home lease). Its unused reservation is
 *  released now instead of after the session-lifetime delay (Astra TRUSTCODE-2 P2-3); a subscription or an unprocessed payment still keeps it. */
export async function expireReservations(env: Env, now: number, ownerId?: string, settled?: string | null): Promise<number> {
  const rows = await env.DB.prepare(`SELECT h.id,h.generation FROM cloud_homes h
    WHERE h.desired_state='payment_pending' AND h.entitlement='pending'
      AND ((h.reservation_expires_at IS NOT NULL AND h.reservation_expires_at<=?) OR h.id IS ?)
      AND (? IS NULL OR h.owner_id=?)
      AND NOT EXISTS (SELECT 1 FROM billing_subscriptions b WHERE b.home_id=h.id AND (b.subscription_id IS NOT NULL OR (b.updated_at>? AND h.id IS NOT ?)))
      AND NOT EXISTS (SELECT 1 FROM cloud_payment_inbox p WHERE p.home_id=h.id AND p.processed_at IS NULL)
      ${EXPIRY_HELD_SQL("h")}
    ORDER BY h.reservation_expires_at LIMIT 50`)
    .bind(now, settled ?? null, ownerId ?? null, ownerId ?? null, now - CHECKOUT_SESSION_LIFETIME_MS, settled ?? null).all<{ id: string; generation: number }>();
  let expired = 0;
  for (const row of rows.results) {
    const guardId = crypto.randomUUID();
    // Astra INTEGRATED-3 #5: the terminal-settlement evidence is enforced INSIDE the expiry batch (its guarded UPDATE matches nothing, and the
    // whole batch aborts, otherwise), never only in the read above: no subscription, no unprocessed payment, the session-lifetime allowance
    // (or this home's complete abandonment reconciliation), and no checkout that may still settle by other means: an unresolved issuance
    // marker (a saved attempt can still be replayed under its key) or a contract awaiting its payment, whatever the billing row's age. And no
    // Delete hold is waiting: its deletion obligation completes the hold and retires the home on its own terms (RULE B).
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE cloud_homes SET desired_state='deleted',observed_state='deleted',generation=generation+1,updated_at=?
        WHERE id=? AND generation=? AND desired_state='payment_pending' AND entitlement='pending'
          AND NOT EXISTS (SELECT 1 FROM billing_subscriptions b WHERE b.home_id=cloud_homes.id AND (b.subscription_id IS NOT NULL OR (b.updated_at>? AND cloud_homes.id IS NOT ?)))
          AND NOT EXISTS (SELECT 1 FROM cloud_payment_inbox p WHERE p.home_id=cloud_homes.id AND p.processed_at IS NULL)
          ${EXPIRY_HELD_SQL("cloud_homes")}`).bind(now, row.id, row.generation, now - CHECKOUT_SESSION_LIFETIME_MS, settled ?? null),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guardId),
      env.DB.prepare("UPDATE cloud_capacity SET home_id=NULL,expires_at=NULL WHERE home_id=?").bind(row.id),
      env.DB.prepare("DELETE FROM machine_endpoints WHERE machine_id=? AND status='pending' AND tunnel_id IS NULL AND dns_record_id IS NULL").bind(row.id),
      env.DB.prepare(`UPDATE machine_endpoints SET status='deleting',delete_requested_at=?,updated_at=? WHERE machine_id=? AND status NOT IN ('pending','deleting','deleted')`)
        .bind(now, now, row.id),
      env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
        SELECT ?,id,generation,owner_id,'reservation_expired','{}',? FROM cloud_homes WHERE id=?`).bind(`expired:${row.id}`, now, row.id),
      homeChangeBump(env.DB, row.id, { desired_state: "payment_pending", generation: row.generation }, now),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guardId),
    ]).catch(() => null); // a concurrent change aborts the whole batch; the next sweep looks again
    if (results) expired++;
  }
  return expired;
}

/** The 409 a customer sees when they already have a home (journey A6): a plain message and what to do, beside the stable `error` code. For a home
 *  whose setup failed, reason, action and message come from the real payment, refund and cleanup state (Astra JOURNEY-A-1 A6), never a blanket
 *  "being refunded": refunded = the slot is being freed (retireRefundedFailedHome); a refund recorded but not done = being refunded; a payment
 *  billing turned away (voided) = no refund pending; anything else = support sorts it out. A home that did not fail: already_have_home. */
interface BlockingHome { desired_state: string; entitlement: string; voided: number; refund_open: number; checkout_open: number; checkout_alerted: number; billing_open: number }
function homeExists(b: BlockingHome): HTTPError {
  const err = (reason: string, action: string, message: string) => new HTTPError(409, "home_exists", { reason, action, message });
  if (b.desired_state === "failed") {
    // Astra JOURNEY-A-3 #3: a refunded home whose retirement waits on a checkout that may still settle promises no time; once billing's
    // reconciliation could not resolve it with Stripe (home.checkout_unresolved raised), the customer is sent to support.
    if (b.entitlement === "refunded" && b.checkout_alerted === 1) {
      return err("setup_failed_checkout_unresolved", "contact_support",
        "Your last setup did not finish, and your payment was refunded to the card you paid with. We could not yet confirm with our payment provider that no other checkout from that setup can still be paid, and our team has been alerted. Contact support and we will free your account so you can start again.");
    }
    if (b.entitlement === "refunded" && b.checkout_open === 1) {
      return err("setup_failed_checkout_unsettled", "try_again_later",
        "Your last setup did not finish, and your payment was refunded to the card you paid with. We are confirming with our payment provider that no other checkout from that setup can still be paid. You can start again once that is confirmed; if it is not cleared within a day, contact support.");
    }
    if (b.entitlement === "refunded") {
      return err("setup_failed_refunded", "try_again_later",
        "Your last setup did not finish, and your payment was refunded to the card you paid with. We are finishing the cleanup; you can start again in a few minutes.");
    }
    if (b.entitlement === "refund_pending" || b.refund_open === 1) {
      return err("setup_failed_refund_pending", "try_again_later",
        "Your last setup did not finish, and your payment is being refunded to the card you paid with. You can start again as soon as the refund is recorded, usually within a few minutes.");
    }
    if (b.voided === 1) {
      return err("setup_failed_payment_voided", "contact_support",
        "Your last setup did not finish. That payment was turned away, so no refund is pending for this setup. Contact support and we will free your account so you can start again.");
    }
    return err("setup_failed", "contact_support",
      "Your last setup did not finish. Contact support and we will sort out the payment and free your account so you can start again.");
  }
  // Astra INTEGRATED-2 #3: a home the customer deleted that is still finishing says why, in plain words, never "you already have a server".
  if (b.desired_state === "deleting") {
    if (b.checkout_open === 1 || b.billing_open === 1 || b.refund_open === 1) {
      return err("deleting_last_payment", "try_again_later",
        "We are finishing your last payment first. Your old server is deleted once that is done, and then you can start a new one. If this takes more than a day, contact support.");
    }
    return err("deleting", "try_again_later", "Your old server is still being deleted. You can start a new one in a few minutes.");
  }
  return err("already_have_home", "open_my_cloud", "You already have a Murage Cloud server. Open My Cloud to manage it, or cancel it there before starting a new one.");
}

const PORTAL_INSTALLATION = "murage-cloud-portal";
/** The signed-in, stepped-up portal user picks a plan: give them a payable home. One pending reservation per user, ever:
 *  every portal reservation lives on the user's single portal installation, and one live home per installation is a
 *  database-level unique index, so two concurrent calls cannot both succeed. */
export async function reserveHomeForUser(env: Env, userId: string,
  bootstrap?: { sessionId: string; now: number; expected: number | null; release?: string | null }): Promise<Response> {
  const config = b3Config(env);
  const now = Date.now();
  await expireReservations(env, now, userId, bootstrap?.release ?? null);
  // The first purchase on the sign-in alone (purchase-bootstrap.ts): never hands back or works around another live home; the claim below
  // decides eligibility inside the reservation's own batch.
  const refused = () => new HTTPError(403, "step_up_required", { step_up: { bootstrap: false } });
  if (bootstrap && await env.DB.prepare("SELECT id FROM cloud_homes WHERE owner_id=? AND desired_state<>'deleted' LIMIT 1").bind(userId).first()) throw refused();
  const existing = async () => env.DB.prepare(`SELECT id,reservation_expires_at FROM cloud_homes
    WHERE owner_id=? AND desired_state='payment_pending' ORDER BY created_at DESC LIMIT 1`).bind(userId).first<{ id: string; reservation_expires_at: number | null }>();
  const pendingResponse = (h: { id: string; reservation_expires_at: number | null }) =>
    json({ homeId: h.id, state: "payment_pending", expiresAt: h.reservation_expires_at, existing: true });
  const pending = await existing(); if (pending) return pendingResponse(pending);
  const blocking = await env.DB.prepare(`SELECT h.desired_state,h.entitlement,
      EXISTS (SELECT 1 FROM cloud_payment_voids v WHERE v.home_id=h.id) AS voided,
      EXISTS (SELECT 1 FROM cloud_outbox o WHERE o.home_id=h.id AND o.kind='refund_required' AND o.completed_at IS NULL) AS refund_open,
      ${CHECKOUT_MAY_SETTLE_SQL.replaceAll("cloud_homes.id", "h.id")} AS checkout_open,
      EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=h.id AND a.kind='${CHECKOUT_UNRESOLVED_ALERT}' AND a.resolved_at IS NULL) AS checkout_alerted,
      ${DELETION_BILLING_OPEN_SQL.replaceAll("cloud_homes.id", "h.id")} AS billing_open
    FROM cloud_homes h WHERE h.owner_id=? AND h.desired_state<>'deleted' ORDER BY h.created_at DESC LIMIT 1`).bind(userId).first<BlockingHome>();
  if (blocking) throw homeExists(blocking);
  await env.DB.prepare(`INSERT INTO installations (id,owner_user_id,client_instance_id,display_name,platform,created_at,updated_at)
    VALUES (?,?,?,'Murage Cloud portal','linux',?,?) ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), userId, PORTAL_INSTALLATION, now, now).run();
  const installation = await env.DB.prepare("SELECT id FROM installations WHERE owner_user_id=? AND client_instance_id=? AND revoked_at IS NULL")
    .bind(userId, PORTAL_INSTALLATION).first<{ id: string }>();
  if (!installation) throw new HTTPError(409, "installation_unavailable");
  const homeId = `home-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  try {
    const claim = bootstrap ? claimStatements(env, { userId, sessionId: bootstrap.sessionId, homeId, now: bootstrap.now, expected: bootstrap.expected }) : [];
    const response = await reserveCore(env, config, { homeId, installationId: installation.id, ownerId: userId, managed_endpoint: true,
      idempotencyKey: `portal-reserve-${homeId}` }, claim).catch((e: unknown) => {
      // The claim's guard aborted the batch: the account has something to protect, or its authorization is not claimable.
      if (bootstrap && !(e instanceof HTTPError)) throw refused();
      throw e;
    });
    if (response.status !== 201) return response; // 202 waitlisted: no capacity right now
    const created = await response.json() as { homeId: string; expiresAt: number };
    return json({ homeId: created.homeId, state: "payment_pending", expiresAt: created.expiresAt, existing: false }, 201);
  } catch (error) {
    // Lost a race to a concurrent reservation by the same user: hand back the winner.
    if (error instanceof HTTPError && error.message === "home_exists") {
      if (bootstrap) throw refused(); // never another request's home on the sign-in alone (the reserving session's retry returns its own)
      const winner = await existing(); if (winner) return pendingResponse(winner);
    }
    throw error;
  }
}

async function payment(request: Request, env: Env) {
  await admin(request, env); // Synthetic trusted snapshot, deliberately not a Stripe webhook.
  const input = await body(request, paymentSchema);
  await home(env.DB, input.homeId);
  const payload = JSON.stringify(input);
  await env.DB.prepare("INSERT INTO cloud_payment_inbox VALUES (?,?,?,?,?,NULL) ON CONFLICT(id) DO NOTHING")
    .bind(input.eventId, input.homeId, input.version, payload, Date.now()).run();
  const stored = await env.DB.prepare("SELECT payload FROM cloud_payment_inbox WHERE id=?").bind(input.eventId).first<{ payload: string }>();
  if (stored?.payload !== payload) throw new HTTPError(409, "event_conflict");
  return json({ fakeOnly: true, accepted: true }, 202);
}

async function transition(env: Env, h: Home, state: string, kind: string, now: number, bump = false,
  extra: D1PreparedStatement[] = []) {
  const nextGeneration = h.generation + (bump ? 1 : 0);
  const guardId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE cloud_homes SET desired_state=?,generation=?,updated_at=?
      WHERE id=? AND generation=? AND desired_state=? RETURNING id`)
      .bind(state, nextGeneration, now, h.id, h.generation, h.desired_state),
    env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guardId),
    env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
      SELECT ?,id,generation,owner_id,?,'{}',? FROM cloud_homes WHERE id=? AND changes()=1`)
      .bind(crypto.randomUUID(), kind, now, h.id),
    ...(bump ? [env.DB.prepare(`UPDATE cloud_machines SET generation=?,credential_hash=NULL,state='fenced'
      WHERE id=? AND EXISTS(SELECT 1 FROM cloud_homes WHERE id=? AND generation=?)`)
      .bind(nextGeneration, h.id, h.id, nextGeneration),
    env.DB.prepare("UPDATE cloud_enrollment_tokens SET used_at=? WHERE machine_id=? AND used_at IS NULL").bind(now, h.id),
    env.DB.prepare(`UPDATE machine_endpoints SET token_roll_due=1,updated_at=?
      WHERE machine_id=? AND NOT (status='pending' AND tunnel_id IS NULL)`).bind(now, h.id)] : []),
    ...extra,
    ...serviceIntervalStatements(env.DB, h.id, state, now),
    // Every transition but the promotion (checking to ready, whose batch re-checks the evidence at the epoch it read) is a negative
    // event for the home's evidence (Astra AUTOCANARY-11 P2-1: explicit, no trigger).
    ...(h.desired_state === "checking" && state === "ready" ? [] : [homeChangeBump(env.DB, h.id, h, now)]),
    env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guardId),
  ]);
  // The home row's own statement only (RETURNING id): meta.changes counts every row the batch statement touched, triggers included.
  if (results[0].results.length !== 1) throw new HTTPError(409, "state_conflict");
  if (SERVICE_STARTS.includes(state) || SERVICE_ENDS.includes(state)) await applyServiceLogSoon(env, h.id);
}

/** Service actually supplied (withdrawal deductions count only this): it starts when the home passes its canary and is ready, and stops
 *  when the home stops being served. The lifecycle writes only its own journal (service_interval_log) in the same batch as the state change;
 *  service_intervals is billing state and is written from that journal under the home's billing lease (service-intervals.ts). */
function serviceIntervalStatements(db: D1Database, homeId: string, state: string, now: number): D1PreparedStatement[] {
  const s = serviceLogStatement(db, homeId, state, now);
  return s ? [s] : [];
}

/** Binds (homeId, paymentId): true while billing has not turned this payment away (cloud_payment_voids, Astra WP5-6 #1). */
const NOT_VOIDED = "NOT EXISTS(SELECT 1 FROM cloud_payment_voids WHERE home_id=? AND payment_id=?)";
/** Binds (homeId, outboxId): no refund obligation of this home other than this one is still open. A retired home with several late payments
 *  (Astra JOURNEY-A-2 A6) reads 'refunded' only once every one of them is refunded, in whatever order they complete. Astra MAILRETRY-12 P2:
 *  this is the ONLY rule a refund completion uses for the home (no payment-version arm): the home's 'refund_pending' is the aggregate of its
 *  open refund obligations (every write of 'refund_pending' records its obligation in the same batch), so it becomes 'refunded' exactly when
 *  the last open one completes, whichever payment that is. A completion while another obligation is open, or while the home is paid again
 *  (entitlement no longer 'refund_pending'), changes only its own obligation. */
export const NO_OTHER_REFUND_OPEN = "NOT EXISTS(SELECT 1 FROM cloud_outbox WHERE home_id=? AND kind='refund_required' AND completed_at IS NULL AND id<>?)";

/** The home's payment line as one read: its current payment (currentPaymentId) and that line's version (payment_version). */
interface PaymentLine { payment: string | null; version: number }
async function paymentLine(db: D1Database, homeId: string): Promise<PaymentLine> {
  const r = await db.prepare(`SELECT payment_version AS version, ${currentPaymentId("cloud_homes.id")} AS payment FROM cloud_homes WHERE id=?`)
    .bind(homeId).first<PaymentLine>();
  if (!r) throw new Error("home_unknown");
  return r;
}

/** C1's currentPaymentId and PAYMENT_PAID_NEWEST_FIRST (defined below) are the ONE payment authority (Astra TAXCOUNTRY-8 P1-4).
 *  F only: the payment_paid version of the home's current payment (currentPaymentId's row): the version another subscription's paid
 *  event must exceed to take the home. NULL for a home never paid. */
const currentPaidVersion = (home: string) => `(SELECT CAST(json_extract(l.payload,'$.version') AS INTEGER) FROM cloud_outbox l
  WHERE l.home_id=${home} AND l.kind='payment_paid' ${PAYMENT_PAID_NEWEST_FIRST} LIMIT 1)`;

/** The payment-event ordering rule (Astra MAILRETRY-11 P1-B, MAILRETRY-12 P1), per payment line. The home's payment_version is the
 *  version of its CURRENT payment line (the payment it rests on, currentPaymentId, and the subscription's events for it): it only ever rises,
 *  and every event of that line this pass acknowledges at a version above it raises it (applied, or recorded with no effect: a cancellation
 *  of a given-up home included), so an event of the current line at or below it is stale (acknowledged, no effect). An event naming ANOTHER
 *  payment that was given up (its provision-failed refund exists; it is not the current payment) is acknowledged with no effect on the home
 *  at all: its version goes to that payment's own high-water mark (cloud_payment_lines), never to the home's, so it can never make an event
 *  of the current payment stale. Pending events are taken newest version first, so of the current line's events waiting together the newest
 *  decides: an older paid event queued behind a newer cancellation is stale, and a paid event newer than the cancellation applies normally. */

/** Round 10 (Astra TAXCOUNTRY-9 P1-4): binds (homeId, paymentId). The payment was SERVED: a payment_paid hand-off names it. */
const PAYMENT_SERVED = "EXISTS (SELECT 1 FROM cloud_outbox s WHERE s.home_id=? AND s.kind='payment_paid' AND json_extract(s.payload,'$.paymentId')=?)";
/** Astra INTEGRATED-8 P1: binds (homeId, paymentId, homeId, paymentId). THIS payment has a durable handling: it was applied (its own
 *  payment_paid hand-off, or the refund_required its application wrote when no capacity was left), a refund obligation names it, or billing
 *  voided it. A paid entry is acknowledged only once this holds: never on the home's line or version alone (a concurrent deletion or a
 *  higher-version cancellation of the same line defeats the application while leaving the line and version test passing). */
const PAYMENT_HANDLED = `(EXISTS (SELECT 1 FROM cloud_outbox ph WHERE ph.home_id=? AND ph.kind IN ('payment_paid','refund_required')
  AND json_extract(ph.payload,'$.paymentId')=?) OR NOT ${NOT_VOIDED})`;
/** Round 10 (Astra TAXCOUNTRY-9 P1-5): how long a paid, billing-suspended home may wait for its resume before the payment is refunded. */
export const RESUME_DEADLINE_MS = 72 * 3_600_000;
/** Round 10 (P1-5): binds (homeId). The home's suspension is billing-caused (the grace expiry; a legacy NULL cause was that same path) and
 *  no abuse closure stands against it: only such a suspension is ever resumed by a payment. */
const BILLING_SUSPENSION = `EXISTS (SELECT 1 FROM cloud_homes bs WHERE bs.id=? AND bs.desired_state='suspended' AND COALESCE(bs.suspension_cause,'billing')='billing'
  AND NOT EXISTS (SELECT 1 FROM abuse_closures ac WHERE ac.home_id=bs.id)
  AND NOT EXISTS (SELECT 1 FROM billing_subscriptions ab WHERE ab.home_id=bs.id AND ab.abuse_closed_at IS NOT NULL))`;

/** Astra INTEGRATED-9 P1: binds (homeId, version, line, line). A CANCELLATION of the entry's payment line (its subscription; '' for a legacy
 *  entry without one, which matches any line) was acknowledged at or above this version: recorded in cloud_payment_cancellations, kept
 *  independently of the home's current entitlement (a later payment_problem replaces 'canceled' there, never here). */
const CANCELLED_SINCE = `EXISTS (SELECT 1 FROM cloud_payment_cancellations c WHERE c.home_id=? AND c.version>=? AND (c.line='' OR ?='' OR c.line=?))`;
/** The cancellation history row of one entry, recorded only once the entry is acknowledged (for the batch that acknowledges it). */
function cancellationHistoryStatement(db: D1Database, entryId: string, line: string | null, now: number): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO cloud_payment_cancellations (home_id,event_id,line,version,recorded_at)
    SELECT home_id,id,?,version,? FROM cloud_payment_inbox WHERE id=? AND processed_at IS NOT NULL`).bind(line ?? "", now, entryId);
}
/** Astra INTEGRATED-9 P2: RETAINED entries (a pass looked at them and could not acknowledge them: their payment's handling could not be
 *  recorded yet). The first RETAINED_IMMEDIATE retries are on the next pass (a fence that moved is classified again at once); after that the
 *  entry's home waits RETAINED_BACKOFF_BASE_MS doubling up to RETAINED_BACKOFF_MAX_MS (a NEWER entry of the home makes it eligible at once).
 *  An entry retained for RETAINED_PAGE_MS raises ONE high alert (billing.payment_retained, subject: the entry), resolved when it is
 *  acknowledged. Selection is per home, least recently tried first, at most PAYMENT_HOMES_PER_PASS homes: retained entries can never
 *  monopolize a pass. */
export const RETAINED_IMMEDIATE = 3;
export const RETAINED_BACKOFF_BASE_MS = 60_000;
export const RETAINED_BACKOFF_MAX_MS = 3_600_000;
export const RETAINED_PAGE_MS = 3_600_000;
const PAYMENT_HOMES_PER_PASS = 100;
/** Astra INTEGRATED-11/12 P2: page slots (of the 100-entry page) reserved for the DRAINAGE FRONTIER of historical entries. */
const PAYMENT_AGED_SLOTS = 25;
/** INTEGRATED-12 P2: at most this many reserved slots per home per pass (its newest pending entry included). */
const PAYMENT_FRONTIER_PER_HOME = 5;
/** INTEGRATED-13 P2: an entry pending this long since its durable receipt is BACKLOG: the per-home share yields to it (it is always taken
 *  while reserved slots remain), so a home that adds more than its share per pass can never grow an unbounded history. */
export const PAYMENT_BACKLOG_AGE_MS = 15 * 60_000;
/** INTEGRATED-12 P2: THE DRAINAGE FRONTIER. A persisted cursor (cloud_payment_frontier: durable receipt time, then entry id) the reserved
 *  slots of each pass start after, so historical obligations advance across passes whatever a hot home keeps adding: the pass takes the
 *  next pending entries past the cursor, oldest first (their own retry backoff respected), at most PAYMENT_FRONTIER_PER_HOME per home, each
 *  home's NEWEST pending entry taken with them (it is processed first: the newest decides, the ordering rule), and the cursor moves past
 *  the contiguous run it took (back to the start once the end is reached). An older entry taken without every newer entry of its home
 *  (`guarded`) is applied only once nothing newer of its home is pending or it is already stale (at or below the home's version): never
 *  out of order. */
// INTEGRATED-13 P2: the cursor moves only AFTER the page's work is recorded (processPayments runs `advance` once processPaymentEntries
// returned: a crash or a failed pass leaves it where it was, and the next pass takes the same unfinished entries again), and every LAP is
// BOUNDED independently of new arrivals: a lap takes only entries received up to its horizon (the newest receipt time when the lap began,
// cloud_payment_frontier.lap_horizon); anything received later waits for the next lap, so the cursor always reaches the end of its lap and
// wraps, and every retained obligation (one a backoff or a crash skipped included) is reached again within one lap. A BACKLOG entry
// (pending PAYMENT_BACKLOG_AGE_MS since its receipt) is taken whatever its home's share of the pass.
async function paymentFrontier(env: Env, now: number): Promise<{ ids: string[]; guarded: Set<string>; advance: D1PreparedStatement }> {
  const at = await env.DB.prepare("SELECT received_at AS t,entry_id AS id,lap_horizon AS h FROM cloud_payment_frontier WHERE name='payments'")
    .first<{ t: number; id: string; h: number | null }>();
  const horizon = at?.h ?? (await env.DB.prepare("SELECT MAX(received_at) AS h FROM cloud_payment_inbox WHERE processed_at IS NULL").first<{ h: number | null }>())?.h ?? now;
  const limit = PAYMENT_AGED_SLOTS * 4;
  const cand = (await env.DB.prepare(`SELECT i.id,i.home_id,i.received_at AS t,
      (SELECT n.id FROM cloud_payment_inbox n WHERE n.home_id=i.home_id AND n.processed_at IS NULL ORDER BY n.version DESC,n.id LIMIT 1) AS head
    FROM cloud_payment_inbox i LEFT JOIN cloud_payment_retention r ON r.entry_id=i.id
    WHERE i.processed_at IS NULL AND COALESCE(r.next_attempt_at,0)<=?1 AND (i.received_at>?2 OR (i.received_at=?2 AND i.id>?3)) AND i.received_at<=?5
    ORDER BY i.received_at,i.id LIMIT ?4`).bind(now, at?.t ?? -1, at?.id ?? "", limit, horizon)
    .all<{ id: string; home_id: string; t: number; head: string }>()).results;
  const ids: string[] = []; const guarded = new Set<string>(); const perHome = new Map<string, number>();
  let last: { t: number; id: string } | null = null; let contiguous = true; let full = false;
  for (const c of cand) {
    if (ids.includes(c.id)) { if (contiguous) last = c; continue; } // already taken as its home's newest
    const n = perHome.get(c.home_id) ?? 0;
    const head = c.head !== c.id && !ids.includes(c.head);
    const backlog = c.t <= now - PAYMENT_BACKLOG_AGE_MS; // INTEGRATED-13: backlog is taken whatever the home's share
    if (!backlog && n + (head ? 2 : 1) > PAYMENT_FRONTIER_PER_HOME) { contiguous = false; continue; } // this home's share of the pass is taken
    if (ids.length + (head ? 2 : 1) > PAYMENT_AGED_SLOTS) { full = true; break; }
    if (head) ids.push(c.head);
    ids.push(c.id);
    if (c.head !== c.id) guarded.add(c.id);
    perHome.set(c.home_id, n + (head ? 2 : 1));
    if (contiguous) last = c;
  }
  // Everything of this lap past the cursor was taken: the lap is over, the next pass starts a new one from the oldest entry.
  const wrap = !full && contiguous && cand.length < limit;
  const advance = wrap
    ? env.DB.prepare("DELETE FROM cloud_payment_frontier WHERE name='payments'")
    : env.DB.prepare(`INSERT INTO cloud_payment_frontier (name,received_at,entry_id,updated_at,lap_horizon) VALUES ('payments',?1,?2,?3,?4)
        ON CONFLICT(name) DO UPDATE SET received_at=excluded.received_at,entry_id=excluded.entry_id,updated_at=excluded.updated_at,lap_horizon=excluded.lap_horizon`)
      .bind(last?.t ?? at?.t ?? -1, last?.id ?? at?.id ?? "", now, horizon);
  return { ids, guarded, advance };
}
async function retainUnacknowledged(env: Env, ids: string[], now: number): Promise<void> {
  if (ids.length === 0) return;
  const list = JSON.stringify(ids);
  await env.DB.batch([
    // Astra INTEGRATED-10 P2: retained since the entry's durable receipt time, not since a pass first looked at it.
    env.DB.prepare(`INSERT INTO cloud_payment_retention (entry_id,home_id,attempts,first_retained_at,last_attempt_at,next_attempt_at)
      SELECT i.id,i.home_id,1,MIN(?1,i.received_at),?1,?1 FROM cloud_payment_inbox i WHERE i.id IN (SELECT value FROM json_each(?2)) AND i.processed_at IS NULL
      ON CONFLICT(entry_id) DO UPDATE SET attempts=cloud_payment_retention.attempts+1,last_attempt_at=?1,
        next_attempt_at=?1+CASE WHEN cloud_payment_retention.attempts+1<=${RETAINED_IMMEDIATE} THEN 0
          ELSE MIN(${RETAINED_BACKOFF_MAX_MS},${RETAINED_BACKOFF_BASE_MS}*(1<<MIN(cloud_payment_retention.attempts+1-${RETAINED_IMMEDIATE},12))) END`).bind(now, list),
    // ONE page per retained entry once it is overdue.
    env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
      SELECT 'alert:payment_retained:' || r.entry_id,r.home_id,'billing.payment_retained','high',json_object('entryId',r.entry_id,
        'paymentId',json_extract(i.payload,'$.paymentId'),'status',json_extract(i.payload,'$.status'),'version',i.version,'attempts',r.attempts,
        'retainedSince',r.first_retained_at,'rule','a payment entry the reconcile pass cannot acknowledge: its payment needs a handling (applied, refunded or voided) that could not be recorded; it is retried with backoff and never acknowledged without one'),?1,r.entry_id
      FROM cloud_payment_retention r JOIN cloud_payment_inbox i ON i.id=r.entry_id
      WHERE r.paged_at IS NULL AND i.processed_at IS NULL AND r.first_retained_at<=?1-${RETAINED_PAGE_MS} ON CONFLICT DO NOTHING`).bind(now),
    env.DB.prepare(`UPDATE cloud_payment_retention SET paged_at=?1 WHERE paged_at IS NULL AND first_retained_at<=?1-${RETAINED_PAGE_MS}
      AND EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.id='alert:payment_retained:' || cloud_payment_retention.entry_id)`).bind(now),
  ]);
}

async function processPayments(env: Env, config: B3Config, now: number) {
  // Settled retained entries leave the retention table; their page (if any) is resolved.
  await env.DB.batch([
    env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=? WHERE kind='billing.payment_retained' AND resolved_at IS NULL
      AND EXISTS (SELECT 1 FROM cloud_payment_inbox i WHERE i.id=cloud_alerts.subject AND i.processed_at IS NOT NULL)`).bind(now),
    env.DB.prepare(`DELETE FROM cloud_payment_retention WHERE EXISTS (SELECT 1 FROM cloud_payment_inbox i WHERE i.id=cloud_payment_retention.entry_id
      AND i.processed_at IS NOT NULL)`),
    // Astra INTEGRATED-10 P2: an entry no pass has reached yet ages from its durable receipt time too: overdue, it is paged (once, the
    // same alert a retained entry gets) whether or not a pass ever selected it. Bounded, oldest first (cloud_payment_inbox_pending).
    // Astra INTEGRATED-11 P2: an entry already paged is excluded BEFORE the limit (anti-join), so later entries are reached on the next pass.
    env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
      SELECT 'alert:payment_retained:' || i.id,i.home_id,'billing.payment_retained','high',json_object('entryId',i.id,
        'paymentId',json_extract(i.payload,'$.paymentId'),'status',json_extract(i.payload,'$.status'),'version',i.version,'attempts',0,
        'retainedSince',i.received_at,'rule','a payment entry not acknowledged within the overdue window of its receipt (never yet reached by a pass, or retained): it is retried and never acknowledged without its handling'),?1,i.id
      FROM cloud_payment_inbox i WHERE i.processed_at IS NULL AND i.received_at<=?1-${RETAINED_PAGE_MS}
        AND NOT EXISTS (SELECT 1 FROM cloud_payment_retention r WHERE r.entry_id=i.id)
        AND NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.id='alert:payment_retained:' || i.id)
      ORDER BY i.received_at LIMIT 50 ON CONFLICT DO NOTHING`).bind(now),
  ]);
  // Fair selection (Astra INTEGRATED-9 P2): homes with pending entries, least recently tried first, skipping a home whose retained entries
  // are backing off unless something newer arrived for it; then their entries, newest version first (the ordering rule below).
  // Astra INTEGRATED-10 P2: the event slots are shared FAIRLY across the selected homes (each home's entries ranked newest version first,
  // the pass taking rank 1 of every home before rank 2 of any): one hot home can never take the whole page from another selected home.
  // Astra INTEGRATED-11/12 P2: up to PAYMENT_AGED_SLOTS of the 100-entry page are RESERVED for the drainage frontier (paymentFrontier: the
  // next historical entries past a persisted cursor, at most PAYMENT_FRONTIER_PER_HOME per home, each with its home's newest entry); the
  // rest of the page is the fair selection. A hot home that keeps adding entries, or a home behind 100 fresher ones, can never starve an
  // older obligation: the frontier reaches it within (entries ahead of it) / PAYMENT_AGED_SLOTS passes.
  const frontier = await paymentFrontier(env, now);
  const events = await env.DB.prepare(`WITH homes AS (
      SELECT p.home_id,ROW_NUMBER() OVER (ORDER BY MAX(COALESCE(r.last_attempt_at,0)),MIN(p.received_at),p.home_id) AS hr
      FROM cloud_payment_inbox p LEFT JOIN cloud_payment_retention r ON r.entry_id=p.id WHERE p.processed_at IS NULL
      GROUP BY p.home_id HAVING MAX(COALESCE(r.next_attempt_at,0))<=?1 OR MAX(p.received_at)>MAX(COALESCE(r.last_attempt_at,0))
      ORDER BY MAX(COALESCE(r.last_attempt_at,0)),MIN(p.received_at),p.home_id LIMIT ?2),
    ranked AS (SELECT i.id,i.payload,i.version,h.hr,ROW_NUMBER() OVER (PARTITION BY i.home_id ORDER BY i.version DESC,i.id) AS rk
      FROM cloud_payment_inbox i JOIN homes h ON h.home_id=i.home_id WHERE i.processed_at IS NULL),
    aged AS (SELECT value AS id,CAST(key AS INTEGER) AS o FROM json_each(?3)),
    page AS (SELECT id FROM (SELECT id,0 AS p,o AS o1,0 AS o2 FROM aged
      UNION ALL SELECT id,1,rk,hr FROM ranked WHERE id NOT IN (SELECT id FROM aged)) ORDER BY p,o1,o2 LIMIT 100)
    SELECT i.id,i.payload FROM cloud_payment_inbox i WHERE i.id IN (SELECT id FROM page) AND i.processed_at IS NULL ORDER BY i.version DESC,i.id`)
    .bind(now, PAYMENT_HOMES_PER_PASS, JSON.stringify(frontier.ids)).all<{ id: string; payload: string }>();
  // Only an entry whose home has a newer pending entry OUTSIDE this page is guarded (inside it, the newer one is processed first anyway).
  const guarded = frontier.guarded.size === 0 ? new Set<string>() : new Set((await env.DB.prepare(`SELECT g.value AS id FROM json_each(?1) g
      JOIN cloud_payment_inbox x ON x.id=g.value WHERE EXISTS (SELECT 1 FROM cloud_payment_inbox n WHERE n.home_id=x.home_id AND n.processed_at IS NULL
        AND n.version>x.version AND n.id NOT IN (SELECT value FROM json_each(?2)))`)
    .bind(JSON.stringify([...frontier.guarded]), JSON.stringify(events.results.map((e) => e.id))).all<{ id: string }>()).results.map((r) => r.id));
  try {
    await processPaymentEntries(env, config, now, events.results, guarded);
    // INTEGRATED-13 P2: the cursor moves past this page only now that its work is recorded (a crash before here retakes the same page).
    await frontier.advance.run();
  } finally {
    const left = await env.DB.prepare("SELECT value AS id FROM json_each(?) WHERE value IN (SELECT id FROM cloud_payment_inbox WHERE processed_at IS NULL)")
      .bind(JSON.stringify(events.results.map((e) => e.id))).all<{ id: string }>();
    await retainUnacknowledged(env, left.results.map((r) => r.id), now);
  }
}

async function processPaymentEntries(env: Env, config: B3Config, now: number, events: { id: string; payload: string }[], guarded = new Set<string>()) {
  for (const event of events) {
    const input = paymentSchema.parse(JSON.parse(event.payload));
    // INTEGRATED-12 P2: a frontier entry taken without every newer entry of its home waits (left pending, retried) while a newer entry of its
    // home is still pending and it is not already stale: the ordering rule (the newest decides) is never broken to drain history.
    if (guarded.has(event.id) && await env.DB.prepare(`SELECT 1 AS x FROM cloud_payment_inbox n JOIN cloud_homes h ON h.id=n.home_id
        WHERE n.home_id=? AND n.processed_at IS NULL AND n.version>? AND h.payment_version<? LIMIT 1`).bind(input.homeId, input.version, input.version).first()) continue;
    const h = await home(env.DB, input.homeId);
    const acknowledge = env.DB.prepare(`UPDATE cloud_payment_inbox SET processed_at=? WHERE id=?
      AND EXISTS(SELECT 1 FROM cloud_homes WHERE id=? AND
        (payment_version>=? OR desired_state IN ('deleting','deleted')))`)
      .bind(now, event.id, h.id, input.version);
    /** An event handled with no effect on the home but its version: payment_version rises to the event's (never falls), only while `fence`
     *  (binding `binds`) still holds, and the entry is acknowledged only once the home's version covers it (or the home is being deleted). A
     *  fence that no longer holds (another pass re-opened the home since the read) writes nothing: the entry is processed again next pass.
     *  Astra MAILRETRY-13 P1-1: the event was classified against the home's payment line as read (`line`: the current payment and its
     *  version), and the write is a compare-and-set on exactly that line: a newer payment accepted by another pass since the read (the
     *  current payment or the version moved) makes it write nothing, so a given-up payment's late event never raises the version of the
     *  payment that replaced it. The entry is then classified again, against the line as it is then (another payment's line). */
    const versionOnly = (fence: string, binds: unknown[], line: PaymentLine) => [
      env.DB.prepare(`UPDATE cloud_homes SET payment_version=?,updated_at=? WHERE id=? AND payment_version<?
        AND desired_state NOT IN ('deleting','deleted') AND payment_version=? AND ${currentPaymentId("cloud_homes.id")} IS ? AND ${fence}`)
        .bind(input.version, now, h.id, input.version, line.version, line.payment, ...binds),
      acknowledge,
      ...(input.status === "canceled" ? [cancellationHistoryStatement(env.DB, event.id, input.subscriptionId ?? null, now)] : []),
    ];
    // Astra WP5-6 #1: a payment that billing turned away (rejected and refunded) never grants anything. Its tombstone names this home and
    // this payment only. Such an entry is marked handled with no effect on the home; the writes below re-check the tombstone, so an entry
    // read before the rejection was written still changes nothing.
    if (input.status === "paid" && await env.DB.prepare("SELECT 1 AS x FROM cloud_payment_voids WHERE home_id=? AND payment_id=?")
      .bind(h.id, input.paymentId).first() !== null) {
      await env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND processed_at IS NULL").bind(now, event.id).run();
      continue;
    }
    // Astra JOURNEY-A-1/-2 A6: a payment for a failed home that was retired (deleted after its refund) is never acknowledged with no effect:
    // the money is owed back, so it becomes a refund obligation (the same refund_required path a payment without capacity takes). Every such
    // payment gets its OWN obligation, keyed by its payment id (idempotent: a replayed or duplicate entry for the same payment adds nothing),
    // whatever the home's aggregate entitlement says ('refunded', or 'refund_pending' while an earlier late payment is still being refunded)
    // and whatever its version: two distinct late payments are two obligations. The obligation and the acknowledgement are one batch, and the
    // entry is acknowledged only once its obligation (or billing's void of that payment) exists.
    // Astra INTEGRATED-1 #2: the same for a home the CUSTOMER deleted (deleting or deleted) while its purchase was unresolved and never paid
    // (entitlement 'pending'): Delete is never gated, so the purchase that completes afterwards is owed back, recorded atomically with the
    // acknowledgement. The refund operation inherits the home's subscription and ends it (end_plan): the resulting subscription is reconciled.
    // Astra INTEGRATED-8 P1: and a PAID entry for a home being deleted whose payment was never served (no hand-off names it) nor handled
    // otherwise, WHATEVER the home's aggregate entitlement ('paid' included): a deletion that landed between this entry's classification
    // and its application left it unapplied; the unserved money is owed back, never acknowledged away.
    const deletingHome = h.desired_state === "deleted" || h.desired_state === "deleting";
    const unservedOnDeleted = input.status === "paid" && deletingHome && await env.DB.prepare(`SELECT 1 AS x WHERE NOT ${PAYMENT_SERVED} AND NOT ${PAYMENT_HANDLED}`)
      .bind(h.id, input.paymentId, h.id, input.paymentId, h.id, input.paymentId).first() !== null;
    if (input.status === "paid" && deletingHome
      && (h.entitlement === "refunded" || h.entitlement === "refund_pending" || h.entitlement === "pending" || unservedOnDeleted)) {
      const obligation = `refund:retired:${input.paymentId}`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
          SELECT ?,id,generation,owner_id,'refund_required',?,? FROM cloud_homes WHERE id=? AND desired_state IN ('deleting','deleted')
            AND (entitlement IN ('refunded','refund_pending','pending') OR NOT ${PAYMENT_SERVED}) AND ${NOT_VOIDED}
          ON CONFLICT(id) DO NOTHING`)
          .bind(obligation, JSON.stringify(input), now, h.id, h.id, input.paymentId, h.id, input.paymentId),
        env.DB.prepare(`UPDATE cloud_homes SET entitlement='refund_pending',payment_version=MAX(payment_version,?),updated_at=?
          WHERE id=? AND desired_state IN ('deleting','deleted') AND entitlement IN ('refunded','refund_pending','pending')
            AND EXISTS (SELECT 1 FROM cloud_outbox WHERE id=? AND completed_at IS NULL)`)
          .bind(input.version, now, h.id, obligation),
        env.DB.prepare(`UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND processed_at IS NULL
          AND (EXISTS (SELECT 1 FROM cloud_outbox WHERE id=?) OR NOT ${NOT_VOIDED})`).bind(now, event.id, obligation, h.id, input.paymentId),
      ]);
      continue;
    }
    // Astra MAILRETRY-12 P1: an event (paid or not) for a payment that was given up on and is NOT the home's current payment (a newer
    // payment re-opened the home, or was given up after it) belongs to another payment line. It never grants anything (provisionRefundFor)
    // and never changes the current payment's state, so it is acknowledged with no effect on the home: its version is recorded as that
    // payment's own high-water mark only, and the home's payment_version is left alone, so the current payment's own events (a
    // cancellation of B queued with A's late payment_problem) are still applied in their order. Re-checked in the statement; the entry is
    // acknowledged only once its line's mark covers it.
    // Astra MAILRETRY-13 P1-1: the payment line is read BEFORE the event is classified; every no-effect write below is a compare-and-set
    // on it (versionOnly), so a classification made against a line that has changed since writes nothing.
    const payLine = await paymentLine(env.DB, h.id);
    const otherLine = `(${provisionRefundFor("?", "?")} AND ? IS NOT ${currentPaymentId("?")})`;
    const otherLineBinds = [h.id, input.paymentId, input.paymentId, h.id];
    if (await env.DB.prepare(`SELECT 1 AS x WHERE ${otherLine}`).bind(...otherLineBinds).first() !== null) {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO cloud_payment_lines (home_id,payment_id,version,updated_at) SELECT ?,?,?,? WHERE ${otherLine}
          ON CONFLICT(home_id,payment_id) DO UPDATE SET version=MAX(version,excluded.version),updated_at=excluded.updated_at`)
          .bind(h.id, input.paymentId, input.version, now, ...otherLineBinds),
        env.DB.prepare(`UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND processed_at IS NULL
          AND EXISTS (SELECT 1 FROM cloud_payment_lines WHERE home_id=? AND payment_id=? AND version>=?)`)
          .bind(now, event.id, h.id, input.paymentId, input.version),
      ]);
      continue;
    }
    // Astra MAILRETRY-10 P1-2: a payment that was given up on (its provision-failed refund obligation exists, open or done: provisionRefundFor)
    // never grants anything again, whatever its version: a later event for the same invoice is marked handled with no effect (the home keeps
    // its failed state, its refund and its payment version, which that refund's completion matches). The grants below re-check it in their
    // own statements. A genuinely new payment (another invoice) is unaffected.
    // Astra MAILRETRY-11 P1-B: handled with no effect, but its version is recorded (versionOnly), so nothing older applies after it.
    if (input.status === "paid" && await env.DB.prepare(`SELECT 1 AS x WHERE ${provisionRefundFor("?", "?")}`)
      .bind(h.id, input.paymentId).first() !== null) {
      // The given-up payment's own line only: it is the current payment (otherwise it is another line, classified above, next pass).
      await env.DB.batch(versionOnly(`${provisionRefundFor("?", "?")} AND ? IS ?`, [h.id, input.paymentId, input.paymentId, payLine.payment], payLine));
      continue;
    }
    // Astra MAILRETRY-11: the same payment identity for a non-paid event (a failed payment, a cancellation, a dispute). An event for a payment
    // that was given up on (its provision-failed refund obligation, open or done), or any non-paid event while the home still rests on such a
    // payment (failed, its entitlement 'refund_pending' or 'refunded' for the payment of its latest hand-off), is marked handled with no effect
    // on the home: its entitlement and payment version stay what that refund's completion and journey A6's retirement match, so the refund is
    // neither lost nor repeated. Cancellation is not gated: billing records it on the subscription before this hand-off (status canceled,
    // ended_at), and the given-up home has no service left to stop. A genuinely newer payment that re-opened the home (paid, its own hand-off)
    // takes its non-paid events normally. The UPDATE below re-checks it in its own statement.
    // Astra MAILRETRY-11 P1-B: the event's version is still recorded (versionOnly: payment_version rises to it, re-checked in the same
    // statement), so the cancellation stays the ordering fence: an older paid event queued behind it is stale, never a provisioning grant.
    // The refund's completion still marks the home 'refunded' after the version moved: it needs only that no other refund obligation of the
    // home is open (NO_OTHER_REFUND_OPEN, MAILRETRY-12 P2), so the home is never left 'refund_pending' with nothing to complete it.
    if (input.status !== "paid" && await env.DB.prepare(`SELECT 1 AS x WHERE ${provisionRefundFor("?", "?")} OR ${GIVEN_UP_ON_CURRENT_PAYMENT}`)
      .bind(h.id, input.paymentId, h.id).first() !== null) {
      await env.DB.batch(versionOnly(`((${provisionRefundFor("?", "?")} AND ? IS ?) OR ${GIVEN_UP_ON_CURRENT_PAYMENT})`,
        [h.id, input.paymentId, input.paymentId, payLine.payment, h.id], payLine));
      continue;
    }
    // Astra TAXCOUNTRY-7 P1-a: SUBSCRIPTION-SCOPED PAYMENT LINES. Every event billing hands off names the subscription it belongs to
    // (`subscriptionId`; absent on legacy entries and the synthetic route). The home's payment_version is the version of ONE line, the
    // subscription it rests on (payment_line); every other subscription keeps its own high-water mark and whether it is closed (ended by its
    // own cancellation, or left when the home moved to another line) in cloud_subscription_lines.
    // Astra TAXCOUNTRY-8 P1-4/P1-1: ONE payment authority, C1's (currentPaymentId: the payment_paid hand-off of the highest version). The rule:
    //  - an event of the home's line (or one without a subscription, or a home with no line yet) is ordered by the home's version, as before,
    //    fenced on the line as read (P1-3); an applied cancellation closes that line;
    //  - a PAID event of ANOTHER subscription whose line is open takes the home only when its version is above the current payment's
    //    payment_paid version (currentPaidVersion), NOT above payment_version: a later non-paid event of the old line (its payment problem,
    //    its cancellation) never outranks a replacement paid before it (delayed activation). The takeover is a compare-and-set on
    //    payment_version, payment_line and currentPaymentId as read; it moves payment_line, sets payment_version to the event's version (which
    //    may be BELOW the old line's) and closes the line it left;
    //  - a paid event of an open line that cannot take the home (C1's rule keeps the current payment) is owed back: its OWN refund obligation
    //    refund:superseded:<paymentId>, ending THAT subscription (b5-billing.ts), never the home's;
    //  - every other event of another subscription (non-paid, or of a closed line) is recorded on its own line only, with no effect.
    // Composes with the per-payment lines of cloud_payment_lines (Astra MAILRETRY-12, merged separately): those run first and keep a given-up
    // payment's events off the home; this rule then orders what is left by subscription.
    const line = input.subscriptionId ?? null;
    const held = h.payment_line ?? null;
    const lineRow = (sub: string) => env.DB.prepare("SELECT version,closed FROM cloud_subscription_lines WHERE home_id=? AND subscription_id=?")
      .bind(h.id, sub).first<{ version: number; closed: number }>();
    const markLine = (sub: string, version: number, closed: boolean, when: string, binds: unknown[]) => env.DB.prepare(`INSERT INTO cloud_subscription_lines
      (home_id,subscription_id,version,closed,updated_at) SELECT ?,?,?,?,? WHERE ${when}
      ON CONFLICT(home_id,subscription_id) DO UPDATE SET version=MAX(version,excluded.version),closed=MAX(closed,excluded.closed),updated_at=excluded.updated_at`)
      .bind(h.id, sub, version, closed ? 1 : 0, now, ...binds);
    const live = !["deleting", "deleted"].includes(h.desired_state);
    /** Round 10 (Astra TAXCOUNTRY-9 P1-4): a PAID event on a CLOSED line (its contract ended: cancelled, or left for another line) whose
     *  payment was never served is owed back: its OWN refund obligation refund:closed_line:<paymentId>, ending THAT subscription (b5-billing.ts),
     *  while the plan stays closed and the home is untouched. Recorded per payment (served OR refunded, never neither), re-checked in the
     *  statement (the line still closed, the payment still unserved and not voided); acknowledged only once its obligation (or billing's void
     *  of the payment, or its service) exists. */
    const closedLineRefund = async (sub: string) => {
      const obligation = `refund:closed_line:${input.paymentId}`;
      await env.DB.batch([
        markLine(sub, input.version, false, "1", []),
        env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
          SELECT ?,id,generation,owner_id,'refund_required',?,? FROM cloud_homes WHERE id=? AND ${NOT_VOIDED} AND NOT ${PAYMENT_SERVED}
            AND EXISTS (SELECT 1 FROM cloud_subscription_lines WHERE home_id=? AND subscription_id=? AND closed=1)
          ON CONFLICT(id) DO NOTHING`).bind(obligation, JSON.stringify(input), now, h.id, h.id, input.paymentId, h.id, input.paymentId, h.id, sub),
        env.DB.prepare(`UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND processed_at IS NULL
          AND (EXISTS (SELECT 1 FROM cloud_outbox WHERE id=?) OR NOT ${NOT_VOIDED} OR ${PAYMENT_SERVED})`)
          .bind(now, event.id, obligation, h.id, input.paymentId, h.id, input.paymentId),
      ]);
    };
    if (input.status === "paid" && line !== null && (held === null || line === held)) {
      // The home's own line (or its first): closed by its own cancellation, a later paid event never re-opens it (a home never sits paid on
      // a closed line, P1-3); a stale one of an unserved payment is owed back the same way.
      const own = await lineRow(line);
      if (own?.closed === 1 && await env.DB.prepare(`SELECT 1 AS x WHERE NOT ${PAYMENT_SERVED}`).bind(h.id, input.paymentId).first() !== null) {
        await closedLineRefund(line);
        continue;
      }
    }
    let switching = false;
    let targetLine = "none";
    let current: { payment: string | null; version: number | null } = { payment: null, version: null };
    if (line !== null && held !== null && line !== held && live) {
      const own = await lineRow(line);
      current = (await env.DB.prepare(`SELECT ${currentPaymentId("?")} AS payment, ${currentPaidVersion("?")} AS version`).bind(h.id, h.id)
        .first<{ payment: string | null; version: number | null }>()) ?? current;
      const open = own?.closed !== 1;
      targetLine = own ? `${own.version}:${own.closed}` : "none";
      const takes = input.status === "paid" && open && (current.version === null || input.version > current.version);
      if (!takes) {
        if (input.status === "paid" && !open && input.paymentId !== current.payment) { await closedLineRefund(line); continue; }
        if (input.status === "paid" && open && input.paymentId !== current.payment) {
          // Superseded: the money is owed back, recorded atomically with the acknowledgement (idempotent per payment); acknowledged only
          // once its obligation (or billing's void of that payment) exists.
          const obligation = `refund:superseded:${input.paymentId}`;
          // Round 10 (P1-3): only while the home is still NOT on this line (a concurrent pass may have moved it here since the read).
          await env.DB.batch([
            markLine(line, input.version, false, "(SELECT payment_line FROM cloud_homes WHERE id=?) IS NOT ?", [h.id, line]),
            env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
              SELECT ?,id,generation,owner_id,'refund_required',?,? FROM cloud_homes WHERE id=? AND ${NOT_VOIDED} AND payment_line IS NOT ?
              ON CONFLICT(id) DO NOTHING`).bind(obligation, JSON.stringify(input), now, h.id, h.id, input.paymentId, line),
            env.DB.prepare(`UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND processed_at IS NULL
              AND (EXISTS (SELECT 1 FROM cloud_outbox WHERE id=?) OR NOT ${NOT_VOIDED})`).bind(now, event.id, obligation, h.id, input.paymentId),
          ]);
          continue;
        }
        // Round 10 (Astra TAXCOUNTRY-9 P1-3): recorded on its own line only while the home is still NOT on that line: a takeover committed by
        // a concurrent pass since the read makes this write nothing and the entry is classified again next pass (as the home's own line, so
        // a cancellation then ends the home's service instead of closing its line behind it).
        await env.DB.batch([
          markLine(line, input.version, input.status === "canceled", "(SELECT payment_line FROM cloud_homes WHERE id=?) IS NOT ?", [h.id, line]),
          env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND processed_at IS NULL AND changes()=1").bind(now, event.id),
          ...(input.status === "canceled" ? [cancellationHistoryStatement(env.DB, event.id, line, now)] : []),
        ]);
        continue;
      }
      switching = true;
    }
    if ((switching || input.version > h.payment_version) && live) {
      // The version fence: the home still at the version, line and current payment read (a takeover), or (same line, P1-3) still on the
      // line read and below this event: a stale pass never applies one line's event to the line that replaced it.
      // Round 10 (Astra TAXCOUNTRY-9 P1-3): a takeover also fences the TARGET line as read (its version and open state, or its absence): a
      // concurrent close of that line (its cancellation recorded by another pass) fails the takeover, which is classified again next pass.
      const vf = switching ? `payment_version=? AND payment_line IS ? AND ${currentPaymentId("cloud_homes.id")} IS ?
          AND COALESCE((SELECT t.version || ':' || t.closed FROM cloud_subscription_lines t WHERE t.home_id=cloud_homes.id AND t.subscription_id=?),'none')=?`
        : "payment_version<? AND payment_line IS ?";
      const vb: unknown[] = switching ? [h.payment_version, held, current.payment, line, targetLine] : [input.version, held];
      // This event now holds the home (its version and line): its line is recorded (closed by a cancellation), and the line it left closed.
      const holds = "EXISTS (SELECT 1 FROM cloud_homes WHERE id=? AND payment_version=? AND payment_line IS ?)";
      const nextLine = line ?? held;
      // Astra INTEGRATED-7 P1: the entry is acknowledged ONLY against the payment line this batch applied it to: the home rests on that line
      // at (or above) this event's version (or is being deleted). payment_version alone is one line's number: a takeover that failed its
      // compare-and-set (the target line closed meanwhile, or another subscription took the home first) leaves the old line's higher
      // version behind, which must never acknowledge this payment unapplied and unrefunded. Unacknowledged, it is classified again next
      // pass, against the line as it is then (closed: refund:closed_line; superseded: refund:superseded).
      // Astra INTEGRATED-8 P1: a PAID entry is acknowledged only once THIS payment has a durable handling (PAYMENT_HANDLED: applied, owed
      // back, or voided). The line/version test alone passed when a deletion (the old deleting arm) or a higher-version cancellation of the
      // same line committed between this pass's read and this batch, defeating the application. Unacknowledged, it is classified again next
      // pass: a deleted home refunds it (refund:retired), a closed line refunds it (refund:closed_line).
      const acknowledgeApplied = input.status === "paid"
        ? env.DB.prepare(`UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND ${PAYMENT_HANDLED}`)
          .bind(now, event.id, h.id, input.paymentId, h.id, input.paymentId)
        : env.DB.prepare(`UPDATE cloud_payment_inbox SET processed_at=? WHERE id=?
          AND EXISTS(SELECT 1 FROM cloud_homes WHERE id=? AND ((payment_version>=? AND payment_line IS ?) OR desired_state IN ('deleting','deleted')))`)
          .bind(now, event.id, h.id, input.version, nextLine);
      const lines = [
        ...(nextLine ? [markLine(nextLine, input.version, input.status === "canceled", holds, [h.id, input.version, nextLine])] : []),
        ...(switching && held ? [markLine(held, h.payment_version, true, holds, [h.id, input.version, nextLine])] : []),
      ];
      if (input.status === "paid") {
        // Claim/reclaim before entitlement. This also handles payment after expiry.
        const protectedIntent = ["stopped", "suspended"].includes(h.desired_state);
        const target = h.desired_state === "payment_pending" || h.desired_state === "failed" || h.observed_state === "reserved" ? "provisioning"
          : h.desired_state === "payment_problem" ? (h.observed_state === "ready" ? "ready" : "checking") : h.desired_state;
        if (protectedIntent) {
          // Round 10 (Astra TAXCOUNTRY-9 P1-5): THE SUSPENSION POLICY (decision recorded for Sean; recommended option implemented).
          //  - A BILLING-caused suspension (the grace expiry; BILLING_SUSPENSION) that is paid is RESUMED through an executable path: the home
          //    is marked paid, its deletion date cleared, and a resume_required obligation with a deadline (resumeBy, RESUME_DEADLINE_MS)
          //    is written with ONE high alert (persisted, claimed delivery). The reconcile sweep consumes it (settleResumes): resumed (the
          //    operator route /resume moves the home back to checking with a fresh canary budget) or, past the deadline still suspended,
          //    the payment becomes a refund obligation with a high alert and the deletion clock starts again.
          //  - ANY OTHER suspension (abuse, operator, an abuse closure on record) is never resumed by a payment and its deletion is never
          //    cleared: the money becomes its own refund obligation (refund:suspended:<paymentId>) with a high alert; the home is untouched
          //    but for its payment version (the event's ordering fence).
          //  - A stopped home (operator stop or quarantine) keeps the earlier rule: marked paid, still stopped.
          const suspended = h.desired_state === "suspended";
          const billingCaused = suspended && await env.DB.prepare(`SELECT 1 AS x WHERE ${BILLING_SUSPENSION}`).bind(h.id).first() !== null;
          if (suspended && !billingCaused) {
            const obligation = `refund:suspended:${input.paymentId}`;
            const g = crypto.randomUUID();
            await env.DB.batch([
              env.DB.prepare(`UPDATE cloud_homes SET payment_version=?,payment_line=COALESCE(?,payment_line),updated_at=?
                WHERE id=? AND ${vf} AND generation=? AND desired_state='suspended' AND NOT ${BILLING_SUSPENSION}`)
                .bind(input.version, line, now, h.id, ...vb, h.generation, h.id),
              env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(g),
              env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
                SELECT ?,id,generation,owner_id,'refund_required',?,? FROM cloud_homes WHERE id=? AND ${NOT_VOIDED} ON CONFLICT(id) DO NOTHING`)
                .bind(obligation, JSON.stringify(input), now, h.id, h.id, input.paymentId),
              alertStatement(env.DB, { homeId: h.id, kind: "billing.suspended_payment_refunded", severity: "high",
                detail: `payment ${input.paymentId}${line ? ` (subscription ${line})` : ""} arrived for a home suspended for a reason other than billing: it is never resumed by a payment and its deletion stands; the payment is refunded (${obligation})` }, now),
              env.DB.prepare("UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND processed_at IS NULL").bind(now, event.id),
              ...lines,
              env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(g),
            ]).catch(() => undefined); // the fence moved: classified again next pass
            continue;
          }
          const resumeBy = now + RESUME_DEADLINE_MS;
          await env.DB.batch([
            env.DB.prepare(`UPDATE cloud_homes SET entitlement='paid',payment_version=?,payment_line=COALESCE(?,payment_line),updated_at=?,
              delete_after=CASE WHEN desired_state='suspended' THEN NULL ELSE delete_after END
              WHERE id=? AND ${vf} AND generation=? AND desired_state=? AND ${NOT_VOIDED} AND NOT ${provisionRefundFor("?", "?")}
                AND (desired_state<>'suspended' OR ${BILLING_SUSPENSION})`)
              .bind(input.version, line, now, h.id, ...vb, h.generation, h.desired_state, h.id, input.paymentId, h.id, input.paymentId, h.id),
            env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
              SELECT ?,id,generation,owner_id,'payment_paid',?,? FROM cloud_homes WHERE id=? AND changes()=1`)
              .bind(`payment:${input.eventId}`, JSON.stringify(input), now, h.id),
            ...(suspended ? [env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
              SELECT ?,id,generation,owner_id,'resume_required',?,? FROM cloud_homes WHERE id=? AND EXISTS (SELECT 1 FROM cloud_outbox WHERE id=?)
              ON CONFLICT(id) DO NOTHING`)
              .bind(`resume_required:${input.eventId}`, JSON.stringify({ paymentId: input.paymentId, subscriptionId: line, version: input.version, resumeBy }), now, h.id,
                `payment:${input.eventId}`),
            env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,?
              WHERE EXISTS (SELECT 1 FROM cloud_outbox WHERE id=? AND created_at=?) ON CONFLICT DO NOTHING`)
              .bind(crypto.randomUUID(), h.id, "billing.resume_required", "high",
                `billing-suspended home paid (payment ${input.paymentId}${line ? `, subscription ${line}` : ""}): its deletion is cancelled; resume it by ${new Date(resumeBy).toISOString()} (unquarantine the server, then POST /v1/machines/${h.id}/resume); otherwise the payment is refunded automatically`,
                now, `resume_required:${input.eventId}`, now)] : []),
            acknowledgeApplied,
            ...lines,
          ]);
          continue;
        }
        await env.DB.batch([
          env.DB.prepare(`UPDATE cloud_capacity SET home_id=?,expires_at=NULL
            WHERE id=(SELECT id FROM cloud_capacity WHERE outcome='available'
              AND (home_id=? OR home_id IS NULL OR (expires_at IS NOT NULL AND expires_at<=?))
              ORDER BY CASE WHEN home_id=? THEN 0 ELSE 1 END,rowid LIMIT 1)
            AND EXISTS(SELECT 1 FROM cloud_homes WHERE id=? AND ${vf} AND generation=? AND desired_state=?) AND ${NOT_VOIDED}
            AND NOT ${provisionRefundFor("?", "?")}`)
            .bind(h.id, h.id, now, h.id, h.id, ...vb, h.generation, h.desired_state, h.id, input.paymentId, h.id, input.paymentId),
          env.DB.prepare(`UPDATE cloud_homes SET entitlement=CASE WHEN changes()=1 THEN 'paid' ELSE 'refund_pending' END,
            payment_version=?,payment_line=COALESCE(?,payment_line),desired_state=CASE WHEN changes()=1 THEN ? ELSE 'failed' END,grace_until=NULL,updated_at=?
            WHERE id=? AND ${vf} AND generation=? AND desired_state=? AND ${NOT_VOIDED} AND NOT ${provisionRefundFor("?", "?")}`)
            .bind(input.version, line, target, now, h.id, ...vb, h.generation, h.desired_state, h.id, input.paymentId, h.id, input.paymentId),
          env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
            SELECT ?,id,generation,owner_id,CASE WHEN entitlement='paid' THEN 'payment_paid' ELSE 'refund_required' END,?,?
            FROM cloud_homes WHERE id=? AND changes()=1`)
            .bind(`payment:${input.eventId}`, JSON.stringify(input), now, h.id),
          acknowledgeApplied,
          homeChangeBump(env.DB, h.id, h, now), // payment_problem back to checking (or failed): Astra AUTOCANARY-11 P2-1
          ...lines,
        ]);
      } else {
        await env.DB.batch([
          env.DB.prepare(`UPDATE cloud_homes SET entitlement=?,payment_version=?,payment_line=COALESCE(?,payment_line),
            desired_state=CASE WHEN desired_state IN ('ready','checking','payment_problem') THEN 'payment_problem' ELSE desired_state END,
            grace_until=CASE WHEN desired_state IN ('ready','checking','payment_problem') THEN ? ELSE grace_until END,
            updated_at=? WHERE id=? AND ${vf} AND generation=? AND desired_state=?
              AND NOT ${provisionRefundFor("?", "?")} AND NOT ${GIVEN_UP_ON_CURRENT_PAYMENT}`)
            .bind(input.status, input.version, line, input.status === "canceled" ? now : h.grace_until ?? now + config.graceMs, now, h.id, ...vb, h.generation, h.desired_state,
              h.id, input.paymentId, h.id),
          env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
            SELECT ?,id,generation,owner_id,'payment_problem',?,? FROM cloud_homes WHERE id=? AND changes()=1`)
            .bind(`payment:${input.eventId}`, JSON.stringify(input), now, h.id),
          acknowledgeApplied,
          ...(input.status === "canceled" ? [cancellationHistoryStatement(env.DB, event.id, line, now)] : []),
          homeChangeBump(env.DB, h.id, h, now), // checking to payment_problem: Astra AUTOCANARY-11 P2-1
          ...lines,
        ]);
      }
    } else if (input.status === "paid" && live && await env.DB.prepare(`SELECT 1 AS x WHERE NOT ${PAYMENT_SERVED} AND NOT ${PAYMENT_HANDLED}`)
        .bind(h.id, input.paymentId, h.id, input.paymentId, h.id, input.paymentId).first() !== null) {
      // Astra INTEGRATED-8/-9 P1: a STALE paid entry (a newer event of its line holds the home) that was never served nor handled. EVERY paid
      // acknowledgement needs a payment-specific handling: applied, owed back or voided. Overtaken by a CANCELLATION of its line at or above
      // its version (CANCELLED_SINCE: the cancellation history, so a later payment_problem replacing 'canceled' changes nothing; or the home
      // still cancelled), its unserved money is owed back: refund:closed_line, recorded with the acknowledgement and re-checked in the
      // statement. Otherwise it is RETAINED, never acknowledged away: retried with backoff and paged when overdue (retainUnacknowledged).
      const lineKey = input.subscriptionId ?? "";
      const cancelled = `((entitlement='canceled' AND payment_version>=?) OR ${CANCELLED_SINCE})`;
      const cancelledBinds = [input.version, h.id, input.version, lineKey, lineKey];
      const obligation = `refund:closed_line:${input.paymentId}`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
          SELECT ?,id,generation,owner_id,'refund_required',?,? FROM cloud_homes WHERE id=? AND ${cancelled}
            AND ${NOT_VOIDED} AND NOT ${PAYMENT_SERVED} ON CONFLICT(id) DO NOTHING`)
          .bind(obligation, JSON.stringify(input), now, h.id, ...cancelledBinds, h.id, input.paymentId, h.id, input.paymentId),
        env.DB.prepare(`UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND processed_at IS NULL AND ${PAYMENT_HANDLED}`)
          .bind(now, event.id, h.id, input.paymentId, h.id, input.paymentId),
      ]);
    } else if (input.status === "paid") {
      // A paid entry is acknowledged only against its OWN payment's handling (served, applied, owed back or voided), never the home's version.
      await env.DB.prepare(`UPDATE cloud_payment_inbox SET processed_at=? WHERE id=? AND processed_at IS NULL AND (${PAYMENT_SERVED} OR ${PAYMENT_HANDLED})`)
        .bind(now, event.id, h.id, input.paymentId, h.id, input.paymentId, h.id, input.paymentId).run();
    } else {
      await env.DB.batch([acknowledge, ...(input.status === "canceled" ? [cancellationHistoryStatement(env.DB, event.id, input.subscriptionId ?? null, now)] : [])]);
    }
  }
}

function checkedResources(resources: ProviderResource[], h: Home, role: ResourceRole) {
  if (resources.length > 1 || resources.some((r) => r.home_id !== h.id || r.generation !== h.resource_generation || r.role !== role)) {
    throw new Error("provider_identity_conflict");
  }
  return resources;
}
async function destroyVolumes(provider: ProviderAdapter, h: Home) {
  for (const resource of checkedResources(await provider.list_by_tag(h.id, h.resource_generation, "volume"), h, "volume")) {
    const v = validateVolume(await provider.volume(resource.id), h.id, h.resource_generation);
    if (v.id !== resource.id) throw new Error("provider_volume_conflict");
    if (v.attachment.serverId !== null) {
      const detached = validateVolume(await provider.detach_volume(v.id, v.attachment.serverId), h.id, h.resource_generation);
      if (detached.attachment.state !== "detached" || detached.attachment.serverId !== null) throw new Error("provider_attachment_pending");
    }
    await provider.destroy(v.id);
  }
}
async function cleanStaleProvision(env: Env, h: Home, provider: ProviderAdapter) {
  const current = await home(env.DB, h.id);
  if (!["stopped", "suspended", "deleting", "deleted"].includes(current.desired_state)) return;
  const resources = checkedResources(await provider.list_by_tag(h.id, h.resource_generation, "home"), h, "home");
  for (const r of resources) {
    await provider.fence_network(r.id, b3Config(env).quarantineRelayIP);
    await provider.power_off(r.id);
  }
  // Preserve the original continuous DNS removal TTL, including a late create.
  if (current.dns_removed_at !== null && Date.now() >= current.dns_removed_at + 60_000
    && ["deleting", "deleted"].includes(current.desired_state)) {
    await destroyVolumes(provider, h);
    for (const r of resources) await provider.destroy(r.id);
  }
}
interface ProvisionIntent {
  home_id: string; cp_generation: number; resource_generation: number; token_hash: string;
  volume_phase: "pending" | "claimed" | "created"; server_phase: "pending" | "claimed" | "created";
  volume_id: string | null; server_id: string | null; volume_json: string | null; state: "pending" | "bound" | "failed";
}
/** Where a new home enrolls. Fake mode keeps the inert test origin; live mode must be the Worker's own public origin. */
function controlPlaneOriginFor(env: Env): string {
  if (env.CLOUD_B3_MODE !== "live") return "https://admin.murage.test";
  return originSchema.parse(new URL(env.BETTER_AUTH_URL).origin);
}
/** Provisioning budget: a home that has not become ready after this many failed attempts or this long is given up on. */
export const PROVISION_MAX_ATTEMPTS = 5;
export const PROVISION_MAX_MS = 60 * 60_000;
const PROVISION_LEASE_MS = 2 * 60_000;
/** Exponential backoff after the nth failed attempt: 1, 2, 4, 8 minutes (the cron sweep itself runs every 5). */
export const provisionBackoffMs = (failed: number) => Math.min(60_000 * 2 ** Math.max(0, failed - 1), 10 * 60_000);

/** Staging-only fault injection for the retry proof. CLOUD_STAGING_FAULT="<step>:<n>" makes <step> fail on the first n
 *  attempts. Inert unless CLOUD_CP0_STAGING=1, so production cannot honour it even if the variable were set. */
type FaultStep = "create_volume" | "create_server" | "after_create_server" | "attach_volume" | "bind";
function faultFor(env: Env, failedSoFar: number): (step: FaultStep) => void {
  const e = env as { CLOUD_CP0_STAGING?: string; CLOUD_STAGING_FAULT?: string };
  const m = e.CLOUD_CP0_STAGING === "1" ? /^(create_volume|create_server|after_create_server|attach_volume|bind):(\d{1,2})$/.exec(e.CLOUD_STAGING_FAULT ?? "") : null;
  return (step) => { if (m && m[1] === step && failedSoFar < Number(m[2])) throw new Error("injected_fault"); };
}
const SAFE_ERRORS = new Set(["provider_identity_conflict", "provider_ip_missing", "reservation_missing", "machine_identity_conflict",
  "machine_creation_failed", "no_capacity", "provider_unconfigured", "provision_choice_missing", "storage_boxes_full", "injected_fault",
  "provision_intent_conflict", "provider_volume_conflict", "provider_attachment_conflict", "enrollment_delivery_expired"]);
/** Operator-facing failure code: our own error codes, or the hosting provider's API error code (a short token such as
 *  resource_limit_exceeded; it never carries customer data or secrets). Anything else is reduced to provider_error. */
const errorCode = (error: unknown) => error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message
  : error instanceof HostError && /^[a-z0-9_]{1,60}$/.test(error.code) ? `host_${error.status}_${error.code}`.slice(0, 80)
  : error instanceof Error && /^http_\d{3}$/.test(error.message) ? error.message : "provider_error";
/** Operator-only: the provider's own message for a refusal, sanitized (no ids, tokens, emails or IPs; at most 200 characters). */
const errorDetail = (error: unknown) => error instanceof HostError ? sanitizeProviderMessage(error.providerMessage) : null;

/** The home (bound: id, generation) is still paid and provisioning at the generation the caller read. */
const STILL_PROVISIONING_PAID = "EXISTS(SELECT 1 FROM cloud_homes WHERE id=? AND generation=? AND desired_state='provisioning' AND entitlement='paid')";
/** Astra MAILRETRY-10: payment identity. The payment a home's entitlement rests on is the one its payment_paid hand-off of the HIGHEST
 *  journaled payment version names (the same row giveUp refunds). Astra MAILRETRY-11 P1-A: chosen by that version only, never by a
 *  timestamp: a sweep that accepted a newer invoice with an earlier `now` than another sweep's hand-off still makes the newer invoice the
 *  current payment. `home` is an SQL expression for the home id. */
const PAYMENT_PAID_NEWEST_FIRST = "ORDER BY CAST(json_extract(l.payload,'$.version') AS INTEGER) DESC,l.rowid DESC";
const currentPaymentId = (home: string) => `(SELECT json_extract(l.payload,'$.paymentId') FROM cloud_outbox l
  WHERE l.home_id=${home} AND l.kind='payment_paid' ${PAYMENT_PAID_NEWEST_FIRST} LIMIT 1)`;
/** Astra MAILRETRY-10 P1-2/P1-3: the durable failed-provision record of ONE payment: its provision-failed refund obligation, open or done.
 *  The obligation key is per payment, refund:provision_failed:<home>:<paymentId>; a give-up committed before this change carries the
 *  home-scoped key refund:provision_failed:<home>. Both carry the payment in their payload (the payment_paid hand-off), so this matches
 *  either: a payment is never given up (refunded) twice across the deploy boundary, and a payment with this record never provisions again. */
const provisionRefundFor = (home: string, payment: string) => `EXISTS (SELECT 1 FROM cloud_outbox r WHERE r.home_id=${home}
  AND r.kind='refund_required' AND substr(r.id,1,24)='refund:provision_failed:' AND json_extract(r.payload,'$.paymentId')=${payment})`;
/** Astra MAILRETRY-11: binds (homeId). The home is given up on for the payment it rests on: failed, its entitlement that payment's refund
 *  ('refund_pending' or 'refunded'), and that payment (its latest payment_paid hand-off) has a provision-failed refund obligation. */
const GIVEN_UP_ON_CURRENT_PAYMENT = `EXISTS (SELECT 1 FROM cloud_homes g WHERE g.id=? AND g.desired_state='failed'
  AND g.entitlement IN ('refund_pending','refunded') AND ${provisionRefundFor("g.id", currentPaymentId("g.id"))})`;
/** Astra MAILRETRY-10: the never-attempted clock. The time the home's CURRENT payment was first accepted by the lifecycle: the earliest
 *  payment_paid hand-off naming that payment (a later, higher-version event for the same payment does not move it; a genuinely new payment,
 *  a new invoice, starts its own clock); failing that, the earliest journaled inbox event for the home's payment version (received_at);
 *  updated_at only for a home with no payment record at all (its give-up alert says "refund by hand"). `h` is the cloud_homes alias. */
const paymentAcceptedAt = (h: string) => `COALESCE(
  (SELECT MIN(o.created_at) FROM cloud_outbox o WHERE o.home_id=${h}.id AND o.kind='payment_paid'
    AND json_extract(o.payload,'$.paymentId')=${currentPaymentId(`${h}.id`)}),
  (SELECT MIN(i.received_at) FROM cloud_payment_inbox i WHERE i.home_id=${h}.id AND i.version=${h}.payment_version),
  ${h}.updated_at)`;

/** MAILRETRY-12 round 8b: a NEW payment re-opens a home given up on for an earlier payment. The earlier payment's setup attempt left its
 *  per-home records behind: a provision intent in state 'failed' (cloud_provision_intents is one row per home), a fenced machine row, the
 *  home's keys and that attempt's provider resources, tagged with the home's resource generation. Re-provisioning at the same resource
 *  generation met that failed intent (provision_intent_conflict on every attempt, then a refund: a paying customer who never gets a home).
 *  The rule: the new payment's setup is a NEW resource generation with a fresh intent, machine, keys and token; the old attempt's intent is
 *  superseded (moved verbatim, its wrapped token dropped, into cloud_provision_intents_superseded, keyed by home and resource generation and
 *  naming the payment that superseded it), never reused. Cleanup: the new generation starts only once the old generation's resources are
 *  released and recorded (cleaned_at); while they are not, this pass releases them first (idempotent, the same release the failed-home
 *  branch performs, which no longer runs for a home that is provisioning). Waiting keeps one owner for the old resources (released and
 *  recorded once, never skipped); the new generation keeps a late or lingering old-generation resource (or its provider choice, label or
 *  idempotency key) from ever being adopted by the new attempt. Everything is one fenced batch: still paid and provisioning at the
 *  generations read, the current payment not given up, the old resources cleaned, and no intent or machine left that is not the failed
 *  attempt's; otherwise nothing is written. Returns the re-read home, or null when the budget was not re-opened. */
async function reopenGivenUp(env: Env, h: Home, provider: ProviderAdapter, now: number): Promise<Home | null> {
  const payment = await env.DB.prepare(`SELECT ${currentPaymentId("?")} AS id, ${provisionRefundFor("?", currentPaymentId("?"))} AS given_up`)
    .bind(h.id, h.id, h.id).first<{ id: string | null; given_up: number }>();
  if (!payment || payment.given_up) return null;
  const budget = await env.DB.prepare("SELECT cleaned_at FROM provision_attempts WHERE home_id=? AND resource_generation=? AND gave_up_at IS NOT NULL")
    .bind(h.id, h.resource_generation).first<{ cleaned_at: number | null }>();
  if (!budget) return null;
  if (budget.cleaned_at === null) await releaseFailedResources(env, h, provider, now); // the old generation, released and recorded first
  // Round 8c: the same wait for the old generation's endpoint. A home has one endpoint row for life (stable hostname = public origin), so the
  // new generation reuses it, and only once the old tunnel and DNS record are deleted (the cleanup sweep, once): never a 'deleting' row
  // claimed, never the old tunnel serving the new generation, never two tunnels on one hostname. Until then nothing is re-opened (the
  // cleanup is asked for now); the batch below re-proves it and puts the row back to 'pending'.
  // Astra MAILRETRY-13 P1-2: the row is read once, and the cleanup asked for is a compare-and-set on exactly that row and this resource
  // generation: a pass that resumes after the old endpoint was deleted and the new generation claimed the row writes nothing.
  const endpoint = await env.DB.prepare(`SELECT ${MACHINE_ENDPOINT_HELD_SQL} AS held, e.machine_id AS present, e.status, e.generation, e.tunnel_id, e.dns_record_id
    FROM (SELECT 1) LEFT JOIN machine_endpoints e ON e.machine_id=?`)
    .bind(h.id, h.id).first<{ held: number; present: string | null } & ObservedMachineEndpoint>();
  if (endpoint?.held) { await expediteMachineEndpointCleanup(env, h.id, endpoint, h.resource_generation, now); return null; }
  let restore: D1PreparedStatement | null = null;
  if (!endpoint?.present) { // a row a give-up of an earlier build deleted (never claimed): the managed hostname comes back as it was
    const reserved = await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE home_id=? AND kind='reserved'").bind(h.id).first<{ payload: string }>();
    let suffix: string | null = null;
    try { suffix = cloudHomeCloudflare(readConfig(env)).companionHostSuffix; } catch { suffix = null; }
    const origin = reserved ? (JSON.parse(reserved.payload) as { publicOrigin?: unknown }).publicOrigin : null;
    if (typeof origin === "string") restore = restoreMachineEndpoint(env.DB, h.id, origin, suffix, now);
  }
  const g = crypto.randomUUID();
  let guards = 0;
  const guard = (sql: string, ...binds: unknown[]) => env.DB.prepare(`INSERT INTO cloud_write_guards VALUES (?,${sql})`).bind(`${g}:${guards++}`, ...binds);
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE provision_attempts SET attempts=0,first_at=?,next_at=0,last_error=NULL,last_error_detail=NULL,gave_up_at=NULL,
          give_up_code=NULL,cleaned_at=NULL,probed_at=NULL,ui_missing_since=NULL,resource_generation=?
        WHERE home_id=? AND resource_generation=? AND gave_up_at IS NOT NULL AND cleaned_at IS NOT NULL AND ${STILL_PROVISIONING_PAID}
          AND NOT ${provisionRefundFor("?", currentPaymentId("?"))} AND ${currentPaymentId("?")} IS ?`)
        .bind(now, h.resource_generation + 1, h.id, h.resource_generation, h.id, h.generation, h.id, h.id, h.id, payment.id),
      guard("changes()"),
      env.DB.prepare(`UPDATE cloud_homes SET resource_generation=resource_generation+1,updated_at=?
        WHERE id=? AND generation=? AND resource_generation=? AND desired_state='provisioning' AND entitlement='paid'`)
        .bind(now, h.id, h.generation, h.resource_generation),
      guard("changes()"),
      // The old attempt's intent, kept as it was (its token was revoked at the give-up; the wrapped copy is not kept).
      env.DB.prepare(`INSERT INTO cloud_provision_intents_superseded (home_id,resource_generation,cp_generation,token_hash,volume_phase,server_phase,
          volume_claim,server_claim,volume_id,server_id,volume_json,state,failure_code,created_at,superseded_by_payment,superseded_at)
        SELECT home_id,resource_generation,cp_generation,token_hash,volume_phase,server_phase,volume_claim,server_claim,volume_id,server_id,
          volume_json,state,failure_code,created_at,?,? FROM cloud_provision_intents WHERE home_id=? AND state='failed' AND resource_generation=?`)
        .bind(payment.id ?? "", now, h.id, h.resource_generation),
      env.DB.prepare("DELETE FROM cloud_provision_intents WHERE home_id=? AND state='failed' AND resource_generation=?").bind(h.id, h.resource_generation),
      guard("NOT EXISTS (SELECT 1 FROM cloud_provision_intents WHERE home_id=?)", h.id),
      env.DB.prepare("DELETE FROM cloud_machines WHERE id=? AND state='fenced' AND credential_hash IS NULL").bind(h.id),
      guard("NOT EXISTS (SELECT 1 FROM cloud_machines WHERE id=?)", h.id),
      env.DB.prepare("DELETE FROM cloud_home_keys WHERE home_id=?").bind(h.id),
      env.DB.prepare("UPDATE cloud_enrollment_tokens SET used_at=? WHERE machine_id=? AND used_at IS NULL").bind(now, h.id),
      reopenMachineEndpoint(env.DB, h.id, now),
      ...(restore ? [restore] : []),
      guard(`NOT ${MACHINE_ENDPOINT_HELD_SQL}`, h.id), // the old endpoint released (read above), re-proved in the batch
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id LIKE ?").bind(`${g}:%`),
    ]);
  } catch (error) {
    if (fenceMiss(error)) return null; // changed since the read (given up, re-paid, another run re-opened it): nothing written
    throw error;
  }
  return home(env.DB, h.id);
}

/** One provisioning pass with a retry budget. Safe to call every sweep: attempts are serialized by a short lease, a failed
 *  attempt backs off, every provider step is idempotent (find by label before create), and the enrollment token is stored
 *  wrapped so each retry re-delivers it. After the budget the home is given up on (resources released, payment refunded). */
async function provision(env: Env, h: Home, provider: ProviderAdapter, now: number) {
  await env.DB.prepare("INSERT INTO provision_attempts (home_id,resource_generation,first_at) VALUES (?,?,?) ON CONFLICT(home_id) DO NOTHING")
    .bind(h.id, h.resource_generation, now).run();
  let row = (await env.DB.prepare("SELECT * FROM provision_attempts WHERE home_id=?").bind(h.id)
    .first<{ resource_generation: number; attempts: number; first_at: number; next_at: number; last_error: string | null; gave_up_at: number | null }>())!;
  // Astra MAILRETRY-13 P1-3: the budget row belongs to ONE setup attempt, its resource generation. A pass holding an older read of the home
  // (the row has moved on to a newer generation: a reopen committed since) touches nothing of it.
  if (row.resource_generation !== h.resource_generation) return;
  if (row.gave_up_at !== null) { // a later payment re-opened a given-up home: a fresh budget
    // Astra MAILRETRY-9: only while the home is STILL paid and provisioning at the generation this run read. A give-up committed since the
    // read (an overlapping invocation's overdue pass, which also writes this row for a home never attempted) leaves the home 'failed': its
    // budget is not re-opened, and nothing is provisioned for a home whose payment is being refunded.
    // Astra MAILRETRY-10 P1-2: and only for a payment that was never given up. The give-up's refund obligation is that payment's durable
    // failed-provision record (provisionRefundFor): while it exists, open or refunded, the same payment (any version of the same invoice)
    // never re-opens the budget; a genuinely new payment (a new invoice) does.
    const h2 = await reopenGivenUp(env, h, provider, now);
    if (!h2) return;
    h = h2;
    row = { ...row, attempts: 0, first_at: now, next_at: 0, last_error: null, gave_up_at: null };
  }
  if (row.attempts >= PROVISION_MAX_ATTEMPTS || now - row.first_at >= PROVISION_MAX_MS) {
    await giveUp(env, h, provider, row.attempts >= PROVISION_MAX_ATTEMPTS ? (row.last_error ?? "provision_failed") : "provision_timeout", now);
    return;
  }
  // The lease also proves the budget is open and the home still paid and provisioning (Astra MAILRETRY-9): a give-up committed since the read
  // matches nothing here. One committed while this attempt runs is refused by the provider steps' own fence (cloud_provision_intents: state
  // 'failed', home no longer 'provisioning'), and its cleanup is the failed-home branch's.
  const lease = await env.DB.prepare(`UPDATE provision_attempts SET next_at=? WHERE home_id=? AND resource_generation=? AND next_at<=? AND gave_up_at IS NULL
      AND ${STILL_PROVISIONING_PAID}`)
    .bind(now + PROVISION_LEASE_MS, h.id, h.resource_generation, now, h.id, h.generation).run();
  if (lease.meta.changes !== 1) return; // backing off, another sweep holds the attempt, or the home was given up since it was read
  try {
    await provisionOnce(env, h, provider, now, faultFor(env, row.attempts));
    await env.DB.prepare("UPDATE provision_attempts SET next_at=0 WHERE home_id=? AND resource_generation=? AND gave_up_at IS NULL")
      .bind(h.id, h.resource_generation).run();
  } catch (error) {
    const code = errorCode(error);
    const failed = row.attempts + 1;
    // Astra MAILRETRY-13 P1-3: the attempt's result is written to ITS budget only, keyed by (home, resource generation) and still open. A late
    // failure of an attempt given up since (the overdue pass) or superseded (a new payment re-opened the home at the next resource generation)
    // matches nothing and is dropped: it never counts against the new attempt's budget, and never gives anything up.
    const counted = await env.DB.prepare(`UPDATE provision_attempts SET attempts=?,next_at=?,last_error=?,last_error_detail=?
      WHERE home_id=? AND resource_generation=? AND gave_up_at IS NULL`)
      .bind(failed, now + provisionBackoffMs(failed), code, errorDetail(error), h.id, h.resource_generation).run();
    if (counted.meta.changes === 1 && failed >= PROVISION_MAX_ATTEMPTS) { await giveUp(env, h, provider, code, now); return; }
    throw error;
  }
}

/** Fail the home for good: free its resources, refund the payment in full through the existing refund outbox (Stripe
 *  idempotency key refund:<paymentId>; one refund obligation per payment, refund:provision_failed:<home>:<paymentId>), queue the customer
 *  email and raise an ops alert.
 *  Astra MAILRETRY-9: giveUp performs NO external I/O before its commit. Two single-row D1 reads, then ONE D1 batch that holds everything the
 *  give-up owes: the fenced failed state, the refund obligation, the customer email (outbox), the budget's give-up mark (written even for a
 *  home whose budget was never opened, so the failed-home branch owns its cleanup: gave_up_at set, cleaned_at NULL) and the ops alert row
 *  (persisted undelivered, subjectAlertStatements; sweepMonitoring delivers it later). All of it commits, or none of it (the write guard aborts the
 *  whole batch when the fence matches nothing). The provider cleanup (network) follows only after the commit, and only when `release`. */
async function giveUp(env: Env, h: Home, provider: ProviderAdapter, code: string, now: number, release = true,
  overdue?: { cutoff: number; never: boolean }) {
  // Astra MAILRETRY-11 P1-A: the current payment by journaled version (currentPaymentId), never by time; the batch below re-checks it.
  const paid = await env.DB.prepare(`SELECT payload FROM cloud_outbox l WHERE l.home_id=? AND l.kind='payment_paid' ${PAYMENT_PAID_NEWEST_FIRST} LIMIT 1`)
    .bind(h.id).first<{ payload: string }>();
  const attempts = await env.DB.prepare("SELECT attempts,last_error,last_error_detail FROM provision_attempts WHERE home_id=? AND resource_generation=?")
    .bind(h.id, h.resource_generation).first<{ attempts: number; last_error: string | null; last_error_detail: string | null }>();
  // The provider's sanitized words, when the give-up code is the refusal they explain (operator alert only, never the customer email).
  const providerSaid = attempts?.last_error_detail && attempts.last_error === code ? `; provider said: ${attempts.last_error_detail}` : "";
  // Astra MAILRETRY-10 P1-3: the refund obligation is keyed per payment (refund:provision_failed:<home>:<paymentId>), so a second payment
  // given up on the same home gets its own obligation; one for the same payment under either key (provisionRefundFor) is never repeated.
  const paidId = paid ? (JSON.parse(paid.payload) as { paymentId?: unknown }).paymentId : null;
  if (paid && (typeof paidId !== "string" || !paidId)) throw new Error("payment_identity_missing");
  const emailId = paid ? `provision_failed:${h.id}:${paidId as string}` : `provision_failed:${h.id}`;
  const alertSubject = paid ? paidId as string : "none";
  // Astra MAILRETRY-10 P1-1: the overdue pass's give-up re-proves, inside the batch, what it selected the home for: still overdue (a budget
  // still open and past its deadline; or, never attempted, still no open budget, so no live lease, and its payment accepted before the
  // cutoff). Every give-up is also fenced on the payment version it read: a payment accepted since the read matches nothing.
  const overdueFence = !overdue ? "" : overdue.never
    ? ` AND NOT EXISTS (SELECT 1 FROM provision_attempts p WHERE p.home_id=cloud_homes.id AND p.gave_up_at IS NULL) AND ${paymentAcceptedAt("cloud_homes")}<=?`
    : " AND EXISTS (SELECT 1 FROM provision_attempts p WHERE p.home_id=cloud_homes.id AND p.resource_generation=cloud_homes.resource_generation AND p.gave_up_at IS NULL AND p.first_at<=?)";
  const guard = crypto.randomUUID();
  await env.DB.batch([
    // A payment whose provision-failed refund is already done (a give-up from before this change, the same payment re-given-up) reads
    // 'refunded', never 'refund_pending' with no obligation left to complete it.
    env.DB.prepare(`UPDATE cloud_homes SET desired_state='failed',observed_state='failed',updated_at=?,
      entitlement=CASE WHEN entitlement='paid' AND ? THEN CASE WHEN EXISTS (SELECT 1 FROM cloud_outbox r WHERE r.home_id=cloud_homes.id
          AND r.kind='refund_required' AND substr(r.id,1,24)='refund:provision_failed:' AND json_extract(r.payload,'$.paymentId')=?
          AND r.completed_at IS NOT NULL) THEN 'refunded' ELSE 'refund_pending' END ELSE entitlement END
      WHERE id=? AND generation=? AND resource_generation=? AND desired_state=? AND payment_version=?${paid ? ` AND ${currentPaymentId("cloud_homes.id")}=?` : ""}${overdueFence}`)
      .bind(now, paid ? 1 : 0, paidId, h.id, h.generation, h.resource_generation, h.desired_state, h.payment_version, ...(paid ? [paidId] : []),
        ...(overdue ? [overdue.cutoff] : [])),
    env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guard),
    // Round 8d: the attempt given up is identified by its RESOURCE generation (the setup attempt's own identity), never by the control-plane
    // generation: a /rotate (or any other credential bump) since the attempt began moves cp_generation away from the intent's, and the
    // attempt must still be marked failed, or reopenGivenUp refuses and the next payment is refunded instead of set up. The batch is fenced
    // (first statement + guard) on the home still being at this resource generation, so an intent of a NEWER resource generation (a reopen
    // that committed first) is never matched: the whole batch aborts, and the bind below names only the generation being given up.
    env.DB.prepare("UPDATE cloud_provision_intents SET state='failed',failure_code=? WHERE home_id=? AND resource_generation=? AND state IN ('pending','bound')")
      .bind(code, h.id, h.resource_generation),
    env.DB.prepare("UPDATE cloud_enrollment_tokens SET used_at=? WHERE machine_id=? AND used_at IS NULL").bind(now, h.id),
    // Round 8d: the home's one machine row, whatever its credential generation (a staging /retire bumps the machine's alone). It belongs to
    // the resource generation being given up: a reopen deletes it in the same batch that moves the home to the next resource generation, and
    // this batch is fenced on the home still being at h.resource_generation.
    env.DB.prepare("UPDATE cloud_machines SET state='fenced',credential_hash=NULL WHERE id=? AND state IN ('pending_binding','active')")
      .bind(h.id),
    env.DB.prepare("UPDATE cloud_capacity SET home_id=NULL,expires_at=NULL WHERE home_id=?").bind(h.id),
    // Round 8c: the home's endpoint row is kept (its hostname is the home's public origin, reused should a new payment set it up again,
    // reopenGivenUp): never claimed, it is released at once; claimed, its tunnel and DNS record are deleted by the cleanup sweep.
    releaseUnclaimedMachineEndpoint(env.DB, h.id, now),
    // The deletion is requested for the resource generation given up (Astra MAILRETRY-13 P1-2: honoured only while the home is still at it).
    env.DB.prepare(`UPDATE machine_endpoints SET status='deleting',delete_requested_at=?,delete_resource_generation=?,updated_at=?
      WHERE machine_id=? AND status NOT IN ('pending','deleting','deleted')`)
      .bind(now, h.resource_generation, now, h.id),
    // Astra MAILRETRY-13 P1-3: the budget of the attempt given up, its resource generation (the batch is fenced on the home being at it).
    env.DB.prepare(`INSERT INTO provision_attempts (home_id,resource_generation,first_at,gave_up_at,give_up_code) VALUES (?,?,?,?,?)
      ON CONFLICT(home_id) DO UPDATE SET gave_up_at=excluded.gave_up_at,give_up_code=excluded.give_up_code,cleaned_at=NULL,
        cleanup_claim=NULL,cleanup_claimed_until=NULL
      WHERE provision_attempts.resource_generation=excluded.resource_generation`)
      .bind(h.id, h.resource_generation, now, now, code),
    ...(paid ? [env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) SELECT ?,?,?,?,'refund_required',?,?
      WHERE NOT ${provisionRefundFor("?", "?")} ON CONFLICT(id) DO NOTHING`)
      .bind(`refund:provision_failed:${h.id}:${paidId}`, h.id, h.generation, h.owner_id, paid.payload, now, h.id, paidId),
      // Astra MAILRETRY-13 P1-5: the obligation's own payment identity, captured with it: the invoice (the payment id) and the subscription
      // that invoice provably belongs to now (the home's subscription whose FIRST invoice it is; otherwise left unknown here and resolved
      // from the invoice itself when the refund operation opens). Never "the home's current subscription" at some later time: a new
      // payment that re-opens the home brings its own subscription, which this refund must never end. Written only with the obligation.
      env.DB.prepare(`INSERT INTO cloud_refund_identities (obligation_id,home_id,payment_id,subscription_id,captured_at)
        SELECT ?,?,?,(SELECT s.subscription_id FROM billing_subscriptions s WHERE s.home_id=? AND s.first_invoice_id=?),?
        WHERE EXISTS (SELECT 1 FROM cloud_outbox WHERE id=? AND created_at=?) ON CONFLICT(obligation_id) DO NOTHING`)
        .bind(`refund:provision_failed:${h.id}:${paidId}`, h.id, paidId, h.id, paidId, now, `refund:provision_failed:${h.id}:${paidId}`, now)] : []),
    // Astra MAILRETRY-11: the customer's failed-setup email (and its notice, keyed from this row) is per payment too. An old home-scoped
    // row, provision_failed:<home> (no payment in it), was written by the build that also keyed the refund home-scoped: it stands for the
    // ONE payment whose refund obligation carries that legacy key, refund:provision_failed:<home> (the deploy-boundary rule of the refunds,
    // provisionRefundFor), never for a payment matched by time (Astra MAILRETRY-11 P2-A). So that payment is never emailed twice across
    // the boundary, and every other payment gets its own email. A give-up with no payment record keeps the home-scoped key (one per home).
    env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) SELECT ?,?,?,?,'provision_failed',?,?
      WHERE ${!paid ? "1=1" : `NOT EXISTS (SELECT 1 FROM cloud_outbox e WHERE e.id=? AND EXISTS (SELECT 1 FROM cloud_outbox r
        WHERE r.id=? AND r.home_id=e.home_id AND r.kind='refund_required' AND json_extract(r.payload,'$.paymentId')=?))`}
      ON CONFLICT(id) DO NOTHING`).bind(emailId, h.id, h.generation, h.owner_id,
      JSON.stringify({ code, attempts: attempts?.attempts ?? 0, refunded: Boolean(paid), ...(paid ? { paymentId: paidId } : {}) }), now,
      ...(paid ? [`provision_failed:${h.id}`, `refund:provision_failed:${h.id}`, paidId] : [])),
    // One provision.failed alert per payment, raised only with that payment's email (a payment already given up raises nothing again).
    ...subjectAlertStatements(env.DB, { homeId: h.id, kind: "provision.failed", severity: "high", subject: alertSubject,
      detail: `home given up after ${attempts?.attempts ?? 0} failed attempts (${code}${providerSaid}); ${paid ? "full refund queued" : "NO payment record found, refund by hand"} [payment ${alertSubject}]` },
      "EXISTS (SELECT 1 FROM cloud_outbox WHERE id=? AND created_at=?)", [emailId, now], now),
    homeChangeBump(env.DB, h.id, h, now), // the home leaves its state for failed (Astra AUTOCANARY-11 P2-1)
    env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guard),
  ]);
  // A home given up on no longer waits for its render: provision.failed carries it from here (Astra AUTOCANARY-5 P2).
  await resolveAlertStatement(env.DB, h.id, UI_RENDER_MISSING_ALERT, now).run();
  if (!release) return; // the caller releases the resources itself (giveUpOverdue: after every give-up of its pass has committed)
  try { await releaseFailedResources(env, { ...h, desired_state: "failed" }, provider, now); }
  catch (error) { // not silent; the failed-home branch retries it (gave_up_at set, cleaned_at NULL) until nothing is left
    console.error(JSON.stringify({ message: "b3 give-up cleanup failed", homeId: h.id, errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown" }));
  }
}

/** Overdue homes given up per batch of the overdue pass (giveUpOverdue), oldest first. */
export const OVERDUE_GIVE_UP_BATCH = 25;
/** Batches per pass: at most 100 give-ups per invocation; more wait for the next invocation, oldest first (none starves: the order is age). */
export const OVERDUE_PASS_MAX_BATCHES = 4;
/** No give-up (nor cleanup) is started once the pass has run this long; the rest wait for the next invocation (or the failed-home branch). */
export const OVERDUE_PASS_BUDGET_MS = 120_000;
/** The write guard's CHECK(ok=1) refusing a give-up batch: the fence matched nothing, so nothing of it was written. */
const fenceMiss = (error: unknown) => error instanceof Error && /CHECK constraint failed/i.test(error.message);
/** Astra MAILRETRY-8 P1: the give-up of a paid home that is overdue (still provisioning, or booted but never ready, PROVISION_MAX_MS after its
 *  budget opened) must not wait behind the per-home work order (the cursor page, where slow homes ahead of it and the customer-waiting loops
 *  first in the invocation could push it past Cloudflare's 15-minute wall in every run). This pass runs before the cursor page, with the same
 *  giveUp and the same fenced batch (a home already given up, or changed since the read, matches nothing and writes nothing).
 *  Astra MAILRETRY-9: (1) zero external I/O until every selected give-up has committed: giveUp(release=false) is D1 only (the alert is a row in
 *  its batch, delivered later by sweepMonitoring), and the provider cleanup of all of them follows, each in its own try/catch, a failure logged
 *  and left to the cursor page's failed-home branch (gave_up_at set, cleaned_at NULL); that branch is in the cursor page, so under the
 *  MAILRETRY-8 load it can be starved: the money is not (the obligations are committed), the provider resources and A6 retirement wait.
 *  (2) A paid home that is provisioning with NO open budget (provision() never ran for this payment: the budget row is created only there)
 *  is overdue PROVISION_MAX_MS after its current payment was accepted (paymentAcceptedAt: the payment's first payment_paid hand-off, else
 *  its journaled inbox event, updated_at only with no payment record) and is given up with provision_never_attempted. Astra MAILRETRY-10
 *  P1-1: the give-up's own batch re-proves it (no open budget, so no live lease; still past the cutoff; the payment version it read), so a
 *  run that opens the budget or takes the lease after this pass's SELECT makes the give-up match nothing. (3) Bound: one give-up is 2 single-row D1 reads plus ONE D1 batch of at most 16 statements, no network; a batch
 *  is one SELECT plus at most 25 give-ups; at most OVERDUE_PASS_MAX_BATCHES batches. OVERDUE_PASS_BUDGET_MS is a pass-ADMISSION bound, not a
 *  deadline: no give-up (nor a batch SELECT) is started after 120 s of pass time, and one already started runs to its end, so the last commit
 *  lands within 120 s plus one give-up's D1 time (2 reads and a batch) of the pass's start. The pass itself starts only after the
 *  customer-waiting loops (two loops, each admitting attempts of at most EVENT_MAX_MS = 60 s within its own 120 s budget: 240 s of attempts
 *  at worst, the stored-event claim writes now inside each attempt's timeout) and reconcileB3's DB-only preamble. So admission of new
 *  give-ups stops by ~360 s (240 + 120) plus D1 overhead (the loops' own SELECTs, the preamble, the last give-up's batch), which a slow D1
 *  stretches and nothing here bounds. More than 100
 *  overdue homes, or a slow D1, drain over consecutive invocations, oldest first. No external I/O before every give-up has committed.
 *  Returns the failures. */
async function giveUpOverdue(env: Env, provider: ProviderAdapter, now: number): Promise<number> {
  type Overdue = Home & { budget_attempts: number; budget_last_error: string | null; due_from: number; never_attempted: number };
  const cutoff = now - PROVISION_MAX_MS;
  const passStart = Date.now();
  const inBudget = () => Date.now() - passStart < OVERDUE_PASS_BUDGET_MS;
  let failures = 0;
  const given: Home[] = [];
  const tried = new Set<string>();
  for (let batch = 0; batch < OVERDUE_PASS_MAX_BATCHES && inBudget(); batch++) {
    // provision_attempts has one row per home that ever had a budget (one scan of it plus primary-key lookups); the never-attempted branch
    // reads the paid provisioning homes only.
    const overdue = await env.DB.prepare(`SELECT * FROM (
        SELECT h.*,p.attempts AS budget_attempts,p.last_error AS budget_last_error,p.first_at AS due_from,0 AS never_attempted
          FROM provision_attempts p JOIN cloud_homes h ON h.id=p.home_id AND h.resource_generation=p.resource_generation
          WHERE p.gave_up_at IS NULL AND p.first_at<=? AND h.entitlement='paid' AND h.desired_state IN ('provisioning','checking')
        UNION ALL
        SELECT h.*,0,NULL,${paymentAcceptedAt("h")},1
          FROM cloud_homes h
          WHERE h.entitlement='paid' AND h.desired_state='provisioning'
            AND NOT EXISTS (SELECT 1 FROM provision_attempts p WHERE p.home_id=h.id AND p.gave_up_at IS NULL))
      WHERE due_from<=? ORDER BY due_from,id LIMIT ${OVERDUE_GIVE_UP_BATCH}`).bind(cutoff, cutoff).all<Overdue>();
    const fresh = overdue.results.filter((r) => !tried.has(r.id));
    if (!fresh.length) break;
    for (const row of fresh) {
      if (!inBudget()) break;
      tried.add(row.id);
      const { budget_attempts: attempts, budget_last_error: lastError, due_from: _due, never_attempted: never, ...h } = row;
      // The code the cursor page would record: provision() for a home still provisioning, the checking branch's home_never_ready otherwise.
      const code = never ? "provision_never_attempted" : h.desired_state === "checking" ? "home_never_ready"
        : attempts >= PROVISION_MAX_ATTEMPTS ? (lastError ?? "provision_failed") : "provision_timeout";
      try {
        // The batch re-proves the selection (Astra MAILRETRY-10 P1-1): still overdue at this cutoff, same payment version.
        await giveUp(env, h, provider, code, now, false, { cutoff, never: Boolean(never) });
        given.push({ ...h, desired_state: "failed" });
      } catch (error) {
        // The fence matched nothing: the home changed since the read (ready, re-paid, given up by another run) or is no longer overdue (an
        // overlapping run opened its budget or holds its lease). The batch is atomic, so nothing was written and nothing is owed here; a
        // home that is still overdue is selected again, freshly read, by the next pass.
        if (fenceMiss(error)) continue;
        const errorCode = error instanceof Error ? error.message.slice(0, 80) : "unknown";
        const current = await env.DB.prepare(`SELECT h.generation,h.desired_state,p.gave_up_at FROM cloud_homes h
          LEFT JOIN provision_attempts p ON p.home_id=h.id WHERE h.id=?`).bind(h.id)
          .first<{ generation: number; desired_state: string; gave_up_at: number | null }>().catch(() => null);
        if (current?.desired_state === "failed" && current.gave_up_at !== null) {
          // Any other error with the home given up: the batch is atomic, so this run's (its answer lost) or an overlapping run's give-up
          // committed every obligation with it. Not silent, and its cleanup is still owed: tried below, else the failed-home branch's.
          console.error(JSON.stringify({ message: "b3 overdue give-up outcome unconfirmed", homeId: h.id, state: h.desired_state, errorCode }));
          given.push({ ...h, desired_state: "failed" });
          continue;
        }
        failures++;
        console.error(JSON.stringify({ message: "b3 overdue give-up failed", homeId: h.id, state: h.desired_state, errorCode }));
      }
    }
    if (overdue.results.length < OVERDUE_GIVE_UP_BATCH) break;
  }
  // Every selected give-up has committed (or failed and been reported): only now any network, the provider cleanup.
  for (const h of given) {
    if (!inBudget()) break; // the rest: the cursor page's failed-home branch
    try { await releaseFailedResources(env, h, provider, now); }
    catch (error) { // not silent; the failed-home branch retries until nothing is left (gave_up_at set, cleaned_at NULL)
      console.error(JSON.stringify({ message: "b3 overdue cleanup failed", homeId: h.id, errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown" }));
    }
  }
  return failures;
}

/** Journey A6: a home given up on whose payment was refunded and whose resources are all released no longer holds its owner's slot:
 *  it becomes `deleted` (the same end state as an expired reservation), which frees the installation for a new reservation (the one-live-home
 *  unique index) and stops blocking POST /v1/billing/reserve. The refund receipt (entitlement `refunded`, the provision_failed email) is
 *  recorded before this can match; nothing here touches money. A failed home still waiting for its refund, or for its cleanup, stays. A voided
 *  payment alone does not retire a home: a failed home that is waiting for a payment can still be served by a replacement order's own payment.
 *  Astra JOURNEY-A-1 A6: retirement is serialized with billing (the home's billing lease, which every payment hand-off and checkout takes) and
 *  the write itself proves, atomically, that nothing can still settle on this home: no payment entry waiting in the lifecycle inbox, no refund
 *  obligation still open, and no checkout of this home that could still complete or still be paid. Otherwise the home stays failed and the next
 *  pass looks again; a paid entry that does arrive later is processed against the failed home (provisioning, or a refund obligation).
 *  Astra JOURNEY-A-2 A6: only terminal settlement evidence counts, never age. Every checkout of the home must be one of: rejected (billing
 *  voids and refunds its money itself); its payment failed (async_payment_failed); never sent to Stripe (no session id and no request in
 *  flight); unsubmitted with its current session expired (the checkout.session.expired webhook, session_expired_at); or paid, its payment
 *  handed to this inbox and refunded (entitlement 'refunded', the inbox drained, no refund obligation open). A submitted checkout still
 *  waiting for its asynchronous payment (contract made, not paid, not failed) keeps the home, however old it is; so does a session request
 *  whose answer was never recorded (session_inflight_at) until that session's own expiry is recorded. */
/** Astra JOURNEY-A-3 #3: billing's sweep (b5-billing reconcileSessionMarker) reconciles every session request in flight against Stripe by
 *  its issuance id under the home's billing lease; one Stripe cannot resolve (no session of that issuance, or a completed session whose
 *  completion was never recorded) for longer than CHECKOUT_UNRESOLVED_ALERT_MS raises this alert. The marker itself is never cleared on age. */
export const CHECKOUT_UNRESOLVED_ALERT = "home.checkout_unresolved";
export const CHECKOUT_UNRESOLVED_ALERT_MS = 6 * 60 * 60_000;
export const CHECKOUT_MAY_SETTLE_SQL = `EXISTS (SELECT 1 FROM checkout_consents c WHERE c.home_id=cloud_homes.id
  AND c.rejected_at IS NULL AND c.payment_failed_at IS NULL
  AND (c.session_inflight_at IS NOT NULL
    OR (c.contract_made_at IS NULL AND c.stripe_session_id IS NOT NULL AND c.session_expired_at IS NULL)
    OR (c.contract_made_at IS NOT NULL AND c.paid_at IS NULL)))`;
async function retireRefundedFailedHome(env: Env, homeId: string, now: number): Promise<void> {
  try {
    await withHomeLease(env, homeId, (lease) => fencedBatch(env, lease, [q(`UPDATE cloud_homes SET desired_state='deleted',observed_state='deleted',generation=generation+1,updated_at=?
      WHERE id=? AND desired_state='failed' AND entitlement='refunded'
        AND NOT EXISTS (SELECT 1 FROM provision_attempts p WHERE p.home_id=cloud_homes.id AND p.gave_up_at IS NOT NULL AND p.cleaned_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM cloud_payment_inbox i WHERE i.home_id=cloud_homes.id AND i.processed_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM cloud_outbox o WHERE o.home_id=cloud_homes.id AND o.kind='refund_required' AND o.completed_at IS NULL)
        AND NOT ${CHECKOUT_MAY_SETTLE_SQL}`, now, homeId),
      homeChangeBump(env.DB, homeId, { desired_state: "failed", generation: null }, now)]));
  } catch (e) {
    if (e instanceof HomeBusy || e instanceof LeaseLost) return; // billing holds the home right now: the next pass looks again
    throw e;
  }
}

/** How long one pass owns a given-up attempt's cleanup (releaseFailedResources, reclaimDispatchedGenerations) before another may take it
 *  over. Astra MAILRETRY-14 P3: longer than Cloudflare's 15-minute wall for one invocation, and renewed before every destructive step, so a
 *  claim can expire only once its holder's invocation is over: a holder that is still running never sees its claim taken over, and a
 *  holder that finds its claim gone (the ownership check before each step) stops at once. */
export const CLEANUP_CLAIM_MS = 16 * 60_000;
/** Astra MAILRETRY-14 P1: a provider create dispatched at time t has returned (or its invocation is over) by t + this (the 15-minute wall),
 *  so a listing taken after it shows every resource that dispatch can ever make. */
export const DISPATCH_SETTLE_MS = 16 * 60_000;
/** Round 11 (Astra MAILRETRY-15 P1-1): every dispatched provider create is aborted after this, whichever path runs it (the cron, or the admin
 *  HTTP reconcile that has no fixed duration limit), so no create can outlive its ledger's expectation (deadline_at). An aborted call is
 *  UNSETTLED (the provider may still execute what it received): it never lets a generation close. */
export const DISPATCH_CALL_MS = 10 * 60_000;
/** Round 11 (Astra MAILRETRY-15 P3-a): a destroy or purge runs bounded by the claim's lease less this margin, so it is aborted while its pass
 *  still holds the claim: no in-flight call survives a takeover. */
export const CLEANUP_CALL_MARGIN_MS = 2 * 60_000;
/** A generation kept open by an unsettled dispatch past its deadline is re-listed (and anything found destroyed) at most this often while
 *  its oldest unanswered call is younger than DISPATCH_RECHECK_FAST_WINDOW_MS... */
export const DISPATCH_RECHECK_MS = 10 * 60_000;
/** Astra INTEGRATED-7 P1: elapsed time alone never settles an unanswered create (no provider documents a request lifetime), so the listing
 *  never stops; its cost is bounded instead: after this window the generation is re-listed once every DISPATCH_RECHECK_SLOW_MS, until the
 *  resource is seen (and destroyed: the call settles by its own key) or an operator confirms the call with evidence. */
export const DISPATCH_RECHECK_FAST_WINDOW_MS = 24 * 60 * 60_000;
export const DISPATCH_RECHECK_SLOW_MS = 24 * 60 * 60_000;
/** ...and the operator is alerted once such a dispatch is this old (provision.dispatch_unsettled). */
export const DISPATCH_UNSETTLED_ALERT_MS = 6 * 60 * 60_000;
const DISPATCH_UNSETTLED_ALERT = "provision.dispatch_unsettled";
const callBounds = new WeakMap<ProviderAdapter, NonNullable<B3Dependencies["callBoundMs"]>>();
const dispatchBound = (provider: ProviderAdapter) => callBounds.get(provider)?.dispatch ?? DISPATCH_CALL_MS;
const cleanupBound = (provider: ProviderAdapter) => callBounds.get(provider)?.cleanup ?? CLEANUP_CLAIM_MS - CLEANUP_CALL_MARGIN_MS;
/** The provider ANSWERED THIS create request with a refusal (nothing executes): an error the adapter marked as the create request's own
 *  answer, or a HostError refusal (4xx other than 408) the adapter did not mark as something else (a listing or GET error, a step after the
 *  create was sent). A 5xx, a network failure, an abort, or any error of a recovery listing is no such answer (Astra MAILRETRY-16 P1). */
export const providerAnswered = (error: unknown) => isAnswered(error)
  || (error instanceof HostError && refusalStatus(error.status) && !(error as { notAnAnswer?: boolean }).notAnAnswer);
/** No call of the generation (alias `d`: home_id, resource_generation) is unsettled or settled at/after `?` (the listing's anchor on the
 *  DATABASE's clock, Astra MAILRETRY-16). A settlement with no database time (an operator's raw write) counts as before. Astra INTEGRATED-7
 *  P1: no listing settles a call any more (only its own answer or an operator's evidence does). */
const DISPATCHES_SETTLED_BEFORE = (d: string) => `NOT EXISTS (SELECT 1 FROM cloud_resource_dispatch_calls dc WHERE dc.home_id=${d}.home_id
  AND dc.resource_generation=${d}.resource_generation AND (dc.settled_at IS NULL OR COALESCE(dc.settled_db_at,0)>=?))`;
class CleanupClaimLost extends Error {}
/** Every server and volume of ONE resource generation of a home destroyed, then its snapshots purged; `mine` re-proves (and renews) the
 *  caller's cleanup claim before each destructive step and throws CleanupClaimLost once it is gone. `purge`: "found" purges only when this
 *  pass found something to destroy. Throws when anything is left. Returns how many resources were destroyed.
 *  Round 11 (Astra MAILRETRY-15 P3-a): `mine` returns the bound of the next call (aborted inside the claim's renewed lease); `found` runs
 *  before the first destroy (persisting that a purge is owed). */
async function destroyGeneration(env: Env, provider: ProviderAdapter, homeId: string, generation: number, mine: () => Promise<AbortSignal>,
  purge: "always" | "found", onFound?: () => Promise<void>): Promise<{ found: number; anchor: number; anchorAt: number; purged: boolean }> {
  const g = { id: homeId, resource_generation: generation } as Home;
  let found = 0;
  for (const role of ["home", "volume"] as const) {
    for (const r of checkedResources(await provider.list_by_tag(homeId, generation, role), g, role)) {
      if (!found && onFound) await onFound();
      // Astra MAILRETRY-16 P1 rule (a): a resource labelled with a call's own key is that call's answer (the request executed).
      if (r.idempotency_key) await settleCall(env.DB, r.idempotency_key, "created", Date.now(), `resource:${r.id}`);
      await provider.destroy(r.id, await mine()); found++;
    }
  }
  // The anchor every verifying listing below follows (the purge's own listings of snapshots and sub-accounts, then the servers and volumes):
  // a call settled before it (DATABASE clock) made nothing those listings could miss.
  const anchorAt = Date.now();
  const anchor = await dbNow(env.DB);
  const purged = purge === "always" || found > 0;
  // Astra MAILRETRY-16 P3: the purge runs bound by the claim's lease; an aborted purge throws (unsettled: purged_at stays unset).
  if (purged) await provider.purge_snapshots?.(homeId, generation, await mine());
  const left = checkedResources(await provider.list_by_tag(homeId, generation, "home"), g, "home").length
    + checkedResources(await provider.list_by_tag(homeId, generation, "volume"), g, "volume").length;
  if (left) throw new Error("failed_home_cleanup_incomplete");
  return { found, anchor, anchorAt, purged };
}
/** Astra MAILRETRY-14 P1: the per-generation resource ledger (cloud_resource_dispatches) is reclaimable for a generation that is no longer
 *  any attempt's: older than the home's current one (superseded by a reopen), or the current one given up and already cleaned once (a
 *  create that landed after that cleanup). `d` is the ledger alias. */
const DISPATCH_RECLAIMABLE = (d: string) => `EXISTS (SELECT 1 FROM cloud_homes rh WHERE rh.id=${d}.home_id AND (${d}.resource_generation<rh.resource_generation
  OR (${d}.resource_generation=rh.resource_generation AND rh.desired_state IN ('failed','deleted') AND EXISTS (SELECT 1 FROM provision_attempts rp
    WHERE rp.home_id=rh.id AND rp.resource_generation=${d}.resource_generation AND rp.gave_up_at IS NOT NULL AND rp.cleaned_at IS NOT NULL))))`;
/** Astra MAILRETRY-14 P1: a provider create cannot be fenced with a D1 batch, so every create is first recorded under ITS attempt's resource
 *  generation (provisionOnce: the dispatch fence) and a create that lands after its attempt was given up or superseded is still found: this
 *  sweep walks every reclaimable generation of the ledger (not only the budget row's, which a reopen moves on), destroys what the provider
 *  shows at that generation, and closes the generation only from a listing taken DISPATCH_SETTLE_MS after its last dispatch (after which no
 *  create of it can still land). Under a renewed claim per generation, so overlapping passes destroy once. Returns the failures. */
async function reclaimDispatchedGenerations(env: Env, provider: ProviderAdapter, now: number): Promise<number> {
  // Astra INTEGRATED-8 P2: open_subs = the generation's Storage Box sub-account creates still unanswered. Servers and volumes are listed
  // every pass; the Storage Box is listed only by the purge, so while such a call is open every pass purges (lists the box) again: a
  // sub-account that lands after the first purge (day 3) is found, its call settled with that evidence, and it is purged.
  const due = await env.DB.prepare(`SELECT d.home_id,d.resource_generation,d.purged_at,(SELECT COUNT(*) FROM cloud_resource_dispatch_calls sc
      WHERE sc.home_id=d.home_id AND sc.resource_generation=d.resource_generation AND sc.role='subaccount' AND sc.settled_at IS NULL) AS open_subs
    FROM cloud_resource_dispatches d
    WHERE d.reclaimed_at IS NULL AND (d.claim IS NULL OR d.claimed_until IS NULL OR d.claimed_until<=?)
      AND (d.next_check_at IS NULL OR d.next_check_at<=?) AND ${DISPATCH_RECLAIMABLE("d")}
    ORDER BY d.last_dispatch_at LIMIT 20`).bind(now, now).all<{ home_id: string; resource_generation: number; purged_at: number | null; open_subs: number }>();
  /** The operator is alerted about a call unanswered this long, whether or not this pass's listing succeeded (a listing that keeps failing
   *  never settles anything, so it must not keep the alert silent either: Astra MAILRETRY-16). */
  const alertIfStale = async (d: { home_id: string; resource_generation: number }) => {
    const stale = await env.DB.prepare(`SELECT MIN(dispatched_at) AS at FROM cloud_resource_dispatch_calls WHERE home_id=? AND resource_generation=?
      AND settled_at IS NULL`).bind(d.home_id, d.resource_generation).first<{ at: number | null }>();
    if (stale?.at != null && stale.at <= now - DISPATCH_UNSETTLED_ALERT_MS) {
      // Claimed delivery (B's ops-monitor): persisted here, delivered once by sweepMonitoring; never sent from this pass.
      await persistAlert(env, { homeId: d.home_id, kind: DISPATCH_UNSETTLED_ALERT, severity: "high", detail: `a provider create (server, volume or backup sub-account) of resource generation ${d.resource_generation} was dispatched and never answered (aborted or its invocation died); the generation stays open, is re-checked every ${DISPATCH_RECHECK_MS / 60_000} minutes, for its first ${DISPATCH_RECHECK_FAST_WINDOW_MS / 3_600_000} hours, then once a day, and is NEVER settled by elapsed time or an empty listing (no provider documents how long it may still act on a request). To close it: find the request in the provider's action log (or get its cancellation confirmed), destroy anything labelled with this home and generation, then confirm the call WITH that evidence (confirmDispatchCall: kind provider_log, cancellation or recheck, and a reference); a confirmation without evidence is refused` }, now);
    } else if (stale?.at == null) {
      await persistResolveUnless(env, d.home_id, DISPATCH_UNSETTLED_ALERT, now,
        "SELECT 1 FROM cloud_resource_dispatch_calls c WHERE c.home_id=cloud_alerts.home_id AND c.settled_at IS NULL");
    }
  };
  let failures = 0;
  for (const d of due.results) {
    const claim = crypto.randomUUID();
    const keyed = "home_id=? AND resource_generation=? AND reclaimed_at IS NULL";
    try {
      const taken = await env.DB.prepare(`UPDATE cloud_resource_dispatches SET claim=?,claimed_until=? WHERE ${keyed}
        AND (claim IS NULL OR claimed_until IS NULL OR claimed_until<=?) AND ${DISPATCH_RECLAIMABLE("cloud_resource_dispatches")}`)
        .bind(claim, now + CLEANUP_CLAIM_MS, d.home_id, d.resource_generation, now).run();
      if (taken.meta.changes !== 1) continue;
      const mine = async () => {
        const held = await env.DB.prepare(`UPDATE cloud_resource_dispatches SET claimed_until=? WHERE ${keyed} AND claim=?`)
          .bind(Date.now() + CLEANUP_CLAIM_MS, d.home_id, d.resource_generation, claim).run();
        if (held.meta.changes !== 1) throw new CleanupClaimLost();
        return AbortSignal.timeout(cleanupBound(provider));
      };
      // Astra MAILRETRY-15 P2-b: the purge is its own step with its own flag (purged_at): owed until a purge succeeded, owed again the moment
      // anything is found to destroy (persisted before the destroy), so a purge that fails is retried by the next pass even when that pass
      // finds nothing left to destroy.
      let listing: Awaited<ReturnType<typeof destroyGeneration>>;
      try {
        listing = await destroyGeneration(env, provider, d.home_id, d.resource_generation, mine, d.purged_at === null || d.open_subs > 0 ? "always" : "found", async () => {
          await env.DB.prepare(`UPDATE cloud_resource_dispatches SET purged_at=NULL WHERE ${keyed} AND claim=?`).bind(d.home_id, d.resource_generation, claim).run();
        });
        // Only a purge that ran in THIS pass marks it done; and only while no new dispatch (a sub-account create re-arms purged_at) came since.
        if (listing.purged) await env.DB.prepare(`UPDATE cloud_resource_dispatches SET purged_at=? WHERE ${keyed} AND claim=? AND NOT EXISTS (
            SELECT 1 FROM cloud_resource_dispatch_calls dc WHERE dc.home_id=cloud_resource_dispatches.home_id
              AND dc.resource_generation=cloud_resource_dispatches.resource_generation AND COALESCE(dc.dispatched_db_at,0)>=?)`)
          .bind(now, d.home_id, d.resource_generation, claim, listing.anchor).run();
      } catch (error) {
        if (error instanceof CleanupClaimLost) continue;
        await env.DB.prepare(`UPDATE cloud_resource_dispatches SET claim=NULL,claimed_until=NULL WHERE ${keyed} AND claim=?`)
          .bind(d.home_id, d.resource_generation, claim).run().catch(() => undefined);
        throw error;
      }
      // Astra MAILRETRY-15 P1-1: closed only when EVERY step settled: each dispatch of the generation has a recorded provider answer (or was
      // never sent) from before this pass's listing, the purge succeeded, and the listing was taken DISPATCH_SETTLE_MS after the last dispatch.
      // "Found nothing" alone never closes it: an unsettled dispatch (aborted, died, no answer) keeps it reclaimable indefinitely, re-checked
      // every DISPATCH_RECHECK_MS once past its deadline, and alerted after DISPATCH_UNSETTLED_ALERT_MS.
      // Astra INTEGRATED-7 P1 (replaces MAILRETRY-16 rule b): an UNANSWERED call is never settled by a listing that found nothing, however
      // long after its dispatch: the provider documents no request lifetime, so a create can still land later. The generation stays open and
      // is listed again (anything found is destroyed and its call settled by its own key) on a decaying schedule: every DISPATCH_RECHECK_MS
      // while its oldest unanswered call is younger than DISPATCH_RECHECK_FAST_WINDOW_MS, then once every DISPATCH_RECHECK_SLOW_MS, until
      // the call is answered or an operator confirms it with evidence. Nothing of the home's own flow (refund, re-provision) waits for this.
      const closable = `last_dispatch_at<=? AND purged_at IS NOT NULL AND ${DISPATCHES_SETTLED_BEFORE("cloud_resource_dispatches")}`;
      const unsettledPastDeadline = `EXISTS (SELECT 1 FROM cloud_resource_dispatch_calls dc WHERE dc.home_id=cloud_resource_dispatches.home_id
        AND dc.resource_generation=cloud_resource_dispatches.resource_generation AND dc.settled_at IS NULL AND dc.deadline_at<=?)`;
      const oldestUnsettled = `(SELECT MIN(dc.dispatched_at) FROM cloud_resource_dispatch_calls dc WHERE dc.home_id=cloud_resource_dispatches.home_id
        AND dc.resource_generation=cloud_resource_dispatches.resource_generation AND dc.settled_at IS NULL)`;
      await env.DB.prepare(`UPDATE cloud_resource_dispatches SET reclaimed_at=CASE WHEN ${closable} THEN ? END,
          next_check_at=CASE WHEN ${unsettledPastDeadline} THEN (CASE WHEN ${oldestUnsettled}>? THEN ? ELSE ? END) END,claim=NULL,claimed_until=NULL
        WHERE ${keyed} AND claim=?`).bind(now - DISPATCH_SETTLE_MS, listing.anchor, now, now, now - DISPATCH_RECHECK_FAST_WINDOW_MS,
          now + DISPATCH_RECHECK_MS, now + DISPATCH_RECHECK_SLOW_MS, d.home_id, d.resource_generation, claim).run();
    } catch (error) {
      failures++;
      console.error(JSON.stringify({ message: "b3 reclaim of a dispatched generation failed", homeId: d.home_id, resourceGeneration: d.resource_generation,
        errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown" }));
    }
    await alertIfStale(d).catch(() => { failures++; });
  }
  return failures;
}
/** Destroy every server, volume, snapshot and backup a failed home holds, then record that it is clean. Idempotent.
 *  Astra MAILRETRY-13 P3: the give-up, the overdue pass, the failed-home branch and a reopen all release a given-up attempt's resources. The
 *  cleanup of one attempt (home, resource generation) runs under a claim on its budget row: taken only while the attempt is given up and not
 *  yet clean and no other pass holds an unexpired claim, released when this pass fails (so the next pass retries at once), cleared with the
 *  clean mark. A pass that does not get the claim does nothing (another pass is releasing them right now, or they are released already), so
 *  overlapping passes never destroy or purge twice. Returns true when this pass recorded the attempt clean. */
async function releaseFailedResources(env: Env, h: Home, provider: ProviderAdapter, now: number): Promise<boolean> {
  const claim = crypto.randomUUID();
  const taken = await env.DB.prepare(`UPDATE provision_attempts SET cleanup_claim=?,cleanup_claimed_until=?
    WHERE home_id=? AND resource_generation=? AND gave_up_at IS NOT NULL AND cleaned_at IS NULL
      AND (cleanup_claim IS NULL OR cleanup_claimed_until IS NULL OR cleanup_claimed_until<=?)`)
    .bind(claim, now + CLEANUP_CLAIM_MS, h.id, h.resource_generation, now).run();
  if (taken.meta.changes !== 1) return false;
  // Astra MAILRETRY-14 P3: before each destructive step the claim is re-proved as this pass's and renewed; a pass whose claim is gone stops.
  const mine = async () => {
    const held = await env.DB.prepare(`UPDATE provision_attempts SET cleanup_claimed_until=?
      WHERE home_id=? AND resource_generation=? AND cleanup_claim=? AND gave_up_at IS NOT NULL AND cleaned_at IS NULL`)
      .bind(Date.now() + CLEANUP_CLAIM_MS, h.id, h.resource_generation, claim).run();
    if (held.meta.changes !== 1) throw new CleanupClaimLost();
    return AbortSignal.timeout(cleanupBound(provider)); // Astra MAILRETRY-15 P3-a: aborted while this pass still holds the claim
  };
  let listing: Awaited<ReturnType<typeof destroyGeneration>>;
  try {
    listing = await destroyGeneration(env, provider, h.id, h.resource_generation, mine, "always");
  } catch (error) {
    if (error instanceof CleanupClaimLost) return false; // another pass owns the cleanup now: nothing more is done here
    await env.DB.prepare("UPDATE provision_attempts SET cleanup_claim=NULL,cleanup_claimed_until=NULL WHERE home_id=? AND resource_generation=? AND cleanup_claim=?")
      .bind(h.id, h.resource_generation, claim).run().catch(() => undefined); // an expired claim is taken over anyway
    throw error;
  }
  // Astra MAILRETRY-15 P2-b: the purge step of the generation's ledger is done (destroyGeneration purged "always"), unless a dispatch came since.
  await env.DB.prepare(`UPDATE cloud_resource_dispatches SET purged_at=? WHERE home_id=? AND resource_generation=? AND reclaimed_at IS NULL
    AND last_dispatch_at<? AND NOT EXISTS (SELECT 1 FROM cloud_resource_dispatch_calls dc WHERE dc.home_id=cloud_resource_dispatches.home_id
      AND dc.resource_generation=cloud_resource_dispatches.resource_generation AND COALESCE(dc.dispatched_db_at,0)>=?)`)
    .bind(now, h.id, h.resource_generation, now, listing.anchor).run();
  // Scoped to the generation released: a pass still holding an older read never marks a newer generation's budget clean.
  const marked = await env.DB.prepare(`UPDATE provision_attempts SET cleaned_at=?,cleanup_claim=NULL,cleanup_claimed_until=NULL
    WHERE home_id=? AND resource_generation=? AND cleanup_claim=?`).bind(now, h.id, h.resource_generation, claim).run();
  if (marked.meta.changes !== 1) return false;
  // Astra MAILRETRY-14 P1: this listing was taken after every dispatch of the generation had settled (no create of it can land any more):
  // the ledger closes the generation now. Otherwise it stays open for reclaimDispatchedGenerations.
  // Astra MAILRETRY-15: and only when every dispatch of it settled before this listing (the purge ran above: purged_at).
  await env.DB.prepare(`UPDATE cloud_resource_dispatches SET reclaimed_at=?,purged_at=? WHERE home_id=? AND resource_generation=? AND reclaimed_at IS NULL
    AND claim IS NULL AND last_dispatch_at<=? AND ${DISPATCHES_SETTLED_BEFORE("cloud_resource_dispatches")}`)
    .bind(now, now, h.id, h.resource_generation, now - DISPATCH_SETTLE_MS, listing.anchor).run();
  return true;
}

async function provisionOnce(env: Env, h: Home, provider: ProviderAdapter, now: number, fault: (step: FaultStep) => void) {
  // Reject a hostile role/identity before preparing any local machine/key material.
  const initialServers = checkedResources(await provider.list_by_tag(h.id, h.resource_generation, "home"), h, "home");
  const initialVolumes = checkedResources(await provider.list_by_tag(h.id, h.resource_generation, "volume"), h, "volume");
  if ((initialServers.length || initialVolumes.length)
    && !await env.DB.prepare("SELECT home_id FROM cloud_provision_intents WHERE home_id=? AND resource_generation=?").bind(h.id, h.resource_generation).first()) {
    throw new Error("provision_intent_missing"); // No evidence that this VM ever received the current token.
  }
  const reserved = await env.DB.prepare("SELECT payload FROM cloud_outbox WHERE home_id=? AND kind='reserved'")
    .bind(h.id).first<{ payload: string }>();
  if (!reserved) throw new Error("reservation_missing");
  const publicOrigin = originSchema.parse((JSON.parse(reserved.payload) as { publicOrigin: string }).publicOrigin);
  await prepareB3Enrollment(env, { homeId: h.id, generation: h.generation,
    resourceGeneration: h.resource_generation, publicOrigin, adminUrl: controlPlaneOriginFor(env), now });
  // Astra MAILRETRY-14 P1: this attempt's intent only, keyed by (home, resource generation): never a replacement attempt's.
  const readIntent = async () => {
    const found = await env.DB.prepare("SELECT * FROM cloud_provision_intents WHERE home_id=? AND resource_generation=?")
      .bind(h.id, h.resource_generation).first<ProvisionIntent>();
    if (!found) throw new Error("provision_intent_conflict");
    return found;
  };
  let intent = await readIntent();
  if (!intent || intent.cp_generation !== h.generation || intent.resource_generation !== h.resource_generation
    || intent.state !== "pending") throw new Error("provision_intent_conflict");
  const currentPredicate = `EXISTS(SELECT 1 FROM cloud_homes h WHERE h.id=cloud_provision_intents.home_id AND h.generation=cloud_provision_intents.cp_generation
    AND h.resource_generation=cloud_provision_intents.resource_generation AND h.desired_state='provisioning')`;
  const claim = async (role: ResourceRole) => {
    const phase = role === "home" ? "server" : "volume";
    const result = await env.DB.prepare(`UPDATE cloud_provision_intents SET ${phase}_phase='claimed',${phase}_claim=?
      WHERE home_id=? AND cp_generation=? AND resource_generation=? AND state='pending'
      AND ${phase}_phase IN ('pending','claimed') AND ${phase}_id IS NULL AND ${currentPredicate}`)
      .bind(crypto.randomUUID(), h.id, h.generation, h.resource_generation).run();
    return result.meta.changes === 1;
  };
  const record = async (role: ResourceRole, resourceId: string, volume?: VolumeDescriptor) => {
    const phase = role === "home" ? "server" : "volume";
    const result = await env.DB.prepare(`UPDATE cloud_provision_intents SET ${phase}_phase='created',${phase}_id=?
      ${volume ? ",volume_json=?" : ""} WHERE home_id=? AND cp_generation=? AND resource_generation=? AND state='pending'
      AND (${phase}_id IS NULL OR ${phase}_id=?) AND ${currentPredicate}`)
      .bind(resourceId, ...(volume ? [JSON.stringify(volume)] : []), h.id, h.generation, h.resource_generation, resourceId).run();
    if (result.meta.changes !== 1) throw new Error("provision_intent_conflict");
  };
  /** Astra MAILRETRY-14 P1: the dispatch fence. Immediately before a provider create, ONE batch records the dispatch in the resource ledger
   *  under this attempt's resource generation, and only while that generation is still the home's current one (paid, provisioning, the
   *  control-plane generation read) and this attempt's intent still pending with the step claimed and nothing recorded. A stale attempt (given
   *  up, or superseded by a reopen) matches nothing: the batch aborts and nothing is dispatched. A create that still lands late (the attempt
   *  paused between this batch and the provider call) is on the ledger, so reclaimDispatchedGenerations destroys it. */
  // Round 11 (Astra MAILRETRY-15 P1-1): each dispatch is also one call row; its outcome is recorded only from a provider answer.
  const dispatch = async (phase: "volume" | "server"): Promise<{ id: string; signal: AbortSignal } | null> => {
    const g = crypto.randomUUID();
    const id = crypto.randomUUID();
    const at = Math.max(now, Date.now());
    const bound = dispatchBound(provider);
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO cloud_resource_dispatches (home_id,resource_generation,last_dispatch_at) SELECT ?,?,?
          WHERE EXISTS (SELECT 1 FROM cloud_homes WHERE id=? AND generation=? AND resource_generation=? AND desired_state='provisioning' AND entitlement='paid')
            AND EXISTS (SELECT 1 FROM cloud_provision_intents WHERE home_id=? AND cp_generation=? AND resource_generation=? AND state='pending'
              AND ${phase}_phase='claimed' AND ${phase}_id IS NULL)
          ON CONFLICT(home_id,resource_generation) DO UPDATE SET last_dispatch_at=excluded.last_dispatch_at,reclaimed_at=NULL,purged_at=NULL,next_check_at=NULL`)
          .bind(h.id, h.resource_generation, at, h.id, h.generation, h.resource_generation, h.id, h.generation, h.resource_generation),
        env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(g),
        env.DB.prepare(`INSERT INTO cloud_resource_dispatch_calls (id,home_id,resource_generation,role,dispatched_at,dispatched_db_at,deadline_at)
          VALUES (?,?,?,?,?,${DB_NOW},?)`)
          .bind(id, h.id, h.resource_generation, phase, at, at + bound),
        env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(g),
      ]);
      return { id, signal: AbortSignal.timeout(bound) };
    } catch (error) {
      if (fenceMiss(error)) return null;
      throw error;
    }
  };
  /** Records the call's outcome: 'created' / 'failed' (the provider answered) or 'not_sent'. Never for an unanswered call. */
  // Astra MAILRETRY-16: settled_db_at on the DATABASE's clock (the listing's anchor is compared with it, never a worker's Date.now()).
  const settle = async (callId: string, outcome: "created" | "failed" | "not_sent", evidence: string | null = null) =>
    settleCall(env.DB, callId, outcome, Date.now(), evidence);
  /** Astra MAILRETRY-16 P1: only the create request's own answer settles a failed call; an error of anything else (a listing, a GET, a step
   *  after the request was sent) leaves it unsettled. An error the adapter raised before sending anything: never sent. */
  const settleFailure = async (callId: string, sent: boolean, error: unknown) => {
    if (!sent || isNotSent(error)) await settle(callId, "not_sent"); else if (providerAnswered(error)) await settle(callId, "failed");
  };
  const lookup = async (role: ResourceRole) => checkedResources(await provider.list_by_tag(h.id, h.resource_generation, role), h, role)[0];
  let volumeResource = await lookup("volume");
  let v: VolumeDescriptor | undefined;
  if (volumeResource) {
    if (intent.volume_phase === "pending") throw new Error("provision_intent_conflict");
    v = validateVolume(await provider.volume(volumeResource.id), h.id, h.resource_generation);
    if (v.id !== volumeResource.id) throw new Error("provider_volume_conflict");
  }
  else if (intent.volume_phase !== "created") {
    // pending, or claimed by an earlier attempt that failed before a volume existed (the attempt lease makes this
    // runner the only one; create_volume itself looks the volume up by label before creating).
    if (!await claim("volume")) return;
    const call = await dispatch("volume");
    if (!call) return; // no longer this attempt's generation: nothing is created
    let sent = false;
    try {
      fault("create_volume");
      sent = true;
      // Astra MAILRETRY-16 P1: the call's own id is its idempotency key, labelled on what it creates.
      const created = await provider.create_volume({ homeId: h.id, resourceGeneration: h.resource_generation,
        idempotencyKey: call.id, provider: "hetzner", signal: call.signal });
      await settle(call.id, "created", `resource:${created.id}`);
      v = validateVolume(created, h.id, h.resource_generation);
    }
    catch (error) {
      await settleFailure(call.id, sent, error);
      // Astra MAILRETRY-16 P1: recovery adopts only the resource labelled with THIS call's key; a listing error propagates and settles
      // nothing; a same-generation resource of any other call is never adopted (nor settles this call): the next pass looks again.
      const own = (await provider.list_by_tag(h.id, h.resource_generation, "volume")).find((r) => r.idempotency_key === call.id);
      if (!own) throw error; // Claimed is durable; an empty list never permits another create.
      volumeResource = checkedResources([own], h, "volume")[0];
      await settle(call.id, "created", `resource:${volumeResource.id}`); // its own resource exists: the request executed
      v = validateVolume(await provider.volume(volumeResource.id), h.id, h.resource_generation);
      if (v.id !== volumeResource.id) throw new Error("provider_volume_conflict");
    }
  } else return; // Recorded as created but not listed: reconcile later, never reissue.
  await record("volume", v.id, v);
  intent = await readIntent();
  let resource = await lookup("home");
  if (resource && intent.server_phase === "pending") throw new Error("provision_intent_conflict");
  /** The token the new server boots with: the one stored wrapped at prepare time, re-delivered on every attempt. Only when it is
   *  gone, used or expired AND no server exists yet is a fresh one minted (the old one revoked in the same batch). */
  const deliveryToken = async () => {
    const stored = await loadProvisionToken(env, h.id, h.resource_generation);
    if (stored) {
      const t = await env.DB.prepare("SELECT expires_at,used_at FROM cloud_enrollment_tokens WHERE hash=? AND machine_id=?")
        .bind(stored.hash, h.id).first<{ expires_at: number; used_at: number | null }>();
      if (t && t.used_at === null && t.expires_at > Date.now()) return stored.token;
    }
    const fresh = await rotateProvisionToken(env, { homeId: h.id, generation: h.generation, resourceGeneration: h.resource_generation, now: Date.now() });
    intent = await readIntent();
    return fresh;
  };
  if (resource) {
    // A server already holds its token. If that token can no longer be redeemed the home cannot enrol: fail the attempt.
    const t = await env.DB.prepare("SELECT expires_at,used_at FROM cloud_enrollment_tokens WHERE hash=? AND machine_id=?")
      .bind(intent.token_hash, h.id).first<{ expires_at: number; used_at: number | null }>();
    if (!t || t.used_at !== null || t.expires_at <= Date.now()) throw new Error("enrollment_delivery_expired");
  }
  if (!resource && intent.server_phase !== "created") {
    const capacity = await env.DB.prepare("SELECT location,server_type FROM cloud_capacity WHERE home_id=?")
      .bind(h.id).first<{ location: string; server_type: string }>();
    if (!capacity) throw new Error("provision_capacity_missing");
    if (!await claim("home")) return;
    const rawToken = await deliveryToken();
    // Astra MAILRETRY-15 P1-2: every credential the server boots with is fixed HERE, before the dispatch fence, from this attempt's own key
    // material, and never re-read after it: the token (this generation's intent) and the restic password (the home keys as they are now: a
    // reopen deletes them in the very batch that moves the resource generation on, so if the fence below passes they were this attempt's,
    // and after a reopen this payload's password matches nothing live). The adapter is never handed a way to read key material by home.
    const backup = provider.wants_backup_password?.() ? { resticPassword: await deriveBackupPassword(env, h.id) } : undefined;
    const userData = { machineId: h.id, enrollmentToken: rawToken, controlPlaneOrigin: controlPlaneOriginFor(env),
      generation: h.generation, volume: { provider: v.provider, id: v.id, device: v.device, new: v.new, generation: h.generation, homeId: h.id } };
    const call = await dispatch("server");
    if (!call) return; // no longer this attempt's generation: nothing is created
    let sent = false;
    try {
      fault("create_server");
      sent = true;
      resource = await provider.create({ homeId: h.id, resourceGeneration: h.resource_generation,
        idempotencyKey: call.id, type: capacity.server_type, location: capacity.location,
        image: h.image_digest, labels: { homeId: h.id, resourceGeneration: String(h.resource_generation), role: "home" },
        volume: v, userData, signal: call.signal, ...(backup ? { backup } : {}) });
      await settle(call.id, "created", `resource:${resource.id}`);
      fault("after_create_server");
    } catch (error) {
      await settleFailure(call.id, sent, error);
      // Preserve the lost-response boundary. A later reconciliation adopts by
      // exact role/identity, including after a temporarily empty provider list.
      throw error;
    }
  }
  if (!resource) return;
  checkedResources([resource], h, "home");
  await record("home", resource.id);
  const expectedVolumeId = v.id;
  fault("attach_volume");
  v = validateVolume(await provider.attach_volume(v.id, resource.id), h.id, h.resource_generation);
  if (v.id !== expectedVolumeId) throw new Error("provider_volume_conflict");
  if (v.attachment.serverId !== resource.id || v.attachment.state !== "attached") {
    if (v.attachment.serverId !== resource.id || v.attachment.state !== "attaching") throw new Error("provider_attachment_conflict");
    await record("volume", v.id, v); return;
  }
  await record("volume", v.id, v);
  const ips = await provider.public_ips(resource.id);
  fault("bind");
  await bindB3Enrollment(env, { homeId: h.id, generation: h.generation, resourceGeneration: h.resource_generation,
    tokenHash: intent.token_hash, volumeId: v.id, serverId: resource.id, ips, now: Date.now() });
}

async function fence(env: Env, h: Home, provider: ProviderAdapter, now: number) {
  // transition() has committed the new generation and revoked credentials
  // before either provider action. A retried old powered-on VM can't unwrap.
  const resources = checkedResources(await provider.list_by_tag(h.id, h.resource_generation, "home"), h, "home");
  for (const r of resources) { await provider.fence_network(r.id, b3Config(env).quarantineRelayIP); await provider.power_off(r.id); }
  if (resources.length) await env.DB.prepare("UPDATE cloud_leases SET fenced=1 WHERE home_id=? AND holder=? AND generation<?")
    .bind(h.id, h.id, h.generation).run();
  await env.DB.prepare("UPDATE cloud_homes SET observed_state=?,updated_at=? WHERE id=? AND generation=?")
    .bind(h.desired_state, now, h.id, h.generation).run();
}

/** A canary result for a home in 'checking', with the same effects whether the admin canary route or autoCanary reports it: ONE
 *  generation-guarded batch moves the home to ready (canary_passed) or failed (canary_failed), records observed_state and canary_json and,
 *  on a pass, makes the ready email owed (readyStamp: ready_pending_at). `extra` joins that batch (a guard, a mutation receipt). */
async function canaryOutcome(env: Env, h: Home, passed: boolean, canary: unknown, at: number, extra: D1PreparedStatement[] = []) {
  await transition(env, h, passed ? "ready" : "failed", passed ? "canary_passed" : "canary_failed", at, false, [
    ...extra,
    env.DB.prepare("UPDATE cloud_homes SET observed_state=?,canary_json=? WHERE id=?")
      .bind(passed ? "ready" : "failed", JSON.stringify(canary), h.id),
    // B3: the first pass makes the ready email owed (ready_pending_at), durably, in this same batch. The refund clock (ready_at) starts
    // when that email is queued (queueServerReady), never before (Astra JOURNEY-B-1 #7).
    ...(passed ? [readyStamp(env, h.id, at)] : []),
    // The home leaves 'checking' (ready, or failed by an admin canary): it no longer waits for its render (Astra AUTOCANARY-5 P2). In
    // the same batch, and without network (Astra AUTOCANARY-6 P2): the monitoring sweep sends the resolution notice.
    resolveAlertStatement(env.DB, h.id, UI_RENDER_MISSING_ALERT, at),
  ]);
  // The ready moment, under the home's billing lease: ready_at and the ready email in one batch. A busy home is left to the billing sweep
  // (queueServerReady runs there too, for every home still owed its email); until then the refund window stays open.
  if (passed) { try { await withHomeLease(env, h.id, (lease) => queueServerReady(env, lease, h.id, Date.now())); } catch { /* the billing sweep queues it */ } }
}

/** How recent the automatic canary's live evidence must be, judged when the promotion commits (after the probe). */
export const AUTO_CANARY_FRESH_MS = 5 * 60_000;
/** The control plane's own probe of one home (probeHome: /api/health, then the public UI shell and its entry script): all of its requests
 *  share this one timeout, the probe's own, which starts when its first request is issued (never while it waits for a worker slot). */
export const AUTO_CANARY_PROBE_MS = 5_000;
/** Probe throughput (Astra AUTOCANARY-3 P2: ten sequential probes a pass was 120 an hour, and 300-400 homes bought at launch would time
 *  out). Up to AUTO_CANARY_PROBE_CONCURRENCY probes run at once, at most AUTO_CANARY_PROBE_BUDGET_PER_PASS a pass, and the probe stage
 *  starts no probe that could end past AUTO_CANARY_STAGE_MS after the stage began (the deadline is re-checked immediately before each fetch).
 *  Concurrency (Astra AUTOCANARY-4 P2): a Worker invocation has at most six connections waiting for response headers at once and queues
 *  the rest, and a queued request still spends its probe's deadline. Each probe holds one connection at a time (its three GETs are
 *  sequential and each body is read to its cap or cancelled before the next), so five probes in flight never exceed six open connections
 *  and none waits in the runtime queue. Each probe's AUTO_CANARY_PROBE_MS starts at its first request.
 *  D1 work is outside the probe slots (Astra AUTOCANARY-5 P2: 200 ms D1 calls inside the slots cut a pass to 80): one read of every
 *  candidate and one statement stamping all their probed_at run before the stage, the stage itself makes no D1 call, and the promotions
 *  (each still its own guarded batch) and the render bookkeeping run after it. So D1 latency lengthens the pass, never the stage.
 *  Budget arithmetic: worst case every probe takes its full 5 s, so a wave of 5 lasts 5 s: 90 probes / 5 in flight x 5 s = 90 s, plus
 *  2 s for timer and scheduling slack (a timed-out probe ends a little after its 5 s) = the 92 s stage. Verified with elapsed time
 *  (b3-control.test.ts, 4.99 s probes and 200 ms for every D1 call): 90 probes a pass. Throughput: the reconcile cron runs every 5 minutes
 *  (wrangler.jsonc triggers.crons), 12 passes an hour x 90 = 1,080 probes an hour, >= 1,000 promotions an hour when probes pass.
 *  400 homes eligible at once are all probed within ceil(400 / 90) = 5 passes (about 20 minutes after the first), inside PROVISION_MAX_MS. */
export const AUTO_CANARY_PROBE_CONCURRENCY = 5;
export const AUTO_CANARY_PROBE_BUDGET_PER_PASS = 90;
export const AUTO_CANARY_STAGE_MS = 92_000;
/** Render age (Astra AUTOCANARY-5 P1: a cached "ok" repeated on later heartbeats is not a fresh render). The app renders its built UI
 *  once per process start, then every 10 minutes (server/index.ts), and reports the time its last render FINISHED (uiAt). A render is
 *  evidence for AUTO_CANARY_RENDER_MAX_AGE_MS = the 10-minute render cadence + 5 minutes of slack (one render may run late or take a
 *  while): a healthy app always has one that young, and a cached result can stand at most 15 minutes after the render that produced it.
 *  This is the binding bound for the render: heartbeats (about one a minute, fresh within AUTO_CANARY_FRESH_MS) only carry it, and a
 *  repeat of the same cached answer keeps its original uiAt, so it ages out instead of being refreshed by its carrier. Checked on both
 *  channels: the stored report (ui_rendered_at) and the public probe's own uiAt, each against the control plane's clock at the time. */
export const AUTO_CANARY_RENDER_MAX_AGE_MS = 15 * 60_000;
/** The transit bound on the report that carries the render (Astra AUTOCANARY-7 P1): our receipt time minus the home's clock sample
 *  (clock.wallMs) at most this, so a heartbeat held in transit cannot carry an old render age as young. */
export const AUTO_CANARY_TRANSIT_MAX_MS = 2 * 60_000;
/** How far ahead of the report that carried it a render time may be (the home's clock against ours): no more than lease skew. */
export const AUTO_CANARY_RENDER_SKEW_MS = LEASE_SKEW_MS;
/** A checking home whose every other piece of evidence is green (D1 and the public markup + script probe) but whose render evidence is
 *  not, for this long, raises UI_RENDER_MISSING_ALERT (Astra AUTOCANARY-5 P2: a renderer regression must be seen within minutes, not
 *  through give-up after the hour). One open alert per home (cloud_alerts_open); resolved when the home leaves checking or is given up. */
export const UI_RENDER_MISSING_ALERT = "home.ui_render_missing";
export const UI_RENDER_MISSING_ALERT_MS = 10 * 60_000;
/** The largest /api/health body the probe reads; the home's public answer is {"app":"murage","ui":"<state>","uiAt":<ms|null>,"instance":"<id>"}. */
export const AUTO_CANARY_PROBE_MAX_BYTES = 1024;
/** The largest public UI shell (GET /) the probe reads: the built index.html is about 5 KiB. */
export const AUTO_CANARY_UI_MAX_BYTES = 64 * 1024;
/** How much of the UI's entry script the probe reads: enough to see it is served, never the whole bundle. */
export const AUTO_CANARY_ASSET_READ_BYTES = 1024;
/** The built UI shell's stable markers (index.html at the repo root, which vite builds into /opt/murage/dist/index.html and the home
 *  serves at GET / to anyone, signed in or not: the door is client side). Contract confirmed by the home-side owner. */
const UI_MARKERS = ["<title>Murage</title>", '<div id="root"></div>'] as const;
/** The one module script vite emits for the entry (hashed name: matched, never a literal). */
const UI_ENTRY_SCRIPT = /^\/assets\/index-[A-Za-z0-9_-]+\.js$/;
const JAVASCRIPT_TYPE = /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)\s*(?:;|$)/i;
/** The same public hostname rule GET /v1/homes applies before it shows a publicOrigin (homes.ts). */
const PUBLIC_HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** The rows the automatic canary's D1 evidence reads, for one home h. */
const AUTO_CANARY_FROM = `cloud_homes h
  JOIN cloud_home_health x ON x.home_id=h.id
  JOIN cloud_machines m ON m.id=h.id
  JOIN machine_endpoints e ON e.machine_id=h.id
  JOIN provision_attempts p ON p.home_id=h.id`;
/** The automatic canary's candidate evidence for a paid home at its current generation, from the LATEST report whatever its epoch (it
 *  chooses whom to probe and when a render is missing, never whom to promote). Binds (freshSince, freshSince). (1) The latest app report
 *  at THIS generation succeeded (app_ok=1, app_ok_at=app_reported_at) within AUTO_CANARY_FRESH_MS and carried the home's own readiness
 *  checks: the built web UI is on the image (ui_bundle_ok) and the data volume takes a durable write (data_writable_ok) (Astra
 *  AUTOCANARY-2 P1: /api/health answering is not readiness). No scheduler check exists: the home has no scheduler heartbeat signal. (2) A
 *  heartbeat within AUTO_CANARY_FRESH_MS and the machine's current-generation credential is live. (3) The home's tunnel endpoint is ready
 *  (status 'ready', tunnel and DNS record created) and was last written during this provisioning budget. The home's state is checked by
 *  transition()'s own generation/state guard. (4) The latest report echoed an evidence epoch (report_echo=1, current or stale: Astra
 *  AUTOCANARY-11 P2-2): only a daemon that takes part in the acceptance rule promotion uses is judged on the display fields above, which
 *  a dropped PASS never lowers. A home whose latest report carried no epoch (a daemon older than evidence epochs, a legacy field, or a
 *  daemon's first report after a restart or a failed heartbeat, a minute before its next) shows as "needs update": never probed, never
 *  alerted as render-missing, never promoted automatically (the admin canary, or the next image, moves it on). A stale echo stays a
 *  candidate: one control-plane bump (a failed probe) must not reset the render-missing clock. Never sufficient: promotion needs
 *  AUTO_CANARY_RENDER and AUTO_CANARY_PROBE too. */
const autoCanaryBase = (freshSince = "?") => `h.entitlement='paid'
    AND x.generation=h.generation AND x.report_echo=1
    AND x.app_ok=1 AND x.app_ok_at IS NOT NULL AND x.app_reported_at>=${freshSince} AND x.app_ok_at=x.app_reported_at
    AND x.ui_bundle_ok=1 AND x.data_writable_ok=1
    AND h.heartbeat_at>=${freshSince}
    AND m.generation=h.generation AND m.state='active' AND m.credential_hash IS NOT NULL
    AND p.gave_up_at IS NULL AND e.updated_at>=p.first_at
    AND e.status='ready' AND e.tunnel_id IS NOT NULL AND e.dns_record_id IS NOT NULL`;
const AUTO_CANARY_BASE = autoCanaryBase();
/** The home's own evidence, at the CURRENT epoch (Astra AUTOCANARY-10). Binds (renderSince = now - AUTO_CANARY_RENDER_MAX_AGE_MS). The
 *  stored report was accepted at the current epoch (report_epoch = evidence_epoch: recordHealth accepts a report only when it echoes the
 *  current epoch, and every negative event since, a failing check, a dropped or rejected report, a failed probe, a generation change, the
 *  home leaving 'checking', bumped the epoch), so it is the latest word on the home and nothing negative has been recorded since. It
 *  passed: the app answered, the UI bundle and the data volume checks, and the UI really rendered in the app's own sandboxed browser
 *  (Astra AUTOCANARY-4 P1), not a refused render (ui_rejected_*, Astra AUTOCANARY-6 P1). The render is young (Astra AUTOCANARY-5/7 P1):
 *  its age on the home's own clock (ui_age_ms) plus the time since our receipt of the report (report_at) within
 *  AUTO_CANARY_RENDER_MAX_AGE_MS (report_at - ui_age_ms >= renderSince), the report's transit (receipt minus the home's sample time) at
 *  most AUTO_CANARY_TRANSIT_MAX_MS, the render not dated after the report beyond clock skew, and it names its app process (ui_instance).
 *  Freshness of the report itself is AUTO_CANARY_BASE's. An image without any of it (no checks, no render, no age) never passes. */
const autoCanaryRender = (renderSince = "?") => `(x.report_epoch IS NOT NULL AND x.report_epoch=x.evidence_epoch
    AND x.app_ok=1 AND x.ui_bundle_ok=1 AND x.data_writable_ok=1 AND x.ui_renders_ok=1 AND x.ui_rendered_at IS NOT NULL
    AND x.report_at IS NOT NULL AND x.ui_age_ms IS NOT NULL AND x.app_sampled_at IS NOT NULL
    AND x.report_at-x.app_sampled_at<=${AUTO_CANARY_TRANSIT_MAX_MS}
    AND x.report_at-x.ui_age_ms>=${renderSince}
    AND x.ui_rendered_at<=x.report_at+${AUTO_CANARY_RENDER_SKEW_MS}
    AND NOT (x.ui_rendered_at IS x.ui_rejected_at AND x.ui_instance IS x.ui_rejected_instance)
    AND x.ui_instance IS NOT NULL)`;
const AUTO_CANARY_RENDER = autoCanaryRender();
/** The control plane's own probe, at the CURRENT epoch (Astra AUTOCANARY-10). Binds (renderSince at the promotion's time). The probe
 *  passed and was recorded against the epoch read before it started, which is still the current one (probe_epoch = evidence_epoch); its
 *  public answer named the same app process as the stored report (probe_instance = ui_instance) and its public render time is still
 *  within AUTO_CANARY_RENDER_MAX_AGE_MS (Astra AUTOCANARY-6 P2: 14:59 old when probed is 15:01 old two seconds later). */
const autoCanaryProbe = (renderSince: string) => `(x.probe_epoch IS NOT NULL AND x.probe_epoch=x.evidence_epoch
    AND x.probe_instance=x.ui_instance AND x.probe_ui_at IS NOT NULL AND x.probe_ui_at>=${renderSince})`;
/** The evidence for one home, re-checked inside the promotion batch as a cloud_write_guards row. Binds (now, dbAt, homeId, generation,
 *  epoch, hostname, tunnelId, dnsRecordId, endpointUpdatedAt). Every age is judged at the statement's EXECUTION (Astra AUTOCANARY-12
 *  P2-2: a PASS 299 s old when `now` was read and a batch delayed 10 s is 309 s old when it commits, and is refused): n.t is `now` (the
 *  control plane's clock, in which every stored timestamp was written) plus the time elapsed on the database's own clock since dbAt, read
 *  from D1 just BEFORE `now` (DB_NOW: julianday('now'), millisecond resolution, which D1 evaluates; billing-lease uses it). Anchoring the
 *  database's elapsed time to `now`, rather than comparing the database's clock with timestamps the control plane wrote, keeps any skew
 *  between the two clocks out of the bound. The anchor read's own latency makes n.t later than the real time by that much (milliseconds):
 *  evidence is refused that early, never accepted late. Bounds at n.t: report and heartbeat within AUTO_CANARY_FRESH_MS, render and probe
 *  within AUTO_CANARY_RENDER_MAX_AGE_MS, and the provisioning deadline (n.t - PROVISION_MAX_MS, Astra AUTOCANARY-3 P3: a home whose budget
 *  ran out while the probe ran is not promoted). The epoch is the one read before the probe (every item at it, and it still current); the
 *  endpoint is pinned to exactly the row read before the probe (Astra AUTOCANARY-2 P2), so a tunnel or DNS record replaced while the probe
 *  ran aborts the promotion. */
const autoCanaryEvidenceSql = (door = "") => `EXISTS(SELECT 1 FROM (SELECT ?+${DB_NOW}-? AS t) n, ${AUTO_CANARY_FROM}
  WHERE h.id=? AND h.generation=? AND ${autoCanaryBase(`n.t-${AUTO_CANARY_FRESH_MS}`)}${door}
    AND ${autoCanaryRender(`n.t-${AUTO_CANARY_RENDER_MAX_AGE_MS}`)} AND ${autoCanaryProbe(`n.t-${AUTO_CANARY_RENDER_MAX_AGE_MS}`)}
    AND x.evidence_epoch=? AND e.hostname=? AND e.tunnel_id=? AND e.dns_record_id=? AND e.updated_at=? AND p.first_at>n.t-${PROVISION_MAX_MS})`;
/** The database clock anchor of AUTO_CANARY_EVIDENCE_SQL (its dbAt). */
export const AUTO_CANARY_DB_ANCHOR_SQL = `SELECT ${DB_NOW} AS dbAt`;

/** Reads at most `max` bytes of a response body: refused before reading when Content-Length says more, otherwise read through the body's
 *  reader with a running count, cancelling the stream the moment it passes `max` (Astra AUTOCANARY-2 P2: never buffer an unbounded body).
 *  Null when the body is too large. */
async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && !(/^\d{1,10}$/.test(declared.trim()) && Number(declared.trim()) <= max)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** Reads the first bytes of a response body, at most `max`, then cancels the rest (the UI's entry script is far larger than what the
 *  probe needs to see). Never buffers more than one chunk past `max`. */
async function readPrefix(response: Response, max: number): Promise<number> {
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    return total;
  } finally {
    reader.releaseLock();
  }
}

/** The script tags of an HTML document that load a module from a src, in order. */
function moduleScriptSources(html: string): string[] {
  const sources: string[] = [];
  for (const tag of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = tag[1];
    if (!/\btype\s*=\s*(["']?)module\1(?=[\s>/]|$)/i.test(attributes)) continue;
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    if (src) sources.push(src[1] ?? src[2]);
  }
  return sources;
}

const cancelBody = (response: Response) => response.body?.cancel().catch(() => undefined);

/** The control plane's own evidence that the home serves (Astra AUTOCANARY-1 P1: everything else is the machine's self-report), all
 *  from the Worker under one AUTO_CANARY_PROBE_MS timeout, no redirects followed, no credentials (a Worker fetch sends no cookies and
 *  this one sets no Authorization). Never throws; anything unexpected, a network error or the timeout is a failed probe.
 *  (1) GET https://<hostname>/api/health: the home's Caddy serves only its public host, and an unsigned visitor through the proxy gets
 *  exactly {"app":"murage","ui":"ok"|"failed"|"pending","uiAt":<ms|null>,"instance":"<id>"} (server/index.ts), so a 200 with that body
 *  proves DNS + tunnel + Caddy + app. Any other key fails the probe. Read capped at AUTO_CANARY_PROBE_MAX_BYTES (readCapped).
 *  The render half (Astra AUTOCANARY-5 P1/P2), `rendered`: the body has all four keys, "ui" is explicitly "ok" (a body without "ui", from
 *  an app restarted into an older image, never passes), uiAt is a render that finished within AUTO_CANARY_RENDER_MAX_AGE_MS of now and
 *  not more than AUTO_CANARY_RENDER_SKEW_MS ahead (null, a pending render, never passes), and "instance" is `instance`, the app process
 *  the latest stored heartbeat names: the public origin and the credentialed channel describe the same running process.
 *  (2) The functional UI (Astra AUTOCANARY-3 P1: uiBundle proves only that a file exists on the image): GET https://<hostname>/ must be
 *  200 text/html, at most AUTO_CANARY_UI_MAX_BYTES, carrying both UI_MARKERS and exactly one module script, /assets/index-<hash>.js;
 *  then GET that script on the same host must be 200 with a JavaScript content type and a non-empty body (only its first
 *  AUTO_CANARY_ASSET_READ_BYTES are read). Until the home serves the built UI (the door lane sets MURAGE_STATIC_DIR on the image), GET /
 *  answers a JSON 404 and no home is promoted automatically: that is correct, and the admin canary remains the override.
 *  `served`: (1) without its render half, and (2). `uiAt`: the public answer's render time when `rendered` (Astra AUTOCANARY-6 P2:
 *  kept so the promotion judges its age again at its own, later time), else null. Null when the probe was not started: one started now
 *  could end past `deadline` (re-checked immediately before every fetch, Astra AUTOCANARY-5 P2). */
async function probeHome(fetcher: typeof fetch, hostname: string, instance: string | null, deadline: number):
  Promise<ProbeResult | null> {
  const failed: ProbeResult = { served: false, rendered: false, uiAt: null };
  if (Date.now() + AUTO_CANARY_PROBE_MS > deadline) return null;
  if (!PUBLIC_HOSTNAME.test(hostname)) return failed;
  // This probe's own deadline, started when its first request is issued (Astra AUTOCANARY-4 P2), shared by its later requests.
  let signal: AbortSignal | undefined;
  const get = (path: string, accept: string) => {
    if (signal && Date.now() > deadline) throw new Error("auto_canary_stage_over");
    return fetcher(`https://${hostname}${path}`, { method: "GET", redirect: "manual",
      headers: { accept }, signal: signal ??= AbortSignal.timeout(AUTO_CANARY_PROBE_MS) });
  };
  try {
    const health = await get("/api/health", "application/json");
    if (health.status !== 200) { await cancelBody(health); return failed; }
    const bytes = await readCapped(health, AUTO_CANARY_PROBE_MAX_BYTES);
    if (bytes === null) return failed;
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!(typeof body === "object" && body !== null && !Array.isArray(body))) return failed;
    const answer = body as { app?: unknown; door?: unknown; ui?: unknown; uiAt?: unknown; instance?: unknown };
    // A door-v2 home also names its door ("door":"v1"|"v2"); it is not part of the render evidence.
    if ("door" in answer && answer.door !== "v1" && answer.door !== "v2") return failed;
    const keys = Object.keys(answer).filter((key) => key !== "door");
    if (answer.app !== "murage" || !keys.every((key) => ["app", "ui", "uiAt", "instance"].includes(key))) return failed;
    const answeredAt = Date.now();
    const renderedNow = keys.length === 4 && answer.ui === "ok" && typeof answer.uiAt === "number" && Number.isSafeInteger(answer.uiAt)
      && answeredAt - answer.uiAt <= AUTO_CANARY_RENDER_MAX_AGE_MS && answer.uiAt <= answeredAt + AUTO_CANARY_RENDER_SKEW_MS
      && typeof answer.instance === "string" && UI_INSTANCE.test(answer.instance) && instance !== null && answer.instance === instance;

    const page = await get("/", "text/html");
    if (page.status !== 200 || !/^text\/html\s*(?:;|$)/i.test(page.headers.get("content-type") ?? "")) { await cancelBody(page); return failed; }
    const shell = await readCapped(page, AUTO_CANARY_UI_MAX_BYTES);
    if (shell === null) return failed;
    const html = new TextDecoder("utf-8", { fatal: true }).decode(shell);
    if (!UI_MARKERS.every((marker) => html.includes(marker))) return failed;
    const scripts = moduleScriptSources(html);
    if (scripts.length !== 1 || !UI_ENTRY_SCRIPT.test(scripts[0])) return failed;

    const asset = await get(scripts[0], "*/*");
    if (asset.status !== 200 || !JAVASCRIPT_TYPE.test(asset.headers.get("content-type") ?? "")) { await cancelBody(asset); return failed; }
    const served = (await readPrefix(asset, AUTO_CANARY_ASSET_READ_BYTES)) > 0;
    const rendered = served && renderedNow;
    return { served, rendered, uiAt: rendered ? answer.uiAt as number : null };
  } catch {
    return failed;
  }
}

interface ProbeResult { served: boolean; rendered: boolean; uiAt: number | null }
interface AutoCanaryCandidate { id: string; generation: number; hostname: string; tunnelId: string; dnsRecordId: string;
  endpointUpdatedAt: number; appOkAt: number; heartbeatAt: number; uiInstance: string | null; renderOk: number; probedAt: number | null;
  epoch: number }

/** The ids as one JSON array bind, for `IN (SELECT value FROM json_each(?))`: one statement for a whole pass. */
const idList = (ids: string[]) => JSON.stringify(ids);

/** The automatic canary (reconcileB3, after the per-home loop): no one posts the admin canary for a customer home, so a paid home in
 *  'checking', within its provisioning budget, that live evidence shows serving passes exactly as a passed admin canary would
 *  (canaryOutcome). Candidates are the homes whose cheap D1 evidence apart from the render (AUTO_CANARY_BASE) holds, taken across the
 *  whole fleet (not the reconcile page) oldest probe first (provision_attempts.probed_at, never-probed first), at most
 *  AUTO_CANARY_PROBE_BUDGET_PER_PASS per pass, AUTO_CANARY_PROBE_CONCURRENCY at a time, none started once it could end past the stage's
 *  AUTO_CANARY_STAGE_MS (Astra AUTOCANARY-3 P2). Homes without render evidence are probed too: that is how a renderer regression is seen
 *  (UI_RENDER_MISSING_ALERT); only a home whose stored render (AUTO_CANARY_RENDER) and public render both pass is promoted.
 *  Pipelined (Astra AUTOCANARY-5 P2): (1) one read of every candidate; (2) one statement stamps every candidate's probed_at, so a home
 *  whose probe failed waits behind every other candidate (Astra AUTOCANARY-2 P2) and every candidate is probed within
 *  ceil(n / AUTO_CANARY_PROBE_BUDGET_PER_PASS) passes; (3) the probe stage, with no D1 call in it; (4) one batch puts back the probed_at of
 *  candidates the stage had no time for (they keep their place) and keeps ui_missing_since; (5) the render alerts; (6) the promotions,
 *  each its own guarded batch, AUTO_CANARY_PROBE_CONCURRENCY at a time. Returns how many homes failed with an error. Exported for the
 *  throughput test. */
export async function autoCanaryPass(env: Env, fetcher: typeof fetch): Promise<number> {
  const read = Date.now();
  const candidates = (await env.DB.prepare(`SELECT h.id AS id, h.generation AS generation, e.hostname AS hostname, e.tunnel_id AS tunnelId,
      e.dns_record_id AS dnsRecordId, e.updated_at AS endpointUpdatedAt, x.app_ok_at AS appOkAt, h.heartbeat_at AS heartbeatAt,
      x.ui_instance AS uiInstance, CASE WHEN ${AUTO_CANARY_RENDER} THEN 1 ELSE 0 END AS renderOk, p.probed_at AS probedAt,
      x.evidence_epoch AS epoch
    FROM ${AUTO_CANARY_FROM}
    WHERE h.desired_state='checking' AND p.first_at>? AND ${AUTO_CANARY_BASE}${doorReadySql(env)}
    ORDER BY p.probed_at ASC NULLS FIRST, h.id LIMIT ?`)
    .bind(read - AUTO_CANARY_RENDER_MAX_AGE_MS, read - PROVISION_MAX_MS, read - AUTO_CANARY_FRESH_MS, read - AUTO_CANARY_FRESH_MS,
      AUTO_CANARY_PROBE_BUDGET_PER_PASS).all<AutoCanaryCandidate>()).results;
  const stamp = Date.now();
  if (candidates.length) {
    await env.DB.prepare("UPDATE provision_attempts SET probed_at=? WHERE home_id IN (SELECT value FROM json_each(?))")
      .bind(stamp, idList(candidates.map((c) => c.id))).run();
  }

  // The probe stage: fetches only.
  const deadline = Date.now() + AUTO_CANARY_STAGE_MS;
  const results: (ProbeResult | null)[] = candidates.map(() => null);
  let next = 0;
  const prober = async () => {
    for (;;) {
      const index = next++;
      if (index >= candidates.length) return;
      const c = candidates[index];
      const result = await probeHome(fetcher, c.hostname, c.uiInstance, deadline);
      if (result === null) { next = candidates.length; return; } // no time left: the rest keep their place for the next pass
      results[index] = result;
    }
  };
  await Promise.all(Array.from({ length: Math.min(AUTO_CANARY_PROBE_CONCURRENCY, candidates.length) }, prober));

  // Bookkeeping, one batch: candidates not probed get their place back; render-missing homes keep (or start) ui_missing_since, every
  // other probed home and every home no longer a candidate loses it.
  const now = Date.now();
  const skipped = candidates.filter((_, i) => results[i] === null);
  const missing = candidates.filter((c, i) => results[i]?.served === true && !(c.renderOk === 1 && results[i]?.rendered === true));
  const clear = candidates.filter((c, i) => results[i] !== null && !missing.includes(c));
  const bookkeeping = await env.DB.batch([
    env.DB.prepare(`UPDATE provision_attempts SET probed_at=(SELECT json_extract(value,'$.at') FROM json_each(?2) WHERE json_extract(value,'$.id')=home_id)
      WHERE probed_at=?1 AND home_id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))`)
      .bind(stamp, JSON.stringify(skipped.map((c) => ({ id: c.id, at: c.probedAt })))),
    env.DB.prepare(`UPDATE provision_attempts SET ui_missing_since=NULL WHERE ui_missing_since IS NOT NULL
      AND (home_id IN (SELECT value FROM json_each(?)) OR home_id NOT IN (SELECT h.id FROM ${AUTO_CANARY_FROM}
        WHERE h.desired_state='checking' AND p.first_at>? AND ${AUTO_CANARY_BASE}${doorReadySql(env)}))`)
      .bind(idList(clear.map((c) => c.id)), now - PROVISION_MAX_MS, now - AUTO_CANARY_FRESH_MS, now - AUTO_CANARY_FRESH_MS),
    env.DB.prepare(`UPDATE provision_attempts SET ui_missing_since=COALESCE(ui_missing_since,?) WHERE home_id IN (SELECT value FROM json_each(?))
      AND gave_up_at IS NULL RETURNING home_id AS id, ui_missing_since AS since`).bind(now, idList(missing.map((c) => c.id))),
    // Each probe's result (Astra AUTOCANARY-10), against the epoch read before it started, in one statement: a pass is recorded only
    // while that epoch is still current (compare-and-set); a pass whose epoch moved meanwhile is dropped, and a failed probe is a negative
    // event, both bumping the epoch. Probes are evidence of this generation only.
    ...candidates.flatMap((c, i) => {
      const r = results[i];
      if (r === null) return [];
      const ok = r.rendered ? 1 : 0;
      return [env.DB.prepare(`UPDATE cloud_home_health SET
          probe_epoch=CASE WHEN ?3=1 AND evidence_epoch=?4 THEN ?4 END,
          probe_instance=CASE WHEN ?3=1 AND evidence_epoch=?4 THEN ?5 END,
          probe_ui_at=CASE WHEN ?3=1 AND evidence_epoch=?4 THEN ?6 END,
          probe_at=?7,
          drop_reason=CASE WHEN ?3=0 THEN 'probe_failed' WHEN evidence_epoch<>?4 THEN 'stale_probe' ELSE drop_reason END,
          dropped_at=CASE WHEN ?3=1 AND evidence_epoch=?4 THEN dropped_at ELSE ?7 END,
          evidence_epoch=CASE WHEN ?3=1 AND evidence_epoch=?4 THEN evidence_epoch ELSE evidence_epoch+1 END
        WHERE home_id=?1 AND generation IS ?2`).bind(c.id, c.generation, ok, c.epoch, ok ? c.uiInstance : null, ok ? r.uiAt : null, now)];
    }),
  ]);
  let failures = 0;
  for (const row of (bookkeeping[2].results ?? []) as { id: string; since: number }[]) {
    if (now - row.since < UI_RENDER_MISSING_ALERT_MS) continue;
    const c = candidates.find((candidate) => candidate.id === row.id)!;
    try {
      // Deduplicated by cloud_alerts_open: a home already alerted changes nothing. Recorded only, never sent here (Astra AUTOCANARY-6
      // P2: a held webhook must not hold the promotions below; the monitoring sweep delivers it), and only while the home is still
      // checking at the generation read, not given up, with its render still missing, checked in the same statement (Astra
      // AUTOCANARY-6 P2: a concurrent canary that made the home ready and resolved its alert is never undone by this stale row).
      await persistAlert(env, { homeId: row.id, kind: UI_RENDER_MISSING_ALERT, severity: "high",
        detail: `checking home serves its UI publicly and every other check passes, but no recent render from its running app for ${Math.floor((now - row.since) / 60_000)} min` }, now,
        { sql: `SELECT 1 FROM cloud_homes h JOIN provision_attempts p ON p.home_id=h.id WHERE h.id=? AND h.generation=?
          AND h.desired_state='checking' AND p.gave_up_at IS NULL AND p.ui_missing_since IS NOT NULL`, binds: [row.id, c.generation] });
    } catch (error) {
      failures++;
      console.error(JSON.stringify({ message: "b3 auto-canary alert failed for a home", homeId: row.id,
        errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown" }));
    }
  }

  // Promotions: each its own guarded batch, outside the probe stage.
  const passed = candidates.filter((c, i) => c.renderOk === 1 && results[i]?.rendered === true);
  let promote = 0;
  const promoter = async () => {
    for (;;) {
      const c = passed[promote++];
      if (!c) return;
      try {
        const h = await home(env.DB, c.id);
        if (h.generation !== c.generation || h.desired_state !== "checking") continue;
        await autoCanary(env, h, c);
      } catch (error) {
        failures++;
        console.error(JSON.stringify({ message: "b3 auto-canary failed for a home", homeId: c.id,
          errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown" }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AUTO_CANARY_PROBE_CONCURRENCY, passed.length) }, promoter));
  // Reconcile (Astra AUTOCANARY-6 P2): a render alert open for a home that no longer waits in 'checking' (ready, failed, deleted, or
  // gone) is resolved, whatever opened it, without network (the monitoring sweep sends the notice).
  try {
    await env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE kind=? AND resolved_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM cloud_homes WHERE id=cloud_alerts.home_id AND desired_state='checking')`)
      .bind(Date.now(), UI_RENDER_MISSING_ALERT).run();
  } catch (error) {
    failures++;
    console.error(JSON.stringify({ message: "b3 auto-canary alert reconcile failed",
      errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown" }));
  }
  return failures;
}

/** One candidate's promotion, after its probe passed and was recorded. `now` is read here, after the probe (Astra AUTOCANARY-2 P3), and
 *  the batch re-checks every piece of evidence at the epoch read before the probe (Astra AUTOCANARY-10: report and probe recorded at it,
 *  and it still current), with freshness and render age judged at this later time and the endpoint pinned to the row read before the
 *  probe, so a negative event recorded since by any worker, evidence that aged out, an endpoint replaced, or a provisioning budget that ran
 *  out (Astra AUTOCANARY-3 P3) never promotes. True when the home became ready. */
async function autoCanary(env: Env, h: Home, c: AutoCanaryCandidate): Promise<boolean> {
  // The database clock first, then ours: the guard's execution time is never earlier than the real one (AUTO_CANARY_EVIDENCE_SQL).
  const dbAt = (await env.DB.prepare(AUTO_CANARY_DB_ANCHOR_SQL).first<{ dbAt: number }>())!.dbAt;
  const now = Date.now();
  const binds = [now, dbAt, h.id, h.generation, c.epoch, c.hostname, c.tunnelId, c.dnsRecordId, c.endpointUpdatedAt];
  const guard = crypto.randomUUID();
  try {
    await canaryOutcome(env, h, true, { auto: true, generation: h.generation, imageDigest: h.image_digest,
      evidence: { appOkAt: c.appOkAt, heartbeatAt: c.heartbeatAt, endpoint: "ready", probe: "ok" } }, now, [
      env.DB.prepare(`INSERT INTO cloud_write_guards VALUES (?,${autoCanaryEvidenceSql(doorReadySql(env))})`).bind(guard, ...binds),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guard),
    ]);
  } catch (error) {
    // Lost a race (state, generation, epoch, evidence or endpoint moved since the read, or the evidence or the budget ran out during
    // the probe): nothing was written; a later pass looks again.
    const current = await home(env.DB, h.id);
    if (current.generation !== h.generation || current.desired_state !== h.desired_state
      || !(await env.DB.prepare(`SELECT ${autoCanaryEvidenceSql(doorReadySql(env))} AS ok`).bind(...binds).first<{ ok: number }>())?.ok) return false;
    throw error;
  }
  return true;
}

/** Round 10 (Astra TAXCOUNTRY-9 P1-5): THE RESUME CONSUMER. Every open resume_required obligation (a billing-suspended home that was paid):
 *  - the home is no longer suspended (resumed through POST /v1/machines/{id}/resume, or deleted/failed by another path): completed with
 *    what it found, its alert resolved (persisted; claimed delivery);
 *  - still suspended past its deadline (resumeBy; a payload without one: created_at + RESUME_DEADLINE_MS): the resume could not complete,
 *    so the payment is refunded: in ONE batch fenced on the home still suspended at the generation read and the obligation still open, the
 *    obligation is completed (outcome refunded), its payment's refund obligation refund:resume_lapsed:<paymentId> is written (it ends that
 *    payment's own subscription, b5-billing.ts), the home's entitlement becomes refund_pending, its deletion clock starts again (a fresh
 *    retention period and notices) and ONE high alert says so;
 *  - otherwise it waits (its alert stays open). Returns the failures. */
async function settleResumes(env: Env, config: B3Config, now: number): Promise<number> {
  const rows = await env.DB.prepare(`SELECT o.id,o.home_id,o.payload,o.created_at FROM cloud_outbox o WHERE o.kind='resume_required' AND o.completed_at IS NULL
    ORDER BY o.created_at LIMIT 50`).all<{ id: string; home_id: string; payload: string; created_at: number }>();
  let failures = 0;
  for (const r of rows.results) {
    try {
      const h = await home(env.DB, r.home_id);
      let p: { paymentId?: string; subscriptionId?: string | null; resumeBy?: number } = {};
      try { p = JSON.parse(r.payload) as typeof p; } catch { /* legacy payload: the deadline from its age */ }
      const paid = await env.DB.prepare("SELECT payload,created_at FROM cloud_outbox WHERE id=?").bind(`payment:${r.id.slice("resume_required:".length)}`).first<{ payload: string; created_at: number }>();
      const paymentId = p.paymentId ?? (paid ? (JSON.parse(paid.payload) as { paymentId?: string }).paymentId : undefined);
      // Astra INTEGRATED-7 P1: the obligation is about ITS payment (and subscription), never the home as it stands now. It is that payment's
      // resume only while the home still rests on it (C1's current payment; the same subscription line); a replacement contract (C paid and
      // took the home) supersedes it: the payment is refunded on its own, the home and C's resume untouched.
      const mine = paymentId !== undefined && await env.DB.prepare(`SELECT 1 AS x FROM cloud_homes WHERE id=? AND ${currentPaymentId("cloud_homes.id")} IS ?
        AND (? IS NULL OR payment_line IS ?)`).bind(h.id, paymentId, p.subscriptionId ?? null, p.subscriptionId ?? null).first() !== null;
      const deleted = h.desired_state === "deleting" || h.desired_state === "deleted";
      if (h.desired_state !== "suspended" && mine && !deleted) {
        // Resumed (or moved on by another path that owns its payment from here: a give-up refunds it): completed with what it found.
        await env.DB.batch([
          env.DB.prepare("UPDATE cloud_outbox SET completed_at=?,receipt=? WHERE id=? AND completed_at IS NULL")
            .bind(now, JSON.stringify({ outcome: "resumed", state: h.desired_state }), r.id),
          resumeAlertResolved(env, h.id, r.id, now),
        ]);
        continue;
      }
      const deadline = typeof p.resumeBy === "number" ? p.resumeBy : r.created_at + RESUME_DEADLINE_MS;
      // Still this payment's suspended home inside its deadline: it waits.
      if (h.desired_state === "suspended" && mine && now < deadline) continue;
      if (!paymentId || !paid) {
        await persistAlert(env, { homeId: h.id, kind: "billing.resume_unresolvable", severity: "high",
          detail: `resume obligation ${r.id} cannot complete (${deleted ? "the home was deleted" : mine ? "its deadline passed" : "the home moved to another payment"}) but its payment hand-off is missing: refund that payment by hand` }, now);
        continue;
      }
      // Astra INTEGRATED-8 P1: DURABLE SERVICE HISTORY before any unserved-payment refund. The resume route completes its payment's
      // obligations itself (above); one resumed before that (or by a path that left the record open) is still recognised from the home's
      // history: a 'resumed' transition after this payment's hand-off with no other payment handed off in between (the resume served THIS
      // payment). Served usage is billed, never refunded as unserved: completed as resumed.
      const served = await env.DB.prepare(`SELECT 1 AS x FROM cloud_outbox e WHERE e.home_id=? AND e.kind='resumed' AND e.created_at>=?
        AND NOT EXISTS (SELECT 1 FROM cloud_outbox p WHERE p.home_id=e.home_id AND p.kind='payment_paid' AND json_extract(p.payload,'$.paymentId') IS NOT ?
          AND p.created_at>=? AND p.created_at<=e.created_at) LIMIT 1`).bind(h.id, paid.created_at, paymentId, paid.created_at).first() !== null;
      if (served) {
        await env.DB.batch([
          env.DB.prepare("UPDATE cloud_outbox SET completed_at=?,receipt=? WHERE id=? AND completed_at IS NULL")
            .bind(now, JSON.stringify({ outcome: "resumed", state: h.desired_state, by: "service_history" }), r.id),
          resumeAlertResolved(env, h.id, r.id, now),
        ]);
        continue;
      }
      // The payment was never served by a resume: owed back through ITS refund obligation, written in the SAME batch that completes the
      // resume record (Astra INTEGRATED-7 P1: a deletion before the resume never completes it as home_deleted with the money kept).
      //  - lapsed (still this payment's suspended home past its deadline): the home's entitlement and deletion clock follow, fenced on the
      //    home still suspended at the generation read AND still resting on this payment and subscription;
      //  - deleted (deleting or deleted before any resume): the home is marked refund_pending like every retired home owed a refund;
      //  - superseded (the home rests on another payment now): the home is not touched at all.
      const outcome = deleted ? "home_deleted" : mine ? "refunded" : "superseded";
      const obligation = `refund:resume_lapsed:${paymentId}`;
      const g = crypto.randomUUID();
      const homeFence = `${currentPaymentId("cloud_homes.id")} IS ? AND (? IS NULL OR payment_line IS ?)`;
      const fenceBinds = [paymentId, p.subscriptionId ?? null, p.subscriptionId ?? null];
      await env.DB.batch([
        env.DB.prepare("UPDATE cloud_outbox SET completed_at=?,receipt=? WHERE id=? AND completed_at IS NULL")
          .bind(now, JSON.stringify({ outcome, obligation, deadline, state: h.desired_state }), r.id),
        env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(`${g}-o`),
        ...(outcome === "refunded" ? [
          env.DB.prepare(`UPDATE cloud_homes SET entitlement='refund_pending',delete_after=?,suspension_notices=0,updated_at=?
            WHERE id=? AND generation=? AND desired_state='suspended' AND ${homeFence}`).bind(now + config.retentionMs, now, h.id, h.generation, ...fenceBinds),
          env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(`${g}-h`),
        ] : outcome === "home_deleted" ? [
          env.DB.prepare(`UPDATE cloud_homes SET entitlement='refund_pending',updated_at=? WHERE id=? AND desired_state IN ('deleting','deleted')
            AND entitlement='paid' AND ${homeFence}`).bind(now, h.id, ...fenceBinds),
        ] : []),
        env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at) SELECT ?,id,generation,owner_id,'refund_required',?,?
          FROM cloud_homes WHERE id=? AND ${NOT_VOIDED} AND NOT ${provisionRefundFor("?", "?")} ON CONFLICT(id) DO NOTHING`)
          .bind(obligation, paid.payload, now, h.id, h.id, paymentId, h.id, paymentId),
        resumeAlertResolved(env, h.id, r.id, now),
        env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(crypto.randomUUID(), h.id, "billing.resume_lapsed", "high", outcome === "refunded"
            ? `the paid, billing-suspended home was not resumed by ${new Date(deadline).toISOString()}: payment ${paymentId} is refunded (${obligation}), its plan ended, and the deletion clock started again`
            : outcome === "home_deleted"
              ? `the paid, billing-suspended home was deleted before its resume: payment ${paymentId} was never served and is refunded (${obligation})`
              : `payment ${paymentId} paid to resume this home was superseded by a later contract before any resume: it is refunded (${obligation}); the home and the later contract are untouched`,
          now, paymentId),
        env.DB.prepare("DELETE FROM cloud_write_guards WHERE id LIKE ?").bind(`${g}-%`),
      ]).catch(async (e) => {
        const again = await env.DB.prepare("SELECT completed_at FROM cloud_outbox WHERE id=?").bind(r.id).first<{ completed_at: number | null }>();
        const now2 = await home(env.DB, h.id);
        if (again?.completed_at == null && now2.desired_state === h.desired_state && now2.generation === h.generation) throw e; // not a lost race: a failure
      });
    } catch (error) {
      failures++;
      console.error(JSON.stringify({ message: "b3 resume settlement failed", homeId: r.home_id, errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown" }));
    }
  }
  return failures;
}
/** The payment a resume_required obligation row `o` is about: its payload's paymentId, or (a legacy payload) its paid hand-off's. */
const RESUME_PAYMENT_SQL = (o: string) => `COALESCE(json_extract(${o}.payload,'$.paymentId'),(SELECT json_extract(pp.payload,'$.paymentId')
  FROM cloud_outbox pp WHERE pp.id='payment:'||substr(${o}.id,17)))`;
/** The home's billing.resume_required alert, resolved once no OTHER resume obligation of the home is open. */
const resumeAlertResolved = (env: Env, homeId: string, obligationId: string, now: number) => env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1
  WHERE home_id=? AND kind='billing.resume_required' AND resolved_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM cloud_outbox x WHERE x.home_id=? AND x.kind='resume_required' AND x.completed_at IS NULL AND x.id<>?)`).bind(now, homeId, homeId, obligationId);

/** Round 10 (Astra TAXCOUNTRY-9 P1-5): THE OPERATOR'S RESUME of a paid, billing-suspended home (POST /v1/machines/{id}/resume, admin). Ops
 *  first lifts the provider quarantine and powers the server on (the runbook); this route then moves the home back to 'checking' (a new
 *  generation: the machine enrols again) with a fresh canary budget, its suspension cause cleared, in ONE batch fenced on: still suspended at
 *  the generation read, paid, billing-caused, and an OPEN resume obligation (a lapsed one was refunded: 409). The automatic canary promotes it
 *  to ready on live evidence; one that never becomes healthy within the budget is given up and refunded by the normal path. */
async function resumeHome(env: Env, h: Home, now: number): Promise<Response> {
  if (h.desired_state !== "suspended" || h.entitlement !== "paid") throw new HTTPError(409, "state_conflict");
  const g = crypto.randomUUID();
  try {
    await transition(env, h, "checking", "resumed", now, true, [
      // Read after the transition's own UPDATE (the home is already 'checking' in this batch): the cause and abuse checks of BILLING_SUSPENSION.
      env.DB.prepare(`INSERT INTO cloud_write_guards VALUES (?,EXISTS (SELECT 1 FROM cloud_outbox WHERE home_id=? AND kind='resume_required' AND completed_at IS NULL)
        AND EXISTS (SELECT 1 FROM cloud_homes bs WHERE bs.id=? AND bs.entitlement='paid' AND COALESCE(bs.suspension_cause,'billing')='billing'
          AND NOT EXISTS (SELECT 1 FROM abuse_closures ac WHERE ac.home_id=bs.id)
          AND NOT EXISTS (SELECT 1 FROM billing_subscriptions ab WHERE ab.home_id=bs.id AND ab.abuse_closed_at IS NOT NULL)))`).bind(g, h.id, h.id),
      env.DB.prepare("UPDATE cloud_homes SET delete_after=NULL,suspension_cause=NULL,suspension_notices=0 WHERE id=?").bind(h.id),
      env.DB.prepare("UPDATE provision_attempts SET first_at=?,attempts=0,next_at=0 WHERE home_id=? AND resource_generation=? AND gave_up_at IS NULL")
        .bind(now, h.id, h.resource_generation),
      // Astra INTEGRATED-8 P1: THE RESUME IS RECORDED HERE, atomically: every open resume obligation of the payment the home rests on (C1's
      // current payment; duplicates of it included) is completed as resumed (served) in this batch, and the resume needs at least one.
      // Leaving it to the sweep let a replacement contract (C) take the home first, so the sweep saw A's served payment as superseded and
      // refunded it in full.
      env.DB.prepare(`UPDATE cloud_outbox SET completed_at=?,receipt=json_object('outcome','resumed','state','checking','by','resume_route','servedFrom',?)
        WHERE home_id=? AND kind='resume_required' AND completed_at IS NULL AND ${RESUME_PAYMENT_SQL("cloud_outbox")} IS ${currentPaymentId("cloud_outbox.home_id")}`)
        .bind(now, now, h.id),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes()>0)").bind(`${g}-r`),
      resumeAlertResolved(env, h.id, "", now), // its billing.resume_required alert, once no resume obligation of the home is left open
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id IN (?,?)").bind(g, `${g}-r`),
    ]);
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    throw new HTTPError(409, "not_resumable");
  }
  return json({ resumed: true, state: "checking" });
}

/** The hosting provider for this mode: injected (tests), live (build host/Vultr) or the inert fake. */
export function providerFor(env: Env, dependencies: B3Dependencies = {}): ProviderAdapter {
  const provider = dependencies.provider?.(env.DB) ?? (env.CLOUD_B3_MODE === "live" ? createLiveProvider(env) : fakeProvider(env.DB));
  if (dependencies.callBoundMs) callBounds.set(provider, dependencies.callBoundMs);
  return provider;
}

export async function reconcileB3(env: Env, dependencies: B3Dependencies = {}): Promise<void> {
  if (!b3Enabled(env)) return;
  const config = b3Config(env);
  const now = Date.now();
  const provider = providerFor(env, dependencies);
  const probeFetch = dependencies.probeFetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  await seedCapacity(env.DB, config);
  await processPayments(env, config, now);
  await expireReservations(env, now);
  // Live mode refunds through Stripe (sweepBilling), never the fake ledger.
  const refunds = env.CLOUD_B3_MODE === "live" ? { results: [] as { id: string; home_id: string; payload: string }[] } : await env.DB.prepare("SELECT id,home_id,payload FROM cloud_outbox WHERE kind='refund_required' AND completed_at IS NULL LIMIT 100")
    .all<{ id: string; home_id: string; payload: string }>();
  for (const refund of refunds.results) {
    const payment = paymentSchema.parse(JSON.parse(refund.payload));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cloud_fake_refunds VALUES (?,?,?,?) ON CONFLICT(payment_id) DO NOTHING")
        .bind(payment.paymentId, refund.home_id, payment.eventId, now),
      // Astra MAILRETRY-12 P2: 'refunded' only when no other refund obligation of the home is open (NO_OTHER_REFUND_OPEN), whichever completes.
      env.DB.prepare(`UPDATE cloud_homes SET entitlement='refunded' WHERE id=? AND entitlement='refund_pending' AND ${NO_OTHER_REFUND_OPEN}`)
        .bind(refund.home_id, refund.home_id, refund.id),
      env.DB.prepare("UPDATE cloud_outbox SET completed_at=?,receipt=? WHERE id=?")
        .bind(now, JSON.stringify({ fakeOnly: true, outcome: "refunded", paymentId: payment.paymentId,
          reason: "reservation_expired_and_no_capacity" }), refund.id),
    ]);
  }
  // Overdue give-ups first, before the per-home work order can displace them (Astra MAILRETRY-8 P1; giveUpOverdue). A home given up here is
  // 'failed' when the page below is read, so it takes the failed-home branch (cleanup, retirement), never the checking/provisioning one.
  let failures = await giveUpOverdue(env, provider, now);
  const cursor = await env.DB.prepare("SELECT last_home_id FROM cloud_reconcile_progress WHERE id='homes'").first<{ last_home_id: string }>();
  let rows = await env.DB.prepare("SELECT * FROM cloud_homes WHERE desired_state<>'deleted' AND id>? ORDER BY id LIMIT 100")
    .bind(cursor?.last_home_id ?? "").all<Home>();
  if (!rows.results.length && cursor?.last_home_id) {
    rows = await env.DB.prepare("SELECT * FROM cloud_homes WHERE desired_state<>'deleted' ORDER BY id LIMIT 100").all<Home>();
  }
  await env.DB.prepare(`INSERT INTO cloud_reconcile_progress VALUES ('homes',?)
    ON CONFLICT(id) DO UPDATE SET last_home_id=excluded.last_home_id`)
    .bind(rows.results.length === 100 ? rows.results[99].id : "").run();
  for (let h of rows.results) {
    try {
    if (h.desired_state === "failed") {
      // A given-up home: keep releasing its resources until the provider shows none left.
      const pending = await env.DB.prepare(`SELECT 1 AS x FROM provision_attempts WHERE home_id=? AND resource_generation=?
        AND gave_up_at IS NOT NULL AND cleaned_at IS NULL`).bind(h.id, h.resource_generation).first();
      if (pending) await releaseFailedResources(env, h, provider, now);
      await retireRefundedFailedHome(env, h.id, now);
      continue;
    }
    if (h.desired_state === "provisioning") {
      if (h.entitlement === "paid") await provision(env, h, provider, now);
      continue;
    }
    if (h.desired_state === "checking" && h.entitlement === "paid") {
      // Booted but never became healthy (enrolment or tunnel never completed) within the same budget: give up and refund.
      const budget = await env.DB.prepare("SELECT first_at FROM provision_attempts WHERE home_id=? AND resource_generation=? AND gave_up_at IS NULL")
        .bind(h.id, h.resource_generation).first<{ first_at: number }>();
      if (budget && now - budget.first_at >= PROVISION_MAX_MS) { await giveUp(env, h, provider, "home_never_ready", now); continue; }
      // Within the budget: the home passes its canary by itself once live evidence shows it serving (autoCanaryPass, after this loop).
    }
    if (h.desired_state === "payment_problem" && h.grace_until !== null && h.grace_until <= now) {
      await transition(env, h, "suspended", "suspended", now, true, [
        // Round 10 (P1-5): the cause is recorded: only a billing suspension is ever resumed by a payment.
        env.DB.prepare("UPDATE cloud_homes SET delete_after=?,suspension_notices=0,suspension_cause='billing' WHERE id=?").bind(now + config.retentionMs, h.id),
        // Astra TAXCOUNTRY-8 P1-2: the payment line suspended is recorded, so a revoke delivered after another subscription took the home
        // stops nothing of the new contract (b5-billing.ts).
        outbox(env.DB, { ...h, generation: h.generation + 1 }, "external_revoke_required",
          { sessions: "export_and_billing_only", flux: true, connectedApps: true, paymentLine: h.payment_line ?? null }, now),
      ]);
      h = await home(env.DB, h.id);
    }
    if (["stopped", "suspended", "deleting"].includes(h.desired_state)) {
      await fence(env, h, provider, now);
    }
    if (h.desired_state === "suspended") await provider.snapshot_home?.(h.id, h.resource_generation);
    // An open "request my data" pauses the deletion (Murage Cloud terms: nothing is deleted while an export request is open, for at most 7 days).
    if (h.desired_state === "suspended" && h.delete_after !== null && h.delete_after <= now && h.suspension_notices >= 2
      && !(await exportPausesDeletion(env, h.id, now))) {
      // The same batch re-checks for an export request accepted since the read above: an accepted request always holds the deletion.
      const exportGuard = crypto.randomUUID();
      try {
        await transition(env, h, "deleting", "retention_ended", now, true, [
          env.DB.prepare(`INSERT INTO cloud_write_guards VALUES (?,${NO_EXPORT_HOLD_SQL})`).bind(exportGuard, h.id, now),
          env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(exportGuard),
        ]);
      } catch (error) {
        if (await exportPausesDeletion(env, h.id, now)) continue;
        throw error;
      }
      h = await home(env.DB, h.id);
    }
    if (h.desired_state === "deleting") {
      if (h.dns_removed_at === null) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM cloud_fake_dns WHERE home_id=?").bind(h.id),
          env.DB.prepare("UPDATE cloud_homes SET dns_removed_at=? WHERE id=? AND dns_removed_at IS NULL").bind(now, h.id),
          outbox(env.DB, h, "dns_removed", { ttl: 60, releaseNotBefore: now + 60_000 }, now),
        ]);
        continue;
      }
      if (now < h.dns_removed_at + 60_000) continue;
      // Both server IP and volume destruction must follow the DNS TTL.
      for (const resource of checkedResources(await provider.list_by_tag(h.id, h.resource_generation, "home"), h, "home")) await provider.destroy(resource.id);
      await destroyVolumes(provider, h);
      await provider.purge_snapshots?.(h.id, h.resource_generation);
      // Astra INTEGRATED-1 #2: the service is gone, but the home is RETIRED only on settlement evidence: no checkout of it may still complete
      // or be paid (CHECKOUT_MAY_SETTLE_SQL) and no payment waits in the inbox. Until then it stays 'deleting', so a late completion still
      // reaches billing and its payment becomes a refund obligation (processPayments); the deletion finishes when the attempt resolves.
      // Astra INTEGRATED-2 #1 (RULE B): nor while its plan's end is owed (DELETION_BILLING_OPEN_SQL: a subscription Stripe has neither ended nor
      // confirmed ending); billing's in-app cancellation sweep ends it through the gateway, then the deletion finishes.
      if (await env.DB.prepare(`SELECT 1 AS x FROM cloud_homes WHERE id=? AND (${CHECKOUT_MAY_SETTLE_SQL} OR ${DELETION_BILLING_OPEN_SQL}
        OR EXISTS (SELECT 1 FROM cloud_payment_inbox i WHERE i.home_id=cloud_homes.id AND i.processed_at IS NULL))`).bind(h.id).first()) continue;
      // The deletion is dated when it actually completed: after the awaited (and verified) purge, not when this sweep started.
      await transition(env, h, "deleted", "deleted", Date.now(), false, [
        env.DB.prepare("UPDATE cloud_homes SET observed_state='deleted' WHERE id=?").bind(h.id),
        env.DB.prepare("UPDATE cloud_capacity SET home_id=NULL,expires_at=NULL WHERE home_id=?").bind(h.id),
        // The door's notice rows (door.ts) go with the home (sweepCloudRetention catches any other way a home ends).
        env.DB.prepare("DELETE FROM cloud_door_notices WHERE home_id=?").bind(h.id),
      ]);
    }
    } catch (error) {
      const current = await home(env.DB, h.id);
      if (current.generation !== h.generation || current.desired_state !== h.desired_state) {
        // A stale commit has rolled back DNS/bindings. Reconcile its provider
        // effects against current lifecycle without resetting the removal TTL.
        try { await cleanStaleProvision(env, h, provider); continue; } catch { /* record below */ }
      }
      failures++;
      // Operator-facing: the error code only (our own Error messages and adapter status codes carry no secrets or customer data).
      console.error(JSON.stringify({ message: "b3 reconcile failed for a home", homeId: h.id, state: h.desired_state,
        errorCode: error instanceof Error ? error.message.slice(0, 80) : "unknown" }));
      const codes = new Set(["provider_identity_conflict", "provider_ip_missing", "reservation_missing", "machine_identity_conflict", "machine_creation_failed"]);
      const code = error instanceof Error && codes.has(error.message) ? error.message : "reconcile_failed";
      await env.DB.prepare(`INSERT INTO cloud_outbox
        (id,home_id,generation,owner_id,kind,payload,created_at) VALUES (?,?,?,?, 'reconcile_failed',?,?)
        ON CONFLICT(id) DO NOTHING`).bind(`failure:${h.id}:${h.generation}:${now}`, h.id, h.generation,
        h.owner_id, JSON.stringify({ errorCode: code, retryable: true, fakeOnly: true }), now).run();
    }
  }
  // Round 10 (Astra TAXCOUNTRY-9 P1-5): every paid, billing-suspended home's resume obligation is settled (resumed, or refunded at its deadline).
  failures += await settleResumes(env, config, now);
  // The automatic canary, fleet-wide and fair (after the loop, so a home past its budget was given up on first).
  failures += await autoCanaryPass(env, probeFetch);
  // Astra MAILRETRY-14 P1: a late create of a given-up or superseded setup attempt (any resource generation) is reclaimed here.
  failures += await reclaimDispatchedGenerations(env, provider, now);
  // Persisted completion receipt describes fake effects only. External token
  // revocation, real notices/refunds and crypto-shred remain explicitly pending.
  await env.DB.prepare(`UPDATE cloud_outbox SET completed_at=?,receipt=? WHERE completed_at IS NULL
    AND kind IN ('reserved','payment_paid','payment_problem','provider_adopted','suspended',
      'retention_ended','dns_removed','deleted','reservation_expired','canary_passed','canary_failed','synthetic_notice_receipt','stop','delete','quarantine','delete_after_hold')`)
    .bind(now, JSON.stringify({ fakeOnly: true, reconciledAt: now })).run();
  // Surface failure after all other homes have been given their bounded turn.
  if (failures) throw new Error("b3_reconcile_incomplete");
}

async function holderAuthorization(request: Request, env: Env, h: Home, holder: string) {
  if (holder === h.id) {
    await machine(request, env, h);
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    return {
      sql: `EXISTS(SELECT 1 FROM cloud_machines WHERE id=? AND generation=? AND state='active'
        AND credential_hash=? AND EXISTS(SELECT 1 FROM json_each(bound_ips) WHERE value=?))`,
      values: [h.id, h.generation, await sha256(token), request.headers.get("CF-Connecting-IP") ?? ""],
    };
  } else {
    const installation = await requireInstallation(request, env);
    if (installation.installation_id !== h.installation_id || holder !== h.installation_id) throw new HTTPError(403, "forbidden");
    return {
      sql: `EXISTS(SELECT 1 FROM installation_credentials c JOIN installations i ON i.id=c.installation_id
        WHERE i.id=? AND i.owner_user_id=? AND i.revoked_at IS NULL AND c.lookup_id=? AND c.secret_hash=?
          AND c.revoked_at IS NULL AND c.expires_at>?)`,
      values: [h.installation_id, h.owner_id, installation.lookup_id, installation.secret_hash, Date.now()],
    };
  }
}

/** Credential check that needs no request body: some valid caller for this home
 *  (its machine, or an installation). Runs before any body parsing so that an
 *  unauthenticated caller never sees a 400. Holder binding is checked after. */
async function requireHomeCaller(request: Request, env: Env, h: Home) {
  try {
    await machine(request, env, h);
  } catch (error) {
    if (!(error instanceof HTTPError) || error.status === 403) throw error;
    await requireInstallation(request, env);
  }
}

async function lease(request: Request, env: Env, h: Home) {
  await requireHomeCaller(request, env, h);
  const input = await body(request, leaseSchema);
  const authorization = await holderAuthorization(request, env, h, input.holder);
  const now = Date.now();
  if (input.generation !== h.generation) throw new HTTPError(409, "stale_generation");
  if (!["ready", "checking", "payment_problem"].includes(h.desired_state)) throw new HTTPError(409, "home_inactive");
  const result = await env.DB.prepare(`INSERT INTO cloud_leases
    (installation_id,home_id,holder,generation,expires_at,renewed_at) SELECT ?,?,?,?,?,?
    WHERE EXISTS(SELECT 1 FROM cloud_homes WHERE id=? AND generation=? AND installation_id=? AND owner_id=?
      AND desired_state IN ('ready','checking','payment_problem')) AND ${authorization.sql}
    ON CONFLICT(installation_id) DO UPDATE SET home_id=excluded.home_id,holder=excluded.holder,generation=excluded.generation,
      expires_at=excluded.expires_at,renewed_at=excluded.renewed_at,acknowledged=0,fenced=0
    WHERE (cloud_leases.home_id=excluded.home_id AND
      ((cloud_leases.holder=excluded.holder AND cloud_leases.generation=excluded.generation AND cloud_leases.fenced=0 AND cloud_leases.acknowledged=0)
       OR (excluded.generation>cloud_leases.generation AND
         ((cloud_leases.acknowledged=1 AND cloud_leases.holder<>excluded.holder)
           OR cloud_leases.fenced=1 OR cloud_leases.expires_at+?<=?))))
      OR (cloud_leases.home_id<>excluded.home_id AND excluded.generation>cloud_leases.generation
        AND EXISTS(SELECT 1 FROM cloud_homes WHERE id=cloud_leases.home_id AND desired_state='deleted')
        AND (cloud_leases.acknowledged=1 OR cloud_leases.fenced=1 OR cloud_leases.expires_at+?<=?))
    RETURNING expires_at`)
    .bind(h.installation_id, h.id, input.holder, h.generation, now + LEASE_TTL_MS, now,
      h.id, h.generation, h.installation_id, h.owner_id, ...authorization.values,
      LEASE_SKEW_MS, now, LEASE_SKEW_MS, now).first<{ expires_at: number }>();
  if (!result) throw new HTTPError(409, "lease_conflict");
  return json({ wire: WIRE, installationId: h.installation_id, holder: input.holder,
    generation: h.generation, expiresAt: result.expires_at, renewAfterMs: LEASE_FRESH_MS, ttlMs: LEASE_TTL_MS, skewMs: LEASE_SKEW_MS });
}

async function acknowledgeLease(request: Request, env: Env, h: Home) {
  await requireHomeCaller(request, env, h);
  const input = await body(request, leaseSchema);
  const authorization = await holderAuthorization(request, env, h, input.holder);
  if (input.holder === h.id && input.generation !== h.generation) throw new HTTPError(409, "stale_generation");
  const now = Date.now();
  const guard = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`UPDATE cloud_leases SET acknowledged=1
      WHERE installation_id=? AND home_id=? AND holder=? AND generation=? AND acknowledged=0 AND fenced=0
      AND ${authorization.sql}`).bind(h.installation_id, h.id, input.holder, input.generation, ...authorization.values),
    env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guard),
    // An authenticated holder's acknowledgement grants the next generation;
    // the former holder cannot renew it while the acknowledged row awaits takeover.
    env.DB.prepare(`UPDATE cloud_homes SET generation=generation+1,updated_at=? WHERE id=? AND generation=?
      AND desired_state IN ('ready','checking','payment_problem')`).bind(now, h.id, input.generation),
    env.DB.prepare(`UPDATE cloud_machines SET generation=(SELECT generation FROM cloud_homes WHERE id=?) WHERE id=?
      AND EXISTS(SELECT 1 FROM cloud_homes WHERE id=? AND generation=?)`)
      .bind(h.id, h.id, h.id, input.generation + 1),
    outbox(env.DB, h, "lease_acknowledged", { holder: input.holder, generation: input.generation }, now),
    homeChangeBump(env.DB, h.id, h, now), // the next generation: Astra AUTOCANARY-11 P2-1
    env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guard),
  ]);
  return json({ fakeOnly: true, acknowledged: true, generation: (await home(env.DB, h.id)).generation });
}
async function desired(request: Request, env: Env, h: Home, config: B3Config) {
  await machine(request, env, h);
  const row = await env.DB.prepare("SELECT * FROM cloud_leases WHERE installation_id=?").bind(h.installation_id).first<Lease>();
  const now = Date.now();
  const leaseValid = !!row && row.holder === h.id && row.generation === h.generation && !row.fenced && !row.acknowledged && row.expires_at > now;
  const fresh = h.heartbeat_at !== null && h.heartbeat_at + LEASE_FRESH_MS > now;
  const allowed = ["ready", "payment_problem"].includes(h.desired_state) && leaseValid;
  const machineRow = await env.DB.prepare("SELECT public_origin FROM cloud_machines WHERE id=?").bind(h.id).first<{ public_origin: string }>();
  return json({ wire: WIRE, homeId: h.id, generation: h.generation, desiredState: h.desired_state,
    engineSubscriptionGates: config.engineSubscriptionGates, lease: row ? { holder: row.holder, generation: row.generation, expiresAt: row.expires_at } : null,
    executionAllowed: allowed, heartbeatFresh: fresh, heartbeatEveryMs: LEASE_FRESH_MS,
    homeKey: await signPayload(env, { type: "murage-home-key-v1", homeId: h.id, generation: h.generation,
      homeKey: h.home_key, publicOrigin: machineRow?.public_origin, issuedAt: now, expiresAt: now + LEASE_TTL_MS }),
    // B4: the poller's cue to renew this home's Flux key (POST /v1/machines/:id/flux/renewal-due gives the op_id). Behind the same
    // default-off switch as the Flux routes: off, the field is ABSENT and no flux_home_keys row is read.
    ...(fluxRoutesEnabled(env) ? { flux_renewal_due: await fluxRenewalDue(env, h.id, now) } : {}),
  });
}

/** Actions that can lose data or change who has access. Each ALWAYS waits out the 72-hour recovery hold, cancellable from any
 *  registered device or the members area, with a notice to every registered device. A device proof never skips it (a stolen,
 *  unlocked laptop must not be able to wipe a home or add a device at once; SELF-SERVICE.md section 4). */
export const HOLD_ACTIONS = ["delete", "start_fresh", "restore", "cancel_renewal", "pair"] as const;
export type HoldAction = typeof HOLD_ACTIONS[number];
export type HoldSource = "operator" | "customer";

/** Opens a 72-hour hold and, in the same batch, the notice to all registered devices (and anything the caller adds). With `lease` (the home's
 *  billing lease) the batch is fenced: it commits whole only while that lease is held, so a deletion hold and the plan end it journals
 *  (b5-billing.ts deletionPlanEnd) are one transaction (Astra JOURNEY-B-1 #1). */
export async function startHold(env: Env, h: Home, action: HoldAction, source: HoldSource, now: number,
  holdId: string = crypto.randomUUID(), extra: (D1PreparedStatement | Q)[] = [], lease?: HomeLease) {
  const completesAt = now + RECOVERY_HOLD_MS;
  const stmts: (D1PreparedStatement | Q)[] = [
    env.DB.prepare(`INSERT INTO cloud_recovery_holds
      (id,home_id,action,generation,started_at,completes_at,source) VALUES (?,?,?,?,?,?,?)`)
      .bind(holdId, h.id, action, h.generation, now, completesAt, source),
    outbox(env.DB, h, "notice_required", { holdId, audience: "all_registered_devices", action, event: "hold_started",
      completesAt, cancellableFrom: ["any_registered_device", "members_area"] }, now),
    ...extra,
  ];
  if (lease) await fencedBatch(env, lease, stmts);
  else await env.DB.batch(stmts.map((st) => Array.isArray(st) ? env.DB.prepare(st[0]).bind(...(st[1] ?? [])) : st));
  return { holdId, startedAt: now, completesAt };
}

/** Cancels an open hold; every registered device is told. False when the hold had already completed or been cancelled. */
export async function cancelHold(env: Env, h: Home, holdId: string, by: "device" | "customer", now: number): Promise<boolean> {
  const guard = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_recovery_holds SET canceled_at=?,canceled_by=? WHERE id=? AND home_id=? AND completed_at IS NULL AND canceled_at IS NULL")
        .bind(now, by, holdId, h.id),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guard),
      outbox(env.DB, h, "notice_required", { holdId, audience: "all_registered_devices", event: "hold_canceled", canceledBy: by }, now),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guard),
    ]);
    return true;
  } catch {
    const row = await env.DB.prepare("SELECT 1 AS x FROM cloud_recovery_holds WHERE id=? AND home_id=? AND completed_at IS NULL AND canceled_at IS NULL")
      .bind(holdId, h.id).first();
    if (row) throw new HTTPError(409, "state_conflict");
    return false;
  }
}

async function portalAction(request: Request, env: Env, h: Home) {
  await admin(request, env);
  const input = await body(request, actionSchema);
  const mutationId = `action:${h.id}:${input.idempotencyKey}`;
  const cached = await replay(env.DB, mutationId, input); if (cached) return cached;
  if (input.generation !== h.generation) throw new HTTPError(409, "stale_generation");
  if (["deleting", "deleted"].includes(h.desired_state)) throw new HTTPError(409, "home_inactive");
  const now = Date.now();
  if ((HOLD_ACTIONS as readonly string[]).includes(input.action)) {
    // input.deviceProof is deliberately ignored here: it never skips the hold (it once did; that let a stolen device delete at once).
    const holdId = crypto.randomUUID();
    const result = { fakeOnly: true, state: "recovery_hold", holdId, startedAt: now, completesAt: now + RECOVERY_HOLD_MS };
    await startHold(env, h, input.action as HoldAction, "operator", now, holdId,
      [mutation(env.DB, mutationId, h.id, await sha256(JSON.stringify(input)), result)]);
    return json(result, 202);
  }
  const result = { fakeOnly: true, accepted: true, action: input.action };
  if (input.action === "stop" || input.action === "quarantine") {
    await transition(env, h, "stopped", input.action, now, true, [
      outbox(env.DB, { ...h, generation: h.generation + 1 }, "external_revoke_required", { sessions: true, flux: true, connectedApps: true }, now),
      mutation(env.DB, mutationId, h.id, await sha256(JSON.stringify(input)), result),
    ]);
  } else {
    // start needs a home/B6 consumer; never falsely advance lifecycle.
    await env.DB.batch([
      outbox(env.DB, h, `${input.action}_required`, { deviceAuthorized: false }, now),
      mutation(env.DB, mutationId, h.id, await sha256(JSON.stringify(input)), result),
    ]);
  }
  return json(result, 202);
}

/** Completes a hold whose 72 hours have passed: a CP-signed recovery proof, the action's outbox entry and, for delete, the move to
 *  deleting with credential revocation, all in one batch. Idempotent: a completed hold returns its proof. `extra` joins that batch after
 *  the completion's guard, so it commits only with the completion (the pair_hold_ready notice row, Astra D1 #5). */
export async function completeHold(env: Env, h: Home, hold: Hold, now: number, extra: D1PreparedStatement[] = []): Promise<SignedEnvelope> {
  if (hold.canceled_at !== null || hold.generation !== h.generation) throw new HTTPError(409, "hold_canceled_or_stale");
  if (hold.completes_at > now) throw new HTTPError(409, "hold_pending");
  if (hold.completed_at !== null) return JSON.parse(hold.signed_proof!) as SignedEnvelope;
  const proof = await signPayload(env, { type: "murage-recovery-v1", homeId: h.id, generation: h.generation,
    holdId: hold.id, action: hold.action, holdStartedAt: hold.started_at, holdCompletedAt: now,
    cancelState: "not_canceled", issuedAt: now, expiresAt: now + 5 * 60_000 });
  const guardId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`UPDATE cloud_recovery_holds SET completed_at=?,signed_proof=?
      WHERE id=? AND completed_at IS NULL AND canceled_at IS NULL AND generation=(SELECT generation FROM cloud_homes WHERE id=?)`)
      .bind(now, JSON.stringify(proof), hold.id, h.id),
    env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guardId),
    ...extra,
    outbox(env.DB, h, hold.action === "delete" ? "delete_hold_completed" : `${hold.action}_required`,
      { holdId: hold.id, signedRecoveryProof: proof }, now),
    outbox(env.DB, h, "recovery_wipe_required", { holdId: hold.id, engineSignins: true, pauseChannels: true }, now),
    ...(hold.action === "delete" ? [
      env.DB.prepare("UPDATE cloud_homes SET desired_state='deleting',generation=generation+1,updated_at=? WHERE id=? AND generation=?")
        .bind(now, h.id, h.generation),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(`${guardId}-delete`),
      homeChangeBump(env.DB, h.id, h, now), // after its guard, which reads changes() (Astra AUTOCANARY-11 P2-1)
      ...serviceIntervalStatements(env.DB, h.id, "deleting", now),
      env.DB.prepare("UPDATE cloud_machines SET generation=?,credential_hash=NULL,state='fenced' WHERE id=?").bind(h.generation + 1, h.id),
      env.DB.prepare("UPDATE cloud_enrollment_tokens SET used_at=? WHERE machine_id=? AND used_at IS NULL").bind(now, h.id),
      outbox(env.DB, { ...h, generation: h.generation + 1 }, "external_revoke_required",
        { sessions: true, devices: true, flux: true, connectedApps: true }, now),
      outbox(env.DB, { ...h, generation: h.generation + 1 }, "delete_after_hold", { holdId: hold.id }, now),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(`${guardId}-delete`),
    ] : []),
    env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guardId),
  ]);
  return proof;
}

async function recovery(request: Request, env: Env, h: Home, operation: string) {
  const input = await body(request, z.object({ holdId: id, deviceProof: envelopeSchema.optional() }).strict());
  const hold = await env.DB.prepare("SELECT * FROM cloud_recovery_holds WHERE id=? AND home_id=?")
    .bind(input.holdId, h.id).first<Hold>();
  if (!hold) throw new HTTPError(404, "not_found");
  const now = Date.now();
  if (operation === "cancel") {
    // Any registered device may cancel (a signed proof bound to this hold); the members area cancels through self-service.
    if (!input.deviceProof) throw new HTTPError(403, "device_stepup_required");
    await consumeDeviceProof(env.DB, input.deviceProof, h.id, h.generation, `cancel_hold:${hold.id}`, now);
    if (!await cancelHold(env, h, hold.id, "device", now)) throw new HTTPError(409, "hold_closed");
    return json({ fakeOnly: true, canceled: true });
  }
  await admin(request, env);
  return json({ fakeOnly: true, proof: await completeHold(env, h, hold, now) });
}

/** The machine heartbeat routes (B3 and the fake-b3 alias). Their body is not read by the API's outer body cap (index.ts): it is read
 *  after the machine is authenticated, bounded to the same 16 KiB, by the route itself (Astra AUTOCANARY-11 P1-2). */
export function isHeartbeatRequest(method: string, pathname: string): boolean {
  return method === "POST" && /^\/v1\/(?:fake-b3\/homes|machines)\/[\w-]{1,128}\/heartbeat$/.test(pathname);
}
/** murage-control's capability header (Astra AUTOCANARY-11 P1-3): a daemon that echoes evidence epochs sends it on every heartbeat, so
 *  the ack carries the epoch even to its first heartbeat, which has the oldest shape any control plane accepts (no evidenceEpoch). A
 *  daemon without it gets the old {wire, accepted} ack it requires (strict_fields). */
export const EVIDENCE_HEADER = "x-murage-evidence";
/** murage-control's door header (door v2): "v2" while the home's last successful probe answered door "v2" (b3-control.ts heartbeat). */
export const DOOR_HEADER = "x-murage-door";
/** murage-control's owner-factor header (CLOUD-DOOR-OWNER-FACTOR-DESIGN-r3 §4.1): "1" while the home's last probe answered
 *  ownerFactor 1 (a 1.0.5 app). Absent or any other value clears it, like door_version. Distinct from the local door HMAC
 *  header x-murage-door-proof, which is never sent to the CP. */
export const OWNER_FACTOR_HEADER = "x-murage-owner-factor";
/** DOOR_V2_REQUIRED (MurageCloud (a)): a home is marked ready only after it stamped door_version 'v2', so the first press after ready mints v2. */
const doorReadySql = (env: Env) => (doorV2Required(env) ? " AND h.door_version='v2'" : "");
/** Seconds after which a home whose heartbeat could not be recorded resends it (Astra AUTOCANARY-11 P1-1; murage-control's 5xx retry). */
export const HEARTBEAT_RETRY_AFTER_S = 5;
const heartbeatSchema = z.object({ generation: generationSchema, health: healthSchema.optional() }).strict();

/** 503 with Retry-After: the report (or its refusal) was not recorded; murage-control resends after HEARTBEAT_RETRY_AFTER_S. */
function resendSoon(): Response {
  const response = errorResponse(503, "heartbeat_unrecorded");
  response.headers.set("retry-after", String(HEARTBEAT_RETRY_AFTER_S));
  return response;
}

/** One authenticated heartbeat.
 *
 *  Invalidation is as reliable as acceptance (Astra AUTOCANARY-11 P1-1): a report we refuse to read (400/413/415, another generation)
 *  bumps the evidence epoch BEFORE the refusal is answered, retried (dropHealth: DROP_ATTEMPTS attempts); when even that fails, or the
 *  report itself could not be recorded, the answer is 503 Retry-After HEARTBEAT_RETRY_AFTER_S and murage-control resends in about 5 s. A
 *  resend after a failure holds no epoch (the daemon forgets it on any failed heartbeat), so it is dropped as 'no_epoch', which bumps.
 *
 *  Residual window, stated honestly (the persisted alternative was measured and refused, see below): between a refused or failing report
 *  whose bump could not be written and the next heartbeat that is recorded, an earlier PASS at the current epoch stays eligible. Bounded
 *  by (a) the retries here (< 1 s), then (b) murage-control's resend: 5 s plus up to 2.5 s of jitter, doubling per consecutive failure up
 *  to its normal 60 s interval, while D1 keeps refusing this home's writes, and (c) in every case by AUTO_CANARY_FRESH_MS (5 minutes): the
 *  stored PASS's app report (app_reported_at) is refreshed only by a recorded report and ages out of AUTO_CANARY_BASE (the test "ASTRA
 *  AUTOCANARY-11 P1-1 bound"). A promotion inside that window also
 *  needs D1 to accept the promotion batch while refusing this route's single-row update.
 *  Refused alternative: a first write on every contact that bumps the epoch unconditionally (so a refused report had already invalidated
 *  older evidence). It cannot fail closed either (that first write can fail too, the same window), and it does not settle: every heartbeat
 *  (one a minute) would invalidate the probe recorded at the previous epoch, while a pass probes for up to AUTO_CANARY_STAGE_MS (92 s) and
 *  promotes only after its whole stage, so at fleet scale nearly every promotion would lose its race. */
async function heartbeat(request: Request, env: Env, h: Home): Promise<Response> {
  const refuse = async (reason: string, error: unknown): Promise<Response> => {
    try { await dropHealth(env, h.id, reason, Date.now()); } catch { return resendSoon(); }
    throw error;
  };
  let input: z.infer<typeof heartbeatSchema>;
  try {
    input = await body(request, heartbeatSchema);
  } catch (error) {
    // Bounded (readBoundedJSON: Content-Length, then a running count; trailing whitespace counts like any byte), never buffered past it.
    return refuse(error instanceof HTTPError && error.status === 413 ? "oversized" : "rejected", error);
  }
  if (input.generation !== h.generation) return refuse("stale_generation", new HTTPError(409, "stale_generation"));
  const now = Date.now();
  let epoch: number | null;
  try {
    // One transactional batch: the counter statement only counts when the generation-guarded home update changed exactly one row.
    const [home] = await env.DB.batch([
      // Door v2 (CLOUD-DOOR-V2-DESIGN.md 4B): the home's door, from the request header only (the body is strict on every CP in the field);
      // a heartbeat without it clears it. No ack change.
      env.DB.prepare("UPDATE cloud_homes SET heartbeat_at=?, door_version=?, door_proof=? WHERE id=? AND generation=?")
        .bind(now, request.headers.get(DOOR_HEADER) === "v2" ? "v2" : null, request.headers.get(OWNER_FACTOR_HEADER) === "1" ? 1 : 0, h.id, h.generation),
      notePowerHeartbeat(env.DB, h.id, now), // power reservations count consecutive beats as they arrive (settlePower consumes them)
    ]);
    if (home!.meta.changes !== 1) return refuse("stale_generation", new HTTPError(409, "stale_generation")); // rotated after authentication
    // Generation-guarded (Astra AUTOCANARY-1 P2 #1); the epoch after this report (Astra AUTOCANARY-10), null when the generation moved.
    epoch = await recordHealth(env, h.id, input.health, now, undefined, h.generation);
  } catch (error) {
    if (error instanceof HTTPError) throw error;
    // The report was not recorded (D1 refused): invalidate what is stored if we can, and have the home resend soon either way.
    try { await dropHealth(env, h.id, "unrecorded", Date.now()); } catch { /* the resend bumps */ }
    return resendSoon();
  }
  if (epoch === null && input.health) throw new HTTPError(409, "stale_generation");
  // The ack carries the epoch to a murage-control that echoes it (the capability header, or health.evidenceEpoch present: the round-12
  // daemon); an older one, or a report with a legacy field, keeps its old ack and is never promoted automatically.
  const echoes = request.headers.get(EVIDENCE_HEADER) === "epoch"
    || (input.health?.evidenceEpoch !== undefined && input.health.bootSeq === undefined);
  return json({ wire: WIRE, accepted: true, ...(echoes && typeof epoch === "number" ? { generation: h.generation, evidenceEpoch: epoch } : {}) });
}

export async function b3Route(request: Request, env: Env, dependencies: B3Dependencies = {}): Promise<Response | null> {
  if (!b3Enabled(env)) return null;
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/v1/fake-b3/") && !/^\/v1\/machines\/[\w-]+\/(desired|heartbeat|lease|resume)$/.test(path)) return null;
  const config = b3Config(env);
  if (request.method === "POST" && path === "/v1/fake-b3/reserve") return reserve(request, env, config);
  if (request.method === "POST" && path === "/v1/fake-b3/payments") {
    if (env.CLOUD_B3_MODE === "live") throw new HTTPError(404, "not_found"); // only Stripe may mark a live home paid
    return payment(request, env);
  }
  if (request.method === "POST" && path === "/v1/fake-b3/reconcile") {
    await admin(request, env); await reconcileB3(env, dependencies); return json({ fakeOnly: true, reconciled: true });
  }
  const match = /^\/v1\/(?:fake-b3\/homes|machines)\/([\w-]{1,128})\/(action|desired|heartbeat|lease|canary|notice|resume|recovery\/cancel|recovery\/complete|lease\/ack)$/.exec(path);
  if (!match) return null;
  const h = await routeHome(env, request, match[1]);
  const operation = match[2];
  if (operation === "desired" && request.method === "GET") return desired(request, env, h, config);
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  if (operation === "lease") return lease(request, env, h);
  if (operation === "action") return portalAction(request, env, h);
  if (operation.startsWith("recovery/")) return recovery(request, env, h, operation.split("/")[1]);
  if (operation === "heartbeat") {
    // The machine is authenticated from its headers before any byte of the body is read (Astra AUTOCANARY-11 P1-2): the outer API body
    // cap is not applied to this route (index.ts isHeartbeatRequest); heartbeat() reads the body itself, bounded, and an oversized one
    // from an authenticated machine is a refused report like any other.
    await machine(request, env, h);
    return heartbeat(request, env, h);
  }
  if (operation === "lease/ack") {
    return acknowledgeLease(request, env, h);
  }
  await admin(request, env);
  if (operation === "resume") return resumeHome(env, h, Date.now());
  if (operation === "notice") {
    const input = await body(request, z.object({ noticeId: key, generation: generationSchema }).strict());
    const mutationId = `notice:${h.id}:${input.noticeId}`;
    const cached = await replay(env.DB, mutationId, input); if (cached) return cached;
    if (input.generation !== h.generation || h.desired_state !== "suspended") throw new HTTPError(409, "state_conflict");
    const result = { fakeOnly: true, recorded: true };
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_homes SET suspension_notices=suspension_notices+1 WHERE id=? AND generation=?").bind(h.id, h.generation),
      outbox(env.DB, h, "synthetic_notice_receipt", { noticeId: input.noticeId }, Date.now()),
      mutation(env.DB, mutationId, h.id, await sha256(JSON.stringify(input)), result),
    ]);
    return json(result);
  }
  if (operation === "canary") {
    const input = await body(request, canarySchema);
    const mutationId = `canary:${h.id}:${input.generation}:${input.imageDigest}`;
    const cached = await replay(env.DB, mutationId, input); if (cached) return cached;
    if (input.generation !== h.generation || h.desired_state !== "checking") throw new HTTPError(409, "state_conflict");
    const passed = input.imageDigest === h.image_digest && Object.values(input.checks).every(Boolean);
    // MurageCloud (a): with DOOR_V2_REQUIRED on, a home that has not advertised door v2 is never marked ready (its pass is refused).
    if (passed && doorV2Required(env)) {
      const door = await env.DB.prepare("SELECT door_version FROM cloud_homes WHERE id=? AND generation=?").bind(h.id, h.generation).first<{ door_version: string | null }>();
      if (door?.door_version !== "v2") throw new HTTPError(409, "door_not_advertised");
    }
    await dependencies.afterDoorCheck?.();
    const response = { fakeOnly: true, state: passed ? "ready" : "failed" };
    // Astra D1 #4: the door is checked again INSIDE the promotion batch (as autoCanary does), so a heartbeat that clears door_version after
    // the read above can never leave a ready home that mints only door_needs_update.
    const doorGuard = passed && doorV2Required(env) ? crypto.randomUUID() : null;
    try {
      await canaryOutcome(env, h, passed, input, Date.now(), [
        ...(doorGuard ? [
          env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,(SELECT COUNT(*) FROM cloud_homes WHERE id=? AND generation=? AND door_version='v2'))")
            .bind(doorGuard, h.id, h.generation),
          env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(doorGuard),
        ] : []),
        mutation(env.DB, mutationId, h.id, await sha256(JSON.stringify(input)), response),
      ]);
    } catch (error) {
      if (doorGuard) {
        const door = await env.DB.prepare("SELECT door_version FROM cloud_homes WHERE id=? AND generation=?").bind(h.id, h.generation).first<{ door_version: string | null }>();
        if (door?.door_version !== "v2") throw new HTTPError(409, "door_not_advertised");
      }
      throw error;
    }
    return json(response);
  }
  return null;
}
