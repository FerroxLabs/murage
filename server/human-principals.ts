import { homeThread } from "./execution-audience.ts";
import type { Store } from "./store.ts";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { database, transaction } from "./database.ts";
import { requireMemoryOwner } from "./memory/authority.ts";
import { scopeRow } from "./memory/scope-id.ts";
import { bindingRowsStamp } from "./io-budget.ts";
import { revokeAllDisclosures } from "./memory/revocation.ts";

export const WORKSPACE_OWNER = "workspace-owner";
export type HumanPrincipal = Readonly<{ personId: string; bindingId: string; revision: number }>;
export type VerifiedHumanOrigin = { platform: "slack" | "discord" | "telegram" | "whatsapp"; connectionId: string; authorityId: string; userId: string };
/** What the channel calls the sender. Kept so lessons can be kept away from customer turns that name a person (bot learning, R3-04). Not an identity: never compared, never grants anything. */
export type SenderDisplay = { name?: string; username?: string };
type Binding = { id: string; origin: VerifiedHumanOrigin; personId: string | null; revision: number; active: boolean; display?: SenderDisplay };
const cleanDisplay = (value: SenderDisplay | undefined): SenderDisplay | undefined => {
  const clean = (text: unknown) => typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const name = clean(value?.name), username = clean(value?.username).replace(/^@/, "");
  return name || username ? { ...(name ? { name } : {}), ...(username ? { username } : {}) } : undefined;
};
export const OWNER: HumanPrincipal = Object.freeze({ personId: WORKSPACE_OWNER, bindingId: "local", revision: 1 });
const PREFIX = "human-binding:";
export const isGroupOrigin = (origin: VerifiedHumanOrigin) => origin.platform === "whatsapp" && origin.userId.endsWith("@g.us");
export function isGroupPrincipal(principal: HumanPrincipal): boolean {
  const value = binding(principal.bindingId);
  return !!value && isGroupOrigin(value.origin);
}
function scope(db: DatabaseSync, kind: string, owner: string): string {
  const old = scopeRow(db, kind, owner);
  if (old) return String(old.id);
  const id = randomUUID(); db.prepare("INSERT INTO memory_scopes VALUES(?,?,?,'[]',0)").run(id, kind, owner); return id;
}
function binding(id: string, db = database()): Binding | undefined {
  const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='human-binding'").get(id);
  return row ? JSON.parse(String(row.intent)) : undefined;
}
function save(value: Binding, db = database()) {
  const scopeId = scope(db, "preferences", "person:" + (value.personId ?? value.id));
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-binding',?,?,'granted',?) ON CONFLICT(id) DO UPDATE SET scope_id=excluded.scope_id,revision=excluded.revision,intent=excluded.intent")
    .run(value.id, scopeId, value.id, value.revision, JSON.stringify(value));
}
function revoke(db: DatabaseSync) { db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1"); revokeAllDisclosures(db,"human-principal"); }
/** Call only from a channel service after its provider identity and sender binding were verified. */
export function observeVerifiedHuman(origin: VerifiedHumanOrigin, display?: SenderDisplay): string {
  for (const value of Object.values(origin)) if (typeof value !== "string" || !value || value.length > 200) throw new Error("HUMAN_ORIGIN_INVALID");
  const id = PREFIX + createHash("sha256").update(JSON.stringify([origin.platform, origin.authorityId, origin.userId, origin.connectionId])).digest("hex");
  const shown = cleanDisplay(display);
  transaction(db => {
    const old = binding(id, db);
    if (isGroupOrigin(origin)) {
      const personId = "whatsapp-group:" + id;
      if (!old || !old.active || old.personId !== personId) {
        save({ id, origin: { ...origin }, personId, revision: (old?.revision ?? 0) + 1, active: true, ...(shown ? { display: shown } : {}) }, db);
        revoke(db);
      }
      return;
    }
    if (!old) save({ id, origin: { ...origin }, personId: null, revision: 1, active: true, ...(shown ? { display: shown } : {}) }, db);
    else if (!old.active) { old.active = true; old.personId=null; old.revision++; if (shown) old.display = shown; save(old, db); revoke(db); }
    // A new display name is not a new person: same revision, nothing revoked.
    else if (shown && JSON.stringify(old.display) !== JSON.stringify(shown)) { old.display = shown; save(old, db); }
  });
  return id;
}
export function humanBindingStatus(ticket: object) {
  requireMemoryOwner(ticket);
  const db = database();
  return { ownerPersonId: WORKSPACE_OWNER, bindings: db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='human-binding' ORDER BY id").all()
    .map(row => JSON.parse(String(row.intent)) as Binding).map(value => ({ ...value, state: !value.active ? "inactive" : value.personId ? "linked" : "link-required" })),
    // Owner person shares are read back, so the people controls never present an assumed grant.
    shares: db.prepare("SELECT subject_id,scope_id,state,revision FROM memory_scope_bindings WHERE subject_type='person' ORDER BY subject_id,scope_id").all()
      .map(row => ({ personId: String(row.subject_id), scopeId: String(row.scope_id), granted: row.state === "granted", revision: Number(row.revision) })) };
}
/** Only the local owner can equate accounts. A missing person id explicitly creates a different person. */
export function linkHumanBinding(ticket: object, input: { bindingId: string; expectedRevision: number; personId?: string; as: "owner" | "person" | "unlink" }) {
  requireMemoryOwner(ticket);
  return transaction(db => {
    const value = binding(input.bindingId, db);
    if (!value || !value.active) throw new Error("HUMAN_BINDING_UNAVAILABLE");
    if (value.revision !== input.expectedRevision) throw new Error("MEMORY_VERSION_CONFLICT");
    if (isGroupOrigin(value.origin)) throw new Error(input.as === "owner" ? "HUMAN_OWNER_INELIGIBLE" : "HUMAN_GROUP_IMMUTABLE");
    if (input.personId?.startsWith("whatsapp-group:")) throw new Error("HUMAN_GROUP_IMMUTABLE");
    let personId: string | null = null;
    if (input.as === "owner") {
      // WhatsApp: the owner is the linked number and nothing else (design 5.1). A contact or group binding names a
      // different userId than the linking authority, so the server refuses it here whatever the caller asked for.
      if (value.origin.platform === "whatsapp" && value.origin.userId !== value.origin.authorityId) throw new Error("HUMAN_OWNER_INELIGIBLE");
      personId = WORKSPACE_OWNER;
    }
    if (input.as === "person") {
      personId = input.personId ?? randomUUID();
      if (personId === WORKSPACE_OWNER || input.personId && !db.prepare("SELECT 1 FROM memory_scopes WHERE kind='preferences' AND owner_key=?").get("person:" + personId)) throw new Error("HUMAN_PERSON_UNKNOWN");
    }
    value.personId = personId; value.revision++; save(value, db); revoke(db);
    return { bindingId: value.id, personId, revision: value.revision };
  });
}
export function revokeHumanConnection(platform: VerifiedHumanOrigin["platform"], connectionId: string) {
  transaction(db => {
    let changed = false;
    for (const row of db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='human-binding'").all()) {
      const value = JSON.parse(String(row.intent)) as Binding;
      if (value.active && value.origin.platform === platform && value.origin.connectionId === connectionId) { value.active = false; value.revision++; save(value, db); changed = true; }
    }
    if (changed) revoke(db);
  });
}
export function resolveHumanBinding(id: string): HumanPrincipal {
  const value = binding(id);
  if (!value?.active || !value.personId) throw new Error("HUMAN_LINK_REQUIRED: link this verified channel account to a person in Murage settings before sending messages");
  return Object.freeze({ personId: value.personId, bindingId: value.id, revision: value.revision });
}
export function assertHumanPrincipal(principal: HumanPrincipal) {
  if (principal.bindingId === "local" && principal.personId === WORKSPACE_OWNER && principal.revision === 1) return;
  const current = resolveHumanBinding(principal.bindingId);
  if (JSON.stringify(current) !== JSON.stringify(principal)) throw new Error("HUMAN_BINDING_REVOKED");
}
/** A thread's human binding, remembered (1.0.3: about 10,000 reads a second of
 * `SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='human-thread'`, one per task/thread per route). The memory is
 * used only inside an explicit synchronous scope (withBindingScope, entered by the hot callers: homeThread, projectBotForTask, the
 * working-context build, an eligibility pass); outside one every ask reads the row, so a callback queued anywhere never meets a memory
 * made by someone else's run (Astra iohot2 Low #4). Inside a scope a memory is trusted only while (1) this connection has not written
 * memory_scope_bindings since it was made (an insert, update, delete, a failed binding write, a rollback, an aborted transaction:
 * bindingRowsStamp, checked on every ask) and (2) no other connection has committed since (SQLite's `PRAGMA data_version`, which moves on
 * any other connection's commit and never on this one's, read on the first ask of every scope): within one scope it answers as a read at
 * the scope's first ask would. A handle that is not instrumented has no stamp and is read every time. Many distinct threads switch to one
 * read of every binding, when there are at most BULK_MAX of them; past that the memory holds at most POINT_MAX threads, each read once.
 * One memory per handle: a replaced memory is emptied at once. */
interface BindingMemo { stamp: number; version: number; run: number; byThread: Map<string, HumanPrincipal | null>; misses: number; all: boolean }
const bindingMemos = new WeakMap<object, BindingMemo>();
/** The open scope (0: none). Each outermost scope takes a new number, so data_version is read once per scope. */
let bindingScope = 0, bindingScopeDepth = 0, bindingScopes = 0;
/** Runs `work` (synchronous) with thread bindings remembered inside it. Nested scopes share the outer one. The scope ends when `work`
 * returns: anything it left to run later (a promise's continuation, a timer) runs outside it and reads every binding directly. */
export function withBindingScope<T>(work: () => T): T {
  if (bindingScopeDepth++ === 0) bindingScope = ++bindingScopes;
  try { return work(); } finally { if (--bindingScopeDepth === 0) bindingScope = 0; }
}
const BULK_AFTER_MISSES = 8;
/** The most bindings one bulk read loads, and the most threads a point memory holds. */
export const BINDING_MEMO_LIMITS = { BULK_MAX: 20_000, POINT_MAX: 4_096 };
const memoStatements = new WeakMap<object, { point: StatementSync; bulk: StatementSync; version: StatementSync }>();
function memoStatementsOf(db: DatabaseSync) {
  let held = memoStatements.get(db);
  if (!held) memoStatements.set(db, held = {
    point: db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='human-thread'"),
    bulk: db.prepare("SELECT id, intent FROM memory_scope_bindings WHERE subject_type='human-thread' LIMIT ?"),
    version: db.prepare("PRAGMA data_version"),
  });
  return held;
}
const principalOf = (intent: unknown): HumanPrincipal | null => intent === undefined || intent === null ? null : Object.freeze(JSON.parse(String(intent))) as HumanPrincipal;
function bindingOf(db: DatabaseSync, threadId: string): HumanPrincipal | null {
  const stamp = bindingRowsStamp(db);
  if (stamp === undefined) return principalOf(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='human-thread'").get("human-thread:" + threadId)?.intent);
  const statements = memoStatementsOf(db);
  // outside a scope: the row as it is now, and no memory made or kept
  if (bindingScope === 0) return principalOf(statements.point.get("human-thread:" + threadId)?.intent);
  let memo = bindingMemos.get(db);
  // (another connection's commit: data_version, read on the first ask of each scope and whenever there is no memory to trust)
  const version = memo && memo.run === bindingScope && memo.stamp === stamp ? memo.version : Number(statements.version.get()?.data_version);
  if (!memo || memo.stamp !== stamp || memo.version !== version) {
    if (memo) { memo.byThread.clear(); memo.all = false; }
    memo = { stamp, version, run: bindingScope, byThread: new Map(), misses: 0, all: false };
    bindingMemos.set(db, memo);
  }
  memo.run = bindingScope;
  const known = memo.byThread.get(threadId);
  if (known !== undefined) return known;
  if (memo.all) return null;  // every binding was read: a thread not among them has none
  let principal: HumanPrincipal | null;
  if (++memo.misses === BULK_AFTER_MISSES + 1) {
    const rows = statements.bulk.all(BINDING_MEMO_LIMITS.BULK_MAX + 1);
    if (rows.length <= BINDING_MEMO_LIMITS.BULK_MAX) {
      memo.byThread.clear();
      for (const row of rows) {
        const id = String(row.id);
        if (id.startsWith("human-thread:")) memo.byThread.set(id.slice("human-thread:".length), principalOf(row.intent));
      }
      memo.all = true;
      principal = memo.byThread.get(threadId) ?? null;
    } else principal = principalOf(statements.point.get("human-thread:" + threadId)?.intent);  // too many to hold: point reads, bounded
  } else principal = principalOf(statements.point.get("human-thread:" + threadId)?.intent);
  if (!memo.all) {
    if (memo.byThread.size >= BINDING_MEMO_LIMITS.POINT_MAX) memo.byThread.clear();
    memo.byThread.set(threadId, principal);
  }
  if (bindingRowsStamp(db) !== stamp) { memo.byThread.clear(); memo.all = false; bindingMemos.delete(db); }  // the read itself wrote: not remembered
  return principal;
}
export function threadHumanPrincipal(threadId: string, db = database()): HumanPrincipal {
  return bindingOf(db, threadId) ?? OWNER;
}
export function bindHumanThread(threadId: string, principal: HumanPrincipal) {
  assertHumanPrincipal(principal);
  const db = database(), id = "human-thread:" + threadId;
  const old = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(id);
  if (old) { if (String(old.intent) !== JSON.stringify(principal)) throw new Error("HUMAN_THREAD_IMMUTABLE"); return; }
  // Binding must precede the first captured source: old transcripts never change audience.
  if (db.prepare("SELECT 1 FROM messages WHERE thread_id=? LIMIT 1").get(threadId) || db.prepare("SELECT 1 FROM memory_sources WHERE thread_id=? LIMIT 1").get(threadId)) throw new Error("HUMAN_THREAD_NOT_EMPTY");
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-thread',?,?,'granted',?)")
    .run(id, scope(db, "conversation", threadId), threadId, principal.revision, JSON.stringify(principal));
}
export function sameHumanAudience(a: HumanPrincipal, b: HumanPrincipal) { return a.personId === b.personId; }
export function isLocalOwner(principal: HumanPrincipal) { return principal.personId === OWNER.personId && principal.bindingId === OWNER.bindingId && principal.revision === OWNER.revision; }
export function isWorkspaceOwner(principal: HumanPrincipal) { return principal.personId === WORKSPACE_OWNER; }

/** Server-selected task; exact binding revision prevents old native-session reuse after relinking. */
export function humanTask(store: Store, botId: string, principal: HumanPrincipal) {
  assertHumanPrincipal(principal);
  const bot=store.bot(botId); if(!bot)return null;
  if (isLocalOwner(principal)) return homeThread(bot);
  const want=JSON.stringify(principal),exact=(threadId:string)=>{const found=threadHumanPrincipal(threadId);return found.personId===principal.personId&&JSON.stringify(found)===want;};
  let task=bot.tasks?.find(task=>exact(task.threadId));
  if(!task){task=store.createTask(botId,"Channel conversation",false)??undefined;if(!task)return null;bindHumanThread(task.threadId,principal);}
  if(!isWorkspaceOwner(principal))store.patchTask(botId,task.threadId,{autoApprove:false,alwaysAllow:[]});
  return task;
}

export function humanMayReadRecord(db: DatabaseSync,id:string,version:number,principal:HumanPrincipal):boolean {
  if(isWorkspaceOwner(principal))return true;
  const row=db.prepare("SELECT d.partition,d.entities,s.kind FROM memory_record_details d JOIN memory_records r ON r.id=d.record_id AND r.version=d.record_version JOIN memory_scopes s ON s.id=r.scope_id WHERE r.id=? AND r.version=?").get(id,version);
  return !row || row.partition!=="identity" || row.kind!=="bot" && !JSON.parse(String(row.entities)).includes("owner-private");
}
/** The scope kinds the owner may share with a linked person: what the share screen offers (src/components/MemoryPeople.tsx SHAREABLE_KINDS). */
export const SHAREABLE_SCOPE_KINDS: ReadonlySet<string> = new Set(["room", "project", "team", "workspace"]);
export function shareHumanScope(ticket:object,input:{personId:string;scopeId:string;granted:boolean}) {
  requireMemoryOwner(ticket);
  return transaction(db=>{
    if(input.personId.startsWith("whatsapp-group:"))throw new Error("HUMAN_GROUP_IMMUTABLE");
    if(!db.prepare("SELECT 1 FROM memory_scopes WHERE kind='preferences' AND owner_key=?").get("person:"+input.personId))throw new Error("HUMAN_PERSON_UNKNOWN");
    const scope=db.prepare("SELECT kind FROM memory_scopes WHERE id=?").get(input.scopeId);
    if(!scope)throw new Error("MEMORY_SCOPE_UNKNOWN");
    // only the kinds the share screen offers (a channel, a shared folder, a team, the workspace; SL-E r3.2); withdrawing any grant stays open
    if(input.granted&&!SHAREABLE_SCOPE_KINDS.has(String(scope.kind)))throw new Error("MEMORY_SCOPE_NOT_SHAREABLE");
    const id="human-share:"+createHash("sha256").update(JSON.stringify([input.personId,input.scopeId])).digest("hex");
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'person',?,1,?,'{}') ON CONFLICT(id) DO UPDATE SET revision=revision+1,state=excluded.state").run(id,input.scopeId,input.personId,input.granted?"granted":"revoked");
    revoke(db);return {personId:input.personId,scopeId:input.scopeId,granted:input.granted};
  });
}

/** Freeze the sender at first admission, including refusals, before the cross-file queue can retry. */
export function resolveHumanDelivery(bindingId:string,deliveryId:string):HumanPrincipal {
  const id="human-delivery:"+createHash("sha256").update(JSON.stringify([bindingId,deliveryId])).digest("hex");
  const db=database();
  let row=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='human-delivery'").get(id);
  if(!row){
    const value=binding(bindingId),principal=value?.active&&value.personId?{personId:value.personId,bindingId,revision:value.revision}:null;
    const intent=JSON.stringify({principal});
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-delivery',?,1,'granted',?)").run(id,scope(db,"preferences","delivery:"+bindingId),bindingId,intent);
    row={intent};
  }
  const principal=JSON.parse(String(row.intent)).principal as HumanPrincipal|null;
  if(!principal)throw new Error("HUMAN_LINK_REQUIRED");
  assertHumanPrincipal(principal);return Object.freeze(principal);
}
/** Channel user ids of the workspace owner's own linked accounts (Telegram,
 * Slack, Discord). Read by the stop line (server/stop-line.ts): a message to
 * the owner is never "someone new". Only active bindings linked to the owner. */
export function ownerChannelUserIds(db = database()): string[] {
  return db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='human-binding'").all()
    .map((row) => JSON.parse(String(row.intent)) as Binding)
    .filter((value) => value.active && value.personId === WORKSPACE_OWNER)
    .map((value) => value.origin.userId);
}
/** The channel user id of the person this thread is with, when it is a
 * channel conversation with someone verified (undefined for the desktop). */
export function threadHumanChannelUserId(threadId: string, db = database()): string | undefined {
  const principal = threadHumanPrincipal(threadId, db);
  if (principal.bindingId === "local") return undefined;
  const value = binding(principal.bindingId, db);
  return value?.active ? value.origin.userId : undefined;
}

/** Names and usernames channel senders go by, with each part of a full name (R3-04): what a customer-turn guard must not let through. */
export function knownHumanNames(db: DatabaseSync = database()): string[] {
  const out = new Set<string>();
  for (const row of db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='human-binding'").all()) {
    let display: SenderDisplay | undefined;
    try { display = (JSON.parse(String(row.intent)) as Binding).display; } catch { continue; }
    if (display?.name) { out.add(display.name); for (const part of display.name.split(/\s+/)) if (part.length >= 2) out.add(part); }
    if (display?.username) out.add(display.username);
  }
  return [...out];
}
