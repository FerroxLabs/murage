import { createHash, randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import type { InternalCapability, InternalCapabilities } from "../internal-capabilities.ts";
import type { MemoryScopeKind } from "../../shared/memory.ts";
import { memoryState } from "./repository.ts";

export interface MemoryRoster {
  bots: Array<{id: string; threadId: string; section?: string; tasks?: Array<{threadId: string}>}>;
  groups: Array<{id: string; threadId: string; section?: string; memberIds: string[]; tasks?: Array<{threadId: string}>}>;
}
export interface MemoryAccess {
  botId: string; threadId: string; generation: string; policyRevision: number; deletionEpoch: number;
  scopeIds: readonly string[];
}
const contexts = new WeakMap<MemoryAccess, {claim: InternalCapability; registry: InternalCapabilities; roster: () => MemoryRoster}>();
const POLICY_ID = "memory-roster-policy";

export function ensureScope(kind: MemoryScopeKind, owner: string): string {
  const db = database();
  const row = db.prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").get(kind,owner);
  if (row) return String(row.id);
  const id = randomUUID();
  db.prepare("INSERT INTO memory_scopes VALUES(?,?,?,'[]',0)").run(id,kind,owner);
  return id;
}

function rosterSnapshot(roster: MemoryRoster) {
  // Active-task selection changes presentation, not the authorized thread set.
  // The active thread usually also appears in tasks; duplicate counts must not
  // revoke running background turns when the owner opens another task.
  const bots = roster.bots.map(b => ({id:b.id, section:b.section?.trim() || "", threads:[...new Set([b.threadId,...(b.tasks??[]).map(t=>t.threadId)])].sort()})).sort((a,b)=>a.id.localeCompare(b.id));
  const groups = roster.groups.map(g => ({id:g.id, section:g.section?.trim() || "", members:[...g.memberIds].sort(), threads:[...new Set([g.threadId,...(g.tasks??[]).map(t=>t.threadId)])].sort()})).sort((a,b)=>a.id.localeCompare(b.id));
  return {bots,groups};
}
function snapshotHash(snapshot: ReturnType<typeof rosterSnapshot>) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
function fingerprint(roster: MemoryRoster) { return snapshotHash(rosterSnapshot(roster)); }
function rosterIntent(roster: MemoryRoster) {
  const snapshot = rosterSnapshot(roster);
  return JSON.stringify({hash:snapshotHash(snapshot),snapshot});
}
/** Creating a new peer channel cannot change access on an existing thread.
 * Only exempt that exact additive case; unknown legacy snapshots fail closed. */
function onlyAddsIndependentRooms(intent: string, roster: MemoryRoster): boolean {
  try {
    const previous = JSON.parse(intent) as {hash: string; snapshot?: ReturnType<typeof rosterSnapshot>};
    const old = previous.snapshot, next = rosterSnapshot(roster);
    if (!old || !Array.isArray(old.bots) || !Array.isArray(old.groups)
      || snapshotHash(old) !== previous.hash || JSON.stringify(old.bots) !== JSON.stringify(next.bots)) return false;
    const oldGroups = new Map(old.groups.map(group => [group.id, group]));
    const nextGroups = new Map(next.groups.map(group => [group.id, group]));
    if (oldGroups.size !== old.groups.length || nextGroups.size !== next.groups.length
      || nextGroups.size <= oldGroups.size) return false;
    for (const [id, group] of oldGroups) {
      if (JSON.stringify(nextGroups.get(id)) !== JSON.stringify(group)) return false;
    }
    // A room/task aliasing a private or another room thread changes eligibleScopes.
    const occupied = new Set([...old.bots, ...old.groups].flatMap(item => item.threads));
    for (const group of next.groups) {
      if (oldGroups.has(group.id)) continue;
      for (const thread of new Set(group.threads)) {
        if (occupied.has(thread)) return false;
        occupied.add(thread);
      }
    }
    return true;
  } catch { return false; }
}
function policyRow() { return database().prepare("SELECT state,intent FROM memory_scope_bindings WHERE id=?").get(POLICY_ID); }

/** Restriction is durable BEFORE the roster file changes. Failure leaves it closed. */
export function persistMemoryRoster(roster: MemoryRoster, persist: () => void) {
  const hash = fingerprint(roster);
  const previous = policyRow();
  if (previous?.state === "granted" && JSON.parse(String(previous.intent)).hash === hash) { persist(); return; }
  if (previous?.state === "granted" && onlyAddsIndependentRooms(String(previous.intent), roster)) {
    persist();
    reconcileMemoryRoster(roster);
    return;
  }
  transaction(db => {
    const scopeId = ensureScope("workspace", memoryState().installationId);
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,'system','roster',?,'pending',?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state='pending',intent=excluded.intent")
      .run(POLICY_ID,scopeId,memoryState().policyRevision,rosterIntent(roster));
    db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'").run();
  });
  persist();
  reconcileMemoryRoster(roster);
}

/** Caller supplies the already-validated durable roster on startup, never model data. */
export function reconcileMemoryRoster(roster: MemoryRoster) {
  transaction(db => {
    const prior = policyRow();
    if (prior && JSON.parse(String(prior.intent)).hash !== fingerprint(roster)
      && !(prior.state === "granted" && onlyAddsIndependentRooms(String(prior.intent), roster))) {
      db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
      db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'").run();
    }
    const scope = ensureScope("workspace", memoryState().installationId);
    for (const bot of roster.bots) {
      ensureScope("bot",bot.id); ensureScope("team",bot.section?.trim() || "");
      for (const id of new Set([bot.threadId,...(bot.tasks??[]).map(t=>t.threadId)])) ensureScope("conversation",id);
    }
    for (const group of roster.groups) {
      ensureScope("room",group.id);
      for (const id of new Set([group.threadId,...(group.tasks??[]).map(t=>t.threadId)])) ensureScope("conversation",id);
    }
    db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,'system','roster',?,'granted',?) ON CONFLICT(id) DO UPDATE SET state='granted',intent=excluded.intent,revision=excluded.revision")
      .run(POLICY_ID,scope,memoryState().policyRevision,rosterIntent(roster));
  });
}

function eligibleScopes(botId: string, threadId: string, roster: MemoryRoster): string[] {
  const bot = roster.bots.find(b => b.id === botId);
  if (!bot) return [];
  const group = roster.groups.find(g => g.threadId === threadId || g.tasks?.some(t => t.threadId === threadId));
  if (group && !group.memberIds.includes(botId)) return [];
  if (!group && bot.threadId !== threadId && !bot.tasks?.some(t => t.threadId === threadId)) return [];
  const db = database();
  const scopes: string[] = [];
  const add = (kind: string, owner: string) => {
    const row = db.prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").get(kind,owner);
    if (row) scopes.push(String(row.id));
  };
  add("conversation",threadId);
  if (group) add("room",group.id);
  else { add("bot",botId); add("team",bot.section?.trim() || ""); }
  const subjectType = group ? "room" : "bot", subjectId = group?.id ?? botId;
  for (const row of db.prepare("SELECT scope_id FROM memory_scope_bindings WHERE subject_type=? AND subject_id=? AND state='granted'").all(subjectType,subjectId)) scopes.push(String(row.scope_id));
  return [...new Set(scopes)];
}

export function memoryAccess(registry: InternalCapabilities, claim: InternalCapability, roster: () => MemoryRoster): MemoryAccess {
  if (claim.kind !== "memory" || !registry.isActive(claim)) throw new Error("MEMORY_UNAUTHORIZED");
  const state = memoryState();
  if (policyRow()?.state !== "granted") throw new Error("MEMORY_POLICY_PENDING");
  const scopeIds = eligibleScopes(claim.botId,claim.threadId,roster());
  if (!scopeIds.length) throw new Error("MEMORY_UNAUTHORIZED");
  const access = Object.freeze({botId:claim.botId,threadId:claim.threadId,generation:claim.generation,policyRevision:state.policyRevision,deletionEpoch:state.deletionEpoch,scopeIds:Object.freeze(scopeIds)});
  contexts.set(access,{claim,registry,roster}); return access;
}

export function assertMemoryAccess(access: MemoryAccess, scope?: string) {
  const trusted = contexts.get(access), state = memoryState();
  if (!trusted || !trusted.registry.isActive(trusted.claim)) throw new Error("MEMORY_UNAUTHORIZED");
  if (state.policyRevision !== access.policyRevision || state.deletionEpoch !== access.deletionEpoch || policyRow()?.state !== "granted") throw new Error("MEMORY_CONTEXT_REVOKED");
  const current = eligibleScopes(access.botId,access.threadId,trusted.roster());
  if (!current.length || scope && (!current.includes(scope) || !access.scopeIds.includes(scope))) throw new Error("MEMORY_SCOPE_DENIED");
}
