import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InboxItem, InboxPage, InboxQuery, InboxStateUpdate } from "../shared/inbox.ts";
import { INBOX_DECISION_STATUSES, INBOX_TO_READ_STATUSES } from "../shared/inbox.ts";
import { redactSecretsInText } from "./redact.ts";
import { type RoutineRunFact, connectionsToRestore, rollUpRoutineRuns } from "./inbox-rollup.ts";

/** The two status lists as SQL literals. Built from the shared constants so
 *  the query, the counts and the tabs cannot drift: a status added in one
 *  place is a status added everywhere. The values are compile-time string
 *  literals from a `const` tuple, never anything a caller supplies. */
const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(",");
const DECISION_SQL = sqlList(INBOX_DECISION_STATUSES);
const TO_READ_SQL = sqlList(INBOX_TO_READ_STATUSES);

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
      WHEN 'text' THEN json_extract(m.json,'$.artifactIds[0]')
      -- RULE 3, WHERE THE GROUPING ALREADY HAPPENS. An engine that is not
      -- signed in writes one of these every time a turn tries to use it, and
      -- they were keyed by message id, so twenty attempts were twenty rows
      -- saying the same sentence. One key per thread per cause makes them one
      -- row carrying the count.
      WHEN 'activity' THEN CASE
        WHEN json_extract(m.json,'$.tool.authRequired')=1 OR json_extract(m.json,'$.tool.setup')=1 THEN 'connection'
        ELSE m.id END
      ELSE m.id END) AS source_key,
    CASE m.kind
      WHEN 'options' THEN CASE
        WHEN json_extract(m.json,'$.card.expired')=1 AND json_extract(m.json,'$.card.unattended')=1
          AND COALESCE(json_extract(m.json,'$.card.sentAsMessage'),0)=0 AND COALESCE(json_extract(m.json,'$.card.dismissed'),0)=0 THEN 'missed'
        WHEN json_type(m.json,'$.card.answered')='text' OR json_extract(m.json,'$.card.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'secret' THEN CASE WHEN json_extract(m.json,'$.secret.provided')=1 OR json_extract(m.json,'$.secret.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'connector' THEN CASE WHEN json_extract(m.json,'$.connector.status')='connected' OR json_extract(m.json,'$.connector.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.goalStatus'),json_extract(m.json,'$.routineRun.status'))
      WHEN 'goal.run' THEN json_extract(m.json,'$.goalRun.status') WHEN 'text' THEN 'completed' ELSE 'failed' END AS status,
    CASE m.kind WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.summary'),json_extract(m.json,'$.routineRun.error'),'')
      WHEN 'goal.run' THEN COALESCE(json_extract(m.json,'$.goalRun.detail'),'') WHEN 'text' THEN COALESCE(json_extract(m.json,'$.text'),'Saved file') ELSE '' END AS summary,
    CASE m.kind WHEN 'options' THEN CASE
      WHEN json_type(m.json,'$.card.routineRequest')='object' THEN 'Routine proposal'
      WHEN json_type(m.json,'$.card.skillRequest')='object' THEN 'Skill proposal'
      -- Expired is checked before the tool, so every expired card called
      -- itself a question. Under a tab named Approvals that reads as though
      -- the wrong row arrived, and "whether it has expired" was the exact
      -- thing reported as impossible to tell.
      WHEN json_extract(m.json,'$.card.expired')=1 THEN
        CASE WHEN json_type(m.json,'$.card.tool')='text' THEN 'Approval expired' ELSE 'Question expired' END
      WHEN json_type(m.json,'$.card.tool')='text' THEN 'Approval requested' ELSE 'Question needs an answer' END
      WHEN 'secret' THEN 'Credential setup requested' WHEN 'connector' THEN 'Connection setup'
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.routineName'),'Routine result')
      WHEN 'goal.run' THEN 'Team goal result' WHEN 'text' THEN 'Saved file'
      -- A provider having a bad morning and an engine that is not signed in
      -- are not the same news, and only one of them is anybody's job.
      WHEN 'activity' THEN CASE
        WHEN json_extract(m.json,'$.tool.authRequired')=1 THEN 'Sign in needed'
        WHEN json_extract(m.json,'$.tool.setup')=1 THEN 'Setup needed'
        ELSE 'Provider needs attention' END
      ELSE 'Provider needs attention' END AS title,
    -- WHICH OF THE FIVE LISTS THIS BELONGS IN.
    --
    -- The kind column says what SHAPE the message is. This says what it
    -- costs the owner to ignore it, which is the only question the Inbox is
    -- sorted on.
    --
    -- The split inside 'options' is the one the owner asked for: a card
    -- carrying a TOOL is permission to perform a specific, already drafted
    -- act ("send these four emails"), and everything else of that shape is a
    -- question wanting a judgement ("should this become a routine?"). They
    -- read the same in a list and are nothing alike to answer.
    --
    -- An 'activity' row that is a missing login or an unfinished setup is a
    -- CONNECTION, not provider news: it needs the owner's hands and no
    -- amount of waiting fixes it. A provider simply erroring is news.
    CASE m.kind
      WHEN 'options' THEN CASE WHEN json_type(m.json,'$.card.tool')='text' THEN 'approval' ELSE 'question' END
      WHEN 'secret' THEN 'connection' WHEN 'connector' THEN 'connection'
      WHEN 'activity' THEN CASE WHEN json_extract(m.json,'$.tool.authRequired')=1 OR json_extract(m.json,'$.tool.setup')=1 THEN 'connection' ELSE 'routine' END
      WHEN 'routine.run' THEN 'routine' WHEN 'goal.run' THEN 'routine'
      ELSE 'result' END AS kind_segment
  FROM messages m
  WHERE m.role='bot' AND m.thread_id IN (SELECT value FROM json_each(?))
    AND m.kind IN ('options','secret','connector','routine.run','goal.run','activity','text')
    AND CASE m.kind
      WHEN 'options' THEN json_type(m.json,'$.card.requestId')='text' OR json_type(m.json,'$.card.routineRequest')='object' OR json_type(m.json,'$.card.skillRequest')='object'
      WHEN 'secret' THEN json_type(m.json,'$.secret')='object'
      WHEN 'connector' THEN json_type(m.json,'$.connector')='object'
      WHEN 'routine.run' THEN json_extract(m.json,'$.routineRun.status') NOT IN ('queued','running')
      WHEN 'goal.run' THEN json_extract(m.json,'$.goalRun.status')!='working'
      WHEN 'activity' THEN json_extract(m.json,'$.tool.ok')=0 AND (json_extract(m.json,'$.tool.setup')=1 OR json_extract(m.json,'$.tool.authRequired')=1 OR json_type(m.json,'$.tool.providerError')='object')
      WHEN 'text' THEN json_type(m.json,'$.artifactIds[0]')='text' AND length(json_extract(m.json,'$.artifactIds[0]'))=36
    END
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY source_key ORDER BY CASE WHEN status IN ('resolved','completed','failed','cancelled','stopped','missed') THEN 1 ELSE 0 END DESC,at DESC,source_row DESC) AS position,
    COUNT(*) OVER (PARTITION BY source_key) AS copies FROM raw
), items AS (
  SELECT r.*, s.read_version, s.snoozed_until,
    -- TWO FLAGS, NOT ONE. A decision is owed on the first set and nothing is
    -- owed on the second: see the comment at the top of shared/inbox.ts for
    -- why putting them in one bucket made the count unreadable. The status
    -- lists live there too, and are spliced in below so SQL and TypeScript
    -- cannot drift apart.
    CASE WHEN status IN (${DECISION_SQL}) THEN 1 ELSE 0 END AS decision,
    CASE WHEN status IN (${TO_READ_SQL}) THEN 1 ELSE 0 END AS to_read,
    -- A RUN THAT HAS STOPPED AND IS ASKING IS NOT A NOTIFICATION.
    --
    -- Rule 4 says a routine run never asks, and that is right about the
    -- thirty five rows it was written for: a run that failed, retried, or
    -- ran on a timer is news. It is NOT right about a run whose goal came
    -- back needs-input. routines.ts parks that run at status 'waiting'
    -- with "The team needs your input" on it, and says so in its own words:
    -- "a team asking the human a question is still waiting on them".
    --
    -- Kept kind-derived and then overridden HERE, rather than in raw,
    -- because status does not exist until this layer.
    --
    -- WHY IT HAS TO BE A COUNTED SEGMENT. decisions counts everything
    -- owed. If an owed run stayed segment 'routine' it would be inside that
    -- number and inside no tab that can show it: the badge would say three,
    -- the three tabs would add to two, and the missing one would be
    -- unreachable except by scrolling the umbrella. That is the defect this
    -- whole redesign exists to remove, reintroduced by arithmetic.
    CASE WHEN kind_segment='routine' AND status IN (${DECISION_SQL}) THEN 'question'
      ELSE kind_segment END AS segment,
    -- WHAT A SEGMENT TAB SHOWS, WHICH IS NOT THE SAME AS WHAT IT COUNTS.
    --
    -- The three tabs filtered on decision=1, and two kinds of thing that
    -- belong to them are not owed and never can be:
    --
    --   An ENGINE THAT IS NOT SIGNED IN arrives as a failed activity. It
    --   needs the owner's hands, which is the definition of a connection,
    --   but it is a log line with nothing on it to resolve, so it can only
    --   ever be 'failed'. It was therefore in no tab at all: Connections
    --   asked for owed, results asks for neither owed nor news, and the
    --   to-read list that used to carry it lost its tab in this redesign.
    --   A dead login reachable only by scrolling "All" is THE original
    --   complaint, made worse by the thing built to fix it.
    --
    --   A REQUEST THAT EXPIRED UNATTENDED is 'missed' for the same reason,
    --   and "I cannot tell whether it expired or where to look" was reported
    --   on the same evening.
    --
    -- So the tab shows both and counts only the first. The count stays
    -- exactly "what is waiting on you", so the three still sum to the
    -- umbrella and nothing can badge for ever with no way to clear it; the
    -- LIST is the place a person goes to look, and it has to hold everything
    -- of that kind or they will look in it and conclude it is not there.
    CASE WHEN status IN (${DECISION_SQL}) OR status IN (${TO_READ_SQL}) THEN 1 ELSE 0 END AS owed_or_over
  FROM ranked r LEFT JOIN inbox_item_state s ON s.source_key=r.source_key
  WHERE position=1 AND NOT(status='completed' AND length(trim(summary))=0)
) `;
interface Row {
  source_key: string; thread_id: string; message_id: string; at: number; kind: string; json: string;
  status: string; title: string; summary: string; segment: string; decision: number; to_read: number; read_version: string | null; snoozed_until: number | null; copies: number;
}
/** Routine runs, oldest first, for the rollup. Bounded: a workspace that has
 *  run every thirty minutes for a year has seventeen thousand of these, and
 *  the rollup answers the same question from the recent ones. */
const ROUTINE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const ROUTINE_ROW_LIMIT = 2_000;

/** A routine run reduced to what the rules need.
 *
 *  IDENTITY IS THE NAME WITHIN ITS THREAD, because a run carries `routineName`
 *  and no stable routine id. Renaming a routine therefore starts a new row,
 *  which is the honest reading: a renamed routine is a different thing in the
 *  owner's head, and the alternative (matching loosely) would merge two real
 *  routines that happen to share a name across bots. */
function routineFacts(db: DatabaseSync, allowed: string, threads: InboxAccess["threads"], now: number): RoutineRunFact[] {
  const rows = db.prepare(SOURCE + `SELECT thread_id, message_id, title, summary, status, at, decision FROM items
    WHERE kind_segment='routine' AND at>=? ORDER BY at DESC LIMIT ?`)
    .all(allowed, now - ROUTINE_WINDOW_MS, ROUTINE_ROW_LIMIT) as unknown as
    Array<{ thread_id: string; message_id: string; title: string; summary: string; status: string; at: number; decision: number }>;
  return rows.map(row => ({
    routineKey: `${row.thread_id}:${row.title}`,
    routineName: text(row.title, 120),
    botLabel: text(threads.find(thread => thread.threadId === row.thread_id)?.label ?? "", 100),
    at: row.at,
    // Anything that is not a clean finish is a failure for the rules'
    // purposes, EXCEPT a run that stopped to ask something. Being generous
    // here is the safe direction: a run wrongly counted as failed shows up
    // inside a row that already exists, while one wrongly counted as clean
    // can make a stuck routine read as recovered. A run that is waiting on
    // the owner is the one case where "failed" is not generous but wrong —
    // it would print "Not recovering" over a routine that is one answer away
    // from carrying on.
    failed: row.status !== "completed" && row.decision !== 1,
    owed: row.decision === 1,
    detail: row.summary,
    link: { threadId: row.thread_id, messageId: row.message_id },
  }));
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
  const kind = row.kind === "options" ? "request" : row.kind === "secret" || row.kind === "connector" ? "connection" : row.kind === "activity" ? "error" : row.kind === "routine.run" ? "routine" : row.kind === "text" ? "artifact" : "goal";
  const revision = version(row.json);
  const segment = (["approval", "question", "connection", "routine", "result"] as const)
    .find(value => value === row.segment) ?? "result";
  return { id: Buffer.from(row.source_key).toString("base64url"), version: revision, kind, segment, status: row.status,
    decision: row.decision === 1, toRead: row.to_read === 1, title: text(row.title, 120), summary: text(row.summary),
    sourceLabel: text(source.label, 100), ...(source.botId ? { botId: source.botId } : {}), at: row.at,
    read: row.read_version === revision, snoozedUntil: row.snoozed_until, duplicates: row.copies,
    link: { threadId: row.thread_id, messageId: row.message_id, ...(typeof runId === "string" ? { runId } : {}), ...(row.kind === "text" ? { artifactId: message.artifactIds[0] as string } : {}) } };
}
function queryValues(query: InboxQuery) {
  const view = query.view ?? "decisions", page = query.page ?? 0, pageSize = query.pageSize ?? 25;
  if (!["decisions", "approvals", "questions", "connections", "routines", "to-read", "results", "all"].includes(view) || !Number.isInteger(page) || page < 0 || page > 100_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
    || (query.query !== undefined && (typeof query.query !== "string" || query.query.length > 200))
    || (query.includeSnoozed !== undefined && typeof query.includeSnoozed !== "boolean")) reject(400, "Invalid Inbox query.");
  return { view, page, pageSize, search: (query.query ?? "").trim().toLowerCase() };
}

export function listInbox(db: DatabaseSync, query: InboxQuery, access: InboxAccess, now = Date.now()): InboxPage {
  const allowed = scope(access), { view, page, pageSize, search } = queryValues(query);
  const decisions = view === "decisions";
  // A DECISION IS A DECISION WHATEVER SHAPE IT ARRIVED IN.
  //
  // This used to also require `kind='options'`, which is the shape an
  // approval card takes. A connector asking to be set up and a secret being
  // requested are `connector` and `secret`, and both sit at status
  // 'pending' with somebody's work stopped behind them. They were therefore
  // absent from the approvals tab and present in the other one, which is
  // exactly backwards: a "Connection setup / Pending" row is the single most
  // decision-shaped thing in the whole list.
  //
  // An expired card is dropped, because nothing is waiting on it any more.
  // THE FIVE LISTS, PLUS THE TWO THE SPLIT REPLACED.
  //
  // `approvals`, `decisions` and `connections` are the three things that
  // genuinely require the owner, and they are filtered on `segment` AND on a
  // decision being owed — a connector row that is already connected is not a
  // request, it is history. `routines` is everything a routine did, owed or
  // not, because a run is a notification; the caller rolls those up.
  //
  // `decisions` STILL MEANS EVERYTHING OWED, and the three segment views are
  // how that total is broken down rather than a replacement for it. The
  // sidebar badge asks for `decisions` by name; narrowing it here would have
  // left that number silently missing every approval and every dead
  // connection.
  const predicate = `${decisions ? "COALESCE(json_extract(json,'$.card.expired'),0)=0 AND" : ""}
    (?='all'
      OR (?='approvals' AND owed_or_over=1 AND segment='approval')
      OR (?='decisions' AND decision=1)
      OR (?='questions' AND owed_or_over=1 AND segment='question')
      OR (?='connections' AND owed_or_over=1 AND segment='connection')
      OR (?='routines' AND kind_segment='routine')
      OR (?='to-read' AND to_read=1)
      OR (?='results' AND decision=0 AND to_read=0 AND kind IN ('routine.run','goal.run','text')))
    AND (?=1 OR snoozed_until IS NULL OR snoozed_until<=?)
    AND (?='' OR instr(lower(title || ' ' || summary || ' ' || status),?)>0
      OR thread_id IN (SELECT json_extract(value,'$.threadId') FROM json_each(?) WHERE instr(lower(json_extract(value,'$.label')),?)>0))`;
  // Snooze applies to decisions too. "Not now" is a legitimate answer to
  // being asked, and the checkbox brings them back; what snooze must never do
  // is make a decision look ANSWERED, and it does not: the item keeps its
  // pending status and returns the moment the snooze expires.
  const params = [allowed, view, view, view, view, view, view, view, view, query.includeSnoozed ? 1 : 0, now, search, search,
    JSON.stringify(access.threads.map(thread => ({ threadId: thread.threadId, label: text(thread.label, 100) }))), search];
  const total = Number(db.prepare(SOURCE + `SELECT COUNT(*) AS total FROM items WHERE ${predicate}`).get(...params)?.total ?? 0);
  // Owed first. A tab that holds both must not float a request that expired
  // last week above one that is waiting now.
  const rows = db.prepare(SOURCE + `SELECT * FROM items WHERE ${predicate} ORDER BY decision DESC,at DESC,source_key LIMIT ? OFFSET ?`).all(...params, pageSize, page * pageSize) as unknown as Row[];
  // Counts describe the visible page's filter, not hidden audiences. Reading
  // a request never removes it from the decisions count, because reading is
  // not answering; reading DOES clear it from the to-read count, because
  // there reading is the whole action.
  const live = "(snoozed_until IS NULL OR snoozed_until<=?)";
  // ONE COUNT PER THING THAT CAN BE ASKED OF A PERSON, AND NONE FOR THE REST.
  //
  // Routines and results are never counted here, and that is the point of the
  // whole redesign: the owner's badge said thirty six because it counted
  // things that happened. A number he cannot act on is a number he stops
  // reading, and then the one he could act on is invisible inside it.
  const segmentCount = (segment: string) => Number(db.prepare(SOURCE
    + `SELECT COUNT(*) AS n FROM items WHERE decision=1 AND segment=? AND ${live}`).get(allowed, segment, now)?.n ?? 0);
  const approvalCount = segmentCount("approval");
  const questionCount = segmentCount("question");
  const connectionCount = segmentCount("connection");
  const decisionCount = Number(db.prepare(SOURCE
    + `SELECT COUNT(*) AS n FROM items WHERE decision=1 AND ${live}`).get(allowed, now)?.n ?? 0);
  // Never opened, rather than "not current". The read mark is a hash of the
  // message computed in JS, and SQL cannot recompute it, so an item that was
  // read and has since changed is counted as read here. Erring that way keeps
  // the badge quiet rather than crying wolf, and the row itself still shows
  // as unread once the list is open.
  const toReadCount = Number(db.prepare(SOURCE + `SELECT COUNT(*) AS n FROM items WHERE to_read=1 AND read_version IS NULL AND ${live}`).get(allowed, now)?.n ?? 0);
  // THE DEAD CREDENTIAL NOTHING ELSE IN THE SYSTEM IS LOOKING FOR.
  //
  // A connector is checked when somebody is watching it being authorized and
  // never again: the only caller that creates one is an endpoint the bot
  // POSTs to, and the live re-check is polled by the card while it is on
  // screen. Nothing sweeps in the background. So a token that dies three
  // weeks after it was connected, during an unattended run at three in the
  // morning, leaves exactly one trace anywhere in this product: the error on
  // that run. `connectionsToRestore` reads it, and is the only thing that
  // does.
  //
  // Computed once and shared, because `routines` wants the same rollup and
  // this runs on the view the sidebar polls.
  const rollups = view === "routines" || view === "connections" || decisions
    ? rollUpRoutineRuns(routineFacts(db, allowed, access.threads, now), now)
    : null;
  // AND IT ASKS ONLY WHEN NOBODY ELSE IS ASKING.
  //
  // This is a LAST RESORT detector, not a second opinion. When a connector
  // card is already sitting at 'pending' the owner is already being told to
  // reconnect something, and raising this as well counts one dead Gmail
  // twice: the existing morning fixture has both, and went from three owed
  // things to four the moment this was wired.
  //
  // The suppression is deliberately coarse because the evidence is. A run
  // error says "401 unauthorized" and names no connector, so there is no
  // slug to match against the card; and this raises ONE row for every
  // connection cause anyway. Coarse evidence, coarse rule, and it errs
  // towards asking once rather than twice.
  const restore = rollups && connectionCount === 0 ? connectionsToRestore(rollups) : [];
  return { items: rows.map(row => item(row, access)), total, page, pageSize,
    unread: rows.filter(row => row.read_version !== version(row.json)).length,
    // IT IS ADDED TO BOTH OR IT IS ADDED TO NEITHER. The three segment counts
    // sum to the umbrella, and that invariant is the one this Inbox has
    // already broken once: a number in `connections` that is missing from
    // `decisions` puts a badge on a tab the sidebar total cannot explain.
    decisions: decisionCount + restore.length, toRead: toReadCount,
    approvals: approvalCount, questions: questionCount, connections: connectionCount + restore.length,
    // ONE ROW PER ROUTINE, NOT PER RUN, and only where it is asked for. The
    // owner's thirty six rows were four routines; the tab says "one line per
    // routine, not per run" and this is that sentence kept in data.
    ...(view === "routines" && rollups ? { routines: rollups } : {}),
    // Not an InboxItem, deliberately. There is no message under it, so it has
    // no read mark, no snooze and nothing to open: giving it the item shape
    // would mean inventing all three. It is a purpose-built row, exactly like
    // the routine rows above it.
    ...(restore.length > 0 ? { restore } : {}) };
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
