import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Message } from "../store.ts";
import { redactSecretsInText } from "../redact.ts";
import { applyMemoryTombstones } from "./restore.ts";

function enabled(db: DatabaseSync) { return db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode !== "off"; }
function excludedThread(db:DatabaseSync,threadId:string){return Boolean(db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=? LIMIT 1").get(threadId));}
function conversationScope(db: DatabaseSync, threadId: string) {
  const existing = db.prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key=?").get(threadId);
  if (existing) return String(existing.id);
  const id = randomUUID(); db.prepare("INSERT INTO memory_scopes VALUES(?,'conversation',?,'[]',0)").run(id,threadId); return id;
}

export function captureSource(db: DatabaseSync, source: {id: string; threadId: string; messageId?: string; turnId?: string; parentId?: string | null; kind: string; speaker: string; outcome: string; text: string; excluded?: string}) {
  if (!enabled(db)||excludedThread(db,source.threadId)) return;
  const text = redactSecretsInText(source.text);
  const payload = JSON.stringify({text,kind:source.kind,speaker:source.speaker,outcome:source.outcome,...source.excluded?{excluded:source.excluded}:{}});
  const hash = createHash("sha256").update(payload).digest("hex");
  const scope = conversationScope(db,source.threadId);
  if (db.prepare("SELECT 1 FROM memory_tombstones WHERE (target_type='source' AND target_id=? AND revision IS NULL) OR (target_type='import' AND target_id=? AND content_hash=?)").get(source.id,scope,hash)) return;
  const previous = db.prepare("SELECT revision,content_hash,state FROM memory_sources WHERE id=?").get(source.id);
  if (previous?.state === "deleted" || previous?.content_hash === hash) return;
  const revision = previous ? Number(previous.revision)+1 : 1;
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  db.prepare(`INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    revision=excluded.revision,content_hash=excluded.content_hash,outcome=excluded.outcome,kind=excluded.kind,state=excluded.state,branch_id=excluded.branch_id`)
    .run(source.id,scope,source.threadId,source.messageId??null,source.turnId??null,revision,hash,source.kind,source.speaker,source.outcome,source.parentId??null,source.excluded?"retired":"active");
  db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,?)").run(source.id,revision,hash,payload,Date.now());
  db.prepare("UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1 WHERE source_id=? AND status NOT IN ('complete','cancelled')").run(source.id);
  const meta = db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) VALUES(?,?,?,'capture','1',?,?,?)")
    .run(randomUUID(),source.id,revision,source.excluded?"complete":"pending",meta.policy_revision,meta.deletion_epoch);
}

/** Only folded message fields are accepted; raw provider envelopes never enter here. */
export function captureMessage(db: DatabaseSync, threadId: string, message: Message) {
  if (!enabled(db)) return;
  const userText = message.kind === "text" && message.role === "user" && !message.queued;
  const finalText = message.kind === "text" && message.role === "bot" && (message.turnTerminal || !message.turnId);
  const tool = message.kind === "activity" && typeof message.tool?.ok === "boolean";
  // Streaming text waits for the terminal patch; never snapshot each delta.
  if (message.kind === "text" && !userText && !finalText) return;
  captureSource(db,{id:`message:${threadId}:${message.id}`,threadId,messageId:message.id,turnId:message.turnId,parentId:message.parentId,
    kind:tool?"tool-outcome":message.kind,speaker:message.role === "user"?"owner":tool?"tool":message.from?.botId??"assistant",
    outcome:tool?(message.tool!.ok?"completed":"failed"):"recorded",text:userText||finalText?message.text??"":tool?message.tool!.name:"",
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
  db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE thread_id=? AND state!='revoked'").run(threadId);
}

export function captureThreadDeletion(db: DatabaseSync, threadId: string) {
  if (!enabled(db)) return;
  db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1 WHERE id=1");
  const epoch = Number(db.prepare("SELECT deletion_epoch FROM memory_meta WHERE id=1").get()!.deletion_epoch);
  const sources = db.prepare("SELECT id FROM memory_sources WHERE thread_id=?").all(threadId);
  for (const source of sources) {
    db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,?,'thread-deleted',?)").run(randomUUID(),source.id,epoch,Date.now());
    db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source.id);
    db.prepare("UPDATE memory_jobs SET status='cancelled',lease_generation=lease_generation+1 WHERE source_id=? AND status!='cancelled'").run(source.id);
  }
  db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE thread_id=?").run(threadId);
  applyMemoryTombstones(db);
}
