import { authoredTurnPieces } from "../reply-action-guard.ts";
import { purgeThreadLearning } from "./evolution-forgetting.ts";
import { threadHumanPrincipal, isWorkspaceOwner } from "../human-principals.ts";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Message } from "../store.ts";
import { redactSecretsInText } from "../redact.ts";
import { reconcilePipStances } from "./pip-stance.ts";
import { applyMemoryTombstones } from "./restore.ts";
import { forgetParkedSource, parkRetiredThreadJobs, reopenParkedThreadJobs } from "./park.ts";
import { enqueueProcedureSourceReview } from "./procedure-review.ts";
import { threadCaptureScope } from "./capture-scope.ts";
import { withoutImageTags } from "../../src/lib/composer-attachments.ts";
import { scopeRow } from "./scope-id.ts";
import { revokeAllDisclosures, revokeThreadDisclosures } from "./revocation.ts";

function enabled(db: DatabaseSync) { return db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode !== "off"; }
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
  db.prepare("UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1 WHERE source_id=? AND status NOT IN ('complete','cancelled')").run(source.id);
  forgetParkedSource(db,source.id);
  const meta = db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES(?,?,?,'capture','1',?,?,?)")
    .run(randomUUID(),source.id,revision,source.excluded || failedTool ? "complete" : "pending",meta.policy_revision,meta.deletion_epoch);
  enqueueProcedureSourceReview(db,source.id,revision);
  if(previous)reconcilePipStances(db);
}

/** The words of a provider turn as one text. A turn's reply can arrive in
 * several pieces around tool calls, each its own row with the same turnId;
 * the closing row is the one captured, and it carries the whole turn so
 * recall and later admission see all of it, not only the last piece. Pieces
 * join in storage order with a blank line. A removal row's removedText never
 * joins (it is not part of what the engine said to the person). */
export function wholeTurnText(db: DatabaseSync, threadId: string, message: Message): string {
  if (!message.turnId) return message.text ?? "";
  const rows = db.prepare(`WITH RECURSIVE path(id,parent,json,depth) AS (
    SELECT id,json_extract(json,'$.parentId'),json,0 FROM messages WHERE thread_id=? AND id=(SELECT active_leaf_id FROM thread_state WHERE thread_id=?)
    UNION ALL SELECT m.id,json_extract(m.json,'$.parentId'),m.json,p.depth+1 FROM messages m JOIN path p ON m.id=p.parent WHERE m.thread_id=?
  ) SELECT json FROM path ORDER BY depth DESC`).all(threadId,threadId,threadId);
  const path = rows.map(row => JSON.parse(String(row.json)) as Message);
  return authoredTurnPieces(path, message).map(piece => piece.id === message.id ? message.text : piece.text).filter(Boolean).join("\n\n");
}

/** Only folded message fields are accepted; raw provider envelopes never enter here. */
export function captureMessage(db: DatabaseSync, threadId: string, message: Message) {
  if (!enabled(db)) return;
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

/** Runs only on an actual branch change, not every ordinary append. */
export function captureBranchChange(db: DatabaseSync, threadId: string, leafId: string | null) {
  if (!enabled(db)||excludedThread(db,threadId)) return;
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  const rows = db.prepare(`WITH RECURSIVE path(id,parent) AS (
    SELECT id,json_extract(json,'$.parentId') FROM messages WHERE thread_id=? AND id=?
    UNION SELECT m.id,json_extract(m.json,'$.parentId') FROM messages m JOIN path p ON m.id=p.parent WHERE m.thread_id=?
  ) SELECT id FROM path`).all(threadId,leafId,threadId);
  const active = JSON.stringify(rows.map(r=>r.id));
  db.prepare("UPDATE memory_sources SET state=CASE WHEN message_id IN (SELECT value FROM json_each(?)) THEN 'active' ELSE 'retired' END WHERE thread_id=? AND message_id IS NOT NULL AND state!='deleted' AND kind IN ('text','tool-outcome')").run(active,threadId);
  // A retired source's jobs can never be claimed: park them out of the open set, and bring back the ones whose source is active again.
  parkRetiredThreadJobs(db,threadId);reopenParkedThreadJobs(db,threadId);
  revokeThreadDisclosures(db,threadId,"branch-change");
}

/** Deleting a conversation forgets what memory captured from it, whatever
 * the memory mode is now: sources captured while memory was on are still on
 * disk after it is turned off. The rows stay (tombstones, epochs and the
 * evidence graph point at them) but the conversation's words do not. */
export function captureThreadDeletion(db: DatabaseSync, threadId: string) {
  // What was learned from this conversation goes with it, captured or not (owner-typed feedback text included).
  purgeThreadLearning(db, threadId);
  if (!db.prepare("SELECT 1 FROM memory_sources WHERE thread_id=? LIMIT 1").get(threadId)) {
    if (enabled(db)) revokeThreadDisclosures(db,threadId,"thread-deletion",{includeRevoked:true});
    return;
  }
  db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1 WHERE id=1");
  const epoch = Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
  const sources = db.prepare("SELECT id FROM memory_sources WHERE thread_id=? AND state!='deleted'").all(threadId);
  for (const source of sources) {
    db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,?,'thread-deleted',?)").run(randomUUID(),source.id,epoch,Date.now());
    db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source.id);
    db.prepare("UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1 WHERE source_id=? AND status!='cancelled'").run(source.id);
    forgetParkedSource(db,String(source.id));
  }
  revokeThreadDisclosures(db,threadId,"thread-deletion",{includeRevoked:true});
  applyMemoryTombstones(db);
  db.prepare(`UPDATE memory_records SET text='' WHERE state='deleted' AND EXISTS (SELECT 1 FROM memory_evidence e JOIN memory_sources s
    ON s.id=e.source_id WHERE e.record_id=memory_records.id AND e.record_version=memory_records.version AND s.thread_id=?)`).run(threadId);
  db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id IN (SELECT id FROM memory_sources WHERE thread_id=? AND state='deleted')")
    .run(JSON.stringify({ deleted: "thread-deleted" }), threadId);
}

/** Bot notebooks, including every composite partition, share deletion semantics. */
export function captureBotDeletion(db: DatabaseSync, botId: string): void {
  const scopes = db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND (owner_key=? OR substr(owner_key,1,?)=?)").all(botId,botId.length+1,botId+"#").map(row=>String(row.id));
  if (!scopes.length) return;
  const encoded = JSON.stringify(scopes);
  db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1,policy_revision=policy_revision+1 WHERE id=1");
  const epoch = Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
  for (const source of db.prepare("SELECT id FROM memory_sources WHERE scope_id IN (SELECT value FROM json_each(?))").all(encoded)) {
    db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,?,'bot-deleted',?)").run(randomUUID(),source.id,epoch,Date.now());
    db.prepare("UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1 WHERE source_id=?").run(source.id);
    forgetParkedSource(db,String(source.id));
  }
  for (const record of db.prepare("SELECT id FROM memory_records WHERE scope_id IN (SELECT value FROM json_each(?))").all(encoded)) db.prepare("INSERT INTO memory_tombstones VALUES(?,'record',?,NULL,NULL,?,'bot-deleted',?)").run(randomUUID(),record.id,epoch,Date.now());
  applyMemoryTombstones(db);
  db.prepare("UPDATE memory_records SET text='',state='deleted' WHERE scope_id IN (SELECT value FROM json_each(?))").run(encoded);
  db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id IN (SELECT id FROM memory_sources WHERE scope_id IN (SELECT value FROM json_each(?)))").run(JSON.stringify({deleted:"bot-deleted"}),encoded);
  db.prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE scope_id IN (SELECT value FROM json_each(?))").run(encoded);
  revokeAllDisclosures(db,"bot-deletion",{includeRevoked:true});
}
