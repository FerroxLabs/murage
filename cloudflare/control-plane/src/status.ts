// SPDX-License-Identifier: AGPL-3.0-or-later
// Two small read-only endpoints for the desktop app (Electron main):
//   GET /v1/status                    -> 200 {"live": boolean}   no auth; EXACTLY one key (the desktop's cloud-live.mjs rejects any extra key)
//       live = the Cloud service is operating for existing customers: all configuration in place, including what /door needs to sign a ticket.
//       It is independent of CLOUD_SALES_OPEN (a sales-only switch): closing sales must not disable Cloud for customers who already have a home.
//   GET /v1/account/step-up/state     -> 200 {"fresh": boolean, "freshUntil"?: number}   Supabase customer; read-only
// Neither writes, consumes, extends or mints anything. /door stays the only enforcer of the step-up.
import { b3Config, b3Enabled } from "./b3-config";
import { billingConfig } from "./b5-config";
import { readConfig, cloudHomeCloudflare } from "./config";
import { carryBinding, STEP_UP_STATE_PATH, type Identity } from "./customer-identity";
import { doorFreshUntil, doorWindowMs } from "./door";
import { HTTPError, json } from "./http";
import { keyWrapperFor } from "./key-wrapper";
import { kmsRegionError } from "../scripts/kms-region.mjs";
import { readSupabaseAuthConfig } from "./supabase-jwt";

/** The environment a Cloud service needs to operate for existing customers: the control plane's own configuration (readConfig), the Supabase
 *  sign-in configuration, the home engine on and its configuration (b3Config), the managed-home endpoint configuration (cloudHomeCloudflare),
 *  billing configured and allowed (billingConfig: keys, prices, live gate), the home-key wrapper (keyWrapperFor, built exactly as pairing and
 *  provisioning build it: KMS region/credentials/key ARN or the legacy KEK; local checks only, no network call), and the B3 signing key
 *  /door signs its ticket with (checked as the signer does, b3-signatures.ts signPayload, and actually importable: with it unusable every door
 *  request is 503 door_unavailable). Any error is false.
 *  Scope (design decision): `live` is the desktop's coarse on/off for ALL existing-customer Cloud access, so it covers only what the door, the
 *  desktop and pairing need to work at all. Partial degradations are deliberately NOT folded in, because one failing email or refund feature must
 *  never cut every customer off: the refund-identity key (7-day first-month refund check; refund_key.checkout_blocked alert), NOTICE_MAIL_KEY and
 *  CANCELLATION_MAIL_KEY (notice/cancellation mail) are watched by their own alerts and enforced as required production secrets by
 *  scripts/check-deploy.mjs PRODUCTION_REQUIRED_SECRETS (the production deploy checklist).
 *  Checkout-only prerequisites are NOT here: the refund-identity key (checkoutRefundKeyError) and the disclosure-token secret (disclosureKeyError)
 *  gate NEW sales only (createCheckout); withdrawals, refunds, the portal and the door run without them (b5-config.ts billingConfig).
 *  Deliberately independent of CLOUD_SALES_OPEN: salesShut() is a SALES-ONLY switch (its only consumers are assertSalesOpen on
 *  reserve/checkout/resume in index.ts and the checkout handlers; it never gates door, status, pairing, refunds or billing for existing homes). */
export async function cloudOperating(env: Env): Promise<boolean> {
  try {
    const config = readConfig(env);
    if (!readSupabaseAuthConfig(env)) return false;
    if (!b3Enabled(env)) return false;
    b3Config(env);
    cloudHomeCloudflare(config);
    if (!billingConfig(env)) return false;
    keyWrapperFor(env);
    // kmsFromEnv only checks presence; the endpoint is built from the region, so a blank/odd region or one that is not the ARN's would 500 every unwrap.
    if (env.AWS_KMS_KEY_ARN && kmsRegionError(env.AWS_KMS_REGION, env.AWS_KMS_KEY_ARN) !== null) return false;
    const jwk = JSON.parse(env.CLOUD_B3_SIGNING_JWK ?? "null") as JsonWebKey | null;
    if (!jwk?.d || jwk.kty !== "EC" || jwk.crv !== "P-256") return false;
    await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    return true;
  } catch { return false; }
}

export const STATUS_PATH = "/v1/status";
export { STEP_UP_STATE_PATH };

/** GET /v1/status. Answered by the worker's handle() before configuration is read, so a broken configuration is {live:false}, never a 5xx. */
export const isStatusRequest = (request: Request): boolean => request.method === "GET" && new URL(request.url).pathname === STATUS_PATH;
export const statusResponse = async (env: Env): Promise<Response> => json({ live: await cloudOperating(env) });

/** The freshness /door applies, asked with no step-up intent on this GET, through the one evaluator /door itself runs (door.ts doorFreshUntil:
 *  the emailed sign-in, a CP-granted code and a trusted authenticator, each with its own end, min(CLOUD_STEPUP_MAX_AGE_SECONDS, 900 s) for the
 *  authenticator) and the window of the member's home (v2 900 s, v1 300 s; several homes: the most restrictive; none: not fresh).
 *  freshUntil is the last millisecond /door still accepts. The clock is read again after every read, and fresh is answered only while
 *  it has not passed. Writes nothing: the identity for this route is resolved read-only (customer-identity.ts), an unknown or unreconcilable
 *  subject is {fresh:false}. */
export async function stepUpStateRoute(request: Request, env: Env, identity: Identity): Promise<Response | null> {
  if (new URL(request.url).pathname !== STEP_UP_STATE_PATH) return null;
  if (request.method !== "GET") throw new HTTPError(405, "method_not_allowed");
  const session = await identity.customer(request);
  if (!session) throw new HTTPError(401, "unauthorized");
  if (session.unresolved) return json({ fresh: false });
  try {
    const homes = (await env.DB.prepare("SELECT door_version FROM cloud_homes WHERE owner_id=? AND desired_state<>'deleted'").bind(session.user.id)
      .all<{ door_version: string | null }>()).results;
    if (homes.length === 0) return json({ fresh: false });
    const windowMs = doorWindowMs(homes.every((h) => h.door_version === "v2"));
    // Ask exactly as the door's request would be asked: the door's path (its window for the trusted factor, stepUpMaxAgeFor), the same
    // bound member and token, no intent. Nothing here is POSTed, claimed or stored.
    const asDoor = new Request(new URL("/v1/homes/status-probe/door", request.url), { method: "POST", headers: { authorization: request.headers.get("authorization") ?? "" } });
    carryBinding(request, asDoor);
    const freshUntil = await doorFreshUntil(asDoor, env, identity, session, identity.now(), windowMs);
    if (!Number.isSafeInteger(freshUntil)) return json({ fresh: false });
    // The reads above took time: the answer is fresh only if the proof still counts right now.
    if (identity.now() > freshUntil) return json({ fresh: false });
    return json({ fresh: true, freshUntil });
  } catch { return json({ fresh: false }); }
}
