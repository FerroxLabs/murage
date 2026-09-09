import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InboxItem, InboxPage, InboxQuery, InboxStateUpdate } from "../shared/inbox.ts";
import { redactSecretsInText } from "./redact.ts";

export interface InboxThread { threadId: string; label: string; botId?: string }
export interface InboxAccess { owner: boolean; threads: readonly InboxThread[] }
export class InboxError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const reject = (status: number, message: string): never => { throw new InboxError(status, message); };
const version = (json: string) => createHash("sha256").update(json).digest("hex");
const text = (value: unknown, limit = 280) => redactSecretsInText(typeof value === "string" ? value : "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, limit);

/** Additive metadata only. Messages remain the only source of action state;
 * no capture hook, second approval record or content backfill is required. */
export function initializeInbox(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_item_state (
    source_key TEXT PRIMARY KEY, read_version TEXT, read_at INTEGER, snoozed_until INTEGER);
    CREATE INDEX IF NOT EXISTS messages_inbox_kind_thread_at ON messages(kind,thread_id,at DESC);`);
}

// Restrict sources to permitted threads before grouping or searching. A
// resolved copy wins over a replayed pending request with the same identity.
// No secret/connector descriptions, option subtitles or tool commands enter
// the projection. Run output is redacted again at the response boundary.
const SOURCE = `WITH raw AS (
  SELECT m.rowid AS source_row, m.thread_id, m.id AS message_id, m.at, m.kind, m.json,
    json_array(m.thread_id,m.kind,CASE m.kind
      WHEN 'options' THEN COALESCE(json_extract(m.json,'$.card.requestId'),json_extract(m.json,'$.card.routineRequest.requestId'),json_extract(m.json,'$.card.skillRequest.requestId'),m.id)
      WHEN 'secret' THEN COALESCE(json_extract(m.json,'$.secret.requestKey'),m.id)
      WHEN 'connector' THEN COALESCE(json_extract(m.json,'$.connector.resumeKey') || ':' || json_extract(m.json,'$.connector.slug'),m.id)
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.runId'),m.id)
      WHEN 'goal.run' THEN COALESCE(json_extract(m.json,'$.goalRun.runId'),m.id)
      ELSE m.id END) AS source_key,
    CASE m.kind
      WHEN 'options' THEN CASE WHEN json_type(m.json,'$.card.answered')='text' OR json_extract(m.json,'$.card.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'secret' THEN CASE WHEN json_extract(m.json,'$.secret.provided')=1 OR json_extract(m.json,'$.secret.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'connector' THEN CASE WHEN json_extract(m.json,'$.connector.status')='connected' OR json_extract(m.json,'$.connector.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.goalStatus'),json_extract(m.json,'$.routineRun.status'))
      WHEN 'goal.run' THEN json_extract(m.json,'$.goalRun.status') ELSE 'failed' END AS status,
    CASE m.kind WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.summary'),json_extract(m.json,'$.routineRun.error'),'')
      WHEN 'goal.run' THEN COALESCE(json_extract(m.json,'$.goalRun.detail'),'') ELSE '' END AS summary,
    CASE m.kind WHEN 'options' THEN CASE
      WHEN json_type(m.json,'$.card.routineRequest')='object' THEN 'Routine proposal'
      WHEN json_type(m.json,'$.card.skillRequest')='object' THEN 'Skill proposal'
      WHEN json_type(m.json,'$.card.tool')='text' THEN 'Approval requested' ELSE 'Question needs an answer' END
      WHEN 'secret' THEN 'Credential setup requested' WHEN 'connector' THEN 'Connection setup'
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.routineName'),'Routine result')
      WHEN 'goal.run' THEN 'Team goal result' ELSE 'Provider needs attention' END AS title
  FROM messages m
  WHERE m.role='bot' AND m.thread_id IN (SELECT value FROM json_each(?))
    AND m.kind IN ('options','secret','connector','routine.run','goal.run','activity')
    AND CASE m.kind
      WHEN 'options' THEN json_type(m.json,'$.card.requestId')='text' OR json_type(m.json,'$.card.routineRequest')='object' OR json_type(m.json,'$.card.skillRequest')='object'
      WHEN 'secret' THEN json_type(m.json,'$.secret')='object'
      WHEN 'connector' THEN json_type(m.json,'$.connector')='object'
      WHEN 'routine.run' THEN json_extract(m.json,'$.routineRun.status') NOT IN ('queued','running')
      WHEN 'goal.run' THEN json_extract(m.json,'$.goalRun.status')!='working'
      WHEN 'activity' THEN json_extract(m.json,'$.tool.ok')=0 AND (json_extract(m.json,'$.tool.setup')=1 OR json_extract(m.json,'$.tool.authRequired')=1 OR json_type(m.json,'$.tool.providerError')='object')
    END
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY source_key ORDER BY CASE WHEN status IN ('resolved','completed','failed','cancelled','stopped','missed') THEN 1 ELSE 0 END DESC,at DESC,source_row DESC) AS position,
    COUNT(*) OVER (PARTITION BY source_key) AS copies FROM raw
), items AS (
  SELECT r.*, s.read_version, s.snoozed_until,
    CASE WHEN status IN ('pending','waiting','needs-input','blocked','limit-reached','failed','missed','paused') THEN 1 ELSE 0 END AS needs_you
  FROM ranked r LEFT JOIN inbox_item_state s ON s.source_key=r.source_key
  WHERE position=1 AND NOT(status='completed' AND length(trim(summary))=0)
) `;
interface Row {
  source_key: string; thread_id: string; message_id: string; at: number; kind: string; json: string;
  status: string; title: string; summary: string; needs_you: number; read_version: string | null; snoozed_until: number | null; copies: number;
}
function scope(access: InboxAccess) {
  if (access.owner !== true) reject(404, "Inbox is unavailable.");
  if (!Array.isArray(access.threads) || access.threads.length > 20_000 || access.threads.some(thread => !thread.threadId || typeof thread.threadId !== "string")) reject(400, "Invalid Inbox scope.");
  return JSON.stringify([...new Set(access.threads.map(thread => thread.threadId))]);
}
function item(row: Row, access: InboxAccess): InboxItem {
  const source = access.threads.find(thread => thread.threadId === row.thread_id)!;
  const message = JSON.parse(row.json);
  const runId = row.kind === "routine.run" ? message.routineRun?.runId : row.kind === "goal.run" ? message.goalRun?.runId : undefined;
  const kind = row.kind === "options" ? "request" : row.kind === "secret" || row.kind === "connector" ? "connection" : row.kind === "activity" ? "error" : row.kind === "routine.run" ? "routine" : "goal";
  const revision = version(row.json);
  return { id: Buffer.from(row.source_key).toString("base64url"), version: revision, kind, status: row.status,
    needsYou: row.needs_you === 1, title: text(row.title, 120), summary: text(row.summary),
    sourceLabel: text(source.label, 100), ...(source.botId ? { botId: source.botId } : {}), at: row.at,
    read: row.read_version === revision, snoozedUntil: row.snoozed_until, duplicates: row.copies,
    link: { threadId: row.thread_id, messageId: row.message_id, ...(typeof runId === "string" ? { runId } : {}) } };
}
function queryValues(query: InboxQuery) {
  const view = query.view ?? "needs-you", page = query.page ?? 0, pageSize = query.pageSize ?? 25;
  if (!["needs-you", "results", "all"].includes(view) || !Number.isInteger(page) || page < 0 || page > 100_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
    || (query.query !== undefined && (typeof query.query !== "string" || query.query.length > 200))
    || (query.includeSnoozed !== undefined && typeof query.includeSnoozed !== "boolean")) reject(400, "Invalid Inbox query.");
  return { view, page, pageSize, search: (query.query ?? "").trim().toLowerCase() };
}

export function listInbox(db: DatabaseSync, query: InboxQuery, access: InboxAccess, now = Date.now()): InboxPage {
  const allowed = scope(access), { view, page, pageSize, search } = queryValues(query);
  const predicate = `(?='all' OR (?='needs-you' AND needs_you=1) OR (?='results' AND needs_you=0 AND kind IN ('routine.run','goal.run')))
    AND (?=1 OR snoozed_until IS NULL OR snoozed_until<=?)
    AND (?='' OR instr(lower(title || ' ' || summary || ' ' || status),?)>0
      OR thread_id IN (SELECT json_extract(value,'$.threadId') FROM json_each(?) WHERE instr(lower(json_extract(value,'$.label')),?)>0))`;
  const params = [allowed, view, view, view, query.includeSnoozed ? 1 : 0, now, search, search,
    JSON.stringify(access.threads.map(thread => ({ threadId: thread.threadId, label: text(thread.label, 100) }))), search];
  const total = Number(db.prepare(SOURCE + `SELECT COUNT(*) AS total FROM items WHERE ${predicate}`).get(...params)?.total ?? 0);
  const rows = db.prepare(SOURCE + `SELECT * FROM items WHERE ${predicate} ORDER BY at DESC,source_key LIMIT ? OFFSET ?`).all(...params, pageSize, page * pageSize) as unknown as Row[];
  // Counts describe the visible page's filter, not hidden audiences. Reading
  // request cards never removes them from the Needs you count.
  const needsYou = Number(db.prepare(SOURCE + "SELECT COUNT(*) AS n FROM items WHERE needs_you=1 AND (snoozed_until IS NULL OR snoozed_until<=?)").get(allowed, now)?.n ?? 0);
  return { items: rows.map(row => item(row, access)), total, page, pageSize,
    unread: rows.filter(row => row.read_version !== version(row.json)).length, needsYou };
}

/** State updates cannot change source status, approve requests or run tools. */
export function updateInboxState(db: DatabaseSync, update: InboxStateUpdate, access: InboxAccess, now = Date.now()) {
  const allowed = scope(access);
  if (!update || typeof update.id !== "string" || update.id.length > 8192 || typeof update.version !== "string"
    || !/^[a-f0-9]{64}$/.test(update.version) || Object.keys(update).some(key => !["id", "version", "read", "snoozedUntil"].includes(key))
    || (update.read !== undefined && typeof update.read !== "boolean")
    || (update.snoozedUntil !== undefined && update.snoozedUntil !== null && (!Number.isSafeInteger(update.snoozedUntil) || update.snoozedUntil <= now || update.snoozedUntil > now + 30 * 24 * 60 * 60 * 1000))
    || (update.read === undefined && update.snoozedUntil === undefined)) reject(400, "Invalid Inbox update.");
  const sourceKey = Buffer.from(update.id, "base64url").toString("utf8");
  const row = db.prepare(SOURCE + "SELECT * FROM items WHERE source_key=?").get(allowed, sourceKey) as unknown as Row | undefined;
  if (!row) throw new InboxError(404, "Inbox item is unavailable.");
  if (version(row.json) !== update.version) reject(409, "This item changed. Refresh Inbox before updating it.");
  db.prepare(`INSERT INTO inbox_item_state(source_key,read_version,read_at,snoozed_until) VALUES(?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET
      read_version=CASE WHEN ? THEN excluded.read_version ELSE inbox_item_state.read_version END,
      read_at=CASE WHEN ? THEN excluded.read_at ELSE inbox_item_state.read_at END,
      snoozed_until=CASE WHEN ? THEN excluded.snoozed_until ELSE inbox_item_state.snoozed_until END`)
    .run(sourceKey, update.read === true ? update.version : null, update.read === true ? now : null, update.snoozedUntil ?? null,
      update.read !== undefined ? 1 : 0, update.read !== undefined ? 1 : 0, update.snoozedUntil !== undefined ? 1 : 0);
  return { ok: true as const };
}

/** Root supplies its existing desktop proof and exact permitted task roster.
 * Kept transport-independent so HTTP fixtures exercise this same boundary. */
export function inboxRequest(db: DatabaseSync, request: { method: string; path: string; query?: InboxQuery; body?: InboxStateUpdate }, access: InboxAccess) {
  try {
    scope(access);
    if (request.method === "GET" && request.path === "/api/inbox") return { status: 200, body: listInbox(db, request.query ?? {}, access) };
    if (request.method === "POST" && request.path === "/api/inbox/state") return { status: 200, body: updateInboxState(db, request.body!, access) };
    return { status: 404, body: { error: "Inbox is unavailable." } };
  } catch (error) {
    if (error instanceof InboxError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}
