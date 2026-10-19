// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ControlPlaneAuth } from "./auth";
import { accountSession } from "./auth";
import { accountContactEmail } from "./cloud-accounts";
import { boundCustomer } from "./customer-identity";
import { senderOrFail, sendOTPEmailChecked, type TransactionalEmailSender } from "./email";
import { HTTPError, json, readBoundedJSON } from "./http";
import { signPayload } from "./b3-signatures";
import { pinnedTargetHolds } from "./step-up-op";
import { base64, kekReadable, keyWrapperFor, type KeyWrapper } from "./key-wrapper";

// First-device pairing. The home accepts POST /api/cloud/pairing for its first
// device only with an HMAC made with its bootstrap secret; the control plane
// holds that secret wrapped. Before using it, the signed-in OWNER proves they
// are at their inbox with a 6-digit code, so a stolen bearer token alone cannot
// pair a device. Lost-device recovery is not here.
//
// ADD DEVICE (POST /v1/homes/:id/pairing/device, B3 WP4): the home refuses a bootstrap-only request once any device exists,
// so a further device needs BOTH the CP's bootstrap signature AND a step-up from an already-paired owner device. The CP
// therefore never calls the home on this path. It checks the signed-in owner, rate limits, and returns the exact body and
// its HMAC; the already-paired desktop sends them to the home itself, with a native confirm and a step-up assertion on the
// FIRST request (the home spends the bootstrap nonce before it checks step-up). Strictest scope: owner-desktop only, one
// device per request, no recovery, no browser factor. And never without the 72-hour hold (SELF-SERVICE.md section 4): the
// owner must have a completed, uncancelled "pair" hold for the home's current generation; the body carries a fresh CP-signed
// proof of it, and the home accepts one device per hold (a stolen session plus an unlocked desktop cannot add a device at once).
//
// Every route here except the redemption is a Cloud route (customer-identity.ts isCloudScopePath): the caller is the
// members-area Supabase identity, never a Better Auth (phone-companion) session. The desktop uses none of them at launch.
//
// DESKTOP CODE (Astra MAKERKIT4 #2), kept for a FUTURE Cloud-home desktop feature; nothing in the desktop calls it at
// launch. A Cloud account has no login on the desktop, so a desktop would pair with a one-time code:
//   1. POST /v1/account/homes/:id/desktop-code: the members area, for the signed-in OWNER with a fresh second factor
//      (a Cloud customer route; customer-identity.ts STEP_UP_PATTERNS). One live code per account and home (a new one
//      replaces the last), 10 minutes, stored as an HMAC only, rate limited. The owner is emailed before the code is
//      returned; if that email cannot be sent, no code exists.
//   2. POST /v1/pairing/desktop { code, device, mode }: the desktop app, with no account session; the code is the
//      credential. It is spent atomically before anything else (single use, also on every later failure), the home must
//      still be owned by the account that made it, and the owner is emailed again before the home is contacted.
//      mode "first": exactly the email-code path's home call (the home refuses it once any device exists: 409).
//      mode "add": exactly the add-device answer (body + bootstrap HMAC + hold proof) for an ALREADY-PAIRED desktop, which
//      needs the completed 72-hour pair hold (409 pair_hold_required otherwise) and that desktop's own step-up at the home. Nothing else changes in B3 pairing.
const CODE_TTL_MS = 10 * 60 * 1000;
const DESKTOP_CODE_TTL_MS = 10 * 60 * 1000;
const DESKTOP_CODE_MAX = 5;
const DESKTOP_ROUTE = /^\/v1\/account\/homes\/([\w-]{1,128})\/desktop-code$/;
export const DESKTOP_REDEEM_PATH = "/v1/pairing/desktop";
// Crockford base32 without I, L, O, U: 16 characters, 80 bits, typed as XXXX-XXXX-XXXX-XXXX.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ATTEMPTS = 5;
const START_WINDOW_MS = 60 * 60 * 1000;
const START_ACCOUNT_MAX = 5;
const START_HOME_MAX = 5;
const HOME_TTL_SECONDS = 120;
const HOME_TIMEOUT_MS = 10_000;
const ROUTE = /^\/v1\/homes\/([\w-]{1,128})\/pairing\/(start|code|device)$/;
const DEVICE_MAX = 10;
/** A completed pair hold can be used to add its one device for this long after it completed. */
export const PAIR_HOLD_USE_MS = 7 * 24 * 60 * 60 * 1000;
const PAIR_PROOF_MS = 5 * 60 * 1000;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const REFUSED = () => new HTTPError(403, "pairing_refused");

export interface PairingAccount { id: string; email: string }
export interface PairingDependencies {
  /** The signed-in account for this request, or null. Default: accountSession (on these Cloud routes, the Supabase identity). */
  currentAccount?: (request: Request, auth: ControlPlaneAuth) => Promise<PairingAccount | null>;
  /** The account id that owns the home, or null. Default: cloud_homes.owner_id. */
  ownerOf?: (env: Env, homeId: string) => Promise<string | null>;
  emailSender?: (env: Env) => TransactionalEmailSender;
  /** Outbound call to the home. Default: global fetch. */
  homeFetch?: typeof fetch;
  /** The bootstrap-secret unwrapper. Default: keyWrapperFor(env). Tests inject one to move the home while a key is unwrapped. */
  keyWrapper?: (env: Env) => KeyWrapper;
}

const deviceSchema = z.strictObject({
  scope: z.enum(["owner-desktop", "owner-phone", "browser"]),
  publicKey: z.string().min(1).max(4096),
  assertionKey: z.string().min(1).max(4096),
  browserFactor: z.strictObject({
    credentialId: z.string().min(1).max(1024), rpId: z.string().min(1).max(253),
    origin: z.string().min(1).max(2048), counter: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).optional(),
});
const codeSchema = z.strictObject({ emailCode: z.string().regex(/^\d{6}$/), device: deviceSchema });
const ownerDesktop = z.strictObject({
  scope: z.literal("owner-desktop"), publicKey: z.string().min(1).max(4096), assertionKey: z.string().min(1).max(4096),
});
const addDeviceSchema = z.strictObject({ device: ownerDesktop });
const redeemSchema = z.strictObject({ code: z.string().min(16).max(32), device: ownerDesktop, mode: z.enum(["first", "add"]) });
const homeAnswerSchema = z.object({ code: z.string().min(1).max(256), expiresIn: z.number().int().positive().max(600) });

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
/** The device a pair hold is spent on: SHA-256 (hex) over its scope and both keys. The home computes the same over the pairing body
 *  (server/cloud-request-auth.ts) and refuses a proof for any other device. Pinned by shared/self-service-contract.json. */
export async function pairDeviceDigest(device: { scope: string; publicKey: string; assertionKey: string }): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`murage-pair-device-v1\n${device.scope}\n${device.publicKey}\n${device.assertionKey}`)));
}
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}
function sixDigits(): string {
  // Rejection sampling: no modulo bias.
  const limit = 4_294_967_296 - (4_294_967_296 % 1_000_000);
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0] >= limit);
  return String(word[0] % 1_000_000).padStart(6, "0");
}
function desktopCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => CROCKFORD[b & 31]).join(""); // 32 divides 256: no bias
  return chars.match(/.{4}/g)!.join("-");
}
/** Upper-case, dashes and spaces dropped, Crockford's look-alikes folded (O->0, I/L->1). Null if not a code. */
function normalizeDesktopCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(c) ? c : null;
}
const desktopCodeHash = (env: Env, normalized: string) => hmacHex(env.BETTER_AUTH_SECRET, `desktop-pairing-code:${normalized}`);

const codeHash = (env: Env, account: string, homeId: string, code: string) =>
  hmacHex(env.BETTER_AUTH_SECRET, `pairing-email-code:${account}:${homeId}:${code}`);

async function defaultOwnerOf(env: Env, homeId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT owner_id FROM cloud_homes WHERE id=? AND desired_state<>'deleted'")
    .bind(homeId).first<{ owner_id: string }>();
  if (row) return row.owner_id;
  // Staging test machines have no cloud_homes row; their owner is assigned by the admin route.
  if ((env as { CLOUD_CP0_STAGING?: string }).CLOUD_CP0_STAGING !== "1") return null;
  const assigned = await env.DB.prepare("SELECT owner_user_id FROM machine_owners WHERE machine_id=?")
    .bind(homeId).first<{ owner_user_id: string }>();
  return assigned?.owner_user_id ?? null;
}

/** Fixed-window counter in the shared HMAC-keyed ledger (same upsert as the unwrap limiter). */
async function withinLimit(env: Env, subject: string, max: number): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - START_WINDOW_MS;
  const result = await env.DB.prepare(`INSERT INTO announcement_rate_limits (subject_key,window_started_at,attempts,updated_at)
    VALUES (?,?,1,?)
    ON CONFLICT(subject_key) DO UPDATE SET
      window_started_at=CASE WHEN window_started_at<=? THEN excluded.window_started_at ELSE window_started_at END,
      attempts=CASE WHEN window_started_at<=? THEN 1 ELSE attempts+1 END,
      updated_at=excluded.updated_at
    WHERE window_started_at<=? OR attempts<?`)
    .bind(await hmacHex(env.BETTER_AUTH_SECRET, subject), now, now, cutoff, cutoff, cutoff, max).run();
  return result.meta.changes !== 0;
}

async function start(env: Env, homeId: string, account: PairingAccount, dependencies: PairingDependencies) {
  // Same 202 whether the home exists, is owned by somebody else, or is ours.
  const accepted = () => json({ sent: true }, 202);
  // The account limit counts every start regardless of the home, so it reveals nothing about any home.
  if (!await withinLimit(env, `pairing-start-account:${account.id}`, START_ACCOUNT_MAX)) throw new HTTPError(429, "rate_limited");
  const owner = await (dependencies.ownerOf ?? defaultOwnerOf)(env, homeId);
  if (owner === null || owner !== account.id) return accepted();
  // Counted only for the owner, so a stranger cannot lock the owner out of their own home.
  if (!await withinLimit(env, `pairing-start-home:${homeId}`, START_HOME_MAX)) throw new HTTPError(429, "rate_limited");
  const code = sixDigits();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO pairing_email_codes (account_id,home_id,code_hash,attempts,expires_at,created_at)
    VALUES (?,?,?,0,?,?)
    ON CONFLICT(account_id,home_id) DO UPDATE SET code_hash=excluded.code_hash,attempts=0,expires_at=excluded.expires_at,created_at=excluded.created_at`)
    .bind(account.id, homeId, await codeHash(env, account.id, homeId, code), now + CODE_TTL_MS, now).run();
  const sender = dependencies.emailSender?.(env) ?? senderOrFail(env);
  const delivered = await sendOTPEmailChecked(sender, env.EMAIL_FROM, { email: account.email, otp: code, type: "device-pairing" }, "pairing");
  if (!delivered) {
    // Only the owner reaches here, so this does not reveal ownership to anyone else.
    await env.DB.prepare("DELETE FROM pairing_email_codes WHERE account_id=? AND home_id=?").bind(account.id, homeId).run();
    throw new HTTPError(503, "email_unavailable");
  }
  return accepted();
}

/** Consumes one attempt and, on a match, the code itself. Every failure is the same refusal. */
async function redeemEmailCode(env: Env, account: string, homeId: string, code: string): Promise<void> {
  const now = Date.now();
  // Attempt is spent before the comparison, atomically, so concurrent guesses cannot exceed the cap.
  const row = await env.DB.prepare(`UPDATE pairing_email_codes SET attempts=attempts+1
    WHERE account_id=? AND home_id=? AND expires_at>? AND attempts<? RETURNING code_hash`)
    .bind(account, homeId, now, MAX_ATTEMPTS).first<{ code_hash: string }>();
  if (!row) throw REFUSED();
  const expected = new TextEncoder().encode(row.code_hash);
  const actual = new TextEncoder().encode(await codeHash(env, account, homeId, code));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw REFUSED();
  // Single use: only the request that deletes the row proceeds.
  const used = await env.DB.prepare("DELETE FROM pairing_email_codes WHERE account_id=? AND home_id=? AND code_hash=?")
    .bind(account, homeId, row.code_hash).run();
  if (used.meta.changes !== 1) throw REFUSED();
}

async function pair(request: Request, env: Env, homeId: string, account: PairingAccount, dependencies: PairingDependencies) {
  const parsed = codeSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const owner = await (dependencies.ownerOf ?? defaultOwnerOf)(env, homeId);
  if (owner === null || owner !== account.id) throw REFUSED();
  await redeemEmailCode(env, account.id, homeId, parsed.data.emailCode);
  // From here on the caller proved the inbox; failures may be specific.
  return json(await firstDeviceAtHome(request, env, homeId, account, parsed.data.device, dependencies));
}

/** The CP's first-device call to the home: bootstrap-signed body, the home's one-time pairing code back. */
async function firstDeviceAtHome(request: Request, env: Env, homeId: string, account: PairingAccount, device: Record<string, unknown>,
  dependencies: PairingDependencies, pinned?: number | null) {
  const prepared = await prepareHomeRequest(env, homeId, account, device, {}, pinned, dependencies);
  const { homeOrigin, body, signature } = prepared;
  let response: Response;
  try {
    response = await (dependencies.homeFetch ?? fetch)(`${homeOrigin}/api/cloud/pairing`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(HOME_TIMEOUT_MS),
      // The home's request guard refuses a POST without an Origin naming itself.
      headers: { "content-type": "application/json", "x-murage-signature": signature, origin: homeOrigin }, body,
    });
  } catch {
    throw new HTTPError(502, "home_unreachable");
  }
  if (response.status === 403) {
    // The home refuses a bootstrap-only request once any device exists and asks for a device step-up.
    const answer = await response.json().catch(() => null) as { error?: unknown } | null;
    if (answer?.error === "step-up required") throw new HTTPError(409, "already_paired");
    throw new HTTPError(502, "home_refused");
  }
  if (response.status !== 200) throw new HTTPError(502, "home_refused");
  const answer = homeAnswerSchema.safeParse(await response.json().catch(() => null));
  if (!answer.success) throw new HTTPError(502, "home_refused");
  // The generation the body was signed for is enforced again as the answer is recorded: a home that moved while the request was in
  // flight gets no 200 (the home itself refuses a body for a generation it is not at, server/cloud-request-auth.ts).
  await recordDisclosure(request, env, homeId, prepared, "pairing_ok");
  return { code: answer.data.code, expiresIn: answer.data.expiresIn, homeOrigin };
}

/**
 * The home's pairing body and its bootstrap HMAC, built from the stored hostname and the wrapped bootstrap secret only.
 * `pinned` is the generation an approval or a desktop code was issued for (Astra STEPUP-EMAIL-6 #1): the key, the machine and the home
 * are read in ONE statement and all must be at exactly that generation, never "current", or nothing is signed (409 home_changed); the
 * signed body names it. `null` pins a staging test machine that has no home row at all. Undefined is the unpinned inbox-code route.
 */
async function prepareHomeRequest(env: Env, homeId: string, account: PairingAccount, device: Record<string, unknown>,
  extra: Record<string, unknown> = {}, pinned: number | null | undefined, dependencies: PairingDependencies) {
  const machine = await env.DB.prepare(`SELECT m.generation,m.state,k.wrapped_bootstrap_secret,k.kek_id,e.hostname,
      h.id AS home_row,h.generation AS home_generation
    FROM cloud_machines m JOIN cloud_home_keys k ON k.home_id=m.home_id
    JOIN machine_endpoints e ON e.machine_id=m.id AND e.status NOT IN ('deleting','deleted')
    LEFT JOIN cloud_homes h ON h.id=?
    WHERE m.id=?`).bind(homeId, homeId).first<{ generation: number; state: string; wrapped_bootstrap_secret: string; kek_id: string; hostname: string;
      home_row: string | null; home_generation: number | null }>();
  if (machine && pinned !== undefined && (pinned === null ? machine.home_row !== null
    : machine.home_row === null || machine.home_generation !== pinned || machine.generation !== pinned)) {
    throw new HTTPError(409, "home_changed");
  }
  if (!machine || machine.state !== "active" || !kekReadable(machine.kek_id) || !HOSTNAME.test(machine.hostname)) {
    throw new HTTPError(503, "home_unavailable");
  }
  // The origin is built from the stored hostname only.
  const homeOrigin = `https://${machine.hostname}`;
  const secret = base64(await (dependencies.keyWrapper ?? keyWrapperFor)(env).unwrap(homeId, machine.wrapped_bootstrap_secret));
  // The signed body always names the generation it is disclosed for (the pinned one, else the home's as read with the key, else the
  // machine's for a staging machine with no home row); the home compares it with its own pin before minting (Astra STEPUP-EMAIL-7 #1).
  const generation = typeof pinned === "number" ? pinned : machine.home_generation ?? machine.generation;
  const body = JSON.stringify({
    operation: "/api/cloud/pairing", timestamp: Date.now() / 1000, nonce: crypto.randomUUID().replaceAll("-", ""),
    account: account.id, ...device, ttl: HOME_TTL_SECONDS, ...extra, generation,
  });
  // The home keys its HMAC on the base64 string itself (server/cloud-home/secrets.ts), over the exact body bytes.
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return { homeOrigin, body, signature, generation, machineGeneration: machine.generation, wrapped: machine.wrapped_bootstrap_secret,
    homeRow: machine.home_row !== null };
}

/**
 * The audit row of one disclosure, written ONLY while the home is still exactly what the key was read with (Astra STEPUP-EMAIL-7 #1):
 * the machine at the same generation and active, the same wrapped bootstrap secret, and the home row (when there is one) at the
 * generation the body was signed for. One statement, so a generation that moved during the unwrap or the home call fails here and
 * the caller answers 409 home_changed: nothing signed for the older generation is handed out. `also` adds a further predicate.
 */
async function recordDisclosure(request: Request, env: Env, homeId: string,
  prepared: { generation: number; machineGeneration: number; wrapped: string; homeRow: boolean }, outcome: string,
  also: { sql: string; binds: unknown[] } = { sql: "", binds: [] }) {
  const home = prepared.homeRow
    ? " AND EXISTS (SELECT 1 FROM cloud_homes h WHERE h.id=m.id AND h.generation=? AND h.desired_state NOT IN ('deleting','deleted'))"
    : " AND NOT EXISTS (SELECT 1 FROM cloud_homes h WHERE h.id=m.id)";
  const logged = await env.DB.prepare(`INSERT INTO cloud_unwrap_log (home_id,generation,at,source_ip,outcome) SELECT ?,?,?,?,?
    WHERE EXISTS (SELECT 1 FROM cloud_machines m JOIN cloud_home_keys k ON k.home_id=m.home_id
      WHERE m.id=? AND m.generation=? AND m.state='active' AND k.wrapped_bootstrap_secret=?${home})${also.sql}`)
    .bind(homeId, prepared.generation, Date.now(), request.headers.get("CF-Connecting-IP"), outcome,
      homeId, prepared.machineGeneration, prepared.wrapped, ...(prepared.homeRow ? [prepared.generation] : []), ...also.binds).run();
  if (logged.meta.changes !== 1) throw new HTTPError(409, "home_changed");
}

function notice(env: Env, dependencies: PairingDependencies): TransactionalEmailSender {
  return dependencies.emailSender?.(env) ?? senderOrFail(env);
}
/** The owner hears about every desktop code: when it is made and when it is used. Text only, no code in it. */
async function sendDesktopNotice(env: Env, dependencies: PairingDependencies, to: string, kind: "created" | "used") {
  const subject = kind === "created" ? "A code to connect a desktop to your Murage Cloud home" : "A desktop is connecting to your Murage Cloud home";
  const text = kind === "created"
    ? `${subject}\n\nA one-time code to connect the Murage desktop app to your Cloud home was just made in your account on murage.ai. It works once, for 10 minutes.\n\nIf this was not you, do not share the code. Sign in at https://murage.ai/home/cloud, make a new code (it replaces this one) and change your password and second factor.`
    : `${subject}\n\nYour one-time desktop code was just used to connect a desktop to your Cloud home.\n\nIf this was not you, open the Murage desktop app on a device you trust, check the devices paired with your Cloud home and remove any you do not recognise, then contact support.`;
  try {
    await notice(env, dependencies).send({ to, from: { email: env.EMAIL_FROM, name: "Murage" }, subject, text,
      html: `<!doctype html><html><body>${text.split("\n\n").map((p) => `<p>${p}</p>`).join("")}</body></html>` });
    return true;
  } catch {
    console.error(JSON.stringify({ message: "desktop pairing notice failed", kind }));
    return false;
  }
}

/** Members area, signed-in owner with a fresh second factor (the step-up gate runs before this). */
async function createDesktopCode(env: Env, homeId: string, account: PairingAccount, dependencies: PairingDependencies) {
  if (!await withinLimit(env, `desktop-code-account:${account.id}`, DESKTOP_CODE_MAX)) throw new HTTPError(429, "rate_limited");
  const owner = await (dependencies.ownerOf ?? defaultOwnerOf)(env, homeId);
  if (owner === null || owner !== account.id) throw REFUSED();
  if (!await withinLimit(env, `desktop-code-home:${homeId}`, DESKTOP_CODE_MAX)) throw new HTTPError(429, "rate_limited");
  const code = desktopCode();
  const now = Date.now();
  const hash = await desktopCodeHash(env, normalizeDesktopCode(code)!);
  // The code is bound to the home's generation as it is NOW, written in the same statement. Under an emailed step-up approval
  // (step-up-op.ts) both writes apply only while the home is still exactly the target the approval was frozen at (its generation and
  // state, Astra STEPUP-EMAIL-5 #2): a generation that advanced after the gate creates no code (409 home_changed) and replaces nothing.
  const frozen = pinnedTargetHolds(env);
  const holds = frozen ? ` AND ${frozen.sql}` : "";
  const [, inserted] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM desktop_pairing_codes WHERE account_id=? AND home_id=?${holds}`).bind(account.id, homeId, ...(frozen?.binds ?? [])),
    env.DB.prepare(`INSERT INTO desktop_pairing_codes (code_hash,account_id,home_id,expires_at,created_at,generation)
      SELECT ?,?,?,?,?,(SELECT generation FROM cloud_homes WHERE id=?) WHERE 1${holds}`)
      .bind(hash, account.id, homeId, now + DESKTOP_CODE_TTL_MS, now, homeId, ...(frozen?.binds ?? [])),
  ]);
  if (inserted.meta.changes !== 1) throw new HTTPError(409, "home_changed");
  if (!await sendDesktopNotice(env, dependencies, account.email, "created")) {
    await env.DB.prepare("DELETE FROM desktop_pairing_codes WHERE code_hash=?").bind(hash).run();
    throw new HTTPError(503, "email_unavailable");
  }
  console.log(JSON.stringify({ message: "desktop pairing code created", homeId }));
  return json({ code, homeId, expiresIn: DESKTOP_CODE_TTL_MS / 1000 }, 201);
}

/** Desktop app, no account session: the one-time code is the credential. Every failure before the home is the same 403. */
async function redeemDesktopCode(request: Request, env: Env, dependencies: PairingDependencies) {
  const parsed = redeemSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success || parsed.data.device.publicKey === parsed.data.device.assertionKey) throw new HTTPError(400, "invalid_request");
  const normalized = normalizeDesktopCode(parsed.data.code);
  if (!normalized) throw REFUSED();
  // Spent before anything else, atomically: only one request can ever hold it, and a later failure does not give it back.
  const row = await env.DB.prepare("DELETE FROM desktop_pairing_codes WHERE code_hash=? RETURNING account_id,home_id,expires_at,generation")
    .bind(await desktopCodeHash(env, normalized)).first<{ account_id: string; home_id: string; expires_at: number; generation: number | null }>();
  if (!row || row.expires_at <= Date.now()) throw REFUSED();
  const homeId = row.home_id;
  // A code pairs only the home generation it was issued for (Astra STEPUP-EMAIL-5 #2): a code for N never pairs against N+1 (a reset,
  // a restore, a re-provisioning). No recorded generation pairs nothing, except a staging test machine that has no home row at all.
  const current = await env.DB.prepare("SELECT generation FROM cloud_homes WHERE id=?").bind(homeId).first<{ generation: number }>();
  if (current ? row.generation !== current.generation : row.generation !== null) throw REFUSED();
  const owner = await (dependencies.ownerOf ?? defaultOwnerOf)(env, homeId);
  if (owner === null || owner !== row.account_id) throw REFUSED();
  const email = await accountContactEmail(env.DB, row.account_id);
  if (!email) throw REFUSED();
  if (!await sendDesktopNotice(env, dependencies, email, "used")) throw new HTTPError(503, "email_unavailable");
  const account: PairingAccount = { id: row.account_id, email };
  console.log(JSON.stringify({ message: "desktop pairing code used", homeId, mode: parsed.data.mode }));
  if (parsed.data.mode === "add") {
    // The same completed 72-hour pair hold as the add-device route (409 pair_hold_required without it).
    const answer = await (await signedAddDevice(request, env, homeId, account, parsed.data.device, dependencies, row.generation)).json<Record<string, unknown>>();
    return json({ mode: "add", homeId, account: account.id, ...answer });
  }
  // The code's generation is carried through key selection and signing: a change during the notice above is 409, never a newer key.
  const answer = await firstDeviceAtHome(request, env, homeId, account, parsed.data.device, dependencies, row.generation);
  return json({ mode: "first", homeId, account: account.id, ...answer });
}

/**
 * Add a device. The signed-in OWNER of the home gets back the exact body and HMAC for the home's /api/cloud/pairing; the
 * home still demands a step-up from an already-paired owner device, which only that device can give. Rate limited per
 * account and per home. The owner check answers the same refusal for a stranger's home and a missing one.
 */
async function addDevice(request: Request, env: Env, homeId: string, account: PairingAccount, dependencies: PairingDependencies) {
  const parsed = addDeviceSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success || parsed.data.device.publicKey === parsed.data.device.assertionKey) throw new HTTPError(400, "invalid_request");
  const owner = await (dependencies.ownerOf ?? defaultOwnerOf)(env, homeId);
  if (owner === null || owner !== account.id) throw REFUSED();
  if (!await withinLimit(env, `pairing-device-account:${account.id}`, DEVICE_MAX) || !await withinLimit(env, `pairing-device-home:${homeId}`, DEVICE_MAX)) {
    throw new HTTPError(429, "rate_limited");
  }
  return signedAddDevice(request, env, homeId, account, parsed.data.device, dependencies);
}

// ---- the pair hold, shared by the add-device answer (spend) and the desktop door mint (reserve) ----------------------------------------
// The hold: completed (72 hours waited, not cancelled) for the home's current generation, within PAIR_HOLD_USE_MS of its completion, and not
// spent on another device. Door v2 (CLOUD-DOOR-V2-DESIGN.md r4.1): the desktop door mint only RESERVES it for its ticket (reserved_by = the
// ticket nonce, reserved_until = the ticket's expiry plus the clock skew); the home spends it at exchange (consumePairHold, bound to the
// ticket's bind). A reservation that is not used lapses at reserved_until and the hold is usable again; while it stands, no other mint
// and no add-device answer can take the hold.

const ELIGIBLE_HOLD = `FROM cloud_recovery_holds r
    JOIN cloud_homes h ON h.id=r.home_id AND h.generation=r.generation AND h.desired_state NOT IN ('deleting','deleted')
    WHERE r.home_id=? AND r.action='pair' AND r.completed_at IS NOT NULL AND r.canceled_at IS NULL AND r.completed_at>?
      AND (r.spent_device_digest IS NULL OR r.spent_device_digest=?)`;
export interface PairHold { id: string; generation: number; started_at: number; completed_at: number }

/** The newest eligible hold for `digest` that no outstanding door ticket holds (a reservation not lapsed), or null. */
export async function selectPairHold(db: D1Database, homeId: string, digest: string, now: number): Promise<PairHold | null> {
  return db.prepare(`SELECT r.id,r.generation,r.started_at,r.completed_at ${ELIGIBLE_HOLD}
      AND (r.reserved_until IS NULL OR r.reserved_until<=?)
    ORDER BY r.completed_at DESC LIMIT 1`).bind(homeId, now - PAIR_HOLD_USE_MS, digest, now).first<PairHold>();
}

/** SPEND (the add-device answer): atomically, bound to `digest`, only while no door ticket holds it. Asking again for the same device is
 *  allowed. True when this hold is (now) spent on `digest`. */
export async function spendPairHold(db: D1Database, holdId: string, digest: string, now: number): Promise<boolean> {
  const spent = await db.prepare(`UPDATE cloud_recovery_holds SET spent_device_digest=?,spent_at=COALESCE(spent_at,?)
    WHERE id=? AND canceled_at IS NULL AND (spent_device_digest IS NULL OR spent_device_digest=?)
      AND (reserved_until IS NULL OR reserved_until<=?)`).bind(digest, now, holdId, digest, now).run();
  return spent.meta.changes === 1;
}

/** RESERVE (the desktop door mint, r4.1): ONE statement selects the newest eligible hold of the home at `generation` for `bind` that no
 *  other ticket holds and stamps reserved_by/reserved_until; it never spends. `prior`: the nonce this same request reserved with before
 *  (a re-mint takes its own reservation over). A concurrent mint that finds the hold reserved gets null (no claim). */
export async function reservePairHold(db: D1Database, homeId: string, generation: number, bind: string, nonce: string, until: number, now: number,
  prior: string | null = null, consumed: string[] = []): Promise<string | null> {
  const free = "(reserved_until IS NULL OR reserved_until<=? OR reserved_by=?)";
  // `consumed`: the hold ids the home just reported it spent (devices.ts), excluded here even if recording them failed (Astra D1 #3).
  const row = await db.prepare(`UPDATE cloud_recovery_holds SET reserved_by=?, reserved_until=?
    WHERE id=(SELECT r.id ${ELIGIBLE_HOLD} AND r.generation=? AND ${free.replaceAll("reserved_", "r.reserved_")}
        AND r.id NOT IN (SELECT value FROM json_each(?))
      ORDER BY r.completed_at DESC LIMIT 1)
      AND canceled_at IS NULL AND (spent_device_digest IS NULL OR spent_device_digest=?) AND ${free}
    RETURNING id`).bind(nonce, until, homeId, now - PAIR_HOLD_USE_MS, bind, generation, now, prior ?? "", JSON.stringify(consumed), bind, now, prior ?? "")
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** The pair hold still running for the home at `generation` (started, not completed, not cancelled): its end time, or null. */
export async function runningPairHold(db: D1Database, homeId: string, generation: number): Promise<number | null> {
  const row = await db.prepare(`SELECT MIN(completes_at) AS at FROM cloud_recovery_holds WHERE home_id=? AND generation=? AND action='pair'
    AND completed_at IS NULL AND canceled_at IS NULL`).bind(homeId, generation).first<{ at: number | null }>();
  return row?.at ?? null;
}

/** The completed, unspent pair holds of the home's current generation, for My Cloud's holds list (self-service.ts status): "ready" until
 *  readyUntil, or "reserved" while an outstanding desktop door ticket holds it. Listed until spent or lapsed. */
export async function readyPairHolds(db: D1Database, homeId: string, now: number) {
  const rows = await db.prepare(`SELECT r.id,r.started_at,r.completes_at,r.completed_at,r.source,r.reserved_until FROM cloud_recovery_holds r
    JOIN cloud_homes h ON h.id=r.home_id AND h.generation=r.generation AND h.desired_state NOT IN ('deleting','deleted')
    WHERE r.home_id=? AND r.action='pair' AND r.completed_at IS NOT NULL AND r.canceled_at IS NULL AND r.completed_at>? AND r.spent_device_digest IS NULL
    ORDER BY r.completed_at`).bind(homeId, now - PAIR_HOLD_USE_MS)
    .all<{ id: string; started_at: number; completes_at: number; completed_at: number; source: string; reserved_until: number | null }>();
  return rows.results.map((r) => ({ holdId: r.id, action: "pair", startedAt: r.started_at, completesAt: r.completes_at, source: r.source,
    state: r.reserved_until !== null && r.reserved_until > now ? "reserved" as const : "ready" as const, readyUntil: r.completed_at + PAIR_HOLD_USE_MS }));
}

/** ONE bootstrap-HMAC call to a home management route (device management, CLOUD-DOOR-V2-DESIGN.md 3.2): the body names `operation` (the
 *  exact home path the home compares), a fresh nonce the home stores, the account and the home's current generation. Unreachable, or a home
 *  that cannot be asked now: 503 home_unreachable. Returns the home's answer as is. */
export async function homeManagementCall(env: Env, homeId: string, account: PairingAccount, operation: string, extra: Record<string, unknown>,
  dependencies: PairingDependencies): Promise<Response> {
  let prepared: Awaited<ReturnType<typeof prepareHomeRequest>>;
  try { prepared = await prepareHomeRequest(env, homeId, account, {}, { ...extra, operation }, undefined, dependencies); }
  catch (e) {
    if (e instanceof HTTPError && e.status === 503) throw new HTTPError(503, "home_unreachable");
    throw e;
  }
  try {
    return await (dependencies.homeFetch ?? fetch)(`${prepared.homeOrigin}${operation}`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(HOME_TIMEOUT_MS),
      headers: { "content-type": "application/json", "x-murage-signature": prepared.signature, origin: prepared.homeOrigin }, body: prepared.body,
    });
  } catch {
    throw new HTTPError(503, "home_unreachable");
  }
}

/** The one add-device answer, for the add-device route and the desktop code's mode "add": needs the completed 72-hour pair hold. */
async function signedAddDevice(request: Request, env: Env, homeId: string, account: PairingAccount, device: z.infer<typeof ownerDesktop>,
  dependencies: PairingDependencies, codeGeneration?: number | null) {
  // The hold: completed (72 hours waited, not cancelled) for the home's current generation, recently, and not spent on another device.
  // It is spent HERE, atomically and bound to this device's keys, in control-plane state no restore of the home can roll back; the
  // signed proof names the device, and the home refuses any other. Asking again for the same device (a lost answer) is allowed.
  const now = Date.now();
  const digest = await pairDeviceDigest(device);
  const hold = await selectPairHold(env.DB, homeId, digest, now);
  if (!hold) throw new HTTPError(409, "pair_hold_required");
  if (codeGeneration !== undefined && codeGeneration !== hold.generation) throw new HTTPError(409, "home_changed");
  if (!await spendPairHold(env.DB, hold.id, digest, now)) throw new HTTPError(409, "pair_hold_required");
  const proof = await signPayload(env, { type: "murage-recovery-v1", homeId, generation: hold.generation, holdId: hold.id, action: "pair",
    holdStartedAt: hold.started_at, holdCompletedAt: hold.completed_at, cancelState: "not_canceled", deviceKeyDigest: digest,
    issuedAt: now, expiresAt: now + PAIR_PROOF_MS });
  const prepared = await prepareHomeRequest(env, homeId, account, device,
    { pairHoldId: hold.id, pairHoldProof: proof }, hold.generation, dependencies);
  // Fenced as it is recorded (Astra STEPUP-EMAIL-7 #1): the home, machine and key still at the hold's generation, and the hold still
  // uncancelled and spent on this device. A generation that moved during the unwrap answers 409; the signed body is never returned.
  await recordDisclosure(request, env, homeId, prepared, "pairing_device_signed", {
    sql: " AND EXISTS (SELECT 1 FROM cloud_recovery_holds r WHERE r.id=? AND r.generation=? AND r.canceled_at IS NULL AND r.spent_device_digest=?)",
    binds: [hold.id, hold.generation, digest],
  });
  const { homeOrigin, body, signature } = prepared;
  return json({ body, signature, homeOrigin, expiresIn: HOME_TTL_SECONDS });
}


export async function pairingRoute(
  request: Request, env: Env, auth: ControlPlaneAuth, dependencies: PairingDependencies = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === DESKTOP_REDEEM_PATH) {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    return redeemDesktopCode(request, env, dependencies);
  }
  const desktop = DESKTOP_ROUTE.exec(path);
  if (desktop) {
    if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
    // Members area only (a Supabase identity, step-up checked by the worker's gate before this; a Cloud route is always
    // bound, so this is belt and braces).
    if (!boundCustomer(request)) throw new HTTPError(404, "not_found");
    const owner = await (dependencies.currentAccount ?? defaultAccount)(request, auth);
    if (!owner) throw new HTTPError(401, "unauthorized");
    return createDesktopCode(env, desktop[1], owner, dependencies);
  }
  const match = ROUTE.exec(path);
  if (!match) return null;
  if (request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  const resolved = await (dependencies.currentAccount ?? defaultAccount)(request, auth);
  if (!resolved) throw new HTTPError(401, "unauthorized");
  if (match[2] === "start") return start(env, match[1], resolved, dependencies);
  if (match[2] === "device") return addDevice(request, env, match[1], resolved, dependencies);
  return pair(request, env, match[1], resolved, dependencies);
}

async function defaultAccount(request: Request, auth: ControlPlaneAuth): Promise<PairingAccount | null> {
  const session = await accountSession(request, auth);
  return session ? { id: session.user.id, email: session.user.email } : null;
}
