// SPDX-License-Identifier: AGPL-3.0-or-later
// Customer self-service from the murage.ai members area (lanes/cloud-v2/support/SELF-SERVICE.md; SUPPORT-DESIGN.md rev 3 rows B1,
// B2b and S7). The caller is the members-area Supabase identity (customer-identity.ts); every route acts on the caller's own home.
//
//   GET  /v1/account/home                  status: state, health, heartbeat, disk, last backup, Fix-it run, open holds, export, job
//   GET  /v1/account/usage                 plan, included Flux credits used this period (%), days until they reset, extra-spend cap
//   POST /v1/account/home/update           "Update my Cloud": update the Murage software; files, settings and logins stay
//   POST /v1/account/home/reset            fresh aal2 + confirm: "Reset my Cloud" from the last good backup, reversible for 7 days (no hold)
//   POST /v1/account/home/reset/undo       fresh aal2: "Undo reset" back to the state kept just before the reset
//   POST /v1/account/home/fix-it           the Fix-it ladder: check, restart Murage, reboot the server; each only if the last did not heal
//   POST /v1/account/home/restart          restart the Murage service (a command the home runs; the server stays up)
//   POST /v1/account/home/reboot           provider power cycle
//   POST /v1/account/home/start            power on a home server that is off while the home should be running
//   POST /v1/account/home/safe-mode        restart Murage with bots, schedules and add-ons paused (until the next restart)
//   POST /v1/account/home/retry-provisioning   provisioning progress (the 5-attempt retry budget already re-runs it)
//   POST /v1/account/home/logs/request     fresh aal2: ask the home for recent redacted logs
//   GET  /v1/account/home/logs             fresh aal2: read them (redacted again here; kept 24 hours)
//   GET  /v1/account/home/audit            this home's self-service log (customer, devices, watchdog)
//   POST /v1/account/home/hold             fresh aal2: delete, start fresh or add a device, always behind the 72-hour hold
//   POST /v1/account/home/hold/cancel      cancel a hold (sign-in is enough; any registered device can cancel too)
//   POST /v1/account/export/download       fresh aal2: one-time download link and the archive key (AGE-SECRET-KEY-1...) for a ready export
//   GET  /v1/export-download/<token>       the encrypted archive itself (the token is the credential: single purpose, 10 minutes, 3 uses)
// Home side (machine credential, bound IP, current generation). Commands are a separate poll so the strict desired wire contract
// (shared/cloud-control-shapes.json, additionalProperties false) is unchanged for homes that do not know them:
//   GET  /v1/machines/<id>/commands        pending commands for this generation, oldest first; each is picked once and gets a run deadline
//   POST /v1/machines/<id>/commands/ack    a command from GET commands ran (done, failed, unsupported); exactly once per command
//   POST /v1/machines/<id>/logs            redacted log lines for a collect_logs command, in chunks
//   POST /v1/machines/<id>/export-ready    the encrypted export archive is in the home's backup space; carries its key once
// The wire shapes on both sides are pinned by shared/self-service-contract.json (tested here and against deploy/cloud-home/murage-commands).
//
// Data jobs (reset, undo, update, export) run one at a time per home: cloud_home_jobs has one active row per home at most (a partial
// unique index, so the database admits exactly one whatever races), and nothing that power-cycles or restarts the home runs while one is
// active. A job's command must be picked by the home before it expires and acknowledged before its run deadline (plus a grace); past
// either, the job fails cleanly and the slot is released. The home never starts, or passes an irreversible step of, a command after its
// run deadline. A provider power action (reboot, start) takes the same slot (kind 'power') until the provider confirms its terminal
// status, so nothing is admitted while a timed-out call may still execute. A reset or undo the home picked but did not answer in time is "unknown", never
// "failed": the home re-sends its journaled result on its own, and that late result settles it.
//
// Signed-in is enough for everything that cannot lose or leak data (B1). Logs can leak, so they need a fresh second factor like the
// export download (SELF-SERVICE.md action 11, B2b). Every action is rate limited per home and written to selfservice_audit. Every write
// runs under the home's lease (billing-lease.ts) and is fenced by it; the watchdog takes the same lease, so it and the customer never act
// on one home at once. Provider calls (reboot, start) re-check the lease, generation, lifecycle and job slot right before the call, and
// record the intent first.
import { journalDispatch } from "./step-up-op";
import { z } from "zod";
import { b3Enabled } from "./b3-config";
import {
  cancelHold, completeHold, home as loadHome, machine, providerFor, startHold,
  type B3Dependencies, type Hold, type HoldAction, type Home,
} from "./b3-control";
import type { PowerReceipt, PowerStatus, ProviderAdapter } from "./b3-provider";
import { HostError } from "./b5-provisioner";
import { hetznerStorageBox, isRetainedExports, type StorageBoxAdapter } from "./b5-backup";
import { confirmDeletionPlanEnd, deletionPlanEnd, endPlanForDeletion, reconcileDeletionObligation, noFurtherCharge, notify, planEndSentence, recordNotice, planEndState, readJSON, type BillingDependencies, type PlanEndState } from "./b5-billing";
import { provisionerConfig } from "./b5-config";
import { fence, fencedBatch, HomeBusy, LeaseLost, q, withHomeLease, type HomeLease, type Q } from "./billing-lease";
import { boundCustomer, pinnedHome, pinnedLogsCommand, type Identity } from "./customer-identity";
import { HTTPError, json, type JSONValue } from "./http";
import { sha256 } from "./installations";
import { keyWrapperFor } from "./key-wrapper";
import { htmlOf, isoDate } from "./legal-flows";
import { readyPairHolds } from "./pairing";
import { raiseAlert } from "./ops-monitor";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Per-home limits: [max, window]. Customer buttons, then the watchdog's own budget (so a customer cannot starve it, nor it them), then the
 *  door's (its account budget is keyed by the account id). */
export const LIMITS = {
  fixit: [[6, HOUR]],
  restart: [[5, HOUR], [10, DAY]],
  reboot: [[3, HOUR], [6, DAY]],
  start: [[6, DAY]],
  safe_mode: [[3, DAY]],
  retry_provisioning: [[12, HOUR]],
  logs: [[20, DAY]],
  hold: [[3, DAY]],
  hold_cancel: [[10, DAY]],
  export_download: [[10, DAY]],
  update: [[3, DAY]],
  reset: [[2, DAY]],
  reset_undo: [[2, DAY]],
  wd_run: [[3, DAY]],
  wd_restart: [[6, DAY]],
  wd_reboot: [[2, 6 * HOUR]],
  // The door (door.ts): opening a home from the members area. door_account is keyed by the ACCOUNT id, door_home by the home.
  door_account: [[10, MINUTE], [60, HOUR]],
  door_home: [[30, MINUTE]],
  // Device management on My Cloud (devices.ts, CLOUD-DOOR-V2-DESIGN.md 3.2), keyed by the ACCOUNT id.
  devices_list: [[30, MINUTE]],
  devices_revoke: [[10, MINUTE]],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;
export type LimitName = keyof typeof LIMITS;

/** A home is healthy when it should run, passed its canary, and its Murage app answered recently (checked every minute by the home). */
export const HEALTHY_HEARTBEAT_MS = 3 * MINUTE;
/** The watchdog acts on a home whose app has not answered this long: the 5-minute alert threshold plus one more interval (SELF-SERVICE.md 4.4). */
export const WATCHDOG_STALE_MS = 10 * MINUTE;
/** After any Fix-it run ends without healing (customer or watchdog), the watchdog waits this long; and runs at most LIMITS.wd_run a day. */
export const WATCHDOG_COOLDOWN_MS = HOUR;
/** How long each ladder step gets to heal the home before the next step. */
export const STEP_WAIT_MS = { restart_service: 4 * MINUTE, reboot: 8 * MINUTE } as const;
export const LADDER = ["check", "restart_service", "reboot"] as const;
type Step = typeof LADDER[number];
/** How long a command waits to be picked by the home. */
const COMMAND_TTL_MS = 15 * MINUTE;
/** A reset, undo or update may wait for a stuck home to come back (after a reboot) this long; an export a little longer. */
export const JOB_PICKUP_MS = DAY;
const EXPORT_PICKUP_MS = 2 * DAY;
/** From pickup, how long the home has to run a command. It never starts or passes an irreversible step after this. */
export const RUN_MS: Record<string, number> = {
  restart_service: 15 * MINUTE, safe_mode: 15 * MINUTE, collect_logs: 15 * MINUTE,
  update_software: 2 * HOUR, reset_from_backup: 12 * HOUR, undo_reset: 12 * HOUR, export_archive: 12 * HOUR,
};
/** Past the run deadline plus this, a job with no acknowledgement fails and its slot is released (room for clock skew and a late ack). */
export const JOB_GRACE_MS = 30 * MINUTE;
/** Undo is offered for 7 full days from the reset's completion (its acknowledgement). */
export const RESET_UNDO_MS = 7 * DAY;
/** The home keeps the pre-reset snapshot this many days from completion: the 7-day window plus room for a late ack and an undo's run. */
export const RESET_SNAPSHOT_KEEP_DAYS = 9;
const EXPORT_COMMAND_TTL_MS = EXPORT_PICKUP_MS;
/** An export the home has not produced in this long goes to the operator path (the existing /v1/admin/export-delivered). */
const EXPORT_AUTOMATION_MS = 2 * DAY;
export const EXPORT_AVAILABLE_MS = 7 * DAY;
/** Archive storage per home in its backup space: ready, unpurged archives plus the one being built never exceed this. */
export const EXPORT_STORAGE_BUDGET_BYTES = 100 * 2 ** 30;
/** Below this much room left in the budget an export goes to the operator path instead of a partial archive. */
const EXPORT_MIN_ROOM_BYTES = 2 ** 30;
const DOWNLOAD_TOKEN_MS = 10 * MINUTE;
const DOWNLOAD_TOKEN_USES = 3;
const LOG_TTL_MS = DAY;
const AUDIT_RETENTION_MS = 90 * DAY;
/** Provider calls are bounded: a hung call is reported, never waited on past this. */
const PROVIDER_TIMEOUT_MS = 20_000;
export const ACTIVE_STATES: readonly string[] = ["ready", "checking", "payment_problem"];

export interface SelfServiceDependencies {
  b3?: B3Dependencies;
  billing?: BillingDependencies;
  /** The Storage Box holding a home's backups (and its export archives), by box id. Default: the live build host box from config. */
  storageBox?: (boxId: number) => StorageBoxAdapter | null;
  /** The request's (or cron run's) ctx.waitUntil: keeps a bounded background continuation alive after the response. */
  waitUntil?: (work: Promise<unknown>) => void;
  /** Tests only: a shorter provider-call bound than PROVIDER_TIMEOUT_MS. */
  providerTimeoutMs?: number;
}
type Actor = "customer" | "device" | "watchdog" | "operator";
type Source = "customer" | "watchdog";

// ---- shared helpers -------------------------------------------------------------------------------------------------------------

export interface AppHealth { app_reported_at: number | null; app_ok_at: number | null; app_ok?: number | null }
/** The outcome of the home's latest app report (Astra AUTOCANARY-3 P2): app_ok, written with every report and merged fail-closed on a
 *  same-millisecond tie (ops-monitor recordHealth). A row written before app_ok existed (NULL) falls back to the rule recordHealth's
 *  tie merge uses for it: the latest report succeeded when app_ok_at=app_reported_at. Null when the home never reported app health. */
export function appOutcome(app: AppHealth | null): boolean | null {
  if (app?.app_reported_at == null) return null;
  if (app.app_ok != null) return app.app_ok === 1;
  return app.app_ok_at != null && app.app_ok_at === app.app_reported_at;
}
/** When the home last showed it is alive: the last time the Murage app answered (app_ok_at), for a home that reports it; for an image
 *  that has never reported app health, its root daemon's heartbeat. Once a home reports app health, a live daemon with a hung app is not
 *  alive. This is a time for display and for the watchdog's "silent since"; whether the home is healthy NOW is healthy(), which decides
 *  on the latest outcome (appOutcome), never on this time alone. */
export function liveAt(h: Pick<Home, "heartbeat_at">, app: AppHealth | null): number | null {
  return app?.app_reported_at != null ? app.app_ok_at : h.heartbeat_at;
}
/** Healthy: an active home observed ready whose latest app report succeeded within HEALTHY_HEARTBEAT_MS (for an image that never
 *  reported app health, a heartbeat within it). A failure reported after (or at the same millisecond as) the last success is unhealthy. */
export function healthy(h: Pick<Home, "desired_state" | "observed_state" | "heartbeat_at">, app: AppHealth | null, now: number): boolean {
  const outcome = appOutcome(app);
  const live = outcome === null ? h.heartbeat_at : outcome ? app!.app_reported_at : null;
  return ["ready", "payment_problem"].includes(h.desired_state) && h.observed_state === "ready" && live !== null && now - live <= HEALTHY_HEARTBEAT_MS;
}
/** What the members area is told. "unknown" when the home has never reported whether its app answers (an image without the app
 *  probe): a live root daemon is not evidence that Murage works. The Fix-it ladder still uses the heartbeat for such homes. */
export function healthState(h: Pick<Home, "desired_state" | "observed_state" | "heartbeat_at">, app: AppHealth | null, now: number): "healthy" | "unhealthy" | "unknown" {
  if (app?.app_reported_at == null) return ["ready", "payment_problem"].includes(h.desired_state) && h.observed_state === "ready" ? "unknown" : "unhealthy";
  return healthy(h, app, now) ? "healthy" : "unhealthy";
}
const appHealth = (env: Env, homeId: string) =>
  env.DB.prepare("SELECT app_reported_at,app_ok_at,app_ok FROM cloud_home_health WHERE home_id=?").bind(homeId).first<AppHealth>();

/** Fixed-window ledger (pairing.ts's withinLimit, with a window per subject). Every window of the limit is spent. */
export async function takeLimit(env: Env, homeId: string, name: LimitName, now: number): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  for (const [max, windowMs] of LIMITS[name]) {
    const subject = `${name}:${windowMs}:${homeId}`;
    const cutoff = now - windowMs;
    const r = await env.DB.prepare(`INSERT INTO selfservice_rate_limits (subject,window_started_at,attempts) VALUES (?,?,1)
      ON CONFLICT(subject) DO UPDATE SET
        window_started_at=CASE WHEN window_started_at<=? THEN excluded.window_started_at ELSE window_started_at END,
        attempts=CASE WHEN window_started_at<=? THEN 1 ELSE attempts+1 END
      WHERE window_started_at<=? OR attempts<?`).bind(subject, now, cutoff, cutoff, cutoff, max).run();
    if (r.meta.changes === 0) {
      const row = await env.DB.prepare("SELECT window_started_at FROM selfservice_rate_limits WHERE subject=?").bind(subject).first<{ window_started_at: number }>();
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(((row?.window_started_at ?? now) + windowMs - now) / 1000)) };
    }
  }
  return { ok: true };
}

const auditQ = (homeId: string, actor: Actor, accountId: string | null, action: string, outcome: string, detail: Record<string, JSONValue>, now: number): Q =>
  q("INSERT INTO selfservice_audit (id,home_id,actor,account_id,action,outcome,detail,at) VALUES (?,?,?,?,?,?,?,?)",
    crypto.randomUUID(), homeId, actor, accountId, action, outcome, JSON.stringify(detail), now);
async function audit(env: Env, ...args: Parameters<typeof auditQ>) {
  const [sql, binds] = auditQ(...args);
  await env.DB.prepare(sql).bind(...(binds ?? [])).run();
}
/** The statement, then a write guard that rolls the whole batch back unless it changed exactly one row. */
const exactlyOne = (stmt: Q): Q[] => {
  const g = crypto.randomUUID();
  return [stmt, q("INSERT INTO cloud_write_guards VALUES (?,changes())", g), q("DELETE FROM cloud_write_guards WHERE id=?", g)];
};
/** A guard that rolls the batch back unless the condition (a SQL boolean) holds at that point in the batch. */
const holds = (condition: string, ...binds: unknown[]): Q[] => {
  const g = crypto.randomUUID();
  return [q(`INSERT INTO cloud_write_guards VALUES (?,(${condition}))`, g, ...binds), q("DELETE FROM cloud_write_guards WHERE id=?", g)];
};
async function runBatch(env: Env, lease: HomeLease | null, stmts: Q[]): Promise<D1Result[]> {
  if (lease) return fencedBatch(env, lease, stmts);
  return env.DB.batch(stmts.map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))));
}

/** A command for the home, fenced by the home's generation (a later generation never runs an earlier one's command). */
const commandQ = (h: Home, id: string, kind: string, payload: Record<string, JSONValue>, now: number, ttl = COMMAND_TTL_MS): Q =>
  q(`INSERT INTO cloud_home_commands (id,home_id,generation,kind,payload,created_at,expires_at)
    SELECT ?,id,generation,?,?,?,? FROM cloud_homes WHERE id=? AND generation=?`, id, kind, JSON.stringify(payload), now, now + ttl, h.id, h.generation);

async function limited(env: Env, h: Home, name: LimitName, actor: Actor, accountId: string | null, action: string, now: number) {
  const r = await takeLimit(env, h.id, name, now);
  if (r.ok) return;
  await audit(env, h.id, actor, accountId, action, "rate_limited", { retryAfterSeconds: r.retryAfterSeconds }, now);
  throw new HTTPError(429, "rate_limited", { retry_after_seconds: r.retryAfterSeconds });
}

/** The home's lease, or 409 home_busy (the watchdog or a billing operation holds it; nothing was changed). */
async function underLease<T>(env: Env, homeId: string, work: (lease: HomeLease) => Promise<T>, held?: HomeLease | null): Promise<T> {
  try { return await withHomeLease(env, homeId, work, held); }
  catch (e) { if (e instanceof HomeBusy || e instanceof LeaseLost) throw new HTTPError(409, "home_busy"); throw e; }
}

/** Under the lease, the home as it is now: still this generation and still in a state self-service may act on. */
async function currentHome(env: Env, h: Home): Promise<Home> {
  const cur = await loadHome(env.DB, h.id);
  if (cur.generation !== h.generation || cur.resource_generation !== h.resource_generation) throw new HTTPError(409, "state_conflict");
  if (!ACTIVE_STATES.includes(cur.desired_state)) throw new HTTPError(409, "home_inactive");
  return cur;
}

/** The home image runs the self-service command runner: it has polled for commands at this generation. Otherwise commands would
 *  never be consumed, so the actions that need them are refused (or, for an export, sent to the operator path). */
async function runnerKnown(env: Env, h: Home): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS x FROM cloud_home_runner WHERE home_id=? AND generation=?").bind(h.id, h.generation).first()) !== null;
}
async function requireRunner(env: Env, h: Home) {
  if (!await runnerKnown(env, h)) throw new HTTPError(409, "home_unsupported");
}

/** A documented, unambiguous refusal by the provider: an HTTP 4xx answer (except 408 timeout and 429 rate limit, which do not say the
 *  request was refused for good). Nothing was accepted, so nothing can still execute. */
function definiteRejection(e: unknown): boolean {
  return e instanceof HostError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

/** A provider power action holds the home's job slot (a 'power' job) until it is proven finished (settlePower). Past this an
 *  unconfirmed reservation raises an ops alert as telemetry; it is never released by time. */
export const POWER_UNCERTAIN_MS = 20 * MINUTE;
/** How long a provider call that outlived its bound is still awaited in the background for its receipt (Workers keep waitUntil work
 *  alive for a limited time after the response; past this the receipt is left to the late-receipt reconciliation). */
const LATE_RECEIPT_MS = 5 * MINUTE;

/** Bounded: a provider call that hangs is reported as a timeout, never awaited past PROVIDER_TIMEOUT_MS. */
async function bounded<T>(work: Promise<T>, ms = PROVIDER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("provider_timeout")), ms); })]);
  } finally { clearTimeout(timer); }
}

/** The one server of this home generation, checked against the provider's labels (never another home's). */
async function homeServer(provider: ProviderAdapter, h: Home) {
  const servers = await provider.list_by_tag(h.id, h.resource_generation, "home");
  if (servers.length > 1 || servers.some((r) => r.home_id !== h.id || r.generation !== h.resource_generation || r.role !== "home")) {
    throw new Error("provider_identity_conflict");
  }
  return servers[0] ?? null;
}

/** A provider power action (reboot or start). Discovery first; then, immediately before the mutation, the lease is renewed and, in one
 *  fenced batch, the intent is recorded and the home's job slot reserved (a 'power' job) only if the home is still this generation,
 *  still active and has no job running. Anything that changed while discovery ran makes it "state_changed" and nothing is sent to the
 *  provider. The call itself is bounded; the reservation records the server and the provider's action id and is kept until the
 *  provider confirms that operation's terminal status (settlePower), so nothing conflicting is admitted while it may still execute. */
async function providerAction(env: Env, deps: SelfServiceDependencies, lease: HomeLease, h: Home, action: "reboot" | "start", actor: Actor,
  accountId: string | null, runId: string | null, now: number): Promise<string> {
  let provider: ProviderAdapter;
  try { provider = providerFor(env, deps.b3); } catch { return "provider_error"; }
  if (action === "reboot" && !provider.reboot) return "unsupported";
  let server: Awaited<ReturnType<typeof homeServer>>;
  try { server = await bounded(homeServer(provider, h)); }
  catch (e) {
    console.error(JSON.stringify({ message: "self-service provider discovery failed", homeId: h.id, errorCode: e instanceof Error ? e.message.slice(0, 80) : "unknown" }));
    return "provider_error";
  }
  if (!server) return "no_server";
  // A start for a server that is already up is not sent (it could never be confirmed, and there is nothing to do): success.
  if (action === "start" && provider.server_up) {
    let up = false;
    try { up = await bounded(provider.server_up(server.id)); } catch { up = false; }
    if (up) {
      await audit(env, h.id, actor, accountId, action, "already_running", { serverId: String(server.id) }, now);
      return "issued";
    }
  }
  const reservation = crypto.randomUUID();
  try {
    await fence(env, lease);
    await fencedBatch(env, lease, [
      ...holds(`(SELECT COUNT(*) FROM cloud_homes WHERE id=? AND generation=? AND resource_generation=? AND desired_state IN ('ready','checking','payment_problem'))=1
        AND NOT EXISTS (SELECT 1 FROM cloud_home_jobs WHERE home_id=? AND state='active')`, h.id, h.generation, h.resource_generation, h.id),
      // Uncertain until the provider answers: a Worker that dies mid-call leaves the slot held for the whole uncertain window.
      q(`INSERT INTO cloud_home_jobs (id,home_id,kind,ref,generation,state,created_at,outcome,settle_at,server_id)
        VALUES (?,?,'power',?,?,'active',?,'uncertain',?,?)`,
        reservation, h.id, action, h.generation, now, now + POWER_UNCERTAIN_MS, String(server.id)),
      auditQ(h.id, actor, accountId, action, "intent", { serverId: String(server.id), reservation, ...(runId ? { runId } : {}) }, now),
    ]);
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    return "state_changed";
  }
  // The provider call itself, started once. Before racing it against the bound, its eventual answer is tied to this reservation: a
  // receipt that arrives after the local timeout still records the call's own action id (a bounded background continuation; only
  // action_id is written, never the state or outcome, so a released reservation stays released). The mutation is never replayed.
  const call = action === "reboot" ? provider.reboot!(server.id) : provider.start(server.id);
  const persist = call.then(async (answer) => {
    const actionId = answer && typeof answer.actionId === "string" ? answer.actionId : null;
    if (actionId) {
      await env.DB.prepare("UPDATE cloud_home_jobs SET action_id=? WHERE id=? AND kind='power' AND action_id IS NULL").bind(actionId, reservation).run();
    }
  }, () => { /* a refusal or a failure carries no receipt */ });
  let lateTimer: ReturnType<typeof setTimeout> | undefined;
  const background = Promise.race([persist, new Promise<void>((resolve) => { lateTimer = setTimeout(resolve, LATE_RECEIPT_MS); })])
    .catch(() => {}).finally(() => clearTimeout(lateTimer));
  deps.waitUntil?.(background);
  let receipt: void | PowerReceipt;
  try {
    receipt = await bounded(call, deps.providerTimeoutMs);
  } catch (e) {
    const code = e instanceof Error ? e.message.slice(0, 80) : "unknown";
    console.error(JSON.stringify({ message: "self-service provider action failed", homeId: h.id, action, errorCode: code }));
    if (definiteRejection(e)) {
      // The provider answered and refused it (a documented 4xx): nothing was accepted, so the slot is released at once, as failed.
      await env.DB.prepare("UPDATE cloud_home_jobs SET state='failed',outcome='provider_rejected',finished_at=? WHERE id=? AND state='active'")
        .bind(now, reservation).run();
      return "provider_rejected";
    }
    // Uncertain delivery (a timeout, a dropped connection, a 5xx): the reservation stays (settlePower decides).
    return code === "provider_timeout" ? "provider_timeout" : "provider_error";
  }
  // Accepted: the reservation now names the provider's action, whose terminal status releases it (settlePower).
  await env.DB.prepare("UPDATE cloud_home_jobs SET outcome='issued',action_id=? WHERE id=? AND state='active'")
    .bind(receipt && typeof receipt.actionId === "string" ? receipt.actionId : null, reservation).run();
  return "issued";
}

async function emailOwner(env: Env, deps: SelfServiceDependencies, lease: HomeLease | null, homeId: string, kind: Parameters<typeof notify>[3], key: string,
  data: Record<string, unknown>) {
  try { await notify(env, { ...(deps.billing ?? {}), lease }, homeId, kind, key, data); }
  catch { /* recorded notices are retried by the billing sweep; the action itself stands */ }
}

// ---- data jobs: one at a time per home --------------------------------------------------------------------------------------------

type JobKind = "reset" | "undo" | "update" | "export" | "power";
interface JobRow { id: string; home_id: string; kind: JobKind; ref: string | null; generation: number; state: string; created_at: number;
  outcome?: string | null; settle_at?: number | null }
const JOB_OF_COMMAND: Record<string, JobKind> = { reset_from_backup: "reset", undo_reset: "undo", update_software: "update", export_archive: "export" };
type JobOutcome = "done" | "failed" | "unsupported" | "expired" | "timed_out";

/** Statements that close an active job and apply its outcome to what it was for. They apply only if they are what closes it (a write
 *  guard on the job row), and the subject's transition names the job's own command id, so a replayed or superseded result changes
 *  nothing. ackCommand: also mark the command answered (expiry; the ack route has already done so). */
function closeJobQ(job: JobRow, outcome: JobOutcome, now: number, ackCommand: boolean): Q[] {
  const ok = outcome === "done";
  const state = ok ? "done" : outcome === "expired" || outcome === "timed_out" ? "expired" : "failed";
  // A reset or undo the home picked but did not answer in time may have happened: its result is unknown (never "failed", never a
  // withdrawn undo window) and its command stays unanswered, so the home's late result (it retries on its own) still reconciles it.
  const unknown = outcome === "timed_out" && (job.kind === "reset" || job.kind === "undo");
  const stmts: Q[] = [...exactlyOne(q("UPDATE cloud_home_jobs SET state=?,outcome=?,finished_at=? WHERE id=? AND state='active'", state, outcome, now, job.id))];
  if (ackCommand && !unknown) stmts.push(q("UPDATE cloud_home_commands SET acked_at=?,outcome=? WHERE id=? AND acked_at IS NULL", now, outcome, job.id));
  if (job.kind === "reset") {
    // Undo is offered for RESET_UNDO_MS from completion, never from the request.
    stmts.push(unknown
      ? q("UPDATE cloud_resets SET state='unknown' WHERE id=? AND command_id=? AND state='requested'", job.ref, job.id)
      : q("UPDATE cloud_resets SET state=?,done_at=?,keep_until=? WHERE id=? AND command_id=? AND state='requested'",
        ok ? "done" : "failed", ok ? now : null, ok ? now + RESET_UNDO_MS : now, job.ref, job.id));
  } else if (job.kind === "undo") {
    // A failed or never-picked undo leaves the reset undoable for the rest of its window.
    stmts.push(unknown
      ? q("UPDATE cloud_resets SET state='undo_unknown' WHERE id=? AND undo_command_id=? AND state='undo_requested'", job.ref, job.id)
      : q(`UPDATE cloud_resets SET state=?,undone_at=?,undo_command_id=CASE WHEN ? THEN undo_command_id ELSE NULL END
      WHERE id=? AND undo_command_id=? AND state='undo_requested'`, ok ? "undone" : "done", ok ? now : null, ok ? 1 : 0, job.ref, job.id));
  } else if (job.kind === "export" && !ok) {
    stmts.push(q("UPDATE cloud_export_jobs SET state='manual' WHERE command_id=? AND state='requested'", job.id));
  }
  return stmts;
}

/** The home's late result for a reset or undo whose job timed out (state unknown): applied exactly once, by that job's own command.
 *  A reset that happened gets its undo window from now, never past what the home keeps the pre-reset snapshot for (it keeps it
 *  RESET_SNAPSHOT_KEEP_DAYS from its own completion, which is after pickup). */
function lateResultQ(job: JobRow, outcome: "done" | "failed" | "unsupported", now: number, pickedAt: number | null): Q[] {
  const ok = outcome === "done";
  const stmts: Q[] = [...exactlyOne(q(`UPDATE cloud_home_jobs SET state=?,outcome=?,finished_at=? WHERE id=? AND state='expired' AND outcome='timed_out'`,
    ok ? "done" : "failed", `late_${outcome}`, now, job.id))];
  if (job.kind === "reset") {
    const ceiling = (pickedAt ?? now) + RESET_SNAPSHOT_KEEP_DAYS * DAY - HOUR;
    stmts.push(q("UPDATE cloud_resets SET state=?,done_at=?,keep_until=? WHERE id=? AND command_id=? AND state='unknown'",
      ok ? "done" : "failed", ok ? now : null, ok ? Math.min(now + RESET_UNDO_MS, ceiling) : now, job.ref, job.id));
  } else {
    stmts.push(q(`UPDATE cloud_resets SET state=?,undone_at=?,undo_command_id=CASE WHEN ? THEN undo_command_id ELSE NULL END
      WHERE id=? AND undo_command_id=? AND state='undo_unknown'`, ok ? "undone" : "done", ok ? now : null, ok ? 1 : 0, job.ref, job.id));
  }
  return stmts;
}

/** A legacy power reservation's server, from the original intent audit matched on both the home and the reservation id (the intent
 *  has recorded serverId and reservation since reservations existed); recorded on the job. Failing that, the home's own server of this
 *  generation from the provider's labels, so even a reservation with no audit settles with no person involved. */
async function backfillServer(env: Env, provider: ProviderAdapter | null, job: JobRow): Promise<{ serverId: string | null; gone: boolean }> {
  const row = await env.DB.prepare(`SELECT CASE WHEN json_valid(detail) THEN json_extract(detail,'$.serverId') END AS server_id FROM selfservice_audit
    WHERE home_id=? AND outcome='intent' AND action=? AND (CASE WHEN json_valid(detail) THEN json_extract(detail,'$.reservation') END)=?
      AND (CASE WHEN json_valid(detail) THEN json_extract(detail,'$.serverId') END) IS NOT NULL ORDER BY at LIMIT 1`)
    .bind(job.home_id, job.ref, job.id).first<{ server_id: string | number | null }>();
  let serverId = row?.server_id != null ? String(row.server_id) : null;
  let gone = false;
  if (!serverId && provider) {
    const h = await env.DB.prepare("SELECT * FROM cloud_homes WHERE id=?").bind(job.home_id).first<Home>();
    if (!h) gone = true;
    else { try { const s = await bounded(homeServer(provider, h)); serverId = s ? String(s.id) : null; gone = !s; } catch { serverId = null; } }
  }
  if (serverId) await env.DB.prepare("UPDATE cloud_home_jobs SET server_id=? WHERE id=? AND server_id IS NULL").bind(serverId, job.id).run();
  return { serverId, gone };
}

/** Consecutive heartbeats (counted as they arrive, after the uncertain window) before an unresolved reservation is released. */
export const POWER_RELEASE_BEATS = 3;
/** Beats closer together than this (the home beats every 60 s) do not add to the run, so a burst never stands in for minutes of uptime. */
export const POWER_BEAT_SPACING_MS = 30 * 1000;

/** Called on every authenticated heartbeat (b3-control). Each power reservation of the home past its uncertain window counts the beat
 *  as it arrives: one more in the run when the last counted beat is at most HEALTHY_HEARTBEAT_MS old (and at least
 *  POWER_BEAT_SPACING_MS), otherwise (an actual gap, or the first beat) the run restarts at one. Settlement (settlePower) only
 *  consumes this evidence; how often it samples (the five-minute cron) no longer decides whether beats are consecutive. */
/** The counter write, as a statement for the heartbeat's D1 batch. It runs right after the generation-guarded home update and is gated on
 *  changes()=1: a heartbeat invalidated by a concurrent credential rotation updated no home row, so it counts for nothing (Astra SELFSERVICE8 P2). */
export function notePowerHeartbeat(db: D1Database, homeId: string, now: number): D1PreparedStatement {
  return db.prepare(`UPDATE cloud_home_jobs SET
      fresh_beats=CASE WHEN last_beat_at IS NULL OR ?1-last_beat_at>?2 THEN 1 WHEN ?1-last_beat_at>=?3 THEN fresh_beats+1 ELSE fresh_beats END,
      last_beat_at=CASE WHEN last_beat_at IS NULL OR ?1-last_beat_at>?2 OR ?1-last_beat_at>=?3 THEN ?1 ELSE last_beat_at END
    WHERE home_id=?4 AND kind='power' AND state='active' AND created_at+?5<=?1 AND changes()=1`)
    .bind(now, HEALTHY_HEARTBEAT_MS, POWER_BEAT_SPACING_MS, homeId, POWER_UNCERTAIN_MS);
}

/** Power reservations. Only a correlated receipt completes one: the provider's record of the action id this call's own answer carried,
 *  in success ("done") or error ("failed"). A newer boot or another action is never taken as this call's completion. Anything else stays
 *  reserved for POWER_UNCERTAIN_MS; after that (Astra's bounded policy, accepting residual late-reboot risk, which reset/update recovery
 *  and the home's start inhibition are built to survive) it is released as 'unconfirmed_released', never 'done', once the provider
 *  answers that the server is up and the home has sent POWER_RELEASE_BEATS consecutive heartbeats (counted on arrival by
 *  notePowerHeartbeat, the last of them recent). This also covers legacy jobs
 *  and providers without receipts (Vultr). A receipt that arrives later is recorded (late_receipt); the call is never replayed. No
 *  person is ever needed; power.unconfirmed is telemetry. Least recently checked first, so none starves. */
export async function settlePower(env: Env, deps: SelfServiceDependencies, now: number, homeId?: string) {
  const open = await env.DB.prepare(`SELECT * FROM cloud_home_jobs WHERE kind='power' AND state='active' ${homeId ? "AND home_id=?" : ""}
    ORDER BY COALESCE(last_checked_at,0),created_at LIMIT 20`).bind(...(homeId ? [homeId] : []))
    .all<JobRow & { server_id: string | null; action_id: string | null; fresh_beats: number; last_beat_at: number | null }>();
  let provider: ProviderAdapter | null = null;
  try { provider = providerFor(env, deps.b3); } catch { provider = null; }
  const receipt = async (serverId: string | null, ref: string | null, actionId: string | null): Promise<PowerStatus | null> => {
    if (!provider?.power_action_status || !serverId || !actionId) return null;
    try { return await bounded(provider.power_action_status(serverId, ref as "reboot" | "start", actionId)); } catch { return null; }
  };
  for (const job of open.results) {
    await env.DB.prepare("UPDATE cloud_home_jobs SET last_checked_at=? WHERE id=?").bind(now, job.id).run();
    // A legacy reservation (before its server was recorded) gets its server back from its own intent audit; then it settles normally.
    let serverGone = false;
    if (!job.server_id) ({ serverId: job.server_id, gone: serverGone } = await backfillServer(env, provider, job));
    const status = await receipt(job.server_id, job.ref, job.action_id);
    if (status === "success" || status === "error") {
      await env.DB.prepare("UPDATE cloud_home_jobs SET state=?,outcome=?,finished_at=? WHERE id=? AND state='active'")
        .bind(status === "success" ? "done" : "failed", `provider_${status}`, now, job.id).run();
      continue;
    }
    if (now < job.created_at + POWER_UNCERTAIN_MS) continue;
    await raiseAlert(env, { homeId: job.home_id, kind: "power.unconfirmed", severity: "high",
      detail: `${job.ref} ${job.id}: not confirmed by the provider; released automatically once the server is up and the home has called in ${POWER_RELEASE_BEATS} times (telemetry, no action needed)` }, now);
    if (serverGone) {
      // No audit and the provider answers that the home has no server at all: nothing can still be executing. Released, never done.
      await env.DB.prepare("UPDATE cloud_home_jobs SET state='expired',outcome='unconfirmed_released',finished_at=? WHERE id=? AND state='active'")
        .bind(now, job.id).run();
      await audit(env, job.home_id, "operator", null, `power_${job.ref}`, "unconfirmed_released", { jobId: job.id, reason: "no_server" }, now);
      continue;
    }
    let up = false;
    if (provider?.server_up && job.server_id) { try { up = await bounded(provider.server_up(job.server_id)); } catch { up = false; } }
    // The run of consecutive beats is counted as they arrive (notePowerHeartbeat). Settlement consumes it: released only with the full
    // run, its last beat recent, and the provider answering that the server is up. A last beat older than HEALTHY_HEARTBEAT_MS is an
    // actual heartbeat gap: the run is cleared (only if no beat arrived meanwhile), so the next beat starts a new one.
    const recent = job.last_beat_at !== null && now - job.last_beat_at <= HEALTHY_HEARTBEAT_MS;
    if (!recent) {
      if (job.fresh_beats !== 0) {
        await env.DB.prepare("UPDATE cloud_home_jobs SET fresh_beats=0 WHERE id=? AND state='active' AND last_beat_at IS ?").bind(job.id, job.last_beat_at).run();
      }
      continue;
    }
    if (!up || job.fresh_beats < POWER_RELEASE_BEATS) continue;
    const released = await env.DB.prepare(`UPDATE cloud_home_jobs SET state='expired',outcome='unconfirmed_released',finished_at=?
      WHERE id=? AND state='active' AND fresh_beats>=?`).bind(now, job.id, POWER_RELEASE_BEATS).run();
    if (released.meta.changes) await audit(env, job.home_id, "operator", null, `power_${job.ref}`, "unconfirmed_released", { jobId: job.id }, now);
  }
  // Late receipts of released reservations are recorded (for the record and the operators), never acted on, never replayed. Least
  // recently checked first, the check time updated on every attempt, so none starves behind ten that stay running.
  const released = await env.DB.prepare(`SELECT id,server_id,ref,action_id FROM cloud_home_jobs WHERE kind='power' AND outcome='unconfirmed_released'
    AND action_id IS NOT NULL AND late_receipt IS NULL AND finished_at>? ${homeId ? "AND home_id=?" : ""}
    ORDER BY COALESCE(late_checked_at,0),finished_at,id LIMIT 10`)
    .bind(now - 7 * DAY, ...(homeId ? [homeId] : [])).all<{ id: string; server_id: string | null; ref: string; action_id: string }>();
  for (const job of released.results) {
    await env.DB.prepare("UPDATE cloud_home_jobs SET late_checked_at=? WHERE id=?").bind(now, job.id).run();
    const status = await receipt(job.server_id, job.ref, job.action_id);
    if (status === "success" || status === "error") {
      await env.DB.prepare("UPDATE cloud_home_jobs SET late_receipt=? WHERE id=?").bind(`${status}@${now}`, job.id).run();
    }
  }
}

/** Jobs whose command was not picked before it expired (or before the home moved to another generation), or was picked and not
 *  acknowledged by its run deadline plus the grace, fail cleanly and release the slot. Then waiting exports may take it. */
export async function reconcileJobs(env: Env, now: number, homeId?: string): Promise<void> {
  const stale = await env.DB.prepare(`SELECT j.*, c.picked_at AS picked_at FROM cloud_home_jobs j
    LEFT JOIN cloud_home_commands c ON c.id=j.id LEFT JOIN cloud_homes h ON h.id=j.home_id
    WHERE j.state='active' AND j.kind<>'power' ${homeId ? "AND j.home_id=?" : ""} AND (c.id IS NULL
      OR (c.acked_at IS NULL AND c.picked_at IS NULL AND (c.expires_at<=? OR h.generation IS NOT c.generation))
      OR (c.acked_at IS NULL AND c.picked_at IS NOT NULL AND c.run_deadline+?<=?))
    LIMIT 50`).bind(...(homeId ? [homeId] : []), now, JOB_GRACE_MS, now).all<JobRow & { picked_at: number | null }>();
  for (const job of stale.results) {
    const outcome: JobOutcome = job.picked_at === null ? "expired" : "timed_out";
    try {
      await runBatch(env, null, [...closeJobQ(job, outcome, now, true), auditQ(job.home_id, "operator", null, `job_${job.kind}`, outcome, { jobId: job.id }, now)]);
      if (job.kind === "export") {
        await raiseAlert(env, { homeId: job.home_id, kind: "export.manual_needed", severity: "high",
          detail: `export job ${job.id}: the home did not ${outcome === "expired" ? "pick it up" : "finish it"} in time` }, now);
      }
    } catch { /* closed by an ack in the meantime */ }
  }
}

/** The home's active job, after reconciling stale jobs; with the provider at hand (deps), power reservations are confirmed first. */
async function activeJob(env: Env, homeId: string, now: number, deps?: SelfServiceDependencies): Promise<JobRow | null> {
  if (deps) await settlePower(env, deps, now, homeId);
  await reconcileJobs(env, now, homeId);
  return env.DB.prepare("SELECT * FROM cloud_home_jobs WHERE home_id=? AND state='active'").bind(homeId).first<JobRow>();
}

/** Admits a job for the home: the job row (the unique index is the slot), its command (fenced by generation) and whatever the caller
 *  adds, in one batch that keeps nothing unless all of it applied. 409 job_in_progress when the slot is taken. Returns the command id. */
async function admitJob(env: Env, lease: HomeLease | null, h: Home, kind: JobKind, ref: string | null, commandKind: string,
  payload: Record<string, JSONValue>, now: number, ttl: number, extra: (commandId: string) => Q[]): Promise<string> {
  const busy = await activeJob(env, h.id, now);
  if (busy) throw new HTTPError(409, "job_in_progress", { job: busy.kind });
  const id = crypto.randomUUID();
  try {
    await runBatch(env, lease, [
      q("INSERT INTO cloud_home_jobs (id,home_id,kind,ref,generation,state,created_at) VALUES (?,?,?,?,?,'active',?)", id, h.id, kind, ref, h.generation, now),
      ...exactlyOne(commandQ(h, id, commandKind, payload, now, ttl)),
      ...extra(id),
    ]);
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    const other = await env.DB.prepare("SELECT kind FROM cloud_home_jobs WHERE home_id=? AND state='active'").bind(h.id).first<{ kind: string }>();
    if (other) throw new HTTPError(409, "job_in_progress", { job: other.kind });
    throw new HTTPError(409, "state_conflict");
  }
  return id;
}

// ---- customer identity ----------------------------------------------------------------------------------------------------------

async function customerHome(request: Request, env: Env): Promise<{ account: string; h: Home }> {
  const s = await boundCustomer(request)?.resolve();
  if (!s) throw new HTTPError(401, "unauthorized");
  const h = await env.DB.prepare("SELECT * FROM cloud_homes WHERE owner_id=? AND desired_state<>'deleted' ORDER BY created_at DESC LIMIT 1")
    .bind(s.user.id).first<Home>();
  if (!h) throw new HTTPError(404, "not_found");
  // An emailed step-up approval is frozen for one home (step-up-email.ts): a newer home that appeared since is not the one approved.
  const pin = pinnedHome(request);
  if (pin !== null && pin !== h.id) throw new HTTPError(403, "step_up_required");
  return { account: s.user.id, h };
}

/** Fresh aal2 (CONTRACT.md section 3): the same 403 body as the money routes. Checked in the handler as well as by the router gate. */
async function requireStepUp(request: Request, env: Env, identity: Identity) {
  const need = await identity.stepUpNeeded(request, env);
  if (need) throw new HTTPError(403, "step_up_required", { step_up: { ...need } });
  if (!await identity.stepUp(request, env)) throw new HTTPError(403, "step_up_required");
}

const emptyBody = z.object({}).strict();
// Restore is "Reset my Cloud" for customers (reversible, no hold). Delete and start fresh destroy data; pair changes who has access.
const holdBody = z.object({ action: z.enum(["delete", "start_fresh", "pair"]), confirm: z.string().max(128).optional() }).strict();
const resetBody = z.object({ confirm: z.string().max(128) }).strict();
const resetIdBody = z.object({ resetId: z.string().uuid() }).strict();
const holdIdBody = z.object({ holdId: z.string().regex(/^[\w-]{1,128}$/) }).strict();
const requestIdBody = z.object({ requestId: z.string().regex(/^[\w-]{1,128}$/) }).strict();

// ---- status ---------------------------------------------------------------------------------------------------------------------

interface RunRow { id: string; home_id: string; source: Source; step: Step; step_at: number; next_at: number; started_at: number;
  finished_at: number | null; outcome: string | null; steps: string }
const runView = (r: RunRow | null): JSONValue => r ? { id: r.id, source: r.source, step: r.step, startedAt: r.started_at,
  nextStepAt: r.finished_at === null ? r.next_at : null, finishedAt: r.finished_at, outcome: r.outcome,
  // Nothing healed it: the page offers "Reset my Cloud" (reversible for 7 days).
  suggestion: r.outcome === "needs_attention" || r.outcome === "watchdog_budget_spent" ? "reset" : null,
  steps: JSON.parse(r.steps) as JSONValue } : null;
const latestRun = (env: Env, homeId: string) => env.DB.prepare("SELECT * FROM cloud_fixit_runs WHERE home_id=? ORDER BY finished_at IS NULL DESC,started_at DESC LIMIT 1")
  .bind(homeId).first<RunRow>();

async function status(env: Env, h: Home, now: number, deps: SelfServiceDependencies = {}): Promise<Response> {
  const health = await env.DB.prepare("SELECT reported_at,disk_used_percent,last_backup_at,app_reported_at,app_ok_at,app_ok FROM cloud_home_health WHERE home_id=?")
    .bind(h.id).first<{ reported_at: number; disk_used_percent: number | null; last_backup_at: number | null } & AppHealth>();
  const holds = await env.DB.prepare(`SELECT id,action,started_at,completes_at,source FROM cloud_recovery_holds
    WHERE home_id=? AND completed_at IS NULL AND canceled_at IS NULL ORDER BY started_at`).bind(h.id)
    .all<{ id: string; action: string; started_at: number; completes_at: number; source: string }>();
  const commands = await env.DB.prepare(`SELECT kind,created_at FROM cloud_home_commands WHERE home_id=? AND generation=? AND acked_at IS NULL
    AND ((picked_at IS NULL AND expires_at>?) OR run_deadline>?) ORDER BY created_at`).bind(h.id, h.generation, now, now).all<{ kind: string; created_at: number }>();
  const job = await env.DB.prepare(`SELECT request_id,state,requested_at,deliver_by,ready_at,available_until,bytes,downloaded_at FROM cloud_export_jobs
    WHERE home_id=? ORDER BY requested_at DESC LIMIT 1`).bind(h.id)
    .first<{ request_id: string; state: string; requested_at: number; deliver_by: number; ready_at: number | null; available_until: number | null; bytes: number | null; downloaded_at: number | null }>();
  const provisioning = h.desired_state === "provisioning" || h.desired_state === "failed" ? await provisioningView(env, h) : null;
  const reset = await env.DB.prepare("SELECT id,state,requested_at,done_at,keep_until FROM cloud_resets WHERE home_id=? ORDER BY requested_at DESC LIMIT 1")
    .bind(h.id).first<{ id: string; state: string; requested_at: number; done_at: number | null; keep_until: number }>();
  const running = await activeJob(env, h.id, now, deps);
  const state = healthState(h, health, now);
  return json({
    homeId: h.id, desiredState: h.desired_state, observedState: h.observed_state, health: state,
    healthy: state === "unknown" ? null : state === "healthy",
    heartbeatAt: h.heartbeat_at, appRespondedAt: health?.app_ok_at ?? null, diskUsedPercent: health?.disk_used_percent ?? null,
    lastBackupAt: health?.last_backup_at ?? null, healthReportedAt: health?.reported_at ?? null, fixIt: runView(await latestRun(env, h.id)),
    // Door v2 (r4.2): a running hold is "waiting" (completesAt); a completed, unspent pair hold stays listed as "ready" (readyUntil) or
    // "reserved" (an outstanding desktop door ticket holds it) until it is spent or lapses.
    holds: [...holds.results.map((x) => ({ holdId: x.id, action: x.action, startedAt: x.started_at, completesAt: x.completes_at, source: x.source,
      state: "waiting" })), ...await readyPairHolds(env.DB, h.id, now)],
    pendingCommands: commands.results.map((c) => ({ kind: c.kind, issuedAt: c.created_at })),
    job: running && running.kind !== "power" ? { kind: running.kind, startedAt: running.created_at } : null,
    export: job ? { requestId: job.request_id, state: job.state, requestedAt: job.requested_at, deliverBy: job.deliver_by, readyAt: job.ready_at,
      availableUntil: job.available_until, bytes: job.bytes, downloadedAt: job.downloaded_at } : null,
    provisioning,
    reset: reset ? { resetId: reset.id, state: reset.state, requestedAt: reset.requested_at, doneAt: reset.done_at,
      undoUntil: reset.state === "done" && reset.keep_until > now ? reset.keep_until : null } : null,
  });
}

async function provisioningView(env: Env, h: Home): Promise<JSONValue> {
  const a = await env.DB.prepare("SELECT attempts,next_at,last_error,gave_up_at,give_up_code FROM provision_attempts WHERE home_id=?").bind(h.id)
    .first<{ attempts: number; next_at: number; last_error: string | null; gave_up_at: number | null; give_up_code: string | null }>();
  return { state: h.desired_state, attempts: a?.attempts ?? 0, nextRetryAt: a && a.next_at > 0 ? a.next_at : null,
    lastError: a?.last_error ?? null, gaveUpAt: a?.gave_up_at ?? null, refunded: h.entitlement === "refund_pending" || h.entitlement === "refunded" };
}

// ---- the Fix-it ladder ----------------------------------------------------------------------------------------------------------

const limitFor = (source: Source, step: "restart_service" | "reboot"): LimitName =>
  source === "watchdog" ? (step === "reboot" ? "wd_reboot" : "wd_restart") : (step === "reboot" ? "reboot" : "restart");

/** Starts a run (or returns the open one) and advances it as far as it can go now. The caller holds the home's lease. */
export async function startFixIt(env: Env, deps: SelfServiceDependencies, lease: HomeLease, h: Home, source: Source, accountId: string | null, now: number): Promise<RunRow> {
  const open = await env.DB.prepare("SELECT * FROM cloud_fixit_runs WHERE home_id=? AND finished_at IS NULL").bind(h.id).first<RunRow>();
  if (open) return advanceFixIt(env, deps, lease, h, open, now);
  const id = crypto.randomUUID();
  const actor: Actor = source;
  if (healthy(h, await appHealth(env, h.id), now)) {
    await fencedBatch(env, lease, [
      q(`INSERT INTO cloud_fixit_runs (id,home_id,source,step,step_at,next_at,started_at,finished_at,outcome,steps) VALUES (?,?,?,'check',?,?,?,?,'healthy',?)`,
        id, h.id, source, now, now, now, now, JSON.stringify([{ step: "check", at: now, outcome: "healthy" }])),
      auditQ(h.id, actor, accountId, "fix_it", "healthy", { runId: id }, now),
    ]);
  } else {
    await fencedBatch(env, lease, [
      q(`INSERT INTO cloud_fixit_runs (id,home_id,source,step,step_at,next_at,started_at,steps) VALUES (?,?,?,'check',?,?,?,?)`,
        id, h.id, source, now, now, now, JSON.stringify([{ step: "check", at: now, outcome: "unhealthy" }])),
      auditQ(h.id, actor, accountId, "fix_it", "started", { runId: id }, now),
    ]);
  }
  const run = (await env.DB.prepare("SELECT * FROM cloud_fixit_runs WHERE id=?").bind(id).first<RunRow>())!;
  return run.finished_at === null ? advanceFixIt(env, deps, lease, h, run, now) : run;
}

async function finishRun(env: Env, lease: HomeLease, run: RunRow, outcome: string, steps: unknown[], now: number, accountId: string | null) {
  await fencedBatch(env, lease, [
    q("UPDATE cloud_fixit_runs SET finished_at=?,outcome=?,steps=? WHERE id=? AND finished_at IS NULL", now, outcome, JSON.stringify(steps), run.id),
    auditQ(run.home_id, run.source, accountId, "fix_it", outcome, { runId: run.id, lastStep: run.step }, now),
  ]);
}

/** One move of the ladder: finished if the home healed after the current step; waiting while the step has time; otherwise the next
 *  step (each step spends its own rate limit); after the last step, needs attention: an ops alert and an email. Never loops. Never
 *  restarts or reboots a home while a data job (reset, undo, update, export) runs on it. */
export async function advanceFixIt(env: Env, deps: SelfServiceDependencies, lease: HomeLease, h: Home, run: RunRow, now: number): Promise<RunRow> {
  const steps = JSON.parse(run.steps) as { step: string; at: number; outcome: string }[];
  const reload = async () => (await env.DB.prepare("SELECT * FROM cloud_fixit_runs WHERE id=?").bind(run.id).first<RunRow>())!;
  const accountId = run.source === "customer" ? h.owner_id : null;
  if (!ACTIVE_STATES.includes(h.desired_state)) { await finishRun(env, lease, run, "home_inactive", steps, now, accountId); return reload(); }
  const app = await appHealth(env, h.id);
  const live = liveAt(h, app);
  if (run.step !== "check" && healthy(h, app, now) && live !== null && live > run.step_at) {
    await finishRun(env, lease, run, "healed", [...steps, { step: run.step, at: now, outcome: "healed" }], now, accountId);
    return reload();
  }
  if (now < run.next_at) return run;
  let next = LADDER[LADDER.indexOf(run.step) + 1] as Exclude<Step, "check"> | undefined;
  const job = await activeJob(env, h.id, now, deps);
  if (job && job.kind === "power" && next) return run; // a power action is settling: the next tick looks again
  if (job && job.kind !== "power") {
    await finishRun(env, lease, run, "job_in_progress", [...steps, { step: run.step, at: now, outcome: "job_in_progress" }], now, accountId);
    return reload();
  }
  if (next === "restart_service" && !await runnerKnown(env, h)) {
    // An image without the command runner would never consume a restart: go straight to the reboot.
    steps.push({ step: "restart_service", at: now, outcome: "unsupported" });
    next = "reboot";
  }
  if (!next) {
    await finishRun(env, lease, run, "needs_attention", [...steps, { step: run.step, at: now, outcome: "not_healed" }], now, accountId);
    await raiseAlert(env, { homeId: h.id, kind: "home.fixit_exhausted", severity: "high",
      detail: `${run.source} Fix-it ran restart and reboot; the home is still not healthy` }, now);
    await emailOwner(env, deps, lease, h.id, "home_needs_attention", run.id, {});
    return reload();
  }
  const limit = await takeLimit(env, h.id, limitFor(run.source, next), now);
  if (!limit.ok) {
    const outcome = run.source === "watchdog" ? "watchdog_budget_spent" : "rate_limited";
    await finishRun(env, lease, run, outcome, [...steps, { step: next, at: now, outcome: "rate_limited" }], now, accountId);
    if (run.source === "watchdog") {
      await raiseAlert(env, { homeId: h.id, kind: "home.watchdog_exhausted", severity: "high",
        detail: `watchdog ${next} budget spent; home still silent, needs a person` }, now);
    }
    return reload();
  }
  // The step is written (fenced) before any provider call: a runner that lost the lease changes nothing.
  const commandId = crypto.randomUUID();
  await fencedBatch(env, lease, [
    q("UPDATE cloud_fixit_runs SET step=?,step_at=?,next_at=? WHERE id=? AND finished_at IS NULL AND step=?", next, now, now + STEP_WAIT_MS[next], run.id, run.step),
    ...(next === "restart_service" ? [commandQ(h, commandId, "restart_service", { reason: `fix_it:${run.source}` }, now)] : []),
  ]);
  let outcome = "issued";
  if (next === "reboot") outcome = await providerAction(env, deps, lease, h, "reboot", run.source, accountId, run.id, now);
  await fencedBatch(env, lease, [
    q("UPDATE cloud_fixit_runs SET steps=? WHERE id=?", JSON.stringify([...steps, { step: next, at: now, outcome }]), run.id),
    auditQ(h.id, run.source, accountId, next === "reboot" ? "reboot" : "restart", outcome, { runId: run.id }, now),
  ]);
  return reload();
}

// ---- single customer actions ----------------------------------------------------------------------------------------------------

type Direct = "restart" | "reboot" | "start" | "safe_mode";
async function direct(env: Env, deps: SelfServiceDependencies, h: Home, account: string, action: Direct, now: number): Promise<Response> {
  if (!ACTIVE_STATES.includes(h.desired_state)) {
    // A stopped home was stopped by the operator (there is no customer stop): starting it is not self-service.
    throw new HTTPError(409, "home_inactive");
  }
  if (action === "restart" || action === "safe_mode") await requireRunner(env, h);
  await limited(env, h, action, "customer", account, action, now);
  return underLease(env, h.id, async (lease) => {
    const cur = await currentHome(env, h);
    const job = await activeJob(env, h.id, now, deps);
    if (job) throw new HTTPError(409, "job_in_progress", { job: job.kind });
    if (action === "restart" || action === "safe_mode") {
      const id = crypto.randomUUID();
      const kind = action === "restart" ? "restart_service" : "safe_mode";
      await fencedBatch(env, lease, [...exactlyOne(commandQ(cur, id, kind, { reason: "customer" }, now)),
        auditQ(h.id, "customer", account, action, "queued", { commandId: id }, now)]).catch((e: unknown) => {
        if (e instanceof LeaseLost) throw e;
        throw new HTTPError(409, "state_conflict");
      });
      // A home that has not called in for a while cannot pick the command up: say so, so the page can offer Reboot.
      const reachable = cur.heartbeat_at !== null && now - cur.heartbeat_at <= HEALTHY_HEARTBEAT_MS;
      return json({ action, state: "queued", commandId: id, expiresAt: now + COMMAND_TTL_MS, homeReachable: reachable }, 202);
    }
    const outcome = await providerAction(env, deps, lease, cur, action, "customer", account, null, now);
    await audit(env, h.id, "customer", account, action, outcome, {}, now);
    if (outcome !== "issued") throw new HTTPError(["provider_error", "provider_timeout", "provider_rejected"].includes(outcome) ? 502 : 409, `${action}_${outcome}`);
    return json({ action, state: "issued" }, 202);
  });
}

// ---- Update my Cloud, Reset my Cloud, Undo reset ---------------------------------------------------------------------------------

async function updateSoftware(env: Env, deps: SelfServiceDependencies, h: Home, account: string, now: number): Promise<Response> {
  if (!ACTIVE_STATES.includes(h.desired_state)) throw new HTTPError(409, "home_inactive");
  await requireRunner(env, h);
  const busy = await activeJob(env, h.id, now, deps);
  if (busy) throw new HTTPError(409, "job_in_progress", { job: busy.kind });
  await limited(env, h, "update", "customer", account, "update", now);
  return underLease(env, h.id, async (lease) => {
    const cur = await currentHome(env, h);
    const id = await admitJob(env, lease, cur, "update", null, "update_software", { keep: ["files", "settings", "logins"], reason: "customer" },
      now, JOB_PICKUP_MS, (cmd) => [auditQ(h.id, "customer", account, "update", "queued", { commandId: cmd }, now)]);
    return json({ action: "update", state: "queued", commandId: id, expiresAt: now + JOB_PICKUP_MS }, 202);
  });
}

/** Reset is reversible, so it never waits 72 hours: the home first keeps its current state as a tagged backup snapshot, then rebuilds
 *  from the last good backup; Undo is offered for 7 full days from completion. Fresh aal2 plus typing the home's name. It takes the
 *  home's one data-job slot. */
async function resetHome(request: Request, env: Env, deps: SelfServiceDependencies, identity: Identity, now: number): Promise<Response> {
  await requireStepUp(request, env, identity);
  const { account, h } = await customerHome(request, env);
  const input = await readJSON(request, resetBody);
  if (input.confirm !== h.id) throw new HTTPError(400, "confirmation_required");
  if (!ACTIVE_STATES.includes(h.desired_state)) throw new HTTPError(409, "home_inactive");
  await requireRunner(env, h);
  const busy = await activeJob(env, h.id, now, deps);
  if (busy) throw new HTTPError(409, "job_in_progress", { job: busy.kind });
  await limited(env, h, "reset", "customer", account, "reset", now);
  return underLease(env, h.id, async (lease) => {
    const cur = await currentHome(env, h);
    const id = crypto.randomUUID();
    const tag = `murage-pre-reset-${id}`;
    await admitJob(env, lease, cur, "reset", id, "reset_from_backup",
      { resetId: id, from: "last_good_backup", snapshotFirst: true, snapshotTag: tag, keepSnapshotDays: RESET_SNAPSHOT_KEEP_DAYS }, now, JOB_PICKUP_MS,
      (cmd) => [
        ...exactlyOne(q(`INSERT INTO cloud_resets (id,home_id,account_id,state,snapshot_tag,command_id,requested_at,keep_until)
          VALUES (?,?,?,'requested',?,?,?,0)`, id, h.id, account, tag, cmd, now)),
        auditQ(h.id, "customer", account, "reset", "queued", { resetId: id }, now),
      ]);
    return json({ action: "reset", state: "requested", resetId: id, undoDays: RESET_UNDO_MS / DAY }, 202);
  });
}

async function undoReset(request: Request, env: Env, deps: SelfServiceDependencies, identity: Identity, now: number): Promise<Response> {
  await requireStepUp(request, env, identity);
  const { account, h } = await customerHome(request, env);
  const input = await readJSON(request, resetIdBody);
  const r = await env.DB.prepare("SELECT * FROM cloud_resets WHERE id=? AND home_id=?").bind(input.resetId, h.id)
    .first<{ id: string; state: string; snapshot_tag: string; keep_until: number }>();
  if (!r) throw new HTTPError(404, "not_found");
  // Only the latest reset can be undone (an older one's snapshot predates a later reset), and only inside its window.
  const latest = await env.DB.prepare("SELECT id FROM cloud_resets WHERE home_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1").bind(h.id).first<{ id: string }>();
  if (r.state !== "done" || r.keep_until <= now || latest?.id !== r.id) throw new HTTPError(409, "undo_unavailable");
  if (!ACTIVE_STATES.includes(h.desired_state)) throw new HTTPError(409, "home_inactive");
  await requireRunner(env, h);
  const busy = await activeJob(env, h.id, now, deps);
  if (busy) throw new HTTPError(409, "job_in_progress", { job: busy.kind });
  await limited(env, h, "reset_undo", "customer", account, "reset_undo", now);
  return underLease(env, h.id, async (lease) => {
    const cur = await currentHome(env, h);
    // The undo must be picked before the window ends; the home keeps the snapshot past that for the undo's run.
    await admitJob(env, lease, cur, "undo", r.id, "undo_reset", { resetId: r.id, snapshotTag: r.snapshot_tag }, now, Math.min(JOB_PICKUP_MS, r.keep_until - now),
      (cmd) => [
        ...exactlyOne(q("UPDATE cloud_resets SET state='undo_requested',undo_command_id=? WHERE id=? AND state='done' AND keep_until>?", cmd, r.id, now)),
        ...holds("(SELECT id FROM cloud_resets WHERE home_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1)=?", h.id, r.id),
        auditQ(h.id, "customer", account, "reset_undo", "queued", { resetId: r.id }, now),
      ]);
    return json({ action: "reset_undo", state: "undo_requested", resetId: r.id }, 202);
  });
}

// ---- usage summary --------------------------------------------------------------------------------------------------------------

async function usage(env: Env, deps: SelfServiceDependencies, h: Home, now: number): Promise<Response> {
  const sub = await env.DB.prepare("SELECT plan,status,current_period_start,current_period_end FROM billing_subscriptions WHERE home_id=?").bind(h.id)
    .first<{ plan: string; status: string; current_period_start: number | null; current_period_end: number | null }>();
  const topup = await env.DB.prepare("SELECT enabled,cap_cents,cap_period,cap_resets FROM topup_settings WHERE home_id=?").bind(h.id)
    .first<{ enabled: number; cap_cents: number; cap_period: string; cap_resets: string }>();
  let usedPercent: number | null = null;
  const flux = deps.billing?.flux;
  if (sub?.current_period_start && sub.current_period_end && flux?.includedCreditMicrocents && !flux.stub) {
    try {
      const [{ usedMicrocents }, { includedMicrocents }] = await Promise.all([
        flux.usedIncludedCreditMicrocents(env, { homeId: h.id, periodStart: sub.current_period_start, periodEnd: Math.min(now, sub.current_period_end), usedThrough: now }),
        flux.includedCreditMicrocents(env, { homeId: h.id, plan: sub.plan })]);
      if (includedMicrocents > 0) usedPercent = Math.min(100, Math.round((usedMicrocents / includedMicrocents) * 1000) / 10);
    } catch { /* unavailable: shown as unknown, never as 0 */ }
  }
  return json({
    plan: sub?.plan ?? null, subscriptionStatus: sub?.status ?? null,
    periodStart: sub?.current_period_start ?? null, periodEnd: sub?.current_period_end ?? null,
    includedCreditsUsedPercent: usedPercent,
    resetsInDays: sub?.current_period_end ? Math.max(0, Math.ceil((sub.current_period_end - now) / DAY)) : null,
    extraSpendCap: topup ? { enabled: topup.enabled === 1, capUsd: topup.cap_cents / 100, period: topup.cap_period, resets: topup.cap_resets }
      : { enabled: false, capUsd: null, period: null, resets: null },
  });
}

// ---- recovery holds from the members area ---------------------------------------------------------------------------------------

const ACTION_WORDS: Record<string, string> = { delete: "delete your home and all its data", start_fresh: "start your home fresh (its data is wiped)",
  pair: "add a new device to your home" };

async function openHold(request: Request, env: Env, deps: SelfServiceDependencies, identity: Identity, now: number): Promise<Response> {
  await requireStepUp(request, env, identity);
  const { account, h } = await customerHome(request, env);
  const input = await readJSON(request, holdBody);
  // Type the home's name to confirm anything that loses data (SELF-SERVICE.md action 14).
  if (input.action !== "pair" && input.confirm !== h.id) throw new HTTPError(400, "confirmation_required");
  if (["deleting", "deleted"].includes(h.desired_state)) throw new HTTPError(409, "home_inactive");
  const existing = await env.DB.prepare(`SELECT id,started_at,completes_at FROM cloud_recovery_holds WHERE home_id=? AND action=?
    AND completed_at IS NULL AND canceled_at IS NULL`).bind(h.id, input.action).first<{ id: string; started_at: number; completes_at: number }>();
  if (existing) {
    // Asked again while the deletion waits: the plan end is made sure of once more (a gap left by a lost lease heals here).
    const plan = input.action === "delete" ? await underLease(env, h.id, (lease) => endPlanForDeletion(env, deps.billing ?? {}, h.id, lease, now)) : null;
    return json({ state: "recovery_hold", holdId: existing.id, action: input.action, startedAt: existing.started_at, completesAt: existing.completes_at, existing: true,
      ...(plan ? { plan: planView(plan) } : {}) });
  }
  await limited(env, h, "hold", "customer", account, `hold_${input.action}`, now);
  return underLease(env, h.id, async (lease) => {
    const holdId = crypto.randomUUID();
    const [sql, binds] = auditQ(h.id, "customer", account, `hold_${input.action}`, "started", { holdId }, now);
    // B1: Delete my Cloud ends the plan (the same journaled period-end cancellation as Cancel plan, with its own confirmation email), so
    // there is never a further charge. Cancelling the deletion later does not take the plan end back: only Keep my plan does.
    // Astra JOURNEY-B-1 #1: the hold, the cancellation intent and its receipt commit in ONE fenced transaction; Stripe is told after.
    const end = input.action === "delete" ? await deletionPlanEnd(env, h.id, now) : null;
    const hold = await startHold(env, h, input.action as HoldAction, "customer", now, holdId, [env.DB.prepare(sql).bind(...(binds ?? [])), ...(end?.stmts ?? [])], lease);
    const plan = end ? await confirmDeletionPlanEnd(env, deps.billing ?? {}, h.id, lease, end) : null;
    const planLine = plan ? planEndSentence(plan) : null;
    const text = `Someone signed in to your Murage Cloud account with your second factor and asked to ${ACTION_WORDS[input.action]}.\n\n`
      + `Nothing happens for 72 hours. It goes ahead on ${new Date(hold.completesAt).toISOString().replace("T", " ").slice(0, 16)} UTC unless it is cancelled.\n\n`
      + (planLine ? `${planLine} Cancelling the deletion does not restart your plan; to keep your plan, press Keep my plan on your account page.\n\n` : "")
      + "If this was not you, cancel it now from your Murage Cloud page in the members area, or from any of your paired devices, then change your password.\n\n"
      + `Reference: ${holdId}`;
    await emailOwner(env, deps, lease, h.id, "hold_started", holdId, { holdId, emailText: text, emailHtml: htmlOf(text) });
    return json({ state: "recovery_hold", holdId, action: input.action, startedAt: hold.startedAt, completesAt: hold.completesAt, existing: false,
      ...(plan ? { plan: planView(plan) } : {}) }, 202);
  });
}
/** What the deletion dialog shows about the plan (B1): `ending` with its end date, or `ended`. Astra JOURNEY-BCORE-1 #5: `confirmed` says
 *  whether Stripe confirmed the end; `noFurtherCharge` only once it has (ended, or ending and confirmed), never while it is pending. */
function planView(p: PlanEndState): JSONValue {
  // cancellationId: the in-app cancellation's CX reference (B5): POST /v1/account/cancellations/{id}/keep takes the plan end back.
  return { state: p.state, endsAt: p.endsAt, confirmed: p.confirmed, noFurtherCharge: noFurtherCharge(p), sentence: planEndSentence(p),
    cancellationId: (p as { cancellationId?: string | null }).cancellationId ?? null };
}

async function cancelCustomerHold(request: Request, env: Env, deps: SelfServiceDependencies, now: number): Promise<Response> {
  const { account, h } = await customerHome(request, env);
  const input = await readJSON(request, holdIdBody);
  const hold = await env.DB.prepare("SELECT id,action FROM cloud_recovery_holds WHERE id=? AND home_id=?").bind(input.holdId, h.id).first<{ id: string; action: string }>();
  if (!hold) throw new HTTPError(404, "not_found");
  await limited(env, h, "hold_cancel", "customer", account, "hold_cancel", now);
  if (!await cancelHold(env, h, input.holdId, "customer", now)) throw new HTTPError(409, "hold_closed");
  await audit(env, h.id, "customer", account, "hold_cancel", "canceled", { holdId: input.holdId }, now);
  // B1: the plan end the deletion journaled stands (cancelling the deletion is not Keep my plan). The email says so plainly.
  const plan = hold.action === "delete" ? await planEndState(env, h.id) : null;
  const planLine = plan && plan.state === "ending" ? ` Your server stays. ${planEndSentence(plan)} To keep your plan, press Keep my plan on your account page.` : "";
  const text = `The waiting change to your Murage Cloud home was cancelled from the members area. ${planLine ? "Your Cloud will not be deleted." + planLine : "Nothing was changed."}\n\nReference: ${input.holdId}`;
  await emailOwner(env, deps, null, h.id, "hold_canceled", input.holdId, { holdId: input.holdId, emailText: text, emailHtml: htmlOf(text) });
  return json({ canceled: true, holdId: input.holdId, ...(plan ? { plan: planView(plan) } : {}) });
}

/** Members-area holds complete on their own once the 72 hours pass (operator holds are still completed by the operator route). A hold
 *  whose home generation moved on cannot be completed (its signed proof would not verify): it is cancelled and the customer told. */
async function completeDueHolds(env: Env, deps: SelfServiceDependencies, now: number) {
  const due = await env.DB.prepare(`SELECT * FROM cloud_recovery_holds WHERE source='customer' AND completed_at IS NULL AND canceled_at IS NULL
    AND completes_at<=? ORDER BY completes_at LIMIT 20`).bind(now).all<Hold>();
  for (const hold of due.results) {
    try {
      const h = await loadHome(env.DB, hold.home_id);
      if (["deleting", "deleted"].includes(h.desired_state) || hold.generation !== h.generation) {
        await env.DB.prepare("UPDATE cloud_recovery_holds SET canceled_at=?,canceled_by='stale_generation' WHERE id=? AND completed_at IS NULL AND canceled_at IS NULL")
          .bind(now, hold.id).run();
        await audit(env, h.id, "operator", null, `hold_${hold.action}`, "canceled_stale", { holdId: hold.id }, now);
        const text = "A waiting change to your Murage Cloud home was cancelled because the home changed while it waited. Nothing was changed. You can ask again from the members area.";
        await emailOwner(env, deps, null, h.id, "hold_canceled", hold.id, { holdId: hold.id, emailText: text, emailHtml: htmlOf(text) });
        continue;
      }
      // Astra INTEGRATED-2 #1/#3 (RULE B): the deletion's billing obligation is reconciled under the billing lease first (a subscription
      // created during the hold is bound and its end asked of Stripe; proven-empty checkout attempts settled). Never a gate: whatever it
      // finds, the hold completes; an end still owed keeps the home from being retired until it is settled.
      if (hold.action === "delete") {
        try { await underLease(env, h.id, (lease) => reconcileDeletionObligation(env, deps.billing ?? {}, h.id, lease, now)); }
        catch (e) { console.error(JSON.stringify({ message: "deletion billing reconcile deferred", holdId: hold.id, errorCode: e instanceof Error ? e.message.slice(0, 80) : "unknown" })); }
      }
      // Door v2 (r4.2 item 2): "Add a computer" waited its 72 hours; the owner is told once (a notice keyed by the hold). Astra D1 #5: the
      // notice row is recorded IN the completion's batch, so a failed or busy send below leaves it owed and the billing sweep delivers it.
      const ready = hold.action === "pair" ? (() => {
        const text = "The 72-hour check for adding a computer to your Murage Cloud home is over.\n\n"
          + "Open the Murage app on your new computer and press Connect. It can connect for the next 7 days.\n\n"
          + "If you did not ask to add a computer, open your Murage Cloud page in the members area and remove any device you do not recognise under Devices, then change your password.\n\n"
          + `Reference: ${hold.id}`;
        return { holdId: hold.id, emailText: text, emailHtml: htmlOf(text) };
      })() : null;
      const [noticeSql, noticeBinds] = ready ? recordNotice(h.id, "pair_hold_ready", hold.id, ready, now) : ["", []];
      await completeHold(env, h, hold, now, ready ? [env.DB.prepare(noticeSql).bind(...(noticeBinds ?? []))] : []);
      await audit(env, h.id, "operator", null, `hold_${hold.action}`, "completed", { holdId: hold.id }, now);
      if (ready) await emailOwner(env, deps, null, h.id, "pair_hold_ready", hold.id, ready);
    } catch (e) {
      console.error(JSON.stringify({ message: "hold completion failed", holdId: hold.id, errorCode: e instanceof Error ? e.message.slice(0, 80) : "unknown" }));
    }
  }
}

// ---- logs -----------------------------------------------------------------------------------------------------------------------

/** The only log messages kept: allowed diagnostic events, fixed text with bounded numbers or fixed words (shared/self-service-contract.json
 *  logEvents; the home's runner sends nothing else). Anything else a home uploads is replaced by "[1 line omitted]" before it is stored. */
export const LOG_EVENTS = [
  String.raw`server started on port \d{1,5}`,
  String.raw`started scheduler in \d{1,7} ms`,
  String.raw`backup finished: \d{1,9} files, \d{1,9} MB`,
  String.raw`backup refused: exclusion list incomplete`,
  String.raw`Cloud control (?:clock authority unavailable|poll unavailable|readiness refused)`,
  String.raw`Cloud enrollment refused`,
  String.raw`Cloud home stopped: stale generation; operator recovery required`,
  String.raw`Cloud home unwrap (?:failed|returned no valid envelope)`,
  String.raw`Self-service command (?:restart_service|safe_mode|update_software|reset_from_backup|undo_reset|collect_logs|export_archive|unknown): (?:done|failed|unsupported|reported)`,
  String.raw`Self-service (?:command poll|housekeeping|start-up recovery) unavailable`,
  String.raw`Self-service (?:command runner refused|recovery pending|update rollback unhealthy)`,
  // The Cloud door (server/cloud-home/door-log.ts DOOR_LOG_EVENTS): one fixed line per outcome.
  String.raw`Cloud door (?:state|enter): (?:source_locked|budget_closed|internal_error|origin_refused|query_token_refused|bearer_refused|body_too_large|body_malformed|state_answered|state_rate_limited|door_unconfigured|home_unbound|ticket_malformed|ticket_wrong_type|ticket_bad_signature|ticket_wrong_home|ticket_expired|ticket_bad_times|ticket_stale_step_up|ticket_reused|account_suspended|account_mismatch|device_key_invalid|device_bind_refused|device_proof_refused|assertion_proof_refused|device_limit|desktop_hold_required|pair_hold_refused|signed_in_first|signed_in_known|signed_in_added)`,
  String.raw`Cloud door page: (?:no_ticket|device_load|device_save|device_forget|refresh|bounce|v1_record|unexpected|unknown) (?:none|NotAllowedError|AbortError|InvalidStateError|SecurityError|NotSupportedError|ConstraintError|UnknownError|DataError|QuotaExceededError|TimeoutError|TypeError|NetworkError|OperationError|VersionError|ReadOnlyError|SyntaxError|unknown)`,
  String.raw`Cloud door page: device_open (?:timeout|blocked|error|unknown) (?:chrome|safari|firefox|edge|other|unknown)`,
  String.raw`Cloud owner factor: (?:owner_factor_issued|owner_factor_renewed|owner_factor_withheld)(?: (?:stale_proof|proof_kind_after_revoke))?`,
  String.raw`(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|AbortError|TimeoutError)(?: \[ERR_[A-Z0-9_]{1,60}\])?`,
  String.raw`at (?:(?:async )?[A-Za-z0-9_$.<>\[\] ]{1,100} )?\(?(?:/opt/murage/[A-Za-z0-9_./@-]{1,200}|node:[a-z_/]{1,80}):\d{1,7}:\d{1,7}\)?`,
  String.raw`\[\d{1,4} lines? omitted\]`,
] as const;
const LOG_EVENT_RES = LOG_EVENTS.map((p) => new RegExp(`^(?:${p})$`));
export function allowedLogMessage(message: string): string {
  const text = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return LOG_EVENT_RES.some((r) => r.test(text)) ? text : "[1 line omitted]";
}

/** Exactly the sources the home's runner maps its allow-listed units to (murage-commands LOG_UNITS); nothing else is accepted. */
export const LOG_SOURCES = ["murage", "backup", "update", "tunnel", "system"] as const;
const logLine = z.object({ at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), level: z.enum(["debug", "info", "warn", "error"]),
  source: z.enum(LOG_SOURCES), message: z.string().max(200) }).strict();
const logsBody = z.object({ generation: z.number().int().positive(), commandId: z.string().uuid(), chunk: z.number().int().min(0).max(7),
  final: z.boolean(), lines: z.array(logLine).max(60) }).strict();

// Field names whose value is a secret wherever they appear: key=value, key: value, "key": "value", JSON, headers, query strings.
const SECRET_FIELD = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|auth|authorization|credential|cookie|session|`
  + String.raw`private[_-]?key|client[_-]?secret|code[_-]?verifier|signature|bearer)[A-Za-z0-9_.-]*`;
// Fields that carry free text a person wrote (chat, prompts, files): never diagnostics.
const TEXT_FIELD = String.raw`(?:content|prompt|text|body|transcript|completion|reply|message_text|input|output)`;
// Paths into engine sign-in locations (the home's CREDENTIAL_PATH).
const CREDENTIAL_PATH = /[^\s"'=]*\/(?:\.claude(?:\.json)?|\.codex|\.grok|\.kimi-code|\.gemini|\.qwen|\.cursor|\.factory|\.droid|\.antigravity|\.config\/opencode|\.local\/share\/opencode|auth\.json|\.credentials\.json|credentials(?:\.json)?)(?:\/[^\s"']*)?/g;
const VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s,;&}\]]+)`;
/** Second line of defence (the home redacts first, with the same rules): whole secret values (quoted values with spaces too), whole
 *  cookie and authorization headers, OAuth fields in JSON, tokens, keys, emails, IPs, long opaque strings, and long quoted free text. */
export function redact(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, "[redacted-key]")
    .replace(/\b((?:proxy-)?authorization|cookie|set-cookie)\b(\s*["']?\s*[:=]\s*).*$/gi, "$1$2[redacted]")
    .replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, "$1 [redacted]")
    .replace(new RegExp(String.raw`(["']?)\b(${SECRET_FIELD})\b\1(\s*[:=]\s*)(?!\[redacted)${VALUE}`, "gi"), "$1$2$1$3[redacted]")
    .replace(new RegExp(String.raw`(["'])(${TEXT_FIELD})\1(\s*:\s*)"(?:[^"\\]|\\.)*"?`, "gi"), "$1$2$1$3\"[redacted-text]\"")
    .replace(/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, "[redacted-token]")
    .replace(CREDENTIAL_PATH, "[redacted-path]")
    .replace(/\b(sk-ant-|sk-proj-|sk-|xai-|AIza|AKIA|murage_install_|sk_live_|sk_test_|rk_live_|whsec_|ghp_|gho_|github_pat_|xox[abpr]-|sb_secret_|sb_publishable_)[\w.-]+/gi, "[redacted-token]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[redacted-email]")
    .replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/\b[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}\b/gi, (m) => (m.split(":").length > 3 ? "[redacted-ip]" : m))
    .replace(/"[^"]{40,}"|'[^']{40,}'/g, "\"[redacted-text]\"")
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, "[redacted]");
}

async function requestLogs(request: Request, env: Env, identity: Identity, now: number): Promise<Response> {
  await requireStepUp(request, env, identity);
  const { account, h } = await customerHome(request, env);
  await readJSON(request, emptyBody);
  if (!ACTIVE_STATES.includes(h.desired_state)) throw new HTTPError(409, "home_inactive");
  await requireRunner(env, h);
  await limited(env, h, "logs", "customer", account, "logs", now);
  return underLease(env, h.id, async (lease) => {
    const cur = await currentHome(env, h);
    const id = crypto.randomUUID();
    await fencedBatch(env, lease, [...exactlyOne(commandQ(cur, id, "collect_logs", { maxLines: 480, redact: true, chatContent: false }, now)),
      auditQ(h.id, "customer", account, "logs", "requested", { commandId: id }, now)]).catch((e: unknown) => {
      if (e instanceof LeaseLost) throw e;
      throw new HTTPError(409, "state_conflict");
    });
    return json({ state: "requested", commandId: id, expiresAt: now + COMMAND_TTL_MS }, 202);
  });
}

async function readLogs(request: Request, env: Env, identity: Identity, now: number): Promise<Response> {
  await requireStepUp(request, env, identity);
  const { account, h } = await customerHome(request, env);
  // The bound continuation of an emailed approval reads exactly the collection that request made (step-up-email.ts), nothing else.
  const only = pinnedLogsCommand(request);
  const rows = await env.DB.prepare(`SELECT chunk,command_id,lines,collected_at FROM cloud_home_logs WHERE home_id=? AND expires_at>?
    ${only ? "AND command_id=?" : ""} ORDER BY chunk`)
    .bind(h.id, now, ...(only ? [only] : [])).all<{ chunk: number; command_id: string; lines: string; collected_at: number }>();
  const pending = await env.DB.prepare(`SELECT 1 AS x FROM cloud_home_commands WHERE home_id=? AND kind='collect_logs' AND acked_at IS NULL
    AND ((picked_at IS NULL AND expires_at>?) OR run_deadline>?) ${only ? "AND id=?" : ""} LIMIT 1`).bind(h.id, now, now, ...(only ? [only] : [])).first();
  await audit(env, h.id, "customer", account, "logs_read", "ok", { lines: rows.results.length }, now);
  return json({ pending: pending !== null, collectedAt: rows.results.length ? Math.max(...rows.results.map((r) => r.collected_at)) : null,
    lines: rows.results.flatMap((r) => JSON.parse(r.lines) as JSONValue[]) });
}

async function auditLog(env: Env, h: Home): Promise<Response> {
  const rows = await env.DB.prepare("SELECT actor,action,outcome,detail,at FROM selfservice_audit WHERE home_id=? ORDER BY at DESC,rowid DESC LIMIT 50")
    .bind(h.id).all<{ actor: string; action: string; outcome: string; detail: string; at: number }>();
  return json({ entries: rows.results.map((r) => ({ actor: r.actor, action: r.action, outcome: r.outcome, at: r.at, detail: JSON.parse(r.detail) as JSONValue })) });
}

// ---- export (S7) ----------------------------------------------------------------------------------------------------------------

async function toManual(env: Env, homeId: string, requestId: string, deliverBy: number, why: string, now: number) {
  await env.DB.prepare("UPDATE cloud_export_jobs SET state='manual' WHERE request_id=? AND state='requested'").bind(requestId).run();
  await raiseAlert(env, { homeId, kind: "export.manual_needed", severity: "high", detail: `export ${requestId} must be sent by hand by ${isoDate(deliverBy)}: ${why}` }, now);
}

/** Called when a customer's export request is recorded (legal-routes.ts). Every request is accepted (legal requests are never capped);
 *  archives are not: a request made while an export job runs shares that job's archive; otherwise it waits for the home's job slot and
 *  every request waiting on a home shares the next archive, within the home's archive storage budget. A home that cannot run it goes to
 *  the operator path at once (an alert; /v1/admin/export-delivered still closes it). Never throws: the request stands either way. */
export async function queueExportArchive(env: Env, homeId: string, requestId: string, deliverBy: number, now: number): Promise<void> {
  try {
    const h = await loadHome(env.DB, homeId);
    await env.DB.prepare(`INSERT INTO cloud_export_jobs (request_id,home_id,state,requested_at,deliver_by,archive_id) VALUES (?,?,'requested',?,?,?)
      ON CONFLICT(request_id) DO NOTHING`).bind(requestId, homeId, now, deliverBy, requestId).run();
    const live = ACTIVE_STATES.includes(h.desired_state)
      && await env.DB.prepare("SELECT 1 AS x FROM cloud_machines WHERE id=? AND state='active' AND generation=?").bind(h.id, h.generation).first()
      && await runnerKnown(env, h);
    if (!live) { await toManual(env, homeId, requestId, deliverBy, `the home is ${h.desired_state} or cannot build it`, now); return; }
    const running = await activeJob(env, homeId, now);
    if (running?.kind === "export") {
      await env.DB.prepare("UPDATE cloud_export_jobs SET command_id=?,archive_id=? WHERE request_id=? AND state='requested' AND command_id IS NULL")
        .bind(running.id, running.ref, requestId).run();
      return;
    }
    await admitWaitingExports(env, now, homeId);
  } catch (e) {
    console.error(JSON.stringify({ message: "export automation not queued", requestId, errorCode: e instanceof Error ? e.message.slice(0, 80) : "unknown" }));
  }
}

/** Waiting export requests (no command yet) take a free job slot: one archive for every request waiting on that home, sized within
 *  what is left of its storage budget. */
async function admitWaitingExports(env: Env, now: number, homeId?: string) {
  const waiting = await env.DB.prepare(`SELECT request_id,home_id,deliver_by FROM cloud_export_jobs WHERE state='requested' AND command_id IS NULL
    ${homeId ? "AND home_id=?" : ""} ORDER BY requested_at LIMIT 20`).bind(...(homeId ? [homeId] : [])).all<{ request_id: string; home_id: string; deliver_by: number }>();
  const seen = new Set<string>();
  for (const w of waiting.results) {
    if (seen.has(w.home_id)) continue;
    seen.add(w.home_id);
    try {
      const h = await loadHome(env.DB, w.home_id);
      if (!ACTIVE_STATES.includes(h.desired_state) || !await runnerKnown(env, h)) {
        await toManual(env, h.id, w.request_id, w.deliver_by, `the home is ${h.desired_state} or cannot build it`, now);
        continue;
      }
      const retained = await env.DB.prepare(`SELECT COALESCE(SUM(bytes),0) AS n FROM cloud_export_jobs WHERE home_id=? AND request_id=archive_id
        AND state='ready' AND purged_at IS NULL`).bind(h.id).first<{ n: number }>();
      const room = EXPORT_STORAGE_BUDGET_BYTES - (retained?.n ?? 0);
      if (room < EXPORT_MIN_ROOM_BYTES) {
        await toManual(env, h.id, w.request_id, w.deliver_by, "the home's export storage budget is used by archives still available", now);
        continue;
      }
      await admitJob(env, null, h, "export", w.request_id, "export_archive", { requestId: w.request_id, deliverBy: w.deliver_by, format: "tar.zst.age",
        path: `exports/${w.request_id}/archive.tar.zst.age`, maxBytes: room }, now, EXPORT_COMMAND_TTL_MS,
      (cmd) => [
        ...exactlyOne(q("UPDATE cloud_export_jobs SET command_id=?,archive_id=? WHERE request_id=? AND state='requested' AND command_id IS NULL", cmd, w.request_id, w.request_id)),
        q("UPDATE cloud_export_jobs SET command_id=?,archive_id=? WHERE home_id=? AND state='requested' AND command_id IS NULL", cmd, w.request_id, h.id),
      ]);
    } catch (e) {
      if (!(e instanceof HTTPError && e.status === 409)) {
        console.error(JSON.stringify({ message: "export admission failed", requestId: w.request_id, errorCode: e instanceof Error ? e.message.slice(0, 80) : "unknown" }));
        continue;
      }
      // Another request's export won the slot at the same moment: share its archive.
      const running = await env.DB.prepare("SELECT id,ref FROM cloud_home_jobs WHERE home_id=? AND state='active' AND kind='export'").bind(w.home_id)
        .first<{ id: string; ref: string }>();
      if (running) {
        await env.DB.prepare("UPDATE cloud_export_jobs SET command_id=?,archive_id=? WHERE home_id=? AND state='requested' AND command_id IS NULL")
          .bind(running.id, running.ref, w.home_id).run();
      }
    }
  }
}

/** When the home's data is scheduled to be deleted, if it is: the end of a suspended home's retention, or an open members-area or
 *  operator hold that deletes or wipes it. Null when nothing is scheduled. */
async function scheduledDeletion(env: Env, h: Home): Promise<number | null> {
  const hold = await env.DB.prepare(`SELECT MIN(completes_at) AS at FROM cloud_recovery_holds WHERE home_id=? AND action IN ('delete','start_fresh')
    AND completed_at IS NULL AND canceled_at IS NULL`).bind(h.id).first<{ at: number | null }>();
  const times = [hold?.at ?? null, h.desired_state === "suspended" ? h.delete_after : null].filter((t): t is number => typeof t === "number");
  return times.length ? Math.min(...times) : null;
}
/** The download date a ready archive is promised, and the one shown everywhere: EXPORT_AVAILABLE_MS, capped at the home's scheduled
 *  deletion (but never under EXPORT_MIN_AVAILABLE_MS, so a request answered hours before the deletion still gets a usable window).
 *  Whatever is promised is kept: an archive still within it survives the home's deletion (b5-backup.ts purgeBackup) until then. */
export const EXPORT_MIN_AVAILABLE_MS = DAY;
async function exportAvailableUntil(env: Env, h: Home, now: number): Promise<number> {
  const deletion = await scheduledDeletion(env, h);
  const capped = deletion === null ? now + EXPORT_AVAILABLE_MS : Math.min(now + EXPORT_AVAILABLE_MS, deletion);
  return Math.max(capped, now + EXPORT_MIN_AVAILABLE_MS);
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromB64url = (v: string) => Uint8Array.from(atob(v.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(v.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ gen[i]) >>> 0;
  }
  return chk;
}
/** The age X25519 identity for 32 secret bytes, exactly as age-keygen writes it: AGE-SECRET-KEY-1... (bech32, upper case), so the
 *  member can save it to a file and run `age -d -i key.txt` directly. Same encoding as murage-commands age_identity(). */
export function ageIdentity(key: Uint8Array): string {
  if (key.length !== 32) throw new Error("invalid_key");
  const hrp = "age-secret-key-";
  const data: number[] = [];
  let acc = 0; let bits = 0;
  for (const byte of key) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); }
    acc &= (1 << bits) - 1;
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = bech32Polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => BECH32[d]).join("")}`.toUpperCase();
}

/** The signed-in member's account, whether or not they still have a home (a deleted home's archive stays theirs). */
async function customerAccount(request: Request): Promise<string> {
  const s = await boundCustomer(request)?.resolve();
  if (!s) throw new HTTPError(401, "unauthorized");
  return s.user.id;
}
/** Exports are authorised by request id and historical ownership (the account that asked for it, or that owned the home), never by
 *  the member's current home: an archive kept past its home's deletion is still theirs until available_until. */
const OWNED_EXPORT = `FROM cloud_export_jobs j JOIN cloud_homes h ON h.id=j.home_id
  WHERE (h.owner_id=? OR EXISTS (SELECT 1 FROM data_export_requests r WHERE r.id=j.request_id AND r.user_id=?))`;

async function listExports(request: Request, env: Env, now: number): Promise<Response> {
  const account = await customerAccount(request);
  const rows = await env.DB.prepare(`SELECT j.request_id,j.home_id,j.state,j.requested_at,j.ready_at,j.available_until,j.bytes ${OWNED_EXPORT}
    AND (j.state IN ('requested','manual') OR (j.state='ready' AND j.available_until>?)) ORDER BY j.requested_at DESC LIMIT 20`)
    .bind(account, account, now).all<{ request_id: string; home_id: string; state: string; requested_at: number; ready_at: number | null; available_until: number | null; bytes: number | null }>();
  return json({ exports: rows.results.map((r) => ({ requestId: r.request_id, homeId: r.home_id, state: r.state, requestedAt: r.requested_at,
    readyAt: r.ready_at, availableUntil: r.available_until, bytes: r.bytes })) });
}

async function exportDownloadLink(request: Request, env: Env, identity: Identity, now: number): Promise<Response> {
  await requireStepUp(request, env, identity);
  const account = await customerAccount(request);
  const input = await readJSON(request, requestIdBody);
  const job = await env.DB.prepare(`SELECT j.* ${OWNED_EXPORT} AND j.request_id=?`).bind(account, account, input.requestId)
    .first<{ request_id: string; home_id: string; archive_id: string | null; state: string; available_until: number | null; wrapped_key: string | null; format: string; bytes: number; sha256: string }>();
  if (!job) throw new HTTPError(404, "not_found");
  const h = await loadHome(env.DB, job.home_id);
  if (job.state !== "ready" || job.available_until === null || job.available_until <= now) throw new HTTPError(409, "export_not_ready");
  await limited(env, h, "export_download", "customer", account, "export_download", now);
  const archive = job.archive_id ?? job.request_id;
  // The key is shown exactly once per archive (every request sharing it): whoever inserts the disclosure row gets it, in the same batch
  // that drops the wrapped key. Later links download the same encrypted archive without it.
  const shownBefore = await env.DB.prepare("SELECT 1 AS x FROM cloud_export_key_disclosures WHERE archive_id=?").bind(archive).first() !== null;
  const keyBytes = !shownBefore && job.wrapped_key ? await keyWrapperFor(env).unwrap(h.id, job.wrapped_key) : null;
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  // A step-up operation journals the link's issuance first (step-up-op.ts): a superseded runner stops here and discloses nothing.
  await journalDispatch(env, `export:${job.request_id}`);
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO cloud_export_downloads (token_hash,request_id,account_id,created_at,expires_at) VALUES (?,?,?,?,?)")
      .bind(await sha256(token), job.request_id, account, now, now + DOWNLOAD_TOKEN_MS),
    env.DB.prepare(keyBytes ? "INSERT OR IGNORE INTO cloud_export_key_disclosures (archive_id,account_id,disclosed_at) VALUES (?,?,?)"
      : "SELECT ?,?,? WHERE 0").bind(archive, account, now),
    env.DB.prepare(keyBytes ? "UPDATE cloud_export_jobs SET wrapped_key=NULL WHERE archive_id=? OR request_id=?" : "SELECT ?,? WHERE 0").bind(archive, archive),
    env.DB.prepare("INSERT INTO selfservice_audit (id,home_id,actor,account_id,action,outcome,detail,at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), h.id, "customer", account, "export_download", keyBytes ? "link_and_key_issued" : "link_issued",
        JSON.stringify({ requestId: job.request_id }), now),
  ]);
  const disclosed = keyBytes !== null && results[1].meta.changes === 1;
  return json({ url: `/v1/export-download/${token}`, expiresAt: now + DOWNLOAD_TOKEN_MS, key: disclosed ? ageIdentity(keyBytes) : null,
    keyFormat: "age-identity", keyShownBefore: !disclosed, format: job.format, bytes: job.bytes, sha256: job.sha256, availableUntil: job.available_until });
}

function boxFor(env: Env, deps: SelfServiceDependencies, boxId: number): StorageBoxAdapter | null {
  if (deps.storageBox) return deps.storageBox(boxId);
  const box = (provisionerConfig(env).storageBox ?? []).find((b) => b.id === boxId);
  return box && env.STORAGEBOX_API_TOKEN && env.STORAGEBOX_MAIN_PASSWORD
    ? hetznerStorageBox(env.STORAGEBOX_API_TOKEN, box, env.STORAGEBOX_MAIN_PASSWORD) : null;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** The archive download. The token (from the MFA-gated link) is the only credential: 10 minutes, 3 uses, one export. The request is
 *  closed (deletion may then resume) only when a download completes: every byte streamed, the advertised size and SHA-256 matched.
 *  Starting a transfer, a failed or cut-off stream, or an expired token closes nothing. */
export async function exportDownload(request: Request, env: Env, deps: SelfServiceDependencies, token: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HTTPError(404, "not_found");
  const now = Date.now();
  const use = await env.DB.prepare(`UPDATE cloud_export_downloads SET uses=uses+1 WHERE token_hash=? AND expires_at>? AND uses<? RETURNING request_id,uses`)
    .bind(await sha256(token), now, DOWNLOAD_TOKEN_USES).first<{ request_id: string; uses: number }>();
  if (!use) throw new HTTPError(404, "not_found");
  const job = await env.DB.prepare("SELECT * FROM cloud_export_jobs WHERE request_id=? AND state='ready' AND available_until>?").bind(use.request_id, now)
    .first<{ request_id: string; home_id: string; file: string; directory: string; box_id: number; bytes: number; sha256: string; downloaded_at: number | null }>();
  if (!job) throw new HTTPError(404, "not_found");
  const box = boxFor(env, deps, job.box_id);
  if (!box?.download) throw new HTTPError(503, "export_unavailable");
  let upstream: Response;
  try { upstream = await box.download(`${job.directory}/${job.file}`); }
  catch { throw new HTTPError(503, "export_unavailable"); }
  if (!upstream.body) throw new HTTPError(503, "export_unavailable");
  let seen = 0;
  // workerd's streaming SHA-256 (crypto.DigestStream), typed here because the Node types in this project shadow Crypto.
  const digest = new (crypto as unknown as { DigestStream: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } })
    .DigestStream("SHA-256");
  const writer = digest.getWriter();
  const delivered = async () => {
    const at = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_export_jobs SET downloaded_at=? WHERE request_id=? AND downloaded_at IS NULL").bind(at, job.request_id),
      env.DB.prepare("UPDATE data_export_requests SET status='delivered',delivered_at=?,closed_at=? WHERE id=? AND status IN ('open','expired')")
        .bind(at, at, job.request_id),
      env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE home_id=? AND kind='export_requested' AND resolved_at IS NULL").bind(at, job.home_id),
      env.DB.prepare("INSERT INTO selfservice_audit (id,home_id,actor,account_id,action,outcome,detail,at) VALUES (?,?,'customer',NULL,'export_download','downloaded',?,?)")
        .bind(crypto.randomUUID(), job.home_id, JSON.stringify({ requestId: job.request_id }), at),
    ]);
    const text = "You downloaded the copy of your Murage Cloud data you asked for. Your request is closed.";
    await emailOwner(env, deps, null, job.home_id, "export_delivered", job.request_id, { requestId: job.request_id, emailText: text, emailHtml: htmlOf(text) });
  };
  const verified = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > job.bytes) throw new Error("export_size_mismatch");
      await writer.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      await writer.close();
      if (seen !== job.bytes || hex(await digest.digest) !== job.sha256) return; // not the archive we advertised: nothing closes
      if (job.downloaded_at !== null) return;
      try { await delivered(); } catch { /* the next complete download closes it */ }
    },
  });
  return new Response(upstream.body.pipeThrough(verified), { status: 200, headers: {
    "content-type": "application/octet-stream", "content-length": String(job.bytes),
    "content-disposition": `attachment; filename="murage-export-${job.request_id}.tar.zst.age"`,
  } });
}

// ---- home-side routes -----------------------------------------------------------------------------------------------------------

const ackBody = z.object({ generation: z.number().int().positive(), commandId: z.string().uuid(),
  outcome: z.enum(["done", "failed", "unsupported"]) }).strict();
const readyBody = z.object({ generation: z.number().int().positive(), commandId: z.string().uuid(), requestId: z.string().regex(/^[\w-]{1,128}$/),
  file: z.string().max(200), format: z.literal("tar.zst.age"), bytes: z.number().int().positive().max(2 ** 45),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
interface CommandRow { id: string; kind: string; payload: string; acked_at: number | null; outcome: string | null; expires_at: number;
  picked_at: number | null; run_deadline: number | null }

export async function selfServiceMachineRoute(request: Request, env: Env, deps: SelfServiceDependencies = {}): Promise<Response | null> {
  const m = /^\/v1\/machines\/([\w-]{1,128})\/(commands|commands\/ack|logs|export-ready)$/.exec(new URL(request.url).pathname);
  if (!m) return null;
  if (request.method !== (m[2] === "commands" ? "GET" : "POST")) throw new HTTPError(405, "method_not_allowed");
  const h = await env.DB.prepare("SELECT * FROM cloud_homes WHERE id=?").bind(m[1]).first<Home>();
  if (!h) throw new HTTPError(401, "unauthorized"); // same answer as a bad credential: no existence oracle
  await machine(request, env, h);
  const now = Date.now();
  if (m[2] === "commands") {
    // The poll marks the runner as present at this generation and picks every pending command once: from now each has its run deadline,
    // which is what the home sees as expiresAt. A command not picked before it expires is never offered.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_home_runner (home_id,generation,polled_at) VALUES (?,?,?)
        ON CONFLICT(home_id) DO UPDATE SET generation=excluded.generation,polled_at=excluded.polled_at`).bind(h.id, h.generation, now),
      env.DB.prepare(`UPDATE cloud_home_commands SET picked_at=?,run_deadline=?+CASE kind ${Object.entries(RUN_MS).map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(" ")} ELSE ${COMMAND_TTL_MS} END
        WHERE home_id=? AND generation=? AND acked_at IS NULL AND picked_at IS NULL AND expires_at>?`).bind(now, now, h.id, h.generation, now),
    ]);
    const rows = await env.DB.prepare(`SELECT id,kind,payload,created_at,run_deadline FROM cloud_home_commands
      WHERE home_id=? AND generation=? AND acked_at IS NULL AND picked_at IS NOT NULL AND run_deadline>? ORDER BY created_at,rowid LIMIT 10`)
      .bind(h.id, h.generation, now).all<{ id: string; kind: string; payload: string; created_at: number; run_deadline: number }>();
    return json({ homeId: h.id, generation: h.generation, pollEveryMs: MINUTE,
      commands: rows.results.map((c) => ({ id: c.id, kind: c.kind, payload: JSON.parse(c.payload) as JSONValue, issuedAt: c.created_at, expiresAt: c.run_deadline })) });
  }
  const command = async (id: string, generation: number, kind?: string) => {
    if (generation !== h.generation) throw new HTTPError(409, "stale_generation");
    const row = await env.DB.prepare("SELECT * FROM cloud_home_commands WHERE id=? AND home_id=? AND generation=?").bind(id, h.id, h.generation)
      .first<CommandRow>();
    if (!row || (kind && row.kind !== kind)) throw new HTTPError(404, "not_found");
    return row;
  };
  if (m[2] === "commands/ack") {
    const input = await readJSON(request, ackBody);
    const row = await command(input.commandId, input.generation);
    const job = JOB_OF_COMMAND[row.kind] ? await env.DB.prepare("SELECT * FROM cloud_home_jobs WHERE id=?").bind(row.id).first<JobRow>() : null;
    // Export success is only export-ready; an ack for an export is a failure (or a duplicate).
    const outcome: JobOutcome = job?.kind === "export" && input.outcome === "done" ? "failed" : input.outcome;
    // A reset or undo that timed out without an answer is unknown, not failed: the home's late result settles it now.
    const late = job !== null && job.state === "expired" && job.outcome === "timed_out" && (job.kind === "reset" || job.kind === "undo");
    try {
      // One batch: the command is answered once, and its job (if any) is closed by this command id only.
      await runBatch(env, null, [
        ...exactlyOne(q("UPDATE cloud_home_commands SET acked_at=?,outcome=? WHERE id=? AND acked_at IS NULL", now, input.outcome, row.id)),
        ...(job ? late ? lateResultQ(job, input.outcome, now, row.picked_at) : closeJobQ(job, outcome, now, false) : []),
      ]);
      if (late) await audit(env, h.id, "operator", null, `job_${job!.kind}`, `late_${input.outcome}`, { jobId: job!.id }, now);
    } catch {
      const stored = await env.DB.prepare("SELECT acked_at,outcome FROM cloud_home_commands WHERE id=?").bind(row.id).first<{ acked_at: number | null; outcome: string | null }>();
      // An identical duplicate gets the stored result; a conflicting or superseded one changes nothing.
      if (stored?.acked_at != null && stored.outcome === input.outcome) return json({ acknowledged: true });
      throw new HTTPError(409, "ack_conflict");
    }
    if (job?.kind === "export") {
      await raiseAlert(env, { homeId: h.id, kind: "export.manual_needed", severity: "high", detail: `export job ${job.id}: the home answered ${input.outcome}` }, now);
    }
    if (job) await admitWaitingExports(env, now, h.id);
    return json({ acknowledged: true });
  }
  if (m[2] === "logs") {
    const input = await readJSON(request, logsBody);
    const row = await command(input.commandId, input.generation, "collect_logs");
    if (row.acked_at !== null || row.run_deadline === null || row.run_deadline <= now) throw new HTTPError(409, "command_expired");
    // Allowed events only (anything else is reduced to the fact a line existed); then scrubbed again as a second line of defence.
    const lines = input.lines.map((l) => ({ ...l, message: redact(allowedLogMessage(l.message)) }));
    await env.DB.batch([
      ...(input.chunk === 0 ? [env.DB.prepare("DELETE FROM cloud_home_logs WHERE home_id=?").bind(h.id)] : []),
      env.DB.prepare(`INSERT INTO cloud_home_logs (home_id,chunk,command_id,lines,collected_at,expires_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(home_id,chunk) DO UPDATE SET command_id=excluded.command_id,lines=excluded.lines,collected_at=excluded.collected_at,expires_at=excluded.expires_at`)
        .bind(h.id, input.chunk, row.id, JSON.stringify(lines), now, now + LOG_TTL_MS),
      ...(input.final ? [env.DB.prepare("UPDATE cloud_home_commands SET acked_at=?,outcome='done' WHERE id=? AND acked_at IS NULL").bind(now, row.id)] : []),
    ]);
    return json({ accepted: true, lines: lines.length });
  }
  const input = await readJSON(request, readyBody);
  const row = await command(input.commandId, input.generation, "export_archive");
  const payload = JSON.parse(row.payload) as { requestId: string; maxBytes?: number };
  if (payload.requestId !== input.requestId || input.file !== `exports/${input.requestId}/archive.tar.zst.age`) throw new HTTPError(400, "invalid_request");
  const archive = await env.DB.prepare("SELECT state FROM cloud_export_jobs WHERE request_id=? AND home_id=?").bind(input.requestId, h.id).first<{ state: string }>();
  if (!archive) throw new HTTPError(404, "not_found");
  if (archive.state === "ready" && row.acked_at !== null) return json({ accepted: true, existing: true });
  const job = await env.DB.prepare("SELECT * FROM cloud_home_jobs WHERE id=? AND state='active'").bind(row.id).first<JobRow>();
  if (!job || row.acked_at !== null || row.run_deadline === null || row.run_deadline <= now) throw new HTTPError(409, "command_expired");
  if (payload.maxBytes !== undefined && input.bytes > payload.maxBytes) {
    await runBatch(env, null, [...exactlyOne(q("UPDATE cloud_home_commands SET acked_at=?,outcome='failed' WHERE id=? AND acked_at IS NULL", now, row.id)),
      ...closeJobQ(job, "failed", now, false)]);
    await raiseAlert(env, { homeId: h.id, kind: "export.manual_needed", severity: "high", detail: `export ${input.requestId}: archive over the storage budget` }, now);
    throw new HTTPError(409, "export_over_budget");
  }
  const space = await env.DB.prepare(`SELECT box_id,directory FROM backup_subaccounts WHERE home_id=? AND resource_generation=? AND deleted_at IS NULL`)
    .bind(h.id, h.resource_generation).first<{ box_id: number; directory: string }>();
  if (!space) throw new HTTPError(409, "backup_space_missing");
  const key = fromB64url(input.key);
  if (key.length !== 32) throw new HTTPError(400, "invalid_request");
  const wrapped = await keyWrapperFor(env).wrap(h.id, key);
  const until = await exportAvailableUntil(env, h, now);
  await runBatch(env, null, [
    // Every request sharing this archive becomes ready with it.
    q(`UPDATE cloud_export_jobs SET state='ready',ready_at=?,available_until=?,file=?,format=?,bytes=?,sha256=?,wrapped_key=?,box_id=?,directory=?
      WHERE command_id=? AND state IN ('requested','manual')`,
    now, until, input.file, input.format, input.bytes, input.sha256, wrapped, space.box_id, space.directory, row.id),
    ...exactlyOne(q("UPDATE cloud_home_commands SET acked_at=?,outcome='done' WHERE id=? AND acked_at IS NULL", now, row.id)),
    ...closeJobQ(job, "done", now, false),
    q("UPDATE cloud_alerts SET resolved_at=? WHERE home_id=? AND kind='export.manual_needed' AND resolved_at IS NULL", now, h.id),
  ]);
  const served = await env.DB.prepare("SELECT request_id FROM cloud_export_jobs WHERE command_id=? AND state='ready'").bind(row.id).all<{ request_id: string }>();
  for (const { request_id: requestId } of served.results) {
    const text = `The copy of your Murage Cloud data you asked for is ready.\n\nDownload it from your Murage Cloud page in the members area until ${isoDate(until)}. `
      + "You will be asked for your authenticator code, and the page shows the key that opens the archive (it is encrypted; keep the key private).\n\n"
      + `Request ID: ${requestId}`;
    await emailOwner(env, deps, null, h.id, "export_ready", requestId, { requestId, emailText: text, emailHtml: htmlOf(text) });
  }
  await admitWaitingExports(env, now, h.id);
  return json({ accepted: true, availableUntil: until });
}

// ---- customer router ------------------------------------------------------------------------------------------------------------

export async function selfServiceRoute(request: Request, env: Env, identity: Identity, deps: SelfServiceDependencies = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/account/home" && !path.startsWith("/v1/account/home/") && path !== "/v1/account/export/download" && path !== "/v1/account/usage"
    && path !== "/v1/account/exports") return null;
  const method = request.method;
  const now = Date.now();
  if (path === "/v1/account/home/logs" && method === "GET") return readLogs(request, env, identity, now);
  if (path === "/v1/account/exports" && method === "GET") return listExports(request, env, now);
  if (method === "GET" && (path === "/v1/account/home" || path === "/v1/account/home/audit" || path === "/v1/account/usage")) {
    const { h } = await customerHome(request, env);
    return path === "/v1/account/home" ? status(env, h, now, deps) : path === "/v1/account/usage" ? usage(env, deps, h, now) : auditLog(env, h);
  }
  if (method !== "POST") throw new HTTPError(405, "method_not_allowed");
  switch (path) {
    case "/v1/account/home/hold": return openHold(request, env, deps, identity, now);
    case "/v1/account/home/hold/cancel": return cancelCustomerHold(request, env, deps, now);
    case "/v1/account/home/logs/request": return requestLogs(request, env, identity, now);
    case "/v1/account/export/download": return exportDownloadLink(request, env, identity, now);
    case "/v1/account/home/reset": return resetHome(request, env, deps, identity, now);
    case "/v1/account/home/reset/undo": return undoReset(request, env, deps, identity, now);
  }
  const { account, h } = await customerHome(request, env);
  await readJSON(request, emptyBody);
  switch (path) {
    case "/v1/account/home/restart": return direct(env, deps, h, account, "restart", now);
    case "/v1/account/home/reboot": return direct(env, deps, h, account, "reboot", now);
    case "/v1/account/home/start": return direct(env, deps, h, account, "start", now);
    case "/v1/account/home/safe-mode": return direct(env, deps, h, account, "safe_mode", now);
    case "/v1/account/home/update": return updateSoftware(env, deps, h, account, now);
    case "/v1/account/home/retry-provisioning": {
      await limited(env, h, "retry_provisioning", "customer", account, "retry_provisioning", now);
      if (h.desired_state !== "provisioning" && h.desired_state !== "failed") throw new HTTPError(409, "not_provisioning");
      // The control plane already re-runs provisioning (5 attempts with backoff, one lease at a time); forcing an attempt early could
      // run two at once. A given-up home was refunded in full: it starts again with a new checkout, never a silent re-charge.
      await audit(env, h.id, "customer", account, "retry_provisioning", h.desired_state === "failed" ? "given_up" : "in_progress", {}, now);
      return json({ provisioning: await provisioningView(env, h) });
    }
    case "/v1/account/home/fix-it": {
      if (h.desired_state === "provisioning" || h.desired_state === "failed") {
        return json({ fixIt: null, provisioning: await provisioningView(env, h) });
      }
      if (!ACTIVE_STATES.includes(h.desired_state)) throw new HTTPError(409, "home_inactive");
      const job = await activeJob(env, h.id, now, deps);
      if (job) throw new HTTPError(409, "job_in_progress", { job: job.kind });
      await limited(env, h, "fixit", "customer", account, "fix_it", now);
      const run = await underLease(env, h.id, async (lease) => startFixIt(env, deps, lease, await currentHome(env, h), "customer", account, now));
      return json({ fixIt: runView(run) }, run.finished_at === null ? 202 : 200);
    }
  }
  throw new HTTPError(404, "not_found");
}

// ---- cron: jobs, Fix-it runs, the watchdog, holds, exports, retention ------------------------------------------------------------

export async function sweepSelfService(env: Env, deps: SelfServiceDependencies = {}, now = Date.now()): Promise<void> {
  const step = async (name: string, work: () => Promise<void>) => {
    try { await work(); } catch (e) {
      console.error(JSON.stringify({ message: "self-service sweep step failed", step: name, errorCode: e instanceof Error ? e.message.slice(0, 80) : "unknown" }));
    }
  };
  await step("power", () => settlePower(env, deps, now));
  await step("jobs", () => reconcileJobs(env, now));
  if (b3Enabled(env)) {
    await step("fixit", () => advanceOpenRuns(env, deps, now));
    await step("watchdog", () => watchdog(env, deps, now));
    await step("holds", () => completeDueHolds(env, deps, now));
  }
  await step("exports", () => sweepExports(env, deps, now));
  await step("retention", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM selfservice_rate_limits WHERE window_started_at<?").bind(now - 2 * DAY),
      // The home forgets its pre-reset snapshot RESET_SNAPSHOT_KEEP_DAYS after completion; the record stops offering Undo at 7 days.
      env.DB.prepare("UPDATE cloud_resets SET state='expired' WHERE state='done' AND keep_until<=?").bind(now),
      // Answered commands a day after their answer; unanswered ones a day past their last deadline; never a running job's command. A
      // picked reset or undo with no answer is kept 30 days, so the home's late result can still settle its unknown outcome.
      env.DB.prepare(`DELETE FROM cloud_home_commands WHERE id NOT IN (SELECT id FROM cloud_home_jobs WHERE state='active')
        AND ((acked_at IS NOT NULL AND acked_at<?) OR (acked_at IS NULL AND COALESCE(run_deadline,expires_at)<?
          AND NOT (picked_at IS NOT NULL AND kind IN ('reset_from_backup','undo_reset') AND run_deadline>=?)))`).bind(now - DAY, now - DAY, now - 30 * DAY),
      env.DB.prepare("DELETE FROM cloud_home_logs WHERE expires_at<?").bind(now),
      env.DB.prepare("DELETE FROM cloud_export_downloads WHERE expires_at<?").bind(now - DAY),
      env.DB.prepare("DELETE FROM selfservice_audit WHERE at<?").bind(now - AUDIT_RETENTION_MS),
      env.DB.prepare("DELETE FROM cloud_fixit_runs WHERE finished_at IS NOT NULL AND finished_at<?").bind(now - AUDIT_RETENTION_MS),
      env.DB.prepare("DELETE FROM cloud_home_jobs WHERE state<>'active' AND finished_at<?").bind(now - AUDIT_RETENTION_MS),
    ]);
  });
}

async function advanceOpenRuns(env: Env, deps: SelfServiceDependencies, now: number) {
  const open = await env.DB.prepare("SELECT * FROM cloud_fixit_runs WHERE finished_at IS NULL ORDER BY next_at LIMIT 50").all<RunRow>();
  for (const run of open.results) {
    try {
      await withHomeLease(env, run.home_id, async (lease) => {
        const fresh = await env.DB.prepare("SELECT * FROM cloud_fixit_runs WHERE id=? AND finished_at IS NULL").bind(run.id).first<RunRow>();
        if (fresh) await advanceFixIt(env, deps, lease, await loadHome(env.DB, run.home_id), fresh, now);
      }, deps.billing?.lease);
    } catch { /* busy or failed: the next tick tries again */ }
  }
}

/** A home that should be running but whose app has not answered for WATCHDOG_STALE_MS gets the Fix-it ladder, bounded: one open run per
 *  home, a cooldown after each run, LIMITS.wd_run runs a day (charged only when a run is admitted under the lease) and the watchdog's own
 *  restart/reboot budget. Fair: homes whose daily budget is spent and already alerted are not selected at all, and the longest-silent
 *  homes come first, so exhausted homes never crowd out the rest. Past the budget it stops and raises one ops alert
 *  (home.watchdog_exhausted); it never restores, rolls back or deletes anything, and never acts while a data job runs. */
async function watchdog(env: Env, deps: SelfServiceDependencies, now: number) {
  const [max, windowMs] = LIMITS.wd_run[0];
  const live = "COALESCE(CASE WHEN x.app_reported_at IS NOT NULL THEN x.app_ok_at ELSE h.heartbeat_at END, h.updated_at)";
  const silent = await env.DB.prepare(`SELECT h.* FROM cloud_homes h LEFT JOIN cloud_home_health x ON x.home_id=h.id
    WHERE h.desired_state='ready' AND h.observed_state='ready' AND ${live}<?
      AND NOT EXISTS (SELECT 1 FROM cloud_fixit_runs r WHERE r.home_id=h.id AND (r.finished_at IS NULL
        OR (r.finished_at>? AND r.outcome IN ('needs_attention','watchdog_budget_spent','rate_limited','job_in_progress'))))
      AND NOT EXISTS (SELECT 1 FROM cloud_recovery_holds o WHERE o.home_id=h.id AND o.completed_at IS NULL AND o.canceled_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM cloud_home_jobs j WHERE j.home_id=h.id AND j.state='active')
      AND (NOT EXISTS (SELECT 1 FROM selfservice_rate_limits l WHERE l.subject='wd_run:' || ? || ':' || h.id AND l.window_started_at>? AND l.attempts>=?)
        OR NOT EXISTS (SELECT 1 FROM cloud_alerts a WHERE a.home_id=h.id AND a.kind='home.watchdog_exhausted' AND a.resolved_at IS NULL))
    ORDER BY ${live},h.id LIMIT 50`).bind(now - WATCHDOG_STALE_MS, now - WATCHDOG_COOLDOWN_MS, String(windowMs), now - windowMs, max).all<Home>();
  for (const h of silent.results) {
    try {
      await withHomeLease(env, h.id, async (lease) => {
        const cur = await loadHome(env.DB, h.id);
        if (cur.generation !== h.generation || cur.desired_state !== "ready") return;
        if (await env.DB.prepare("SELECT 1 AS x FROM cloud_fixit_runs WHERE home_id=? AND finished_at IS NULL").bind(h.id).first()) return;
        const budget = await takeLimit(env, h.id, "wd_run", now);
        if (!budget.ok) {
          if (await raiseAlert(env, { homeId: h.id, kind: "home.watchdog_exhausted", severity: "high",
            detail: `silent ${Math.floor((now - (liveAt(cur, await appHealth(env, h.id)) ?? cur.updated_at)) / MINUTE)} min; ${max} automatic Fix-it runs today did not heal it` }, now)) {
            await audit(env, h.id, "watchdog", null, "fix_it", "budget_spent", {}, now);
          }
          return;
        }
        await startFixIt(env, deps, lease, cur, "watchdog", null, now);
      }, deps.billing?.lease);
    } catch { /* busy: the next tick looks again */ }
  }
}

async function sweepExports(env: Env, deps: SelfServiceDependencies, now: number) {
  await admitWaitingExports(env, now);
  const late = await env.DB.prepare("SELECT request_id,home_id,deliver_by FROM cloud_export_jobs WHERE state='requested' AND requested_at<? LIMIT 50")
    .bind(now - EXPORT_AUTOMATION_MS).all<{ request_id: string; home_id: string; deliver_by: number }>();
  for (const job of late.results) {
    await toManual(env, job.home_id, job.request_id, job.deliver_by, `not produced by the home in ${EXPORT_AUTOMATION_MS / HOUR} h`, now);
  }
  // One purge per archive; every request sharing it expires with it.
  const expired = await env.DB.prepare(`SELECT request_id,box_id,directory FROM cloud_export_jobs WHERE state='ready' AND request_id=archive_id
    AND available_until<=? AND purged_at IS NULL LIMIT 20`).bind(now).all<{ request_id: string; box_id: number; directory: string }>();
  for (const job of expired.results) {
    try {
      const box = boxFor(env, deps, job.box_id);
      if (!box) continue;
      await box.purgeDirectory(`${job.directory}/exports/${job.request_id}`);
      await env.DB.prepare("UPDATE cloud_export_jobs SET state='expired',purged_at=?,wrapped_key=NULL WHERE archive_id=? AND state='ready'").bind(now, job.request_id).run();
      // An archive kept past its home's deletion (b5-backup.ts retainReadyExports): the kept folder goes with the last one in it.
      if (isRetainedExports(job.directory) && !await env.DB.prepare("SELECT 1 AS x FROM cloud_export_jobs WHERE directory=? AND state='ready' AND purged_at IS NULL")
        .bind(job.directory).first()) await box.purgeDirectory(job.directory);
    } catch { /* retried next tick */ }
  }
}
