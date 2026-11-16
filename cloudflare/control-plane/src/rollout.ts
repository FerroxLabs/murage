// SPDX-License-Identifier: AGPL-3.0-or-later
// Home-update ROLLOUT CONTROLLER. The home side (Lane G, lanes/cloud-v2/LANE-G-UPDATE-STATE-MACHINE-r3.md) installs one signed sequence
// into the idle slot, verifies it, rolls itself back when it is unhealthy and goes Stuck when it cannot. This controller decides WHICH
// homes are asked to install a release and WHEN, so a bad release stops after a few homes, not the fleet.
//
// Operator routes (the existing CLOUD_ADMIN_TOKEN bearer, like every /v1/admin route; there is no customer route):
//   POST /v1/admin/rollout/releases                  {sequence, manifestRef}: a draft release (the sequence the signed channel manifest names)
//   GET  /v1/admin/rollout/releases                  the releases, newest first
//   GET  /v1/admin/rollout/releases/<id>             one release: its state, wave, per-wave counts and every home that failed
//   POST /v1/admin/rollout/releases/<id>/start       draft -> rolling (one release at a time may be rolling or halted)
//   POST /v1/admin/rollout/releases/<id>/cancel      draft, rolling or halted -> cancelled; nothing further is sent, queued-but-unpicked commands expire
//   POST /v1/admin/rollout/releases/<id>/resume      halted -> rolling. The wave starts over: its failed homes are asked again, or with
//                                                    {"skipFailed":true} left out of the wave. Homes that updated stay where they are.
//   POST /v1/admin/rollout/homes/<homeId>/internal   {internal: boolean}: flag a home for wave 0 (our own and staging homes)
//
// Waves: 0 = homes flagged internal; 1 = 3 homes; 2 = 25% of the fleet (cumulative); 3 = every remaining home. A wave sends each home
// update_software with the release's TARGET sequence (reason "rollout") through the ordinary command path, its job slot and its lease.
// The wave is done when every home reported the target sequence healthy; then it SOAKS for ROLLOUT_SOAK_MS (default 2 h) with no
// rollback, no Stuck updater, no home.heartbeat_missed and no home.ui_render_missing on a wave home. Only then does the next wave start;
// after wave 3's soak the release is PROMOTED, which is what a customer's Update button installs (self-service latestPromotedSequence).
//
// HALT. A wave home that rolls back, goes Stuck, goes silent or unrendered during the soak, or does not report in time halts the release:
// nothing more is dispatched and ONE rollout.halted alert lists the homes. Homes that already updated stay where they are and every
// home's own Lane G rollback has already handled itself. THERE IS NO FLEET ROLLBACK: the home's sequence floor forbids installing a lower
// sequence, so going back means publishing the old build as a NEW release with a higher sequence and rolling that out.
//
// The sweep (cron, every 5 minutes) drives it: no loops, no timers. Each pass is idempotent and takes the release's own lease
// (cloud_releases.sweep_holder), and every dispatch takes the home's lease and job slot like the customer's button does.
import { z } from "zod";
import { admin } from "./b3-control";
import { readJSON } from "./b5-billing";
import { q, type Q } from "./billing-lease";
import { HTTPError, json, type JSONValue } from "./http";
import { ACTIVE_STATES, appOutcome, dispatchRolloutUpdate, healthy } from "./self-service";

const MINUTE = 60_000; const HOUR = 60 * MINUTE;
/** Soak after a wave is healthy, before the next wave. ROLLOUT_SOAK_MS overrides it (a plain var, never a secret). */
export const ROLLOUT_SOAK_MS = 2 * HOUR;
/** How long a dispatched home has to report the target sequence healthy (the home's run limit is 2 h; the rest is slack for its verify). */
export const ROLLOUT_REPORT_TIMEOUT_MS = 3 * HOUR;
export const WAVE1_HOMES = 3;
export const WAVE2_SHARE = 0.25;
/** Homes dispatched per sweep pass: a pass stays far inside D1's per-invocation query budget however large wave 3 is. */
export const ROLLOUT_DISPATCH_PER_PASS = 50;
/** The release's own lease: longer than a pass, so a pass that died frees itself on the next cron. */
const SWEEP_LEASE_MS = 4 * MINUTE;
/** Alerts that mean a wave home went silent or unrendered. */
const SOAK_ALERT_KINDS = ["home.heartbeat_missed", "home.ui_render_missing"] as const;
/** The sequence floor: what a home may already run. A release that started and was then cancelled counts (homes may have installed it); a draft never did. */
const FLOOR_SQL = "(state IN ('promoted','rolling','halted') OR (state='cancelled' AND started_at IS NOT NULL))";
export const ROLLOUT_HALTED_ALERT = "rollout.halted";
const MAX_SEQUENCE = 9007199254740991;

export interface RolloutOptions { soakMs?: number; reportTimeoutMs?: number; dispatchPerPass?: number }
type RolloutEnv = Env & { ROLLOUT_SOAK_MS?: string; ROLLOUT_REPORT_TIMEOUT_MS?: string };
const positive = (value: string | undefined, fallback: number): number => {
  const n = value === undefined ? NaN : Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
};
const options = (env: Env, o: RolloutOptions) => ({
  soakMs: o.soakMs ?? positive((env as RolloutEnv).ROLLOUT_SOAK_MS, ROLLOUT_SOAK_MS),
  reportTimeoutMs: o.reportTimeoutMs ?? positive((env as RolloutEnv).ROLLOUT_REPORT_TIMEOUT_MS, ROLLOUT_REPORT_TIMEOUT_MS),
  dispatchPerPass: o.dispatchPerPass ?? ROLLOUT_DISPATCH_PER_PASS,
});

export interface ReleaseRow {
  id: string; sequence: number; manifest_ref: string; state: "draft" | "rolling" | "halted" | "promoted" | "cancelled"; wave: number;
  wave_started_at: number | null; soak_started_at: number | null; halt_reason: string | null; created_at: number; started_at: number | null;
  halted_at: number | null; promoted_at: number | null; cancelled_at: number | null; updated_at: number; sweep_holder: string | null; sweep_until: number | null;
}
interface WaveRow {
  home_id: string; state: "pending" | "dispatched" | "updated" | "failed" | "skipped"; command_id: string | null; dispatched_at: number | null;
  healthy_at: number | null; failure: string | null; row_updated_at: number;
  generation: number; desired_state: string; observed_state: string; heartbeat_at: number | null;
  app_reported_at: number | null; app_ok_at: number | null; app_ok: number | null;
  installed_sequence: number | null; last_command_id: string | null; last_outcome: string | null; last_reason: string | null; stuck: string | null;
  cmd_acked_at: number | null; cmd_outcome: string | null;
}

const run = (env: Env, stmts: Q[]) => env.DB.batch(stmts.map(([sql, binds]) => env.DB.prepare(sql).bind(...(binds ?? []))));
async function runChunked(env: Env, stmts: Q[]) {
  for (let i = 0; i < stmts.length; i += 50) await run(env, stmts.slice(i, i + 50));
}
const guardOne = (): Q[] => {
  const g = crypto.randomUUID();
  return [q("INSERT INTO cloud_write_guards VALUES (?,changes())", g), q("DELETE FROM cloud_write_guards WHERE id=?", g)];
};
const releaseAlertHome = (id: string) => `release:${id}`;

// ---- selecting a wave -------------------------------------------------------------------------------------------------------------

const ELIGIBLE = `FROM cloud_homes h LEFT JOIN cloud_rollout_flags f ON f.home_id=h.id
  WHERE h.desired_state='ready' AND h.observed_state='ready' AND COALESCE(f.internal,0)=?`;
const NOT_IN_RELEASE = "AND h.id NOT IN (SELECT home_id FROM cloud_release_homes WHERE release_id=?)";

/** Which homes a wave takes: [internal flag, how many]. The choice is made once, when the wave starts, in ONE statement that also records it. */
async function waveSelection(env: Env, rel: ReleaseRow): Promise<[0 | 1, number]> {
  if (rel.wave === 0) return [1, 1_000_000];
  if (rel.wave === 1) return [0, WAVE1_HOMES];
  if (rel.wave === 3) return [0, 1_000_000];
  // Wave 2: the release reaches 25% of the (non-internal) fleet in total, counting the homes wave 1 already took.
  const fleet = (await env.DB.prepare(`SELECT COUNT(*) AS n ${ELIGIBLE}`).bind(0).first<{ n: number }>())!.n;
  const have = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM cloud_release_homes r LEFT JOIN cloud_rollout_flags f ON f.home_id=r.home_id
    WHERE r.release_id=? AND r.wave>=1 AND COALESCE(f.internal,0)=0`).bind(rel.id).first<{ n: number }>())!.n;
  return [0, Math.max(0, Math.ceil(fleet * WAVE2_SHARE) - have)];
}

/** The rows of one wave (cmp "="), or of every wave before it (cmp "<"). */
const waveRows = (env: Env, releaseId: string, wave: number, cmp: "=" | "<" = "=") => env.DB.prepare(`
  SELECT r.home_id,r.state,r.command_id,r.dispatched_at,r.healthy_at,r.failure,r.updated_at AS row_updated_at,
    h.generation,h.desired_state,h.observed_state,h.heartbeat_at,x.app_reported_at,x.app_ok_at,x.app_ok,
    u.installed_sequence,u.last_command_id,u.last_outcome,u.last_reason,u.stuck,c.acked_at AS cmd_acked_at,c.outcome AS cmd_outcome
  FROM cloud_release_homes r JOIN cloud_homes h ON h.id=r.home_id
    LEFT JOIN cloud_home_health x ON x.home_id=r.home_id
    LEFT JOIN cloud_home_update_reports u ON u.home_id=r.home_id AND u.generation=h.generation
    LEFT JOIN cloud_home_commands c ON c.id=r.command_id
  WHERE r.release_id=? AND r.wave${cmp}? ORDER BY r.home_id`).bind(releaseId, wave).all<WaveRow>();

// ---- judging one home -------------------------------------------------------------------------------------------------------------

type Verdict = { state: WaveRow["state"]; failure: string | null } | null;

/** What the home's own reports say about this wave home, or null when nothing changed. Failure checks come first: a home that rolled back
 *  or went Stuck is a failure whatever else it reports. */
function judge(row: WaveRow, target: number, now: number, reportTimeoutMs: number, waveStartedAt: number): Verdict {
  if (row.state === "failed" || row.state === "skipped") return null;
  if (!ACTIVE_STATES.includes(row.desired_state)) return { state: "skipped", failure: "home_inactive" }; // the home left the fleet
  if (row.stuck !== null) return { state: "failed", failure: `stuck:${row.stuck}` };
  if (row.command_id !== null && row.last_command_id === row.command_id && row.last_outcome === "failed") {
    return { state: "failed", failure: `rolled_back:${row.last_reason ?? "unknown"}` };
  }
  const atTarget = row.installed_sequence === target;
  if (row.state === "updated") return atTarget ? null : { state: "failed", failure: "regressed" };
  if (row.cmd_acked_at !== null && !atTarget && (row.cmd_outcome === "failed" || row.cmd_outcome === "unsupported")) {
    return { state: "failed", failure: `refused:${row.cmd_outcome}` };
  }
  const app = { app_reported_at: row.app_reported_at, app_ok_at: row.app_ok_at, app_ok: row.app_ok };
  if (atTarget && healthy({ desired_state: row.desired_state, observed_state: row.observed_state, heartbeat_at: row.heartbeat_at }, app, now)) {
    return { state: "updated", failure: null };
  }
  // A pending home's dispatch clock runs from the wave start, but never through time the controller itself held every dispatch back for
  // missing evidence on an updated home (the sweep refreshes a pending row's updated_at on every pass of such a hold): the home was not
  // late, it was not asked.
  const since = row.state === "dispatched" ? row.dispatched_at ?? waveStartedAt : Math.max(waveStartedAt, row.row_updated_at);
  if (now - since > reportTimeoutMs) return { state: "failed", failure: row.state === "dispatched" ? "no_report" : "not_dispatched" };
  return null;
}

// ---- the sweep --------------------------------------------------------------------------------------------------------------------

/** A monitoring gap longer than this (cron runs every minute) is time the soak could not see failures in. */
const MONITOR_BLIND_MS = 5 * 60_000;
/** Called after every SUCCESSFUL monitoring sweep. The soak's only health signal is what monitoring writes, so any interval in which it
 *  did not run is not soak time: it is added back to soak_started_at (never past now), and the soak ends that much later. */
export async function noteMonitoring(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare(`UPDATE cloud_releases SET
      soak_started_at=CASE WHEN soak_started_at IS NOT NULL AND ?1-MAX(COALESCE(monitored_at,0),soak_started_at)>?2
        THEN soak_started_at+(?1-MAX(COALESCE(monitored_at,0),soak_started_at)) ELSE soak_started_at END,
      monitored_at=?1 WHERE state='rolling'`).bind(now, MONITOR_BLIND_MS).run();
}

/** Cron entry. Drives the (one) rolling release a step; safe to run any number of times, and concurrently (the loser sees the lease). */
export async function sweepRollout(env: Env, now = Date.now(), o: RolloutOptions = {}): Promise<void> {
  // Retry path: a halt or cancel whose own withdraw did not land still ends here (the commands are found by release state, not by a recorded id).
  await withdrawStale(env, now);
  const rolling = await env.DB.prepare("SELECT id FROM cloud_releases WHERE state='rolling'").all<{ id: string }>();
  for (const { id } of rolling.results) {
    const holder = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE cloud_releases SET sweep_holder=?,sweep_until=? WHERE id=? AND state='rolling'
      AND (sweep_until IS NULL OR sweep_until<=?)`).bind(holder, now + SWEEP_LEASE_MS, id, now).run();
    if (claimed.meta.changes !== 1) continue; // another pass holds it
    try { await advance(env, id, now, options(env, o)); }
    finally { await env.DB.prepare("UPDATE cloud_releases SET sweep_holder=NULL,sweep_until=NULL WHERE id=? AND sweep_holder=?").bind(id, holder).run(); }
  }
}

async function advance(env: Env, id: string, now: number, o: ReturnType<typeof options>): Promise<void> {
  // At most one wave boundary is crossed per iteration; empty waves (no internal homes, a tiny fleet) are crossed in the same pass.
  for (let guard = 0; guard < 5; guard++) {
    const rel = await env.DB.prepare("SELECT * FROM cloud_releases WHERE id=? AND state='rolling'").bind(id).first<ReleaseRow>();
    if (!rel) return;
    if (rel.wave_started_at === null) {
      const [internal, limit] = await waveSelection(env, rel);
      await run(env, [
        q(`INSERT INTO cloud_release_homes (release_id,home_id,wave,state,created_at,updated_at)
          SELECT ?,h.id,?,'pending',?,? ${ELIGIBLE} ${NOT_IN_RELEASE} ORDER BY h.created_at,h.id LIMIT ? ON CONFLICT DO NOTHING`,
        rel.id, rel.wave, now, now, internal, rel.id, limit),
        q("UPDATE cloud_releases SET wave_started_at=?,updated_at=? WHERE id=? AND state='rolling' AND wave_started_at IS NULL AND wave=?", now, now, rel.id, rel.wave),
      ]);
      continue; // re-read with the wave recorded
    }
    const waveStartedAt = rel.wave_started_at;
    let rows = (await waveRows(env, rel.id, rel.wave)).results;
    // Homes of the waves already passed are judged on every pass too: a canary that regresses or goes Stuck later still halts the release.
    const prior = rel.wave > 0 ? (await waveRows(env, rel.id, rel.wave, "<")).results : [];

    // 1. What the homes have reported since the last pass.
    const changes: Q[] = [];
    for (const row of [...prior, ...rows]) {
      const v = judge(row, rel.sequence, now, o.reportTimeoutMs, waveStartedAt);
      if (!v || v.state === row.state) continue;
      changes.push(q(`UPDATE cloud_release_homes SET state=?,failure=?,healthy_at=CASE WHEN ?='updated' THEN COALESCE(healthy_at,?) ELSE healthy_at END,updated_at=?
        WHERE release_id=? AND home_id=? AND state=?`, v.state, v.failure, v.state, now, now, rel.id, row.home_id, row.state));
      row.state = v.state; row.failure = v.failure;
      if (v.state === "updated") row.healthy_at = row.healthy_at ?? now; // mirror the write: the evidence deadline below reads this row
    }
    // 2. A failure halts the release before anything more is sent.
    const failed = [...prior, ...rows].filter((r) => r.state === "failed");
    if (failed.length > 0) { await runChunked(env, changes); await halt(env, rel, failed.map((r) => [r.home_id, r.failure ?? "failed"]), now); return; }
    if (changes.length) await runChunked(env, changes);
    // Every UPDATED home (earlier waves and this one) is re-checked on every pass, before anything more is sent: an updated home whose app
    // failed, stopped rendering or raised a soak alert halts the release now, not once the whole wave has landed. Affirmative app AND render
    // evidence reported after the update is also required to advance; missing evidence waits only until the evidence deadline, then halts.
    const evPrior = await soakFailures(env, prior.filter((r) => r.state === "updated"), waveStartedAt, now, o.reportTimeoutMs);
    const evCur = await soakFailures(env, rows.filter((r) => r.state === "updated"), rel.soak_started_at, now, o.reportTimeoutMs);
    const bad = [...evPrior.bad, ...evCur.bad];
    if (bad.length > 0) { await halt(env, rel, bad, now); return; }
    // No app/render evidence yet for an earlier or current updated home: nothing more is sent either (until the evidence deadline halts it).
    if (evPrior.unproven || evCur.unproven) {
      // The hold: pending homes cannot be dispatched, so this pass does not count against their dispatch deadline (see judge).
      await env.DB.prepare("UPDATE cloud_release_homes SET updated_at=? WHERE release_id=? AND state='pending'").bind(now, rel.id).run();
      return;
    }

    // 3. Send the update to homes still waiting (a bounded number per pass; a busy home is simply asked again next pass).
    let budget = o.dispatchPerPass;
    for (const row of [...prior, ...rows]) {
      if (budget <= 0) break;
      if (row.state !== "pending") continue;
      budget--;
      const sent = await dispatchRolloutUpdate(env, row.home_id, rel.sequence, now, rel.id);
      if ("commandId" in sent) {
        await env.DB.prepare(`UPDATE cloud_release_homes SET state='dispatched',command_id=?,dispatched_at=?,updated_at=?
          WHERE release_id=? AND home_id=? AND state='pending'`).bind(sent.commandId, now, now, rel.id, row.home_id).run();
      }
    }

    // 4. Wave gate: every (non-skipped) home of this and any earlier wave updated, with proven health -> the soak clock starts; soak passed -> the
    //    next wave (or promotion).
    rows = (await waveRows(env, rel.id, rel.wave)).results;
    const priorNow = rel.wave > 0 ? (await waveRows(env, rel.id, rel.wave, "<")).results : [];
    const live = rows.filter((r) => r.state !== "skipped");
    const allUpdated = [...priorNow, ...live].filter((r) => r.state !== "skipped").every((r) => r.state === "updated");
    if (!allUpdated) return;
    let soakStartedAt = rel.soak_started_at;
    if (live.length > 0 && soakStartedAt === null) {
      soakStartedAt = now;
      await env.DB.prepare("UPDATE cloud_releases SET soak_started_at=?,updated_at=? WHERE id=? AND state='rolling' AND soak_started_at IS NULL").bind(now, now, rel.id).run();
    }
    if (live.length > 0 && now - soakStartedAt! < o.soakMs) return;
    if (rel.wave < 3) {
      await env.DB.prepare(`UPDATE cloud_releases SET wave=wave+1,wave_started_at=NULL,soak_started_at=NULL,updated_at=? WHERE id=? AND state='rolling' AND wave=?`)
        .bind(now, rel.id, rel.wave).run();
      continue;
    }
    // No canary, no promotion: a release no home ever installed (every wave empty or skipped) stays rolling instead of reaching every customer.
    const installed = await env.DB.prepare("SELECT 1 AS n FROM cloud_release_homes WHERE release_id=? AND state='updated' LIMIT 1").bind(rel.id).first();
    if (!installed) return;
    await env.DB.prepare("UPDATE cloud_releases SET state='promoted',promoted_at=?,updated_at=? WHERE id=? AND state='rolling' AND wave=3").bind(now, now, rel.id).run();
    return;
  }
}

/** Updated homes with an open home.heartbeat_missed or home.ui_render_missing, or one raised since `windowStart` (even if resolved again), or
 *  whose current health report says the app failed (app_ok=0) or does not render. `unproven`: some home has no affirmative evidence yet (no
 *  health row for its generation, app health or render evidence missing, or reported before its update was dispatched); that holds the wave
 *  rather than count as a pass, but only until `timeoutMs` after the home was judged updated: then it is a failure ("soak:no_evidence") and
 *  the release halts through the normal halt and alert path. */
async function soakFailures(env: Env, homes: WaveRow[], windowStart: number | null, now: number, timeoutMs: number): Promise<{ bad: [string, string][]; unproven: boolean }> {
  const out: [string, string][] = [];
  let unproven = false;
  const byId = new Map(homes.map((r) => [r.home_id, r]));
  const homeIds = [...byId.keys()];
  for (let i = 0; i < homeIds.length; i += 50) {
    const ids = homeIds.slice(i, i + 50);
    const marks = ids.map(() => "?").join(",");
    const kinds = SOAK_ALERT_KINDS.map(() => "?").join(",");
    // Before the soak starts (windowStart null) alerts are not judged: the update's own restart may have raised and cleared one.
    const found = windowStart === null ? { results: [] as { home_id: string; kind: string }[] } : await env.DB.prepare(`SELECT DISTINCT home_id,kind FROM cloud_alerts WHERE home_id IN (${marks}) AND kind IN (${kinds})
      AND (resolved_at IS NULL OR raised_at>=?) ORDER BY home_id,kind`).bind(...ids, ...SOAK_ALERT_KINDS, windowStart).all<{ home_id: string; kind: string }>();
    for (const r of found.results) out.push([r.home_id, `soak:${r.kind}`]);
    // The render alert exists only while a home waits in 'checking', so a READY canary whose app stops rendering never raises it: read the
    // health row itself (the current generation's own report) so a canary that keeps its heartbeat but renders nothing still halts the release.
    const rows = await env.DB.prepare(`SELECT x.home_id,x.report_at,x.report_epoch,x.evidence_epoch,x.ui_age_ms,x.app_reported_at,x.app_ok_at,x.app_ok,x.ui_renders_ok FROM cloud_home_health x
      JOIN cloud_homes h ON h.id=x.home_id AND x.generation=h.generation WHERE x.home_id IN (${marks}) ORDER BY x.home_id`)
      .bind(...ids).all<{ home_id: string; report_at: number | null; report_epoch: number | null; evidence_epoch: number | null; ui_age_ms: number | null; app_reported_at: number | null; app_ok_at: number | null; app_ok: number | null; ui_renders_ok: number | null }>();
    const health = new Map(rows.results.map((r) => [r.home_id, r]));
    for (const id of ids) {
      if (out.some(([h]) => h === id)) continue;
      const r = health.get(id);
      const why = r && r.ui_renders_ok === 0 ? "soak:ui_renders_ok" : r && appOutcome(r) === false ? "soak:app_ok" : null;
      if (why) { out.push([id, why]); continue; }
      const row = byId.get(id)!;
      // Affirmative: the app reported healthy AND the UI rendered, in a report made after the update went out.
      // report_at is the receipt time of the last ACCEPTED report (render evidence); reported_at also moves on dropped or epoch-less heartbeats
      // that keep an older ui_renders_ok, so it is not render proof. The evidence must still be live: report_epoch = evidence_epoch (a later
      // rejected heartbeat or epoch-less report clears report_epoch and bumps the epoch but leaves report_at and the old render behind).
      // Receipt time alone is not render time either: an accepted report can carry a render cached from before the update. ui_rendered_at is
      // the HOME's clock (spoofable by skew), so the render time is derived from OUR receipt clock and the home-measured age of the render:
      // report_at - ui_age_ms >= since (age clamped at 0, so a negative age cannot push the render later). No age: no proof.
      const since = row.dispatched_at ?? row.healthy_at ?? 0;
      const renderedAt = r && r.report_at !== null && r.ui_age_ms !== null ? r.report_at - Math.max(0, r.ui_age_ms) : null;
      const proven = !!r && appOutcome(r) === true && r.ui_renders_ok === 1 && r.report_epoch !== null && r.report_epoch === r.evidence_epoch
        && renderedAt !== null && renderedAt >= since && (r.report_at ?? 0) >= since && (r.app_reported_at ?? 0) >= since;
      if (proven) continue;
      if (now - (row.healthy_at ?? row.dispatched_at ?? 0) > timeoutMs) out.push([id, "soak:no_evidence"]);
      else unproven = true;
    }
  }
  return { bad: out, unproven };
}

/** Halts a rolling release: one atomic batch (the state change, the failed homes, the ONE alert), then queued-but-unpicked commands expire so
 *  a halted release really dispatches nothing more. A concurrent cancel or halt wins: the guard rolls the batch back. */
async function halt(env: Env, rel: ReleaseRow, failures: [string, string][], now: number): Promise<void> {
  const list = failures.slice(0, 20).map(([h, why]) => `${h} (${why})`).join(", ") + (failures.length > 20 ? `, and ${failures.length - 20} more` : "");
  const detail = `release ${rel.sequence} halted in wave ${rel.wave}: ${list}`.slice(0, 1500);
  const batch = (): Promise<unknown> =>
    run(env, [
      q("UPDATE cloud_releases SET state='halted',halt_reason=?,halted_at=?,updated_at=? WHERE id=? AND state='rolling'", detail, now, now, rel.id),
      ...guardOne(),
      withdrawStatement(now), // in the SAME batch: a halted release has no unpicked command left
      ...failures.slice(0, 200).map(([h, why]) => q(`UPDATE cloud_release_homes SET state='failed',failure=?,updated_at=? WHERE release_id=? AND home_id=? AND state NOT IN ('failed','skipped')`,
        why, now, rel.id, h)),
      // The ONE alert, in the same atomic batch as the halt it reports (the row alertStatement writes; one open per release id).
      q(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,?
        WHERE EXISTS (SELECT 1 FROM cloud_releases WHERE id=? AND state='halted' AND halted_at=?) ON CONFLICT DO NOTHING`,
      crypto.randomUUID(), releaseAlertHome(rel.id), ROLLOUT_HALTED_ALERT, "high", detail, now, rel.id, now),
    ]);
  // A failed batch rolls back whole. If the release is no longer rolling someone else (a cancel, another halt) won and there is nothing to do;
  // if it is STILL rolling the halt did not land, so retry in-line and then throw (the sweep logs it and the next pass halts again), never
  // return as if halted while queued update commands stay deliverable.
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await batch(); return; } catch (e) { last = e; }
    const cur = await env.DB.prepare("SELECT state FROM cloud_releases WHERE id=?").bind(rel.id).first<{ state: string }>();
    if (!cur || cur.state !== "rolling") return;
  }
  throw last;
}

/** Expires every command no home picked yet whose rollout release is halted or cancelled. Found by the command's own payload (reason + sequence),
 *  so a command whose id was never recorded on its release home is still caught. Idempotent. */
const withdrawStatement = (now: number): Q => q(`UPDATE cloud_home_commands SET expires_at=? WHERE acked_at IS NULL AND picked_at IS NULL AND expires_at>?
  AND kind='update_software' AND json_extract(payload,'$.reason')='rollout'
  AND json_extract(payload,'$.sequence') IN (SELECT sequence FROM cloud_releases WHERE state IN ('halted','cancelled'))`, now, now);
const withdrawStale = (env: Env, now: number) => run(env, [withdrawStatement(now)]);

// ---- operator routes --------------------------------------------------------------------------------------------------------------

const createBody = z.object({ sequence: z.number().int().min(1).max(MAX_SEQUENCE), manifestRef: z.string().min(1).max(200) }).strict();
const resumeBody = z.object({ skipFailed: z.boolean().optional() }).strict();
const internalBody = z.object({ internal: z.boolean() }).strict();
const emptyBody = z.object({}).strict();

async function view(env: Env, rel: ReleaseRow): Promise<JSONValue> {
  const counts = await env.DB.prepare("SELECT wave,state,COUNT(*) AS n FROM cloud_release_homes WHERE release_id=? GROUP BY wave,state ORDER BY wave,state").bind(rel.id).all<{ wave: number; state: string; n: number }>();
  const failed = await env.DB.prepare("SELECT home_id,wave,failure FROM cloud_release_homes WHERE release_id=? AND state='failed' ORDER BY home_id LIMIT 100").bind(rel.id)
    .all<{ home_id: string; wave: number; failure: string | null }>();
  return { id: rel.id, sequence: rel.sequence, manifestRef: rel.manifest_ref, state: rel.state, wave: rel.wave, waveStartedAt: rel.wave_started_at,
    soakStartedAt: rel.soak_started_at, haltReason: rel.halt_reason, createdAt: rel.created_at, startedAt: rel.started_at, haltedAt: rel.halted_at,
    promotedAt: rel.promoted_at, cancelledAt: rel.cancelled_at,
    homes: counts.results.map((c) => ({ wave: c.wave, state: c.state, count: c.n })),
    failedHomes: failed.results.map((f) => ({ homeId: f.home_id, wave: f.wave, failure: f.failure })) };
}
const releaseById = async (env: Env, id: string) => {
  const rel = await env.DB.prepare("SELECT * FROM cloud_releases WHERE id=?").bind(id).first<ReleaseRow>();
  if (!rel) throw new HTTPError(404, "not_found");
  return rel;
};

export async function rolloutRoute(request: Request, env: Env, now = Date.now()): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/v1/admin/rollout/")) return null;
  await admin(request, env);
  const method = request.method;
  if (path === "/v1/admin/rollout/releases") {
    if (method === "GET") {
      const all = await env.DB.prepare("SELECT * FROM cloud_releases ORDER BY sequence DESC LIMIT 50").all<ReleaseRow>();
      return json({ releases: await Promise.all(all.results.map((r) => view(env, r))) });
    }
    if (method !== "POST") throw new HTTPError(405, "method_not_allowed");
    const body = await readJSON(request, createBody);
    // A release must be newer than everything already promoted: the home's sequence floor refuses anything else.
    const top = await env.DB.prepare(`SELECT MAX(sequence) AS s FROM cloud_releases WHERE ${FLOOR_SQL}`).first<{ s: number | null }>();
    if (top?.s != null && body.sequence <= top.s) throw new HTTPError(409, "sequence_not_newer");
    const id = crypto.randomUUID();
    try {
      // The floor is re-checked inside the write itself, so a release that started and was cancelled between the read above and here still counts.
      const ins = await env.DB.prepare(`INSERT INTO cloud_releases (id,sequence,manifest_ref,state,wave,created_at,updated_at)
        SELECT ?,?,?,'draft',0,?,? WHERE ? > COALESCE((SELECT MAX(sequence) FROM cloud_releases WHERE ${FLOOR_SQL}),0)`)
        .bind(id, body.sequence, body.manifestRef, now, now, body.sequence).run();
      if (ins.meta.changes !== 1) throw new HTTPError(409, "sequence_not_newer");
    } catch (e) { if (e instanceof HTTPError) throw e; throw new HTTPError(409, "sequence_exists"); }
    return json(await view(env, await releaseById(env, id)), 201);
  }
  const flag = /^\/v1\/admin\/rollout\/homes\/([\w-]{1,128})\/internal$/.exec(path);
  if (flag) {
    if (method !== "POST") throw new HTTPError(405, "method_not_allowed");
    const body = await readJSON(request, internalBody);
    const h = await env.DB.prepare("SELECT id FROM cloud_homes WHERE id=?").bind(flag[1]).first();
    if (!h) throw new HTTPError(404, "not_found");
    await env.DB.prepare(`INSERT INTO cloud_rollout_flags (home_id,internal,updated_at) VALUES (?,?,?)
      ON CONFLICT(home_id) DO UPDATE SET internal=excluded.internal,updated_at=excluded.updated_at`).bind(flag[1], body.internal ? 1 : 0, now).run();
    return json({ homeId: flag[1], internal: body.internal });
  }
  const m = /^\/v1\/admin\/rollout\/releases\/([\w-]{1,64})(?:\/(start|cancel|resume))?$/.exec(path);
  if (!m) throw new HTTPError(404, "not_found");
  const rel = await releaseById(env, m[1]);
  if (!m[2]) {
    if (method !== "GET") throw new HTTPError(405, "method_not_allowed");
    return json(await view(env, rel));
  }
  if (method !== "POST") throw new HTTPError(405, "method_not_allowed");
  if (m[2] === "start") {
    await readJSON(request, emptyBody);
    if (rel.state !== "draft") throw new HTTPError(409, "not_a_draft");
    const top = await env.DB.prepare(`SELECT MAX(sequence) AS s FROM cloud_releases WHERE ${FLOOR_SQL} AND id<>?`).bind(rel.id).first<{ s: number | null }>();
    if (top?.s != null && rel.sequence <= top.s) throw new HTTPError(409, "sequence_not_newer");
    try {
      const upd = await env.DB.prepare(`UPDATE cloud_releases SET state='rolling',wave=0,wave_started_at=NULL,soak_started_at=NULL,started_at=?,updated_at=? WHERE id=? AND state='draft'
        AND sequence > COALESCE((SELECT MAX(sequence) FROM cloud_releases WHERE ${FLOOR_SQL} AND id<>?),0)`)
        .bind(now, now, rel.id, rel.id).run();
      if (upd.meta.changes !== 1) throw new HTTPError(409, "sequence_not_newer");
    } catch (e) { if (e instanceof HTTPError) throw e; throw new HTTPError(409, "rollout_in_progress"); } // the one-active-release index
    return json(await view(env, await releaseById(env, rel.id)));
  }
  if (m[2] === "cancel") {
    await readJSON(request, emptyBody);
    if (!["draft", "rolling", "halted"].includes(rel.state)) throw new HTTPError(409, "not_cancellable");
    await run(env, [
      q("UPDATE cloud_releases SET state='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND state IN ('draft','rolling','halted')", now, now, rel.id),
      q("UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE home_id=? AND kind=? AND resolved_at IS NULL", now, releaseAlertHome(rel.id), ROLLOUT_HALTED_ALERT),
      withdrawStatement(now), // same batch as the state change
    ]);
    return json(await view(env, await releaseById(env, rel.id)));
  }
  // resume
  const body = await readJSON(request, resumeBody);
  if (rel.state !== "halted") throw new HTTPError(409, "not_halted");
  const statements: Q[] = [
    q(`UPDATE cloud_releases SET state='rolling',halt_reason=NULL,halted_at=NULL,wave_started_at=?,soak_started_at=NULL,updated_at=? WHERE id=? AND state='halted'`, now, now, rel.id),
    ...guardOne(),
    // The wave starts over (failed homes of EVERY wave so far, not only this one): failed homes are asked again (or left out), homes still waiting keep their command, updated homes stay updated.
    q(`UPDATE cloud_release_homes SET state=?,failure=CASE WHEN ?='skipped' THEN failure ELSE NULL END,command_id=CASE WHEN ?='skipped' THEN command_id ELSE NULL END,
      dispatched_at=CASE WHEN ?='skipped' THEN dispatched_at ELSE NULL END,healthy_at=CASE WHEN ?='skipped' THEN healthy_at ELSE NULL END,updated_at=? WHERE release_id=? AND wave<=? AND state='failed'`,
    body.skipFailed ? "skipped" : "pending", body.skipFailed ? "skipped" : "", body.skipFailed ? "skipped" : "", body.skipFailed ? "skipped" : "", body.skipFailed ? "skipped" : "", now, rel.id, rel.wave),
    // A home still waiting whose command no home picked up (the halt withdrew it) is asked again; one already running it keeps its command.
    q(`UPDATE cloud_release_homes SET state='pending',command_id=NULL,dispatched_at=NULL,updated_at=? WHERE release_id=? AND wave<=? AND state='dispatched'
      AND NOT EXISTS (SELECT 1 FROM cloud_home_commands c WHERE c.id=cloud_release_homes.command_id AND (c.picked_at IS NOT NULL OR c.acked_at IS NOT NULL))`, now, rel.id, rel.wave),
    q("UPDATE cloud_release_homes SET dispatched_at=?,updated_at=? WHERE release_id=? AND wave<=? AND state='dispatched'", now, now, rel.id, rel.wave),
    q("UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE home_id=? AND kind=? AND resolved_at IS NULL", now, releaseAlertHome(rel.id), ROLLOUT_HALTED_ALERT),
  ];
  try { await run(env, statements); } catch { throw new HTTPError(409, "rollout_in_progress"); }
  return json(await view(env, await releaseById(env, rel.id)));
}
