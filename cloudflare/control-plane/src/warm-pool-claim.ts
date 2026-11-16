// SPDX-License-Identifier: AGPL-3.0-or-later
// Warm pool, lane L3: the atomic claim at payment (WARM-POOL-PLAN 4.2), the claim payload (4.3, with the 2026-10-16 provider spike rules) and
// the cloud-config route a claimed server fetches (5.2, 5.4). Nothing here talks to the provider except the quarantine of a fenced row.
import { persistAlert } from "./ops-monitor";
import { provisionerConfig, type ProvisionerConfig } from "./b5-config";
import { hetznerAdapter, type HetznerPoolAdapter, type HostingAdapter } from "./b5-provisioner";
import { base64, keyWrapperFor, type KeyWrapper } from "./key-wrapper";
import { errorResponse } from "./http";
import { sha256 } from "./installations";

export type PoolClass = "starter" | "pro";
/** Starter homes take the starter class; Pro and Max share the pro class (same hardware, the volume differs). Null: no class, no claim. */
export function poolClassFor(plan: string): PoolClass | null {
  return plan === "starter" ? "starter" : plan === "pro" || plan === "max" ? "pro" : null;
}

export interface PoolRow {
  id: string; env: string; class: string; provider: string; server_type: string; arch: string; location: string; image_id: string; image_digest: string;
  state: "warming" | "ready" | "claimed" | "failed" | "retired"; phase: string | null; server_id: string | null; ipv4: string | null;
  secret_hash: string | null; home_id: string | null; resource_generation: number | null;
}
interface DeliveryRow { pool_id: string; home_id: string; resource_generation: number; token_hash: string; payload_wrapped: string | null;
  purged_at: number | null; fetch_count: number }

/** The claim: ONE D1 batch. It takes one `ready` row of the home's class whose image is the CURRENT image of its arch (a stale-image row is never
 *  claimed and never rebuilt: the grabber retires it; none left means the stock ladder), by rung order then oldest ready_at, records
 *  the home's provision choice from that row and marks the row `claimed`, all under changes() guards. Two homes cannot take the same row; a
 *  home cannot claim twice. Any lost race rolls the whole batch back and the caller falls through to the stock ladder (false). */
export async function claimPoolServer(env: Env, config: ProvisionerConfig,
  input: { homeId: string; resourceGeneration: number; plan: string; now: number },
  /** Checks one arch's configured image (verifyImageForUse). An arch whose image fails is dropped from the claim, so the caller takes the ladder. */
  verifyArch: (arch: "x86" | "arm", image: string) => Promise<boolean>): Promise<boolean> {
  const pool = config.pool;
  const cls = poolClassFor(input.plan);
  if (!pool || !cls) return false;
  const control = await env.DB.prepare("SELECT claims FROM warm_pool_control WHERE id='pool'").first<{ claims: number }>();
  if (control?.claims !== 1) return false;
  const imageX = config.images.hetzner.x86 && await verifyArch("x86", config.images.hetzner.x86) ? config.images.hetzner.x86 : null;
  const imageA = config.images.hetzner.arm && await verifyArch("arm", config.images.hetzner.arm) ? config.images.hetzner.arm : null;
  const rungs = pool.classes[cls].rungs.filter((r) => (r.arch === "x86" ? imageX : imageA) !== null);
  if (!rungs.length) return false;
  const rank = `CASE ${rungs.map(() => "WHEN p.server_type=? AND p.arch=? THEN ?").join(" ")} END`;
  const rankBinds = rungs.flatMap((r, i) => [r.serverType, r.arch, i]);
  const g = crypto.randomUUID();
  const mine = [input.homeId, input.resourceGeneration];
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO provision_choices (home_id,resource_generation,provider,server_type,location,arch,image,tried,created_at,pool_id)
        SELECT ?,?,s.provider,s.server_type,s.location,s.arch,CASE s.arch WHEN 'x86' THEN ? ELSE ? END,
          json_array(json_object('provider',s.provider,'serverType',s.server_type,'arch',s.arch,'result','pool_claim')),?,s.id
        FROM (SELECT p.*,${rank} AS rk FROM warm_pool p
          WHERE p.env=? AND p.class=? AND p.state='ready' AND p.image_id=CASE p.arch WHEN 'x86' THEN ? ELSE ? END AND p.provider='hetzner' AND p.server_id IS NOT NULL
            AND (SELECT claims FROM warm_pool_control WHERE id='pool')=1) s
        WHERE s.rk IS NOT NULL ORDER BY s.rk,s.ready_at,s.id LIMIT 1
        ON CONFLICT(home_id,resource_generation) DO NOTHING`)
        .bind(...mine, imageX, imageA, input.now, ...rankBinds, pool.env, cls, imageX, imageA),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(`${g}:choice`),
      env.DB.prepare(`UPDATE warm_pool SET state='claimed',home_id=?,resource_generation=?,claimed_at=?
        WHERE id=(SELECT pool_id FROM provision_choices WHERE home_id=? AND resource_generation=?) AND state='ready'`)
        .bind(...mine, input.now, ...mine),
      env.DB.prepare("INSERT INTO cloud_write_guards VALUES (?,changes())").bind(`${g}:pool`),
      env.DB.prepare(`INSERT INTO warm_pool_events (pool_id,at,kind,detail) SELECT pool_id,?,'claimed',? FROM provision_choices WHERE home_id=? AND resource_generation=?`)
        .bind(input.now, input.homeId, ...mine),
      env.DB.prepare("DELETE FROM cloud_write_guards WHERE id IN (?,?)").bind(`${g}:choice`, `${g}:pool`),
    ]);
    return true;
  } catch (error) {
    // A lost race (no ready row, a choice already recorded, the row taken meanwhile) trips a guard or a unique index: the ladder takes over.
    if (error instanceof Error && /constraint/i.test(error.message)) {
      await env.DB.prepare("DELETE FROM cloud_write_guards WHERE id IN (?,?)").bind(`${g}:choice`, `${g}:pool`).run().catch(() => undefined);
      return false;
    }
    throw error;
  }
}

/** The relabel marker: `relabeling@<ms>`. It only says "the relabel was started", so a retry that finds the server by its home labels finishes the claim. */
export const relabelPhase = (at: number) => `relabeling@${at}`;
const GONE_HOME = `EXISTS (SELECT 1 FROM cloud_homes h WHERE h.id=p.home_id AND (h.resource_generation<>p.resource_generation
  OR h.desired_state IN ('failed','deleting','deleted')))`;

/** Give-up of a claim: a `claimed` row whose home no longer wants it (given up, deleted, or moved on to another resource generation). A claimed
 *  pool server is NEVER released back to `ready`: the row becomes `failed` (`claim_abandoned`) and the undelivered payload is dropped. The server is
 *  destroyed by whoever owns it: with this home's labels B3 cleanup finds it by label; still with pool labels the grabber's cleanup deletes the
 *  failed row's server by id (a relabel PUT that lands late then fails against a deleted server). One statement, no provider call, no LIMIT: every
 *  abandoned row is resolved in the pass, so a resolved row can never hold a slot. Returns the number of rows failed. */
export async function failAbandonedClaims(env: Env, now: number): Promise<number> {
  const failed = await env.DB.prepare(`UPDATE warm_pool AS p SET state='failed',fail_reason='claim_abandoned'
    WHERE p.state='claimed' AND p.home_id IS NOT NULL AND ${GONE_HOME} RETURNING id,home_id`).all<{ id: string; home_id: string }>();
  if (!failed.results.length) return 0;
  await env.DB.batch(failed.results.flatMap((r) => [
    env.DB.prepare("DELETE FROM warm_pool_deliveries WHERE pool_id=?").bind(r.id),
    env.DB.prepare("INSERT INTO warm_pool_events (pool_id,at,kind,detail) VALUES (?,?,'claim_abandoned',?)").bind(r.id, now, r.home_id),
  ]));
  return failed.results.length;
}

/** Delivery hygiene, run by the grabber's maintenance stage every minute. Two idempotent statements:
 *   1. a claimed row whose delivery token is USED no longer needs its secret: secret_hash=NULL (the route answers the harmless config to the
 *      server's own IP whatever the secret, and 404 to everyone else);
 *   2. a delivery whose token is used or expired is dropped: payload_wrapped=NULL, purged_at set (the route answers the harmless config).
 *  The row and its token/intents are never touched otherwise. Returns the number of secrets revoked and payloads purged. */
export async function purgeUsedDeliveries(env: Env, now: number): Promise<{ revoked: number; purged: number }> {
  const [revoked, purged] = await env.DB.batch([
    env.DB.prepare(`UPDATE warm_pool SET secret_hash=NULL WHERE state='claimed' AND secret_hash IS NOT NULL AND EXISTS
      (SELECT 1 FROM warm_pool_deliveries d JOIN cloud_enrollment_tokens t ON t.hash=d.token_hash AND t.machine_id=d.home_id
        WHERE d.pool_id=warm_pool.id AND d.home_id IS warm_pool.home_id AND d.resource_generation IS warm_pool.resource_generation AND t.used_at IS NOT NULL)`),
    env.DB.prepare(`UPDATE warm_pool_deliveries SET payload_wrapped=NULL,purged_at=? WHERE payload_wrapped IS NOT NULL AND EXISTS
      (SELECT 1 FROM cloud_enrollment_tokens t WHERE t.hash=warm_pool_deliveries.token_hash AND t.machine_id=warm_pool_deliveries.home_id
        AND (t.used_at IS NOT NULL OR t.expires_at<=?))`).bind(now, now),
  ]);
  return { revoked: revoked.meta.changes ?? 0, purged: purged.meta.changes ?? 0 };
}

/** The delivery for a claimed row: the home's identity user-data exactly as prepareServer would have sent it, plus two extra files (spike
 *  2026-10-16: write_files lands in cloud-init's init stage, before murage-enroll, and runcmd is unreliable on this image).
 *   - /var/lib/cloud/instance/user-data.txt is overwritten with that user-data, so murage-enroll reads the identity as it does today;
 *   - /etc/murage-home/claim-user-data (0600) carries the same for the future home-side change.
 *  The user-data's own write_files (volume.json, backup, ops ssh) stay in the document and cloud-init applies them as always. */
export function claimCloudConfig(userData: string): string {
  const b64 = base64(new TextEncoder().encode(userData));
  const file = (path: string) => [`  - path: ${path}`, "    permissions: '0600'", "    owner: root:root", "    encoding: b64", `    content: ${b64}`, ""].join("\n");
  const extra = file("/var/lib/cloud/instance/user-data.txt") + file("/etc/murage-home/claim-user-data");
  if (!/^write_files:\n/m.test(userData)) throw new Error("pool_payload_shape");
  return userData.replace(/^write_files:\n/m, () => `write_files:\n${extra}`);
}
/** Served to the claimed server's own IP once its token is used (a reboot of a running home): changes nothing. */
export const HARMLESS_CONFIG = "#cloud-config\n{}\n";
/** Served to an anomaly. bootcmd runs in cloud-init's init stage (cloud-final can be dropped by the image's systemd ordering cycle). */
export const POWEROFF_CONFIG = ["#cloud-config", "power_state:", "  mode: poweroff", "  message: pool server fenced", "  timeout: 5", "  condition: true",
  "bootcmd:", "  - [sh, -c, \"systemctl poweroff --no-block || poweroff -f\"]", ""].join("\n");

const textResponse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
const notFound = () => errorResponse(404, "not_found");
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The payload at rest: ENVELOPE encryption. KMS Encrypt takes at most 4096 bytes and a cloud-config with backup credentials is larger, so a
 *  random AES-256-GCM data key encrypts the payload and the key wrapper wraps only that 32-byte key. Stored as `env1:<json>`. */
export async function sealPayload(wrapper: KeyWrapper, homeId: string, text: string): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(homeId), tagLength: 128 }, key, new TextEncoder().encode(text)));
  return `env1:${JSON.stringify({ k: await wrapper.wrap(homeId, raw), iv: base64(iv), c: base64(ct) })}`;
}
export async function openPayload(wrapper: KeyWrapper, homeId: string, sealed: string): Promise<string> {
  if (!sealed.startsWith("env1:")) throw new Error("pool_payload_format");
  const { k, iv, c } = JSON.parse(sealed.slice(5)) as { k: string; iv: string; c: string };
  const bytes = (v: string) => Uint8Array.from(atob(v), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", await wrapper.unwrap(homeId, k), "AES-GCM", false, ["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: new TextEncoder().encode(homeId), tagLength: 128 }, key, bytes(c)));
}

export interface PoolRouteDeps { adapter?: (HostingAdapter & HetznerPoolAdapter) | null; now?: () => number; wrapper?: KeyWrapper }
const ROUTE = /^\/v1\/pool\/([\w-]{1,128})\/cloud-config\/([A-Za-z0-9_-]{16,128})$/;
/** True for any path of this feature: the platform's Server-Timing (D1 round trips) is withheld there. */
export const isPoolPath = (pathname: string) => pathname.startsWith("/v1/pool/");
/** The path of this route as it may be logged: the secret segment is never part of it. */
export const redactPoolPath = (pathname: string) => pathname.replace(/^(\/v1\/pool\/[\w-]{1,128}\/cloud-config\/).*$/, "$1[redacted]");

export function defaultPoolAdapter(env: Env): (HostingAdapter & HetznerPoolAdapter) | null {
  try { return env.HCLOUD_TOKEN ? hetznerAdapter(env.HCLOUD_TOKEN, provisionerConfig(env)) : null; } catch { return null; }
}

/** GET /v1/pool/:id/cloud-config/:secret. The secret is in the path because cloud-init's #include cannot send headers; it is bound to one IP
 *  and the enrollment token behind it is single use. This handler never logs the URL, but the platform's own invocation log does (log access
 *  is Cloudflare account access), so a logged secret must be harmless to replay:
 *   - claimed, token unused, right secret from the server's IP: the sealed delivery (re-fetchable from that IP until the token is used);
 *   - claimed, token used: a harmless empty config to the server's own IP (a customer's home rebooting is never powered off); 404 to others;
 *   - the right secret from ANY OTHER IP, or a wrong secret: 404 and (for a known row) a high alert. NEVER a quarantine or power-off, so a
 *     replayed URL cannot hurt a customer's server;
 *   - quarantine + power-off + failed row ONLY for a request from the row's OWN IP while the row is still unclaimed (warming/ready).
 *  Every request does the same D1 reads (row, delivery, token, intent) whatever the id, secret or state, and answers 404 identically. */
export async function poolCloudConfigRoute(request: Request, env: Env, deps: PoolRouteDeps = {}): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const match = ROUTE.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, poolId, secret] = match;
  const now = (deps.now ?? Date.now)();
  const callerIp = request.headers.get("CF-Connecting-IP") ?? "";
  const row = await env.DB.prepare("SELECT * FROM warm_pool WHERE id=?").bind(poolId).first<PoolRow>();
  const delivery = await env.DB.prepare("SELECT * FROM warm_pool_deliveries WHERE pool_id=? AND home_id IS ? AND resource_generation IS ?")
    .bind(poolId, row?.home_id ?? null, row?.resource_generation ?? null).first<DeliveryRow>();
  const token = await env.DB.prepare("SELECT used_at,expires_at FROM cloud_enrollment_tokens WHERE hash=? AND machine_id=?")
    .bind(delivery?.token_hash ?? "", delivery?.home_id ?? "").first<{ used_at: number | null; expires_at: number }>();
  const intent = await env.DB.prepare(`SELECT 1 AS x FROM cloud_provision_intents WHERE home_id=? AND resource_generation=? AND token_hash=? AND state IN ('pending','bound')`)
    .bind(delivery?.home_id ?? "", delivery?.resource_generation ?? -1, delivery?.token_hash ?? "").first();
  const secretOk = row?.secret_hash != null && sameHash(await sha256(secret), row.secret_hash);
  if (!row) return notFound();
  const fromServer = row.ipv4 !== null && callerIp === row.ipv4;
  const adapter = deps.adapter === undefined ? defaultPoolAdapter(env) : deps.adapter;
  const alert = async (reason: string) => {
    await persistAlert(env, { homeId: row.home_id ?? row.id, kind: "pool.secret_misuse", severity: "high", detail: `pool ${row.id}: ${reason}` }, now).catch(() => false);
    await env.DB.prepare("INSERT INTO warm_pool_events (pool_id,at,kind,detail) VALUES (?,?,?,?)").bind(row.id, now, "misuse", reason).run().catch(() => undefined);
    return notFound();
  };

  if (row.state === "warming" || row.state === "ready") {
    if (fromServer) { // the server itself asked while unclaimed: the one case that fences
      await fencePoolRow(env, row, "cloud_config_fetched_while_unclaimed", false, adapter, now);
      return textResponse(POWEROFF_CONFIG);
    }
    return secretOk ? alert("right_secret_from_other_ip_unclaimed") : notFound();
  }
  if (row.state === "failed" || row.state === "retired") return fromServer ? textResponse(POWEROFF_CONFIG) : notFound();

  // claimed
  if (token && token.used_at !== null) return fromServer ? textResponse(HARMLESS_CONFIG) : notFound();
  if (!fromServer) return secretOk ? alert("right_secret_from_wrong_ip") : notFound();
  if (!secretOk) return alert("wrong_secret_from_server_ip");
  // Right secret from the server's own IP. No delivery stored yet: 404, and cloud-init's retry succeeds once it is.
  if (!delivery || !token) return notFound();
  // Deliver only while a live pending or bound intent holds this token; otherwise there is nothing to hand over.
  if (delivery.payload_wrapped === null || delivery.purged_at !== null || token.expires_at <= now || !intent) return textResponse(HARMLESS_CONFIG);
  try {
    const userData = await openPayload(deps.wrapper ?? keyWrapperFor(env), delivery.home_id, delivery.payload_wrapped);
    const config = claimCloudConfig(userData);
    await env.DB.prepare("UPDATE warm_pool_deliveries SET fetch_count=fetch_count+1,first_fetched_at=COALESCE(first_fetched_at,?) WHERE pool_id=?").bind(now, row.id).run();
    return textResponse(config);
  } catch {
    console.error(JSON.stringify({ message: "pool cloud-config delivery failed", path: redactPoolPath(new URL(request.url).pathname) }));
    return errorResponse(503, "pool_delivery_unavailable");
  }
}

/** Anomaly: the row becomes `failed` (guarded by id, state AND the owner the caller read: a stale caller cannot fence a row now owned by
 *  another home), the event and a high alert are recorded, and the server is quarantined and powered off (best effort). Returns whether this
 *  call changed the row; when it did not, nothing else happens. The server is destroyed by the grabber 24 hours later. */
export async function fencePoolRow(env: Env, row: PoolRow, reason: string, revokeSecret: boolean,
  adapter: (HostingAdapter & HetznerPoolAdapter) | null, now: number, guard: { sql: string; binds: unknown[] } = { sql: "", binds: [] }): Promise<boolean> {
  // `guard`: an extra condition on the row write itself (the provisioning attempt's lease fence: a stale attempt fences nothing).
  const [update] = await env.DB.batch([
    env.DB.prepare(`UPDATE warm_pool SET state='failed',fail_reason=?,secret_hash=CASE WHEN ? THEN NULL ELSE secret_hash END
      WHERE id=? AND state=? AND home_id IS ? AND resource_generation IS ?${guard.sql}`).bind(reason, revokeSecret ? 1 : 0, row.id, row.state, row.home_id, row.resource_generation, ...guard.binds),
    env.DB.prepare(`INSERT INTO warm_pool_events (pool_id,at,kind,detail) SELECT ?,?,'fenced',? WHERE EXISTS
      (SELECT 1 FROM warm_pool WHERE id=? AND state='failed' AND fail_reason=?)`).bind(row.id, now, reason, row.id, reason),
  ]);
  if (update.meta.changes !== 1) return false;
  await persistAlert(env, { homeId: row.home_id ?? row.id, kind: "pool.anomaly", severity: "high", detail: `pool ${row.id} fenced: ${reason}` }, now)
    .catch(() => false);
  if (adapter && row.server_id) {
    try { await adapter.quarantine(row.server_id); } catch { /* the power-off below and the config answer still apply */ }
    try { await adapter.powerOff(row.server_id); } catch { /* idem */ }
  }
  return true;
}
