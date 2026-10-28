// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls (design BOT-CALLS-109 rev 4.2), phase 1: the messages.db tables (5.1), the one way a rule is written
// (insertCallRule, putCallRules), the restore fence and the owner's re-arm (5.9), the per-bot and owner settings,
// retention, and the step back to 1.0.8. No imports of server state: the snapshot inspector builds its reference
// schema from initializeBotCalls.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { txScopeBegin, txScopeEnd } from "./tx-scope.ts";

/** The newest restore's token, or null: exactly currentRestoreGeneration (send-store.ts), read here so this module stays a
 * leaf. restore-fence.ts imports it, and send-store.ts imports restore-fence.ts (a cycle otherwise). The test holds the two equal. */
export function newestRestoreGeneration(db: DatabaseSync): string | null {
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='send_restore_generation'").get()) return null;
  const row = db.prepare("SELECT token FROM send_restore_generation WHERE id=1").get() as { token: string } | undefined;
  return row?.token ?? null;
}

export const CALL_RULE_KINDS = ["timed", "watch", "webhook", "sender", "turn_end", "routine_problem", "needs_owner_now"] as const;
export type CallRuleKind = typeof CALL_RULE_KINDS[number];
export const TIER_A_KINDS: readonly CallRuleKind[] = ["timed", "watch", "webhook", "sender", "turn_end"];
export type CallTier = "A" | "B";
export const CALL_WAIT_MINUTES = [10, 15, 30, 60] as const;
export const CALL_LABEL_MAX = 60;
/** Retention (5.1): done intents are kept 90 days, sessions 1 day after they end. */
export const CALL_INTENT_RETENTION_MS = 90 * 24 * 3600_000;
export const CALL_SESSION_RETENTION_MS = 24 * 3600_000;

/** The tier is derived from the kind, never taken from input (4.6). */
export function tierOfKind(kind: CallRuleKind): CallTier {
  return TIER_A_KINDS.includes(kind) ? "A" : "B";
}
const isKind = (value: unknown): value is CallRuleKind => typeof value === "string" && (CALL_RULE_KINDS as readonly string[]).includes(value);

/** A rule write the route answers with 400 (closed lists, Emergency on a Tier B kind). */
export class CallRuleInputError extends Error {
  readonly status = 400;
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "CallRuleInputError"; this.code = code; }
}
const refuse = (code: string, message: string): never => { throw new CallRuleInputError(code, message); };

// ── tables (5.1, verbatim; the SQL comments of the design are kept here instead) ──

/** tier: derived, never written. emergency: the owner switch, Tier A kinds only (4.6); the CHECK binds to kind.
 * restore_held / restore_gen: the restore that held the rule (5.9). */
const RULES_DDL = `CREATE TABLE IF NOT EXISTS bot_call_rules (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('timed','watch','webhook','sender','turn_end','routine_problem','needs_owner_now')),
  tier TEXT GENERATED ALWAYS AS (CASE WHEN kind IN ('timed','watch','webhook','sender','turn_end') THEN 'A' ELSE 'B' END) VIRTUAL,
  params TEXT NOT NULL, label TEXT,
  how TEXT NOT NULL CHECK (how IN ('ring','text_first')), wait_min INTEGER CHECK (wait_min IN (10,15,30,60)),
  enabled INTEGER NOT NULL DEFAULT 1, demoted INTEGER NOT NULL DEFAULT 0,
  emergency INTEGER NOT NULL DEFAULT 0 CHECK (emergency = 0 OR kind IN ('timed','watch','webhook','sender','turn_end')),
  restore_held INTEGER NOT NULL DEFAULT 0, restore_gen TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bot_call_rules_bot ON bot_call_rules(bot_id, enabled, kind);`;

const CALLS_DDL = `CREATE TABLE IF NOT EXISTS bot_calls (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, rule_id TEXT NOT NULL, tier TEXT NOT NULL,
  thread_id TEXT NOT NULL, fact_kind TEXT NOT NULL, fact_key TEXT NOT NULL, fact_at INTEGER NOT NULL,
  fact_fields TEXT NOT NULL, line TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','waiting','ringing','live','done')),
  gen INTEGER NOT NULL DEFAULT 0,
  active_slot INTEGER CHECK (active_slot IS NULL OR active_slot = 1),
  deadline_at INTEGER, rang_at INTEGER, answered_on TEXT, session_id TEXT, seen_at INTEGER,
  created_at INTEGER NOT NULL, ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('answered','declined','text_instead','missed','texted','seen','dropped','cancelled','late','restored')),
  receipt TEXT NOT NULL DEFAULT '{}');
CREATE UNIQUE INDEX IF NOT EXISTS bot_calls_fact ON bot_calls(bot_id, fact_key);
CREATE UNIQUE INDEX IF NOT EXISTS bot_calls_one_active ON bot_calls(active_slot);
CREATE INDEX IF NOT EXISTS bot_calls_open ON bot_calls(state, deadline_at) WHERE state <> 'done';
CREATE INDEX IF NOT EXISTS bot_calls_rule_created ON bot_calls(rule_id, created_at);
CREATE INDEX IF NOT EXISTS bot_calls_rule_rang ON bot_calls(rule_id, rang_at) WHERE rang_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_calls_bot_rang ON bot_calls(bot_id, rang_at) WHERE rang_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_calls_rang ON bot_calls(rang_at) WHERE rang_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_calls_history ON bot_calls(created_at);`;

/** Every call, bot-initiated or not. last_seen_at is set by the SERVER from traffic it receives (5.7); backstop_at is
 * opened_at + 4 h, last resort only. thread_id (added in phase 2, not in the design's DDL): the thread the call runs on,
 * which GET /api/calls/active returns for an ordinary call too (an intent's call also has it on bot_calls). */
const SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS bot_call_sessions (
  id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL, intent_id TEXT, thread_id TEXT,
  device TEXT NOT NULL, opened_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  backstop_at INTEGER NOT NULL,
  ended_at INTEGER, ended_by TEXT CHECK (ended_by IN ('closed','lost','stopped','backstop','restore')));
CREATE INDEX IF NOT EXISTS bot_call_sessions_live ON bot_call_sessions(last_seen_at) WHERE ended_at IS NULL;`;

const OWED_DDL = `CREATE TABLE IF NOT EXISTS bot_call_owed (
  fact_key TEXT PRIMARY KEY, bot_id TEXT NOT NULL, kind TEXT NOT NULL, thread_id TEXT NOT NULL,
  source_id TEXT, at INTEGER, armed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS bot_call_owed_at ON bot_call_owed(at);
CREATE TABLE IF NOT EXISTS bot_call_watch_threads (thread_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL);`;

/** The channel fact's owed row, written in the message's own transaction (4.1). It reads no JSON, so a damaged row still writes. */
const OWED_TRIGGER_DDL = `CREATE TRIGGER IF NOT EXISTS bot_call_owed_msg AFTER INSERT ON messages
  WHEN NEW.thread_id IN (SELECT thread_id FROM bot_call_watch_threads)
BEGIN
  INSERT OR IGNORE INTO bot_call_owed (fact_key, bot_id, kind, thread_id, source_id, at, armed)
    SELECT 'channel:' || NEW.thread_id || ':' || NEW.id, w.bot_id, 'channel', NEW.thread_id, NEW.id, NEW.at, 0
    FROM bot_call_watch_threads w WHERE w.thread_id = NEW.thread_id;
END`;

/** The bot switch, "Calls off for today" and the last re-armed restore generation (HANDOFF-BUILD storage decisions). */
const SETTINGS_DDL = "CREATE TABLE IF NOT EXISTS bot_call_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

export const BOT_CALLS_109_TABLES = ["bot_call_rules", "bot_calls", "bot_call_sessions", "bot_call_owed", "bot_call_watch_threads", "bot_call_settings"] as const;
export const BOT_CALLS_109_TRIGGERS = ["bot_call_owed_msg"] as const;
export const BOT_CALLS_109_INDEXES = ["bot_call_rules_bot", "bot_calls_fact", "bot_calls_one_active", "bot_calls_open", "bot_calls_rule_created", "bot_calls_rule_rang",
  "bot_calls_bot_rang", "bot_calls_rang", "bot_calls_history", "bot_call_sessions_live", "bot_call_owed_at"] as const;
/** Every schema object 1.0.9 adds for calls, for the downgrade checks (sqlite_autoindex_* objects carry no SQL). */
export const BOT_CALLS_109_OBJECTS: readonly string[] = Object.freeze([...BOT_CALLS_109_TABLES, ...BOT_CALLS_109_TRIGGERS, ...BOT_CALLS_109_INDEXES]);

/** Creates the call tables, indexes and the owed trigger on messages (the messages table must exist). Idempotent. */
export function initializeBotCalls(db: DatabaseSync): void {
  db.exec(RULES_DDL);
  db.exec(CALLS_DDL);
  db.exec(SESSIONS_DDL);
  db.exec(OWED_DDL);
  db.exec(SETTINGS_DDL);
  db.exec(OWED_TRIGGER_DDL);
}

const hasTable = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Synchronous work in one transaction; a savepoint when the caller already holds one. Every call transition uses it.
 * It opens a tx-scope frame like database.ts `transaction`: a card the transition writes through the store (CallEffects.card,
 * store.appendMessage/patchMessage, synchronous on this same messages.db connection) announces its SSE change only after the
 * outermost commit, and a rollback drops the store's cached thread, so a card never outlives the transition that owed it. */
export function inTransaction<T>(db: DatabaseSync, operation: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT bot_calls" : "BEGIN IMMEDIATE");
  txScopeBegin();
  try {
    const result = operation();
    db.exec(nested ? "RELEASE bot_calls" : "COMMIT");
    txScopeEnd(true);
    return result;
  } catch (error) {
    try { db.exec(nested ? "ROLLBACK TO bot_calls; RELEASE bot_calls" : "ROLLBACK"); } catch { /* already rolled back */ }
    txScopeEnd(false);
    throw error;
  }
}

// ── settings ────────────────────────────────────────────────────────────────

const getSetting = (db: DatabaseSync, key: string): string | null =>
  (db.prepare("SELECT value FROM bot_call_settings WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
const setSetting = (db: DatabaseSync, key: string, value: string | null): void => {
  if (value === null) db.prepare("DELETE FROM bot_call_settings WHERE key=?").run(key);
  else db.prepare("INSERT INTO bot_call_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
};
/** 4.1 recovery window for the boot re-scan of saved runs: back to the start of the previous process (so a crash after
 * a long run is still covered), never less than 24 h and never more than 30 days (inside CALL_INTENT_RETENTION_MS, so
 * the unique fact key still dedups everything in the window). `markFactReplay` records this boot once the scan is done. */
export const FACT_REPLAY_MAX_MS = 30 * 24 * 3600_000;
export function factReplayFrom(db: DatabaseSync, now: number): number {
  const prev = Number(getSetting(db, "fact_scan_from"));
  const floor = now - 24 * 3600_000;
  return Math.max(now - FACT_REPLAY_MAX_MS, Number.isFinite(prev) && prev > 0 ? Math.min(floor, prev) : floor);
}
export function markFactReplay(db: DatabaseSync, bootAt: number): void { setSetting(db, "fact_scan_from", String(Math.trunc(bootAt))); }
const enabledKey = (botId: string) => `enabled:${botId}`;

/** "Scout can call me": off unless the owner turned it on. */
export function botCallsEnabled(db: DatabaseSync, botId: string): boolean { return getSetting(db, enabledKey(botId)) === "1"; }
export function setBotCallsEnabled(db: DatabaseSync, botId: string, enabled: boolean): void { setSetting(db, enabledKey(botId), enabled ? "1" : null); }
/** "Calls off for today": the stored end (epoch ms), or null when not set. */
export function callsOffUntil(db: DatabaseSync): number | null {
  const value = Number(getSetting(db, "off_until"));
  return Number.isFinite(value) && value > 0 ? value : null;
}
export function callsOffActive(db: DatabaseSync, now: number): boolean { const until = callsOffUntil(db); return until !== null && now < until; }
export function setCallsOffUntil(db: DatabaseSync, until: number | null): void {
  setSetting(db, "off_until", until === null || !Number.isFinite(until) ? null : String(Math.trunc(until)));
}
/** A deleted bot leaves no call setting behind. */
export function deleteBotCallSettings(db: DatabaseSync, botId: string): void { setSetting(db, enabledKey(botId), null); }
/** The restore generation the owner last re-armed calls under. */
export function rearmedGeneration(db: DatabaseSync): string | null { return getSetting(db, "rearmed_gen"); }

// ── rules ───────────────────────────────────────────────────────────────────

export interface CallRuleInput {
  id?: unknown; kind: unknown; params: unknown; label?: unknown; how: unknown; waitMin?: unknown; enabled?: unknown; emergency?: unknown;
}
export interface CallRuleRow {
  id: string; botId: string; position: number; kind: CallRuleKind; tier: CallTier; params: Record<string, unknown>; label: string | null;
  how: "ring" | "text_first"; waitMin: number | null; enabled: boolean; demoted: boolean; emergency: boolean;
  restoreHeld: boolean; restoreGen: string | null; createdAt: number; updatedAt: number;
}
interface ValidRule { kind: CallRuleKind; params: string; label: string | null; how: "ring" | "text_first"; waitMin: number | null; enabled: boolean; emergency: boolean }

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isRef = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
/** The params each kind carries: a closed set of keys (required, optional). */
const PARAM_KEYS: Readonly<Record<CallRuleKind, { required: readonly string[]; optional: readonly string[] }>> = {
  timed: { required: ["routineId"], optional: [] },
  watch: { required: ["watchId"], optional: [] },
  webhook: { required: ["routineId", "eventType"], optional: [] },
  sender: { required: ["threadId", "senderIds"], optional: [] },
  turn_end: { required: ["threadId"], optional: ["turnId"] },
  routine_problem: { required: [], optional: ["routineId"] },
  needs_owner_now: { required: [], optional: [] },
};
const SENDERS_MAX = 50;

function validParams(kind: CallRuleKind, params: unknown): string {
  if (params === null || typeof params !== "object" || Array.isArray(params)) refuse("bad_params", "params must be an object");
  const object = params as Record<string, unknown>;
  const { required, optional } = PARAM_KEYS[kind];
  for (const key of Object.keys(object)) if (!required.includes(key) && !optional.includes(key)) refuse("bad_params", `params.${key} is not used by ${kind}`);
  const out: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    const value = object[key];
    if (value === undefined) { if (required.includes(key)) refuse("bad_params", `params.${key} is required for ${kind}`); continue; }
    if (key === "senderIds") {
      if (!Array.isArray(value) || value.length === 0 || value.length > SENDERS_MAX || !value.every(isRef) || new Set(value).size !== value.length) refuse("bad_params", "params.senderIds must list 1 to 50 distinct ids");
      out[key] = [...value as string[]];
    } else {
      if (!isRef(value)) refuse("bad_params", `params.${key} must be a non-empty string`);
      out[key] = value;
    }
  }
  return JSON.stringify(out);
}

/** The closed lists (4.6, 5.1, design 3). Tier, restore_held and restore_gen are never read from input. */
export function validateCallRule(input: CallRuleInput): ValidRule {
  if (!input || typeof input !== "object") refuse("bad_rule", "a rule must be an object");
  if (!isKind(input.kind)) refuse("bad_kind", "unknown rule kind");
  const kind = input.kind as CallRuleKind;
  const tier = tierOfKind(kind);
  if (input.how !== "ring" && input.how !== "text_first") refuse("bad_how", "how must be ring or text_first");
  const how = input.how as "ring" | "text_first";
  if (tier === "B" && how !== "text_first") refuse("bad_how", "a Tier B rule always messages first");
  let waitMin: number | null = null;
  if (how === "text_first") {
    if (!(CALL_WAIT_MINUTES as readonly unknown[]).includes(input.waitMin)) refuse("bad_wait", "waitMin must be 10, 15, 30 or 60");
    waitMin = input.waitMin as number;
  } else if (input.waitMin !== undefined && input.waitMin !== null) refuse("bad_wait", "waitMin applies only to text_first");
  let label: string | null = null;
  if (input.label !== undefined && input.label !== null) {
    if (typeof input.label !== "string" || [...input.label].length > CALL_LABEL_MAX) refuse("bad_label", "a label is text of 60 characters or fewer");
    label = (input.label as string).trim() || null;
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") refuse("bad_rule", "enabled must be a boolean");
  if (input.emergency !== undefined && typeof input.emergency !== "boolean") refuse("bad_rule", "emergency must be a boolean");
  const emergency = input.emergency === true;
  if (emergency && tier === "B") refuse("emergency_tier_b", "Emergency is for Tier A rules only");
  return { kind, params: validParams(kind, input.params), label, how, waitMin, enabled: input.enabled !== false, emergency };
}

/** Whether a rule written now must be born held (5.9): any rule is held, or a restore newer than the last re-arm exists.
 * Returns the newest restore generation to hold it under, or null. */
function birthHold(db: DatabaseSync): string | null {
  const current = newestRestoreGeneration(db);
  if (current === null) {
    // a hold always carries a generation; a held rule without a current one keeps its own
    const held = db.prepare("SELECT restore_gen FROM bot_call_rules WHERE restore_held=1 LIMIT 1").get() as { restore_gen: string | null } | undefined;
    return held ? (held.restore_gen ?? "") : null;
  }
  if (db.prepare("SELECT 1 AS x FROM bot_call_rules WHERE restore_held=1 LIMIT 1").get()) return current;
  return rearmedGeneration(db) === current ? null : current;
}

/** THE only way a row enters bot_call_rules (PUT, a confirmed call card, "Call me when this finishes"). Born held while
 * the restore fence is up. Returns the new rule id. */
export function insertCallRule(db: DatabaseSync, input: CallRuleInput & { botId: string; position?: number }, now: number): string {
  const rule = validateCallRule(input);
  if (typeof input.botId !== "string" || !input.botId) refuse("bad_bot", "a rule belongs to a bot");
  return inTransaction(db, () => {
    let id: string;
    if (input.id === undefined || input.id === null) id = randomUUID();
    else if (typeof input.id === "string" && ID.test(input.id)) id = input.id;
    else return refuse("bad_id", "a rule id is 1 to 64 letters, digits, - or _");
    if (db.prepare("SELECT 1 AS x FROM bot_call_rules WHERE id=?").get(id)) refuse("bad_id", "that rule id is taken");
    const position = Number.isInteger(input.position) ? input.position as number
      : Number((db.prepare("SELECT COALESCE(MAX(position)+1, 0) AS p FROM bot_call_rules WHERE bot_id=?").get(input.botId) as { p: number }).p);
    const hold = birthHold(db);
    db.prepare(`INSERT INTO bot_call_rules (id, bot_id, position, kind, params, label, how, wait_min, enabled, demoted, emergency, restore_held, restore_gen, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`).run(id, input.botId, position, rule.kind, rule.params, rule.label, rule.how, rule.waitMin,
      rule.enabled ? 1 : 0, rule.emergency ? 1 : 0, hold === null ? 0 : 1, hold, now, now);
    if (rule.kind === "sender") rebuildWatchThreads(db);
    return id;
  });
}

/** bot_call_watch_threads from every enabled sender rule, rewritten in the rule write's transaction (4.1). One bot per
 * thread: the first enabled rule by bot, position wins (the drain matches every bot's rules for the thread). */
export function rebuildWatchThreads(db: DatabaseSync): void {
  db.exec("DELETE FROM bot_call_watch_threads");
  db.prepare(`INSERT OR IGNORE INTO bot_call_watch_threads (thread_id, bot_id)
    SELECT json_extract(params, '$.threadId'), bot_id FROM bot_call_rules
    WHERE kind='sender' AND enabled=1 AND json_valid(params) AND json_type(params, '$.threadId')='text'
    ORDER BY bot_id, position, id`).run();
}

/** PUT /api/bots/:id/calls/rules: an upsert by id in ONE transaction; a rule left out is deleted. The hold columns of an
 * existing row are never written; a new row goes through insertCallRule. Everything is validated before anything is written. */
export function putCallRules(db: DatabaseSync, botId: string, list: readonly CallRuleInput[], now: number): CallRuleRow[] {
  if (typeof botId !== "string" || !botId) refuse("bad_bot", "a rule belongs to a bot");
  if (!Array.isArray(list)) refuse("bad_rules", "rules must be a list");
  const valid = list.map(input => ({ input, rule: validateCallRule(input) }));
  const ids = new Set<string>();
  for (const { input } of valid) {
    if (input.id === undefined || input.id === null) continue;
    if (typeof input.id !== "string" || !ID.test(input.id)) refuse("bad_id", "a rule id is 1 to 64 letters, digits, - or _");
    if (ids.has(input.id as string)) refuse("bad_id", "a rule id is listed twice");
    ids.add(input.id as string);
  }
  return inTransaction(db, () => {
    const owner = db.prepare("SELECT bot_id FROM bot_call_rules WHERE id=?");
    const update = db.prepare("UPDATE bot_call_rules SET position=?, kind=?, params=?, label=?, how=?, wait_min=?, enabled=?, emergency=?, updated_at=? WHERE id=? AND bot_id=?");
    const kept: string[] = [];
    for (const [position, { input, rule }] of valid.entries()) {
      const id = typeof input.id === "string" ? input.id : undefined;
      const existing = id === undefined ? undefined : owner.get(id) as { bot_id: string } | undefined;
      if (existing && existing.bot_id !== botId) refuse("bad_id", "that rule belongs to another bot");
      if (existing) {
        update.run(position, rule.kind, rule.params, rule.label, rule.how, rule.waitMin, rule.enabled ? 1 : 0, rule.emergency ? 1 : 0, now, id!, botId);
        kept.push(id!);
      } else {
        kept.push(insertCallRule(db, { ...input, botId, position }, now));
      }
    }
    const keptSet = new Set(kept);
    const drop = db.prepare("DELETE FROM bot_call_rules WHERE id=?");
    for (const row of db.prepare("SELECT id FROM bot_call_rules WHERE bot_id=?").all(botId) as Array<{ id: string }>) if (!keptSet.has(row.id)) drop.run(row.id);
    rebuildWatchThreads(db);
    return listCallRules(db, botId);
  });
}

type RuleRow = { id: string; bot_id: string; position: number; kind: CallRuleKind; tier: CallTier; params: string; label: string | null; how: "ring" | "text_first"; wait_min: number | null;
  enabled: number; demoted: number; emergency: number; restore_held: number; restore_gen: string | null; created_at: number; updated_at: number };
const toRule = (r: RuleRow): CallRuleRow => {
  let params: Record<string, unknown> = {};
  try { const parsed = JSON.parse(r.params) as unknown; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed as Record<string, unknown>; } catch { /* a damaged row reads as empty params */ }
  return {
    id: r.id, botId: r.bot_id, position: Number(r.position), kind: r.kind, tier: r.tier, params, label: r.label, how: r.how, waitMin: r.wait_min === null ? null : Number(r.wait_min),
    enabled: Number(r.enabled) === 1, demoted: Number(r.demoted) === 1, emergency: Number(r.emergency) === 1,
    restoreHeld: Number(r.restore_held) === 1, restoreGen: r.restore_gen, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
};
export function listCallRules(db: DatabaseSync, botId: string): CallRuleRow[] {
  return (db.prepare("SELECT * FROM bot_call_rules WHERE bot_id=? ORDER BY position, id").all(botId) as RuleRow[]).map(toRule);
}

/** The Calls page's view of the fence: whether calls are held and the token Turn calls back on carries. */
export function callRulesHold(db: DatabaseSync): { held: boolean; restoreGen: string | null } {
  const current = newestRestoreGeneration(db);
  const anyHeld = !!db.prepare("SELECT 1 AS x FROM bot_call_rules WHERE restore_held=1 LIMIT 1").get();
  return { held: anyHeld || (current !== null && rearmedGeneration(db) !== current), restoreGen: current };
}

/** POST /api/calls/rearm: clears the holds only when the token is the newest restore generation and the rules' own
 * (the rule of releaseHeldContinuation). A missing or stale token changes nothing. */
export function rearmCallRules(db: DatabaseSync, restoreGen: unknown, now: number = Date.now()): { ok: true; rearmed: number } | { ok: false; reason: "stale" } {
  const current = newestRestoreGeneration(db);
  if (typeof restoreGen !== "string" || !restoreGen || current === null || restoreGen !== current) return { ok: false, reason: "stale" };
  return inTransaction(db, () => {
    const rearmed = Number(db.prepare("UPDATE bot_call_rules SET restore_held=0, restore_gen=NULL, updated_at=? WHERE restore_held=1 AND restore_gen=?").run(now, restoreGen).changes);
    setSetting(db, "rearmed_gen", restoreGen);
    return { ok: true as const, rearmed };
  });
}

// ── restore fence (5.9), inside the messages.db restore transaction ─────────

export const BOT_CALLS_FENCE_PROOFS = {
  calls: ["SELECT COUNT(*) AS n FROM bot_calls WHERE state <> 'done'", "SELECT COUNT(*) AS n FROM bot_call_sessions WHERE ended_at IS NULL"],
  owed: ["SELECT COUNT(*) AS n FROM bot_call_owed"],
  rules: ["SELECT COUNT(*) AS n FROM bot_call_rules WHERE restore_held=0"],
} as const;

/** Non-done intents end done(restored) with the slot freed; open sessions end `restore`; owed admissions are dropped;
 * every rule is held under this restore's generation. Tables an older archive lacks are skipped. */
export function fenceRestoredBotCalls(db: DatabaseSync, generation: string, now: number = Date.now()): { calls: number; sessions: number; owed: number; rules: number } {
  const result = { calls: 0, sessions: 0, owed: 0, rules: 0 };
  if (hasTable(db, "bot_calls")) result.calls = Number(db.prepare("UPDATE bot_calls SET state='done', outcome='restored', active_slot=NULL, ended_at=COALESCE(ended_at, ?) WHERE state <> 'done'").run(now).changes);
  if (hasTable(db, "bot_call_sessions")) result.sessions = Number(db.prepare("UPDATE bot_call_sessions SET ended_at=?, ended_by='restore' WHERE ended_at IS NULL").run(now).changes);
  if (hasTable(db, "bot_call_owed")) result.owed = Number(db.prepare("DELETE FROM bot_call_owed").run().changes);
  if (hasTable(db, "bot_call_rules")) result.rules = Number(db.prepare("UPDATE bot_call_rules SET restore_held=1, restore_gen=?").run(generation).changes);
  return result;
}

// ── retention and the step back ─────────────────────────────────────────────

/** Done intents older than 90 days and sessions a day after they ended leave, `limit` rows of each per call. */
export function pruneBotCalls(db: DatabaseSync, now: number, limit = 500): { calls: number; sessions: number } {
  const calls = Number(db.prepare("DELETE FROM bot_calls WHERE rowid IN (SELECT rowid FROM bot_calls WHERE created_at < ? AND state='done' ORDER BY created_at LIMIT ?)").run(now - CALL_INTENT_RETENTION_MS, limit).changes);
  const sessions = Number(db.prepare("DELETE FROM bot_call_sessions WHERE rowid IN (SELECT rowid FROM bot_call_sessions WHERE ended_at IS NOT NULL AND ended_at < ? LIMIT ?)").run(now - CALL_SESSION_RETENTION_MS, limit).changes);
  return { calls, sessions };
}

/** "Prepare to reinstall" steps a 1.0.9 file back to 1.0.8's shape: the trigger first (it names a table that leaves),
 * then the call tables and push_bindings.rings_for_calls, in one BEGIN IMMEDIATE. Idempotent. */
export function downgradeBotCallsTo108(db: DatabaseSync): { dropped: number } {
  const present = (type: string, name: string) => !!db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type=? AND name=?").get(type, name);
  const triggers = BOT_CALLS_109_TRIGGERS.filter(name => present("trigger", name));
  const tables = BOT_CALLS_109_TABLES.filter(name => present("table", name));
  const column = present("table", "push_bindings") && (db.prepare("PRAGMA table_info(push_bindings)").all() as Array<{ name: string }>).some(c => c.name === "rings_for_calls");
  if (!triggers.length && !tables.length && !column) return { dropped: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const name of triggers) db.exec(`DROP TRIGGER ${name}`);
    for (const name of tables) db.exec(`DROP TABLE ${name}`);
    if (column) db.exec("ALTER TABLE push_bindings DROP COLUMN rings_for_calls");
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  return { dropped: triggers.length + tables.length + (column ? 1 : 0) };
}
