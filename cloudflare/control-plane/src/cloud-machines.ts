// SPDX-License-Identifier: AGPL-3.0-or-later
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HTTPError, json, readBoundedJSON } from "./http";
import { sha256 } from "./installations";
import { base64, kekIdFor, kekReadable, keyWrapperFor, KEK_KMS } from "./key-wrapper";
import { b3Enabled } from "./b3-config";
import { homeChangeBump } from "./ops-monitor";
import { cloudHomeCloudflare, readConfig } from "./config";
import { allocateMachineEndpoint } from "./endpoints";

const homeIdSchema = z.string().regex(/^[\w-]{1,128}$/);
const originSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
});
const ipSchema = z.string().max(64).refine((ip) => z.ipv4().safeParse(ip).success || z.ipv6().safeParse(ip).success);
// Every CP0 machine is bound to a provider server and its IPs from birth.
const createSchema = z.object({
  homeId: homeIdSchema, publicOrigin: originSchema.optional(), adminUrl: originSchema.optional(),
  // The control plane allocates the hostname itself and derives public_origin from it.
  managed_endpoint: z.boolean().optional(),
  serverId: z.string().min(1).max(128), boundIps: z.array(ipSchema).min(1).max(8),
}).strict();
const enrollSchema = z.object({ token: z.string().min(1).max(256) }).strict();
const unwrapSchema = z.object({ generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const TOKEN_TTL = 30 * 60 * 1000;
/** A provisioning token must outlive the whole provisioning budget (b3-control PROVISION_MAX_MS = 60 min) plus boot time,
 *  so a retried attempt can still deliver it. It is single use and bound to the server and its address at activation. */
const PROVISION_TOKEN_TTL = 90 * 60 * 1000;
// Unwrap is unauthenticated until the bearer check, so it is throttled per
// source IP before any machine lookup, and its audit log is bounded.
const UNWRAP_IP_WINDOW_MS = 60 * 1000;
const UNWRAP_IP_MAX = 30;
const UNWRAP_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;
interface Machine {
  id: string; home_id: string; generation: number; state: string;
  credential_hash: string | null; server_id: string | null; bound_ips: string | null;
  public_origin: string; admin_url: string; created_at: number;
}
interface HomeKeys {
  wrapped_data_key: string; wrapped_bootstrap_secret: string; wrapped_volume_key: string | null; kek_id: string;
}
const randomSecret = () => base64(crypto.getRandomValues(new Uint8Array(32)));
const bearer = (request: Request) => /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";

async function admin(request: Request, env: Env) {
  if (!env.CLOUD_ADMIN_TOKEN) throw new HTTPError(401, "unauthorized");
  const [actual, expected] = await Promise.all([sha256(bearer(request)), sha256(env.CLOUD_ADMIN_TOKEN)]);
  if (!timingSafeEqual(new TextEncoder().encode(actual), new TextEncoder().encode(expected))) {
    throw new HTTPError(401, "unauthorized");
  }
}

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

async function create(request: Request, env: Env) {
  await admin(request, env);
  const input = await body(request, createSchema);
  const homeId = input.homeId;
  // Exactly one source of the public origin: the caller, or the control plane's managed hostname.
  if (input.managed_endpoint ? input.publicOrigin !== undefined : input.publicOrigin === undefined) {
    throw new HTTPError(400, "invalid_request");
  }
  const wrapper = keyWrapperFor(env);
  const [data, bootstrap, volume] = await Promise.all([
    wrapper.wrap(homeId, crypto.getRandomValues(new Uint8Array(32))),
    wrapper.wrap(homeId, crypto.getRandomValues(new Uint8Array(32))),
    wrapper.wrap(homeId, crypto.getRandomValues(new Uint8Array(32))),
  ]);
  const token = randomSecret();
  const now = Date.now();
  const managed = input.managed_endpoint
    ? allocateMachineEndpoint(env, homeId, cloudHomeCloudflare(readConfig(env)).companionHostSuffix, now)
    : null;
  const publicOrigin = managed ? managed.origin : new URL(input.publicOrigin as string).origin;
  // A home is its machine identity for CP0; no provider resource is created.
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_machines
        (id,home_id,generation,state,created_at,public_origin,admin_url,server_id,bound_ips) VALUES (?,?,1,'active',?,?,?,?,?)`)
        .bind(homeId, homeId, now, publicOrigin,
          input.adminUrl ? new URL(input.adminUrl).origin : new URL(request.url).origin,
          input.serverId, JSON.stringify(input.boundIps)),
      env.DB.prepare(`INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)`).bind(homeId, data, bootstrap, volume, kekIdFor(env)),
      env.DB.prepare(`INSERT INTO cloud_enrollment_tokens (hash,machine_id,expires_at,bound_server_id,bound_ip) VALUES (?,?,?,?,?)`)
        .bind(await sha256(token), homeId, now + TOKEN_TTL, input.serverId, input.boundIps[0]),
      ...(managed ? [managed.statement] : []),
    ]);
  } catch (error) {
    if (await env.DB.prepare("SELECT id FROM cloud_machines WHERE id=?").bind(homeId).first()) {
      throw new HTTPError(409, "conflict");
    }
    throw error;
  }
  return json({ machineId: homeId, homeId, enrollmentToken: token, generation: 1,
    ...(managed ? { publicOrigin, hostname: managed.hostname } : {}) }, 201);
}

export interface B3EnrollmentInput {
  homeId: string; generation: number; resourceGeneration: number; publicOrigin: string; adminUrl: string; now: number;
}
// Internal preparation only. CP0 create is staging-only and always bound.
// The winning caller alone receives the token; all durable state contains hashes.
export async function prepareB3Enrollment(env: Env, input: B3EnrollmentInput): Promise<string | null> {
  if (!b3Enabled(env)) throw new Error("b3_disabled");
  homeIdSchema.parse(input.homeId); originSchema.parse(input.publicOrigin); originSchema.parse(input.adminUrl);
  if (await env.DB.prepare("SELECT home_id FROM cloud_provision_intents WHERE home_id=?").bind(input.homeId).first()) return null;
  const wrapper = keyWrapperFor(env);
  const [data, bootstrap, volume] = await Promise.all([0, 1, 2].map(() =>
    wrapper.wrap(input.homeId, crypto.getRandomValues(new Uint8Array(32)))));
  const token = randomSecret(); const hash = await sha256(token); const guard = crypto.randomUUID();
  // Wrapped like every other home secret, so a retried attempt re-delivers the SAME token instead of losing it.
  const tokenWrapped = await wrapper.wrap(input.homeId, new TextEncoder().encode(token));
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_provision_intents (home_id,cp_generation,resource_generation,token_hash,token_wrapped,created_at)
        SELECT id,generation,resource_generation,?,?,? FROM cloud_homes
        WHERE id=? AND generation=? AND resource_generation=? AND desired_state='provisioning'
        ON CONFLICT(home_id) DO NOTHING`).bind(hash, tokenWrapped, input.now, input.homeId, input.generation, input.resourceGeneration),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guard),
      env.DB.prepare(`INSERT INTO cloud_machines
        (id,home_id,generation,state,created_at,public_origin,admin_url) VALUES (?,?,?,'pending_binding',?,?,?)`)
        .bind(input.homeId, input.homeId, input.generation, input.now, input.publicOrigin, input.adminUrl),
      env.DB.prepare("INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)").bind(input.homeId, data, bootstrap, volume, kekIdFor(env)),
      env.DB.prepare("INSERT INTO cloud_enrollment_tokens (hash,machine_id,expires_at) VALUES (?,?,?)")
        .bind(hash, input.homeId, input.now + PROVISION_TOKEN_TTL),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guard),
    ]);
  } catch (error) {
    // A concurrent successful prepare is adoption, never token reconstruction.
    if (await env.DB.prepare("SELECT home_id FROM cloud_provision_intents WHERE home_id=?").bind(input.homeId).first()) return null;
    throw error;
  }
  return token;
}

/** The pending enrollment token of ONE setup attempt of a provisioning home (its resource generation), unwrapped for re-delivery. Null
 *  when none is stored (an intent from before token_wrapped existed), the stored value does not match the recorded hash, or the home's
 *  pending intent belongs to another attempt. Astra MAILRETRY-14 P1: keyed by (home, resource generation), never by the home alone: an
 *  attempt superseded by a reopen (a new payment, the next resource generation) must never receive its replacement's token. */
export async function loadProvisionToken(env: Env, homeId: string, resourceGeneration: number): Promise<{ token: string; hash: string } | null> {
  const row = await env.DB.prepare("SELECT token_hash,token_wrapped FROM cloud_provision_intents WHERE home_id=? AND resource_generation=? AND state='pending'")
    .bind(homeId, resourceGeneration).first<{ token_hash: string; token_wrapped: string | null }>();
  if (!row?.token_wrapped) return null;
  const token = new TextDecoder().decode(await keyWrapperFor(env).unwrap(homeId, row.token_wrapped));
  return await sha256(token) === row.token_hash ? { token, hash: row.token_hash } : null;
}

/** A fresh token for a home whose stored one is missing, used or expired and whose server does not exist yet. The old
 *  token is revoked in the same batch. Never call this when a server was created: it already holds the old token. */
export async function rotateProvisionToken(env: Env, input: { homeId: string; generation: number; resourceGeneration: number; now: number }): Promise<string> {
  if (!b3Enabled(env)) throw new Error("b3_disabled");
  const token = randomSecret(); const hash = await sha256(token); const guard = crypto.randomUUID();
  const wrapped = await keyWrapperFor(env).wrap(input.homeId, new TextEncoder().encode(token));
  await env.DB.batch([
    env.DB.prepare(`UPDATE cloud_provision_intents SET token_hash=?,token_wrapped=?
      WHERE home_id=? AND cp_generation=? AND resource_generation=? AND state='pending' AND server_id IS NULL`)
      .bind(hash, wrapped, input.homeId, input.generation, input.resourceGeneration),
    env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guard),
    env.DB.prepare("UPDATE cloud_enrollment_tokens SET used_at=? WHERE machine_id=? AND used_at IS NULL").bind(input.now, input.homeId),
    env.DB.prepare("INSERT INTO cloud_enrollment_tokens (hash,machine_id,expires_at) VALUES (?,?,?)")
      .bind(hash, input.homeId, input.now + PROVISION_TOKEN_TTL),
    env.DB.prepare("DELETE FROM cloud_write_guards WHERE id=?").bind(guard),
  ]);
  return token;
}

export interface B3BindingInput { homeId: string; generation: number; resourceGeneration: number;
  tokenHash: string; serverId: string; volumeId: string; ips: string[]; now: number; }
export async function bindB3Enrollment(env: Env, input: B3BindingInput): Promise<boolean> {
  if (!b3Enabled(env)) throw new Error("b3_disabled");
  if (!input.ips.length || !input.ips.every((ip) => z.ipv4().safeParse(ip).success || z.ipv6().safeParse(ip).success)) {
    throw new Error("provider_ip_missing");
  }
  const alreadyBound = async () => !!await env.DB.prepare(`SELECT m.id FROM cloud_machines m
    JOIN cloud_homes h ON h.id=m.id JOIN cloud_provision_intents i ON i.home_id=m.id
    WHERE m.id=? AND m.generation=? AND m.state='active' AND m.server_id=? AND m.bound_ips=?
      AND h.generation=m.generation AND h.resource_generation=? AND h.desired_state IN ('checking','ready','payment_problem')
      AND i.state='bound' AND i.token_hash=? AND i.server_id=? AND i.volume_id=?`)
    .bind(input.homeId, input.generation, input.serverId, JSON.stringify(input.ips), input.resourceGeneration,
      input.tokenHash, input.serverId, input.volumeId).first();
  if (await alreadyBound()) return true; // Never clear an issued credential.
  const guard = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE cloud_machines SET state='active',server_id=?,bound_ips=?
        WHERE id=? AND generation=? AND state='pending_binding' AND credential_hash IS NULL
        AND EXISTS(SELECT 1 FROM cloud_homes h JOIN cloud_provision_intents i ON i.home_id=h.id
          JOIN cloud_enrollment_tokens t ON t.hash=i.token_hash AND t.machine_id=h.id
          WHERE h.id=cloud_machines.id AND h.generation=? AND h.resource_generation=? AND h.desired_state='provisioning'
          AND i.cp_generation=h.generation AND i.resource_generation=h.resource_generation AND i.state='pending'
          AND i.token_hash=? AND i.server_phase='created' AND i.volume_phase='created' AND i.server_id=? AND i.volume_id=?
          AND json_extract(i.volume_json,'$.attachment.serverId')=? AND json_extract(i.volume_json,'$.attachment.state')='attached'
          AND t.used_at IS NULL AND t.expires_at>?)`)
        .bind(input.serverId, JSON.stringify(input.ips), input.homeId, input.generation, input.generation,
          input.resourceGeneration, input.tokenHash, input.serverId, input.volumeId, input.serverId, input.now),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(guard),
      env.DB.prepare(`UPDATE cloud_enrollment_tokens SET bound_server_id=?,bound_ip=?
        WHERE hash=? AND machine_id=? AND used_at IS NULL AND expires_at>?`)
        .bind(input.serverId, input.ips[0], input.tokenHash, input.homeId, input.now),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(`${guard}:token`),
      env.DB.prepare(`UPDATE cloud_provision_intents SET state='bound' WHERE home_id=? AND token_hash=?
        AND cp_generation=? AND resource_generation=? AND state='pending'`)
        .bind(input.homeId, input.tokenHash, input.generation, input.resourceGeneration),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(`${guard}:intent`),
      env.DB.prepare(`UPDATE cloud_homes SET desired_state='checking',observed_state='checking',updated_at=?
        WHERE id=? AND generation=? AND resource_generation=? AND desired_state='provisioning'`)
        .bind(input.now, input.homeId, input.generation, input.resourceGeneration),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(`${guard}:home`),
      env.DB.prepare("INSERT INTO cloud_fake_dns VALUES (?,?,60) ON CONFLICT(home_id) DO UPDATE SET addresses=excluded.addresses")
        .bind(input.homeId, JSON.stringify(input.ips)),
      env.DB.prepare(`INSERT INTO cloud_outbox (id,home_id,generation,owner_id,kind,payload,created_at)
        SELECT ?,id,generation,owner_id,'provider_adopted','{}',? FROM cloud_homes WHERE id=?`)
        // One per binding: a home set up again at a new resource generation (a new payment after a given-up setup) is bound again at the
        // same control-plane generation, so that binding is keyed by its resource generation too; the first keeps the original key.
        .bind(`provider-adopted:${input.homeId}:${input.generation}${input.resourceGeneration > 1 ? `:r${input.resourceGeneration}` : ""}`, input.now, input.homeId),
      // The home enters 'checking': evidence from before never counts (Astra AUTOCANARY-11 P2-1, explicit, no trigger).
      homeChangeBump(env.DB, input.homeId, { desired_state: "provisioning", generation: input.generation }, input.now),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id IN (?,?,?,?)")
        .bind(guard, `${guard}:token`, `${guard}:intent`, `${guard}:home`),
    ]);
    return true;
  } catch (error) {
    if (await alreadyBound()) return true;
    throw error;
  }
}

async function rotate(request: Request, env: Env, id: string) {
  await admin(request, env);
  const existing = await env.DB.prepare("SELECT bound_ips FROM cloud_machines WHERE id=?").bind(id).first<Pick<Machine, "bound_ips">>();
  if (!existing) throw new HTTPError(404, "not_found");
  // Never mint an enrolment token for a machine that is not network-bound.
  if (existing.bound_ips === null) throw new HTTPError(409, "unbound_machine");
  const token = randomSecret();
  const now = Date.now();
  const results = await env.DB.batch<Pick<Machine, "generation" | "home_id">>([
    env.DB.prepare("UPDATE cloud_enrollment_tokens SET used_at=? WHERE machine_id=? AND used_at IS NULL").bind(now, id),
    env.DB.prepare(`UPDATE cloud_machines SET generation=generation+1,credential_hash=NULL WHERE id=? RETURNING generation,home_id`).bind(id),
    env.DB.prepare(`INSERT INTO cloud_enrollment_tokens (hash,machine_id,expires_at,bound_server_id,bound_ip)
      SELECT ?,id,?,server_id,json_extract(bound_ips,'$[0]') FROM cloud_machines WHERE id=?`)
      .bind(await sha256(token), now + TOKEN_TTL, id),
    // The old connector token must die with the old credential: owe a tunnel secret roll,
    // performed by the next endpoint claim before it returns any token.
    env.DB.prepare(`UPDATE machine_endpoints SET token_roll_due=1,updated_at=?
      WHERE machine_id=? AND NOT (status='pending' AND tunnel_id IS NULL)`).bind(now, id),
    ...(b3Enabled(env) ? [env.DB.prepare(`UPDATE cloud_homes SET generation=(SELECT generation FROM cloud_machines WHERE id=?),
      updated_at=? WHERE id=?`).bind(id, now, id),
      // A new generation: the home's evidence stops counting (Astra AUTOCANARY-11 P2-1, explicit, no trigger).
      homeChangeBump(env.DB, id, null, now)] : []),
  ]);
  const machine = results[1].results[0];
  if (!machine) throw new HTTPError(404, "not_found");
  return json({ machineId: id, homeId: String(machine.home_id), enrollmentToken: token, generation: Number(machine.generation) });
}

/** Staging-only: a test server was destroyed, so retire the machine. It can no longer
 *  authenticate, its unused tokens die, and the existing endpoint sweep (state 'fenced',
 *  status 'deleting') removes the tunnel and DNS record. Idempotent. */
async function retire(request: Request, env: Env, id: string) {
  await admin(request, env);
  const existing = await env.DB.prepare("SELECT id FROM cloud_machines WHERE id=?").bind(id).first();
  if (!existing) throw new HTTPError(404, "not_found");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE cloud_enrollment_tokens SET used_at=? WHERE machine_id=? AND used_at IS NULL").bind(now, id),
    // Bump the generation only on the first retire so a repeat call changes nothing.
    env.DB.prepare(`UPDATE cloud_machines SET generation=generation+(state<>'fenced'),credential_hash=NULL,state='fenced'
      WHERE id=?`).bind(id),
    env.DB.prepare(`UPDATE machine_endpoints SET status='deleting',delete_requested_at=COALESCE(delete_requested_at,?),updated_at=?
      WHERE machine_id=? AND status!='deleted'`).bind(now, now, id),
  ]);
  return json({ machineId: id, state: "fenced" });
}

/** Staging-only: name the account that owns a test machine for first-device pairing. The
 *  machine has no cloud_homes row, so the owner lives in machine_owners. Idempotent; the
 *  user id is never returned. */
async function assignOwner(request: Request, env: Env, id: string) {
  await admin(request, env);
  const { email } = await body(request, z.strictObject({ email: z.string().trim().min(3).max(320) }));
  const machine = await env.DB.prepare("SELECT id FROM cloud_machines WHERE id=?").bind(id).first();
  if (!machine) throw new HTTPError(404, "not_found");
  // A Cloud account by its contact address first (its "user".email is synthetic; cloud-accounts.ts), else a plain row.
  const user = await env.DB.prepare(`SELECT COALESCE((SELECT user_id FROM supabase_identities WHERE contact_email=?1),
    (SELECT id FROM "user" WHERE email=?1)) AS id`).bind(email.toLowerCase()).first<{ id: string | null }>();
  if (!user?.id) throw new HTTPError(404, "not_found");
  await env.DB.prepare(`INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES (?,?,?)
    ON CONFLICT(machine_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,assigned_at=excluded.assigned_at`)
    .bind(id, user.id, Date.now()).run();
  return json({ machineId: id, assigned: true });
}

async function enroll(request: Request, env: Env, id: string) {
  const input = await body(request, enrollSchema);
  const credential = randomSecret();
  const now = Date.now();
  const tokenHash = await sha256(input.token);
  // Exact string match against ANY of the machine's bound IPs (v4 or v6); no prefix or family loosening.
  const callerIp = request.headers.get("CF-Connecting-IP");
  if (b3Enabled(env)) {
    // Exact current hash only; this branch cannot consume or issue anything.
    const pending = await env.DB.prepare(`SELECT t.hash FROM cloud_enrollment_tokens t
      JOIN cloud_machines m ON m.id=t.machine_id JOIN cloud_homes h ON h.id=m.id
      JOIN cloud_provision_intents i ON i.home_id=h.id AND i.token_hash=t.hash
      WHERE t.hash=? AND t.machine_id=? AND t.used_at IS NULL AND t.expires_at>?
        AND m.state='pending_binding' AND m.credential_hash IS NULL AND m.server_id IS NULL
        AND h.desired_state='provisioning' AND h.generation=m.generation AND h.generation=i.cp_generation
        AND h.resource_generation=i.resource_generation AND i.state='pending'`)
      .bind(tokenHash, id, now).first();
    if (pending) return json({ error: "enrollment_pending" }, 409);
  }
  // D1 batch is a transaction. changes() links credential issuance to this
  // request's successful token consumption; concurrent replays cannot issue one.
  const results = await env.DB.batch<Pick<Machine, "home_id" | "admin_url" | "public_origin" | "generation">>([
    env.DB.prepare(`UPDATE cloud_enrollment_tokens SET used_at=?
      WHERE hash=? AND machine_id=? AND used_at IS NULL AND expires_at>?
      AND (bound_ip IS NULL OR bound_ip=? OR EXISTS (SELECT 1 FROM cloud_machines mb,
        json_each(CASE WHEN json_valid(mb.bound_ips) THEN mb.bound_ips ELSE '[]' END) je
        WHERE mb.id=machine_id AND je.value=?))
      AND EXISTS (SELECT 1 FROM cloud_machines m WHERE m.id=machine_id AND m.state='active'
        AND m.credential_hash IS NULL AND (bound_server_id IS NULL OR bound_server_id=m.server_id))
      ${b3Enabled(env) ? `AND NOT EXISTS(SELECT 1 FROM cloud_homes h JOIN cloud_machines m ON m.id=h.id
        WHERE h.id=machine_id AND (h.generation<>m.generation OR h.desired_state NOT IN ('provisioning','checking','ready','payment_problem')
          OR m.server_id IS NULL OR m.bound_ips IS NULL OR bound_server_id IS NULL OR bound_ip IS NULL))` : ""}`)
      .bind(now, tokenHash, id, now, callerIp, callerIp),
    env.DB.prepare(`UPDATE cloud_machines SET credential_hash=? WHERE id=? AND changes()=1
      RETURNING home_id,admin_url,public_origin,generation`).bind(await sha256(credential), id),
  ]);
  const machine = results[1].results[0];
  if (results[0].meta.changes !== 1 || !machine) throw new HTTPError(401, "unauthorized");
  const siteOrigin = enrollSiteOrigin(env);
  return json({ machineCredential: credential, homeId: String(machine.home_id), adminUrl: String(machine.admin_url),
    publicOrigin: String(machine.public_origin), generation: Number(machine.generation),
    ...(siteOrigin ? { siteOrigin } : {}) });
}

/** The marketing site's origin, handed to the home at enrollment so it can send a first-time browser to
 *  <siteOrigin>/home/cloud/open. Only a bare https origin is passed on; missing or invalid means the field is
 *  absent (never null, never a default) and one warning names the problem. */
function enrollSiteOrigin(env: Env): string | undefined {
  const raw = (env as unknown as { SITE_ORIGIN?: string }).SITE_ORIGIN;
  if (raw === undefined || raw === "") {
    console.warn("cloud enroll: SITE_ORIGIN is not set; enroll response omits siteOrigin");
    return undefined;
  }
  if (!originSchema.safeParse(raw).success) {
    console.warn("cloud enroll: SITE_ORIGIN is not a bare https origin; enroll response omits siteOrigin");
    return undefined;
  }
  return new URL(raw).origin;
}

/** Same shared HMAC-keyed ledger and upsert shape as the announcement limiter. */
async function unwrapIpWithinLimit(request: Request, env: Env): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - UNWRAP_IP_WINDOW_MS;
  const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  const mac = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`unwrap-ip:${ip}`));
  const subject = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  const result = await env.DB.prepare(`INSERT INTO announcement_rate_limits (subject_key,window_started_at,attempts,updated_at)
    VALUES (?,?,1,?)
    ON CONFLICT(subject_key) DO UPDATE SET
      window_started_at=CASE WHEN window_started_at<=? THEN excluded.window_started_at ELSE window_started_at END,
      attempts=CASE WHEN window_started_at<=? THEN 1 ELSE attempts+1 END,
      updated_at=excluded.updated_at
    WHERE window_started_at<=? OR attempts<?`)
    .bind(subject, now, now, cutoff, cutoff, cutoff, UNWRAP_IP_MAX).run();
  return result.meta.changes !== 0;
}

/** Retention for the unwrap audit log and the shared per-IP throttle ledger. */
export async function sweepCloudRetention(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cloud_unwrap_log WHERE at<?").bind(now - UNWRAP_LOG_RETENTION_MS),
    env.DB.prepare("DELETE FROM announcement_rate_limits WHERE updated_at<?").bind(now - RATE_LIMIT_RETENTION_MS),
    // The door's notice rows (door.ts) of a home that is deleted, or gone: account and home ids and an opening time are not kept past it.
    env.DB.prepare("DELETE FROM cloud_door_notices WHERE home_id NOT IN (SELECT id FROM cloud_homes WHERE desired_state<>'deleted')"),
  ]);
}

async function unwrap(request: Request, env: Env, id: string) {
  if (!await unwrapIpWithinLimit(request, env)) throw new HTTPError(429, "rate_limited");
  let generation = 0;
  let homeId = id;
  let outcome = "internal_error";
  let known = false;
  try {
    const machine = await env.DB.prepare("SELECT * FROM cloud_machines WHERE id=?").bind(id).first<Machine>();
    if (machine) { homeId = machine.home_id; known = true; }
    const actual = await sha256(bearer(request));
    const expected = machine?.credential_hash ?? "0".repeat(64);
    if (!timingSafeEqual(new TextEncoder().encode(actual), new TextEncoder().encode(expected))
      || !machine || machine.state !== "active" || !machine.credential_hash) {
      throw new HTTPError(401, "unauthorized");
    }
    const input = await body(request, unwrapSchema);
    generation = input.generation;
    if (generation !== machine.generation) throw new HTTPError(409, "stale_generation");
    if (b3Enabled(env)) {
      const home = await env.DB.prepare("SELECT generation,desired_state FROM cloud_homes WHERE id=?")
        .bind(id).first<{ generation: number; desired_state: string }>();
      if (home && (home.generation !== generation
        || !["provisioning", "checking", "ready", "payment_problem"].includes(home.desired_state))) {
        throw new HTTPError(409, "home_fenced");
      }
    }
    // bound_ips is mandatory: an unbound machine, an unparseable binding or
    // an unlisted source IP all fail closed.
    let bound: string[] = [];
    try {
      const parsed = z.array(z.string()).safeParse(JSON.parse(machine.bound_ips ?? "null"));
      if (parsed.success) bound = parsed.data;
    } catch { /* unparseable binding stays empty and fails closed */ }
    if (!bound.includes(request.headers.get("CF-Connecting-IP") ?? "")) {
      throw new HTTPError(403, "forbidden");
    }
    // Astra MAILRETRY-13 P1-4: the keys are read through the machine row this request authenticated, never by home id alone, and the read
    // itself re-proves that authentication: the same row (id, home, control-plane generation, creation), still active, still holding THIS
    // credential. A give-up (credential cleared) or a reopen (the row deleted and a new attempt's machine, credential and keys written)
    // committed since the check above makes the read match nothing: 401, and the replacement attempt's secrets never reach this request.
    // Keys and their machine row are written together and removed together (prepareB3Enrollment, reopenGivenUp), so the keys found here
    // are the ones issued with this credential's machine.
    const authenticated = await env.DB.prepare(`SELECT m.id AS machine_id, k.home_id, k.wrapped_data_key, k.wrapped_bootstrap_secret,
        k.wrapped_volume_key, k.kek_id
      FROM cloud_machines m LEFT JOIN cloud_home_keys k ON k.home_id=m.home_id
      WHERE m.id=? AND m.home_id=? AND m.generation=? AND m.created_at=? AND m.state='active' AND m.credential_hash=?`)
      .bind(machine.id, machine.home_id, machine.generation, machine.created_at, machine.credential_hash)
      .first<{ machine_id: string; home_id: string | null; wrapped_data_key: string | null; wrapped_bootstrap_secret: string | null;
        wrapped_volume_key: string | null; kek_id: string | null }>();
    if (!authenticated) throw new HTTPError(401, "unauthorized");
    const keys: HomeKeys | null = authenticated.home_id === null || authenticated.wrapped_data_key === null
      || authenticated.wrapped_bootstrap_secret === null || authenticated.kek_id === null ? null
      : { wrapped_data_key: authenticated.wrapped_data_key, wrapped_bootstrap_secret: authenticated.wrapped_bootstrap_secret,
        wrapped_volume_key: authenticated.wrapped_volume_key, kek_id: authenticated.kek_id };
    if (!keys || !kekReadable(keys.kek_id) || !keys.wrapped_volume_key) throw new Error("cloud_key_unavailable");
    const wrapper = keyWrapperFor(env);
    const [data, bootstrap, volume] = await Promise.all([
      wrapper.unwrap(homeId, keys.wrapped_data_key), wrapper.unwrap(homeId, keys.wrapped_bootstrap_secret),
      wrapper.unwrap(homeId, keys.wrapped_volume_key),
    ]);
    outcome = "ok";
    return json({ dataKey: base64(data), bootstrapSecret: base64(bootstrap), volumeKey: base64(volume), generation });
  } catch (error) {
    if (error instanceof HTTPError) outcome = error.code;
    throw error;
  } finally {
    const at = Date.now();
    // Only real machines are audited: an unauthenticated caller must not be
    // able to grow the table with arbitrary ids.
    if (known) {
      await env.DB.prepare("INSERT INTO cloud_unwrap_log (home_id,generation,at,source_ip,outcome) VALUES (?,?,?,?,?)")
        .bind(homeId, generation, at, request.headers.get("CF-Connecting-IP"), outcome).run();
    }
    if (b3Enabled(env) && outcome === "ok") {
      // Persist a synthetic alert once per UTC day. This is not a production
      // KMS rate limiter or notification-delivery claim.
      await env.DB.prepare(`INSERT INTO cloud_outbox
        (id,home_id,generation,owner_id,kind,payload,created_at)
        SELECT ?,h.id,h.generation,h.owner_id,'unwrap_alert_required','{"threshold":3}',?
        FROM cloud_homes h WHERE h.id=? AND h.desired_state='ready'
          AND (SELECT COUNT(*) FROM cloud_unwrap_log WHERE home_id=h.id AND outcome='ok' AND at>?)>3
        ON CONFLICT(id) DO NOTHING`)
        .bind(`unwrap-alert:${homeId}:${Math.floor(at / 86_400_000)}`, at, homeId, at - 86_400_000).run();
    }
  }
}

export async function cloudMachineRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return null;
  // The unbound-era create and rotate surfaces exist only where staging opts in.
  const cp0Staging = (env as { CLOUD_CP0_STAGING?: string }).CLOUD_CP0_STAGING === "1";
  if (path === "/v1/machines") return cp0Staging ? create(request, env) : null;
  if (path === "/v1/machines/rewrap-keys") return rewrapKeys(request, env);
  const match = /^\/v1\/machines\/([\w-]{1,128})\/(rotate|retire|owner|enroll|unwrap|backup-password)$/.exec(path);
  if (!match) return null;
  if (match[2] === "rotate") return cp0Staging ? rotate(request, env, match[1]) : null;
  if (match[2] === "retire") return cp0Staging ? retire(request, env, match[1]) : null;
  if (match[2] === "owner") return cp0Staging ? assignOwner(request, env, match[1]) : null;
  if (match[2] === "backup-password") return backupPassword(request, env, match[1]);
  if (match[2] === "enroll") return enroll(request, env, match[1]);
  return unwrap(request, env, match[1]);
}

const rewrapSchema = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict();

/**
 * Admin migration: re-wrap every home key still wrapped under the Worker-secret KEK (kek_id v1) with KMS.
 * Idempotent and resumable: call until `remaining` is 0, then delete the CLOUD_KEK_V1 secret.
 * Each row is swapped only if it is still the exact v1 row that was read, so a concurrent rotate wins.
 */
async function rewrapKeys(request: Request, env: Env) {
  await admin(request, env);
  if (!(env as { AWS_KMS_KEY_ARN?: string }).AWS_KMS_KEY_ARN) throw new HTTPError(409, "kms_not_configured");
  const input = await body(request, rewrapSchema);
  const wrapper = keyWrapperFor(env);
  const rows = await env.DB.prepare("SELECT home_id,wrapped_data_key,wrapped_bootstrap_secret,wrapped_volume_key FROM cloud_home_keys WHERE kek_id='v1' LIMIT ?")
    .bind(input.limit ?? 50).all<{ home_id: string; wrapped_data_key: string; wrapped_bootstrap_secret: string; wrapped_volume_key: string | null }>();
  let rewrapped = 0; let failed = 0;
  for (const row of rows.results) {
    try {
      const re = async (v: string) => wrapper.wrap(row.home_id, await wrapper.unwrap(row.home_id, v));
      const [data, bootstrap, volume] = await Promise.all([
        re(row.wrapped_data_key), re(row.wrapped_bootstrap_secret), row.wrapped_volume_key ? re(row.wrapped_volume_key) : Promise.resolve(null)]);
      const result = await env.DB.prepare(`UPDATE cloud_home_keys SET wrapped_data_key=?,wrapped_bootstrap_secret=?,wrapped_volume_key=?,kek_id=?
        WHERE home_id=? AND kek_id='v1' AND wrapped_data_key=? AND wrapped_bootstrap_secret=? AND wrapped_volume_key IS ?`)
        .bind(data, bootstrap, volume, KEK_KMS, row.home_id, row.wrapped_data_key, row.wrapped_bootstrap_secret, row.wrapped_volume_key).run();
      if (result.meta.changes === 1) rewrapped++; else failed++;
    } catch { failed++; }
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_home_keys WHERE kek_id='v1'").first<{ n: number }>();
  return json({ rewrapped, failed, remaining: left?.n ?? 0 });
}

/**
 * Admin only. The restic repository password for a home, derived from its data key with HKDF so it is never
 * stored: any operator with admin rights (and, in production, KMS access) can recompute it to provision a
 * backup or to restore into a fresh home. Audited like an unwrap.
 */
async function backupPassword(request: Request, env: Env, homeId: string) {
  await admin(request, env);
  const keys = await env.DB.prepare("SELECT * FROM cloud_home_keys WHERE home_id=?").bind(homeId).first<HomeKeys>();
  if (!keys || !kekReadable(keys.kek_id)) throw new HTTPError(404, "not_found");
  const password = await deriveBackupPassword(env, homeId, keys);
  await env.DB.prepare("INSERT INTO cloud_unwrap_log (home_id,generation,at,source_ip,outcome) VALUES (?,?,?,?,?)")
    .bind(homeId, 0, Date.now(), request.headers.get("CF-Connecting-IP"), "backup_password").run();
  return json({ password });
}

/** HKDF restic password for a home (never stored). Shared by the admin endpoint and the live provisioner's backup wiring. */
export async function deriveBackupPassword(env: Env, homeId: string, keys?: HomeKeys | null): Promise<string> {
  const row = keys ?? await env.DB.prepare("SELECT * FROM cloud_home_keys WHERE home_id=?").bind(homeId).first<HomeKeys>();
  if (!row || !kekReadable(row.kek_id)) throw new Error("backup_password_unavailable");
  const data = await keyWrapperFor(env).unwrap(homeId, row.wrapped_data_key);
  const base = await crypto.subtle.importKey("raw", data, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(homeId),
    info: new TextEncoder().encode("murage-backup-v1") }, base, 256);
  return base64(new Uint8Array(bits));
}
