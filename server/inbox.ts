import { Worker } from "node:worker_threads";
import { inboxDeferredDrain, INBOX_FILL_MAX_HOLD_MS, type InboxDeferredSql } from "./inbox-fill-worker.ts";
import { observeLine } from "./observe.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InboxItem, InboxPage, InboxQuery, InboxStateUpdate } from "../shared/inbox.ts";
import { INBOX_DECISION_STATUSES, INBOX_RUN_ON_CARD_STATUSES, INBOX_TO_READ_STATUSES } from "../shared/inbox.ts";
import { redactSecretsInText } from "./redact.ts";
import { type RoutineRunFact, connectionsToRestore, rollUpRoutineRuns } from "./inbox-rollup.ts";
import { bumpMessagesVersion, messagesVersion } from "./inbox-version.ts";

/** The two status lists as SQL literals. Built from the shared constants so
 *  the query, the counts and the tabs cannot drift: a status added in one
 *  place is a status added everywhere. The values are compile-time string
 *  literals from a `const` tuple, never anything a caller supplies. */
const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(",");
const DECISION_SQL = sqlList(INBOX_DECISION_STATUSES);
const TO_READ_SQL = sqlList(INBOX_TO_READ_STATUSES);
/** Owed: a decision status, except a routine run waiting on a card that is
 *  itself the item owed (shared/inbox.ts INBOX_RUN_ON_CARD_STATUSES). `p` is
 *  the row prefix ("p.", "h."). */
const RUN_ON_CARD = (p: string) => `(${p}kind='routine.run' AND ${p}status IN (${sqlList(INBOX_RUN_ON_CARD_STATUSES)}))`;
const OWED = (p: string) => `(${p}status IN (${DECISION_SQL}) AND NOT ${RUN_ON_CARD(p)})`;

export interface InboxThread { threadId: string; label: string; botId?: string }
/** One routine run as the routine's own record has it (server/routines.ts).
 *  A run in the routine's own conversation posts no card anywhere, so the
 *  Routines view reads these beside the cards. */
export interface InboxRoutineRun {
  runId: string;
  routineId: string;
  routineName: string;
  threadId?: string;
  status: string;
  /** When it started (or was due). */
  at: number;
  error?: string;
  attention?: string;
  /** Where the run begins in its conversation, when the caller found it. */
  link?: { threadId: string; messageId: string };
}
export interface InboxAccess { owner: boolean; threads: readonly InboxThread[]; routineRuns?: readonly InboxRoutineRun[] }
export class InboxError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const reject = (status: number, message: string): never => { throw new InboxError(status, message); };
const version = (json: string) => createHash("sha256").update(json).digest("hex");
const text = (value: unknown, limit = 280) => redactSecretsInText(typeof value === "string" ? value : "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, limit);

/** Additive metadata, and the projection derived from messages (kept by
 * triggers in the write's own transaction). Messages remain the only source of
 * action state: no second approval record exists, and the projection is
 * rebuilt from them whenever it cannot be trusted. */
export function initializeInbox(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_item_state (
    source_key TEXT PRIMARY KEY, read_version TEXT, read_at INTEGER, snoozed_until INTEGER);
    CREATE INDEX IF NOT EXISTS messages_inbox_kind_thread_at ON messages(kind,thread_id,at DESC);
    -- The projection starts from role='bot' and a kind list, so role leads.
    CREATE INDEX IF NOT EXISTS messages_inbox ON messages(role,kind,thread_id,at);
    -- Plain chat text is the bulk of any busy history and is never an item;
    -- only a saved file (artifactIds[0]) is. This lets the Needs-you scan
    -- reach those without json_extract-ing every ordinary message.
    CREATE INDEX IF NOT EXISTS messages_inbox_text_artifact ON messages(thread_id,at)
      WHERE role='bot' AND kind='text' AND json_extract(json,'$.artifactIds[0]') IS NOT NULL;`);
  // Cleared: set aside by the owner until something newer happens to it.
  // Added after the table shipped, so an existing database gains the column.
  const columns = db.prepare("PRAGMA table_info(inbox_item_state)").all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === "cleared_at")) db.exec("ALTER TABLE inbox_item_state ADD COLUMN cleared_at INTEGER");
  // After cleared_at exists: the projection's triggers read it.
  createInboxProjection(db);
}

// THE PROJECTION IS KEPT, NOT RECOMPUTED.
//
// Every Inbox answer used to rebuild this from the messages table: every
// message of an Inbox kind, in every conversation, from the start of history,
// with about twenty json_extract calls each, on the main connection. On three
// years of use that was a 51 s freeze, paid again after any new card or run.
//
// Now each message is reduced ONCE, when it is written, into `inbox_raw` (the
// triggers below run in the same transaction as the write, so the projection
// can never disagree with the message it came from); `inbox_keys` keeps how
// many copies each item has; `inbox_items` holds each item's winning copy with
// its read, snooze and clear marks; and `inbox_counts` holds, per
// conversation, how many items each list and each badge has. All four move in
// the write's own transaction. A read is a walk down one list's own index for
// the rows on the page, plus one counter row per permitted conversation. The
// Inbox holds exactly what it always held, of every age; nothing is windowed
// except the routine roll-up, as before.
//
// The CASE logic below is the same text the old query ran, so what an item
// says, where it is filed and whether it is owed cannot drift.
/** The most characters of summary and title the projection stores. */
const PREVIEW_CHARS = 2048;
const RAW_COLUMNS = `m.rowid AS source_row, m.thread_id, m.id AS message_id, m.at, m.kind,
    COALESCE(json_extract(m.json,'$.card.expired'),0) AS expired,
    json_extract(m.json,'$.routineRun.runId') AS run_id, json_extract(m.json,'$.routineRun.routineId') AS routine_id,
    json_array(m.thread_id,m.kind,CASE m.kind
      WHEN 'options' THEN COALESCE(json_extract(m.json,'$.card.requestId'),json_extract(m.json,'$.card.routineRequest.requestId'),json_extract(m.json,'$.card.skillRequest.requestId'),m.id)
      WHEN 'secret' THEN COALESCE(json_extract(m.json,'$.secret.requestKey'),m.id)
      WHEN 'connector' THEN COALESCE(json_extract(m.json,'$.connector.resumeKey') || ':' || json_extract(m.json,'$.connector.slug'),m.id)
      WHEN 'mcpSignIn' THEN COALESCE(json_extract(m.json,'$.mcpSignIn.resumeKey') || ':' || json_extract(m.json,'$.mcpSignIn.name'),m.id)
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
        WHEN json_type(m.json,'$.card.answered')='text' OR json_extract(m.json,'$.card.dismissed')=1 THEN 'resolved'
        -- D7: an approval whose request died with a previous process
        -- (index.ts boot sweep) is not waiting on anyone any more.
        WHEN json_extract(m.json,'$.card.orphaned')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'secret' THEN CASE WHEN json_extract(m.json,'$.secret.provided')=1 OR json_extract(m.json,'$.secret.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'connector' THEN CASE WHEN json_extract(m.json,'$.connector.status')='connected' OR json_extract(m.json,'$.connector.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      -- A link server's sign-in that ended mid-turn (MCP-LINK 3.12): owed until
      -- the owner signs in again or sets the card aside.
      WHEN 'mcpSignIn' THEN CASE WHEN json_extract(m.json,'$.mcpSignIn.status')='signed-in' OR json_extract(m.json,'$.mcpSignIn.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.goalStatus'),json_extract(m.json,'$.routineRun.status'))
      WHEN 'activity' THEN CASE WHEN json_extract(m.json,'$.actorKind')='murage' AND json_extract(m.json,'$.murage.kind')='status' AND json_type(m.json,'$.murage.digestDay')='text' THEN 'digest' ELSE 'failed' END
      WHEN 'goal.run' THEN json_extract(m.json,'$.goalRun.status') WHEN 'text' THEN 'completed' ELSE 'failed' END AS status,
    -- The projection keeps a PREVIEW (the list shows 280 characters, a digest 1000): capped in SQL so the full text of a huge message is never copied into the projection.
    substr(CASE m.kind WHEN 'activity' THEN CASE WHEN json_extract(m.json,'$.actorKind')='murage' AND json_extract(m.json,'$.murage.kind')='status' AND json_type(m.json,'$.murage.digestDay')='text' THEN COALESCE(json_extract(m.json,'$.tool.name'),'') ELSE '' END
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.summary'),json_extract(m.json,'$.routineRun.error'),'')
      WHEN 'goal.run' THEN COALESCE(json_extract(m.json,'$.goalRun.detail'),'') WHEN 'text' THEN COALESCE(json_extract(m.json,'$.text'),'Saved file')
      WHEN 'mcpSignIn' THEN COALESCE(json_extract(m.json,'$.mcpSignIn.body'),'') ELSE '' END, 1, ${PREVIEW_CHARS}) AS summary,
    substr(CASE m.kind WHEN 'options' THEN CASE
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
      WHEN 'mcpSignIn' THEN 'Sign in to ' || COALESCE(json_extract(m.json,'$.mcpSignIn.host'),'a server')
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.routineName'),'Routine result')
      WHEN 'goal.run' THEN 'Team goal result' WHEN 'text' THEN 'Saved file'
      -- A provider having a bad morning and an engine that is not signed in
      -- are not the same news, and only one of them is anybody's job.
      WHEN 'activity' THEN CASE
        WHEN json_extract(m.json,'$.actorKind')='murage' AND json_extract(m.json,'$.murage.kind')='status' AND json_type(m.json,'$.murage.digestDay')='text' THEN 'Daily digest'
        WHEN json_extract(m.json,'$.tool.authRequired')=1 THEN 'Sign in needed'
        WHEN json_extract(m.json,'$.tool.setup')=1 THEN 'Setup needed'
        ELSE 'Provider needs attention' END
      ELSE 'Provider needs attention' END, 1, ${PREVIEW_CHARS}) AS title,
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
      WHEN 'secret' THEN 'connection' WHEN 'connector' THEN 'connection' WHEN 'mcpSignIn' THEN 'connection'
      WHEN 'activity' THEN CASE WHEN json_extract(m.json,'$.actorKind')='murage' AND json_extract(m.json,'$.murage.kind')='status' AND json_type(m.json,'$.murage.digestDay')='text' THEN 'result' WHEN json_extract(m.json,'$.tool.authRequired')=1 OR json_extract(m.json,'$.tool.setup')=1 THEN 'connection' ELSE 'routine' END
      WHEN 'routine.run' THEN 'routine' WHEN 'goal.run' THEN 'routine'
      ELSE 'result' END AS kind_segment`;
/** Which messages are items at all. Damaged JSON is never an item and never
 *  blocks the write it rides on: json_valid runs before any json_extract. */
const RAW_VALID = `CASE WHEN json_valid(m.json) THEN CASE m.kind
      WHEN 'options' THEN json_type(m.json,'$.card.requestId')='text' OR json_type(m.json,'$.card.routineRequest')='object' OR json_type(m.json,'$.card.skillRequest')='object'
      WHEN 'secret' THEN json_type(m.json,'$.secret')='object'
      WHEN 'connector' THEN json_type(m.json,'$.connector')='object'
      WHEN 'mcpSignIn' THEN json_type(m.json,'$.mcpSignIn')='object'
      WHEN 'routine.run' THEN json_extract(m.json,'$.routineRun.status') NOT IN ('queued','running')
      WHEN 'goal.run' THEN json_extract(m.json,'$.goalRun.status')!='working'
      WHEN 'activity' THEN (json_extract(m.json,'$.actorKind')='murage' AND json_extract(m.json,'$.murage.kind')='status' AND json_type(m.json,'$.murage.digestDay')='text') OR (json_extract(m.json,'$.tool.ok')=0 AND (json_extract(m.json,'$.tool.setup')=1 OR json_extract(m.json,'$.tool.authRequired')=1 OR json_type(m.json,'$.tool.providerError')='object'))
      WHEN 'text' THEN json_type(m.json,'$.artifactIds[0]')='text' AND length(json_extract(m.json,'$.artifactIds[0]'))=36
    END ELSE 0 END`;
const PROJECTED_KINDS = "'options','secret','connector','mcpSignIn','routine.run','goal.run','activity','text'";
const ITEM_KINDS = "'options','secret','connector','mcpSignIn','routine.run','goal.run','activity'";
/** A copy in one of these states outranks a newer pending replay of the same item. */
const TERMINAL_SQL = "'resolved','completed','failed','cancelled','stopped','missed'";
/** The reduced rows of the messages `where` selects, ready to insert. */
const projectedRows = (where: string, source = "messages m") => `SELECT p.*, CASE WHEN p.status IN (${TERMINAL_SQL}) THEN 1 ELSE 0 END, CASE WHEN ${OWED("p.")} THEN 1 ELSE 0 END
  FROM (SELECT ${RAW_COLUMNS}
    FROM ${source} WHERE ${where} AND m.role='bot' AND m.kind IN (${PROJECTED_KINDS}) AND ${RAW_VALID}) p`;
const RAW_COLUMNS_LIST = "source_row,thread_id,message_id,at,kind,expired,run_id,routine_id,source_key,status,summary,title,kind_segment,terminal,decision";
const RAW_INSERT = `INSERT INTO inbox_raw(${RAW_COLUMNS_LIST})`;

// WHAT SETUP NEEDS FROM A CONVERSATION, kept as rows so each of its two facts
// is one index seek whatever the length of the history: a settled engine
// reply (turnTerminal; `solid` when it carries text) and a provider refusal.
// Only those messages are rows, so the table is the size of the turns and the
// refusals, never of the history. Derived data like the rest of the projection.
const MARK_CANDIDATE = (row: string) => `(instr(${row}.json,'turnTerminal')>0 OR instr(${row}.json,'providerError')>0)`;
const MARK_VALID = `CASE WHEN json_valid(m.json) THEN CASE m.kind
      WHEN 'text' THEN m.role='bot' AND json_extract(m.json,'$.turnTerminal')=1
      WHEN 'activity' THEN json_type(m.json,'$.tool.providerError')='object'
    END ELSE 0 END`;
const markRows = (where: string, source = "messages m") => `SELECT m.rowid, m.thread_id, m.id,
    CASE m.kind WHEN 'text' THEN 'reply' ELSE 'refusal' END,
    CASE WHEN m.kind='text' AND trim(COALESCE(m.text,''),char(32,9,10,11,12,13,160))<>'' THEN 1 ELSE 0 END, m.at,
    CASE WHEN m.kind='activity' THEN json_extract(m.json,'$.tool.providerError.httpStatus') END,
    CASE WHEN m.kind='activity' THEN json_extract(m.json,'$.tool.providerError.provider') END
  FROM ${source} WHERE ${where} AND m.kind IN ('text','activity') AND ${MARK_CANDIDATE("m")} AND ${MARK_VALID}`;
const MARK_COLUMNS_LIST = "source_row,thread_id,message_id,kind,solid,at,http_status,provider";
const MARK_INSERT = `INSERT INTO setup_marks(${MARK_COLUMNS_LIST})`;
/** A message row that can be an item: an Inbox kind, or a bot text that names a saved file. */
const candidate = (row: "NEW" | "OLD") => `(${row}.role='bot' AND (${row}.kind IN (${ITEM_KINDS}) OR (${row}.kind='text' AND instr(${row}.json,'artifactIds')>0)))`;

/** The projection's layout. A database holding another layout's objects has
 *  them dropped and rebuilt from its messages (they are derived data). */
// 5 (1.0.11): a routine run waiting on a card is no longer owed beside the card (RUN_ON_CARD).
const PROJECTION_VERSION = 5;
/** Index names carry the layout, so an older layout's indexes (which stay with its set-aside tables) never collide with these. */
const ix = (name: string) => `${name}_${PROJECTION_VERSION}`;

// WHAT ONE ITEM IS: its winning copy, with the owner's marks on it.
//
// TWO FLAGS, NOT ONE. A decision is owed on the first set and nothing is owed
// on the second: see the comment at the top of shared/inbox.ts for why putting
// them in one bucket made the count unreadable. The status lists live there
// too, and are spliced in below so SQL and TypeScript cannot drift apart.
//
// A RUN THAT HAS STOPPED AND IS ASKING IS NOT A NOTIFICATION.
//
// Rule 4 says a routine run never asks, and that is right about the thirty
// five rows it was written for: a run that failed, retried, or ran on a timer
// is news. It is NOT right about a run whose goal came back needs-input.
// routines.ts parks that run at status 'waiting' with "The team needs your
// input" on it, and says so in its own words: "a team asking the human a
// question is still waiting on them". Kept kind-derived and then overridden
// here, because status does not exist until this layer.
//
// WHY IT HAS TO BE A COUNTED SEGMENT. decisions counts everything owed. If an
// owed run stayed segment 'routine' it would be inside that number and inside
// no tab that can show it: the badge would say three, the three tabs would add
// to two, and the missing one would be unreachable except by scrolling the
// umbrella. That is the defect this whole redesign exists to remove,
// reintroduced by arithmetic.
//
// WHAT A SEGMENT TAB SHOWS, WHICH IS NOT THE SAME AS WHAT IT COUNTS
// (owed_or_over). The three tabs filtered on decision=1, and two kinds of
// thing that belong to them are not owed and never can be: an ENGINE THAT IS
// NOT SIGNED IN arrives as a failed activity (it needs the owner's hands, but
// it is a log line with nothing on it to resolve), and a REQUEST THAT EXPIRED
// UNATTENDED is 'missed'. A dead login reachable only by scrolling "All" is
// THE original complaint. So the tab shows both and counts only the first: the
// count stays exactly "what is waiting on you", so the three still sum to the
// umbrella; the LIST is the place a person goes to look, and it has to hold
// everything of that kind or they will look in it and conclude it is not
// there.
//
// The winning copy: a resolved copy wins over a replayed pending request with
// the same identity, then the newest. A completed run that said nothing is not
// an item at all. `live` is the clear mark: set aside until something newer
// happens to it.
const ITEM_COLUMNS = "source_key,thread_id,message_id,source_row,at,kind,expired,run_id,routine_id,status,summary,title,kind_segment,copies,decision,to_read,segment,owed_or_over,read_version,snoozed_until,cleared_at,live";
const refreshItem = (key: string) => `DELETE FROM inbox_items WHERE source_key=${key};
    INSERT INTO inbox_items(${ITEM_COLUMNS})
    SELECT h.source_key, h.thread_id, h.message_id, h.source_row, h.at, h.kind, h.expired, h.run_id, h.routine_id, h.status, h.summary, h.title, h.kind_segment, k.copies,
      CASE WHEN ${OWED("h.")} THEN 1 ELSE 0 END,
      CASE WHEN h.status IN (${TO_READ_SQL}) THEN 1 ELSE 0 END,
      CASE WHEN h.kind_segment='routine' AND ${OWED("h.")} THEN 'question' ELSE h.kind_segment END,
      CASE WHEN ${OWED("h.")} OR h.status IN (${TO_READ_SQL}) THEN 1 ELSE 0 END,
      s.read_version, s.snoozed_until, s.cleared_at,
      CASE WHEN s.cleared_at IS NULL OR h.at>s.cleared_at THEN 1 ELSE 0 END
    FROM inbox_raw h JOIN inbox_keys k ON k.source_key=h.source_key LEFT JOIN inbox_item_state s ON s.source_key=h.source_key
    WHERE h.rowid=(SELECT x.rowid FROM inbox_raw x WHERE x.source_key=${key} ORDER BY x.terminal DESC,x.at DESC,x.source_row DESC LIMIT 1)
      AND NOT(h.status='completed' AND length(trim(h.summary))=0);`;

// THE LISTS, as conditions on an item row (`p` is a trigger's NEW./OLD.).
//
// `approvals`, `questions` and `connections` show what needs the owner of that
// kind, owed or over; `decisions` is everything still owed and not expired;
// `routines` is everything a routine did (the caller rolls those up);
// `to-read` is news, a digest only until it is opened; `results` is what runs
// and saved files produced that is neither owed nor news.
type ListName = "all" | "approvals" | "decisions" | "questions" | "connections" | "routines" | "to-read" | "results";
const LISTS: readonly ListName[] = ["all", "approvals", "decisions", "questions", "connections", "routines", "to-read", "results"];
const listTerms = (list: ListName, p = ""): string[] => {
  switch (list) {
    case "all": return [];
    case "approvals": return [`${p}owed_or_over=1`, `${p}segment='approval'`];
    case "decisions": return [`${p}expired=0`, `${p}decision=1`];
    case "questions": return [`${p}owed_or_over=1`, `${p}segment='question'`];
    case "connections": return [`${p}owed_or_over=1`, `${p}segment='connection'`];
    case "routines": return [`${p}kind_segment='routine'`];
    case "to-read": return [`${p}to_read=1`, `(${p}status<>'digest' OR ${p}read_version IS NULL)`];
    // a run waiting on its card is still working, not a result: the Routines list shows it as waiting
    case "results": return [`${p}decision=0`, `${p}to_read=0`, `${p}kind IN ('routine.run','goal.run','text')`, `NOT ${RUN_ON_CARD(p)}`];
  }
};
const ident = (list: ListName) => list.replace("-", "_");
/** A list's terms, with the clear mark when `live`. Never empty: SQL wants a condition. */
const listWhere = (list: ListName, live: boolean, p = "") => [...listTerms(list, p), ...(live ? [`${p}live=1`] : [])].join(" AND ") || "1";
const listIndex = (list: ListName, live: boolean) => ix(`inbox_items_${live ? "l" : "v"}_${ident(list)}`);

// THE BADGES. Reading a request never removes it from the decisions count,
// because reading is not answering; reading DOES clear it from the to-read
// count, because there reading is the whole action. Never opened, rather than
// "not current", for to-read: the read mark is a hash of the message computed
// in JS, and SQL cannot recompute it, so an item that was read and has since
// changed is counted as read. Erring that way keeps the badge quiet rather
// than crying wolf. `owed_open` is owedThreads: owed and unexpired, whatever
// the marks say.
const BADGES = (p = "") => ({
  o_approvals: `${p}decision=1 AND ${p}segment='approval' AND ${p}live=1`,
  o_questions: `${p}decision=1 AND ${p}segment='question' AND ${p}live=1`,
  o_connections: `${p}decision=1 AND ${p}segment='connection' AND ${p}live=1`,
  o_decisions: `${p}decision=1 AND ${p}live=1`,
  o_unread: `${p}to_read=1 AND ${p}read_version IS NULL AND ${p}live=1`,
  owed_open: `${p}decision=1 AND ${p}expired=0`,
});
/** Every counter kept per conversation: each list with and without the clear mark, and each badge. */
const COUNTERS = (p = ""): Array<[string, string]> => [
  ...LISTS.map((list): [string, string] => [`v_${ident(list)}`, listWhere(list, false, p)]),
  ...LISTS.map((list): [string, string] => [`l_${ident(list)}`, listWhere(list, true, p)]),
  ...Object.entries(BADGES(p)),
];
const bump = (p: "NEW." | "OLD.", sign: "+" | "-") => COUNTERS(p).map(([name, condition]) => `${name}=${name}${sign}(CASE WHEN ${condition} THEN 1 ELSE 0 END)`).join(",\n      ");

// NO STATEMENT IN THESE TRIGGERS CAN CONFLICT. A trigger's statements take the
// conflict policy of the statement that fired it, and messages are written
// with INSERT OR REPLACE: an inner "insert or ignore" or upsert would become a
// REPLACE and silently reset a counter row. So every insert here is guarded by
// NOT EXISTS or follows the delete of the same key.

/** Messages triggers, and the projection's own. Listed so an old layout can be dropped whole. */
const PROJECTION_TRIGGERS = ["inbox_project_insert", "inbox_project_update", "inbox_project_delete", "inbox_raw_added", "inbox_raw_removed",
  "inbox_state_added", "inbox_state_changed", "inbox_state_removed", "inbox_item_added", "inbox_item_removed",
  "setup_marks_insert", "setup_marks_update", "setup_marks_delete", "inbox_deferred_removed", "inbox_deferred_updated", "inbox_deferred_reinserted",
  // the first layout's
  "inbox_raw_counted", "inbox_raw_uncounted"];
const PROJECTION_TABLES = ["inbox_counts", "inbox_items", "inbox_keys", "inbox_raw", "inbox_projection_state", "setup_marks", "inbox_fill_deferred"];
/** Whether a schema object belongs to the projection (derived data, discarded at restore, so its text is never compared). */
export function isInboxProjectionObject(item: { type: string; name: string; tbl_name: string }): boolean {
  return PROJECTION_TABLES.includes(item.tbl_name) || RETIRED_TABLE.test(item.tbl_name) || (item.type === "trigger" && PROJECTION_TRIGGERS.includes(item.name));
}

const PROJECTION_DDL = `CREATE TABLE IF NOT EXISTS inbox_raw(thread_id TEXT NOT NULL, message_id TEXT NOT NULL, source_row INTEGER NOT NULL, at INTEGER NOT NULL,
    kind TEXT NOT NULL, expired INTEGER NOT NULL, run_id, routine_id, source_key TEXT NOT NULL, status TEXT, summary TEXT, title TEXT,
    kind_segment TEXT NOT NULL, terminal INTEGER NOT NULL, decision INTEGER NOT NULL, PRIMARY KEY(thread_id,message_id));
  CREATE INDEX IF NOT EXISTS ${ix("inbox_raw_rank")} ON inbox_raw(source_key,terminal DESC,at DESC,source_row DESC);
  CREATE TABLE IF NOT EXISTS inbox_keys(source_key TEXT PRIMARY KEY, copies INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS inbox_items(source_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, message_id TEXT NOT NULL, source_row INTEGER NOT NULL,
    at INTEGER NOT NULL, kind TEXT NOT NULL, expired INTEGER NOT NULL, run_id, routine_id, status TEXT, summary TEXT, title TEXT, kind_segment TEXT NOT NULL,
    copies INTEGER NOT NULL, decision INTEGER NOT NULL, to_read INTEGER NOT NULL, segment TEXT NOT NULL, owed_or_over INTEGER NOT NULL,
    read_version TEXT, snoozed_until INTEGER, cleared_at INTEGER, live INTEGER NOT NULL);
  ${LISTS.flatMap(list => [false, true].map(live => {
    const where = listWhere(list, live);
    return `CREATE INDEX IF NOT EXISTS ${listIndex(list, live)} ON inbox_items(decision DESC,at DESC,source_key)${where === "1" ? "" : ` WHERE ${where}`};`;
  })).join("\n  ")}
  CREATE INDEX IF NOT EXISTS ${ix("inbox_items_routine_at")} ON inbox_items(at) WHERE kind_segment='routine';
  CREATE INDEX IF NOT EXISTS ${ix("inbox_items_snoozed")} ON inbox_items(snoozed_until) WHERE snoozed_until IS NOT NULL;
  CREATE TABLE IF NOT EXISTS inbox_counts(thread_id TEXT PRIMARY KEY, ${COUNTERS().map(([name]) => `${name} INTEGER NOT NULL DEFAULT 0`).join(", ")}) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS inbox_projection_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS setup_marks(source_row INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL, solid INTEGER NOT NULL, at INTEGER NOT NULL, http_status, provider);
  CREATE INDEX IF NOT EXISTS ${ix("setup_marks_message")} ON setup_marks(thread_id,message_id);
  CREATE INDEX IF NOT EXISTS ${ix("setup_marks_tail")} ON setup_marks(thread_id,kind,at DESC,source_row DESC);
  CREATE INDEX IF NOT EXISTS ${ix("setup_marks_solid")} ON setup_marks(thread_id,kind,solid);
  CREATE TABLE IF NOT EXISTS inbox_fill_deferred(source_row INTEGER PRIMARY KEY, thread_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS ${ix("inbox_fill_deferred_thread")} ON inbox_fill_deferred(thread_id);
  CREATE TRIGGER IF NOT EXISTS inbox_deferred_removed AFTER DELETE ON messages BEGIN
    DELETE FROM inbox_fill_deferred WHERE source_row=OLD.rowid;
  END;
  -- A write to a deferred row projects it (the triggers below) and so settles its entry: the worker's staged copy of the old content is then stale, and the entry's absence is how its guard knows.
  -- A fresh insert at a rowid (INSERT OR REPLACE reuses the rowid of the row it replaced without firing delete triggers) means any older deferred entry for that rowid is stale.
  CREATE TRIGGER IF NOT EXISTS inbox_deferred_reinserted AFTER INSERT ON messages BEGIN
    DELETE FROM inbox_fill_deferred WHERE source_row=NEW.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS inbox_deferred_updated AFTER UPDATE ON messages BEGIN
    DELETE FROM inbox_fill_deferred WHERE source_row=OLD.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS setup_marks_insert AFTER INSERT ON messages BEGIN
    DELETE FROM setup_marks WHERE thread_id=NEW.thread_id AND message_id=NEW.id;
    ${MARK_INSERT} ${markRows("m.rowid=NEW.rowid")};
  END;
  CREATE TRIGGER IF NOT EXISTS setup_marks_update AFTER UPDATE ON messages WHEN ${MARK_CANDIDATE("OLD")} OR ${MARK_CANDIDATE("NEW")} BEGIN
    DELETE FROM setup_marks WHERE thread_id=OLD.thread_id AND message_id=OLD.id;
    ${MARK_INSERT} ${markRows("m.rowid=NEW.rowid")};
  END;
  CREATE TRIGGER IF NOT EXISTS setup_marks_delete AFTER DELETE ON messages WHEN ${MARK_CANDIDATE("OLD")} BEGIN
    DELETE FROM setup_marks WHERE thread_id=OLD.thread_id AND message_id=OLD.id;
  END;
  CREATE TRIGGER IF NOT EXISTS inbox_raw_added AFTER INSERT ON inbox_raw BEGIN
    UPDATE inbox_keys SET copies=copies+1 WHERE source_key=NEW.source_key;
    INSERT INTO inbox_keys(source_key,copies) SELECT NEW.source_key,1 WHERE NOT EXISTS (SELECT 1 FROM inbox_keys WHERE source_key=NEW.source_key);
    ${refreshItem("NEW.source_key")}
  END;
  CREATE TRIGGER IF NOT EXISTS inbox_raw_removed AFTER DELETE ON inbox_raw BEGIN
    UPDATE inbox_keys SET copies=copies-1 WHERE source_key=OLD.source_key;
    DELETE FROM inbox_keys WHERE source_key=OLD.source_key AND copies<=0;
    ${refreshItem("OLD.source_key")}
  END;
  CREATE TRIGGER IF NOT EXISTS inbox_state_added AFTER INSERT ON inbox_item_state BEGIN ${refreshItem("NEW.source_key")} END;
  CREATE TRIGGER IF NOT EXISTS inbox_state_changed AFTER UPDATE ON inbox_item_state BEGIN ${refreshItem("NEW.source_key")} END;
  CREATE TRIGGER IF NOT EXISTS inbox_state_removed AFTER DELETE ON inbox_item_state BEGIN ${refreshItem("OLD.source_key")} END;
  CREATE TRIGGER IF NOT EXISTS inbox_item_added AFTER INSERT ON inbox_items BEGIN
    INSERT INTO inbox_counts(thread_id) SELECT NEW.thread_id WHERE NOT EXISTS (SELECT 1 FROM inbox_counts WHERE thread_id=NEW.thread_id);
    UPDATE inbox_counts SET ${bump("NEW.", "+")} WHERE thread_id=NEW.thread_id;
  END;
  CREATE TRIGGER IF NOT EXISTS inbox_item_removed AFTER DELETE ON inbox_items BEGIN
    UPDATE inbox_counts SET ${bump("OLD.", "-")} WHERE thread_id=OLD.thread_id;
    DELETE FROM inbox_counts WHERE thread_id=OLD.thread_id AND v_all<=0;
  END;
  CREATE TRIGGER IF NOT EXISTS inbox_project_insert AFTER INSERT ON messages BEGIN
    DELETE FROM inbox_raw WHERE thread_id=NEW.thread_id AND message_id=NEW.id;
    ${RAW_INSERT} ${projectedRows("m.rowid=NEW.rowid")};
  END;
  CREATE TRIGGER IF NOT EXISTS inbox_project_update AFTER UPDATE ON messages WHEN ${candidate("OLD")} OR ${candidate("NEW")} BEGIN
    DELETE FROM inbox_raw WHERE thread_id=OLD.thread_id AND message_id=OLD.id;
    ${RAW_INSERT} ${projectedRows("m.rowid=NEW.rowid")};
  END;
  CREATE TRIGGER IF NOT EXISTS inbox_project_delete AFTER DELETE ON messages WHEN ${candidate("OLD")} BEGIN
    DELETE FROM inbox_raw WHERE thread_id=OLD.thread_id AND message_id=OLD.id;
  END;`;

/** The projection tables a layout change sets aside (inbox_projection_state is the layout's own marker: it stays). */
const RETIRABLE_TABLES = ["inbox_counts", "inbox_items", "inbox_keys", "inbox_raw", "setup_marks", "inbox_fill_deferred"];
/** What a set-aside table is called: the layout it held, then its name. */
const RETIRED_TABLE = /^retired\d+_(inbox_counts|inbox_items|inbox_keys|inbox_raw|setup_marks|inbox_fill_deferred)$/;
const tableExists = (db: DatabaseSync, name: string) => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined;
const retiredTables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'retired%'").all() as Array<{ name: string }>).map(row => row.name).filter(name => RETIRED_TABLE.test(name));

/** Remove every projection object, set-aside tables included (triggers first:
 *  the messages triggers write into the tables). Dropping fires no triggers,
 *  but the pages of a large table are freed, so this is for a restored archive
 *  and never for a start. */
function dropInboxProjection(db: DatabaseSync): void {
  for (const trigger of PROJECTION_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of [...PROJECTION_TABLES, ...retiredTables(db)]) db.exec(`DROP TABLE IF EXISTS ${table}`);
}

/** Take another layout out of the way at a start, doing no work that grows
 *  with the history: its triggers are dropped (they cost nothing to drop) and
 *  its tables, with their indexes, are renamed (a schema edit). Their rows are
 *  freed later, in slices, by the background loop (reclaimRetiredInboxProjection),
 *  never before the server listens. The layout marker table is kept and
 *  cleared; the next layout is created empty under the usual names. */
function retireInboxProjection(db: DatabaseSync, layout: number | undefined): void {
  for (const trigger of PROJECTION_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of RETIRABLE_TABLES) {
    if (!tableExists(db, table)) continue;
    const to = `retired${layout ?? 0}_${table}`;
    if (tableExists(db, to)) db.exec(`DROP TABLE ${to}`);
    db.exec(`ALTER TABLE ${table} RENAME TO ${to}`);
  }
  if (tableExists(db, "inbox_projection_state")) db.exec("DELETE FROM inbox_projection_state");
}

/** The highest message rowid that existed when the fill began. Rows above it
 *  are projected by the triggers from then on, so what the projection says
 *  about them is complete; null when it was not recorded. */
export function inboxProjectionHighWater(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT cursor FROM inbox_projection_state WHERE name='high'").get() as { cursor: number } | undefined;
  return row ? row.cursor : null;
}
/** Where the first fill stands: its cursor and the high-water rowid; null when the high-water was not recorded. */
export function inboxProjectionPosition(db: DatabaseSync): { cursor: number; high: number } | null {
  const rows = db.prepare("SELECT name, cursor FROM inbox_projection_state WHERE name IN ('inbox','high')").all() as Array<{ name: string; cursor: number }>;
  const high = rows.find(row => row.name === "high");
  return high ? { cursor: rows.find(row => row.name === "inbox")?.cursor ?? 0, high: high.cursor } : null;
}
const recordHighWater = (db: DatabaseSync) => db.prepare("INSERT OR REPLACE INTO inbox_projection_state(name,done,cursor) SELECT 'high',1,COALESCE(max(rowid),0) FROM messages").run();

/** Create the projection (or set another layout's aside and create this one).
 *  Never reads the history: an installation that has messages from before the
 *  projection existed is filled after the server listens
 *  (startInboxProjectionFill), and the Inbox says it is getting ready until
 *  then. A new installation has nothing to fill and is ready at once.
 *
 *  ONE TRANSACTION, AND SELF-REPAIRING. Setting the old layout aside, creating
 *  the new one and writing the markers commit together, so an interruption
 *  leaves either the old state or the finished one. Independently of that, a
 *  missing fill marker is written whenever it is found missing (a database
 *  interrupted by an earlier build of this code, or edited by hand), whatever
 *  the layout marker says: the fill is resumable from its cursor and keeps
 *  whatever the triggers already projected, so repairing it can only cost time.
 *  The fill marker is written with the high-water rowid (see
 *  inboxProjectionHighWater), in the same transaction as the triggers. */
function createInboxProjection(db: DatabaseSync): void {
  db.exec("SAVEPOINT inbox_projection_init");
  try {
    const layout = tableExists(db, "inbox_projection_state")
      ? (db.prepare("SELECT cursor FROM inbox_projection_state WHERE name='layout'").get() as { cursor: number } | undefined)?.cursor
      : undefined;
    const fresh = layout !== PROJECTION_VERSION;
    if (fresh) retireInboxProjection(db, layout);
    db.exec(PROJECTION_DDL);
    if (fresh) db.prepare("INSERT OR REPLACE INTO inbox_projection_state(name,done,cursor) VALUES('layout',1,?)").run(PROJECTION_VERSION);
    const marker = db.prepare("SELECT 1 FROM inbox_projection_state WHERE name='inbox'").get() !== undefined;
    if (fresh || !marker) {
      const empty = db.prepare("SELECT 1 FROM messages LIMIT 1").get() === undefined;
      db.prepare("INSERT OR REPLACE INTO inbox_projection_state(name,done,cursor) VALUES('inbox',?,0)").run(empty ? 1 : 0);
      recordHighWater(db);
    }
    db.exec("RELEASE inbox_projection_init");
  } catch (error) {
    try { db.exec("ROLLBACK TO inbox_projection_init; RELEASE inbox_projection_init"); } catch { /* the connection is gone: nothing was committed */ }
    throw error;
  }
}

interface ProjectionState { done: number; cursor: number }
function projectionState(db: DatabaseSync): ProjectionState {
  return (db.prepare("SELECT done, cursor FROM inbox_projection_state WHERE name='inbox'").get() as ProjectionState | undefined) ?? { done: 0, cursor: 0 };
}
const ready = new WeakSet<DatabaseSync>();
/** Whether the projection holds every message: until then the Inbox says it
 *  is getting ready rather than showing part of the history as all of it. */
export function inboxProjectionReady(db: DatabaseSync): boolean {
  if (ready.has(db)) return true;
  if (!tableExists(db, "inbox_projection_state") || projectionState(db).done !== 1) return false;
  ready.add(db);
  return true;
}

/** What a row costs beyond its bytes: the statement, the index entries, the triggers. */
const SLICE_ROW_WEIGHT = 256;
const SLICE_MAX_ROWS = 10_000;
/** A row weighs its bytes (from the record header alone) plus a fixed amount. The fill's statements and the sizing rule use this one text. */
const ROW_WEIGHT_SQL = `octet_length(m.json)+${SLICE_ROW_WEIGHT}`;
/** The budget stands for "no budget" in the row-count form of a slice. */
const NO_BUDGET = Number.MAX_SAFE_INTEGER;

/** The fill's statements. `NOT INDEXED` is deliberate: without statistics the
 *  planner prefers the (role, kind) index over the rowid range the slice is
 *  written for, and every slice then walks every bot message in the database.
 *  The triggers' own statements address one rowid and are left alone.
 *
 *  Parameters: (after, up to, budget). The last term, right after the rowid
 *  range and header-only like the sizing rule's, keeps the statement away from
 *  the content of a row the budget cannot admit: that row is deferred
 *  (inbox_fill_deferred) and projected off the main thread. */
export const INBOX_FILL_SQL = {
  raw: `${RAW_INSERT.replace("INSERT INTO", "INSERT OR IGNORE INTO")} ${projectedRows(`m.rowid>? AND m.rowid<=? AND ${ROW_WEIGHT_SQL}<=?`, "messages m NOT INDEXED")}`,
  marks: `${MARK_INSERT.replace("INSERT INTO", "INSERT OR IGNORE INTO")} ${markRows(`m.rowid>? AND m.rowid<=? AND ${ROW_WEIGHT_SQL}<=?`, "messages m NOT INDEXED")}`,
};
/** The same projection for ONE conversation's rows in (after, up to], through messages_thread (the Chief's threads are completed first).
 *  Parameters: (thread, after, up to, budget). */
export const INBOX_THREAD_FILL_SQL = {
  raw: `${RAW_INSERT.replace("INSERT INTO", "INSERT OR IGNORE INTO")} ${projectedRows(`m.thread_id=? AND m.rowid>? AND m.rowid<=? AND ${ROW_WEIGHT_SQL}<=?`, "messages m INDEXED BY messages_thread")}`,
  marks: `${MARK_INSERT.replace("INSERT INTO", "INSERT OR IGNORE INTO")} ${markRows(`m.thread_id=? AND m.rowid>? AND m.rowid<=? AND ${ROW_WEIGHT_SQL}<=?`, "messages m INDEXED BY messages_thread")}`,
};
/** The deferred rows' projection. The staging statements parse the row and run OUTSIDE the writer lock into connection-private temp tables;
 *  the apply statements inside the lock only move the staged rows, and the guard (header-only) says the staging still describes the row. */
export const INBOX_DEFERRED_SQL: InboxDeferredSql = {
  setup: `CREATE TEMP TABLE IF NOT EXISTS inbox_stage_raw AS SELECT ${RAW_COLUMNS_LIST} FROM main.inbox_raw WHERE 0;
    CREATE TEMP TABLE IF NOT EXISTS inbox_stage_marks AS SELECT ${MARK_COLUMNS_LIST} FROM main.setup_marks WHERE 0;`,
  clear: ["DELETE FROM temp.inbox_stage_raw", "DELETE FROM temp.inbox_stage_marks"],
  stageRaw: `INSERT INTO temp.inbox_stage_raw(${RAW_COLUMNS_LIST}) ${projectedRows("m.rowid=?")}`,
  stageMarks: `INSERT INTO temp.inbox_stage_marks(${MARK_COLUMNS_LIST}) ${markRows("m.rowid=?")}`,
  applyRaw: `INSERT OR IGNORE INTO main.inbox_raw(${RAW_COLUMNS_LIST}) SELECT ${RAW_COLUMNS_LIST} FROM temp.inbox_stage_raw`,
  applyMarks: `INSERT OR IGNORE INTO main.setup_marks(${MARK_COLUMNS_LIST}) SELECT ${MARK_COLUMNS_LIST} FROM temp.inbox_stage_marks`,
  guard: "SELECT 1 FROM inbox_fill_deferred d JOIN messages m ON m.rowid=d.source_row WHERE d.source_row=?1 AND m.thread_id=?2 AND m.id=?3 AND octet_length(m.json)=?4",
};
export interface InboxSlice { finished: boolean; rows: number; weight: number; /** Nothing follows the cursor, but deferred rows are still to be projected ("priority": a priority conversation waits only on its own deferred rows). */ deferred?: true | "priority" }

/** Rows whose sizes one sizing step reads. */
const SIZING_STEP_ROWS = 16;
/** The rows a byte budget admits, from the SIZE of each row alone.
 *
 *  octet_length(json) is answered from the record header (the serial type of
 *  the column), so a row's size costs the same whether the row is 32 KiB or
 *  2 MiB: server/inbox.slice-sizing.test.ts measures that against length(json)
 *  and length(CAST(json AS BLOB)), which both read the content. The window is
 *  walked in small steps and the walk stops as soon as the next row does not fit.
 *
 *  A row heavier than the whole budget is DEFERRED, wherever it sits, the
 *  first included: it is never read here. Any other row is admitted while the
 *  total so far plus its weight stays within the budget, so a slice reads at
 *  most the budget. */
function sizeSlice(db: DatabaseSync, cursor: number, cap: number, budget: number, scope?: { thread: string; high: number }): { upper: number | null; rows: number; weight: number; deferred: Array<{ r: number; t: string }> } {
  const step = scope
    ? db.prepare(`SELECT rowid AS r, thread_id AS t, octet_length(json)+${SLICE_ROW_WEIGHT} AS l FROM messages INDEXED BY messages_thread WHERE thread_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`)
    : db.prepare(`SELECT rowid AS r, thread_id AS t, octet_length(json)+${SLICE_ROW_WEIGHT} AS l FROM messages WHERE rowid>? ORDER BY rowid LIMIT ?`);
  let at = cursor, upper: number | null = null, rows = 0, weight = 0, full = false;
  const deferred: Array<{ r: number; t: string }> = [];
  while (rows < cap && !full) {
    const batch = (scope ? step.all(scope.thread, at, scope.high, Math.min(SIZING_STEP_ROWS, cap - rows)) : step.all(at, Math.min(SIZING_STEP_ROWS, cap - rows))) as Array<{ r: number; t: string; l: number }>;
    if (batch.length === 0) break;
    for (const row of batch) {
      if (row.l > budget) deferred.push({ r: row.r, t: row.t });
      else if (weight + row.l > budget) { full = true; break; }
      else weight += row.l;
      upper = row.r; at = row.r; rows++;
    }
  }
  return { upper, rows, weight, deferred };
}

/** The per-conversation completion marker: inbox_projection_state 't:<thread>', done=1 once every row of the
 *  conversation up to the high-water rowid is projected and none of it waits in inbox_fill_deferred. */
export const threadFillName = (threadId: string) => `t:${threadId}`;

/** THE CHIEF'S CONVERSATIONS FIRST. Before the unrelated history, the fill completes the conversations it is told
 *  matter to setup: their rows in (cursor, high] by the messages_thread index, in the same bounded slices (the
 *  same budget, the same deferral of rows the budget cannot admit), then their deferred rows. A finished
 *  conversation is marked, so its setup facts are KNOWN by one primary-key probe, whatever the length of the
 *  rest of the history. Runs inside the caller's transaction. `slice` is set when this call did the slice's work. */
function prioritySlice(db: DatabaseSync, state: ProjectionState, limit: { rows: number; weight?: number }, priority: readonly string[]): { slice: InboxSlice | null; completed: boolean } {
  const high = inboxProjectionPosition(db)?.high;
  if (high === undefined || limit.weight === undefined) return { slice: null, completed: false };
  const get = db.prepare("SELECT done, cursor FROM inbox_projection_state WHERE name=?");
  const budget = limit.weight;
  const cap = Math.max(1, Math.min(Math.trunc(limit.rows), SLICE_MAX_ROWS, Math.ceil(budget / SLICE_ROW_WEIGHT)));
  let completed = false;
  for (const thread of priority) {
    const name = threadFillName(thread);
    let mark = get.get(name) as { done: number; cursor: number } | undefined;
    if (!mark) { db.prepare("INSERT OR IGNORE INTO inbox_projection_state(name,done,cursor) VALUES(?,0,?)").run(name, state.cursor); mark = { done: 0, cursor: state.cursor }; }
    if (mark.done === 1) continue;
    const from = Math.max(mark.cursor, state.cursor);
    const sized = sizeSlice(db, from, cap, budget, { thread, high });
    if (typeof sized.upper === "number") {
      const defer = db.prepare("INSERT OR IGNORE INTO inbox_fill_deferred(source_row,thread_id) VALUES(?,?)");
      for (const row of sized.deferred) defer.run(row.r, row.t);
      db.prepare(INBOX_THREAD_FILL_SQL.raw).run(thread, from, sized.upper, budget);
      db.prepare(INBOX_THREAD_FILL_SQL.marks).run(thread, from, sized.upper, budget);
      db.prepare("UPDATE inbox_projection_state SET cursor=? WHERE name=?").run(sized.upper, name);
      return { slice: { finished: false, rows: sized.rows, weight: sized.weight }, completed };
    }
    if (db.prepare("SELECT 1 FROM inbox_fill_deferred WHERE thread_id=? LIMIT 1").get(thread) !== undefined) {
      return { slice: { finished: false, rows: 0, weight: 0, deferred: "priority" }, completed };
    }
    db.prepare("UPDATE inbox_projection_state SET done=1 WHERE name=?").run(name);
    completed = true;
  }
  return { slice: null, completed };
}

/** One slice of the first fill: the messages after the cursor by storage
 *  position, up to `rows` of them and, when given, up to `weight` (their bytes
 *  plus a fixed amount per row: the cost of a slice follows bytes, not rows),
 *  committed with the cursor so an interrupted fill resumes where it was. A
 *  row the triggers already projected (written since) is kept as they wrote
 *  it. A missing fill marker is written first, so the fill always has a
 *  cursor to advance.
 *
 *  With a weight, a row heavier than the budget is not read: its rowid goes to
 *  inbox_fill_deferred in this same transaction and the cursor passes it. The
 *  fill is finished only when nothing follows the cursor AND that table is
 *  empty; until then the slice reports `deferred` (see drainInboxDeferred). */
export function inboxProjectionSlice(db: DatabaseSync, limit: { rows: number; weight?: number }, priority: readonly string[] = []): InboxSlice {
  if (tableExists(db, "inbox_projection_state") && projectionState(db).done) return { finished: true, rows: 0, weight: 0 };
  let result: InboxSlice = { finished: false, rows: 0, weight: 0 };
  let completedAny = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (Number(db.prepare("INSERT OR IGNORE INTO inbox_projection_state(name,done,cursor) VALUES('inbox',0,0)").run().changes) > 0) recordHighWater(db);
    const state = projectionState(db);
    if (limit.weight !== undefined && priority.length > 0) {
      const first = prioritySlice(db, state, limit, priority);
      if (first.slice) { db.exec("COMMIT"); if (first.completed) bumpMessagesVersion(); return first.slice; }
      if (first.completed) completedAny = true;
    }
    let upper: number | null | undefined, rows = 0, weight = 0, budget = NO_BUDGET, diverted: Array<{ r: number; t: string }> = [];
    if (limit.weight === undefined) {
      upper = (db.prepare("SELECT max(r) AS r FROM (SELECT rowid AS r FROM messages WHERE rowid>? ORDER BY rowid LIMIT ?)").get(state.cursor, Math.max(1, Math.trunc(limit.rows))) as { r: number | null } | undefined)?.r;
    } else {
      // Every row weighs at least SLICE_ROW_WEIGHT, so the budget never admits more rows than this.
      const cap = Math.max(1, Math.min(Math.trunc(limit.rows), SLICE_MAX_ROWS, Math.ceil(limit.weight / SLICE_ROW_WEIGHT)));
      budget = limit.weight;
      ({ upper, rows, weight, deferred: diverted } = sizeSlice(db, state.cursor, cap, budget));
    }
    if (typeof upper === "number") {
      if (diverted.length > 0) {
        const defer = db.prepare("INSERT OR IGNORE INTO inbox_fill_deferred(source_row,thread_id) VALUES(?,?)");
        for (const row of diverted) defer.run(row.r, row.t);
      }
      db.prepare(INBOX_FILL_SQL.raw).run(state.cursor, upper, budget);
      db.prepare(INBOX_FILL_SQL.marks).run(state.cursor, upper, budget);
      db.prepare("UPDATE inbox_projection_state SET cursor=? WHERE name='inbox'").run(upper);
      result = { finished: false, rows, weight };
    } else if (db.prepare("SELECT 1 FROM inbox_fill_deferred LIMIT 1").get() !== undefined) {
      result = { finished: false, rows: 0, weight: 0, deferred: true };
    } else {
      db.prepare("UPDATE inbox_projection_state SET done=1 WHERE name='inbox'").run();
      result = { finished: true, rows: 0, weight: 0 };
    }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  // Every held answer was "getting ready": drop them and tell the pollers.
  if (result.finished || completedAny) bumpMessagesVersion();
  return result;
}

/** Project every deferred row here, on this connection. For tools, tests and a
 *  database with no file; the server drains them on a worker (startInboxProjectionFill). */
export function drainInboxDeferredInline(db: DatabaseSync, options: { priorityOnly?: boolean } = {}): void {
  const drain = inboxDeferredDrain(db, INBOX_DEFERRED_SQL, options);
  while (drain.step()) { /* next row */ }
}

/** Row-count form of one slice. Returns true once everything is projected. */
export function inboxProjectionStep(db: DatabaseSync, rows: number): boolean {
  const slice = inboxProjectionSlice(db, { rows });
  if (slice.deferred) drainInboxDeferredInline(db);
  return slice.finished;
}

/** The whole first fill at once. For tools and tests; the server uses startInboxProjectionFill. */
export function fillInboxProjection(db: DatabaseSync): void {
  while (!inboxProjectionStep(db, 20_000)) { /* next slice */ }
}

/** Slice length the background fill aims for, and never far over. */
export const INBOX_FILL_TARGET_MS = 20;
export const INBOX_FILL_PAUSE_MS = 5;
/** While an owner turn is live the fill slows, it never stops. */
export const INBOX_FILL_BUSY_PAUSE_MS = 250;
/** While an owner turn is live the freeing of an older layout waits: it is not owed to anyone. */
export const INBOX_RECLAIM_BUSY_PAUSE_MS = 2_000;
const DEFERRED_WORKER_MEMORY_MB = 512;
const FILL_START_WEIGHT = 64 * 1024, FILL_MIN_WEIGHT = 4 * 1024, FILL_MAX_WEIGHT = 512 * 1024, FILL_GROWTH = 1.5;
/** Rows freed per statement while reclaiming, and the time a reclaim slice may take. */
const RECLAIM_CHUNK_ROWS = 100;
const RECLAIM_TARGET_MS = 15;
/** How each set-aside table names a row: by rowid, or by its primary key when it has none. */
const RECLAIM_KEY: Record<string, string> = { inbox_raw: "rowid", inbox_items: "rowid", setup_marks: "rowid", inbox_fill_deferred: "rowid", inbox_keys: "source_key", inbox_counts: "thread_id" };

/** Free some of an older layout's set-aside tables: rows in small chunks for
 *  about RECLAIM_TARGET_MS, one transaction, and the table itself once it is
 *  empty. Takes the writer lock without waiting (a busy database is retried
 *  later by the loop), and never runs before the server listens. Returns
 *  whether any set-aside table remains. */
export function reclaimRetiredInboxProjection(db: DatabaseSync, targetMs = RECLAIM_TARGET_MS): boolean {
  const tables = retiredTables(db);
  if (tables.length === 0) return false;
  const waited = (db.prepare("PRAGMA busy_timeout").get() as { timeout: number } | undefined)?.timeout ?? 0;
  db.exec("PRAGMA busy_timeout=0");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const until = performance.now() + targetMs;
      for (const table of tables) {
        const key = RECLAIM_KEY[table.replace(/^retired\d+_/, "")] ?? "rowid";
        const remove = db.prepare(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} LIMIT ?)`);
        while (performance.now() < until) {
          if (Number(remove.run(RECLAIM_CHUNK_ROWS).changes) === 0) break;
        }
        if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() === undefined) db.exec(`DROP TABLE ${table}`);
        if (performance.now() >= until) break;
      }
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  } finally { try { db.exec(`PRAGMA busy_timeout=${Math.trunc(waited)}`); } catch { /* closed */ } }
  return retiredTables(db).length > 0;
}

export interface InboxProjectionFill { done: Promise<{ filled: boolean }>; stop(): void; stats: { slices: number; maxSliceMs: number; reclaimSlices: number; maxReclaimMs: number } }

/** The first fill, after the server listens: short writer transactions sized
 *  by measured cost, with the event loop handed back between them on a real
 *  timer. A slice is bounded by BYTES (plus a fixed amount per row), because
 *  that is what it costs: a stretch of large tool outputs after a stretch of
 *  short chat lines would otherwise authorise one slice far over the limit on
 *  the strength of the cheap ones before it. The size of a slice is worked out
 *  from the rows' record headers (sizeSlice), so even choosing the slice reads
 *  no content. The cost per unit is the worst of
 *  the last slice and a slowly fading memory of earlier ones, the budget grows
 *  by at most half per slice, and it has a hard ceiling (512 KiB: about 30 ms
 *  even on a 17 MB/s disk, whatever the earlier slices cost). The owner comes
 *  first: `admit` (the writer gate) is awaited before each slice, and while an
 *  owner turn is live the pause is longer. A lock held elsewhere retries
 *  later; any other failure stops the run quietly and the next start carries
 *  on from the saved cursor.
 *
 *  AFTER THE FILL (or at once, when it was already done) the same loop frees
 *  the tables of an older layout that the start set aside, in slices of about
 *  15 ms, only while no owner turn is live, without waiting for a lock. */
export function startInboxProjectionFill(db: DatabaseSync, options: { busy?: () => boolean; admit?: () => Promise<void>; targetMs?: number; onError?: (error: unknown) => void; /** The conversations setup depends on (the Chief's): completed before the unrelated history. */ priorityThreads?: () => readonly string[] } = {}): InboxProjectionFill {
  const target = options.targetMs ?? INBOX_FILL_TARGET_MS;
  const stats = { slices: 0, maxSliceMs: 0, reclaimSlices: 0, maxReclaimMs: 0 };
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, resolve!: (value: { filled: boolean }) => void;
  const done = new Promise<{ filled: boolean }>(r => { resolve = r; });
  let filling = !inboxProjectionReady(db), filled = false;
  if (!filling && retiredTables(db).length === 0) { resolve({ filled: false }); return { done, stop() {}, stats }; }
  let budget = FILL_START_WEIGHT, rate = 0;
  let worker: Worker | undefined;
  const finish = (result: boolean) => { stopped = true; if (timer) clearTimeout(timer); void worker?.terminate(); resolve({ filled: result }); };
  /** Project the deferred rows on a worker and wait for its one "drained" message (no polling).
   *  An in-memory database has no file for a worker to open: it drains here (tests and tools only). */
  const drainDeferred = (priorityOnly: boolean): Promise<void> => new Promise<void>((done, fail) => {
    const file = (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")?.file;
    if (!file) { try { drainInboxDeferredInline(db, { priorityOnly }); done(); } catch (error) { fail(error); } return; }
    const spawned = new Worker(SPAWNED_PROXIES.inboxFillWorker, { workerData: { kind: "inbox-fill", file, sql: INBOX_DEFERRED_SQL, priorityOnly, maxHoldMs: INBOX_FILL_MAX_HOLD_MS }, resourceLimits: { maxOldGenerationSizeMb: DEFERRED_WORKER_MEMORY_MB } });
    worker = spawned;
    spawned.on("message", (message: { type: string; message?: string; ms?: number; size?: number; more?: number }) => {
      // one deferred row's write held the lock past INBOX_FILL_MAX_HOLD_MS (the worker reports at most one per INBOX_SLOW_ROW_REPORT_MS)
      if (message.type === "slow-row") { observeLine(`[inbox] fill slow-row ms=${Math.round(Number(message.ms) || 0)} size=${Math.round(Number(message.size) || 0)}${message.more ? ` more=${message.more}` : ""}`); return; }
      if (message.type === "drained") done();
      else if (message.type === "error") fail(new Error(message.message ?? "the deferred rows could not be projected"));
    });
    spawned.on("error", fail);
    spawned.on("exit", () => fail(new Error("the deferred-row worker stopped")));
  }).finally(() => { void worker?.terminate(); worker = undefined; });
  const tick = async () => {
    timer = null;
    if (stopped) return;
    let delay = INBOX_FILL_PAUSE_MS;
    try {
      if (options.admit) await options.admit();
      if (stopped) return;
      if (filling) {
        const started = performance.now();
        let priority: readonly string[] = [];
        try { priority = options.priorityThreads?.() ?? []; } catch { /* the list is a hint: the fill goes on in storage order */ }
        const slice = inboxProjectionSlice(db, { rows: SLICE_MAX_ROWS, weight: budget }, priority);
        const ms = performance.now() - started;
        stats.slices++; stats.maxSliceMs = Math.max(stats.maxSliceMs, ms);
        if (slice.finished) {
          filled = true; filling = false;
          if (retiredTables(db).length === 0) { finish(true); return; }
        } else if (slice.deferred) {
          // Nothing follows the cursor; the rows the budget could not admit are projected off this thread.
          await drainDeferred(slice.deferred === "priority");
          if (stopped) return;
          delay = 0;
        } else if (slice.weight > 0) {
          rate = Math.max(ms / slice.weight, rate * 0.9);
          const wanted = rate > 0 ? target / rate : FILL_MAX_WEIGHT;
          budget = Math.round(Math.max(FILL_MIN_WEIGHT, Math.min(FILL_MAX_WEIGHT, wanted, slice.weight * FILL_GROWTH)));
        }
        if (options.busy?.()) delay = INBOX_FILL_BUSY_PAUSE_MS;
      } else if (options.busy?.()) {
        delay = INBOX_RECLAIM_BUSY_PAUSE_MS;
      } else {
        const started = performance.now();
        const remaining = reclaimRetiredInboxProjection(db);
        const ms = performance.now() - started;
        stats.reclaimSlices++; stats.maxReclaimMs = Math.max(stats.maxReclaimMs, ms);
        if (!remaining) { finish(filled); return; }
      }
    } catch (error) {
      if (stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message)) delay = 1000;
      else { try { options.onError?.(error); } catch { /* reporting never throws into the loop */ } finish(false); return; }
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, delay);
  };
  timer = setTimeout(() => { void tick(); }, 0);
  return { done, stop() { finish(false); }, stats };
}

/** A restored archive is untrusted input: its projection is dropped whole and
 *  rebuilt from its messages after the next start, never trusted blind. */
export function discardInboxProjection(db: DatabaseSync): void {
  dropInboxProjection(db);
}

/** The json of an item's message, for the rows actually returned (the read mark is a hash of it). */
const ITEM_JSON = "(SELECT json FROM messages WHERE thread_id=inbox_items.thread_id AND id=inbox_items.message_id) AS json";
const SCOPE = "thread_id IN (SELECT value FROM json_each(?))";
const NOT_SNOOZED = "(snoozed_until IS NULL OR snoozed_until<=?)";
interface Row {
  source_key: string; thread_id: string; message_id: string; at: number; kind: string; expired: number; json: string;
  status: string; title: string; summary: string; segment: string; decision: number; to_read: number; read_version: string | null; snoozed_until: number | null; cleared_at: number | null; copies: number;
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
interface RoutineRow { thread_id: string; message_id: string; title: string; summary: string; status: string; at: number; decision: number; run_id: unknown; routine_id: unknown }
/** The SQL half of routineFacts: the only part that reads the table, so the only part worth caching. */
function routineRows(db: DatabaseSync, allowed: string, now: number): RoutineRow[] {
  return db.prepare(`SELECT thread_id, message_id, title, summary, status, at, decision, run_id, routine_id FROM inbox_items INDEXED BY ${ix("inbox_items_routine_at")}
    WHERE kind_segment='routine' AND at>=? AND ${SCOPE} ORDER BY at DESC LIMIT ?`)
    .all(now - ROUTINE_WINDOW_MS, allowed, ROUTINE_ROW_LIMIT) as unknown as RoutineRow[];
}
const runOnCard = (status: string) => (INBOX_RUN_ON_CARD_STATUSES as readonly string[]).includes(status);
function routineFacts(sqlRows: readonly RoutineRow[], threads: InboxAccess["threads"], now: number, records: readonly InboxRoutineRun[] = []): RoutineRunFact[] {
  const rows = sqlRows.filter(row => row.at >= now - ROUTINE_WINDOW_MS);
  // One lookup per row, not a walk of every conversation per row.
  const byThread = threadsById(threads);
  const carded = new Set(rows.map(row => row.run_id).filter((id): id is string => typeof id === "string"));
  return [...rows.map(row => ({
    // one routine is one row whichever record a run came from
    routineKey: typeof row.routine_id === "string" && row.routine_id ? `routine:${row.routine_id}` : `${row.thread_id}:${row.title}`,
    routineName: text(row.title, 120),
    botLabel: text(byThread.get(row.thread_id)?.label ?? "", 100),
    at: row.at,
    // Anything that is not a clean finish is a failure for the rules'
    // purposes, EXCEPT a run that stopped to ask something. Being generous
    // here is the safe direction: a run wrongly counted as failed shows up
    // inside a row that already exists, while one wrongly counted as clean
    // can make a stuck routine read as recovered. A run that is waiting on
    // the owner is the one case where "failed" is not generous but wrong —
    // it would print "Not recovering" over a routine that is one answer away
    // from carrying on.
    // A run waiting on its card is waiting, not failed, though the card and not the run is counted (RUN_ON_CARD).
    failed: row.status !== "completed" && row.decision !== 1 && !runOnCard(row.status),
    owed: row.decision === 1 || runOnCard(row.status),
    detail: row.summary,
    link: { threadId: row.thread_id, messageId: row.message_id },
  })), ...routineRecordFacts(records, carded, byThread, now)];
}

/** Runs in the routine's own record that posted no card: finished ones, and
 *  ones waiting on the owner, inside the window and the Inbox's scope. A run
 *  still working is not a result yet. The same rules as a card: anything but
 *  a clean finish is a failure, except a run that is waiting on the owner. */
function routineRecordFacts(records: readonly InboxRoutineRun[], carded: ReadonlySet<string>, threads: ReadonlyMap<string, InboxThread>, now: number): RoutineRunFact[] {
  const facts: RoutineRunFact[] = [];
  for (const run of records.slice(0, ROUTINE_ROW_LIMIT)) {
    if (carded.has(run.runId) || !run.threadId || run.at < now - ROUTINE_WINDOW_MS || ["queued", "running"].includes(run.status)) continue;
    const thread = threads.get(run.threadId);
    if (!thread) continue;
    const owed = run.status === "waiting" || run.status === "needs-you";
    facts.push({
      routineKey: `routine:${run.routineId}`,
      routineName: text(run.routineName, 120),
      botLabel: text(thread.label, 100),
      at: run.at,
      failed: run.status !== "completed" && !owed,
      owed,
      detail: text(owed ? run.attention : run.error),
      ...(run.link && run.link.threadId === run.threadId ? { link: run.link } : {}),
    });
  }
  return facts;
}

const threadIndex = new WeakMap<readonly InboxThread[], Map<string, InboxThread>>();
function threadsById(threads: readonly InboxThread[]): ReadonlyMap<string, InboxThread> {
  let index = threadIndex.get(threads);
  if (!index) { index = new Map(); for (const thread of threads) if (!index.has(thread.threadId)) index.set(thread.threadId, thread); threadIndex.set(threads, index); }
  return index;
}
function scope(access: InboxAccess) {
  if (access.owner !== true) reject(404, "Inbox is unavailable.");
  if (!Array.isArray(access.threads) || access.threads.length > 20_000 || access.threads.some(thread => !thread.threadId || typeof thread.threadId !== "string")) reject(400, "Invalid Inbox scope.");
  return JSON.stringify([...new Set(access.threads.map(thread => thread.threadId))]);
}
function item(row: Row, access: InboxAccess): InboxItem {
  const source = threadsById(access.threads).get(row.thread_id)!;
  const message = JSON.parse(row.json);
  const runId = row.kind === "routine.run" ? message.routineRun?.runId : row.kind === "goal.run" ? message.goalRun?.runId : undefined;
  const kind = row.kind === "options" ? "request" : row.kind === "secret" || row.kind === "connector" || row.kind === "mcpSignIn" ? "connection" : row.kind === "activity" ? "error" : row.kind === "routine.run" ? "routine" : row.kind === "text" ? "artifact" : "goal";
  const revision = version(row.json);
  const segment = (["approval", "question", "connection", "routine", "result"] as const)
    .find(value => value === row.segment) ?? "result";
  return { id: Buffer.from(row.source_key).toString("base64url"), version: revision, kind, segment, status: row.status,
    decision: row.decision === 1, toRead: row.to_read === 1, title: text(row.title, 120), summary: text(row.summary, row.status === "digest" ? 1000 : 280),
    sourceLabel: text(source.label, 100), ...(source.botId ? { botId: source.botId } : {}), at: row.at,
    read: row.read_version === revision, snoozedUntil: row.snoozed_until, duplicates: row.copies,
    ...(row.kind === "connector" && row.status === "pending" && source.botId ? { dismissible: true as const } : {}),
    // A sign-in card is set aside through its own route, which names the bot
    // that posted it (in a room that is not the thread's own bot).
    ...(row.kind === "mcpSignIn" ? mcpSignInRow(row, message, source) : {}),
    ...(row.decision !== 1 ? { clearable: true as const } : {}),
    link: { threadId: row.thread_id, messageId: row.message_id, ...(typeof runId === "string" ? { runId } : {}), ...(row.kind === "text" ? { artifactId: message.artifactIds[0] as string } : {}) } };
}
function mcpSignInRow(row: Row, message: { from?: { botId?: unknown }; mcpSignIn?: { botId?: unknown } }, source: InboxThread): Partial<InboxItem> {
  const botId = source.botId ?? (typeof message.mcpSignIn?.botId === "string" ? message.mcpSignIn.botId : typeof message.from?.botId === "string" ? message.from.botId : undefined);
  if (!botId) return {};
  return { botId, ...(row.status === "pending" ? { dismissible: true as const, dismissVia: "mcp-sign-in" as const } : {}) };
}
function queryValues(query: InboxQuery) {
  const view = query.view ?? "decisions", page = query.page ?? 0, pageSize = query.pageSize ?? 25;
  if (!["decisions", "approvals", "questions", "connections", "routines", "to-read", "results", "all"].includes(view) || !Number.isInteger(page) || page < 0 || page > 100_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
    || (query.query !== undefined && (typeof query.query !== "string" || query.query.length > 200))
    || (query.includeSnoozed !== undefined && typeof query.includeSnoozed !== "boolean")
    || (query.after !== undefined && (typeof query.after !== "string" || query.after.length > 12_000))) reject(400, "Invalid Inbox query.");
  return { view: view as ListName, page, pageSize, search: (query.query ?? "").trim().toLowerCase(), after: query.after ? decodeCursor(query.after) : undefined };
}

/** Where the next page starts: the last row's place in the list order
 *  (owed first, then newest, then key). Opaque to the client. */
interface Cursor { decision: 0 | 1; at: number; key: string }
function encodeCursor(row: Row): string {
  return Buffer.from(JSON.stringify([row.decision === 1 ? 1 : 0, row.at, row.source_key])).toString("base64url");
}
function decodeCursor(value: string): Cursor {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return reject(400, "Invalid Inbox query."); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || (parsed[0] !== 0 && parsed[0] !== 1) || !Number.isSafeInteger(parsed[1]) || typeof parsed[2] !== "string" || parsed[2].length > 8192) reject(400, "Invalid Inbox query.");
  const [decision, at, key] = parsed as [0 | 1, number, string];
  return { decision, at, key };
}

export function listInbox(db: DatabaseSync, query: InboxQuery, access: InboxAccess, now = Date.now()): InboxPage {
  return inboxPage(db, query, access, now, false);
}

/** What the SQL half of an Inbox answer holds: everything that costs a scan. */
interface InboxData {
  rows: Row[]; next?: string; total: number; approvals: number; questions: number; connections: number; decisions: number; toRead: number;
  questionThreads: Record<string, number>;
  /** The first moment a snooze in the answer runs out, after which the answer is stale. */
  wakeAt: number; filledAt: number;
}
const ENTRY_LIMIT = 32;
/** Per database handle, for one messages version: the answers, and the
 *  routine rows by audience. The routine rows do not depend on the view, page
 *  or search, and can be thousands of rows with run summaries in them, so they
 *  are held once per audience rather than once per answer. */
interface Held { version: number; entries: Map<string, InboxData>; routines: Map<string, RoutineRow[]> }
const answers = new WeakMap<DatabaseSync, Held>();
function heldFor(db: DatabaseSync): Held {
  const version = messagesVersion();
  let current = answers.get(db);
  if (!current || current.version !== version) { current = { version, entries: new Map(), routines: new Map() }; answers.set(db, current); }
  return current;
}
function cachedRoutineRows(db: DatabaseSync, allowed: string, now: number): RoutineRow[] {
  const { routines } = heldFor(db);
  let rows = routines.get(allowed);
  if (!rows) {
    rows = routineRows(db, allowed, now);
    if (routines.size >= ENTRY_LIMIT) routines.delete(routines.keys().next().value as string);
    routines.set(allowed, rows);
  }
  return rows;
}

/** The same answer as listInbox, with the scans memoised per (access, view,
 *  page) until a message or an Inbox mark changes (inbox-version.ts) or a
 *  snooze runs out. The sidebar, the tray, the push badge and the per-bot
 *  needs-you list all poll this; none of them should cost a scan when nothing
 *  happened. Only the SQL half is kept: roll-ups and restore rows are cheap
 *  and depend on the clock, so they are recomputed from the kept rows. */
export function listInboxCached(db: DatabaseSync, query: InboxQuery, access: InboxAccess, now = Date.now()): InboxPage {
  return inboxPage(db, query, access, now, true);
}

function cachedAnswer(db: DatabaseSync, key: string, now: number, load: () => InboxData): InboxData {
  const { entries } = heldFor(db);
  const hit = entries.get(key);
  if (hit && now >= hit.filledAt && now < hit.wakeAt) return hit;
  const data = load();
  if (entries.size >= ENTRY_LIMIT) entries.delete(entries.keys().next().value as string);
  entries.set(key, data);
  return data;
}

function inboxPage(db: DatabaseSync, query: InboxQuery, access: InboxAccess, now: number, cache: boolean): InboxPage {
  const allowed = scope(access), { view, page, pageSize, search, after } = queryValues(query);
  const decisions = view === "decisions";
  // GETTING READY IS SAID, NEVER SHOWN AS AN EMPTY INBOX. Until the first fill
  // has read the history from before the projection, any list or number would
  // be part of it presented as all of it. Every count is zero and `preparing`
  // says why; the clients show "Getting your inbox ready" and keep their last
  // badge, and the end of the fill tells them to read again.
  if (!inboxProjectionReady(db)) return { items: [], total: 0, page, pageSize, unread: 0, decisions: 0, toRead: 0, approvals: 0, questions: 0, connections: 0, preparing: true };
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
  //
  // Each list is read down its own partial index (listTerms), in list order,
  // so a page costs the rows on it. Without "show snoozed" the index already
  // leaves out what was cleared, and the walk skips what is snoozed now.
  //
  // Snooze applies to decisions too. "Not now" is a legitimate answer to
  // being asked, and the checkbox brings them back; what snooze must never do
  // is make a decision look ANSWERED, and it does not: the item keeps its
  // pending status and returns the moment the snooze expires.
  const includeSnoozed = query.includeSnoozed === true;
  const listed = listWhere(view, !includeSnoozed), index = listIndex(view, !includeSnoozed);
  // The conversation names are only read by a search, so only a search pays
  // for them (one redaction per conversation was a cost of every poll).
  const labels = search ? JSON.stringify(access.threads.map(thread => ({ threadId: thread.threadId, label: text(thread.label, 100) }))) : "[]";
  const filter = `${listed} AND ${SCOPE}${includeSnoozed ? "" : ` AND ${NOT_SNOOZED}`}${search ? ` AND (instr(lower(title || ' ' || summary || ' ' || status),?)>0
      OR thread_id IN (SELECT json_extract(value,'$.threadId') FROM json_each(?) WHERE instr(lower(json_extract(value,'$.label')),?)>0))` : ""}`;
  const filterParams = [allowed, ...(includeSnoozed ? [] : [now]), ...(search ? [search, labels, search] : [])];
  // ONE COUNT PER THING THAT CAN BE ASKED OF A PERSON, AND NONE FOR THE REST.
  //
  // Routines and results are never counted in the badges, and that is the
  // point of the whole redesign: the owner's badge said thirty six because it
  // counted things that happened. A number he cannot act on is a number he
  // stops reading, and then the one he could act on is invisible inside it.
  //
  // KEPT, NOT COUNTED. Every number comes from the per-conversation counters
  // the projection keeps in the write's own transaction (one row per permitted
  // conversation), less what is snoozed right now: a snooze runs out with no
  // write, so those few are read from the snooze index and taken off. A
  // search is the one exception: what it matches is only known by reading.
  const load = (): InboxData => {
    const badges = BADGES();
    const kept = db.prepare(`SELECT SUM(${includeSnoozed ? "v" : "l"}_${ident(view)}) AS total, SUM(o_approvals) AS approvals, SUM(o_questions) AS questions,
      SUM(o_connections) AS connections, SUM(o_decisions) AS decisions, SUM(o_unread) AS to_read FROM inbox_counts WHERE ${SCOPE}`).get(allowed) as Record<string, number | null>;
    const snoozed = db.prepare(`SELECT thread_id, SUM(CASE WHEN ${listWhere(view, true)} THEN 1 ELSE 0 END) AS total,
      SUM(CASE WHEN ${badges.o_approvals} THEN 1 ELSE 0 END) AS approvals, SUM(CASE WHEN ${badges.o_questions} THEN 1 ELSE 0 END) AS questions,
      SUM(CASE WHEN ${badges.o_connections} THEN 1 ELSE 0 END) AS connections, SUM(CASE WHEN ${badges.o_decisions} THEN 1 ELSE 0 END) AS decisions,
      SUM(CASE WHEN ${badges.o_unread} THEN 1 ELSE 0 END) AS to_read
      FROM inbox_items INDEXED BY ${ix("inbox_items_snoozed")} WHERE snoozed_until IS NOT NULL AND snoozed_until>? AND ${SCOPE} GROUP BY thread_id`)
      .all(now, allowed) as Array<Record<"thread_id" | "total" | "approvals" | "questions" | "connections" | "decisions" | "to_read", string | number | null>>;
    const less = (key: "total" | "approvals" | "questions" | "connections" | "decisions" | "to_read") => snoozed.reduce((n, row) => n + Number(row[key] ?? 0), 0);
    const count = (key: "approvals" | "questions" | "connections" | "decisions" | "to_read") => Number(kept[key] ?? 0) - less(key);
    const total = search
      ? Number((db.prepare(`SELECT COUNT(*) AS n FROM inbox_items INDEXED BY ${index} WHERE ${filter}`).get(...filterParams) as { n: number }).n)
      : Number(kept.total ?? 0) - (includeSnoozed ? 0 : less("total"));
    // Owed first. A tab that holds both must not float a request that expired
    // last week above one that is waiting now. The json comes back only for the
    // rows on this page: the read mark is a hash of the whole message. A
    // cursor continues from the last row of the page before, as an index seek.
    const order = "ORDER BY decision DESC,at DESC,source_key";
    const select = (extra: string) => `SELECT inbox_items.*, ${ITEM_JSON} FROM inbox_items INDEXED BY ${index} WHERE ${filter}${extra} ${order} LIMIT ? OFFSET ?`;
    let rows: Row[];
    if (after) {
      rows = db.prepare(select(" AND decision=? AND at<=? AND NOT(at=? AND source_key<=?)")).all(...filterParams, after.decision, after.at, after.at, after.key, pageSize, 0) as unknown as Row[];
      if (rows.length < pageSize && after.decision === 1) rows.push(...db.prepare(select(" AND decision=0")).all(...filterParams, pageSize - rows.length, 0) as unknown as Row[]);
    } else {
      rows = db.prepare(select("")).all(...filterParams, pageSize, page * pageSize) as unknown as Row[];
    }
    // THE SAME QUESTIONS, SPLIT BY CONVERSATION, so a row can carry a question
    // badge that attributes part of this number and never adds to it; only the
    // view the sidebar polls.
    const questionThreads: Record<string, number> = {};
    if (decisions) {
      for (const row of db.prepare(`SELECT thread_id, o_questions FROM inbox_counts WHERE o_questions>0 AND ${SCOPE}`).all(allowed) as Array<{ thread_id: string; o_questions: number }>) questionThreads[row.thread_id] = row.o_questions;
      for (const row of snoozed) {
        const id = String(row.thread_id), left = (questionThreads[id] ?? 0) - Number(row.questions ?? 0);
        if (left > 0) questionThreads[id] = left; else delete questionThreads[id];
      }
    }
    const wake = (db.prepare(`SELECT MIN(snoozed_until) AS next FROM inbox_items INDEXED BY ${ix("inbox_items_snoozed")} WHERE snoozed_until IS NOT NULL AND snoozed_until>?`).get(now) as { next: number | null } | undefined)?.next;
    return { rows, ...(rows.length === pageSize ? { next: encodeCursor(rows[rows.length - 1]) } : {}), total,
      approvals: count("approvals"), questions: count("questions"), connections: count("connections"), decisions: count("decisions"), toRead: count("to_read"),
      questionThreads, wakeAt: typeof wake === "number" ? wake : Infinity, filledAt: now };
  };
  const data = cache ? cachedAnswer(db, JSON.stringify([view, page, pageSize, search, includeSnoozed, allowed, labels, query.after ?? ""]), now, load) : load();
  const { rows, total } = data;
  const approvalCount = data.approvals, questionCount = data.questions, questionThreads = decisions ? data.questionThreads : undefined;
  const connectionCount = data.connections, decisionCount = data.decisions, toReadCount = data.toRead;
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
  //
  // Read on EVERY view, because the rows it finds are counted in `decisions`
  // and `connections`, and those counts label every tab. Reading it on three
  // views only made the same Inbox say "Needs you (1)" on Results and "(2)" on
  // Needs you. The rows themselves are still listed only where they belong.
  const rollups = rollUpRoutineRuns(routineFacts(cache ? cachedRoutineRows(db, allowed, now) : routineRows(db, allowed, now), access.threads, now, access.routineRuns), now);
  const listsRestore = view === "routines" || view === "connections" || decisions;
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
  const restore = connectionCount === 0 ? connectionsToRestore(rollups) : [];
  return { items: rows.map(row => item(row, access)), total, page, pageSize, ...(data.next ? { next: data.next } : {}),
    unread: rows.filter(row => row.read_version !== version(row.json)).length,
    // IT IS ADDED TO BOTH OR IT IS ADDED TO NEITHER. The three segment counts
    // sum to the umbrella, and that invariant is the one this Inbox has
    // already broken once: a number in `connections` that is missing from
    // `decisions` puts a badge on a tab the sidebar total cannot explain.
    decisions: decisionCount + restore.length, toRead: toReadCount,
    approvals: approvalCount, questions: questionCount, connections: connectionCount + restore.length,
    ...(questionThreads ? { questionThreads } : {}),
    // ONE ROW PER ROUTINE, NOT PER RUN, and only where it is asked for. The
    // owner's thirty six rows were four routines; the tab says "one line per
    // routine, not per run" and this is that sentence kept in data.
    ...(view === "routines" ? { routines: rollups } : {}),
    // Not an InboxItem, deliberately. There is no message under it, so it has
    // no read mark, no snooze and nothing to open: giving it the item shape
    // would mean inventing all three. It is a purpose-built row, exactly like
    // the routine rows above it.
    ...(listsRestore && restore.length > 0 ? { restore } : {}) };
}

/** Every conversation holding something owed to the owner: an approval, a
 *  question or a connection still waiting. Deliberately ignores the Inbox's
 *  own item snooze and clear marks, because this answers "may this
 *  conversation go quiet?" (server/thread-snooze.ts), and the answer for
 *  anything owed is no, whatever else was done to it. An expired card is
 *  not owed: nothing is waiting on it any more. */
export function owedThreads(db: DatabaseSync, access: InboxAccess): Set<string> {
  const allowed = scope(access);
  // Until the first fill is done the answer would be part of the history read
  // as all of it. Nothing is reported owed then: a snoozed conversation wakes
  // for an owed item a little late (the next sweep after the fill) rather
  // than being woken, and marked unread, by an item a later copy answered.
  if (!inboxProjectionReady(db)) return new Set();
  const rows = db.prepare(`SELECT thread_id FROM inbox_counts WHERE owed_open>0 AND ${SCOPE}`).all(allowed) as Array<{ thread_id: string }>;
  return new Set(rows.map(row => row.thread_id));
}

const owedAnswers = new WeakMap<DatabaseSync, { version: number; entries: Map<string, Set<string>> }>();
/** owedThreads, kept until a message or an Inbox mark changes. The snooze
 *  sweep asks on every beat while any snooze exists; the answer only moves
 *  when something is written. A fresh copy each call, so callers may keep it. */
export function owedThreadsCached(db: DatabaseSync, access: InboxAccess): Set<string> {
  const allowed = scope(access), version = messagesVersion();
  let held = owedAnswers.get(db);
  if (!held || held.version !== version) { held = { version, entries: new Map() }; owedAnswers.set(db, held); }
  let hit = held.entries.get(allowed);
  if (!hit) { hit = owedThreads(db, access); if (held.entries.size >= ENTRY_LIMIT) held.entries.clear(); held.entries.set(allowed, hit); }
  return new Set(hit);
}

/** State updates cannot change source status, approve requests or run tools. */
export function updateInboxState(db: DatabaseSync, update: InboxStateUpdate, access: InboxAccess, now = Date.now()) {
  const allowed = scope(access);
  if (!update || typeof update.id !== "string" || update.id.length > 8192 || typeof update.version !== "string"
    || !/^[a-f0-9]{64}$/.test(update.version) || Object.keys(update).some(key => !["id", "version", "read", "snoozedUntil", "cleared"].includes(key))
    || (update.cleared !== undefined && update.cleared !== true)
    || (update.read !== undefined && typeof update.read !== "boolean")
    || (update.snoozedUntil !== undefined && update.snoozedUntil !== null && (!Number.isSafeInteger(update.snoozedUntil) || update.snoozedUntil <= now || update.snoozedUntil > now + 30 * 24 * 60 * 60 * 1000))
    || (update.read === undefined && update.snoozedUntil === undefined && update.cleared === undefined)) reject(400, "Invalid Inbox update.");
  const sourceKey = Buffer.from(update.id, "base64url").toString("utf8");
  const row = db.prepare(`SELECT inbox_items.*, ${ITEM_JSON} FROM inbox_items WHERE source_key=? AND ${SCOPE}`).get(sourceKey, allowed) as unknown as Row | undefined;
  if (!row) throw new InboxError(404, "Inbox item is unavailable.");
  if (version(row.json) !== update.version) reject(409, "This item changed. Refresh Inbox before updating it.");
  // Clearing is never answering: something still waiting on the owner is
  // answered (or snoozed), not cleared away.
  if (update.cleared && row.decision === 1) reject(409, "This is waiting on your answer. Answer it rather than clearing it.");
  db.prepare(`INSERT INTO inbox_item_state(source_key,read_version,read_at,snoozed_until,cleared_at) VALUES(?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET
      read_version=CASE WHEN ? THEN excluded.read_version ELSE inbox_item_state.read_version END,
      read_at=CASE WHEN ? THEN excluded.read_at ELSE inbox_item_state.read_at END,
      snoozed_until=CASE WHEN ? THEN excluded.snoozed_until ELSE inbox_item_state.snoozed_until END,
      cleared_at=CASE WHEN ? THEN excluded.cleared_at ELSE inbox_item_state.cleared_at END`)
    .run(sourceKey, update.read === true ? update.version : null, update.read === true ? now : null, update.snoozedUntil ?? null, update.cleared ? now : null,
      update.read !== undefined ? 1 : 0, update.read !== undefined ? 1 : 0, update.snoozedUntil !== undefined ? 1 : 0, update.cleared ? 1 : 0);
  bumpMessagesVersion();
  return { ok: true as const };
}

/** Root supplies its existing desktop proof and exact permitted task roster.
 * Kept transport-independent so HTTP fixtures exercise this same boundary. */
export function inboxRequest(db: DatabaseSync, request: { method: string; path: string; query?: InboxQuery; body?: InboxStateUpdate }, access: InboxAccess, options: { cache?: boolean } = {}) {
  try {
    scope(access);
    if (request.method === "GET" && request.path === "/api/inbox") return { status: 200, body: (options.cache ? listInboxCached : listInbox)(db, request.query ?? {}, access) };
    if (request.method === "POST" && request.path === "/api/inbox/state") return { status: 200, body: updateInboxState(db, request.body!, access) };
    return { status: 404, body: { error: "Inbox is unavailable." } };
  } catch (error) {
    if (error instanceof InboxError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}
