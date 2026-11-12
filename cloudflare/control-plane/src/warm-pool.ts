// SPDX-License-Identifier: AGPL-3.0-or-later
// Warm pool grabber (WARM-POOL-PLAN section 3): keeps a stock of pre-created, powered-off provider servers. Runs on the 1-minute cron.
// An unclaimed pool server never boots, holds no customer data, and is found again only by its labels (murage/role=pool, murage/env, murage/pool).
import { assertHetznerImagesApproved } from "./env-isolation";
import { z } from "zod";
import { provisionerConfig, type PoolConfig, type ProvisionerConfig } from "./b5-config";
import { diskFits, hetznerAdapter, HostError, raiseImageTooBig, type HetznerPoolAdapter, type HostingAdapter, type PoolServer, type ServerTypeInfo } from "./b5-provisioner";
import { b3Config, b3Enabled } from "./b3-config";
import { controlPlaneOriginFor, fastProvision, type B3Dependencies } from "./b3-control";
import { poolFleetLabels } from "./fleet-labels";
import { failAbandonedClaims, purgeUsedDeliveries } from "./warm-pool-claim";
import { PROVIDER_REQUEST_LIFETIME_MS } from "./dispatch-ledger";
import { persistAlert, resolveAlertStatement } from "./ops-monitor";
import { assertNoProdSshKeys, ImageRefused, verifyImageForUse, type VerifiedImage, type VerifyDeps } from "./image-signature";

export type PoolClass = "starter" | "pro";
export type GrabberMode = "off" | "observe" | "on" | "drain";
/** What the grabber needs from the provider: the pool adapter methods plus the destroy and quarantine of the shared adapter. */
export type PoolHost = HetznerPoolAdapter & Pick<HostingAdapter, "quarantine">;
export interface GrabberDeps { adapter?: PoolHost | null; holder?: string; deadline?: number; /** Tests: the signature check's fetch, trust lists and build environment. */ verify?: VerifyDeps }
export interface GrabberResult {
  mode: GrabberMode | "no_pool_config" | "leased";
  created: number; refused: number; ready: number; warming: number; idleCents: number; errors: string[];
}

export const LEASE_MS = 55_000;
export const STOCK_HEARTBEAT_MS = 10 * 60_000;
export const BELOW_RED_AFTER_MS = 10 * 60_000;
export const CREATE_BACKOFF_MS = 15 * 60_000;
export const ANOMALY_HOLD_MS = 24 * 3_600_000;
export const RETENTION_MS = 14 * 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CREATE_LOST_SETTLE_MS = DAY_MS;
const CREATE_TIMEOUT_MS = 20_000;
// Per-call caps are small enough that a cleanup call fits the minute tick's 30 s grabber budget; every guard below derives from ctx.deadline.
const MUTATE_MS = 8_000;
const READ_MS = 8_000;
const MIN_CALL_MS = 2_000;
const RETIRE_PER_TICK = 100;
/** provider bills the primary IPv4 separately (net EUR 0.50 per month); the API's server_types answer does not carry it, so it is a constant. */
export const IPV4_MONTHLY_CENTS = 50;
const ACTIONS_PER_TICK = 200; // bounded D1 work per tick (the invocation limit is 1,000 queries)
const ANOMALIES_PER_TICK = 25;
const STALE_RETIRE_PER_TICK = 25;
/** A row is "current" when its image is the configured image for its arch (the claim takes only current-image servers and never rebuilds). */
const CURRENT_IMAGE_SQL = "((arch='x86' AND image_id=?) OR (arch='arm' AND image_id=?))";
const currentImageBinds = (config: ProvisionerConfig) => [config.images.hetzner.x86 ?? "", config.images.hetzner.arm ?? ""];
const ORPHANS_PER_TICK = 20;
const DESTROYS_PER_TICK = 50;
const NAME_PREFIX = { staging: "mcq-pool-stg-", production: "mcq-pool-prd-" } as const;
const CLASSES: PoolClass[] = ["pro", "starter"]; // Pro first: it is the scarcer hardware.

interface Row {
  id: string; env: string; class: PoolClass; provider: string; server_type: string; arch: string; location: string; image_id: string; image_digest: string;
  state: "warming" | "ready" | "claimed" | "failed" | "retired"; phase: string | null; server_id: string | null; ipv4: string | null;
  create_call_id: string; monthly_cents: number; vcpus: number; created_at: number; last_verified_at: number | null; fail_reason: string | null; retired_at: number | null;
}
interface Usage { vcpu: number; primaryIps: number }
type Target = { target: number; red: number; max: number };

const overrideSchema = z.object({
  starter: z.union([z.number().int().min(0).max(1000), z.object({ target: z.number().int().min(0).max(1000), red: z.number().int().min(0).max(1000), max: z.number().int().min(0).max(1000) }).partial().strict()]).optional(),
  pro: z.union([z.number().int().min(0).max(1000), z.object({ target: z.number().int().min(0).max(1000), red: z.number().int().min(0).max(1000), max: z.number().int().min(0).max(1000) }).partial().strict()]).optional(),
}).strict();

// ---- small helpers -------------------------------------------------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function kvGet<T>(env: Env, key: string): Promise<T | null> {
  const r = await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key=?").bind(key).first<{ value: string }>();
  if (!r) return null;
  try { return JSON.parse(r.value) as T; } catch { return null; }
}
async function kvSet(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, JSON.stringify(value)).run();
}
async function kvDel(env: Env, key: string): Promise<void> { await env.DB.prepare("DELETE FROM cloud_ops_state WHERE key=?").bind(key).run(); }

async function event(env: Env, poolId: string | null, kind: string, detail: string | null, now: number): Promise<void> {
  await env.DB.prepare("INSERT INTO warm_pool_events (pool_id,at,kind,detail) VALUES (?,?,?,?)").bind(poolId, now, kind, detail ? detail.slice(0, 500) : null).run();
}
async function raise(env: Env, homeId: string, kind: string, severity: string, detail: string, now: number): Promise<void> {
  await persistAlert(env, { homeId, kind, severity, detail }, now);
}
async function resolve(env: Env, homeId: string, kind: string, now: number): Promise<void> { await resolveAlertStatement(env.DB, homeId, kind, now).run(); }

function targetsFor(config: PoolConfig, override: unknown): Record<PoolClass, Target> {
  const out = {} as Record<PoolClass, Target>;
  const parsed = overrideSchema.safeParse(override ?? {});
  for (const c of CLASSES) {
    const base = config.classes[c];
    const o = parsed.success ? parsed.data[c] : undefined;
    const t: Target = typeof o === "number" ? { target: o, red: base.red, max: base.max } : { target: o?.target ?? base.target, red: o?.red ?? base.red, max: o?.max ?? base.max };
    t.red = Math.min(t.red, t.target); t.max = Math.max(t.max, t.target);
    out[c] = t;
  }
  return out;
}
function imageDigestFor(env: Env): string {
  try { return b3Enabled(env) ? b3Config(env).imageDigest : "unconfigured"; } catch { return "unconfigured"; }
}
const isStatus = (e: unknown, ...codes: number[]) => e instanceof HostError && codes.includes(e.status);
const errCode = (e: unknown) => (e instanceof HostError ? e.code : e instanceof Error ? e.message : "error").slice(0, 80);

// ---- the tick --------------------------------------------------------------------------------------------------------------------------

/** One grabber tick (plan 3.2). Never throws: every stage is isolated and its failure is returned in `errors`. */
export async function runGrabber(env: Env, now: number = Date.now(), deps: GrabberDeps = {}): Promise<GrabberResult> {
  const result: GrabberResult = { mode: "off", created: 0, refused: 0, ready: 0, warming: 0, idleCents: 0, errors: [] };
  let config: ProvisionerConfig;
  try { config = provisionerConfig(env); } catch { result.errors.push("config_invalid"); return result; }
  const pool = config.pool;
  if (!pool) return { ...result, mode: "no_pool_config" };
  // The deadline always sits inside the lease, so a tick can never still be mutating when the next minute's grabber takes the lease.
  const deadline = Math.min(deps.deadline ?? Date.now() + 50_000, Date.now() + LEASE_MS - 5_000);

  // 1. Lease.
  const holder = deps.holder ?? crypto.randomUUID();
  const leased = await env.DB.prepare("UPDATE warm_pool_control SET lease_holder=?,lease_until=? WHERE id='pool' AND (lease_until IS NULL OR lease_until<?)")
    .bind(holder, now + LEASE_MS, now).run();
  if (leased.meta.changes !== 1) return { ...result, mode: "leased" };

  // 2. Mode.
  const control = await env.DB.prepare("SELECT grabber,targets_override FROM warm_pool_control WHERE id='pool'").first<{ grabber: GrabberMode; targets_override: string | null }>();
  const mode = control?.grabber ?? "off";
  result.mode = mode;
  if (mode === "off") return result;
  const adapter = deps.adapter !== undefined ? deps.adapter : env.HCLOUD_TOKEN ? hetznerAdapter(env.HCLOUD_TOKEN, { ...config, quarantineFirewallId: config.quarantineFirewallId }) : null;
  if (!adapter) { result.errors.push("provider_unconfigured"); return result; }
  const ctx: Ctx = { env, pool, config, adapter, now, deadline, verify: deps.verify, result, usage: null, budget: { actions: ACTIONS_PER_TICK, anomalies: ANOMALIES_PER_TICK } };
  const stage = async (name: string, work: () => Promise<void>) => {
    if (Date.now() > deadline) { result.errors.push(`${name}:deadline`); return; }
    try { await work(); } catch (e) { result.errors.push(`${name}:${errCode(e)}`); await event(env, null, "stage_failed", `${name}:${errCode(e)}`, now).catch(() => {}); }
  };

  // 3. Stock sample.
  let types: ServerTypeInfo[] | null = null;
  await stage("stock", async () => { types = await sampleStock(ctx); });
  if (mode === "observe") return finish(ctx);

  // 4. Reconcile the provider view.
  let listing: PoolServer[] | null = null;
  await stage("reconcile", async () => { listing = await reconcile(ctx); });

  if (mode === "drain") {
    await stage("drain", async () => {
      await env.DB.prepare("UPDATE warm_pool SET state='retired',retire_reason='drain',retired_at=?,secret_hash=NULL WHERE state IN ('ready','warming') AND env=? AND server_id IS NOT NULL")
        .bind(now, pool.env).run();
    });
    if (listing) await stage("destroy", () => destroyPass(ctx));
    return finish(ctx);
  }

  // Cleanup first, so it fits the grabber's own budget whatever the creates take, and its freed spend is visible to the creates.
  if (listing) await stage("destroy", () => destroyPass(ctx));

  // 5-7. Usage and budget, need, creates.
  if (listing && types) {
    await stage("usage", async () => { ctx.usage = await usageNow(ctx); });
    await stage("create", async () => {
      // G3: with the real provider credential, every configured image must be approved for this environment before any server is created.
      if (deps.adapter === undefined) await assertHetznerImagesApproved(env, config, env.HCLOUD_TOKEN);
      await createPass(ctx, types!, ctx.usage);
    });
  }

  // 8. Over target.
  await stage("over_target", () => overTarget(ctx, targetsFor(pool, parseJson(control?.targets_override))));

  // 9. Maintenance and alerts.
  await stage("maintenance", () => maintenance(ctx));
  await stage("alerts", () => alerts(ctx, targetsFor(pool, parseJson(control?.targets_override))));
  return finish(ctx);
}

type Ctx = { verify?: VerifyDeps; env: Env; pool: PoolConfig; config: ProvisionerConfig; adapter: PoolHost; now: number; deadline: number; result: GrabberResult; usage: Usage | null; budget: { actions: number; anomalies: number } };
/** No provider mutation may START unless it can finish (its own timeout) before the deadline, which is itself inside the lease. */
const mutationOk = (ctx: Ctx, ms: number) => Date.now() + ms <= ctx.deadline;
/** Every provider call is capped to finish by the deadline (which sits inside the lease): its timeout is min(cap, time left), and it does not start with under MIN_CALL_MS left. */
function boundedCall<T>(ctx: Ctx, cap: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ms = Math.min(cap, ctx.deadline - Date.now());
  if (ms < MIN_CALL_MS) return Promise.reject(new Error("deadline"));
  return bounded(ms, work);
}
function bounded<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error("provider_timeout")); }, ms); });
  return Promise.race([work(ac.signal), timeout]).finally(() => clearTimeout(timer));
}

function parseJson(text: string | null | undefined): unknown { if (!text) return null; try { return JSON.parse(text); } catch { return null; } }

async function finish(ctx: Ctx): Promise<GrabberResult> {
  const rows = await ctx.env.DB.prepare("SELECT state,COUNT(*) AS n,COALESCE(SUM(monthly_cents),0) AS cents FROM warm_pool WHERE env=? AND state IN ('warming','ready') GROUP BY state")
    .bind(ctx.pool.env).all<{ state: string; n: number; cents: number }>();
  for (const r of rows.results ?? []) { if (r.state === "ready") ctx.result.ready = r.n; else ctx.result.warming = r.n; ctx.result.idleCents += r.cents; }
  console.log(JSON.stringify({ message: "pool_tick", mode: ctx.result.mode, created: ctx.result.created, refused: ctx.result.refused, ready: ctx.result.ready,
    idleEur: ctx.result.idleCents / 100, errors: ctx.result.errors.length }));
  return ctx.result;
}

// ---- 3. stock --------------------------------------------------------------------------------------------------------------------------

function rungTypes(pool: PoolConfig): Set<string> {
  return new Set(CLASSES.flatMap((c) => pool.classes[c].rungs.map((r) => r.serverType)));
}
async function sampleStock(ctx: Ctx): Promise<ServerTypeInfo[]> {
  const { env, pool, adapter, now } = ctx;
  const all = await boundedCall(ctx, READ_MS, (signal) => adapter.serverTypes(signal));
  const wanted = rungTypes(pool);
  const mine = all.filter((t) => wanted.has(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  const sig = JSON.stringify(mine.map((t) => [t.name, Object.entries(t.locations).filter(([, l]) => l.available).map(([n]) => n).sort()]));
  const last = await kvGet<{ at: number; sig: string }>(env, "pool.stock_last");
  if (!last || last.sig !== sig || now - last.at >= STOCK_HEARTBEAT_MS) {
    const stmts = mine.map((t) => env.DB.prepare("INSERT OR REPLACE INTO warm_pool_stock (sampled_at,provider,server_type,locations) VALUES (?,?,?,?)")
      .bind(now, "hetzner", t.name, JSON.stringify(Object.entries(t.locations).filter(([, l]) => l.available).map(([n]) => n).sort())));
    if (stmts.length) await env.DB.batch(stmts);
    await kvSet(env, "pool.stock_last", { at: now, sig });
  }
  return all;
}

// ---- 4. reconcile ----------------------------------------------------------------------------------------------------------------------
// IDENTITY RULE. A row that has a server_id acts on the provider server with that id and on no other; labels never pick a server for it.
// Labels are used only to ADOPT a row that has no server_id yet (a create whose answer was lost). Before ANY mutation of a server it is read by id and must
// still be a pool server of this env, labelled for this very row, and not a home. Otherwise: alert only.

/** Why this server cannot be the row's pool server, or null when it can. */
function notOurs(ctx: Ctx, row: Row, s: PoolServer): string | null {
  const l = s.labels;
  if (l["murage/role"] !== "pool") return `role=${l["murage/role"] ?? "none"}`;
  if (l["murage/env"] !== ctx.pool.env) return `env=${l["murage/env"] ?? "none"}`;
  if (l["murage/pool"] !== row.id) return `pool=${l["murage/pool"] ?? "none"}`;
  if (l["murage/home"] !== undefined) return "home";
  return null;
}
async function getById(ctx: Ctx, id: string): Promise<PoolServer | null> {
  try { return await boundedCall(ctx, READ_MS, (signal) => ctx.adapter.getServerDetail(id, signal)); } catch (e) { if (isStatus(e, 404)) return null; throw e; }
}

/** Alert only. The row leaves the stock (a database change: it can no longer be claimed or counted as idle spend) but keeps its server_id; the server is never touched. */
async function foreign(ctx: Ctx, row: Row, serverId: string, why: string): Promise<void> {
  const { env, now } = ctx;
  const moved = await env.DB.prepare(`UPDATE warm_pool SET state='failed',phase=NULL,fail_reason=?,retired_at=COALESCE(retired_at,?),secret_hash=NULL
      WHERE id=? AND state IN ('warming','ready','retired','failed') AND destroyed_at IS NULL AND COALESCE(fail_reason,'') NOT LIKE 'foreign:%'`)
    .bind(`foreign:${why}`, now, row.id).run();
  if (moved.meta.changes === 1) {
    await event(env, row.id, "foreign_server", `${serverId} ${why}`, now);
    await raise(env, "pool", "pool.anomaly", "high", `pool row ${row.id} points at server ${serverId} that is not its pool server (${why}); the server was left alone`, now);
  }
}
async function conflict(ctx: Ctx, s: PoolServer, detail: string): Promise<void> {
  await event(ctx.env, null, "label_conflict", `${s.id} ${detail}`, ctx.now);
  await raise(ctx.env, "pool", "pool.anomaly", "high", `server ${s.id}: ${detail}; it was left alone`, ctx.now);
}

/** Fences and powers off the row's own server (by server_id) only after: the server read by id is still ours, and our guarded row update affected exactly one row. */
async function quarantine(ctx: Ctx, row: Row, kind: string, refence = false): Promise<void> {
  const { env, adapter, now } = ctx;
  const id = row.server_id;
  if (!id) return;
  const detail = await getById(ctx, id);
  if (!detail) return; // gone: the not-listed pass settles it
  const bad = notOurs(ctx, row, detail);
  if (bad) { await foreign(ctx, row, id, bad); return; }
  if (!refence) {
    const moved = await env.DB.prepare("UPDATE warm_pool SET state='failed',phase=NULL,fail_reason=?,retired_at=?,secret_hash=NULL WHERE id=? AND server_id=? AND state IN ('warming','ready')")
      .bind(`anomaly:${kind}`, now, row.id, id).run();
    if (moved.meta.changes !== 1) return; // a claim (or a retire) won: the server is no longer ours to touch
    await event(env, row.id, "anomaly", kind, now);
    await raise(env, "pool", "pool.anomaly", "high", `pool server ${row.id} (${row.server_type}/${row.location}): ${kind}. Fenced and powered off; destroyed after 24 h for review.`, now);
  } else {
    const same = await env.DB.prepare("UPDATE warm_pool SET fail_reason=fail_reason WHERE id=? AND server_id=? AND state='failed' AND destroyed_at IS NULL").bind(row.id, id).run();
    if (same.meta.changes !== 1) return;
  }
  if (!mutationOk(ctx, MUTATE_MS)) return;
  try { await boundedCall(ctx, MUTATE_MS, (signal) => adapter.quarantine(id, signal)); } catch (e) { await event(env, row.id, "quarantine_failed", errCode(e), now); }
  if (!mutationOk(ctx, MUTATE_MS)) return;
  try { await boundedCall(ctx, MUTATE_MS, (signal) => adapter.powerOff(id, signal)); } catch (e) { await event(env, row.id, "power_off_failed", errCode(e), now); }
}

const CHUNK = 90;
async function reconcile(ctx: Ctx): Promise<PoolServer[]> {
  const { env, pool, adapter, now, budget } = ctx;
  const prefix = NAME_PREFIX[pool.env];
  const servers = await boundedCall(ctx, READ_MS, (signal) => adapter.listByLabel(`murage/role=pool,murage/env=${pool.env}`, signal));
  const rows = (await env.DB.prepare("SELECT * FROM warm_pool WHERE env=? AND destroyed_at IS NULL").bind(pool.env).all<Row>()).results ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byCall = new Map(rows.map((r) => [r.create_call_id, r]));
  const bySid = new Map(rows.filter((r) => r.server_id).map((r) => [r.server_id!, r]));
  const seen = new Set<string>();
  const adoptedNow = new Set<string>();
  const stmts: D1PreparedStatement[] = [];
  const verify: string[] = [];
  let orphans = 0;
  let readied = 0;

  for (const s of servers) {
    const row = bySid.get(s.id);
    if (!row) {
      // No row owns this server's id. Labels may only ADOPT a row that has no server yet.
      const poolLabel = s.labels["murage/pool"], callLabel = s.labels["murage/call"];
      const cand = (poolLabel ? byId.get(poolLabel) : undefined) ?? (callLabel ? byCall.get(callLabel) : undefined);
      if (cand) {
        seen.add(cand.id);
        if (cand.state === "failed" && cand.fail_reason === "create_lost" && !cand.server_id && !adoptedNow.has(cand.id) && poolLabel === cand.id && callLabel === cand.create_call_id
          && s.labels["murage/role"] === "pool" && s.labels["murage/env"] === pool.env && s.labels["murage/home"] === undefined) {
          // The unanswered create did land: take its server id so the destroy pass deletes it by id.
          adoptedNow.add(cand.id);
          stmts.push(env.DB.prepare("UPDATE warm_pool SET server_id=?,ipv4=COALESCE(?,ipv4) WHERE id=? AND state='failed' AND fail_reason='create_lost' AND server_id IS NULL AND destroyed_at IS NULL")
            .bind(s.id, s.ipv4, cand.id));
          await event(env, cand.id, "create_lost_adopted", s.id, now);
          continue;
        }
        const adoptable = cand.state === "warming" && !cand.server_id && !adoptedNow.has(cand.id) && poolLabel === cand.id && callLabel === cand.create_call_id
          && s.labels["murage/role"] === "pool" && s.labels["murage/env"] === pool.env;
        if (!adoptable) {
          if (budget.anomalies > 0) { budget.anomalies--; await conflict(ctx, s, `its labels point at row ${cand.id} (${cand.server_id ? "which has another server" : `state ${cand.state}`})`); }
          continue;
        }
        if (readied >= budget.actions) continue;
        readied++;
        adoptedNow.add(cand.id);
        // Adoption writes the server id in the same guarded statement; the fresh provider listing then accounts for the server.
        if (s.status === "off" && s.ipv4) {
          stmts.push(env.DB.prepare("UPDATE warm_pool SET state='ready',phase=NULL,server_id=?,ipv4=?,image_id=?,ready_at=?,last_verified_at=? WHERE id=? AND state='warming' AND server_id IS NULL")
            .bind(s.id, s.ipv4, s.imageId ?? cand.image_id, now, now, cand.id));
        } else {
          stmts.push(env.DB.prepare("UPDATE warm_pool SET server_id=?,ipv4=COALESCE(ipv4,?),phase='creating' WHERE id=? AND state='warming' AND server_id IS NULL").bind(s.id, s.ipv4, cand.id));
        }
        continue;
      }
      if (!s.name?.startsWith(prefix) || orphans >= ORPHANS_PER_TICK || !mutationOk(ctx, MUTATE_MS)) continue;
      orphans++;
      // An "orphan" by labels may still be a (destroyed) row's server or already a customer's home: check ownership by id and the live labels right before the DELETE.
      const owned = await env.DB.prepare("SELECT id FROM warm_pool WHERE provider='hetzner' AND server_id=? LIMIT 1").bind(s.id).first();
      if (owned) { await event(env, null, "orphan_skipped", `${s.id} belongs to row ${(owned as { id: string }).id}`, now); continue; }
      const fresh = await getById(ctx, s.id);
      if (!fresh) continue; // already gone
      if (fresh.labels["murage/role"] !== "pool" || fresh.labels["murage/env"] !== pool.env || fresh.labels["murage/home"] !== undefined) {
        await event(env, null, "orphan_not_ours", `${s.id} role=${fresh.labels["murage/role"] ?? "none"}`, now);
        await raise(env, "pool", "pool.anomaly", "high", `server ${s.id} looked like an orphan pool server but its labels say otherwise; it was left alone`, now);
        continue;
      }
      await boundedCall(ctx, MUTATE_MS, (signal) => adapter.deleteServer(s.id, signal));
      await event(env, null, "orphan_destroyed", `${s.id} ${s.name}`, now);
      continue;
    }
    seen.add(row.id);
    if (row.state === "warming" || row.state === "ready") {
      const drift = notOurs(ctx, row, s);
      if (drift) { if (budget.anomalies > 0) { budget.anomalies--; await foreign(ctx, row, s.id, drift); } continue; }
      const running = s.status === "running" || s.status === "starting";
      const imageBad = s.imageId !== null && s.imageId !== row.image_id;
      const labelsBad = s.labels["murage/class"] !== row.class || s.labels["murage/call"] !== row.create_call_id;
      const anomaly = running ? (row.state === "ready" ? "unclaimed_running" : "warming_running") : imageBad ? "image_mismatch" : labelsBad ? "labels_changed" : null;
      if (anomaly) {
        if (budget.anomalies <= 0 || !mutationOk(ctx, MUTATE_MS)) continue; // deferred: found again next tick
        budget.anomalies--;
        await quarantine(ctx, row, anomaly);
        continue;
      }
      if (row.state === "warming" && s.status === "off" && s.ipv4) {
        if (readied >= budget.actions) continue;
        readied++;
        stmts.push(env.DB.prepare("UPDATE warm_pool SET state='ready',phase=NULL,ipv4=?,image_id=?,ready_at=?,last_verified_at=? WHERE id=? AND state='warming' AND server_id=?")
          .bind(s.ipv4, s.imageId ?? row.image_id, now, now, row.id, s.id));
      } else if (row.state === "ready" && now - (row.last_verified_at ?? 0) >= 10 * 60_000) verify.push(row.id);
    } else if (row.state === "failed" && row.fail_reason?.startsWith("anomaly:") && (s.status === "running" || s.status === "starting")) {
      if (budget.anomalies > 0 && mutationOk(ctx, MUTATE_MS)) { budget.anomalies--; await quarantine(ctx, row, "still_running", true); } // keep it fenced and off until destroyed
    }
  }

  // Rows that expect a server the listing did not show.
  let lostOld = 0;
  for (const row of rows) {
    // Unsettled = still no server after the committed adoptions; a label match that was REJECTED for adoption settles nothing.
    if (row.state === "failed" && row.fail_reason === "create_lost" && !row.server_id && !adoptedNow.has(row.id) && now - (row.retired_at ?? row.created_at) >= CREATE_LOST_SETTLE_MS) lostOld++;
    if (seen.has(row.id)) continue;
    if (row.state === "failed" && row.fail_reason === "create_lost" && !row.server_id) {
      // Settled only by evidence: a labelled server is adopted above (then deleted by id); otherwise the row keeps its spend and limit reservation.
      // Elapsed time with an empty listing is NOT settlement evidence (dispatch-ledger.ts): the reservation is held indefinitely and an operator is alerted (lostOld).
    } else if (row.state === "warming" && !row.server_id) {
      // create_lost: the request lifetime is over and no labelled server pointed at this row.
      if (now - row.created_at >= PROVIDER_REQUEST_LIFETIME_MS && stmts.length < budget.actions)
        stmts.push(env.DB.prepare("UPDATE warm_pool SET state='failed',phase=NULL,fail_reason='create_lost',retired_at=?,secret_hash=NULL WHERE id=? AND state='warming' AND server_id IS NULL").bind(now, row.id));
    } else if ((row.state === "warming" || row.state === "ready") && row.server_id) {
      if (budget.anomalies <= 0 || Date.now() > ctx.deadline) continue;
      budget.anomalies--;
      const detail = await getById(ctx, row.server_id);
      if (!detail) {
        stmts.push(env.DB.prepare("UPDATE warm_pool SET state='failed',phase=NULL,fail_reason='server_gone',retired_at=?,destroyed_at=?,secret_hash=NULL WHERE id=? AND server_id=? AND state IN ('warming','ready')").bind(now, now, row.id, row.server_id));
      } else {
        const bad = notOurs(ctx, row, detail);
        if (bad) await foreign(ctx, row, row.server_id, bad);
      }
    }
  }
  if (lostOld) await raise(env, "pool", "pool.create_lost_unsettled", "high", `${lostOld} lost pool create(s) older than 24 h still show no server; their spend, vCPU and IP reservation stays held until the server is found and destroyed or an operator settles them`, now);
  else await resolve(env, "pool", "pool.create_lost_unsettled", now);
  for (let i = 0; i < verify.length; i += CHUNK) {
    const ids = verify.slice(i, i + CHUNK);
    stmts.push(env.DB.prepare(`UPDATE warm_pool SET last_verified_at=? WHERE state='ready' AND id IN (${ids.map(() => "?").join(",")})`).bind(now, ...ids));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  if (readied) await event(env, null, "reconciled", `${readied} rows advanced`, now);
  return servers;
}

// ---- retired and failed rows go away only on a confirmed DELETE success or a 404 by id, and only for a row WITH a server_id ----------------------

async function destroyPass(ctx: Ctx): Promise<void> {
  const { env, pool, adapter, now } = ctx;
  // Held anomalies and foreign rows are excluded in SQL, before the LIMIT, so they can never starve eligible rows.
  const rows = (await env.DB.prepare(`SELECT * FROM warm_pool WHERE env=? AND state IN ('retired','failed') AND destroyed_at IS NULL AND server_id IS NOT NULL
      AND COALESCE(fail_reason,'') NOT LIKE 'foreign:%' AND NOT (COALESCE(fail_reason,'') LIKE 'anomaly:%' AND COALESCE(retired_at,0)>?) ORDER BY COALESCE(retired_at,0) LIMIT ?`)
    .bind(pool.env, now - ANOMALY_HOLD_MS, DESTROYS_PER_TICK).all<Row>()).results ?? [];
  const done = (id: string) => env.DB.prepare("UPDATE warm_pool SET destroyed_at=?,phase='destroyed',secret_hash=NULL WHERE id=? AND destroyed_at IS NULL").bind(now, id).run();
  for (const row of rows) {
    if (!mutationOk(ctx, MUTATE_MS)) return;
    const id = row.server_id!;
    try {
      // A DELETE already sent: the row stays billed (and counted) until its action succeeded or the server is 404.
      if (row.phase?.startsWith("destroying")) {
        const actionId = row.phase.slice("destroying:".length);
        const st = actionId ? await boundedCall(ctx, READ_MS, (signal) => adapter.actionStatus(actionId, signal)) : "none";
        if (st === "success") { await done(row.id); continue; }
        if (st === "running") continue;
        // error / unknown: fall through. Only a 404 by id proves it is gone; otherwise the DELETE is sent again.
      }
      const detail = await getById(ctx, id);
      if (!detail) { await done(row.id); continue; } // GET 404: gone
      if (row.fail_reason?.startsWith("claim_") && detail.labels["murage/home"] !== undefined) continue; // an abandoned claim: the home cleanup (B3) owns the server
      const bad = notOurs(ctx, row, detail);
      if (bad) { await foreign(ctx, row, id, bad); continue; }
      if (!mutationOk(ctx, MUTATE_MS)) return;
      const r = await boundedCall(ctx, MUTATE_MS, (signal) => adapter.deleteServer(id, signal));
      if (r.gone || r.status === "success") { await done(row.id); await event(env, row.id, "destroyed", id, now); continue; }
      await env.DB.prepare("UPDATE warm_pool SET phase=? WHERE id=? AND destroyed_at IS NULL").bind(`destroying:${r.actionId ?? ""}`, row.id).run();
      await event(env, row.id, "destroy_sent", `${id} action ${r.actionId ?? "none"}`, now);
    } catch (e) { await event(env, row.id, "destroy_failed", errCode(e), now); }
  }
}

// ---- 5. usage and budget ---------------------------------------------------------------------------------------------------------------

/** ONE accounting rule. Used vCPU and primary IPs for this tick = a FRESH provider read (every page of servers and primary IPs; claimed homes included)
 *  plus the reservation of every create that has no server yet (warming, no server_id, any age, until it is adopted or settled). */
async function usageNow(ctx: Ctx): Promise<{ vcpu: number; primaryIps: number }> {
  const u = await boundedCall(ctx, READ_MS, (signal) => ctx.adapter.projectUsage(signal));
  const open = await ctx.env.DB.prepare("SELECT COALESCE(SUM(vcpus),0) AS v, COUNT(*) AS n FROM warm_pool WHERE env=? AND destroyed_at IS NULL AND server_id IS NULL AND (state='warming' OR (state='failed' AND fail_reason='create_lost'))")
    .bind(ctx.pool.env).first<{ v: number; n: number }>();
  return { vcpu: u.vcpu + (open?.v ?? 0), primaryIps: u.primaryIps + (open?.n ?? 0) };
}

// ---- 6-7. need and creates -------------------------------------------------------------------------------------------------------------

async function createPass(ctx: Ctx, types: ServerTypeInfo[], usage: Usage | null): Promise<void> {
  const { env, pool, config, adapter, now, result } = ctx;
  const targets = targetsFor(pool, parseJson((await env.DB.prepare("SELECT targets_override FROM warm_pool_control WHERE id='pool'").first<{ targets_override: string | null }>())?.targets_override));
  const breaker = (await kvGet<{ n: number; until: number }>(env, "pool.create_fail")) ?? { n: 0, until: 0 };
  if (config.firewallIds.length === 0) {
    await event(env, null, "no_firewall", "firewallIds is empty: the grabber creates nothing", now);
    await raise(env, "pool", "pool.create_failing", "high", "the pool config has no firewallIds: a pool server is never created unfirewalled", now);
    return;
  }
  if (!usage) { await event(env, null, "usage_unknown", "project usage not readable: no creates", now); return; }
  if (now < breaker.until) return;

  const est = usage;
  const counts = new Map<string, number>();
  for (const r of (await env.DB.prepare(`SELECT class,COUNT(*) AS n FROM warm_pool WHERE env=? AND state IN ('ready','warming') AND ${CURRENT_IMAGE_SQL} GROUP BY class`)
    .bind(pool.env, ...currentImageBinds(config)).all<{ class: string; n: number }>()).results ?? []) counts.set(r.class, r.n);
  const day = (await env.DB.prepare("SELECT COUNT(*) AS n FROM warm_pool WHERE env=? AND created_at>=? AND COALESCE(fail_reason,'') NOT IN ('no_stock','rate_limited','not_sent')").bind(pool.env, now - DAY_MS).first<{ n: number }>())?.n ?? 0;
  let dayLeft = pool.maxCreatesPerDay - day;
  let tickLeft = pool.maxCreatesPerTick;
  // Idle spend: every row still billed (warming, ready, and failed/retired until the provider confirms the destroy).
  const idle = (await env.DB.prepare(`SELECT COALESCE(SUM(monthly_cents),0) AS c FROM warm_pool WHERE env=? AND destroyed_at IS NULL AND state IN ('warming','ready','failed','retired')`)
    .bind(pool.env).first<{ c: number }>())?.c ?? 0;
  let room = Math.round(pool.monthlyIdleCapEur * 100) - idle;
  let vcpuRoom = pool.limits.vcpu - pool.limits.reserveForLive.vcpu - est.vcpu;
  let ipRoom = pool.limits.primaryIps - pool.limits.reserveForLive.primaryIps - est.primaryIps;
  const info = new Map(types.map((t) => [t.name, t]));
  const closed = new Set<string>();
  const rr = new Map<string, number>();
  let stopped = false;
  let tooBigRaised = false;
  let capped = false;
  let consecutive = breaker.n;

  for (const cls of CLASSES) {
    let need = targets[cls].target - (counts.get(cls) ?? 0);
    while (need > 0 && !stopped) {
      if (tickLeft <= 0 || dayLeft <= 0) break;
      if (!mutationOk(ctx, CREATE_TIMEOUT_MS)) { stopped = true; break; } // nothing may START that could outlive the deadline (and so the lease)
      // The first rung with an open, priced, in-stock location that is affordable (price of THAT location + its IPv4) and has room.
      let pick: { serverType: string; arch: "x86" | "arm"; location: string; cents: number; cores: number; image: string; verified: VerifiedImage } | null = null;
      for (const rung of pool.classes[cls].rungs) {
        const t = info.get(rung.serverType);
        const image = config.images.hetzner[rung.arch];
        if (!t || t.deprecated || !image) continue;
        // A pool server is never filled from an image that fails the signature check: the rung is skipped.
        let verified: VerifiedImage;
        try { verified = await verifyImageForUse(env, config, { provider: "hetzner", image, arch: rung.arch }, now, ctx.verify); }
        catch (e) {
          if (!(e instanceof ImageRefused)) throw e;
          await raise(env, "pool", "pool.image_unverified", "high", `${rung.arch}: ${e.code}`, now);
          continue;
        }
        // The image must fit the type's disk (after the signature gate, never instead of it). Unknown sizes never block: provider's 422 still would.
        let imageGb: number | null = null;
        try { imageGb = adapter.imageDiskGb ? await boundedCall(ctx, READ_MS, (signal) => adapter.imageDiskGb!(image, signal)) : null; } catch { imageGb = null; }
        if (!diskFits(imageGb, t.diskGb)) {
          if (!tooBigRaised) { tooBigRaised = true; await raiseImageTooBig(env, [{ image, serverType: rung.serverType }], now); }
          continue;
        }
        const open = config.hetznerLocations.filter((l) => t.locations[l]?.available && !t.locations[l].deprecated && t.locations[l].monthlyNetCents !== null && !closed.has(`${rung.serverType}/${l}`));
        if (!open.length) continue;
        const start = rr.get(rung.serverType) ?? 0;
        for (let k = 0; k < open.length; k++) {
          const location = open[(start + k) % open.length];
          const cents = t.locations[location].monthlyNetCents! + IPV4_MONTHLY_CENTS;
          if (cents > room) { capped = true; continue; }
          if (t.cores > vcpuRoom || ipRoom < 1) continue;
          rr.set(rung.serverType, start + k + 1);
          pick = { serverType: rung.serverType, arch: rung.arch, location, cents, cores: t.cores, image, verified };
          break;
        }
        if (pick) break;
      }
      if (!pick) break;

      const id = `wp_${crypto.randomUUID()}`;
      const callId = crypto.randomUUID();
      const secret = newSecret();
      // Dispatch fence: the row exists before the request leaves, and the reservation is taken here, not after the answer.
      await env.DB.prepare(`INSERT INTO warm_pool (id,env,class,provider,server_type,arch,location,image_id,image_digest,state,phase,secret_hash,create_call_id,monthly_cents,vcpus,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'warming','create_sent',?,?,?,?,?)`)
        .bind(id, pool.env, cls, "hetzner", pick.serverType, pick.arch, pick.location, pick.image, imageDigestFor(env), await sha256Hex(secret), callId, pick.cents, pick.cores, now).run();
      tickLeft--; dayLeft--; need--; room -= pick.cents; vcpuRoom -= pick.cores; ipRoom -= 1;
      const refund = () => { room += pick!.cents; vcpuRoom += pick!.cores; ipRoom += 1; };
      if (!mutationOk(ctx, CREATE_TIMEOUT_MS)) {
        // The insert itself took the time: the POST must not start, so it cannot outlive the lease. Nothing was sent.
        await env.DB.prepare("UPDATE warm_pool SET state='failed',phase=NULL,fail_reason='not_sent',retired_at=?,destroyed_at=?,secret_hash=NULL WHERE id=? AND state='warming'").bind(now, now, id).run();
        refund(); dayLeft++; stopped = true; break;
      }
      try {
        assertNoProdSshKeys(env, config, ctx.verify);
        // Re-verify right before the POST (cached for an hour) so the capability is fresh; a refusal here sends nothing.
        pick.verified = await verifyImageForUse(env, config, { provider: "hetzner", image: pick.image, arch: pick.arch }, now, ctx.verify);
      } catch (e) {
        if (!(e instanceof ImageRefused)) throw e;
        await env.DB.prepare("UPDATE warm_pool SET state='failed',phase=NULL,fail_reason='not_sent',retired_at=?,destroyed_at=?,secret_hash=NULL WHERE id=? AND state='warming'").bind(now, now, id).run();
        refund(); dayLeft++; result.refused++; await raise(env, "pool", "pool.image_unverified", "high", `${pick.arch}: ${e.code}`, now);
        stopped = true; break;
      }
      try {
        const s = await adapter.createPoolServer({
          name: `${NAME_PREFIX[pool.env]}${id.slice(3, 11)}`, type: pick.serverType, location: pick.location, image: pick.verified,
          labels: { "murage/role": "pool", "murage/pool": id, "murage/env": pool.env, "murage/call": callId, "murage/class": cls, ...poolFleetLabels(pool.env, now) },
          userData: `#include\n${controlPlaneOriginFor(env)}/v1/pool/${id}/cloud-config/${secret}`,
          firewallIds: config.firewallIds, sshKeyIds: config.sshKeyIds, signal: AbortSignal.timeout(Math.min(CREATE_TIMEOUT_MS, Math.max(MIN_CALL_MS, ctx.deadline - Date.now()))) });
        await env.DB.prepare("UPDATE warm_pool SET server_id=?,ipv4=?,phase='creating' WHERE id=? AND state='warming' AND server_id IS NULL").bind(s.id, s.ipv4, id).run();
        result.created++;
        consecutive = 0;
        await kvSet(env, "pool.create_fail", { n: 0, until: 0 });
        await resolve(env, "pool", "pool.create_failing", now);
      } catch (e) {
        if (e instanceof HostError && e.status === 429) {
          // Nothing was created: the row must not hold phantom capacity for 70 minutes.
          await env.DB.prepare("UPDATE warm_pool SET state='failed',phase=NULL,fail_reason='rate_limited',retired_at=?,destroyed_at=?,secret_hash=NULL WHERE id=? AND state='warming'").bind(now, now, id).run();
          refund(); dayLeft++;
          await event(env, id, "rate_limited", null, now);
          stopped = true; break;
        }
        if (e instanceof HostError && e.status >= 400 && e.status < 500 && e.status !== 408) {
          const noStock = e.status === 412 || e.code === "resource_unavailable" || e.code === "placement_error";
          await env.DB.prepare("UPDATE warm_pool SET state='failed',phase=NULL,fail_reason=?,retired_at=?,secret_hash=NULL,destroyed_at=? WHERE id=? AND state='warming'")
            .bind(noStock ? "no_stock" : `refused:${e.code}`, now, now, id).run();
          refund();
          result.refused++;
          await event(env, id, noStock ? "no_stock" : "refused", `${pick.serverType}/${pick.location} ${e.status} ${e.code}`, now);
          if (noStock) { closed.add(`${pick.serverType}/${pick.location}`); need++; dayLeft++; } // nothing was created: try another location
          else consecutive++;
        } else {
          // Unanswered (timeout, 5xx, network): the row stays warming and KEEPS its reservation; reconcile adopts the server by murage/call or fails it after 70 minutes.
          await event(env, id, "create_unanswered", errCode(e), now);
          consecutive++;
        }
        if (consecutive >= pool.maxConsecutiveCreateFailures) {
          await kvSet(env, "pool.create_fail", { n: consecutive, until: now + CREATE_BACKOFF_MS });
          await raise(env, "pool", "pool.create_failing", "high", `${consecutive} pool creates in a row failed (last: ${errCode(e)}); backing off 15 minutes`, now);
          stopped = true;
        } else await kvSet(env, "pool.create_fail", { n: consecutive, until: 0 });
      }
    }
  }
  // spend cap: wanted more, and the idle budget (not stock, limits or counts) is what stopped it.
  // Evaluated on the counts AFTER this tick's creates, so a successful fill never raises it.
  const after = new Map<string, number>();
  for (const r of (await env.DB.prepare(`SELECT class,COUNT(*) AS n FROM warm_pool WHERE env=? AND state IN ('ready','warming') AND ${CURRENT_IMAGE_SQL} GROUP BY class`)
    .bind(pool.env, ...currentImageBinds(config)).all<{ class: string; n: number }>()).results ?? []) after.set(r.class, r.n);
  const wanted = CLASSES.some((c) => targets[c].target - (after.get(c) ?? 0) > 0);
  if (wanted && capped) await raise(env, "pool", "pool.spend_cap_reached", "high", `idle pool spend would pass the cap of EUR ${pool.monthlyIdleCapEur} per month`, now);
  else if (!wanted || room > 0) await resolve(env, "pool", "pool.spend_cap_reached", now);
}

// ---- 8. over target --------------------------------------------------------------------------------------------------------------------

async function overTarget(ctx: Ctx, targets: Record<PoolClass, Target>): Promise<void> {
  const { env, pool, config, now } = ctx;
  let budget = RETIRE_PER_TICK;
  let staleBudget = STALE_RETIRE_PER_TICK;
  for (const cls of CLASSES) {
    // Stale-image ready rows are unclaimable (the claim never rebuilds), so keeping them buys no availability and only holds spend, vCPU and IP:
    // they are retired unconditionally, oldest first, bounded per tick, and the next tick's destroy frees the room for the replacement.
    const img = currentImageBinds(config);
    const stale = (await env.DB.prepare(`SELECT id FROM warm_pool WHERE env=? AND class=? AND state='ready' AND NOT ${CURRENT_IMAGE_SQL} ORDER BY created_at, id LIMIT ?`)
      .bind(pool.env, cls, ...img, staleBudget).all<{ id: string }>()).results ?? [];
    if (stale.length && Date.now() <= ctx.deadline) {
      const res = await env.DB.batch(stale.map((r) => env.DB.prepare(`UPDATE warm_pool SET state='retired',retire_reason='stale_image',retired_at=?,secret_hash=NULL
          WHERE id=? AND state='ready' AND NOT ${CURRENT_IMAGE_SQL}`)
        .bind(now, r.id, ...img)));
      const n = res.reduce((k, x) => k + (x.meta.changes ?? 0), 0);
      staleBudget -= stale.length;
      if (n) await event(env, null, "retired", `${cls}: ${n} stale image`, now);
    }
    const rows = (await env.DB.prepare("SELECT * FROM warm_pool WHERE env=? AND class=? AND state IN ('ready','warming')").bind(pool.env, cls).all<Row>()).results ?? [];
    const total = rows.length;
    const t = targets[cls];
    let retire = Math.max(0, total - t.max);
    let floor = t.max; // retirement never takes the class's ready+warming below this
    const key = `pool.over_target_since.${cls}`;
    if (total > t.target) {
      const since = (await kvGet<{ at: number }>(env, key))?.at ?? now;
      if (since === now) await kvSet(env, key, { at: now });
      if (now - since >= pool.overTargetRetireAfterH * 3_600_000) { retire = Math.max(retire, total - t.target); floor = t.target; }
    } else await kvDel(env, key);
    if (retire <= 0 || budget <= 0) continue;
    const current = (r: Row) => r.image_id === config.images.hetzner[r.arch as "x86" | "arm"];
    const ready = rows.filter((r) => r.state === "ready").sort((a, b) => Number(current(a)) - Number(current(b)) || a.created_at - b.created_at);
    const picks = ready.slice(0, Math.min(retire, budget));
    // Batched, one guarded statement per row: it retires only while the class stays above `floor`, evaluated at execution time,
    // so claims that land meanwhile can never leave the class below target.
    let retired = 0;
    for (let i = 0; i < picks.length; i += 50) {
      if (Date.now() > ctx.deadline) break;
      const res = await env.DB.batch(picks.slice(i, i + 50).map((r) => env.DB.prepare(`UPDATE warm_pool SET state='retired',retire_reason='over_target',retired_at=?,secret_hash=NULL
          WHERE id=? AND state='ready' AND (SELECT COUNT(*) FROM warm_pool WHERE env=? AND class=? AND state IN ('ready','warming'))>?`).bind(now, r.id, pool.env, cls, floor)));
      retired += res.reduce((n, x) => n + (x.meta.changes ?? 0), 0);
      budget -= Math.min(50, picks.length - i);
    }
    if (retired) await event(env, null, "retired", `${cls}: ${retired} over target`, now);
  }
}

// ---- 9. maintenance and alerts ---------------------------------------------------------------------------------------------------------

async function maintenance(ctx: Ctx): Promise<void> {
  const { env, now } = ctx;
  const last = await kvGet<{ at: number }>(env, "pool.pruned");
  if (!last || now - last.at >= PRUNE_EVERY_MS) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM warm_pool_stock WHERE sampled_at<?").bind(now - RETENTION_MS),
      env.DB.prepare("DELETE FROM warm_pool_events WHERE at<?").bind(now - RETENTION_MS),
    ]);
    await kvSet(env, "pool.pruned", { at: now });
    await kvDel(env, "pool.usage"); await kvDel(env, "pool.adopted"); // keys of the removed snapshot mechanisms
  }
  // Delivery hygiene (plan 3.4): claimed rows whose home is gone fail (idempotent; fastProvision also runs it), delivered payloads are dropped and
  // the secret is revoked once the home's enrollment token is used. Both belong to the claim lane's file.
  await failAbandonedClaims(env, now);
  await purgeUsedDeliveries(env, now);
  // TODO(L4, claim lane): sync the cloud_capacity admission slots from the pool (plan 4.4).
}

async function alerts(ctx: Ctx, targets: Record<PoolClass, Target>): Promise<void> {
  const { env, pool, now } = ctx;
  const counts = new Map<string, number>();
  for (const r of (await env.DB.prepare("SELECT class||':'||state AS k,COUNT(*) AS n FROM warm_pool WHERE env=? AND state IN ('ready','warming') GROUP BY class,state").bind(pool.env).all<{ k: string; n: number }>()).results ?? []) counts.set(r.k, r.n);
  for (const cls of CLASSES) {
    const ready = counts.get(`${cls}:ready`) ?? 0, warming = counts.get(`${cls}:warming`) ?? 0, t = targets[cls];
    const home = `pool-${cls}`;
    const key = `pool.below_red_since.${cls}`;
    if (t.target > 0 && ready < t.red) {
      const since = (await kvGet<{ at: number }>(env, key))?.at ?? now;
      if (since === now) await kvSet(env, key, { at: now });
      if (now - since >= BELOW_RED_AFTER_MS) await raise(env, home, "pool.below_red", "high", `${cls}: ${ready} ready, below the red line of ${t.red} for ${Math.round((now - since) / 60_000)} minutes`, now);
    } else { await kvDel(env, key); await resolve(env, home, "pool.below_red", now); }
    if (t.target > 0 && ready === 0 && warming === 0) await raise(env, home, "pool.empty", "high", `${cls}: no ready and no warming servers (target ${t.target})`, now);
    else await resolve(env, home, "pool.empty", now);
  }
  const est = ctx.usage;
  if (est) {
    if (est.vcpu > 0.9 * pool.limits.vcpu || est.primaryIps > 0.9 * pool.limits.primaryIps)
      await raise(env, "pool", "pool.limit_near", "high", `this env's share is nearly used: ${est.vcpu}/${pool.limits.vcpu} vCPU, ${est.primaryIps}/${pool.limits.primaryIps} primary IPs`, now);
    else await resolve(env, "pool", "pool.limit_near", now);
  }
}

/** POOL-GRABBER-PERSISTENT: pages once pool.tick_grabber has stayed open GRABBER_PERSISTENT_MS (a blind reconcile can miss a stray billable
 *  server). raise() never refreshes raised_at (ON CONFLICT DO NOTHING keeps the open row), so the open row's raised_at is the episode's first
 *  failing tick. The page's id is keyed on it: one row per episode, never re-opened after a clean tick resolves it. */
export const GRABBER_PERSISTENT_MS = 2 * 3_600_000;
/** The modes in which runGrabber actually ran its stages; only such a tick, with no errors, resolves the grabber alerts. */
const GRABBER_WORKED: ReadonlySet<GrabberResult["mode"]> = new Set(["observe", "on", "drain"]);
async function pageGrabberPersistent(env: Env, now: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ? || ':' || raised_at,?,?,?,
    'the grabber has failed every minute tick for ' || ((? - raised_at) / 60000) || ' minutes: the pool reconcile may miss a stray billable server',?
    FROM cloud_alerts WHERE home_id=? AND kind=? AND resolved_at IS NULL AND raised_at<=? ON CONFLICT DO NOTHING`)
    .bind("pool.grabber_persistent", "pool", "pool.grabber_persistent", "high", now, now, "pool", "pool.tick_grabber", now - GRABBER_PERSISTENT_MS).run();
}

// ---- the 1-minute cron -----------------------------------------------------------------------------------------------------------------

export const MINUTE_CRON = "* * * * *";
export const MINUTE_TICK_DEADLINE_MS = 50_000;
/** The grabber gets at most this much of the minute; fastProvision gets what is left of MINUTE_TICK_DEADLINE_MS. */
export const MINUTE_TICK_GRABBER_MS = 30_000;
export interface MinuteTickDeps { runGrabber?: typeof runGrabber; fastProvision?: typeof fastProvision; b3?: B3Dependencies; grabber?: GrabberDeps }
/** The 1-minute cron body: the grabber first (at most 30 s), then fastProvision (the rest of the 50 s). One failing never stops the other: the
 *  failure is logged and a high alert is raised (resolved by the next clean tick). Returns the grabber's result. */
export async function minuteTick(env: Env, now: number = Date.now(), deps: MinuteTickDeps = {}): Promise<GrabberResult> {
  const started = Date.now();
  let result: GrabberResult = { mode: "off", created: 0, refused: 0, ready: 0, warming: 0, idleCents: 0, errors: [] };
  const fail = async (stage: string, e: unknown) => {
    result.errors.push(`${stage}:${errCode(e)}`);
    console.error(JSON.stringify({ message: "pool minute tick stage failed", stage, errorCode: errCode(e) }));
    await raise(env, "pool", `pool.tick_${stage}`, "high", `the minute tick's ${stage} stage failed: ${errCode(e)}`, now).catch(() => undefined);
  };
  try {
    result = await (deps.runGrabber ?? runGrabber)(env, now, { ...deps.grabber, deadline: started + MINUTE_TICK_GRABBER_MS });
    if (result.errors.length) await raise(env, "pool", "pool.tick_grabber", "high", `the grabber tick returned stage errors: ${result.errors.join(", ").slice(0, 300)}`, now).catch(() => undefined);
    // astra-code3 Medium: a tick that did no work (another holder had the lease, the grabber is off, no pool config) is NOT a clean tick:
    // it neither raises nor resolves, so a failure episode runs on through it and its 2 h page still fires from the first failure.
    else if (GRABBER_WORKED.has(result.mode)) {
      await resolve(env, "pool", "pool.tick_grabber", now).catch(() => undefined);
      await resolve(env, "pool", "pool.grabber_persistent", now).catch(() => undefined);
    }
  } catch (e) { await fail("grabber", e); }
  // ITEM4-FIX2 section 3: checked on EVERY tick while pool.tick_grabber is open (an off, leased or no_pool_config tick returns no errors but
  // leaves the episode open); a clean tick resolved it above, and the episode id keeps it to one page.
  await pageGrabberPersistent(env, now).catch(() => undefined);
  try {
    const left = Math.max(0, MINUTE_TICK_DEADLINE_MS - (Date.now() - started));
    const failures = await (deps.fastProvision ?? fastProvision)(env, deps.b3 ?? {}, left);
    if (failures > 0) {
      result.errors.push(`fast:${failures}_failed`);
      await raise(env, "pool", "pool.tick_fast", "high", `fastProvision: ${failures} home pass(es) failed`, now).catch(() => undefined);
    } else await resolve(env, "pool", "pool.tick_fast", now).catch(() => undefined);
  } catch (e) { await fail("fast", e); }
  return result;
}
