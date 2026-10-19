// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

export const HEARTBEAT_MISS_MS = 5 * 60 * 1000;
export const DISK_ALERT_PERCENT = 85;
export const BACKUP_STALE_MS = 26 * 60 * 60 * 1000;
const SUMMARY_HOUR_UTC = 7;
const ALERT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_DELIVERY_ATTEMPTS = 20;

/** Events a home may report. One name per event; lane 1's CPU-mining flag is abuse.mining_suspected. */
export const HOME_EVENT_TYPES = ["abuse.mining_suspected"] as const;

/** The app's process id on /api/health ("instance": a random 16-byte base64url token minted at process start), on the heartbeat
 *  (checks.uiInstance) and on the public probe alike. */
export const UI_INSTANCE = /^[A-Za-z0-9_-]{16,64}$/;
/** How far ahead of the clock that judges it a render time (uiAt) may be (Astra AUTOCANARY-6 P1): murage-control refuses a render
 *  finished more than this ahead of its own wall clock (checks.uiReason "clock_ahead"), and the control plane rejects, at its first
 *  observation and for good, a (uiInstance, uiAt) pair more than this ahead of its own clock (recordHealth: ui_rejected_at). */
export const UI_AT_FUTURE_MAX_MS = 2 * 60_000;
/** One webhook send's bound (Astra AUTOCANARY-6 P2): a webhook holding its response is a failed delivery, retried by the next sweep. */
export const ALERT_POST_TIMEOUT_MS = 10_000;
/** The monitoring sweep's delivery stage (Astra AUTOCANARY-7): at most this many sends at once, and no send started once the stage has
 *  run this long, so a stalled webhook costs the sweep at most ALERT_STAGE_MS + ALERT_POST_TIMEOUT_MS; what is left waits, claimed or
 *  not, for the next sweep. */
export const ALERT_SEND_CONCURRENCY = 10;
export const ALERT_STAGE_MS = 30_000;
/** Per-run send limits of the monitoring sweep's delivery stage (Astra AUTOCANARY-8 P2): resolution notices go first, at most
 *  RESOLUTION_SEND_LIMIT a run and none started after RESOLUTION_STAGE_MS; then alerts, at most ALERT_SEND_LIMIT a run and none started
 *  after ALERT_STAGE_MS from the start of the stage. A backlog of either can never take the whole stage from the other. */
export const RESOLUTION_SEND_LIMIT = 20;
export const RESOLUTION_STAGE_MS = ALERT_STAGE_MS / 2;
export const ALERT_SEND_LIMIT = 60;
/** Of each run's ALERT_SEND_LIMIT, the share reserved for the oldest non-urgent alerts (Astra AUTOCANARY-10 P2). */
export const ALERT_OLDEST_SHARE = 20;
/** Raised (one open) when more undelivered alerts wait than one sweep sends (Astra AUTOCANARY-9 P2); resolved once the queue fits. */
export const ALERT_BACKLOG_ALERT = "alerts.backlog";
/** Alerts sent ahead of the rest of a backlog (Astra AUTOCANARY-9 P2): a home waiting in 'checking' without its render, and a home given
 *  up on. Then by severity, then by age; alerts.backlog itself goes first and ALERT_OLDEST_SHARE of a run goes to the oldest (AUTOCANARY-10). */
const URGENT_ALERT_KINDS = ["home.ui_render_missing", "provision.failed"];

/** Optional block on the existing heartbeat body. Older homes that send only {generation} keep working. */
export const healthSchema = z.object({
  diskUsedPercent: z.number().int().min(0).max(100).optional(),
  lastBackupAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  // The Murage app itself answered a local request through the home's front door this minute (murage-control's probe). Health is the
  // app answering, not the root daemon being alive (self-service.ts liveAt).
  appResponding: z.boolean().optional(),
  // The home's own readiness checks, sampled with the app report (murage-control collect_health): every file of the built web UI's
  // manifest is on the image (uiBundle), the data volume takes a durable write (dataWritable) and the UI really rendered (uiRenders: the
  // app's own /api/health "ui" field, set only after it rendered its built UI in its sandboxed browser; absent while the app has no
  // self-render, which the automatic canary treats as not ready). Stored only together with an app report (recordHealth). There is no
  // scheduler check: the home has no scheduler heartbeat signal to report (none exists in the tree), so the automatic canary does not claim one.
  // uiAt and uiInstance (Astra AUTOCANARY-5 P1) date the render and name the app process that did it, copied from the same /api/health
  // answer as uiRenders: uiAt is when the app's last render FINISHED (ms epoch, the home's clock; null while none has finished, which never
  // satisfies the render-age rule), uiInstance the opaque id the app mints at process start (UI_INSTANCE). A cached "ok" is evidence only
  // while it is young (b3-control.ts AUTO_CANARY_RENDER_MAX_AGE_MS) and only for the process and boot that produced it.
  checks: z.object({ uiBundle: z.boolean(), dataWritable: z.boolean(), uiRenders: z.boolean().optional(),
    uiAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    uiInstance: z.string().regex(UI_INSTANCE).optional(),
    // Why murage-control reported the render as failed although the app said "ok" (Astra AUTOCANARY-6 P1): "clock_ahead", its uiAt was
    // more than UI_AT_FUTURE_MAX_MS ahead of the home's own wall clock. A fixed vocabulary, never free text.
    uiReason: z.enum(["clock_ahead"]).optional(),
    // The render's age on the home's own clock (Astra AUTOCANARY-7 P1): murage-control's wall clock at this heartbeat's ONE clock sample
    // minus uiAt (negative when the render is dated ahead of it). The control plane judges render age by it, never by its receipt time.
    uiAgeMs: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional() }).strict().optional(),
  // The home's own clock sample for this heartbeat (Astra AUTOCANARY-6 P1), from murage-control's clock helper, taken just before the app
  // probe whose answer this heartbeat carries. wallMs is the sample time for the canary's transit bound; bootMs (CLOCK_BOOTTIME) is
  // informational. Neither orders anything (Astra AUTOCANARY-10: the evidence epoch does).
  clock: z.object({ bootMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    wallMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  // The evidence epoch of the last heartbeat ack murage-control received (Astra AUTOCANARY-10), echoed: null when it holds none (just
  // started, or the ack was refused). A report is accepted as evidence only when it equals the home's current epoch (recordHealth); the ack
  // carries the epoch only to a heartbeat that sent this field, so an older murage-control keeps its old ack.
  evidenceEpoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  // LEGACY, tolerated so every daemon in the field keeps its heartbeat through a control-plane deploy (Astra AUTOCANARY-11 P1-3): a
  // strict 400 fences the home's authority (murage-control poll_once). Each legacy field is validated exactly as its last schema did and
  // then IGNORED, and a report carrying one is a report WITHOUT an epoch whatever else it says (recordHealth: dropped as 'no_epoch', its
  // failures count, it never promotes). The list, by the commit that introduced the field:
  //  - bootSeq: the home-persisted boot sequence, sent by murage-control 1e5481a7f through 1ae30ebf0 (retired at d00e9486e).
  // Every other field any earlier daemon sent (56a15e901 and the 044323c42..878173855 series: appResponding, bootId, checks.*, clock,
  // diskUsedPercent, lastBackupAt, events) is still a current field above; nothing else is tolerated.
  bootSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  // The kernel's boot id (/proc/sys/kernel/random/boot_id): a different value proves the home booted again (a power action finished).
  bootId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional(),
  events: z.array(z.object({
    // No free text: a heartbeat or alert must never be able to carry file content or a credential.
    type: z.enum(HOME_EVENT_TYPES), at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(5).optional(),
}).strict();
export type HomeHealth = z.infer<typeof healthSchema>;

interface OpsEnv { ALERT_WEBHOOK_URL?: string }
type Fetcher = typeof fetch;

/** How a refused heartbeat's invalidation is retried (Astra AUTOCANARY-11 P1-1): as many attempts as the accept path gets chances, with a
 *  short backoff, before the route gives up and asks the home to resend soon (b3-control.ts heartbeat: 503, Retry-After). */
export const DROP_ATTEMPTS = 3;
export const DROP_BACKOFF_MS = [50, 250] as const;

/** Drops a report without reading it (Astra AUTOCANARY-10 P1 #3): an authenticated heartbeat the route rejected (a body that failed
 *  validation or was too large, a stale generation) is a negative event like any other. The epoch is bumped and the drop recorded in one
 *  statement, BEFORE the route answers, so a passing report stored earlier never stays eligible behind a report we refused to read.
 *  Retried (Astra AUTOCANARY-11 P1-1): DROP_ATTEMPTS attempts, DROP_BACKOFF_MS apart; the last failure is thrown. No row: no evidence. */
export async function dropHealth(env: Env, homeId: string, reason: string, now: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await env.DB.prepare(`UPDATE cloud_home_health SET evidence_epoch=evidence_epoch+1,report_epoch=NULL,drop_reason=?2,dropped_at=?3
        WHERE home_id=?1`).bind(homeId, reason, now).run();
      return;
    } catch (error) {
      if (attempt + 1 >= DROP_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, DROP_BACKOFF_MS[attempt]));
    }
  }
}

/** The evidence-epoch bump for a change of the home itself (Astra AUTOCANARY-11 P2-1, replacing the two D1 triggers of migration 0102:
 *  a trigger's row counted in the statement's meta.changes and made committed transitions report failure). A statement for the SAME batch
 *  as the change, placed after it: when the home's desired_state or generation is no longer `before`'s (the change happened), the epoch
 *  is bumped and the stored report and probe stop counting, so evidence from before the change never promotes the home. Every writer that
 *  changes a home's generation or desired_state adds it, except the promotion (checking to ready), whose batch re-checks the evidence at
 *  the epoch it read. `before` null: unconditional (a writer that does not know the prior row). */
export function homeChangeBump(db: D1Database, homeId: string, before: { desired_state: string; generation: number | null } | null,
  now: number): D1PreparedStatement {
  // ?2/?3 the prior state and generation (?3 null: not compared); ?5=0: no prior row known (machine rotation: a generation change).
  const generationMoved = "(?3 IS NOT NULL AND generation IS NOT ?3)";
  return db.prepare(`UPDATE cloud_home_health SET evidence_epoch=evidence_epoch+1,report_epoch=NULL,probe_epoch=NULL,dropped_at=?4,
      drop_reason=CASE WHEN ?5=0 THEN 'generation_change'
        ELSE COALESCE((SELECT CASE WHEN ${generationMoved} THEN 'generation_change' ELSE 'state_change' END FROM cloud_homes WHERE id=?1),
          'state_change') END
    WHERE home_id=?1 AND (?5=0 OR EXISTS(SELECT 1 FROM cloud_homes WHERE id=?1 AND (desired_state IS NOT ?2 OR ${generationMoved})))`)
    .bind(homeId, before?.desired_state ?? null, before?.generation ?? null, now, before ? 1 : 0);
}

/** Records one heartbeat's health. `generation` null (CP0): display health only, unguarded, as before; returns null.
 *
 *  Display (both paths; self-service appOutcome/liveAt, the watchdog): app_reported_at, app_ok and app_ok_at are ordered by OUR receipt
 *  time `now`: a strictly newer report replaces the outcome, a same-millisecond pair merges fail-closed (MIN) in either order (Astra
 *  AUTOCANARY-3 P2), and app_ok_at is the latest success seen whatever the arrival order (Astra AUTOCANARY-4 P2). The automatic canary
 *  never decides on that order.
 *
 *  Evidence (B3, `generation` set; Astra AUTOCANARY-10, replacing the home-persisted boot sequence, the retired-boot list, the restore rule
 *  and every bootMs or timestamp comparison of rounds 6-11): ordering is the control plane's evidence epoch alone, never the home's and
 *  never a clock. The row is written only while `generation` is still the home's (checked in the same statement). ONE statement then
 *  decides and records the report:
 *   - the row is of another generation (or new): it is reset for this one, evidence_epoch 0 and no evidence (report, probe); the report
 *     itself is not accepted (no epoch of this generation can have been acknowledged before the reset).
 *   - the report echoes the current epoch (health.evidenceEpoch = evidence_epoch, a compare-and-set in the statement): it is ACCEPTED: its
 *     outcome and checks are stored, tagged report_epoch = that epoch. A full PASS (the app answered, every check true, a rendered UI with
 *     its time, process and age, not a refused render) leaves the epoch; anything else bumps it (drop_reason the failure).
 *   - otherwise (no epoch: an older murage-control, one sending a legacy field, or a restarted one; a stale epoch: a delayed or replayed report, a report composed
 *     before a negative event): DROPPED: the epoch is bumped, report_epoch cleared, and its failing checks still lower the stored ones
 *     (fail-closed); its passes never count.
 *  A refused render (murage-control's own clock_ahead, a uiAt more than UI_AT_FUTURE_MAX_MS ahead of the home's clock sample or of ours, or
 *  the (uiInstance, uiAt) pair refused before: ui_rejected_at/_instance, kept for good) is a failing check.
 *  Returns the epoch after the statement (the heartbeat ack carries it; murage-control echoes it next time), or null when the home's
 *  generation moved while this was decided (then the epoch is bumped too). */
export async function recordHealth(env: Env, homeId: string, health: HomeHealth | undefined, now = Date.now(), fetcher?: Fetcher,
  generation: number | null = null): Promise<number | null> {
  if (!health) {
    // A B3 heartbeat without health carries no epoch: a dropped report.
    if (generation !== null) await dropHealth(env, homeId, "no_epoch", now);
    return null;
  }
  // A report carrying a legacy field (healthSchema: bootSeq) comes from a daemon older than evidence epochs: it holds no epoch, whatever
  // it says (Astra AUTOCANARY-11 P1-3).
  const echoed = health.bootSeq !== undefined ? null : health.evidenceEpoch ?? null;
  const app = health.appResponding;
  const checks = app === undefined ? undefined : health.checks;
  const flag = (value: boolean | undefined) => value === undefined ? null : value ? 1 : 0;
  const rendered = checks?.uiRenders !== undefined;
  const renderAt = rendered ? checks!.uiAt ?? null : null;
  const renderInstance = rendered ? checks!.uiInstance ?? null : null;
  const uiAge = renderAt !== null ? checks!.uiAgeMs ?? null : null;
  const refused = renderAt !== null && (checks!.uiReason === "clock_ahead" || renderAt > now + UI_AT_FUTURE_MAX_MS
    || (uiAge !== null && uiAge < -UI_AT_FUTURE_MAX_MS));
  const pass = app === true && checks?.uiBundle === true && checks.dataWritable === true && checks.uiRenders === true && !refused
    && renderAt !== null && renderInstance !== null && uiAge !== null && health.clock !== undefined;
  // Display: the report replaces the stored one when strictly newer by our receipt time, merges fail-closed at the same millisecond.
  const sameDisplay = "(excluded.generation IS NULL OR cloud_home_health.generation IS excluded.generation)";
  const newer = `(excluded.app_reported_at IS NOT NULL AND (cloud_home_health.app_reported_at IS NULL OR excluded.app_reported_at>cloud_home_health.app_reported_at))`;
  const tie = `(excluded.app_reported_at IS NOT NULL AND excluded.app_reported_at=cloud_home_health.app_reported_at)`;
  // A row written before app_ok existed: its outcome as self-service appOutcome reads it.
  const storedAppOk = `COALESCE(cloud_home_health.app_ok,CASE WHEN cloud_home_health.app_ok_at=cloud_home_health.app_reported_at THEN 1 ELSE 0 END)`;
  const display = `reported_at=excluded.reported_at,
      disk_used_percent=COALESCE(excluded.disk_used_percent,disk_used_percent),
      last_backup_at=COALESCE(excluded.last_backup_at,last_backup_at),
      app_ok_at=CASE WHEN NOT ${sameDisplay} THEN excluded.app_ok_at WHEN excluded.app_ok_at IS NULL THEN cloud_home_health.app_ok_at
        WHEN cloud_home_health.app_ok_at IS NULL THEN excluded.app_ok_at ELSE MAX(excluded.app_ok_at,cloud_home_health.app_ok_at) END,
      app_ok=CASE WHEN NOT ${sameDisplay} OR ${newer} THEN excluded.app_ok WHEN ${tie} THEN MIN(excluded.app_ok,${storedAppOk})
        ELSE cloud_home_health.app_ok END,
      app_reported_at=CASE WHEN NOT ${sameDisplay} OR ${newer} THEN excluded.app_reported_at ELSE cloud_home_health.app_reported_at END,
      boot_id=COALESCE(excluded.boot_id,boot_id),
      generation=excluded.generation`;
  // A new row of a B3 home starts at epoch 0 with no evidence; the report that creates it is not accepted (nothing acknowledged it).
  const insert = `INSERT INTO cloud_home_health (home_id,reported_at,disk_used_percent,last_backup_at,app_reported_at,app_ok_at,boot_id,generation,app_ok,
      drop_reason,dropped_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,CASE WHEN ?8 IS NULL THEN NULL ELSE 'new_generation' END,CASE WHEN ?8 IS NULL THEN NULL ELSE ?2 END WHERE (?8 IS NULL OR EXISTS(SELECT 1 FROM cloud_homes WHERE id=?1 AND generation=?8))
    ON CONFLICT(home_id) DO UPDATE SET ${display}`;
  const binds = [homeId, now, health.diskUsedPercent ?? null, health.lastBackupAt ?? null, app === undefined ? null : now,
    app === true ? now : null, health.bootId ?? null, generation, flag(app)];
  let epoch: number | null = null;
  if (generation === null) {
    await env.DB.prepare(insert).bind(...binds).run();
  } else {
    // ?10.. the report's evidence. A row of this generation that already holds the report's epoch (?19) accepts it; ?20 its full PASS.
    const same = "cloud_home_health.generation IS ?8";
    const repeatRefused = "(?13 IS NOT NULL AND ?13=cloud_home_health.ui_rejected_at AND ?14 IS cloud_home_health.ui_rejected_instance)";
    const accept = `(${same} AND ?19 IS NOT NULL AND cloud_home_health.evidence_epoch=?19)`;
    const passed = `(${accept} AND ?20=1 AND NOT ${repeatRefused})`;
    // Accepted: the report's value. Dropped: a failure (0) still lowers the stored value, a pass never raises it. Reset: no evidence.
    const check = (column: string, value: string) => `${column}=CASE WHEN NOT ${same} THEN NULL WHEN ${accept} THEN ${value}
        WHEN ${value}=0 THEN 0 ELSE cloud_home_health.${column} END`;
    const detail = (column: string, value: string) => `${column}=CASE WHEN NOT ${same} THEN NULL WHEN ${accept} THEN ${value}
        ELSE cloud_home_health.${column} END`;
    const sql = `${insert},
      ${check("ui_bundle_ok", "?10")},
      ${check("data_writable_ok", "?11")},
      ${check("ui_renders_ok", `CASE WHEN ${repeatRefused} THEN 0 ELSE ?12 END`)},
      ${detail("ui_rendered_at", "?13")},
      ${detail("ui_instance", "?14")},
      ${detail("ui_boot_id", "?15")},
      ${detail("ui_age_ms", "?16")},
      ${detail("app_sampled_at", "?17")},
      ${detail("report_at", "?2")},
      ui_rejected_at=CASE WHEN NOT ${same} OR ?18 IS NOT NULL THEN ?18 ELSE cloud_home_health.ui_rejected_at END,
      ui_rejected_instance=CASE WHEN NOT ${same} OR ?18 IS NOT NULL THEN CASE WHEN ?18 IS NULL THEN NULL ELSE ?14 END
        ELSE cloud_home_health.ui_rejected_instance END,
      report_epoch=CASE WHEN ${accept} THEN cloud_home_health.evidence_epoch ELSE NULL END,
      report_echo=CASE WHEN ?19 IS NULL THEN 0 ELSE 1 END,
      probe_epoch=CASE WHEN ${same} THEN cloud_home_health.probe_epoch END,
      probe_instance=CASE WHEN ${same} THEN cloud_home_health.probe_instance END,
      probe_ui_at=CASE WHEN ${same} THEN cloud_home_health.probe_ui_at END,
      drop_reason=CASE WHEN NOT ${same} THEN 'new_generation' WHEN ${passed} THEN cloud_home_health.drop_reason
        WHEN NOT ${accept} THEN CASE WHEN ?19 IS NULL THEN 'no_epoch' ELSE 'stale_epoch' END
        WHEN ${repeatRefused} THEN 'clock_ahead' ELSE ?21 END,
      dropped_at=CASE WHEN ${passed} THEN cloud_home_health.dropped_at ELSE ?2 END,
      evidence_epoch=CASE WHEN NOT ${same} THEN 0 WHEN ${passed} THEN cloud_home_health.evidence_epoch
        ELSE cloud_home_health.evidence_epoch+1 END
      RETURNING evidence_epoch`;
    const result = await env.DB.prepare(sql).bind(...binds, flag(checks?.uiBundle), flag(checks?.dataWritable),
      refused ? 0 : flag(checks?.uiRenders), renderAt, renderInstance, rendered ? health.bootId ?? null : null, uiAge,
      app !== undefined && health.clock ? health.clock.wallMs : null, refused ? renderAt : null,
      echoed, pass ? 1 : 0, refused ? "clock_ahead" : "failing_check").all<{ evidence_epoch: number }>();
    // Not written: the home's generation moved while this report was decided. Still a negative event.
    if (result.results.length === 1) epoch = result.results[0].evidence_epoch;
    else await dropHealth(env, homeId, "generation_mismatch", now);
  }
  for (const event of health.events ?? []) {
    await raiseAlert(env, { homeId, kind: event.type, severity: "high",
      detail: "reported by the home" }, now, fetcher);
  }
  return epoch;
}

/** Opens an alert unless one of this kind is already open for the home and only records it (Astra AUTOCANARY-6 P2): no network. The
 *  monitoring sweep delivers it (its bounded retry of undelivered alerts). `guard` (a SELECT, with its binds) must find a row in the same
 *  statement, so an alert whose reason went away concurrently is never opened. True when a row was inserted. */
export async function persistAlert(env: Env, alert: { homeId: string; kind: string; severity: string; detail: string }, now: number,
  guard?: { sql: string; binds: unknown[] }): Promise<boolean> {
  const result = await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) SELECT ?,?,?,?,?,?
    WHERE ${guard ? `EXISTS(${guard.sql})` : "1"} ON CONFLICT DO NOTHING`)
    .bind(crypto.randomUUID(), alert.homeId, alert.kind, alert.severity, alert.detail, now, ...(guard?.binds ?? [])).run();
  return result.meta.changes === 1;
}

/** Resolves the open alert of this kind for the home without any network (Astra AUTOCANARY-6 P2): it marks the resolution notice due
 *  (resolve_notice_due) and the monitoring sweep sends it. A statement, so a caller can make it part of its own batch. */
export function resolveAlertStatement(db: D1Database, homeId: string, kind: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE home_id=? AND kind=? AND resolved_at IS NULL")
    .bind(now, homeId, kind);
}

/** Persist-only variant of raiseAlert: the INSERT as a statement, for the caller's own atomic batch (the alert commits with the state it
 *  reports, or not at all). Same row and dedupe as raiseAlert (one open alert per home and kind: ON CONFLICT DO NOTHING keeps the open one),
 *  but no delivery here: the row is left undelivered (delivered_at NULL) and sweepMonitoring's retry of undelivered alerts sends it later in
 *  the invocation (and on every later one until delivered or MAX_DELIVERY_ATTEMPTS). No network. */
export function alertStatement(db: D1Database, alert: { homeId: string; kind: string; severity: string; detail: string }, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), alert.homeId, alert.kind, alert.severity, alert.detail, now);
}

/** Astra MAILRETRY-11: an alert of ONE subject (a payment id) of a kind (provision.failed), for the caller's atomic batch. One open row per
 *  home, kind and subject (cloud_alerts_open, migration 0106): an open alert of the same kind for ANOTHER subject is left exactly as it is
 *  (open, delivered once on its own by sweepMonitoring, never closed as if resolved, its text never copied: Astra MAILRETRY-11 P2-B). The new
 *  row only references those by id ("earlier payment <subject> also failed; see alert <id>"). It is inserted only when `gateSql` (a
 *  condition binding `gateBinds`) holds, i.e. the subject's own obligation was just recorded by this batch, with the usual shape
 *  (delivered_at NULL, delivery_attempts 0), which sweepMonitoring delivers later. One delivery per row, so one per fact. No network. */
export function subjectAlertStatements(db: D1Database, alert: { homeId: string; kind: string; severity: string; detail: string; subject: string },
  gateSql: string, gateBinds: unknown[], now: number): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
      SELECT ?,?,?,?,? || COALESCE((SELECT ' | ' || group_concat('earlier payment ' || CASE WHEN a.subject<>'' THEN a.subject ELSE '(unrecorded)' END
          || ' also failed; see alert ' || a.id, ' | ') FROM cloud_alerts a WHERE a.home_id=? AND a.kind=? AND a.subject<>?),''),?,?
      WHERE ${gateSql} ON CONFLICT DO NOTHING`)
      .bind(crypto.randomUUID(), alert.homeId, alert.kind, alert.severity, alert.detail, alert.homeId, alert.kind, alert.subject, now, alert.subject, ...gateBinds),
  ];
}

/** Opens an alert unless one of this kind is already open for the home; delivers it to the webhook once. */
export async function raiseAlert(env: Env, alert: { homeId: string; kind: string; severity: string; detail: string }, now = Date.now(), fetcher?: Fetcher) {
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT DO NOTHING`).bind(id, alert.homeId, alert.kind, alert.severity, alert.detail, now).run();
  if (result.meta.changes !== 1) return false;
  await deliver(env, id, alert.detail, { kind: alert.kind, severity: alert.severity, homeId: alert.homeId, text: `[murage-cloud] ${alert.kind} home=${alert.homeId}: ${alert.detail}`, at: now }, now, fetcher);
  return true;
}

/** Resolves the open alert of this kind for the home; its ".resolved" notice is owed (resolve_notice_due) until a send of it succeeds
 *  (Astra AUTOCANARY-7 P2): sent now, and on failure retried by the monitoring sweep. */
export async function resolveAlert(env: Env, homeId: string, kind: string, now: number, fetcher?: Fetcher) {
  const open = await env.DB.prepare("SELECT id FROM cloud_alerts WHERE home_id=? AND kind=? AND resolved_at IS NULL").bind(homeId, kind).first<{ id: string }>();
  if (!open) return;
  const r = await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE id=? AND resolved_at IS NULL").bind(now, open.id).run();
  if (r.meta.changes === 1) await deliverResolution(env, { id: open.id, home_id: homeId, kind, resolved_at: now }, now, fetcher);
}

/**
 * Resolves an open alert only if `guardSql` (a SELECT that finds a reason to keep it open) returns no row, checked inside the same UPDATE
 * so another worker cannot slip a new reason in between a read and the close. Notifies only when the UPDATE actually closed a row; the
 * notice is owed until a send succeeds (resolve_notice_due, retried by the monitoring sweep).
 */
export async function resolveAlertUnless(env: Env, homeId: string, kind: string, now: number, guardSql: string, fetcher?: Fetcher) {
  const closed = await env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE home_id=? AND kind=? AND resolved_at IS NULL
    AND NOT EXISTS (${guardSql}) RETURNING id`).bind(now, homeId, kind).all<{ id: string }>();
  for (const row of closed.results) await deliverResolution(env, { id: row.id, home_id: homeId, kind, resolved_at: now }, now, fetcher);
}

/** The persist-only variant of resolveAlertUnless (claimed delivery): the guarded UPDATE marks the resolution notice due and sends nothing;
 *  sweepMonitoring delivers it, once. No network. */
export async function persistResolveUnless(env: Env, homeId: string, kind: string, now: number, guardSql: string): Promise<void> {
  await env.DB.prepare(`UPDATE cloud_alerts SET resolved_at=?,resolve_notice_due=1 WHERE home_id=? AND kind=? AND resolved_at IS NULL
    AND NOT EXISTS (${guardSql})`).bind(now, homeId, kind).run();
}

/** Webhook body always carries a `text` field, which Slack, Discord and most relays accept; a Telegram or email relay can map it.
 *  `idempotencyKey` (Astra AUTOCANARY-7 P2) names the notification (alert id and what about it is notified): it rides as the
 *  Idempotency-Key header (the body keeps its fixed fields), so a relay that dedupes makes a repeated send of the same notification harmless. */
export async function post(env: Env, payload: Record<string, unknown>, fetcher?: Fetcher, idempotencyKey?: string): Promise<boolean> {
  const url = (env as OpsEnv).ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    if (new URL(url).protocol !== "https:") return false;
    // Bounded (Astra AUTOCANARY-6 P2): aborted after ALERT_POST_TIMEOUT_MS, and given up on then even if the fetch ignores the abort.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(false); }, ALERT_POST_TIMEOUT_MS); });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    try {
      return await Promise.race([(fetcher ?? fetch)(url, { method: "POST", headers,
        body: JSON.stringify(payload), signal: controller.signal })
        .then((response) => response.ok, () => false), timeout]);
    } finally { clearTimeout(timer); }
  } catch { return false; }
}

/** A short stable digest of an alert's contents, so each revision of an alert is its own notification. */
function revision(detail: string | null): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < (detail ?? "").length; i++) { h ^= (detail ?? "").charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
/** The claim (and retry backoff) a send takes, in SQL over the attempts made before it: 1 min, doubling, at most an hour. Always well
 *  past ALERT_POST_TIMEOUT_MS, so a claim never lapses while its send can still be running. */
const claimFor = (attempts: string) => `MIN(60000*(1<<MIN(${attempts},6)),3600000)`;
/** The claim must still cover the whole send when it starts (Astra AUTOCANARY-8 P2): a send that could outlive its claim is skipped, its
 *  claim lapses and a later sweep retries it, so another worker can never take the same notification while this POST is outstanding. */
const claimCovers = (claimUntil: number | null | undefined) =>
  typeof claimUntil === "number" && Date.now() + ALERT_POST_TIMEOUT_MS < claimUntil;

/** Sends one alert under a recoverable claim (Astra AUTOCANARY-7 P2): the claim (delivery_claim_until) and the attempt are recorded
 *  before the send, so a concurrent sweep never sends it at the same time, and a send that failed, timed out or whose worker died is
 *  retried once the claim lapses. Only a successful send acknowledges it. `sentDetail` (compared null-safe, Astra WP3-4 #3) is the
 *  contents this send carries: the alert is marked delivered only if its stored contents are still exactly those (Astra WP5-6 #3).
 *  Contents that changed while the send was outstanding (an order added to the list, a new revision, which resets delivery_attempts to
 *  0 and so frees the claim) stay due, and the next sweep sends the new contents. True when this call delivered it. */
export async function deliver(env: Env, id: string, sentDetail: string, payload: Record<string, unknown>, now: number, fetcher?: Fetcher): Promise<boolean> {
  // The claim is dated by Date.now() when it is written, never by a caller's `now` (Astra AUTOCANARY-8/9 P2: a long-running caller's
  // `now` is stale), and re-checked against Date.now() before the POST. `now` only stamps delivered_at.
  const claimed = await env.DB.prepare(`UPDATE cloud_alerts SET delivery_claim_until=?2+${claimFor("delivery_attempts")},delivery_attempts=delivery_attempts+1
    WHERE id=?1 AND detail IS ?3 AND delivered_at IS NULL AND delivery_attempts<?4
      AND (delivery_claim_until IS NULL OR delivery_claim_until<=?2 OR delivery_attempts=0) RETURNING delivery_claim_until`)
    .bind(id, Date.now(), sentDetail, MAX_DELIVERY_ATTEMPTS).all<{ delivery_claim_until: number }>();
  if (claimed.results.length !== 1 || !claimCovers(claimed.results[0].delivery_claim_until)) return false;
  const ok = await post(env, payload, fetcher, `alert:${id}:${revision(sentDetail)}`);
  if (ok) await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=?,delivery_claim_until=NULL WHERE id=? AND detail IS ?").bind(now, id, sentDetail).run();
  return ok;
}

/** Sends one owed resolution notice under the same kind of claim (resolve_claim_until, resolve_attempts; Astra AUTOCANARY-7 P2): owed
 *  until a send succeeds, retried after the claim lapses, never sent by two sweeps at once. */
export async function deliverResolution(env: Env, a: { id: string; home_id: string; kind: string; resolved_at: number }, now: number,
  fetcher?: Fetcher): Promise<boolean> {
  if (!(env as OpsEnv).ALERT_WEBHOOK_URL) return false;
  const claimed = await env.DB.prepare(`UPDATE cloud_alerts SET resolve_claim_until=?2+${claimFor("resolve_attempts")},resolve_attempts=resolve_attempts+1
    WHERE id=?1 AND resolve_notice_due=1 AND resolve_attempts<?3 AND (resolve_claim_until IS NULL OR resolve_claim_until<=?2)
    RETURNING resolve_claim_until`).bind(a.id, Date.now(), MAX_DELIVERY_ATTEMPTS).all<{ resolve_claim_until: number }>();
  if (claimed.results.length !== 1 || !claimCovers(claimed.results[0].resolve_claim_until)) return false;
  const ok = await post(env, { kind: `${a.kind}.resolved`, severity: "info", homeId: a.home_id,
    text: `[murage-cloud] ${a.kind} resolved home=${a.home_id}`, at: a.resolved_at }, fetcher, `alert:${a.id}:resolved`);
  if (ok) await env.DB.prepare("UPDATE cloud_alerts SET resolve_notice_due=NULL,resolve_claim_until=NULL WHERE id=?").bind(a.id).run();
  return ok;
}

/** The refund state of every ledger operation an alert names (detail.opId, detail.items[].opId), read from refund_ops when the alert is
 *  sent (Astra WP5-6 #4): an alert records only that a refund was requested, never that it was made. */
async function refundStates(env: Env, detail: string): Promise<string> {
  let d: unknown;
  try { d = JSON.parse(detail); } catch { return ""; }
  if (!d || typeof d !== "object") return "";
  const ids = new Set<string>();
  const add = (x: unknown) => { const op = x && typeof x === "object" ? (x as { opId?: unknown }).opId : null; if (typeof op === "string" && op) ids.add(op); };
  add(d);
  const items = (d as { items?: unknown }).items;
  if (Array.isArray(items)) items.forEach(add);
  if (ids.size === 0) return "";
  const states: string[] = [];
  for (const opId of [...ids].slice(0, 20)) {
    const op = await env.DB.prepare("SELECT refunded_at,done_at FROM refund_ops WHERE id=?").bind(opId)
      .first<{ refunded_at: number | null; done_at: number | null }>();
    states.push(`${opId}=${!op ? "not found" : op.refunded_at !== null ? "refunded" : "requested"}`);
  }
  return ` | refunds: ${states.join(", ")}`;
}

interface Row { home_id: string; last_seen: number | null; disk: number | null; backup: number | null; since: number }

/** Called from the 5-minute cron. Each step is independent so one failure cannot silence the rest. */
export async function sweepMonitoring(env: Env, now = Date.now(), fetcher?: Fetcher) {
  const homes = await env.DB.prepare(`
    SELECT h.id AS home_id, h.heartbeat_at AS last_seen, x.disk_used_percent AS disk, x.last_backup_at AS backup, h.updated_at AS since
      FROM cloud_homes h LEFT JOIN cloud_home_health x ON x.home_id=h.id
      WHERE h.desired_state='ready' AND h.observed_state='ready'
    UNION ALL
    SELECT m.id, c.heartbeat_at, x.disk_used_percent, x.last_backup_at, m.created_at
      FROM cloud_machines m JOIN cloud_cp0_control c ON c.machine_id=m.id AND c.generation=m.generation
      LEFT JOIN cloud_home_health x ON x.home_id=m.id
      WHERE m.state='active' AND NOT EXISTS (SELECT 1 FROM cloud_homes WHERE id=m.id)`).all<Row>();
  // Alerts and resolutions are only recorded here; the delivery stage below sends them, bounded, so a stalled webhook never makes this
  // loop (or the cron) wait on one send per home.
  const record = (homeId: string, kind: string, severity: string, detail: string) => persistAlert(env, { homeId, kind, severity, detail }, now);
  const resolve = (homeId: string, kind: string) => resolveAlertStatement(env.DB, homeId, kind, now).run();
  for (const home of homes.results) {
    const seen = home.last_seen ?? home.since;
    if (now - seen > HEARTBEAT_MISS_MS) {
      await record(home.home_id, "home.heartbeat_missed", "high", `no heartbeat for ${Math.floor((now - seen) / 60_000)} min`);
    } else await resolve(home.home_id, "home.heartbeat_missed");
    if (home.disk !== null && home.disk >= DISK_ALERT_PERCENT) {
      await record(home.home_id, "home.disk_high", "medium", `data volume ${home.disk}% full`);
    } else if (home.disk !== null) await resolve(home.home_id, "home.disk_high");
    // A home that reports backups but has not completed one for 26 h; homes not yet reporting a backup are skipped.
    if (home.backup !== null && now - home.backup > BACKUP_STALE_MS) {
      await record(home.home_id, "home.backup_stale", "medium", `last backup ${Math.floor((now - home.backup) / 3_600_000)} h ago`);
    } else if (home.backup !== null) await resolve(home.home_id, "home.backup_stale");
  }
  // The delivery stage (Astra AUTOCANARY-6/7/8 P2): undelivered alerts (webhook down, just configured, or recorded without network) and
  // owed resolution notices whose claim is free, each sent under its own recoverable claim (deliver, deliverResolution) dated when it is
  // written (Date.now()), at most ALERT_SEND_CONCURRENCY at once. Resolutions go first (at most RESOLUTION_SEND_LIMIT, none started after
  // RESOLUTION_STAGE_MS), then alerts (at most ALERT_SEND_LIMIT, none started after ALERT_STAGE_MS from the stage's start): neither
  // backlog starves the other, and stalled sends cost the sweep at most ALERT_STAGE_MS + ALERT_POST_TIMEOUT_MS.
  if ((env as OpsEnv).ALERT_WEBHOOK_URL) {
    const resolved = await env.DB.prepare(`SELECT id,home_id,kind,resolved_at FROM cloud_alerts WHERE resolve_notice_due=1 AND resolve_attempts<?
      AND (resolve_claim_until IS NULL OR resolve_claim_until<=?) ORDER BY resolved_at LIMIT ?`)
      .bind(MAX_DELIVERY_ATTEMPTS, Date.now(), RESOLUTION_SEND_LIMIT).all<{ id: string; home_id: string; kind: string; resolved_at: number }>();
    const started = Date.now();
    const stage = async (sends: (() => Promise<unknown>)[], budgetMs: number) => {
      let next = 0;
      const worker = async () => {
        while (next < sends.length && Date.now() - started < budgetMs) {
          const send = sends[next++];
          try { await send(); } catch { /* one failed send never stops the rest; its claim lapses and a later sweep retries it */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(ALERT_SEND_CONCURRENCY, sends.length) }, worker));
    };
    await stage(resolved.results.map((a) => () => deliverResolution(env, a, now, fetcher)), RESOLUTION_STAGE_MS);
    // Alerts (Astra AUTOCANARY-10 P2). The backlog is counted first, so alerts.backlog itself is opened (or resolved) before the run is
    // chosen, and while it is open and undelivered it is sent first. The run is then at most ALERT_SEND_LIMIT alerts: ALERT_OLDEST_SHARE of
    // them reserved for the oldest non-urgent alerts, by age alone, the rest by priority (urgent kinds, then severity, then age),
    // interleaved two priority to one oldest. A flood of urgent alerts can never starve the oldest, nor hide the backlog alert.
    const claimable = `delivered_at IS NULL AND resolved_at IS NULL AND delivery_attempts<?1
      AND (delivery_claim_until IS NULL OR delivery_claim_until<=?2 OR delivery_attempts=0)`;
    const notBacklog = "NOT (home_id='ops' AND kind=?3)";
    const waiting = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cloud_alerts WHERE ${claimable} AND ${notBacklog}`)
      .bind(MAX_DELIVERY_ATTEMPTS, Date.now(), ALERT_BACKLOG_ALERT).first<{ n: number }>();
    if ((waiting?.n ?? 0) > ALERT_SEND_LIMIT) {
      await persistAlert(env, { homeId: "ops", kind: ALERT_BACKLOG_ALERT, severity: "high",
        detail: `more than ${ALERT_SEND_LIMIT} undelivered alerts wait; ${ALERT_SEND_LIMIT} are sent per sweep, the most urgent and the oldest first` }, now);
    } else await resolveAlertStatement(env.DB, "ops", ALERT_BACKLOG_ALERT, now).run();
    type Pending = { id: string; home_id: string; kind: string; severity: string; detail: string; raised_at: number };
    const columns = "id,home_id,kind,severity,detail,raised_at";
    const urgent = URGENT_ALERT_KINDS.map((kind) => `'${kind}'`).join(",");
    const at = Date.now();
    const [backlog, oldest, priority] = await env.DB.batch<Pending>([
      env.DB.prepare(`SELECT ${columns} FROM cloud_alerts WHERE ${claimable} AND NOT ${notBacklog}`)
        .bind(MAX_DELIVERY_ATTEMPTS, at, ALERT_BACKLOG_ALERT),
      env.DB.prepare(`SELECT ${columns} FROM cloud_alerts WHERE ${claimable} AND ${notBacklog} AND kind NOT IN (${urgent})
        ORDER BY raised_at,id LIMIT ?4`).bind(MAX_DELIVERY_ATTEMPTS, at, ALERT_BACKLOG_ALERT, ALERT_OLDEST_SHARE),
      env.DB.prepare(`SELECT ${columns} FROM cloud_alerts WHERE ${claimable} AND ${notBacklog}
        ORDER BY CASE WHEN kind IN (${urgent}) THEN 0 ELSE 1 END,
          CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, raised_at,id LIMIT ?4`)
        .bind(MAX_DELIVERY_ATTEMPTS, at, ALERT_BACKLOG_ALERT, ALERT_SEND_LIMIT + ALERT_OLDEST_SHARE),
    ]);
    const run: Pending[] = [...(backlog.results ?? [])];
    const room = ALERT_SEND_LIMIT - run.length;
    const byAge = (oldest.results ?? []).slice(0, Math.min(ALERT_OLDEST_SHARE, room));
    const reserved = new Set(byAge.map((a) => a.id));
    const byPriority = (priority.results ?? []).filter((a) => !reserved.has(a.id)).slice(0, room - byAge.length);
    // Interleaved two priority to one oldest, so a stage cut short by a stalled webhook still reaches both.
    while (byPriority.length || byAge.length) {
      for (const queue of [byPriority, byPriority, byAge]) { const a = queue.shift(); if (a) run.push(a); }
    }
    await stage(run.map((a) => async () => deliver(env, a.id, a.detail, { kind: a.kind, severity: a.severity, homeId: a.home_id,
      text: `[murage-cloud] ${a.kind} home=${a.home_id}: ${a.detail}${await refundStates(env, a.detail)}`, at: a.raised_at }, now, fetcher)),
      ALERT_STAGE_MS);
  }
  await dailySummary(env, homes.results, now, fetcher);
  await env.DB.prepare("DELETE FROM cloud_alerts WHERE resolved_at IS NOT NULL AND resolved_at<?").bind(now - ALERT_RETENTION_MS).run();
}

async function dailySummary(env: Env, homes: Row[], now: number, fetcher?: Fetcher) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (new Date(now).getUTCHours() < SUMMARY_HOUR_UTC) return;
  const last = await env.DB.prepare("SELECT value FROM cloud_ops_state WHERE key='daily_summary_day'").first<{ value: string }>();
  if (last?.value === day) return;
  const open = await env.DB.prepare("SELECT kind,COUNT(*) AS n FROM cloud_alerts WHERE resolved_at IS NULL GROUP BY kind").all<{ kind: string; n: number }>();
  const raised = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE raised_at>?").bind(now - 86_400_000).first<{ n: number }>();
  const disk = homes.filter((h) => h.disk !== null && h.disk >= DISK_ALERT_PERCENT).length;
  const noBackup = homes.filter((h) => h.backup === null || now - h.backup > BACKUP_STALE_MS).length;
  const stale = homes.filter((h) => now - (h.last_seen ?? h.since) > HEARTBEAT_MISS_MS).length;
  const text = `[murage-cloud] daily summary ${day}: ${homes.length} homes, ${stale} silent, ${disk} disk >= ${DISK_ALERT_PERCENT}%, ${noBackup} without a fresh backup, `
    + `${raised?.n ?? 0} alerts in 24 h, open: ${open.results.map((o) => `${o.kind}=${o.n}`).join(", ") || "none"}`;
  // Mark the day only if it was delivered, so a down webhook retries on the next tick.
  if (await post(env, { kind: "daily.summary", severity: "info", text, at: now }, fetcher, `daily:${day}`) || !(env as OpsEnv).ALERT_WEBHOOK_URL) {
    await env.DB.prepare("INSERT INTO cloud_ops_state (key,value) VALUES ('daily_summary_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(day).run();
  }
}
