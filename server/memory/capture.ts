import { authoredTurnPieces } from "../reply-action-guard.ts";
import { threadHumanPrincipal, isWorkspaceOwner } from "../human-principals.ts";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { memoryCaptures } from "./capture-gate.ts";
import { memoryGate } from "./memory-gate.ts";
import { turnFirstRowid } from "../transcript-backfill.ts";
import type { Message } from "../store.ts";
import { isMurageVoice } from "../murage-voice.ts";
import { redactSecretsInText } from "../redact.ts";
import { reconcilePipStances } from "./pip-stance.ts";
import { applyForgetTombstones } from "./restore.ts";
import { REVOCATION_JOB_SUBJECT } from "./memory-revocation.ts";
import { forgetParkedSource, parkRetiredThreadJobs } from "./park.ts";
import { memoryClaimIndex } from "./claim-index.ts";
import { enqueueProcedureSourceReview } from "./procedure-review.ts";
import { threadCaptureScope } from "./capture-scope.ts";
import { withoutImageTags } from "../../src/lib/composer-attachments.ts";
import { scopeRow } from "./scope-id.ts";
import { revokeThreadDisclosures } from "./revocation.ts";
import { commitRevoke, inheritEdge } from "./revoke-commit.ts";
import { writeCaptureLineage } from "./lineage-write.ts";
import { startBranchChange } from "./branch-change.ts";
import { noteTurnCaptureJob } from "./turn-capture-jobs.ts";

function enabled(db: DatabaseSync) { const mode = db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode as string | undefined; return memoryCaptures(mode, memoryGate(db, "capture") === "ok" ? null : "held"); }
function excludedThread(db:DatabaseSync,threadId:string){return Boolean(db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=? LIMIT 1").get(threadId));}
/** The scope a thread's sources are captured into: its room's scope for a
 * room or project desk thread, else its own conversation (capture-scope.ts). */
export function captureScopeId(db: DatabaseSync, threadId: string) {
  const {kind,owner} = threadCaptureScope(threadId,undefined,db);
  const existing = scopeRow(db, kind,owner);
  if (existing) return String(existing.id);
  const id = randomUUID(); db.prepare("INSERT INTO memory_scopes VALUES(?,?,?,'[]',0)").run(id,kind,owner); return id;
}

export function captureSource(db: DatabaseSync, source: {id: string; threadId: string; messageId?: string; turnId?: string; parentId?: string | null; kind: string; speaker: string; outcome: string; text: string; origin?: {kind:string;channel?:string;connectionId?:string;webhookId?:string;routineId?:string}; engine?: {instanceId:string;model:string;capabilityHash:string}; actionCheck?: Message["actionCheck"]; excluded?: string; occurredAt?: number; actorId?: string; artifactIds?: string[]; action?: { label: string; reportedOutcome: "completed" | "failed"; detail?: string; verification: "tool-reported" }}) {
  if (!enabled(db)||excludedThread(db,source.threadId)) return;
  // Keep failed outcomes as procedure-learning evidence, never recall work.
  const failedTool = (source.kind === "tool-outcome" || source.kind === "activity") && source.outcome === "failed";
  const text = redactSecretsInText(source.text);
  const content = {text,kind:source.kind,speaker:source.speaker,outcome:source.outcome,
    ...(source.occurredAt !== undefined && Number.isSafeInteger(source.occurredAt) && source.occurredAt >= 0 ? {occurredAt:source.occurredAt} : {}),
    ...(source.actorId ? {actorId:source.actorId} : {}),
    ...(source.artifactIds?.length ? {artifactIds:[...source.artifactIds]} : {}),
    ...(source.action ? {action:{...source.action,label:redactSecretsInText(source.action.label),...(source.action.detail ? {detail:redactSecretsInText(source.action.detail)} : {})}} : {}),
    ...source.excluded?{excluded:source.excluded}:{}};
  // engine is metadata like origin: kept in the payload, never in the content hash, no column.
  const payload = JSON.stringify({...content,...(source.origin?{origin:source.origin}:{}),...(source.engine?{engine:source.engine}:{}),...(source.actionCheck?{actionCheck:source.actionCheck}:{})});
  const hash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const scope = captureScopeId(db,source.threadId);
  if (db.prepare("SELECT 1 FROM memory_tombstones WHERE (target_type='source' AND target_id=? AND revision IS NULL) OR (target_type='import' AND target_id=? AND content_hash=?)").get(source.id,scope,hash)) return;
  // a deleted conversation or bot takes nothing new (deny.ts)
  if (db.prepare("SELECT 1 FROM memory_deny WHERE (kind='thread' AND id=?) OR (kind='scope' AND id=?)").get(source.threadId,scope)) return;
  const previous = db.prepare("SELECT revision,content_hash,state FROM memory_sources WHERE id=?").get(source.id);
  if (previous?.state === "deleted") return;
  if (previous?.content_hash === hash) {
    // Metadata changes do not enqueue extraction or duplicate captured text.
    const version = db.prepare("SELECT payload FROM memory_source_versions WHERE source_id=? AND revision=?").get(source.id,previous.revision);
    const merged = JSON.stringify({ ...JSON.parse(String(version?.payload ?? "{}")), ...JSON.parse(payload) });
    db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id=? AND revision=?").run(merged,source.id,previous.revision);
    return;
  }
  // Keep evidence captured by the first v4 writer intact too: origin is metadata.
  if(previous){
    const version=db.prepare("SELECT payload FROM memory_source_versions WHERE source_id=? AND revision=?").get(source.id,previous.revision);
    if(version){const prior=JSON.parse(String(version.payload));delete prior.origin;delete prior.engine;delete prior.actionCheck;if(JSON.stringify(prior)===JSON.stringify(content))return;}
  }
  const revision = previous ? Number(previous.revision)+1 : 1;
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  db.prepare(`INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    revision=excluded.revision,content_hash=excluded.content_hash,outcome=excluded.outcome,kind=excluded.kind,state=excluded.state,branch_id=excluded.branch_id`)
    .run(source.id,scope,source.threadId,source.messageId??null,source.turnId??null,revision,hash,source.kind,source.speaker,source.outcome,source.parentId??null,source.excluded?"retired":"active");
  db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,?)").run(source.id,revision,hash,payload,Date.now());
  // the line -> source edge the marker follows when the line is revoked (DESIGN-WRITETIME 2.6)
  if(source.messageId){writeCaptureLineage(db,{threadId:source.threadId,messageId:source.messageId},source.id);
    // a source captured from a denied line is marked at its write (DRAIN-104 2.11): the walk that passed the line may be done
    inheritEdge(db,{kind:"source",id:source.id},{threadId:source.threadId,messageId:source.messageId});}
  db.prepare("UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1 WHERE source_id=? AND status NOT IN ('complete','cancelled')").run(source.id);
  forgetParkedSource(db,source.id);
  const meta = db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  // A turn still running (`working`) can never be claimed at this revision: its settlement is a new revision that cancels this
  // job. The job is born closed (claim-settle.ts), so it never sits in the open statuses, and it is not noted as the thread's
  // newest capture job: that is still the prompt's, which a starting turn claims first (worker-controller claimTurnCritical).
  const jobId = randomUUID(), working = source.outcome === "working", jobDone = Boolean(source.excluded || failedTool || working);
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,error,policy_revision,deletion_epoch) VALUES(?,?,?,'capture','1',?,?,?,?)")
    .run(jobId,source.id,revision,source.excluded || failedTool ? "complete" : working ? "cancelled" : "pending",working && !source.excluded && !failedTool ? "settled:working" : null,meta.policy_revision,meta.deletion_epoch);
  if (!jobDone) noteTurnCaptureJob(source.threadId, jobId); // a starting turn claims its own capture by this id (worker-controller claimTurnCritical)
  enqueueProcedureSourceReview(db,source.id,revision);
  if(previous){
    // a bot's stance rests on its own scope's sources: only that bot is reconciled (the primary-key lookup); a source of another kind of scope reconciles them all, through the index
    const owner=db.prepare("SELECT owner_key FROM memory_scopes WHERE id=? AND kind='bot'").get(scope)?.owner_key;
    reconcilePipStances(db,typeof owner==="string"&&owner?owner.split("#")[0]:undefined);
  }
}

/** The words of a provider turn as one text. A turn's reply can arrive in
 * several pieces around tool calls, each its own row with the same turnId;
 * the closing row is the one captured, and it carries the whole turn so
 * recall and later admission see all of it, not only the last piece. Pieces
 * join in storage order with a blank line. A removal row's removedText never
 * joins (it is not part of what the engine said to the person). */
export const TURN_WALK_MAX = 512;
export function wholeTurnText(db: DatabaseSync, threadId: string, message: Message): string {
  if (!message.turnId) return message.text ?? "";
  // The parent-link walk reads root to this message only: right for the turn's last piece, which is all capture holds; a
  // message with later pieces of its turn after it (the engine payload's reader) needs the branch read.
  const path = (message.turnTerminal ? turnPath(db, threadId, message) : null) ?? boundedBranchPath(db, threadId, message);
  return authoredTurnPieces(path, message).map(piece => piece.id === message.id ? message.text : piece.text).filter(Boolean).join("\n\n");
}
/** The rows of the captured message's turn, root to message: walked up the parent links from the message itself until the first row of an
 * earlier turn (a different turnId), so the cost is the turn's length, never the history's. Null (not provable: a missing link, a row that
 * is not held, a loop, or past TURN_WALK_MAX rows) sends the caller to the rowid-bounded branch read. */
function turnPath(db: DatabaseSync, threadId: string, message: Message): Message[] | null {
  const rows: Message[] = [message];
  const seen = new Set<string>([message.id]);
  // The turn's first row is kept as it is written (turn_first): nothing stored before it is of this turn, whatever turn id that row carries (a
  // row with none is not of the turn either), so the walk is bounded by the turn's own rows and not by the history behind it.
  const first = turnFirstRowid(db, threadId, message.turnId!);
  const read = db.prepare("SELECT json, rowid AS position FROM messages WHERE thread_id=? AND id=?");
  let at: string | null | undefined = message.parentId;
  while (at !== null) {
    if (at === undefined || seen.has(at) || rows.length > TURN_WALK_MAX) return null;
    const row = read.get(threadId, at);
    if (!row) return null;
    if (first !== null && Number(row.position) < first) break;
    const parsed = JSON.parse(String(row.json)) as Message;
    if (parsed.turnId && parsed.turnId !== message.turnId) break;
    seen.add(at); rows.push(parsed);
    at = parsed.parentId;
  }
  return rows.reverse();
}
function boundedBranchPath(db: DatabaseSync, threadId: string, message: Message): Message[] {
  // Only this turn's own rows matter (authoredTurnPieces), and a parent is
  // always stored before its child, so the walk up the branch stops at the
  // turn's first row instead of climbing to the root of a very long thread.
  // The turn's first row is kept as it is written (turn_first); a turn that began
  // before that table existed is found the long way, once.
  const first = { first: turnFirstRowid(db, threadId, message.turnId!) };
  const rows = db.prepare(`WITH RECURSIVE path(id,parent,json,depth) AS (
    SELECT id,json_extract(json,'$.parentId'),json,0 FROM messages WHERE thread_id=? AND id=(SELECT active_leaf_id FROM thread_state WHERE thread_id=?)
    UNION ALL SELECT m.id,json_extract(m.json,'$.parentId'),m.json,p.depth+1 FROM messages m JOIN path p ON m.id=p.parent WHERE m.thread_id=? AND m.rowid>=? AND p.depth<10000
  ) SELECT json FROM path ORDER BY depth DESC`).all(threadId,threadId,threadId,first.first ?? 0);
  const path = rows.map(row => JSON.parse(String(row.json)) as Message);
  return path;
}

/** Only folded message fields are accepted; raw provider envelopes never enter here. */
export function captureMessage(db: DatabaseSync, threadId: string, message: Message) {
  if (!enabled(db)) return;
  // A Murage-voice row (murage-voice.ts) is never a source: no Murage line reaches memory from 1.0.3 on (LINEAGE-DESIGN-S6 rule 22).
  if (isMurageVoice(message)) return;
  const userText = message.kind === "text" && message.role === "user" && !message.queued;
  const finalText = message.kind === "text" && message.role === "bot" && (message.turnTerminal || !message.turnId);
  // Engine notices and Murage's own status rows (the held queue) are not tool outcomes.
  const tool = message.kind === "activity" && typeof message.tool?.ok === "boolean" && !message.tool.notice && !message.murage && message.actorKind !== "murage";
  if (message.kind === "activity" && (message.tool?.notice || message.murage || message.actorKind === "murage")) return;
  // Streaming text waits for the terminal patch; never snapshot each delta.
  if (message.kind === "text" && !userText && !finalText) return;
  captureSource(db,{id:`message:${threadId}:${message.id}`,threadId,messageId:message.id,turnId:message.turnId,parentId:message.parentId,
    kind:tool?"tool-outcome":message.kind,speaker:message.role === "user"?(isWorkspaceOwner(threadHumanPrincipal(threadId,db))?"owner":"person:"+threadHumanPrincipal(threadId,db).personId):tool?"tool":message.from?.botId??"assistant",
    outcome:tool?(message.tool!.ok?"completed":"failed"):"recorded",
    // images a turn left out never come back through recall (turn-images.ts)
    text:userText?withoutImageTags(message.text??"",message.imagesNotSent??[]):finalText?(message.turnTerminal?wholeTurnText(db,threadId,message):message.text??""):tool?[message.tool!.name,message.text,message.tool!.errorDetails].filter(Boolean).join("\n"):"",
    ...(userText?{origin:message.automation??{kind:message.origin==="desktop"||message.origin==="companion"?"attended":message.origin==="unproven"?"unproven":"unknown"}}:{}),
    ...(message.role==="bot"&&message.engine?{engine:{instanceId:message.engine.instanceId,model:message.engine.model,capabilityHash:message.engine.capabilityHash}}:{}),
    actionCheck:message.actionCheck,occurredAt:message.at,actorId:message.role==="user"?threadHumanPrincipal(threadId,db).personId:message.from?.botId,artifactIds:message.artifactIds,
    ...(tool?{action:{label:message.tool!.name,reportedOutcome:message.tool!.ok?"completed" as const:"failed" as const,detail:message.tool!.errorDetails??message.text,verification:"tool-reported" as const}}:{}),
    ...(!userText&&!finalText&&!tool?{excluded:`unsupported-${message.kind}`}:{})});
}

/** Runs only on an actual branch change, not every ordinary append. `fromLeafId`
 * is the head it moved from, when known: the sources of the rows that changed
 * sides are updated, not every source of the thread (memory/branch-change.ts:
 * the first rows in this transaction, a long change in slices after it). */
export function captureBranchChange(db: DatabaseSync, threadId: string, leafId: string | null, fromLeafId?: string | null) {
  if (!enabled(db)||excludedThread(db,threadId)) return;
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  if (leafId) startBranchChange(db, threadId, fromLeafId ?? null, leafId);
  else {
    // no head at all: nothing of the thread is on a branch
    db.prepare("UPDATE memory_sources SET state='retired' WHERE thread_id=? AND message_id IS NOT NULL AND state!='deleted' AND state!='retired' AND kind IN ('text','tool-outcome')").run(threadId);
    parkRetiredThreadJobs(db,threadId);
  }
  // Sources active again bring their open jobs back: the claim's ready index sweeps for them (review finding 5).
  memoryClaimIndex.reopened();
  revokeThreadDisclosures(db,threadId,"branch-change");
}

/** Deleting a conversation forgets what memory captured from it, whatever
 * the memory mode is now: sources captured while memory was on are still on
 * disk after it is turned off. The rows stay (tombstones, epochs and the
 * evidence graph point at them) but the conversation's words do not.
 * The commit writes one deny row for the conversation (deny.ts: every reader refuses its sources from here on) and the epoch
 * bump; its sources are tombstoned, ended and blanked by the durable job's thread phase, a page at a time. */
export function captureThreadDeletion(db: DatabaseSync, threadId: string) {
  // The deny row and the epoch bump are written whatever memory captured from the conversation (revbound r3 A1, Fable P1-2): a line
  // carried out of it, or a lesson citing one of its messages, has no source row to be refused by, only the conversation's deny.
  db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1 WHERE id=1");
  const epoch = Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
  db.prepare("INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES('thread',?,?,?)").run(threadId, epoch, Date.now());
  // write-time: the thread's lines denied, its carries out and captures walked by the marker (revoke-commit.ts)
  const revokeId = commitRevoke(db, { kind: "thread", threadId, cause: "delete-conversation" });
  const tracked = revokeId ? { revokeId } : {};
  if (!db.prepare("SELECT 1 FROM memory_sources WHERE thread_id=? LIMIT 1").get(threadId)) {
    // nothing captured: what was learned from this conversation still goes with it (owner-typed feedback text included)
    applyForgetTombstones(db, { sources: [], records: [] }, { job: { threads: [threadId], phases: ["learning", "done"], ...tracked }, messages: threadId });
    if (enabled(db)) revokeThreadDisclosures(db,threadId,"thread-deletion",{includeRevoked:true});
    return;
  }
  applyForgetTombstones(db, { sources: [], records: [] }, { job: { thread: threadId, threads: [threadId], cause: "thread-deletion", ...tracked }, before: ["thread"], messages: threadId });
}

/** Bot notebooks, including every composite partition, share deletion semantics. The commit writes one deny row per scope (every
 * reader refuses its sources and records from here on), the epoch and policy bump and the bindings' revoke; its sources and
 * records are tombstoned, ended and blanked by the durable job's scope phase, then every receipt made before the commit ends. */
export function captureBotDeletion(db: DatabaseSync, botId: string): void {
  const scopes = db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND (owner_key=? OR substr(owner_key,1,?)=?)").all(botId,botId.length+1,botId+"#").map(row=>String(row.id));
  if (!scopes.length) return;
  const encoded = JSON.stringify(scopes);
  db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1");
  const epoch = Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
  const deny = db.prepare("INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES('scope',?,?,?)");
  for (const scope of scopes) deny.run(scope, epoch, Date.now());
  db.prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE scope_id IN (SELECT value FROM json_each(?)) AND NOT (subject_type='system' AND subject_id=?)").run(encoded, REVOCATION_JOB_SUBJECT);
  // write-time: the bot's scopes' records walked by the marker (its conversations are deleted, each its own thread revoke)
  const revokeId = commitRevoke(db, { kind: "bot", botId, threadIds: [], cause: "delete-bot" });
  applyForgetTombstones(db, { sources: [], records: [] }, { job: { scopes, cause: "bot-deletion", ...(revokeId ? { revokeId } : {}) }, before: ["scope"], tail: "all" });
}
