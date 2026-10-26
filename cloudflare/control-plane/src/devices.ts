// SPDX-License-Identifier: AGPL-3.0-or-later
// Device management on My Cloud (CLOUD-DOOR-V2-DESIGN.md 3.2, Decision 9). Two Cloud-scope routes (customer-identity.ts isCloudScopePath),
// each ONE bootstrap-HMAC call to the home (pairing.ts homeManagementCall: operation = the exact home path, a fresh nonce the home stores):
//   GET  /v1/homes/:id/devices                     -> 200 {devices: [{id, scope, addedAt, lastSeenAt|null}]} (times in ms, no key material)
//   POST /v1/homes/:id/devices/:deviceId/revoke {} -> 200 {revoked: true} (also when it was already revoked); 404 device_not_found
// The revoke is in STEP_UP_PATTERNS: the ordinary emailed code or a fresh trusted factor; the door's 15-minute reuse never satisfies it.
// Refusals: 401 unauthorized; 403 step_up_required; 404 not_found (not the owner and no such home answer alike); 409 door_needs_update (a
// home that has not advertised door v2 has no device routes); 429 rate_limited (30 lists and 10 revokes a minute per account); 503
// home_unreachable. Logs: `home devices listed {homeId, count, outcome}`, one `home device revoked {homeId, deviceId, outcome, requestId}`
// per revoke.
import { z } from "zod";
import { boundCustomer, DEVICE_REVOKE_ROUTE, DEVICES_ROUTE, stepUpProof, stepUpProofValid, type Identity } from "./customer-identity";
import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";
import { homeManagementCall, type PairingDependencies } from "./pairing";
import { takeLimit } from "./self-service";

export const HOME_DEVICES_LIST = "/api/cloud/devices/list";
export const HOME_DEVICES_REVOKE = "/api/cloud/devices/revoke";

const SCOPES = ["browser", "owner-desktop", "owner-phone"] as const;
const homeDevice = z.object({ id: z.string().min(1).max(128), scope: z.enum(SCOPES), addedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().nullable().optional(),
  factor: z.enum(["passkey", "remembered-owner"]).nullable().optional(),
  factorExpiresAt: z.number().int().nonnegative().nullable().optional() }).passthrough();
// fullScopeEver: true once any full-scope device ever enrolled at the home (revoked ones included). consumedHoldIds: the pair holds the home
// spent through consumePairHold, most recent first, capped at 50 (MurageMain contract, 10-15). Both optional: an older image omits them, and
// then the history (or the consumption) is UNKNOWN, never "none".
const homeList = z.object({ devices: z.array(homeDevice).max(1000), fullScopeEver: z.boolean().optional(),
  consumedHoldIds: z.array(z.string().min(1).max(128)).max(1000).optional() }).passthrough();
export type HomeDevices = { devices: { id: string; scope: typeof SCOPES[number]; addedAt: number; lastSeenAt: number | null; factor: "passkey" | "remembered-owner" | null; factorExpiresAt: number | null }[]; fullScopeEver: boolean | null;
  consumedHoldIds: string[] | null };
/** The most consumed hold ids the home reports (and the CP reconciles) per answer. */
export const CONSUMED_HOLD_IDS_MAX = 50;
/** spent_device_digest of a hold the HOME reports it consumed (never a device digest: those are 64 hex), so no selection matches it again. */
export const HOME_CONSUMED_DIGEST = "home-consumed";

interface OwnedHome { owner_id: string; generation: number; door_version: string | null }
const ownedHome = (env: Env, homeId: string) => env.DB.prepare(
  "SELECT owner_id, generation, door_version FROM cloud_homes WHERE id=? AND desired_state NOT IN ('deleting','deleted')").bind(homeId).first<OwnedHome>();

function rateLimited(retryAfterSeconds: number): Response {
  const retryAfter = Math.max(1, retryAfterSeconds);
  const res = errorResponse(429, "rate_limited", { retryAfter, retry_after_seconds: retryAfter });
  res.headers.set("retry-after", String(retryAfter));
  return res;
}

/** Astra D1 #3: the holds the home (authenticated: the answer to our bootstrap-HMAC call) reports it consumed are marked spent in CP state,
 *  so none is listed ready or reserved again. Only this home's pair holds; an id the CP does not know changes nothing. The home's exchange
 *  stays the final check, so a failed write here is logged and the answer still stands. */
export async function reconcileConsumedHolds(env: Env, homeId: string, ids: string[], now: number): Promise<number> {
  if (!ids.length) return 0;
  try {
    const r = await env.DB.prepare(`UPDATE cloud_recovery_holds SET spent_device_digest=COALESCE(spent_device_digest,?), spent_at=COALESCE(spent_at,?),
        reserved_by=NULL, reserved_until=NULL
      WHERE home_id=? AND action='pair' AND id IN (SELECT value FROM json_each(?)) AND (spent_device_digest IS NULL OR reserved_until IS NOT NULL)`)
      .bind(HOME_CONSUMED_DIGEST, now, homeId, JSON.stringify(ids)).run();
    if (r.meta.changes) console.log(JSON.stringify({ message: "pair holds consumed at home", homeId, count: r.meta.changes }));
    return r.meta.changes;
  } catch {
    console.error(JSON.stringify({ message: "pair hold reconcile failed", homeId }));
    return 0;
  }
}

/** The home's device list (unrevoked), as the CP shows it: never a key or key hash. 503 home_unreachable when the home cannot answer. The
 *  holds it reports consumed are reconciled into CP state first (reconcileConsumedHolds). */
export async function listHomeDevices(env: Env, homeId: string, account: { id: string; email: string }, dependencies: PairingDependencies): Promise<HomeDevices> {
  const res = await homeManagementCall(env, homeId, account, HOME_DEVICES_LIST, {}, dependencies);
  if (res.status !== 200) throw new HTTPError(503, "home_unreachable");
  const parsed = homeList.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new HTTPError(503, "home_unreachable");
  const consumedHoldIds = parsed.data.consumedHoldIds ? parsed.data.consumedHoldIds.slice(0, CONSUMED_HOLD_IDS_MAX) : null;
  if (consumedHoldIds) await reconcileConsumedHolds(env, homeId, consumedHoldIds, Date.now());
  return { devices: parsed.data.devices.map((d) => ({ id: d.id, scope: d.scope, addedAt: d.addedAt, lastSeenAt: d.lastSeenAt ?? null,
      factor: d.factor ?? null, factorExpiresAt: d.factorExpiresAt ?? null })),
    fullScopeEver: parsed.data.fullScopeEver ?? null, consumedHoldIds };
}

export async function devicesRoute(request: Request, env: Env, identity: Identity, requestId: string,
  dependencies: PairingDependencies = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const list = DEVICES_ROUTE.exec(path);
  const revoke = list ? null : DEVICE_REVOKE_ROUTE.exec(path);
  if (!list && !revoke) return null;
  if (request.method !== (list ? "GET" : "POST")) throw new HTTPError(405, "method_not_allowed");
  if (!boundCustomer(request)) throw new HTTPError(404, "not_found");
  const session = await identity.customer(request);
  if (!session) throw new HTTPError(401, "unauthorized");
  const homeId = (list ?? revoke)![1];
  const now = identity.now();
  let factorOnly = false;
  if (revoke) {
    // "Make chat-only" sends {factorOnly:true}; a full sign-out sends {} (CLOUD-DOOR-OWNER-FACTOR-DESIGN-r3 §7.1).
    const revokeBody = z.strictObject({ factorOnly: z.boolean().optional() }).safeParse(await readBoundedJSON(request));
    if (!revokeBody.success) throw new HTTPError(400, "invalid_request");
    factorOnly = revokeBody.data.factorOnly === true;
    // The worker's gate asked the step-up first (STEP_UP_PATTERNS); asked again here. The door's reuse is not a proof here.
    if (!(stepUpProof(request) && await stepUpProofValid(request)) && await identity.stepUpNeeded(request, env)) throw new HTTPError(403, "step_up_required");
  }
  // The account budget counts every call, whatever the home: it reveals nothing about any home.
  const limit = await takeLimit(env, session.user.id, list ? "devices_list" : "devices_revoke", now);
  if (!limit.ok) return rateLimited(limit.retryAfterSeconds);
  const home = await ownedHome(env, homeId);
  if (!home || home.owner_id !== session.user.id) throw new HTTPError(404, "not_found");
  if (home.door_version !== "v2") throw new HTTPError(409, "door_needs_update");
  const account = { id: session.user.id, email: session.user.email };
  if (list) {
    try {
      const answer = await listHomeDevices(env, homeId, account, dependencies);
      console.log(JSON.stringify({ message: "home devices listed", homeId, count: answer.devices.length, outcome: "ok" }));
      const res = json({ devices: answer.devices });
      res.headers.set("cache-control", "no-store");
      return res;
    } catch (e) {
      console.log(JSON.stringify({ message: "home devices listed", homeId, count: 0, outcome: e instanceof HTTPError ? e.code : "error" }));
      throw e;
    }
  }
  const deviceId = revoke![2];
  const log = (outcome: string) => console.log(JSON.stringify({ message: "home device revoked", homeId, deviceId, outcome, requestId }));
  let res: Response;
  try { res = await homeManagementCall(env, homeId, account, HOME_DEVICES_REVOKE, { deviceId, ...(factorOnly ? { factorOnly: true } : {}) }, dependencies); }
  catch (e) { log(e instanceof HTTPError ? e.code : "error"); throw e; }
  if (res.status === 404) { log("device_not_found"); throw new HTTPError(404, "device_not_found"); }
  if (res.status !== 200) { log("home_unreachable"); throw new HTTPError(503, "home_unreachable"); }
  log("revoked");
  return json({ revoked: true });
}
