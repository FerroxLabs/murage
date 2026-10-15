// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ready-team set of the shared queue (shared-work.ts drainSharedWork).
//
// Shared work is strict FIFO per (bot, team): only the HEAD of a team (a continuation wake of its running request, else its oldest queued request) is ever
// considered, and only SHARED rows (room_requests.shared_work) are in a team's FIFO. The drain does not walk the queue. It serves the teams whose head may be startable now, round-robin, from this table:
//   - one row per (bot, team) with queued work; `waiting=0` is ready, `waiting=1` is a team whose head was found waiting (its target busy, its cap full);
//   - `gen` moves on with every event for the team, so a pass that read the team before the event never overwrites it;
//   - `seq` is the team's place in the round: a team that becomes ready, or that was just served, goes behind every team already ready, so each ready team
//     is served within ceil(ready teams / SHARED_DRAIN_TEAMS) passes whatever arrives meanwhile;
//   - a team ENTERS (or wakes) only on events, written by the database itself in the same statement as the event (the triggers below): a new head, its
//     running request ending or going back to the queue (which also frees one of the bot's slots: the oldest teams waiting on the bot wake), a parked
//     request released. The server adds the rest: the head's conversation freeing (`wakeSharedThread`, by the row's thread, which follows the current head),
//     any turn of the bot ending (`wakeSharedBot`), a bot's own drain event waking a small fixed page of its oldest waiting teams (`wakeOldestWaiting`), and a
//     bounded safety sweep every SWEEP_MS with its position kept in `shared_drain_sweep` (`sweepWaitingTeams`, visited a few bots per pump).
//   - `wait_on` says what a waiting team waits on (WaitOn), so each of those events wakes only the teams it frees.
// Waiting teams are never re-checked by a pass, so the work of a pass follows the ready teams it serves (at most SHARED_DRAIN_TEAMS), never the backlog.
import type { DatabaseSync } from "node:sqlite";

export const SHARED_READY_TABLE = "shared_ready_teams";
export const SHARED_SWEEP_TABLE = "shared_drain_sweep";
export const SHARED_READY_TRIGGERS = ["shared_ready_insert", "shared_ready_park", "shared_ready_state", "shared_ready_unpark"] as const;
export const SHARED_READY_INDEXES = ["shared_ready_order", "shared_ready_seq", "shared_ready_thread", "shared_ready_live", "shared_ready_bot_wait"] as const;
/** What a waiting team waits on, so the event that frees it wakes it directly:
 *  - `thread`: its head's conversation is busy (woken when that conversation frees: `wakeSharedThread`, by the row's thread, which follows the current head);
 *  - `team`: its own running request holds the team's slot (woken by that request's end: the state trigger, for the team);
 *  - `bot`: the bot is full (the total cap of shared conversations, its thread ceiling, a room turn): woken a page at a time, oldest first, when the bot frees
 *    a slot (a shared request of the bot ends: the state trigger; any turn of the bot ends: `wakeSharedBot`);
 *  - `other`: anything with no event of its own (a refusal for now, an unresolved teammate): the bot's own drain events and the safety sweep. */
export type WaitOn = "thread" | "team" | "bot" | "other";
/** The shared-work mark on a request row (room_requests.shared_work): set by the database from the request's provenance (an ask or message with a
 * shared_request_provenance row, or a wake whose parent has one), whichever of the two is written first. A team's FIFO is its SHARED rows only: a teammate's
 * room ask or a card run in the same (bot, team) is not shared work and never heads it. */
export const SHARED_MARK_TRIGGERS = ["room_request_mark_shared", "shared_provenance_mark_request"] as const;
export const SHARED_MARK_INDEXES = ["room_requests_shared_team", "room_requests_shared_wake"] as const;
/** How many waiting teams one drain invocation wakes (oldest first; a woken team that still waits goes behind the others, so they take turns). */
export const SHARED_WAKE_PAGE = 8;
/** The safety sweep: every 10 minutes, waiting teams are woken a page at a time. */
export const SWEEP_MS = 10 * 60_000;
export const SWEEP_PAGE = 100;

const TEAM_OF = (alias: string) => `json_extract(${alias}.execution_audience,'$.team')`;
const NEXT_SEQ = (bot: string) => `(SELECT COALESCE(MAX(s.seq),0)+1 FROM shared_ready_teams s WHERE s.bot_id=${bot})`;
/** Queued rows of the team other than NEW (the runnable index's own terms, so the lookup is one seek). */
const OTHER_QUEUED = `SELECT 1 FROM room_requests r WHERE r.state='queued' AND r.refusal IS NOT 'retained_unresolved' AND r.to_bot_id=NEW.to_bot_id AND ${TEAM_OF("r")}=${TEAM_OF("NEW")} AND r.id<>NEW.id`;
const ANY_QUEUED = `SELECT 1 FROM room_requests r WHERE r.state='queued' AND r.refusal IS NOT 'retained_unresolved' AND r.to_bot_id=NEW.to_bot_id AND ${TEAM_OF("r")}=${TEAM_OF("NEW")}`;
const ENTER = (when: string) => `INSERT OR IGNORE INTO shared_ready_teams(bot_id,team,thread_id,seq,waiting) SELECT NEW.to_bot_id, ${TEAM_OF("NEW")}, NEW.target_thread_id, ${NEXT_SEQ("NEW.to_bot_id")}, 0 WHERE ${when};`;
/** An event for the team: a waiting team is ready again behind the others; a ready one keeps its place. Either way its generation moves on, so a pass that read
 * the team before the event never overwrites what the event gave it (applyReadyChanges checks the generation). */
const WAKE = (extra: string) => `UPDATE shared_ready_teams SET ${WAKE_ROW("NEW.to_bot_id")}, thread_id=${HEAD_THREAD("NEW.to_bot_id", TEAM_OF("NEW"))} WHERE bot_id=NEW.to_bot_id AND team=${TEAM_OF("NEW")}${extra};`;
const SHARED_ROW = `NEW.to_bot_id IS NOT NULL AND ${TEAM_OF("NEW")} IS NOT NULL`;
/** The conversation of the team's CURRENT head (its shared continuation wake, else its oldest shared request), keeping the row's own when the head is not
 * known yet (a request whose shared mark is written after this statement): the row follows its head, never the request that first brought the team in. */
const HEAD_THREAD = (bot: string, team: string) => `COALESCE(
  (SELECT h.target_thread_id FROM room_requests h WHERE h.state='queued' AND h.verb='wake' AND h.refusal IS NOT 'retained_unresolved' AND h.shared_work=1 AND h.to_bot_id=${bot} AND ${TEAM_OF("h")}=${team} ORDER BY h.created_at, h.id LIMIT 1),
  (SELECT h.target_thread_id FROM room_requests h WHERE h.state='queued' AND h.refusal IS NOT 'retained_unresolved' AND h.shared_work=1 AND h.to_bot_id=${bot} AND ${TEAM_OF("h")}=${team} ORDER BY h.created_at, h.id LIMIT 1),
  thread_id)`;
/** How many teams waiting on the bot one freed slot wakes (oldest first); a pass that then finds the bot free with none of them able to use it wakes the next page. */
export const SHARED_BOT_WAKE_PAGE = 8;
const BOT_WAITERS = (bot: string) => `team IN (SELECT w.team FROM shared_ready_teams w WHERE w.bot_id=${bot} AND w.waiting=1 AND w.wait_on='bot' ORDER BY w.seq, w.team LIMIT ${SHARED_BOT_WAKE_PAGE})`;
const WAKE_ROW = (bot: string) => `seq=CASE WHEN waiting=1 THEN ${NEXT_SEQ(bot)} ELSE seq END, waiting=0, wait_on=NULL, gen=gen+1`;

const DDL = `CREATE TABLE IF NOT EXISTS shared_ready_teams (
  bot_id TEXT NOT NULL,
  team TEXT NOT NULL,
  thread_id TEXT,
  seq INTEGER NOT NULL,
  waiting INTEGER NOT NULL DEFAULT 0 CHECK(waiting IN (0,1)),
  gen INTEGER NOT NULL DEFAULT 0,
  wait_on TEXT,
  PRIMARY KEY (bot_id, team)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS shared_ready_order ON shared_ready_teams(bot_id, waiting, seq, team);
CREATE INDEX IF NOT EXISTS shared_ready_seq ON shared_ready_teams(bot_id, seq);
CREATE INDEX IF NOT EXISTS shared_ready_thread ON shared_ready_teams(thread_id, waiting) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shared_ready_live ON shared_ready_teams(bot_id) WHERE waiting=0;
CREATE TABLE IF NOT EXISTS shared_drain_sweep (bot_id TEXT PRIMARY KEY NOT NULL, due_at INTEGER NOT NULL, end_seq INTEGER);`;
/** Made after the wait_on column exists (an older set gets it by ALTER first). */
const WAIT_INDEX = "CREATE INDEX IF NOT EXISTS shared_ready_bot_wait ON shared_ready_teams(bot_id, seq, team) WHERE waiting=1 AND wait_on='bot';";
/** The triggers are made again on every start (dropped and created in the same savepoint), so a database a development build wrote gets these bodies. */
const TRIGGERS = `-- a queued team-tagged request: its team is in the set; a waiting team wakes only when this request is its new head (a continuation wake, or its only queued request)
CREATE TRIGGER IF NOT EXISTS shared_ready_insert AFTER INSERT ON room_requests
WHEN NEW.state='queued' AND NEW.refusal IS NOT 'retained_unresolved' AND ${SHARED_ROW}
BEGIN
  ${ENTER("1")}
  ${WAKE(` AND (NEW.verb='wake' OR NOT EXISTS (${OTHER_QUEUED}))`)}
END;
-- a request leaves an active state, or the queue, other than by starting: its team's head (or its team cap) changed
CREATE TRIGGER IF NOT EXISTS shared_ready_state AFTER UPDATE OF state ON room_requests
WHEN OLD.state IS NOT NEW.state AND NEW.state NOT IN ('running','waiting_owner','waiting_bot') AND ${SHARED_ROW}
BEGIN
  ${ENTER(`EXISTS (${ANY_QUEUED})`)}
  ${WAKE("")}
  -- a running request of the bot ended: one of the bot's slots is free, so the oldest teams waiting on the bot are ready again (directly, not by a page or the sweep)
  UPDATE shared_ready_teams SET ${WAKE_ROW("NEW.to_bot_id")} WHERE bot_id=NEW.to_bot_id AND OLD.state IN ('running','waiting_owner','waiting_bot') AND ${BOT_WAITERS("NEW.to_bot_id")};
END;
-- a request is parked (its teammate is not listed): a team left with nothing runnable leaves the set, so no pass looks at it until a request is released;
-- a team with other runnable work has a new head: it is considered again
CREATE TRIGGER IF NOT EXISTS shared_ready_park AFTER UPDATE OF refusal ON room_requests
WHEN NEW.refusal IS 'retained_unresolved' AND OLD.refusal IS NOT 'retained_unresolved' AND NEW.state='queued' AND ${SHARED_ROW}
BEGIN
  DELETE FROM shared_ready_teams WHERE bot_id=NEW.to_bot_id AND team=${TEAM_OF("NEW")} AND NOT EXISTS (${ANY_QUEUED});
  ${WAKE("")}
END;
-- a parked request is released: its team is considered again
CREATE TRIGGER IF NOT EXISTS shared_ready_unpark AFTER UPDATE OF refusal ON room_requests
WHEN OLD.refusal IS 'retained_unresolved' AND NEW.refusal IS NOT 'retained_unresolved' AND NEW.state='queued' AND ${SHARED_ROW}
BEGIN
  ${ENTER("1")}
  ${WAKE("")}
END;`;

/** Creates the set (with room_requests already present) and fills it from the queue on EVERY start: each team with queued work that is not in the set yet joins it
 * behind the teams already there, oldest head first. The set is derived from the durable queue, never trusted to have been filled once: a start that was cut short
 * after the table was created and before it was filled (or any other lost entry) is made whole by the next start. A team already in the set keeps its place and
 * its state. The schema and the fill commit together (one savepoint, so it also nests in a caller's transaction). */
export function initializeSharedReady(db: DatabaseSync): void {
  db.exec("SAVEPOINT shared_ready_init");
  try {
    db.exec(DDL);
    const readyColumns = (db.prepare("PRAGMA table_info(shared_ready_teams)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!readyColumns.includes("gen")) db.exec("ALTER TABLE shared_ready_teams ADD COLUMN gen INTEGER NOT NULL DEFAULT 0");
    if (!readyColumns.includes("wait_on")) db.exec("ALTER TABLE shared_ready_teams ADD COLUMN wait_on TEXT");
    db.exec(WAIT_INDEX);
    for (const name of SHARED_READY_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    // the mark column first: the triggers read it (a team's current head)
    if (!(db.prepare("PRAGMA table_info(room_requests)").all() as Array<{ name: string }>).some((column) => column.name === "shared_work")) db.exec("ALTER TABLE room_requests ADD COLUMN shared_work INTEGER");
    db.exec(TRIGGERS);
    db.exec(MARK_INDEXES);
    ensureSharedMark(db);
    db.exec(`INSERT OR IGNORE INTO shared_ready_teams(bot_id,team,thread_id,seq,waiting)
      SELECT q.to_bot_id, q.team, q.thread, (SELECT COALESCE(MAX(s.seq),0) FROM shared_ready_teams s WHERE s.bot_id=q.to_bot_id) + ROW_NUMBER() OVER (PARTITION BY q.to_bot_id ORDER BY q.first, q.team), 0 FROM (
        SELECT to_bot_id, ${TEAM_OF("room_requests")} AS team, MAX(target_thread_id) AS thread, MIN(created_at) AS first FROM room_requests
        WHERE state='queued' AND refusal IS NOT 'retained_unresolved' AND to_bot_id IS NOT NULL AND ${TEAM_OF("room_requests")} IS NOT NULL GROUP BY 1, 2) q
      WHERE NOT EXISTS (SELECT 1 FROM shared_ready_teams r WHERE r.bot_id=q.to_bot_id AND r.team=q.team)`);
    db.exec("RELEASE shared_ready_init");
  } catch (error) {
    db.exec("ROLLBACK TO shared_ready_init; RELEASE shared_ready_init");
    throw error;
  }
}

const MARK_INDEXES = `-- a team's FIFO (shared-work.ts sharedTeamHead): its shared rows only, oldest first, and its shared continuation wake; one seek each
CREATE INDEX IF NOT EXISTS room_requests_shared_team ON room_requests(to_bot_id, json_extract(execution_audience,'$.team'), created_at, id) WHERE state='queued' AND refusal IS NOT 'retained_unresolved' AND shared_work=1;
CREATE INDEX IF NOT EXISTS room_requests_shared_wake ON room_requests(to_bot_id, json_extract(execution_audience,'$.team'), created_at, id) WHERE state='queued' AND verb='wake' AND refusal IS NOT 'retained_unresolved' AND shared_work=1;`;
/** The mark's triggers, once both room_requests (with its mark column) and shared_request_provenance exist (they come up in either order). The first time, the
 * requests that are still live are marked from their provenance (the queue, never the history). */
export function ensureSharedMark(db: DatabaseSync): void {
  const has = (type: string, name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type=? AND name=?").get(type, name));
  if (!has("table", "room_requests") || !has("table", "shared_request_provenance")) return;
  if (!(db.prepare("PRAGMA table_info(room_requests)").all() as Array<{ name: string }>).some((column) => column.name === "shared_work")) return;
  const marked = has("trigger", SHARED_MARK_TRIGGERS[0]);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${SHARED_MARK_TRIGGERS[0]} AFTER INSERT ON room_requests
WHEN (NEW.verb IN ('ask','message') AND EXISTS (SELECT 1 FROM shared_request_provenance p WHERE p.request_id=NEW.id))
  OR (NEW.verb='wake' AND NEW.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM shared_request_provenance p WHERE p.request_id=NEW.parent_id))
BEGIN UPDATE room_requests SET shared_work=1 WHERE id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS ${SHARED_MARK_TRIGGERS[1]} AFTER INSERT ON shared_request_provenance
BEGIN
  UPDATE room_requests SET shared_work=1 WHERE id=NEW.request_id AND verb IN ('ask','message') AND shared_work IS NOT 1;
  UPDATE room_requests SET shared_work=1 WHERE parent_id=NEW.request_id AND verb='wake' AND shared_work IS NOT 1;
END;`);
  if (!marked) db.exec(`UPDATE room_requests SET shared_work=1 WHERE state IN ('queued','running','waiting_owner','waiting_bot') AND shared_work IS NULL AND (
    (verb IN ('ask','message') AND id IN (SELECT request_id FROM shared_request_provenance)) OR (verb='wake' AND parent_id IN (SELECT request_id FROM shared_request_provenance)))`);
}

/** The first ready team of this bot's round (the least place). */
export function nextReadyTeam(db: DatabaseSync, botId: string): string | null {
  const row = db.prepare("SELECT team FROM shared_ready_teams WHERE bot_id=? AND waiting=0 ORDER BY seq, team LIMIT 1").get(botId) as { team: string } | undefined;
  return row ? String(row.team) : null;
}
/** The first few ready teams in round order (for the "is it next?" question, which skips a ready team that has no head any more). */
export function readyTeams(db: DatabaseSync, botId: string, limit: number): string[] {
  return (db.prepare("SELECT team FROM shared_ready_teams WHERE bot_id=? AND waiting=0 ORDER BY seq, team LIMIT ?").all(botId, limit) as Array<{ team: string }>).map((row) => String(row.team));
}
/** The next `limit` ready teams of this bot's round, with the place and the generation each holds now (one seek on shared_ready_order). */
export function readyPage(db: DatabaseSync, botId: string, limit: number): Array<{ team: string; seq: number; gen: number }> {
  return (db.prepare("SELECT team, seq, gen FROM shared_ready_teams WHERE bot_id=? AND waiting=0 ORDER BY seq, team LIMIT ?").all(botId, limit) as Array<{ team: string; seq: number; gen: number }>)
    .map((row) => ({ team: String(row.team), seq: Number(row.seq), gen: Number(row.gen) }));
}
/** What a pass decided for one team: it leaves the set (its head started, or it has none), it waits, or it goes behind the others (a request settled). */
export type ReadyChange = { team: string; seq: number; gen: number; to: "leave" | "wait" | "back"; on?: WaitOn; thread?: string | null };
/** Applies a pass's decisions, each only if the team is still as the pass read it (its place, and its generation: no event for it since): a team an event
 * touched meanwhile, even one that was already ready (a request of it went back to the queue, a new head arrived), keeps what the event gave it and is decided
 * again, so no wake-up is ever overwritten. The caller runs this in one transaction (one commit per pass, not one per team). */
export function applyReadyChanges(db: DatabaseSync, botId: string, changes: readonly ReadyChange[]): void {
  const leave = db.prepare("DELETE FROM shared_ready_teams WHERE bot_id=? AND team=? AND seq=? AND gen=? AND waiting=0");
  // a team that waits records what it waits on and the conversation of the head it waits with (the thread wake follows the current head)
  const wait = db.prepare("UPDATE shared_ready_teams SET waiting=1, wait_on=?, thread_id=COALESCE(?, thread_id) WHERE bot_id=? AND team=? AND seq=? AND gen=? AND waiting=0");
  const back = db.prepare(`UPDATE shared_ready_teams SET seq=${NEXT_SEQ("?")} WHERE bot_id=? AND team=? AND seq=? AND gen=? AND waiting=0`);
  for (const change of changes) {
    if (change.to === "leave") leave.run(botId, change.team, change.seq, change.gen);
    else if (change.to === "wait") wait.run(change.on ?? "other", change.thread ?? null, botId, change.team, change.seq, change.gen);
    else back.run(botId, botId, change.team, change.seq, change.gen);
  }
}
/** Its head started (or it has no queued work): the team leaves the set. It comes back on its next event. */
export function leaveReady(db: DatabaseSync, botId: string, team: string): void {
  db.prepare("DELETE FROM shared_ready_teams WHERE bot_id=? AND team=?").run(botId, team);
}
/** Its head waits: the team stays in the set as waiting, keeping its place among the waiting, and is not looked at again until an event wakes it. */
export function waitReady(db: DatabaseSync, botId: string, team: string): void {
  db.prepare("UPDATE shared_ready_teams SET waiting=1, wait_on='other' WHERE bot_id=? AND team=? AND waiting=0").run(botId, team);
}
/** It was served (a request settled) and may have more: behind every team now ready. */
export function readyToBack(db: DatabaseSync, botId: string, team: string): void {
  db.prepare(`UPDATE shared_ready_teams SET seq=${NEXT_SEQ("?")} WHERE bot_id=? AND team=?`).run(botId, botId, team);
}
/** The oldest `limit` waiting teams of this bot are ready again, behind the ready ones (a still-waiting one goes back to waiting behind the others). */
export type Atomically = (writes: () => void) => void;
const direct: Atomically = (writes) => writes();
export function wakeOldestWaiting(db: DatabaseSync, botId: string, limit = SHARED_WAKE_PAGE, atomically: Atomically = direct): number {
  const teams = (db.prepare("SELECT team FROM shared_ready_teams WHERE bot_id=? AND waiting=1 ORDER BY seq, team LIMIT ?").all(botId, limit) as Array<{ team: string }>).map((row) => String(row.team));
  if (!teams.length) return 0;
  const wake = db.prepare(`UPDATE shared_ready_teams SET waiting=0, wait_on=NULL, seq=${NEXT_SEQ("?")} WHERE bot_id=? AND team=? AND waiting=1`);
  atomically(() => { for (const team of teams) wake.run(botId, botId, team); });
  return teams.length;
}
/** A conversation freed (its run ended): the teams whose work runs there are ready again. One indexed update. */
export function wakeSharedThread(db: DatabaseSync, threadId: string): void {
  db.prepare("UPDATE shared_ready_teams SET seq=CASE WHEN waiting=1 THEN (SELECT COALESCE(MAX(s.seq),0)+1 FROM shared_ready_teams s WHERE s.bot_id=shared_ready_teams.bot_id) ELSE seq END, waiting=0, wait_on=NULL, gen=gen+1 WHERE thread_id=?").run(threadId);
}
/** A slot of this bot freed (a turn of it ended, a room turn among them): the oldest teams waiting on the bot are ready again, one indexed update. Returns how
 * many it woke. */
export function wakeSharedBot(db: DatabaseSync, botId: string): number {
  return Number(db.prepare(`UPDATE shared_ready_teams SET ${WAKE_ROW("?")} WHERE bot_id=? AND ${BOT_WAITERS("?")}`).run(botId, botId, botId).changes);
}
/** Whether any team of this bot waits on the bot (one seek in shared_ready_bot_wait). */
export function hasBotWaiters(db: DatabaseSync, botId: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS x FROM shared_ready_teams WHERE bot_id=? AND waiting=1 AND wait_on='bot' LIMIT 1").get(botId));
}
/** The next bots (after `after`, in id order) that have a ready team: what a pump drains. One seek in shared_ready_live. */
export function botsWithReadyTeams(db: DatabaseSync, after: string, limit: number): string[] {
  return (db.prepare("SELECT DISTINCT bot_id FROM shared_ready_teams WHERE waiting=0 AND bot_id>? ORDER BY bot_id LIMIT ?").all(after, limit) as Array<{ bot_id: string }>).map((row) => String(row.bot_id));
}
/** The next bot (after `after`, in id order) that has a waiting team: what the global safety sweep visits. */
export function nextBotWithWaiting(db: DatabaseSync, after: string): string | null {
  const row = db.prepare("SELECT bot_id FROM shared_ready_teams WHERE bot_id>? AND waiting=1 ORDER BY bot_id LIMIT 1").get(after) as { bot_id: string } | undefined;
  return row ? String(row.bot_id) : null;
}
const sweepDue = new WeakMap<DatabaseSync, Map<string, number>>();
/** The bounded safety sweep: due every SWEEP_MS (and once per bot after a start), it wakes at most SWEEP_PAGE waiting teams per call, oldest first, up to the
 * last place that existed when the sweep began (kept in shared_drain_sweep with its due time, so a restart resumes it). Between sweeps it costs no statement:
 * the due time is remembered. Returns how many it woke. */
export function sweepWaitingTeams(db: DatabaseSync, botId: string, now: number, atomically: Atomically = direct): number {
  let due = sweepDue.get(db);
  if (!due) { due = new Map(); sweepDue.set(db, due); }
  const known = due.get(botId);
  if (known !== undefined && now < known) return 0;
  // the first look in this process (a start is an event: every waiting team is owed one look) or a sweep that is due or under way
  const state = known === undefined ? undefined : db.prepare("SELECT end_seq FROM shared_drain_sweep WHERE bot_id=?").get(botId) as { end_seq: number | null } | undefined;
  const end = state?.end_seq ?? null;
  const teams = (db.prepare("SELECT team FROM shared_ready_teams WHERE bot_id=? AND waiting=1 AND seq<=COALESCE(?, (SELECT MAX(s.seq) FROM shared_ready_teams s WHERE s.bot_id=?)) ORDER BY seq, team LIMIT ?")
    .all(botId, end, botId, SWEEP_PAGE) as Array<{ team: string }>).map((row) => String(row.team));
  const wake = db.prepare(`UPDATE shared_ready_teams SET waiting=0, wait_on=NULL, seq=${NEXT_SEQ("?")} WHERE bot_id=? AND team=? AND waiting=1`);
  // a full page: the sweep goes on, and its end is fixed (persisted) before anything it wakes takes a later place
  const keep = teams.length >= SWEEP_PAGE;
  // one statement needs no enclosing transaction; several commit together
  (teams.length ? atomically : direct)(() => {
    if (keep) db.prepare("INSERT INTO shared_drain_sweep(bot_id, due_at, end_seq) VALUES(?,?,COALESCE(?, (SELECT MAX(s.seq) FROM shared_ready_teams s WHERE s.bot_id=?))) ON CONFLICT(bot_id) DO UPDATE SET due_at=excluded.due_at, end_seq=excluded.end_seq").run(botId, now, end, botId);
    for (const team of teams) wake.run(botId, botId, team);
    if (!keep) db.prepare("INSERT INTO shared_drain_sweep(bot_id, due_at, end_seq) VALUES(?,?,NULL) ON CONFLICT(bot_id) DO UPDATE SET due_at=excluded.due_at, end_seq=NULL").run(botId, now + SWEEP_MS);
  });
  due.set(botId, keep ? now : now + SWEEP_MS);
  return teams.length;
}
