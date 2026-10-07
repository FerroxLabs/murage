// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The project record tables (SPEC-P section 3, lane R).
//
// Every durable project record is a messages.db app table created here by one
// initializer, registered in APP_TABLES (server/installation-database-snapshot.ts)
// with `required: false`, so an archive from before the projects release still
// restores and inspects. The DDL below is the contract, frozen at merge: a
// later change is only ever `ALTER TABLE ADD COLUMN <nullable>` listed in that
// table's `optional` array, in order. No `memory_*` object and no memory
// schema bump belongs to this lane.
//
// This module also holds the shared row validator (SPEC-P 15.2), the group
// deletion sweep (section 2), activity pruning (section 2) and the forget
// purge for derived rows (15.3). Restore preparation and paused validation
// live here too (15.1), because they are table business and nothing else.
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { rollupSettledUsage } from "./usage-ledger.ts";
import { LIVE_PROJECT_CLOSES_SQL } from "./room-requests.ts";

import { InstallationSnapshotError } from "./installation-snapshot-error.ts";
import { DEFAULT_PROJECT_PARTS } from "./project-defaults.ts";

/** The eleven tables, in creation order. Indexes are created by the same
 * statements and are not listed separately. */
export const PROJECT_TABLE_NAMES = [
  "project_settings",
  "room_requests",
  "project_work_items",
  "project_board_columns",
  "project_briefs",
  "project_goals",
  "project_budgets",
  "usage_ledger",
  "project_summaries",
  "project_activity",
  "project_member_state",
] as const;
export type ProjectTableName = (typeof PROJECT_TABLE_NAMES)[number];

/** Tables whose rows belong to a group and are deleted with it.
 * `usage_ledger` keeps its rows (no content; D4 totals). */
const GROUP_SCOPED_TABLES = PROJECT_TABLE_NAMES.filter(name => name !== "usage_ledger");

/** Activity rows older than this are pruned (SPEC-P section 2). The
 * `room_requests` pruning and `usage_ledger` rollup belong to lanes E1 and B:
 * `pruneTerminalRoomRequests` and `rollupUsageLedger` below are their named
 * hooks and deliberately do nothing here. */
export const PROJECT_ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Lane E1 hook (SPEC-P section 2 pruning row): terminal `room_requests`
 * older than 30 days, except rows still referenced by a non-archived card or
 * by an open request. Not implemented in lane R. */
export function pruneTerminalRoomRequests(_db: DatabaseSync, _now: number): void {
  // Lane E1 implements the request pruning; the boot/daily caller is shared.
}

/** Lane B hook (SPEC-P section 2 pruning row): `usage_ledger` rows older than
 * 90 days roll up into deterministic per-day rows. Not implemented in lane R. */
export function rollupUsageLedger(db: DatabaseSync, now: number): void {
  rollupSettledUsage(db, now);
}

/** The daily/boot pruning pass for the tables lane R owns. */
export function pruneProjectRows(db: DatabaseSync, now: number): void {
  pruneProjectActivity(db, now);
  pruneTerminalRoomRequests(db, now);
  rollupUsageLedger(db, now);
}

export function pruneProjectActivity(db: DatabaseSync, now: number): void {
  if (!projectTableExists(db, "project_activity")) return;
  // An unfinished close resumes from its own rows; the markers before it no
  // longer decide anything, so they age out like every other row.
  db.prepare(`DELETE FROM project_activity WHERE at < ? AND NOT (kind='close'
    AND json_type(detail,'$.closeSeq')='integer'
    AND EXISTS (SELECT 1 FROM (${LIVE_PROJECT_CLOSES_SQL}) live
      WHERE live.group_id=project_activity.group_id AND live.close_seq=json_extract(project_activity.detail,'$.closeSeq')))`)
    .run(now - PROJECT_ACTIVITY_RETENTION_MS);
}

export function projectTableExists(db: DatabaseSync, name: ProjectTableName): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined;
}

/** node:sqlite reports change counts as number|bigint depending on build. */
const changedRows = (result: { changes: number | bigint }): number => Number(result.changes);

/** SPEC-P section 3, copied verbatim. The archive inspector compares
 * normalised CREATE text, so this text is the contract. */
const PROJECT_DDL = `
CREATE TABLE IF NOT EXISTS project_settings (
  group_id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL DEFAULT 'conversation' CHECK(mode IN ('conversation','ongoing')),
  lead_bot_id TEXT,                                   -- NULL = lead off (front bot answers)
  parts TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(parts)),
  parallel_cards INTEGER NOT NULL DEFAULT 3 CHECK(parallel_cards BETWEEN 1 AND 5),
  work_roots TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(work_roots)),
  work_profile TEXT NOT NULL DEFAULT 'ask' CHECK(work_profile IN ('ask','auto-in-roots')),
  migrated_from TEXT CHECK(migrated_from IS NULL OR migrated_from IN ('channelProject','bulletin','both')),
  owner_viewed_at INTEGER,                            -- "since you left" cursor (plan 3.9)
  run_state TEXT NOT NULL DEFAULT 'running' CHECK(run_state IN ('running','paused')),
  run_state_reason TEXT CHECK(run_state_reason IS NULL OR length(run_state_reason) <= 200),
  closed_at INTEGER,                                  -- Close (lane N); NULL = open
  ended_at INTEGER,                                   -- End project; NULL = the group is a project now
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS room_requests (
  id TEXT PRIMARY KEY NOT NULL,
  root_id TEXT NOT NULL,                              -- = id for a root request
  parent_id TEXT,                                     -- the request that caused this one
  card_generation INTEGER CHECK(card_generation IS NULL OR card_generation>=0),  -- the card generation this request may affect (5.1)
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt>=1),
  group_id TEXT NOT NULL,
  target_thread_id TEXT,                              -- NULL until resolved at dispatch for card runs
  project_goal_id TEXT,
  work_item_id TEXT,
  verb TEXT NOT NULL CHECK(verb IN ('owner_send','room_turn','ask','assign','message','review','wake','routine')),
  from_kind TEXT NOT NULL CHECK(from_kind IN ('owner','bot','murage','routine')),
  from_bot_id TEXT, to_bot_id TEXT,
  payload_text TEXT CHECK(payload_text IS NULL OR length(payload_text) <= 100000),
  reply_to_id TEXT, send_id TEXT,
  mode TEXT CHECK(mode IS NULL OR mode IN ('chat','goal')),
  origin TEXT NOT NULL CHECK(origin IN ('desktop','companion','unproven','server')),
  root_thread_id TEXT NOT NULL,
  audience_fingerprint TEXT NOT NULL,
  not_owner_audience INTEGER NOT NULL CHECK(not_owner_audience IN (0,1)),
  unattended INTEGER NOT NULL CHECK(unattended IN (0,1)),
  execution_audience TEXT CHECK(execution_audience IS NULL OR json_valid(execution_audience)),  -- lane X, section 17
  source_message_id TEXT,
  return_thread_id TEXT, return_bot_id TEXT,
  admission_key TEXT NOT NULL UNIQUE,
  priority TEXT NOT NULL DEFAULT 'work' CHECK(priority IN ('owner','coordinator','work')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_owner','waiting_bot','done','failed','cancelled','expired','unknown')),
  refusal TEXT,                                       -- last arbiter refusal reason code (section 7.2)
  created_at INTEGER NOT NULL, dispatched_at INTEGER, deadline_at INTEGER, finished_at INTEGER,
  owner_wait_ms INTEGER NOT NULL DEFAULT 0 CHECK(owner_wait_ms>=0),   -- time spent in waiting_owner (not work, 5.4)
  waiting_since INTEGER,                              -- set on entering waiting_owner, cleared on leaving
  result_message_id TEXT,
  outcome_note TEXT CHECK(outcome_note IS NULL OR length(outcome_note) <= 200));
CREATE INDEX IF NOT EXISTS room_requests_group_state ON room_requests(group_id, state);
CREATE INDEX IF NOT EXISTS room_requests_root ON room_requests(root_id);
CREATE INDEX IF NOT EXISTS room_requests_parent ON room_requests(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS room_requests_work_item ON room_requests(work_item_id) WHERE work_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS room_requests_to_bot ON room_requests(to_bot_id, state) WHERE to_bot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_work_items (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  goal_id TEXT,
  number INTEGER NOT NULL CHECK(number>=1),           -- "card 12": per-group sequence
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  assignee_bot_id TEXT,
  owner_took_over INTEGER NOT NULL DEFAULT 0 CHECK(owner_took_over IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('todo','doing','waiting','review','done','failed','cancelled')),
  column_id TEXT,                                     -- custom column; NULL = canonical column for state
  position REAL NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt>=1),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0),        -- consecutive, reset on done
  waiting_on TEXT CHECK(waiting_on IS NULL OR json_valid(waiting_on)),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 200),
  needs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(needs)),     -- capability tags for assign checks (3.10)
  touches TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(touches)),
  depends_on TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(depends_on)),
  writes INTEGER NOT NULL DEFAULT 1 CHECK(writes IN (0,1)),      -- may write: claims a work root (3.3 item 5)
  work_root_index INTEGER,                            -- which work root it writes; NULL = its desk folder
  request_id TEXT,
  review_request_id TEXT,
  desk_thread_id TEXT,
  result_message_id TEXT,
  source_message_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_message_ids)),
  stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),
  create_key TEXT UNIQUE,
  due_at INTEGER,
  created_by TEXT NOT NULL,                           -- 'owner' | 'server' | botId
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER, archived_at INTEGER);
CREATE INDEX IF NOT EXISTS project_work_items_group_state ON project_work_items(group_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS project_work_items_number ON project_work_items(group_id, number);

CREATE TABLE IF NOT EXISTS project_board_columns (
  group_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 40),
  state TEXT NOT NULL CHECK(state IN ('todo','doing','waiting','review','done')),
  position REAL NOT NULL,
  PRIMARY KEY(group_id, id));

CREATE TABLE IF NOT EXISTS project_briefs (
  group_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 200),
  done_means TEXT NOT NULL DEFAULT '' CHECK(length(done_means) <= 4000),
  rules TEXT NOT NULL DEFAULT '' CHECK(length(rules) <= 12000),   -- = the existing setup.bulletin cap (fact 17), so migration never truncates
  where_work_is TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(where_work_is)),
  decisions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(decisions)),
  updated_by TEXT NOT NULL,                           -- 'owner' | botId (the lead) | 'migration'
  change TEXT NOT NULL CHECK(change IN ('owner_edit','lead_decision','lead_note','restore_version','migration','member_proposal_accepted')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, version));

CREATE TABLE IF NOT EXISTS project_goals (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),  -- owner text; the migration keeps the full old goal here
  criteria TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(criteria)),
  state TEXT NOT NULL CHECK(state IN ('draft','planning','awaiting_plan_ok','working','awaiting_signoff','done','paused','stopped','failed')),
  state_reason TEXT CHECK(state_reason IS NULL OR length(state_reason) <= 200),
  plan_first INTEGER NOT NULL DEFAULT 0 CHECK(plan_first IN (0,1)),
  review INTEGER NOT NULL DEFAULT 1 CHECK(review IN (0,1)),
  replans INTEGER NOT NULL DEFAULT 0 CHECK(replans>=0),
  no_progress INTEGER NOT NULL DEFAULT 0 CHECK(no_progress>=0),
  lead_wakes INTEGER NOT NULL DEFAULT 0 CHECK(lead_wakes>=0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  summary_message_id TEXT,
  deadline_at INTEGER);
CREATE INDEX IF NOT EXISTS project_goals_group_state ON project_goals(group_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS project_goals_one_active ON project_goals(group_id)
  WHERE state IN ('planning','awaiting_plan_ok','working','awaiting_signoff','paused');

CREATE TABLE IF NOT EXISTS project_budgets (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  goal_id TEXT,                                       -- set iff period='goal'
  period TEXT NOT NULL CHECK(period IN ('goal','day','week','month')),
  tz TEXT NOT NULL,                                   -- IANA zone captured from the desktop at creation
  period_start INTEGER NOT NULL,
  max_work_minutes INTEGER NOT NULL CHECK(max_work_minutes BETWEEN 1 AND 100000),
  max_tokens INTEGER CHECK(max_tokens IS NULL OR max_tokens>=1),
  max_charge REAL,                                    -- stays NULL until a charge source exists (plan 3.6)
  warn_at REAL NOT NULL DEFAULT 0.8 CHECK(warn_at>0 AND warn_at<1),
  state TEXT NOT NULL DEFAULT 'ok' CHECK(state IN ('ok','warned','paused')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  raised_at INTEGER, raised_by TEXT CHECK(raised_by IS NULL OR raised_by IN ('owner')),
  created_at INTEGER NOT NULL,
  CHECK((period='goal') = (goal_id IS NOT NULL)));
CREATE INDEX IF NOT EXISTS project_budgets_group ON project_budgets(group_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS project_budgets_one_period ON project_budgets(group_id) WHERE period <> 'goal';
CREATE UNIQUE INDEX IF NOT EXISTS project_budgets_one_goal ON project_budgets(goal_id) WHERE goal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS usage_ledger (
  settle_key TEXT PRIMARY KEY NOT NULL,               -- 'turn:' || JSON [threadId, providerTurnId]; 'charge:<operation id>'; 'unknown:<requestId>'; 'rollup:...'
  turn_id TEXT,                                       -- the provider's turn id, informational (thread-local, fact 19)
  group_id TEXT, goal_id TEXT, work_item_id TEXT, request_id TEXT, root_id TEXT,
  attempt INTEGER,
  bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  engine TEXT NOT NULL, model TEXT,
  input INTEGER, output INTEGER, cached_input INTEGER,
  tokens_reported INTEGER NOT NULL CHECK(tokens_reported IN (0,1)),
  charge REAL, charge_kind TEXT NOT NULL CHECK(charge_kind IN ('charge','estimate','none')),
  work_ms INTEGER NOT NULL CHECK(work_ms>=0),
  ok INTEGER NOT NULL CHECK(ok IN (0,1)),
  audience TEXT CHECK(audience IS NULL OR json_valid(audience)),   -- lane X attribution (section 17)
  rolled_up INTEGER NOT NULL DEFAULT 0 CHECK(rolled_up IN (0,1)),
  at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS usage_ledger_group_at ON usage_ledger(group_id, at);
CREATE INDEX IF NOT EXISTS usage_ledger_goal ON usage_ledger(goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_ledger_root ON usage_ledger(root_id) WHERE root_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_summaries (
  group_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  text TEXT NOT NULL CHECK(length(text) <= 6000),
  source_message_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_message_ids)),
  made_by TEXT NOT NULL,                              -- botId | 'fallback'
  at INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),
  PRIMARY KEY(group_id, version));

CREATE TABLE IF NOT EXISTS project_activity (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('card_created','card_moved','card_reassigned','card_took_over','card_failed','card_result','brief_version','goal_state','criteria','decision_opened','decision_closed','budget_warned','budget_paused','budget_raised','member_error','routine_run','settings','work_roots','restore','close','reopen','deadline')),
  actor TEXT NOT NULL,                                -- 'owner' | 'server' | botId
  work_item_id TEXT, goal_id TEXT, request_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail) AND length(detail) <= 2000));
CREATE INDEX IF NOT EXISTS project_activity_group_at ON project_activity(group_id, at);

CREATE TABLE IF NOT EXISTS project_member_state (
  group_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  transcript_cursor TEXT,                             -- id of the last room message this member's prompt included
  joined_at INTEGER,                                  -- first project turn; the joining brief rides only while NULL
  last_card_summary TEXT CHECK(last_card_summary IS NULL OR length(last_card_summary) <= 2000),  -- card-boundary summary for the desk thread
  last_card_summary_sources TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(last_card_summary_sources)),
  stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, bot_id));
`;

/** Create every project table and index. Runs on every `database()` open
 * (CREATE ... IF NOT EXISTS), so a fresh install and an upgrade are the same
 * path. Never called on an archive under inspection or restore: a table that
 * is absent there belongs to an older release and is skipped, not created. */
export function initializeProjectTables(db: DatabaseSync): void {
  db.exec(PROJECT_DDL);
}

// ── 15.2 the shared row validator ───────────────────────────────────────────

export interface ProjectRowContext {
  /** The restored (or live) groups.json records: id plus whether the record
   * carries `channelProject`. */
  groups: Array<{ id: string; channelProject?: unknown }>;
  /** Bot ids of the install the rows belong to. */
  botIds: Set<string>;
  now: number;
  /** When false the database is opened read-only (validatePaused): a row
   * that would need a repair fails the check instead of being rewritten. */
  readOnly?: boolean;
  /** Boot checks shapes and references without imposing restore-only pause. */
  requirePaused?: boolean;
}

const LIVE_WAIT_KINDS = new Set(["owner_approval", "writer_root", "ask", "blocked"]);
const TERMINAL_REQUEST_STATES = new Set(["done", "failed", "cancelled", "expired", "unknown"]);
const PART_KEYS = new Set(["board", "review", "digest"]);

function failRows(table: string): never {
  throw new InstallationSnapshotError("RESTORE_WORK_NOT_PAUSED", { cause: new Error(`RESTORE_WORK_NOT_PAUSED: ${table}`) });
}

interface RepairLog { notes: string[]; writable: boolean }

function repair(log: RepairLog, table: string, action: string, write: () => void): void {
  if (!log.writable) failRows(table);
  write();
  log.notes.push(`${table}: ${action}`);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Authority JSON is strict; descriptive JSON is repaired to its empty
 * default with a note (15.2 "Shapes"). */
function checkDescriptive(db: DatabaseSync, log: RepairLog, table: string, column: string, empty: string, bound: (value: unknown) => boolean): void {
  for (const row of db.prepare(`SELECT rowid AS k, ${column} AS v FROM ${table}`).all() as Array<{ k: number; v: string }>) {
    const parsed = parseJson(row.v);
    if (parsed !== undefined && bound(parsed)) continue;
    repair(log, table, `${column} of row ${row.k} was unreadable and was reset`, () => {
      db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(empty, row.k);
    });
  }
}

const boundedStringArray = (maxItems: number, maxLength: number) => (value: unknown): boolean =>
  Array.isArray(value) && value.length <= maxItems && value.every(item => typeof item === "string" && item.length <= maxLength);

const evidenceShape = z.object({ kind: z.enum(["message", "file", "check"]), ref: z.string(), workItemId: z.string(), attempt: z.number().int().positive(), at: z.number() }).strict();
const criteriaShape = z.array(z.object({ id: z.string(), text: z.string().max(300), setBy: z.enum(["owner", "lead"]), proposed: z.boolean(), met: z.boolean(), metBy: z.string().optional(), evidence: evidenceShape.optional() }).strict()).max(10);
const briefEntryShape = z.object({ text: z.string().max(500), path: z.string().max(512).optional(), by: z.string(), at: z.number(), sourceMessageIds: z.array(z.string()).max(20).optional(), lineageSourceMessageIds: z.array(z.string()).max(50).optional(), stale: z.literal(true).optional() }).strict();
const decisionShape = z.object({ id: z.string(), text: z.string().max(500), by: z.string(), at: z.number(), sourceMessageIds: z.array(z.string()).max(20), lineageSourceMessageIds: z.array(z.string()).max(50).optional(), stale: z.literal(true).optional() }).strict();
const rootShape = z.array(z.object({ path: z.string(), dev: z.string(), ino: z.string(), label: z.string().max(60), addedAt: z.number() }).strict()).max(8);
const audienceShape = z.discriminatedUnion("kind", [
  z.object({ v: z.literal(1), kind: z.literal("project"), human: z.literal("owner"), projectId: z.string(), rootRequestId: z.string() }).strict(),
  z.object({ v: z.literal(1), kind: z.literal("team"), human: z.literal("owner"), team: z.string(), rootRequestId: z.string() }).strict(),
  z.object({ v: z.literal(1), kind: z.literal("home"), human: z.literal("owner"), rootRequestId: z.string() }).strict(),
]);
function validateProjectAuthority(db: DatabaseSync): void {
  if (projectTableExists(db, "project_settings")) {
    for (const row of db.prepare("SELECT parts, work_roots FROM project_settings").all()) {
      const parts = parseJson(String(row.parts));
      if (!z.object({ board: z.boolean().optional(), review: z.boolean().optional(), digest: z.boolean().optional() }).strict().safeParse(parts).success || !rootShape.safeParse(parseJson(String(row.work_roots))).success) failRows("project_settings");
    }
  }
  if (projectTableExists(db, "room_requests")) {
    for (const row of db.prepare("SELECT execution_audience FROM room_requests WHERE execution_audience IS NOT NULL").all()) {
      if (!audienceShape.safeParse(parseJson(String(row.execution_audience))).success) failRows("room_requests");
    }
  }
}

/** Validate project rows at the end of restore preparation (writable) and
 * again inside `validatePaused` (read-only). Returns the repair notes; a
 * Paused or authority-shape failure throws RESTORE_WORK_NOT_PAUSED naming the
 * table in the cause. Absent tables are skipped, never created. */
export function validateProjectRows(db: DatabaseSync, ctx: ProjectRowContext): string[] {
  const paused = ctx.requirePaused !== false;
  const log: RepairLog = { notes: [], writable: ctx.readOnly !== true };
  // Boot only: a malformed settings shape is reset before the strict authority
  // check, which would otherwise stop the app from starting (audit C-2).
  if (!paused && log.writable && projectTableExists(db, "project_settings")) {
    const partsShape = z.object({ board: z.boolean().optional(), review: z.boolean().optional(), digest: z.boolean().optional() }).strict();
    for (const row of db.prepare("SELECT group_id, parts, work_roots FROM project_settings").all() as Array<{ group_id: string; parts: unknown; work_roots: unknown }>) {
      if (!partsShape.safeParse(parseJson(String(row.parts))).success) {
        repair(log, "project_settings", `parts of ${row.group_id} were malformed and were reset`, () => {
          db.prepare("UPDATE project_settings SET parts=? WHERE group_id=?").run(JSON.stringify(DEFAULT_PROJECT_PARTS), row.group_id);
        });
      }
      if (!rootShape.safeParse(parseJson(String(row.work_roots))).success) {
        repair(log, "project_settings", `work roots of ${row.group_id} were malformed and were cleared`, () => {
          db.prepare("UPDATE project_settings SET work_roots='[]' WHERE group_id=?").run(row.group_id);
        });
      }
    }
  }
  validateProjectAuthority(db);
  const has = (name: ProjectTableName) => projectTableExists(db, name);
  const projectGroups = new Map(ctx.groups.map(group => [group.id, group.channelProject !== undefined && group.channelProject !== null]));

  if (has("room_requests")) {
    const open = db.prepare(`SELECT COUNT(*) AS n FROM room_requests WHERE state IN ('queued','running','waiting_owner','waiting_bot')`).get() as { n: number };
    if (paused && open.n > 0) failRows("room_requests");
  }

  if (has("project_goals")) {
    const active = db.prepare("SELECT COUNT(*) AS n FROM project_goals WHERE state IN ('planning','working')").get() as { n: number };
    if (paused && active.n > 0) failRows("project_goals");
  }

  if (has("project_work_items")) {
    for (const row of db.prepare("SELECT id, state, waiting_on, request_id FROM project_work_items").all() as Array<{ id: string; state: string; waiting_on: string | null; request_id: string | null }>) {
      if (paused && (row.state === "doing" || row.state === "review")) failRows("project_work_items");
      if (row.state === "waiting") {
        const waiting = parseJson(row.waiting_on) as { kind?: string } | undefined;
        if (paused && waiting && typeof waiting.kind === "string" && LIVE_WAIT_KINDS.has(waiting.kind) && (waiting.kind !== "blocked" || row.request_id !== null)) failRows("project_work_items");
      }
    }
  }

  if (has("project_settings")) {
    for (const row of db.prepare("SELECT group_id, run_state, work_profile, work_roots, lead_bot_id, ended_at, parts FROM project_settings").all() as Array<{ group_id: string; run_state: string; work_profile: string; work_roots: string; lead_bot_id: string | null; ended_at: number | null; parts: string }>) {
      if (paused && (row.run_state !== "paused" || row.work_profile !== "ask" || row.work_roots !== "[]")) failRows("project_settings");
      // Every open row belongs to a group of the install that is a project.
      // At boot the roster may be missing or lagging (audit C-1), so the rule is for restore only.
      if (row.ended_at === null && projectGroups.get(row.group_id) !== true && (paused || !log.writable)) failRows("project_settings");
      const parts = parseJson(row.parts) as Record<string, unknown> | undefined;
      if (!parts || typeof parts !== "object" || Array.isArray(parts)
        || Object.entries(parts).some(([key, value]) => !PART_KEYS.has(key) || typeof value !== "boolean")) failRows("project_settings");
      const roots = parseJson(row.work_roots);
      if (!Array.isArray(roots)) failRows("project_settings");
      if (row.lead_bot_id !== null && !ctx.botIds.has(row.lead_bot_id)) {
        repair(log, "project_settings", `lead of ${row.group_id} is not in this install and was cleared`, () => {
          db.prepare("UPDATE project_settings SET lead_bot_id=NULL WHERE group_id=?").run(row.group_id);
          if (has("project_goals")) {
            db.prepare("UPDATE project_goals SET state='paused', state_reason=? WHERE group_id=? AND state IN ('awaiting_plan_ok','awaiting_signoff','paused')").run("Pick a lead to resume", row.group_id);
          }
        });
      }
    }
  }

  if (has("room_requests")) {
    for (const row of db.prepare("SELECT id, from_bot_id, to_bot_id, return_bot_id, execution_audience FROM room_requests").all() as Array<{ id: string; from_bot_id: string | null; to_bot_id: string | null; return_bot_id: string | null; execution_audience: string | null }>) {
      for (const column of ["from_bot_id", "to_bot_id", "return_bot_id"] as const) {
        const value = row[column];
        if (value !== null && !ctx.botIds.has(value)) {
          repair(log, "room_requests", `bot ${value} on request ${row.id} is not in this install and was cleared`, () => {
            db.prepare(`UPDATE room_requests SET ${column}=NULL WHERE id=?`).run(row.id);
          });
        }
      }
      if (row.execution_audience !== null) {
        const tag = parseJson(row.execution_audience) as { v?: unknown; kind?: unknown } | undefined;
        if (!tag || tag.v !== 1 || !["project", "team", "home"].includes(String(tag.kind))) failRows("room_requests");
      }
    }
  }

  if (has("project_work_items")) {
    const requests = has("room_requests")
      ? new Map((db.prepare("SELECT id, state FROM room_requests").all() as Array<{ id: string; state: string }>).map(row => [row.id, row.state]))
      : new Map<string, string>();
    const goals = has("project_goals")
      ? new Map((db.prepare("SELECT id, group_id FROM project_goals").all() as Array<{ id: string; group_id: string }>).map(row => [row.id, row.group_id]))
      : new Map<string, string>();
    const columns = has("project_board_columns")
      ? new Map((db.prepare("SELECT group_id, id, state FROM project_board_columns").all() as Array<{ group_id: string; id: string; state: string }>).map(row => [JSON.stringify([row.group_id, row.id]), row.state]))
      : new Map<string, string>();
    const cards = db.prepare("SELECT id, group_id, goal_id, request_id, review_request_id, column_id, state, assignee_bot_id, work_root_index, depends_on, created_at FROM project_work_items").all() as Array<{ id: string; group_id: string; goal_id: string | null; request_id: string | null; review_request_id: string | null; column_id: string | null; state: string; assignee_bot_id: string | null; work_root_index: number | null; depends_on: string; created_at: number }>;
    const cardIds = new Map(cards.map(card => [`${card.group_id} ${card.id}`, card]));
    for (const card of cards) {
      for (const column of ["request_id", "review_request_id"] as const) {
        const reference = card[column];
        if (reference === null) continue;
        const state = requests.get(reference);
        if (state !== undefined && (!paused || TERMINAL_REQUEST_STATES.has(state))) continue;
        repair(log, "project_work_items", `card ${card.id} referenced a request that is open or gone; cleared`, () => {
          db.prepare(`UPDATE project_work_items SET ${column}=NULL WHERE id=?`).run(card.id);
        });
      }
      if (card.column_id !== null && columns.get(JSON.stringify([card.group_id, card.column_id])) !== card.state) {
        repair(log, "project_work_items", `card ${card.id} named a column that does not hold its state; cleared`, () => {
          db.prepare("UPDATE project_work_items SET column_id=NULL WHERE id=?").run(card.id);
        });
      }
      if (card.goal_id !== null && goals.get(card.goal_id) !== card.group_id) {
        repair(log, "project_work_items", `card ${card.id} named a goal outside its project; cleared`, () => {
          db.prepare("UPDATE project_work_items SET goal_id=NULL WHERE id=?").run(card.id);
        });
      }
      if (card.assignee_bot_id !== null && !ctx.botIds.has(card.assignee_bot_id)) {
        repair(log, "project_work_items", `assignee of card ${card.id} is not in this install and was cleared`, () => {
          db.prepare("UPDATE project_work_items SET assignee_bot_id=NULL WHERE id=?").run(card.id);
        });
      }
      if (paused && card.work_root_index !== null) {
        repair(log, "project_work_items", `card ${card.id} named a work root and restore clears the roots; cleared`, () => {
          db.prepare("UPDATE project_work_items SET work_root_index=NULL WHERE id=?").run(card.id);
        });
      }
    }
    // Cut dependency cycles (15.2): find a cycle, drop the edge pointing at
    // the cycle's latest card, repeat until acyclic. Edges between cards
    // created in one envelope transaction (same timestamp) survive unless
    // they truly close a cycle.
    {
      const dependsOf = new Map<string, string[]>();
      for (const card of cards) {
        const parsed = parseJson(card.depends_on);
        if (!Array.isArray(parsed)) continue; // repaired as descriptive JSON below
        dependsOf.set(
          `${card.group_id} ${card.id}`,
          parsed.filter((id): id is string => typeof id === "string" && cardIds.has(`${card.group_id} ${id}`)).map(id => `${card.group_id} ${id}`),
        );
      }
      const order = (key: string): [number, string] => {
        const card = cardIds.get(key)!;
        return [card.created_at, card.id];
      };
      for (;;) {
        // Depth-first search for one cycle; state 0 = unseen, 1 = open, 2 = done.
        const state = new Map<string, number>();
        let cycle: string[] | null = null;
        const walk = (key: string, stack: string[]): boolean => {
          state.set(key, 1);
          for (const next of dependsOf.get(key) ?? []) {
            const seen = state.get(next);
            if (seen === 1) { cycle = [...stack.slice(stack.indexOf(next)), next]; return true; }
            if (seen === undefined && walk(next, [...stack, next])) return true;
          }
          state.set(key, 2);
          return false;
        };
        for (const key of dependsOf.keys()) if (state.get(key) === undefined && walk(key, [key])) break;
        if (!cycle) break;
        const ring: string[] = cycle;
        // The edge pointing at the ring's latest card is the one dropped.
        let dropFrom = ring[ring.length - 2]!, dropTo = ring[ring.length - 1]!;
        for (let index = 0; index + 1 < ring.length; index++) {
          const from = ring[index]!, to = ring[index + 1]!;
          const [at, aid] = order(to), [bt, bid] = order(dropTo);
          if (at > bt || (at === bt && aid > bid)) { dropFrom = from; dropTo = to; }
        }
        const fromKey = dropFrom, toKey = dropTo;
        const toId = toKey.split(" ").pop()!;
        dependsOf.set(fromKey, (dependsOf.get(fromKey) ?? []).filter(id => id !== toKey));
        const fromCard = cardIds.get(fromKey)!;
        repair(log, "project_work_items", `card ${fromCard.id} depended on ${toId} in a cycle; the edge to the later card was cut`, () => {
          db.prepare("UPDATE project_work_items SET depends_on=? WHERE id=?").run(JSON.stringify((dependsOf.get(fromKey) ?? []).map(key => cardIds.get(key)!.id)), fromCard.id);
        });
      }
    }
    checkDescriptive(db, log, "project_work_items", "touches", "[]", boundedStringArray(10, 512));
    checkDescriptive(db, log, "project_work_items", "needs", "[]", boundedStringArray(8, 512));
    checkDescriptive(db, log, "project_work_items", "depends_on", "[]", boundedStringArray(10, 512));
    checkDescriptive(db, log, "project_work_items", "source_message_ids", "[]", boundedStringArray(50, 512));
  }

  if (has("project_goals")) {
    checkDescriptive(db, log, "project_goals", "criteria", "[]", value => criteriaShape.safeParse(value).success);
  }
  if (has("project_briefs")) {
    checkDescriptive(db, log, "project_briefs", "where_work_is", "[]", value => z.array(briefEntryShape).max(20).safeParse(value).success);
    checkDescriptive(db, log, "project_briefs", "decisions", "[]", value => z.array(decisionShape).max(50).safeParse(value).success);
  }
  if (has("project_summaries")) {
    checkDescriptive(db, log, "project_summaries", "source_message_ids", "[]", boundedStringArray(500, 512));
  }
  if (has("project_member_state")) {
    checkDescriptive(db, log, "project_member_state", "last_card_summary_sources", "[]", boundedStringArray(500, 512));
  }
  if (has("project_budgets")) {
    const goals = new Map((has("project_goals") ? db.prepare("SELECT id, group_id FROM project_goals").all() as Array<{ id: string; group_id: string }> : []).map(row => [row.id, row.group_id]));
    for (const row of db.prepare("SELECT id, group_id, goal_id FROM project_budgets WHERE goal_id IS NOT NULL").all() as Array<{ id: string; group_id: string; goal_id: string }>) {
      // A goal budget cannot lose its goal or become a period budget without
      // changing its restriction. Refuse instead of violating the frozen DDL.
      if (goals.get(row.goal_id) !== row.group_id) failRows("project_budgets");
    }
  }
  if (has("room_requests")) {
    const goals = new Map((has("project_goals") ? db.prepare("SELECT id, group_id FROM project_goals").all() as Array<{ id: string; group_id: string }> : []).map(row => [row.id, row.group_id]));
    for (const row of db.prepare("SELECT id, group_id, project_goal_id FROM room_requests WHERE project_goal_id IS NOT NULL").all() as Array<{ id: string; group_id: string; project_goal_id: string }>) {
      if (goals.get(row.project_goal_id) === row.group_id) continue;
      repair(log, "room_requests", `request ${row.id} named a goal outside its project; cleared`, () => {
        db.prepare("UPDATE room_requests SET project_goal_id=NULL WHERE id=?").run(row.id);
      });
    }
  }
  return log.notes;
}

// ── 15.1 restore preparation ────────────────────────────────────────────────

const RESTORE_PAUSE_REASON = "Restored from a backup: paused. Resume?";

/** Applied inside the existing messages.db restore transaction
 * (installation-restore-preparation.ts): every project row is rewritten to
 * its paused, authority-free restore shape, one `modifications` entry per
 * rewrite. Absent tables (an older archive) are skipped, never created. */
export function prepareProjectTablesForRestore(db: DatabaseSync, ctx: ProjectRowContext): Array<{ component: string; action: string }> {
  validateProjectAuthority(db);
  const modifications: Array<{ component: string; action: string }> = [];
  const has = (name: ProjectTableName) => projectTableExists(db, name);
  if (has("room_requests")) {
    const changed = changedRows(db.prepare(`UPDATE room_requests SET state='expired', outcome_note='restored', finished_at=?, waiting_since=NULL
      WHERE state IN ('queued','running','waiting_owner','waiting_bot')`).run(ctx.now));
    if (changed > 0) modifications.push({ component: "messages.db", action: `${changed} waiting room request(s) expired: this was waiting when the backup was made; ask again` });
  }
  if (has("project_work_items")) {
    const live = changedRows(db.prepare(`UPDATE project_work_items SET state='waiting', waiting_on=?, reason='Interrupted by a restore', request_id=NULL, review_request_id=NULL, column_id=NULL, revision=revision+1, updated_at=?
      WHERE state IN ('doing','review') OR (state='waiting' AND (json_extract(waiting_on,'$.kind') IN ('owner_approval','writer_root','ask') OR (json_extract(waiting_on,'$.kind')='blocked' AND request_id IS NOT NULL)))`)
      .run(JSON.stringify({ kind: "restore" }), ctx.now));
    if (live > 0) modifications.push({ component: "messages.db", action: `${live} card(s) interrupted by the restore moved to Waiting` });
    if (has("room_requests")) {
      // References to requests that are now expired or gone are cleared, so no
      // card points at a request that cannot continue (15.1).
      const dangling = changedRows(db.prepare(`UPDATE project_work_items SET request_id=NULL WHERE request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM room_requests WHERE room_requests.id=project_work_items.request_id AND room_requests.state IN ('done','failed','cancelled','unknown'))`).run());
      const danglingReview = changedRows(db.prepare(`UPDATE project_work_items SET review_request_id=NULL WHERE review_request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM room_requests WHERE room_requests.id=project_work_items.review_request_id AND room_requests.state IN ('done','failed','cancelled','unknown'))`).run());
      if (dangling + danglingReview > 0) modifications.push({ component: "messages.db", action: "Card references to requests that cannot continue were cleared" });
    }
  }
  if (has("project_goals")) {
    const changed = changedRows(db.prepare("UPDATE project_goals SET state='paused', state_reason=?, revision=revision+1 WHERE state IN ('planning','working')").run(RESTORE_PAUSE_REASON));
    if (changed > 0) modifications.push({ component: "messages.db", action: `${changed} running goal(s) paused: ${RESTORE_PAUSE_REASON}` });
  }
  if (has("project_settings")) {
    const changed = changedRows(db.prepare("UPDATE project_settings SET run_state='paused', run_state_reason=?, work_profile='ask', work_roots='[]', revision=revision+1, updated_at=?").run(RESTORE_PAUSE_REASON, ctx.now));
    if (changed > 0) modifications.push(
      { component: "messages.db", action: "Every project paused." },
      { component: "messages.db", action: "Project work settings were reset to Ask." },
      { component: "messages.db", action: "Pick the project's work folders again." },
    );
    if (has("project_work_items") && changedRows(db.prepare("UPDATE project_work_items SET work_root_index=NULL WHERE work_root_index IS NOT NULL").run()) > 0) modifications.push({ component: "messages.db", action: "Card work folder references cleared" });
    const activity = (has("project_activity") ? db.prepare("SELECT group_id FROM project_settings").all() : []) as Array<{ group_id: string }>;
    const insert = has("project_activity") ? db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, detail) VALUES (?,?,?,'restore','server','{}')") : null;
    for (const row of activity) insert!.run(randomUUID(), row.group_id, ctx.now);
    if (activity.length > 0) modifications.push({ component: "messages.db", action: "A restore note was added to each project's activity" });
  }
  // project_briefs, project_summaries, project_board_columns,
  // project_activity and project_member_state are kept as they are;
  // project_budgets and usage_ledger are kept (they restrict, never widen).
  for (const note of validateProjectRows(db, ctx)) {
    modifications.push({ component: "messages.db", action: note });
  }
  return modifications;
}

/** The read-only half, called from `validatePaused`
 * (installation-activation.ts): any project row that is not in its paused
 * restore shape fails the restore with RESTORE_WORK_NOT_PAUSED naming the
 * table. */
export function assertProjectTablesPaused(db: DatabaseSync, ctx: ProjectRowContext): void {
  validateProjectRows(db, { ...ctx, readOnly: true });
}

// ── group deletion, pruning, forget purge ───────────────────────────────────

/** The group is gone from groups.json: every project table loses the group's
 * rows except `usage_ledger` (no content; D4 totals). Open requests are
 * cancelled first (SPEC-P section 2; lane E1 will route the cancellation
 * through completeRequest once it owns dispatch). Runs inside the caller's
 * transaction. */
export function deleteProjectRows(db: DatabaseSync, groupId: string, now: number): void {
  if (projectTableExists(db, "room_requests")) {
    db.prepare("UPDATE room_requests SET state='cancelled', finished_at=?, waiting_since=NULL WHERE group_id=? AND state IN ('queued','running','waiting_owner','waiting_bot')").run(now, groupId);
  }
  for (const table of GROUP_SCOPED_TABLES) {
    if (!projectTableExists(db, table)) continue;
    if (table === "room_requests") db.prepare("DELETE FROM room_requests WHERE group_id=?").run(groupId);
    else db.prepare(`DELETE FROM ${table} WHERE group_id=?`).run(groupId);
  }
}

/** SPEC-P 15.3: model-written derived text that cites a forgotten or withheld
 * message is marked stale, which drops it from prompt material (13.2) until
 * it is rewritten. A lead card made on a goal Start or Change wake cites no
 * message, yet the lead read the room's messages: when `placed` says a
 * forgotten message was in a project's room, every card of that project with
 * no sources that the owner did not make, created after the message, is
 * marked too (a conservative superset). Returns the number of rows and
 * entries marked. */
export function markProjectDerivedStale(db: DatabaseSync, messageIds: string[], placed?: (messageId: string) => { groupId: string; at: number } | undefined): number {
  if (messageIds.length === 0) return 0;
  const forgotten = new Set(messageIds);
  const cites = (json: string | null): boolean => {
    const ids = parseJson(json);
    return Array.isArray(ids) && ids.some(id => typeof id === "string" && forgotten.has(id));
  };
  let marked = 0;
  if (projectTableExists(db, "project_work_items")) {
    for (const row of db.prepare("SELECT id, source_message_ids FROM project_work_items WHERE stale=0").all() as Array<{ id: string; source_message_ids: string }>) {
      if (!cites(row.source_message_ids)) continue;
      db.prepare("UPDATE project_work_items SET stale=1 WHERE id=?").run(row.id);
      marked += 1;
    }
    // the earliest forgotten message of each project decides its superset
    const earliest = new Map<string, number>();
    for (const id of forgotten) {
      const place = placed?.(id);
      if (place && !(Number(earliest.get(place.groupId)) <= place.at)) earliest.set(place.groupId, place.at);
    }
    for (const [groupId, at] of earliest) {
      marked += Number(db.prepare(`UPDATE project_work_items SET stale=1 WHERE group_id=? AND stale=0 AND created_at>=?
        AND created_by NOT IN ('owner','server') AND (source_message_ids IS NULL OR source_message_ids IN ('','[]'))`).run(groupId, at).changes);
    }
  }
  if (projectTableExists(db, "project_summaries")) {
    for (const row of db.prepare("SELECT group_id, version, source_message_ids FROM project_summaries WHERE stale=0").all() as Array<{ group_id: string; version: number; source_message_ids: string }>) {
      if (!cites(row.source_message_ids)) continue;
      db.prepare("UPDATE project_summaries SET stale=1 WHERE group_id=? AND version=?").run(row.group_id, row.version);
      marked += 1;
    }
  }
  if (projectTableExists(db, "project_member_state")) {
    for (const row of db.prepare("SELECT group_id, bot_id, last_card_summary_sources FROM project_member_state WHERE stale=0 AND last_card_summary IS NOT NULL").all() as Array<{ group_id: string; bot_id: string; last_card_summary_sources: string }>) {
      if (!cites(row.last_card_summary_sources)) continue;
      db.prepare("UPDATE project_member_state SET stale=1 WHERE group_id=? AND bot_id=?").run(row.group_id, row.bot_id);
      marked += 1;
    }
  }
  if (projectTableExists(db, "project_briefs")) {
    for (const row of db.prepare("SELECT group_id, version, where_work_is, decisions FROM project_briefs").all() as Array<{ group_id: string; version: number; where_work_is: string; decisions: string }>) {
      let dirty = false;
      const markEntries = (json: string): string => {
        const entries = parseJson(json);
        if (!Array.isArray(entries)) return json;
        for (const entry of entries) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const cited = entry as { sourceMessageIds?: unknown; lineageSourceMessageIds?: unknown };
            const sources = [cited.sourceMessageIds, cited.lineageSourceMessageIds].flatMap(ids => Array.isArray(ids) ? ids : []);
            if (sources.some(id => typeof id === "string" && forgotten.has(id)) && (entry as { stale?: unknown }).stale !== true) {
              (entry as { stale: boolean }).stale = true;
              dirty = true;
              marked += 1;
            }
          }
        }
        return dirty ? JSON.stringify(entries) : json;
      };
      const whereWorkIs = markEntries(row.where_work_is);
      const decisions = markEntries(row.decisions);
      if (dirty) db.prepare("UPDATE project_briefs SET where_work_is=?, decisions=? WHERE group_id=? AND version=?").run(whereWorkIs, decisions, row.group_id, row.version);
    }
  }
  return marked;
}

/** Deterministic rollup key namespace for lane B (SPEC-P section 2). */
export function usageRollupKey(groupId: string, day: string, dimensions: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(dimensions)).digest("hex").slice(0, 16);
  return `rollup:${groupId}:${day}:${hash}`;
}
