// SPDX-License-Identifier: AGPL-3.0-or-later
// What a Cloud home may ask of the control plane (browser-owner/DESIGN.md sections 6, 7 and 11). Four operations, one door:
//
//   POST /v1/homes/:id/home/owner-code-send     mail a fresh 6-digit code, bound to the exact act the owner is about to do
//   POST /v1/homes/:id/home/owner-code-verify   check the code and answer an ES256 proof of that one act (murage-owner-act-v1, 120 s)
//   POST /v1/homes/:id/home/terms-proof         the signed terms proof built from the checkout acceptance (home-terms.ts)
//   POST /v1/homes/:id/home/owner-event         tell the owner by mail that the browser changed something that outlives it
//
// Authentication, and nothing else is allowed in: x-murage-home-signature = hex HMAC-SHA256 keyed on the home's bootstrap secret (the base64
// STRING, as the home keys it everywhere) over  "murage-home-to-cp-v1\n" + the exact body bytes. The domain string keeps this apart from the
// body the control plane signs for the home (pairing.ts "operation": "/api/cloud/pairing"): a body signed for one cannot be replayed to the
// other. The body is strict JSON naming `operation` (it must equal the path's), `timestamp` (seconds, 300 s skew), `nonce` (spent in D1, so a
// replay is refused) and `generation` (the home's own, which must be the stored one). These routes bypass the customer identity gate (the
// caller is a home, not a member) and nothing else: there is no bearer, no cookie, and no route here writes anything about billing, terms
// acceptance or devices.
//
// The home never stores the owner's address and never sees it whole: the control plane resolves it as Supabase confirms it now
// (cloud-accounts.ts reconciledContactEmail through the identity reader) and answers only a masked form.
//
// A taken-over home holds the secret, so it can ask for codes and events. What it cannot do: sign a proof (the proof is signed here, and only
// after the code for exactly that act checked out), read the code or the address, or reach another home (the secret is per home, and the body
// names the home in the path). Its reach is bounded by the limits below: 30 s between sends and 12 sends a day per home, 5 guesses per code.
import { z } from "zod";
import { FIRST_SETUP_WINDOW_MS } from "./access-events";
import { signPayload, verifyPayload, type SignedEnvelope } from "./b3-signatures";
import { reconciledContactEmail } from "./cloud-accounts";
import { readerUser, type DoorDependencies } from "./door";
import { senderOrFail, type TransactionalEmailSender } from "./email";
import { errorResponse, HTTPError, json } from "./http";
import { mintTermsProof } from "./home-terms";
import { HOME_TERMS_VERSION } from "./home-terms-map";
import { base64, keyWrapperFor, kekReadable, type KeyWrapper } from "./key-wrapper";
import { ACTIVE_STATES } from "./self-service";
import { CODE_DIGITS, CODE_TTL_SECONDS, MAX_GUESSES, SEND_GAP_MS, sixDigits } from "./step-up-email";

export const HOME_API_ROUTE = /^\/v1\/homes\/([\w-]{1,128})\/home\/(owner-code-send|owner-code-verify|terms-proof|owner-event)$/;
export const HOME_SIGNATURE_HEADER = "x-murage-home-signature";
/** Prefixed to the body bytes before the HMAC: home to control plane, never the other way. */
export const HOME_TO_CP_DOMAIN = "murage-home-to-cp-v1\n";
export const HOME_API_SKEW_SECONDS = 300;
/** The proof a verified code earns: one act, one device, 120 seconds, spent once at the home. */
export const OWNER_PROOF_TTL_MS = 120_000;
export const OWNER_CODE_SENDS_PER_DAY = 12;
export const OWNER_EVENT_MAILS_PER_HOUR = 3;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The acts a code can be asked for. The email's words are fixed here by this enum, never taken from the home; one cleaned argument may follow. */
export const OWNER_CODE_LABELS = ["full_access", "allow_request", "folder_trust", "restore_release", "delete", "bot_reach", "new_skill", "mcp_server",
  "traffic_moved", "computer_viewer", "computer_command", "bot_widen", "device_remove", "config_change", "take_down_site", "publish_allow", "fresh_door",
  "other"] as const;
export type OwnerCodeLabel = typeof OWNER_CODE_LABELS[number];
const LABEL_WORDS: Record<OwnerCodeLabel, (arg: string | null) => string> = {
  full_access: (a) => `turn on Full access${a ? ` for ${a}` : ""}`,
  allow_request: (a) => `allow ${a ? a : "a request from your bot"}`,
  folder_trust: (a) => `trust a folder${a ? ` for ${a}` : ""}`,
  restore_release: () => "release what a restore held back",
  delete: (a) => `delete ${a ? a : "something that cannot be undone"}`,
  bot_reach: (a) => `widen what ${a ? a : "a bot"} can reach`,
  new_skill: (a) => `add a skill${a ? `: ${a}` : ""}`,
  mcp_server: (a) => `add a tool server${a ? `: ${a}` : ""}`,
  traffic_moved: () => "send your model traffic to a different address",
  computer_viewer: (a) => `open the computer screen of ${a ? a : "a bot"}`,
  computer_command: (a) => `run a command on the computer of ${a ? a : "a bot"}`,
  bot_widen: (a) => `give ${a ? a : "a bot"} more access`,
  device_remove: () => "remove a device from your home",
  config_change: () => "change a protected setting",
  take_down_site: (a) => `take down ${a ? a : "a published site"}`,
  publish_allow: (a) => `publish ${a ? a : "a page"}`,
  fresh_door: (a) => `connect ${a ? a : "a new channel or script"}`,
  other: () => "make a protected change",
};
/** The owner events a home may report, a fixed enum: no names, no text, no addresses. */
export const OWNER_EVENT_KINDS = ["flux_key_changed", "provider_key_changed", "channel_paired", "script_access_added", "webhook_added", "engine_signed_out",
  "browser_made_owner", "code_used"] as const;
export type OwnerEventKind = typeof OWNER_EVENT_KINDS[number];
const EVENT_WORDS: Record<OwnerEventKind, string> = {
  flux_key_changed: "changed your Flux key", provider_key_changed: "changed an AI provider key", channel_paired: "paired a chat channel",
  script_access_added: "gave a script access", webhook_added: "added a webhook", engine_signed_out: "signed an engine out",
  browser_made_owner: "became an owner of your home", code_used: "used a code to approve a protected change",
};

const base = { timestamp: z.number().finite(), nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), generation: z.number().int().positive() };
const act = z.string().regex(/^[0-9a-f]{64}$/);
const device = z.string().min(1).max(128);
const bodies = {
  "owner-code-send": z.strictObject({ operation: z.literal("owner-code-send"), ...base, deviceId: device, act, label: z.enum(OWNER_CODE_LABELS),
    labelArg: z.string().max(200).optional() }),
  "owner-code-verify": z.strictObject({ operation: z.literal("owner-code-verify"), ...base, deviceId: device, act, challengeId: z.string().regex(/^oc_[0-9a-f]{32}$/),
    code: z.string().regex(/^\d{6}$/) }),
  "terms-proof": z.strictObject({ operation: z.literal("terms-proof"), ...base, homeTermsVersion: z.string().regex(HOME_TERMS_VERSION) }),
  "owner-event": z.strictObject({ operation: z.literal("owner-event"), ...base, seq: z.number().int().min(1).max(2_147_483_647), kind: z.enum(OWNER_EVENT_KINDS) }),
} as const;
type Op = keyof typeof bodies;

export const ownerActProofSchema = z.strictObject({ type: z.literal("murage-owner-act-v1"), homeId: z.string().min(1), generation: z.number().int().positive(),
  account: z.string().min(1), deviceId: z.string().min(1), act, nonce: z.string().min(16), issuedAt: z.number().int(), expiresAt: z.number().int() });
export type OwnerActProof = z.infer<typeof ownerActProofSchema>;
/** The home's side of the check, as a reference the wire tests run (the home carries its own copy): the signature against the pinned key, the
 *  exact shape, the home, generation, account and device it was issued for, the act it equals, and the 120 second life. It does NOT spend the
 *  nonce: the home spends it once, in its own store, after every other check passed. Throws on any mismatch. */
export async function verifyOwnerActProof(envelope: SignedEnvelope, publicJwk: JsonWebKey,
  expected: { homeId: string; generation: number; account: string; deviceId: string; act: string; now: number }): Promise<OwnerActProof> {
  const claims = ownerActProofSchema.parse(await verifyPayload(envelope, publicJwk));
  if (claims.homeId !== expected.homeId || claims.generation !== expected.generation || claims.account !== expected.account || claims.deviceId !== expected.deviceId
    || claims.act !== expected.act) throw new Error("owner_proof_mismatch");
  if (claims.issuedAt > expected.now + 5_000 || claims.expiresAt <= expected.now || claims.expiresAt - claims.issuedAt > OWNER_PROOF_TTL_MS) throw new Error("owner_proof_expired");
  return claims;
}

export interface HomeApiDependencies {
  emailSender?: (env: Env) => TransactionalEmailSender;
  keyWrapper?: (env: Env) => KeyWrapper;
  reader?: DoorDependencies["reader"];
  readerTimeoutMs?: number;
  /** Tests only: the clock (ms). */
  now?: () => number;
}

const enc = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
async function hmacHex(secret: string, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(enc.encode(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new Uint8Array(message)));
}
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const randomId = (prefix: string) => `${prefix}${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** HMAC of the code and everything it is for: one code works for one home, generation, device, act and challenge, for one account and address. */
export const ownerCodeHash = (secret: string, t: { homeId: string; generation: number; deviceId: string; act: string; challengeId: string; accountId: string;
  email: string; code: string }) => hmacHex(secret, enc.encode(JSON.stringify(["murage.owner-code.v1", t.homeId, t.generation, t.deviceId, t.act, t.challengeId, t.accountId, t.email, t.code])));

/** The one cleaned argument an email may carry: printable text only, no markup characters, no links, at most 60 characters. */
export function cleanArg(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const s = raw.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>&"'`\\]/gu, " ")
    .replace(/\b(?:https?|ftp|file):\S*/gi, " ").replace(/\bwww\.\S*/gi, " ").replace(/\S+@\S+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return s.length > 0 ? s : null;
}
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

interface Authenticated { homeId: string; generation: number; ownerId: string; now: number; op: Op; body: Record<string, unknown> }

async function authenticate(request: Request, env: Env, deps: HomeApiDependencies, homeId: string, op: Op): Promise<Authenticated> {
  const unauthorized = () => new HTTPError(401, "unauthorized");
  const signature = request.headers.get(HOME_SIGNATURE_HEADER) ?? "";
  if (!/^[0-9a-f]{64}$/.test(signature)) throw unauthorized();
  const bytes = new Uint8Array(await request.arrayBuffer());
  // One statement: the key, the machine and the home at one moment. An unknown home, a deleted one and a bad signature are the same 401.
  const row = await env.DB.prepare(`SELECT m.generation AS machine_generation, m.state, k.wrapped_bootstrap_secret, k.kek_id, h.owner_id, h.generation AS home_generation,
      h.desired_state FROM cloud_machines m JOIN cloud_home_keys k ON k.home_id=m.home_id JOIN cloud_homes h ON h.id=m.id WHERE m.id=?`).bind(homeId)
    .first<{ machine_generation: number; state: string; wrapped_bootstrap_secret: string; kek_id: string; owner_id: string; home_generation: number; desired_state: string }>();
  if (!row || row.state !== "active" || !kekReadable(row.kek_id) || !ACTIVE_STATES.includes(row.desired_state)) throw unauthorized();
  let secret: string;
  try {
    // Not an audited unwrap (pairing.ts auditedKeyUse says "a device was connected"): nothing is disclosed here, the secret only checks a signature.
    secret = base64(await (deps.keyWrapper ?? keyWrapperFor)(env).unwrap(homeId, row.wrapped_bootstrap_secret));
  } catch {
    console.error(JSON.stringify({ message: "home api key unavailable", homeId }));
    throw new HTTPError(503, "home_unavailable");
  }
  const prefix = enc.encode(HOME_TO_CP_DOMAIN);
  const message = new Uint8Array(prefix.length + bytes.length);
  message.set(prefix, 0);
  message.set(bytes, prefix.length);
  if (!sameHex(await hmacHex(secret, message), signature)) throw unauthorized();
  // Authentic. Now the body.
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new HTTPError(400, "invalid_request"); }
  const body = bodies[op].safeParse(parsed);
  if (!body.success) throw new HTTPError(400, "invalid_request");
  const now = (deps.now ?? Date.now)();
  const data = body.data as Record<string, unknown> & { timestamp: number; nonce: string; generation: number };
  if (Math.abs(now / 1000 - data.timestamp) > HOME_API_SKEW_SECONDS) throw new HTTPError(401, "stale_timestamp");
  // The home's own generation, which must be the stored one (a restored or replaced home is a different generation).
  if (data.generation !== row.home_generation || row.machine_generation !== row.home_generation) throw new HTTPError(409, "stale_generation");
  const spent = await env.DB.batch([
    env.DB.prepare("DELETE FROM home_api_nonces WHERE expires_at<?").bind(now),
    env.DB.prepare("INSERT OR IGNORE INTO home_api_nonces (home_id,nonce,expires_at) VALUES (?,?,?)").bind(homeId, data.nonce, now + 2 * HOME_API_SKEW_SECONDS * 1000),
  ]);
  if (spent[1].meta.changes !== 1) throw new HTTPError(409, "replay");
  return { homeId, generation: row.home_generation, ownerId: row.owner_id, now, op, body: data };
}

/** The owner's address as Supabase confirms it now; any failure is one answer, and never the address. */
async function ownerAddress(env: Env, deps: HomeApiDependencies, ownerId: string, now: number): Promise<string> {
  try {
    const to = await reconciledContactEmail(env.DB, ownerId, now, readerUser(env, { reader: deps.reader, readerTimeoutMs: deps.readerTimeoutMs }));
    if (to) return to;
  } catch { /* the same answer as no address */ }
  throw new HTTPError(503, "identity_unavailable");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const htmlOf = (text: string) => `<!doctype html><html><body>${text.split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("")}</body></html>`;
const rateLimited = (retryAfterSeconds: number, extra: { [key: string]: string }) => {
  const retryAfter = Math.max(1, retryAfterSeconds);
  const res = errorResponse(429, "rate_limited", { retryAfter, retry_after_seconds: retryAfter, ...extra });
  res.headers.set("retry-after", String(retryAfter));
  return res;
};

async function sendOwnerCode(env: Env, deps: HomeApiDependencies, a: Authenticated): Promise<Response> {
  const b = a.body as { deviceId: string; act: string; label: OwnerCodeLabel; labelArg?: string };
  const to = await ownerAddress(env, deps, a.ownerId, a.now);
  // The same act asked again inside the gap (a double press, a retry) reuses its live challenge: no second mail, no spent slot.
  const live = await env.DB.prepare(`SELECT challenge_id, created_at, expires_at, email FROM home_owner_codes WHERE home_id=? AND generation=? AND device_id=? AND act=?
    AND account_id=? AND expires_at>? AND attempts<? AND created_at>? ORDER BY created_at DESC LIMIT 1`)
    .bind(a.homeId, a.generation, b.deviceId, b.act, a.ownerId, a.now, MAX_GUESSES, a.now - SEND_GAP_MS).first<{ challenge_id: string; created_at: number; expires_at: number; email: string }>();
  if (live && live.email === to) {
    return json({ sent: true, reused: true, challengeId: live.challenge_id, maskedEmail: maskEmail(to), digits: CODE_DIGITS,
      expiresIn: Math.max(0, Math.ceil((live.expires_at - a.now) / 1000)), resendIn: Math.max(0, Math.ceil((live.created_at + SEND_GAP_MS - a.now) / 1000)) });
  }
  const challengeId = randomId("oc_");
  const code = sixDigits();
  const hash = await ownerCodeHash(env.BETTER_AUTH_SECRET, { homeId: a.homeId, generation: a.generation, deviceId: b.deviceId, act: b.act, challengeId, accountId: a.ownerId, email: to, code });
  // ONE batch: the reservation (fewer than 12 in 24 h and none in the last 30 s, decided inside the INSERT so two concurrent sends cannot both
  // pass), then this challenge written only when the reservation took, then the older challenges of the same act removed (a resend replaces).
  const [reserved] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO home_owner_code_sends (id,home_id,challenge_id,at) SELECT ?,?,?,?
      WHERE (SELECT COUNT(*) FROM home_owner_code_sends WHERE home_id=? AND at>?) < ? AND NOT EXISTS (SELECT 1 FROM home_owner_code_sends WHERE home_id=? AND at>?)`)
      .bind(crypto.randomUUID(), a.homeId, challengeId, a.now, a.homeId, a.now - DAY_MS, OWNER_CODE_SENDS_PER_DAY, a.homeId, a.now - SEND_GAP_MS),
    env.DB.prepare(`INSERT INTO home_owner_codes (challenge_id,home_id,generation,account_id,device_id,act,label,code_hash,email,attempts,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?,?,0,?,? WHERE changes()=1`)
      .bind(challengeId, a.homeId, a.generation, a.ownerId, b.deviceId, b.act, b.label, hash, to, a.now, a.now + CODE_TTL_SECONDS * 1000),
    env.DB.prepare(`DELETE FROM home_owner_codes WHERE home_id=? AND device_id=? AND act=? AND challenge_id<>? AND EXISTS (SELECT 1 FROM home_owner_codes WHERE challenge_id=?)`)
      .bind(a.homeId, b.deviceId, b.act, challengeId, challengeId),
    env.DB.prepare("DELETE FROM home_owner_code_sends WHERE home_id=? AND at<?").bind(a.homeId, a.now - DAY_MS),
  ]);
  if (reserved.meta.changes !== 1) {
    const recent = (await env.DB.prepare("SELECT at FROM home_owner_code_sends WHERE home_id=? AND at>? ORDER BY at DESC LIMIT ?")
      .bind(a.homeId, a.now - DAY_MS, OWNER_CODE_SENDS_PER_DAY).all<{ at: number }>()).results;
    const cooldown = recent[0] ? recent[0].at + SEND_GAP_MS - a.now : 0;
    const quota = recent.length >= OWNER_CODE_SENDS_PER_DAY ? recent[OWNER_CODE_SENDS_PER_DAY - 1].at + DAY_MS - a.now : 0;
    return rateLimited(Math.ceil(Math.max(cooldown, quota) / 1000), { limit: quota > cooldown ? "day" : "gap" });
  }
  const subject = `Your Murage code: ${code}`;
  const text = `Use this code to ${LABEL_WORDS[b.label](cleanArg(b.labelArg))}.\n\nYour code is: ${code}\n\n`
    + "It works for 10 minutes. Murage staff will never ask you for it.\n\n"
    + "Not you? Open your Murage Cloud page and choose Make chat-only next to the browser you don't know.";
  try {
    await (deps.emailSender?.(env) ?? senderOrFail(env)).send({ to, from: { email: env.EMAIL_FROM, name: "Murage" }, subject, text, html: htmlOf(text) });
  } catch {
    // The reservation stays spent (a failed delivery counts). Only this challenge goes. Never the message or the address.
    await env.DB.prepare("DELETE FROM home_owner_codes WHERE challenge_id=?").bind(challengeId).run().catch(() => undefined);
    console.error(JSON.stringify({ message: "owner code email failed", homeId: a.homeId }));
    throw new HTTPError(503, "email_unavailable");
  }
  console.log(JSON.stringify({ message: "owner code sent", homeId: a.homeId, label: b.label }));
  return json({ sent: true, reused: false, challengeId, maskedEmail: maskEmail(to), digits: CODE_DIGITS, expiresIn: CODE_TTL_SECONDS, resendIn: SEND_GAP_MS / 1000 });
}

async function verifyOwnerCode(env: Env, deps: HomeApiDependencies, a: Authenticated): Promise<Response> {
  const b = a.body as { deviceId: string; act: string; challengeId: string; code: string };
  // A guess is spent BEFORE the comparison, atomically: at most five per challenge however many requests race. Bound to this home, generation,
  // device and act: another act's challenge is invisible here.
  const ch = await env.DB.prepare(`UPDATE home_owner_codes SET attempts=attempts+1 WHERE challenge_id=? AND home_id=? AND generation=? AND device_id=? AND act=?
    AND attempts<? AND expires_at>? RETURNING code_hash, email, account_id`)
    .bind(b.challengeId, a.homeId, a.generation, b.deviceId, b.act, MAX_GUESSES, a.now).first<{ code_hash: string; email: string; account_id: string }>();
  if (!ch) throw new HTTPError(403, "code_expired");
  const expected = await ownerCodeHash(env.BETTER_AUTH_SECRET, { homeId: a.homeId, generation: a.generation, deviceId: b.deviceId, act: b.act, challengeId: b.challengeId,
    accountId: ch.account_id, email: ch.email, code: b.code });
  if (!sameHex(expected, ch.code_hash) || ch.account_id !== a.ownerId) throw new HTTPError(403, "code_refused");
  // Spent once: a second verify of the same challenge finds nothing.
  const spent = await env.DB.prepare("DELETE FROM home_owner_codes WHERE challenge_id=?").bind(b.challengeId).run();
  if (spent.meta.changes !== 1) throw new HTTPError(403, "code_expired");
  const claims = { type: "murage-owner-act-v1", homeId: a.homeId, generation: a.generation, account: a.ownerId, deviceId: b.deviceId, act: b.act,
    nonce: b64url(crypto.getRandomValues(new Uint8Array(32))), issuedAt: a.now, expiresAt: a.now + OWNER_PROOF_TTL_MS };
  let proof;
  try { proof = await signPayload(env, claims); } catch {
    console.error(JSON.stringify({ message: "owner proof signer unavailable", homeId: a.homeId }));
    throw new HTTPError(503, "signer_unavailable");
  }
  return json({ proof, expiresAt: claims.expiresAt });
}

async function termsProof(env: Env, a: Authenticated): Promise<Response> {
  const b = a.body as { homeTermsVersion: string };
  const answer = await mintTermsProof(env, { homeId: a.homeId, generation: a.generation, ownerId: a.ownerId, homeTermsVersion: b.homeTermsVersion, now: a.now });
  return answer.status === "proof" ? json({ status: "proof", proof: answer.proof }) : json({ status: "none" });
}

async function ownerEvent(env: Env, deps: HomeApiDependencies, a: Authenticated): Promise<Response> {
  const b = a.body as { seq: number; kind: OwnerEventKind };
  const ins = await env.DB.prepare(`INSERT OR IGNORE INTO home_owner_events (home_id,seq,generation,kind,created_at,mailed_at,claim_id,next_attempt_at,attempts)
    VALUES (?,?,?,?,?,NULL,NULL,?,0)`).bind(a.homeId, b.seq, a.generation, b.kind, a.now, a.now).run();
  const duplicate = ins.meta.changes !== 1;
  // The mail itself is best effort here and retried by the sweep: the event is recorded before anything else.
  if (!duplicate) await sendOwnerEventMail(env, deps, a.homeId, a.now);
  return json({ recorded: true, duplicate });
}

/** The owner's own first browser on their new home, soon after it went ready: the welcome email covers it, so it is closed unmailed. Any other change,
 *  a second browser, or a later one is mailed. Unknown is mailed. */
async function ownersFirstBrowser(env: Env, homeId: string, claimed: { kind: string }[], nowMs: number): Promise<boolean> {
  if (claimed.length !== 1 || claimed[0].kind !== "browser_made_owner") return false;
  try {
    const row = await env.DB.prepare(`SELECT h.ready_at AS ready_at, (SELECT COUNT(*) FROM home_owner_events e WHERE e.home_id=h.id AND e.kind='browser_made_owner' AND e.mailed_at IS NOT NULL) AS earlier
      FROM cloud_homes h WHERE h.id=?`).bind(homeId).first<{ ready_at: number | null; earlier: number }>();
    return !!row && row.earlier === 0 && row.ready_at !== null && nowMs <= row.ready_at + FIRST_SETUP_WINDOW_MS;
  } catch { return false; }
}

/** ONE paced send of the unmailed events of a home: claim them, take one of the three slots of the clock hour, mail ONE email for all of them
 *  ("and N more" folds the rest in). No slot: they are released to the next hour. Never throws; true when a mail went out. */
export async function sendOwnerEventMail(env: Env, deps: HomeApiDependencies, homeId: string, nowMs: number): Promise<boolean> {
  const claimId = crypto.randomUUID();
  let claimed: { kind: string; created_at: number; attempts: number }[];
  try {
    claimed = (await env.DB.prepare(`UPDATE home_owner_events SET claim_id=?, next_attempt_at=? WHERE home_id=? AND mailed_at IS NULL AND next_attempt_at<=?
      RETURNING kind, created_at, attempts`).bind(claimId, nowMs + 10 * 60_000, homeId, nowMs).all<{ kind: string; created_at: number; attempts: number }>()).results;
  } catch { return false; }
  if (!claimed.length) return false;
  if (await ownersFirstBrowser(env, homeId, claimed, nowMs)) {
    await env.DB.prepare("UPDATE home_owner_events SET mailed_at=? WHERE claim_id=? AND mailed_at IS NULL").bind(nowMs, claimId).run().catch(() => undefined);
    return false;
  }
  const backOff = async () => {
    try {
      await env.DB.prepare("UPDATE home_owner_events SET attempts=attempts+1, next_attempt_at=? WHERE claim_id=? AND mailed_at IS NULL")
        .bind(Date.now() + Math.min(HOUR_MS, 60_000 * 2 ** Math.min(6, Math.max(...claimed.map((r) => r.attempts)))), claimId).run();
    } catch { /* the claim runs out; the sweep tries again */ }
  };
  const hour = Math.floor(nowMs / HOUR_MS);
  let slot = false;
  try {
    for (let n = 1; n <= OWNER_EVENT_MAILS_PER_HOUR && !slot; n += 1) {
      slot = (await env.DB.prepare("INSERT OR IGNORE INTO home_owner_event_slots (home_id,hour,n,at) VALUES (?,?,?,?)").bind(homeId, hour, n, nowMs).run()).meta.changes === 1;
    }
  } catch { await backOff(); return false; }
  if (!slot) {
    await env.DB.prepare("UPDATE home_owner_events SET next_attempt_at=? WHERE claim_id=? AND mailed_at IS NULL").bind((hour + 1) * HOUR_MS, claimId).run().catch(() => undefined);
    return false;
  }
  try {
    const owner = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=? AND desired_state<>'deleted'").bind(homeId).first<{ owner_id: string }>();
    if (!owner) throw new Error("no_owner");
    const to = await ownerAddress(env, deps, owner.owner_id, nowMs);
    const first = claimed.reduce((x, y) => (y.created_at < x.created_at ? y : x));
    const at = new Date(first.created_at).toISOString().slice(11, 16);
    const kind = first.kind as OwnerEventKind;
    const more = claimed.length > 1 ? ` And ${claimed.length - 1} more change${claimed.length - 1 === 1 ? "" : "s"} since the last email.` : "";
    const text = `A browser ${EVENT_WORDS[kind] ?? "made a change"} on your Murage home at ${at} UTC.${more}\n\n`
      + "Not you? Open your Murage Cloud page and choose Make chat-only next to the browser you don't know.";
    await (deps.emailSender?.(env) ?? senderOrFail(env)).send({ to, from: { email: env.EMAIL_FROM, name: "Murage" }, subject: "A browser changed something on your Murage home", text, html: htmlOf(text) });
  } catch {
    console.error(JSON.stringify({ message: "owner event mail failed", homeId }));
    await backOff();
    return false;
  }
  await env.DB.prepare("UPDATE home_owner_events SET mailed_at=? WHERE claim_id=? AND mailed_at IS NULL").bind(Date.now(), claimId).run().catch(() => undefined);
  return true;
}

/** Cron: every home with an owed owner-event mail gets one paced send; mailed events older than 30 days and old slots are tidied away. */
export async function sweepOwnerEvents(env: Env, nowMs = Date.now(), deps: HomeApiDependencies = {}): Promise<number> {
  for (const [sql, before] of [
    ["DELETE FROM home_owner_events WHERE mailed_at IS NOT NULL AND mailed_at<?", nowMs - 30 * DAY_MS],
    ["DELETE FROM home_owner_event_slots WHERE at<?", nowMs - DAY_MS],
    ["DELETE FROM home_owner_codes WHERE expires_at<?", nowMs - DAY_MS],
    ["DELETE FROM door_computer_notices WHERE created_at<?", nowMs - 30 * DAY_MS],
  ] as const) await env.DB.prepare(sql).bind(before).run().catch(() => undefined);
  const due = await env.DB.prepare("SELECT DISTINCT home_id FROM home_owner_events WHERE mailed_at IS NULL AND next_attempt_at<=? LIMIT 50").bind(nowMs).all<{ home_id: string }>();
  let sent = 0;
  for (const row of due.results) if (await sendOwnerEventMail(env, deps, row.home_id, nowMs)) sent += 1;
  return sent;
}

export async function homeApiRoute(request: Request, env: Env, deps: HomeApiDependencies = {}): Promise<Response | null> {
  const m = HOME_API_ROUTE.exec(new URL(request.url).pathname);
  if (!m) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  const op = m[2] as Op;
  const a = await authenticate(request, env, deps, m[1], op);
  switch (op) {
    case "owner-code-send": return sendOwnerCode(env, deps, a);
    case "owner-code-verify": return verifyOwnerCode(env, deps, a);
    case "terms-proof": return termsProof(env, a);
    case "owner-event": return ownerEvent(env, deps, a);
  }
}
