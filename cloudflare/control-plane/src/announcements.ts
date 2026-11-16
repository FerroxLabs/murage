// The onboarding announcement signup, and the only place a Sendlane
// credential exists.
//
// WHY IT MOVED HERE. This ran in the desktop app until now, from
// `server/sendlane.ts`, reading `SENDLANE_API_KEY` and `SENDLANE_HASH_KEY`.
// `electron-builder.yml` packs the app with `asar: true`, and an ASAR is an
// archive, not encryption — so both keys were readable by everyone who
// installed Murage, and both are write credentials for the WHOLE Sendlane
// account. They are Worker secrets now. A desktop build carries an address,
// a name and a URL, and nothing else.
//
// Legacy v1 API. Base is api.sendlane.com (www.sendlane.com redirects and
// breaks). Auth is form-encoded `api` + `hash` in the POST body, not a header.
// `list-subscriber-add` updates rather than duplicating, so a retry or a
// repeat signup is safe and never clears fields we did not send.
import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { errorResponse, HTTPError, json, readBoundedJSON } from "./http";
import { raiseAlert } from "./ops-monitor";
import { bindNumbered, updatesSignupsOpen } from "./updates-consent/gate";
import { APP_UNMATCHED_VERSION, rejectSignup, runSignup } from "./updates-consent/routes";
import * as UB from "./updates-consent/sql-b1";
import * as UQ from "./updates-consent/sql-design";

declare global {
  interface Env {
    /** The site forwarder's shared secret (Worker secret, optional: unset means the forwarder path is off). */
    SITE_FORWARDER_TOKEN?: string;
    /** Plaintext var: the Sendlane list for the Team/Business waitlist. Unset means waitlist signups are recorded, never sent. */
    SENDLANE_WAITLIST_LIST_ID?: string;
  }
  namespace Cloudflare {
    interface Env {
      SITE_FORWARDER_TOKEN?: string;
      SENDLANE_WAITLIST_LIST_ID?: string;
    }
  }
}

/**
 * Murage's own list.
 *
 * A LIST ID IS CONFIGURATION, NOT A SECRET, and that is the whole reason it
 * gets a default while `SENDLANE_API_KEY` and `SENDLANE_HASH_KEY` never will.
 * Those two are write credentials for the entire Sendlane account; this is a
 * number that says which of that account's lists the onboarding signup lands
 * on. Owner's ruling, 2026-09-21: "List ID 37 is Murage's list."
 *
 * `SENDLANE_LIST_ID` is a plaintext `var` in wrangler.jsonc for the same
 * reason: an operator pointing a fork at their own list is editing
 * configuration, not handling a secret. This constant is the fallback for a
 * fork that deletes the var, so the endpoint cannot end up posting to list
 * "" — credentials present, list absent, every address on the floor.
 */
export const DEFAULT_LIST_ID = "37";

/** Names only, never values. Nothing in this module may log a secret. */
export const SENDLANE_SECRET_NAMES = ["SENDLANE_API_KEY", "SENDLANE_HASH_KEY"] as const;

/** The site forwarder (MurageSite on Vercel posts its own and the desktop's signups server to server). Optional: a Worker without it has
 *  no forwarder path at all, and deploy does not require it. Names only, never values. */
export const SITE_FORWARDER_SECRET_NAME = "SITE_FORWARDER_TOKEN";
export const SITE_FORWARDER_HEADER = "X-Murage-Site-Token";
/** Every forwarded signup in one hour, all callers together. Vercel's egress IPs are shared, so the per-IP limits do not apply to the
 *  forwarder; this cap bounds what a leaked token can put on the list. Hitting it raises one alert per hour. */
export const FORWARDER_HOURLY_CAP = 500;
const FORWARDER_WINDOW_MS = 60 * 60 * 1_000;
export const FORWARDER_CAP_ALERT = "sendlane.forwarder_cap";
/** Every unsubscribe in one hour, all callers together, under its own key: a leaked token cannot mass-unsubscribe the lists. */
export const UNSUBSCRIBE_HOURLY_CAP = 500;
export const UNSUBSCRIBE_CAP_ALERT = "sendlane.unsubscribe_cap";
/** Consent records are kept 3 years: long enough to answer a "when did I agree, and to what" question for any live subscriber. */
export const CONSENT_RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1_000;
export const FORWARDER_SOURCES = ["site", "footer", "download", "app", "waitlist", "guide"] as const;
export type ForwarderSource = (typeof FORWARDER_SOURCES)[number];

const SENDLANE_BASE = "https://api.sendlane.com/api/v1";
const SENDLANE_TIMEOUT_MS = 5_000;
const SENDLANE_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 64 * 1_024;

/** One address, three tries in a quarter of an hour. A person signs up once;
 *  anything past that is a script or a mistake. Same shape and the same
 *  numbers as the OTP recipient limit in `otp-rate-limit.ts`. */
const EMAIL_WINDOW_MS = 15 * 60 * 1_000;
const EMAIL_MAX_ATTEMPTS = 3;
/** A per-address limit alone stops nothing: a spammer simply uses a different
 *  address every time. The caller is bounded too. */
const CALLER_WINDOW_MS = 60 * 60 * 1_000;
const CALLER_MAX_ATTEMPTS = 10;
const RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Shape first, address second, so an unknown field and a typo in an address
 *  are not the same answer to the person who sent it. */
const subscribeSchema = z.strictObject({
  email: z.string().max(254),
  name: z.string().max(80).optional(),
});
/** The forwarded body: today's two fields plus where the signup came from and the words the person agreed to. Only with a valid token. */
const forwardedSchema = z.strictObject({
  email: z.string().max(254),
  name: z.string().max(80).optional(),
  source: z.enum(FORWARDER_SOURCES).optional(),
  // Kept verbatim, never trimmed: source app matches a text row byte for byte and stores the words as received (B1 r1 Astra M). Blank
  // (only whitespace) is still refused.
  consentText: z.string().max(500).refine((t) => t.trim().length > 0).optional(),
  // Updates consent v5.6.1 (B1): one id per site submission, sent on every retry (RQ), and the guide flag (G mints guide_prove).
  requestId: z.string().min(16).max(120),
  withGuide: z.boolean().optional(),
});
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const listIdSchema = z.string().regex(/^[0-9]{1,20}$/);

/**
 * Whether this Worker may WRITE to Sendlane. G3: staging used to post real
 * signups to the live list 37, so staging now defaults to OFF.
 *
 * - `SENDLANE_WRITES` = "off" | "on" is an explicit switch and always wins.
 * - Unset: staging (CLOUD_CP0_STAGING=1, "never set in production") is off;
 *   everything else, including production, is on.
 * Production's wrangler config does not set the flag, so its behaviour is
 * unchanged.
 */
export function sendlaneWritesEnabled(env: Env): boolean {
  const e = env as { SENDLANE_WRITES?: string; CLOUD_CP0_STAGING?: string; MURAGE_ENV?: string };
  // MURAGE_ENV=staging is authoritative: staging never writes to Sendlane, whatever the other switches say.
  if (e.MURAGE_ENV === "staging") return false;
  const flag = String(e.SENDLANE_WRITES ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return false;
  if (flag === "on" || flag === "1" || flag === "true") return true;
  return e.CLOUD_CP0_STAGING !== "1";
}

export type SendlaneFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface SendlaneCredentials {
  apiKey: string;
  hashKey: string;
  listId: string;
}

/** The two keys are required and have no default, so a Worker nobody has run
 *  `wrangler secret put` against cannot look configured. A malformed list id
 *  counts as unconfigured for the same reason: posting to a list this Worker
 *  cannot name is worse than refusing. */
export function sendlaneCredentials(env: Env): SendlaneCredentials | null {
  const apiKey = String(env.SENDLANE_API_KEY ?? "").trim();
  const hashKey = String(env.SENDLANE_HASH_KEY ?? "").trim();
  const listId = String(env.SENDLANE_LIST_ID ?? "").trim() || DEFAULT_LIST_ID;
  if (!apiKey || !hashKey || !listIdSchema.safeParse(listId).success) return null;
  return { apiKey, hashKey, listId };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC, never the address or the IP itself. This table is a spam ledger, and
 *  it has to stay useless to anyone who reads it — the same rule, and the same
 *  key material, as the OTP recipient limiter. */
export async function subjectKey(scope: string, value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}:${value}`)));
}

export async function withinLimit(
  env: Env,
  key: string,
  windowMs: number,
  maxAttempts: number,
  now: number,
): Promise<boolean> {
  const cutoff = now - windowMs;
  const result = await env.DB.prepare(
    `INSERT INTO announcement_rate_limits
      (subject_key, window_started_at, attempts, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(subject_key) DO UPDATE SET
       window_started_at = CASE
         WHEN window_started_at <= ? THEN excluded.window_started_at
         ELSE window_started_at
       END,
       attempts = CASE
         WHEN window_started_at <= ? THEN 1
         ELSE attempts + 1
       END,
       updated_at = excluded.updated_at
     WHERE window_started_at <= ? OR attempts < ?`,
  ).bind(key, now, now, cutoff, cutoff, cutoff, maxAttempts).run();
  return result.meta.changes !== 0;
}

interface SendlaneResult {
  ok: boolean;
  status?: number;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * The site forwarder's token check.
 * - "none": no forwarder path. The secret is unset or blank, or the request carries no (or an empty) header. Today's behaviour, exactly.
 * - "valid": the header matches the secret.
 * - "wrong": the secret is set and the header is present but does not match (the route answers 401).
 * Both sides are hashed to 32 bytes first, so the compare is constant time and does not leak the length.
 */
export async function siteForwarderAuth(request: Request, env: Env): Promise<"none" | "valid" | "wrong"> {
  const secret = String(env.SITE_FORWARDER_TOKEN ?? "").trim();
  const presented = (request.headers.get(SITE_FORWARDER_HEADER) ?? "").trim();
  if (!secret || !presented) return "none";
  const [expected, actual] = await Promise.all([sha256(secret), sha256(presented)]);
  return timingSafeEqual(expected, actual) ? "valid" : "wrong";
}

/** The waitlist's own list, or null (recorded, never sent). By the privacy policy a waitlist address is used only for the Team/Business
 *  opening, so it never lands on the main list: a value equal to the main list, or to the default list, counts as unset. */
function waitlistListId(env: Env, mainListId: string): string | null {
  const id = String(env.SENDLANE_WAITLIST_LIST_ID ?? "").trim();
  if (!id || !listIdSchema.safeParse(id).success || id === mainListId || id === DEFAULT_LIST_ID) return null;
  return id;
}

/** The hour a forwarder cap alert belongs to (UTC, e.g. 2026-11-04T13): one open alert per hour through the open-alert index. */
function hourBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

interface OptOutRow { rowId: string; compPending: boolean; compNonce: string | null }

const unsubscribeSchema = z.strictObject({ email: z.string().max(254) });
export const UNSUBSCRIBE_PATH = "/v1/announcements/unsubscribe";
/** The one documented success body: {"success":"Unsubscribed Successfully."} (Sendlane v1 "Unsubscribe", see unsubscribeFromList). */
/** The lists an unsubscribe covers: the main list and, when one is configured, the waitlist. */
function unsubscribeLists(env: Env, mainListId: string): string[] {
  const waitlist = waitlistListId(env, mainListId);
  return waitlist ? [mainListId, waitlist] : [mainListId];
}

// ---- Updates consent v5.6.1 (B1): the three routes below act on D1 only. No Sendlane call, no writeGate, no 502, no refund (3.5, 4.2). ----

/** The hour cap alert, kept from the Sendlane path: raised when the forwarder's global hourly cap row is exhausted. */
async function forwarderCapAlert(env: Env, capKey: string, now: number, requestId: string): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT attempts, window_started_at FROM announcement_rate_limits WHERE subject_key = ?")
      .bind(capKey).first<{ attempts: number; window_started_at: number }>();
    if (!row || row.attempts < FORWARDER_HOURLY_CAP || row.window_started_at <= now - FORWARDER_WINDOW_MS) return;
    console.error(JSON.stringify({ message: "announcement forwarder over its hourly cap", requestId, errorCode: "forwarder_cap", cap: FORWARDER_HOURLY_CAP }));
    await raiseAlert(env, {
      homeId: `platform:sendlane-forwarder:${hourBucket(now)}`,
      kind: FORWARDER_CAP_ALERT,
      severity: "high",
      detail: `site forwarder reached ${FORWARDER_HOURLY_CAP} signups this hour; later signups answer 429 until the hour turns. Check the site, or rotate ${SITE_FORWARDER_SECRET_NAME} if it leaked.`,
    }, now);
  } catch { /* an alert never changes the answer */ }
}

/** Source `app` with words that match no app row (v5.6.2). The route is public through the site, so anyone can post any words: one
 *  digest alert per UTC hour (the open-alert index keeps one row per hour, never a page), and the words are never in it. */
async function appUnmatchedAlert(env: Env, now: number, requestId: string): Promise<void> {
  try {
    console.log(JSON.stringify({ message: "updates app consent words matched no card", requestId, errorCode: "updates_app_unmatched" }));
    await raiseAlert(env, {
      homeId: `platform:updates-app-unmatched:${hourBucket(now)}`,
      kind: APP_UNMATCHED_ALERT,
      severity: "low",
      detail: "an app signup this hour sent consent words that match no known card; it is recorded as app-unmatched. The words are on the consent row only.",
    }, now);
  } catch { /* an alert never changes the answer */ }
}
export const APP_UNMATCHED_ALERT = "updates.app_unmatched";

/** RQQ's outcome as the forwarder's answer (4.2): refused, capped and noop are byte-equal, so nothing about the address is revealed. */
function forwardedAnswer(outcome: string | null, withGuide: boolean): Response {
  if (outcome === "rate_limited") throw new HTTPError(429, "rate_limited");
  if (outcome === "invalid") throw new HTTPError(400, "invalid");
  if (!withGuide) return json({ ok: true });
  return json({ ok: true, guide: outcome === "admitted" ? "queued" : "none" });
}

const hex256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/**
 * `POST /v1/announcements/subscribe`, unauthenticated (the 1.0.19 first run) or with `X-Murage-Site-Token` (the site forwarder).
 * Both run the one request batch of design v5.6.1 3.3 (RQ, FL1 to FL3, FS0 to FS4, G ... RO, RQQ); the limits are charged in SQL on the
 * first delivery of a request id only. A wrong token is 401; without the header the strict `{ email, name }` body applies.
 */
export async function subscribeToAnnouncements(
  request: Request,
  env: Env,
  _sendlaneFetch: SendlaneFetch,
  requestId: string,
): Promise<Response> {
  const forwarder = await siteForwarderAuth(request, env);
  if (forwarder === "wrong") {
    // Names only: never the token, the address or the name.
    console.error(JSON.stringify({
      message: "announcement forwarder refused: wrong token",
      requestId,
      errorCode: "forwarder_unauthorized",
      header: SITE_FORWARDER_HEADER,
      secret: SITE_FORWARDER_SECRET_NAME,
    }));
    throw new HTTPError(401, "unauthorized");
  }
  if (forwarder === "valid") return subscribeForwarded(request, env, requestId);

  const parsed = subscribeSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const email = emailSchema.safeParse(parsed.data.email);
  if (!email.success) throw new HTTPError(400, "invalid_email");
  const name = (parsed.data.name ?? "").trim();
  const now = Date.now();
  const [emailKey, callerKey] = await Promise.all([
    subjectKey("announce-email", email.data, env.BETTER_AUTH_SECRET),
    subjectKey("announce-caller", request.headers.get("cf-connecting-ip") ?? "", env.BETTER_AUTH_SECRET),
  ]);
  const { outcome } = await runSignup(env, {
    path: "legacy", email: email.data, name, source: "legacy_desktop", forwarderSource: null, consentWords: null, withGuide: false,
    // One id per address per 10 minutes: a retry inside the bucket is a replay (uncharged, same answer).
    requestId: `legacy:${emailKey}:${Math.floor(now / LEGACY_BUCKET_MS)}`,
    payloadHash: await hex256(JSON.stringify([email.data, name])),
    limits: { firstKey: emailKey, firstWindowMs: EMAIL_WINDOW_MS, firstMax: EMAIL_MAX_ATTEMPTS,
      secondKey: callerKey, secondWindowMs: CALLER_WINDOW_MS, secondMax: CALLER_MAX_ATTEMPTS },
  }, now);
  if (outcome === "rate_limited") throw new HTTPError(429, "rate_limited");
  return json({ ok: true });
}

const LEGACY_BUCKET_MS = 10 * 60 * 1_000;

/** The forwarded path (valid `X-Murage-Site-Token`). */
async function subscribeForwarded(request: Request, env: Env, requestId: string): Promise<Response> {
  const raw = await readBoundedJSON(request);
  const now = Date.now();
  const parsed = forwardedSchema.safeParse(raw);
  const email = parsed.success ? emailSchema.safeParse(parsed.data.email) : null;
  if (!parsed.success || !email?.success) {
    // 3.3 RJ, RJQ: a validation failure with a usable request id commits `invalid` for that id and payload, once.
    const fields = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const rid = fields.requestId;
    if (typeof rid !== "string" || rid.length < 16 || rid.length > 120) throw new HTTPError(400, "invalid");
    // T-C1 closed (either flag off): no RJ, no tombstone, a plain 400 without `committed` (B1 r1: Astra High, Grok M2).
    if (!updatesSignupsOpen(env)) throw new HTTPError(400, "invalid");
    const rejected = await rejectSignup(env, rid, await hex256(JSON.stringify(raw)), now);
    if (rejected.committed) return errorResponse(400, "invalid", { committed: false });
    return forwardedAnswer(rejected.outcome ?? "invalid", fields.withGuide === true);
  }
  const source: ForwarderSource = parsed.data.source ?? "site";
  const withGuide = parsed.data.withGuide === true;
  const [emailKey, capKey] = await Promise.all([
    subjectKey("announce-email", email.data, env.BETTER_AUTH_SECRET),
    subjectKey("announce-forwarder-cap", "global", env.BETTER_AUTH_SECRET),
  ]);
  const { outcome, textVersion } = await runSignup(env, {
    path: "forwarder", email: email.data, name: (parsed.data.name ?? "").trim(), source, forwarderSource: source,
    consentWords: parsed.data.consentText ?? null, withGuide, requestId: parsed.data.requestId,
    payloadHash: await hex256(JSON.stringify([parsed.data.requestId, email.data, source, parsed.data.consentText ?? null, withGuide, parsed.data.name ?? null])),
    limits: { firstKey: emailKey, firstWindowMs: EMAIL_WINDOW_MS, firstMax: EMAIL_MAX_ATTEMPTS,
      secondKey: capKey, secondWindowMs: FORWARDER_WINDOW_MS, secondMax: FORWARDER_HOURLY_CAP },
  }, now);
  if (outcome === "rate_limited") await forwarderCapAlert(env, capKey, now, requestId);
  if (textVersion === APP_UNMATCHED_VERSION) await appUnmatchedAlert(env, now, requestId);
  return forwardedAnswer(outcome, withGuide);
}

/**
 * `POST /v1/announcements/unsubscribe`, site forwarder only (SU, design v5.6.1 3.3). Without a valid `X-Murage-Site-Token` (or with the
 * secret unset) this returns null and the caller answers the unknown-route 404. Body `{ email }`. D1 only: SU1 writes the 0146 opt-outs
 * (the mirror trigger appends `list37`), SU1b appends `our_unsub`, SU2 to SU5 withdraw every row for the address, delete its prove
 * tokens, drop its queued mail and write the events. 200 `{ ok: true }`; 429 over the per-address limit or the hourly cap. No refunds.
 */
export async function unsubscribeFromAnnouncements(
  request: Request,
  env: Env,
  _sendlaneFetch: SendlaneFetch,
  requestId: string,
): Promise<Response | null> {
  if (await siteForwarderAuth(request, env) !== "valid") return null;
  const parsed = unsubscribeSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const email = emailSchema.safeParse(parsed.data.email);
  if (!email.success) throw new HTTPError(400, "invalid_email");

  const now = Date.now();
  // Its own key space: an unsubscribe never spends the signup budget for the same address.
  const [limitKey, capKey, optKey] = await Promise.all([
    subjectKey("announce-unsubscribe", email.data, env.BETTER_AUTH_SECRET),
    subjectKey("announce-unsubscribe-cap", "global", env.BETTER_AUTH_SECRET),
    subjectKey("announce-email", email.data, env.BETTER_AUTH_SECRET),
  ]);
  const emailAllowed = await withinLimit(env, limitKey, EMAIL_WINDOW_MS, EMAIL_MAX_ATTEMPTS, now);
  const capAllowed = emailAllowed && await withinLimit(env, capKey, FORWARDER_WINDOW_MS, UNSUBSCRIBE_HOURLY_CAP, now);
  if (!emailAllowed) throw new HTTPError(429, "rate_limited");
  if (!capAllowed) {
    console.error(JSON.stringify({ message: "announcement unsubscribe over its hourly cap", requestId, errorCode: "unsubscribe_cap", cap: UNSUBSCRIBE_HOURLY_CAP }));
    try {
      await raiseAlert(env, {
        homeId: `platform:sendlane-unsubscribe:${hourBucket(now)}`,
        kind: UNSUBSCRIBE_CAP_ALERT,
        severity: "high",
        detail: `unsubscribe reached ${UNSUBSCRIBE_HOURLY_CAP} requests this hour; later ones answer 429 until the hour turns. Check the site, or rotate ${SITE_FORWARDER_SECRET_NAME} if it leaked.`,
      }, now);
    } catch { /* an alert never changes the answer */ }
    throw new HTTPError(429, "rate_limited");
  }

  const configured = String(env.SENDLANE_LIST_ID ?? "").trim();
  const mainListId = listIdSchema.safeParse(configured).success ? configured : DEFAULT_LIST_ID;
  const lists = unsubscribeLists(env, mainListId);
  const nonce = crypto.randomUUID();
  await env.DB.batch([
    bindNumbered(env.DB, UQ.SU1, { 1: optKey, 2: now, 4: lists[0], 5: lists[1] ?? null }),
    bindNumbered(env.DB, UQ.SU1b, { 1: optKey, 2: now }),
    ...[UB.SU2, UB.SU3, UB.SU4, UB.SU5].map((s) => bindNumbered(env.DB, s, { 1: optKey, 2: now, 3: nonce })),
  ]);
  return json({ ok: true });
}
