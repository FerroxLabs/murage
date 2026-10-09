import { executionStore, threadPartition, isHomePartition, partitionScopeKey, sameThreadPartition } from "../execution-audience.ts";
import { teamMemoryKey } from "../team-identities.ts";
import { isGroupPrincipal, threadHumanPrincipal, assertHumanPrincipal, isWorkspaceOwner, sameHumanAudience, WORKSPACE_OWNER, type HumanPrincipal } from "../human-principals.ts";
import { createHash, randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import type { InternalCapability, InternalCapabilities } from "../internal-capabilities.ts";
import type { MemoryScopeKind } from "../../shared/memory.ts";
import { memoryState } from "./repository.ts";
import { threadMemoryRoom } from "./capture-scope.ts";
import { scopeRow } from "./scope-id.ts";
import { eligibilityAnswer, inEligibilityPass, passLookup } from "./eligibility-pass.ts";
import { revokeAllDisclosures } from "./revocation.ts";

export interface MemoryRoster {
  bots: Array<{name?: string; id: string; threadId: string; section?: string; tasks?: Array<{threadId: string; sharedWork?: {teamId: string; quarantined?: boolean}; channelProjectDesk?: {groupId: string; archivedAt?: number}}>}>;
  groups: Array<{name?: string; id: string; threadId: string; section?: string; memberIds: string[]; tasks?: Array<{threadId: string}>; dm?: boolean; channelProject?: unknown}>;
}
export interface MemoryAccess {
  botId: string; threadId: string; generation: string; policyRevision: number; deletionEpoch: number;
  scopeIds: readonly string[];
  humanPrincipal: HumanPrincipal;
}
const contexts = new WeakMap<MemoryAccess, {claim: InternalCapability; registry: InternalCapabilities; roster: () => MemoryRoster}>();
const POLICY_ID = "memory-roster-policy";

export function ensureScope(kind: MemoryScopeKind, owner: string): string {
  const db = database();
  const row = scopeRow(db, kind,owner);
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
/** New rooms or collision-free tasks with unchanged audiences cannot change
 * access on existing threads. Unknown legacy snapshots still fail closed. */
function onlyAddsIndependentRoomThreads(intent: string, roster: MemoryRoster): boolean {
  try {
    const previous = JSON.parse(intent) as {hash: string; snapshot?: ReturnType<typeof rosterSnapshot>};
    const old = previous.snapshot, next = rosterSnapshot(roster);
    if (!old || !Array.isArray(old.bots) || !Array.isArray(old.groups)
      || snapshotHash(old) !== previous.hash || JSON.stringify(old.bots) !== JSON.stringify(next.bots)) return false;
    const oldGroups = new Map(old.groups.map(group => [group.id, group]));
    const nextGroups = new Map(next.groups.map(group => [group.id, group]));
    if (oldGroups.size !== old.groups.length || nextGroups.size !== next.groups.length
      || nextGroups.size < oldGroups.size) return false;
    for (const [id, group] of oldGroups) {
      const candidate=nextGroups.get(id);
      if (!candidate || candidate.section!==group.section || JSON.stringify(candidate.members)!==JSON.stringify(group.members)
        || group.threads.some(thread=>!candidate.threads.includes(thread))) return false;
    }
    // New tasks must not alias private or other-room authority. Existing
    // mappings and audiences above are immutable throughout this exemption.
    const occupied = new Set([...old.bots, ...old.groups].flatMap(item => item.threads));
    let added=false;
    for (const group of next.groups) {
      const previousThreads=new Set(oldGroups.get(group.id)?.threads??[]);
      for (const thread of new Set(group.threads)) {
        if(previousThreads.has(thread))continue;
        if (occupied.has(thread)) return false;
        occupied.add(thread);added=true;
      }
    }
    return added;
  } catch { return false; }
}
/** A single fresh owner task on an existing bot adds no authority to any
 * existing thread. Do not exempt imports, bound-person contexts, aliases,
 * removals, or a combined roster/membership edit. */
function onlyAddsIndependentOwnerTask(intent:string,roster:MemoryRoster):boolean {
  try {
    const previous=JSON.parse(intent) as {hash:string;snapshot?:ReturnType<typeof rosterSnapshot>};
    const old=previous.snapshot,next=rosterSnapshot(roster);
    if(!old||!Array.isArray(old.bots)||!Array.isArray(old.groups)||snapshotHash(old)!==previous.hash||JSON.stringify(old.groups)!==JSON.stringify(next.groups)||old.bots.length!==next.bots.length)return false;
    const bots=new Map(next.bots.map(bot=>[bot.id,bot]));
    if(bots.size!==next.bots.length||new Set(old.bots.map(bot=>bot.id)).size!==old.bots.length)return false;
    const occupied=new Set([...old.bots,...old.groups].flatMap(item=>item.threads));
    let additions=0;
    for(const bot of old.bots){
      const candidate=bots.get(bot.id);
      if(!candidate||candidate.section!==bot.section||bot.threads.some(thread=>!candidate.threads.includes(thread)))return false;
      for(const thread of candidate.threads){
        if(bot.threads.includes(thread))continue;
        if(occupied.has(thread)||++additions>1)return false;
        const principal=threadHumanPrincipal(thread);assertHumanPrincipal(principal);
        if(!isWorkspaceOwner(principal))return false;
        // Fresh factory-generated IDs cannot reuse an orphaned transcript or
        // previously registered scope that happens to be absent from roster.
        const db=database();
        if(db.prepare("SELECT 1 FROM memory_scopes WHERE kind='conversation' AND owner_key=?").get(thread)
          ||db.prepare("SELECT 1 FROM messages WHERE thread_id=? LIMIT 1").get(thread)
          ||db.prepare("SELECT 1 FROM memory_sources WHERE thread_id=? LIMIT 1").get(thread))return false;
        occupied.add(thread);
      }
    }
    return additions===1;
  }catch{return false;}
}
function policyRow() { return database().prepare("SELECT state,intent FROM memory_scope_bindings WHERE id=?").get(POLICY_ID); }

/** Restriction is durable BEFORE the roster file changes. Failure leaves it closed. */
export function persistMemoryRoster(roster: MemoryRoster, persist: () => void) {
  const hash = fingerprint(roster);
  const previous = policyRow();
  if (previous?.state === "granted" && JSON.parse(String(previous.intent)).hash === hash) { persist(); return; }
  if (previous?.state === "granted" && (onlyAddsIndependentRoomThreads(String(previous.intent), roster)||onlyAddsIndependentOwnerTask(String(previous.intent),roster))) {
    persist();
    reconcileMemoryRoster(roster);
    return;
  }
  transaction(db => {
    const scopeId = ensureScope("workspace", memoryState().installationId);
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,'system','roster',?,'pending',?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state='pending',intent=excluded.intent")
      .run(POLICY_ID,scopeId,memoryState().policyRevision,rosterIntent(roster));
    revokeAllDisclosures(db,"roster");
  });
  persist();
  reconcileMemoryRoster(roster);
}

/** Caller supplies the already-validated durable roster on startup, never model data. */
export function reconcileMemoryRoster(roster: MemoryRoster) {
  transaction(db => {
    const prior = policyRow();
    if (prior && JSON.parse(String(prior.intent)).hash !== fingerprint(roster)
      && !(prior.state === "granted" && (onlyAddsIndependentRoomThreads(String(prior.intent), roster)||onlyAddsIndependentOwnerTask(String(prior.intent),roster)))) {
      db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
      revokeAllDisclosures(db,"roster-reconcile");
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

/** notOwnerAudience: the turn's words were not proven to be the owner's
 * (0.1.61). It reads like a stranger in the owner's own thread: the
 * conversation and room it runs in, never the bot's or team's memory, the
 * owner's preferences or anything the owner shared. */
function eligibleScopes(botId: string, threadId: string, roster: MemoryRoster, notOwnerAudience = false): string[] {
  const bot = roster.bots.find(b => b.id === botId);
  if (!bot) return [];
  const group = roster.groups.find(g => g.threadId === threadId || g.tasks?.some(t => t.threadId === threadId));
  if (group && !group.memberIds.includes(botId)) return [];
  if (!group && bot.threadId !== threadId && !bot.tasks?.some(t => t.threadId === threadId)) return [];
  const db = database();
  const principal=threadHumanPrincipal(threadId);
  assertHumanPrincipal(principal);
  const owner=isWorkspaceOwner(principal) && !notOwnerAudience;
  const scopes: string[] = [];
  const add = (kind: string, owner: string) => {
    const row = scopeRow(db, kind,owner);
    if (row) scopes.push(String(row.id));
  };
  // Private continuity belongs to the bot's owned direct tasks, not its current
  // model/session. Never infer a private grant from an aliased room/other bot.
  const foreignThreads = new Set([
    ...roster.bots.filter(other => other.id !== botId).flatMap(other => [other.threadId,...(other.tasks??[]).map(task=>task.threadId)]),
    ...roster.groups.flatMap(room => [room.threadId,...(room.tasks??[]).map(task=>task.threadId)]),
  ]);
  if (!group && foreignThreads.has(threadId)) return [];
  add("conversation",threadId);
  if (isGroupPrincipal(principal)) return scopes;
  const excluded = new Set(db.prepare("SELECT e.value FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'").all().map(row=>String(row.value)));
  /** The bot's own direct chat and tasks the owner keeps in memory. */
  const ownThreads = () => [...new Set([bot.threadId,...(bot.tasks??[]).map(task=>task.threadId)])]
    .filter(owned => !foreignThreads.has(owned) && !excluded.has(owned) && sameHumanAudience(principal,threadHumanPrincipal(owned)));
  /** A room's own threads (main chat and task threads). Before 0.1.61 each
   * captured into its own conversation scope, so reaching a room means
   * reaching those scopes too (plan 3.8: existing sources are not moved). */
  const roomThreads = (room: MemoryRoster["groups"][number]) => [...new Set([room.threadId,...(room.tasks??[]).map(task=>task.threadId)])]
    .filter(thread => !excluded.has(thread));
  if (group) {
    add("room",group.id);
    // the room's other threads (its goal and task threads, R3): an
    // owner-audience turn only, same audience only (Astra r2 #17)
    if(owner)for(const thread of roomThreads(group))if(thread!==threadId && sameHumanAudience(principal,threadHumanPrincipal(thread)))add("conversation",thread);
    // A member is the same bot in a room as in a direct chat: when the room's
    // only human is the owner, it also recalls its OWN bot memory and its
    // team's memory (adapted from OpenMausBot), and since 0.1.61 (lane M,
    // "recall both ways") its own direct chat and tasks. A room whose audience
    // is a channel person keeps the room-only boundary; owner shares still
    // apply through the person bindings below. Never another member's scopes.
    if(owner){add("bot",botId); add("team",bot.section?.trim() || ""); for(const owned of ownThreads())add("conversation",owned);}
  } else {
    if(owner){add("bot",botId); add("team",bot.section?.trim() || "");}
    // A project desk thread (one of this bot's tasks tagged with a project it
    // is a member of) captures into the project's room scope
    // (capture-scope.ts), so it recalls that scope too: owner audience only.
    const deskRoom = owner ? threadMemoryRoom(threadId, roster) : null;
    // Threads bound to a channel person: never reached from here, whichever
    // room they sit in (their words never enter the room scope either,
    // capture-scope.ts).
    const personThreads = owner ? new Set(db.prepare("SELECT subject_id FROM memory_scope_bindings WHERE subject_type='human-thread' AND json_extract(intent,'$.personId')!=?").all(WORKSPACE_OWNER).map(row=>String(row.subject_id))) : new Set<string>();
    const reachRoom = (room: MemoryRoster["groups"][number]) => { add("room",room.id); for(const thread of roomThreads(room))if(!personThreads.has(thread))add("conversation",thread); };
    const desk = deskRoom ? roster.groups.find(room => room.id === deskRoom) : undefined;
    if(desk)reachRoom(desk);
    // Recall both ways (0.1.61 lane M): on an owner-audience direct turn the
    // bot also recalls the rooms it is a member of whose every thread is the
    // owner's (never a pair room, never a room a channel person is in). A
    // desk thread keeps to its own project.
    if(owner && !deskRoom){
      for(const room of roster.groups)if(!room.dm && room.memberIds.includes(botId)
        && ![room.threadId,...(room.tasks??[]).map(task=>task.threadId)].some(thread=>personThreads.has(thread)))reachRoom(room);
    }
    // Words nobody proved are the owner's get none of the owner's own memory.
    if(notOwnerAudience && isWorkspaceOwner(principal))return filterPartitionScopes(botId, threadId, scopes, owner);
    add("preferences","person:"+principal.personId);
    for (const owned of ownThreads()) add("conversation",owned);
  }
  if (notOwnerAudience && isWorkspaceOwner(principal)) return filterPartitionScopes(botId, threadId, scopes, owner);
  const subjectType = isWorkspaceOwner(principal) ? (group ? "room" : "bot") : "person", subjectId = isWorkspaceOwner(principal) ? (group?.id ?? botId) : principal.personId;
  for (const row of db.prepare("SELECT scope_id FROM memory_scope_bindings WHERE subject_type=? AND subject_id=? AND state='granted'").all(subjectType,subjectId)) scopes.push(String(row.scope_id));
  return filterPartitionScopes(botId, threadId, scopes, owner);
}

/** Final narrowing, after explicit grants; an owner grant cannot bridge a partition. */
function filterPartitionScopes(botId: string, threadId: string, scopes: string[], owner: boolean): string[] {
  const store = executionStore(), bot = store?.bot(botId);
  if (!bot || bot.partitionedAt === undefined) return [...new Set(scopes)];
  const partition = threadPartition(bot, threadId), db = database();
  const allowed = new Set<string>();
  const add = (kind: import("../../shared/memory.ts").MemoryScopeKind, key: string) => allowed.add(ensureScope(kind, key));
  add("conversation", threadId);
  if (partition.kind === "isolated") return [...allowed];
  if (owner) {
    add("bot", `${botId}#general`);
    const key = partitionScopeKey(botId, partition); if (key) add("bot", key);
    if (partition.kind === "team") { const team = teamMemoryKey(partition.teamId); if (team) add("team", team); }
    if (partition.kind === "project" && !isHomePartition(partition) || partition.kind === "room") add("room", partition.groupId);
    const group = store!.groups.find(g => g.threadId === threadId || g.tasks?.some(t => t.threadId === threadId));
    if (partition.kind === "team" && group && !group.dm) add("room", group.id);
  }
  for (const id of scopes) {
    const row = db.prepare("SELECT kind,owner_key FROM memory_scopes WHERE id=?").get(id); if (!row) continue;
    const key = String(row.owner_key);
    if (row.kind === "preferences") { if (owner || key === `person:${threadHumanPrincipal(threadId).personId}`) allowed.add(id); }
    if (row.kind === "conversation" && owner && sameThreadPartition(bot, threadId, key)) allowed.add(id);
    if (row.kind === "room") {
      const room = store!.groups.find(g => g.id === key);
      if (room && (owner && sameThreadPartition(bot, threadId, room.threadId) || !owner && (room.threadId === threadId || room.tasks?.some(t => t.threadId === threadId)))) allowed.add(id);
    }
    if (owner && isHomePartition(partition) && (row.kind === "bot" && key === botId || row.kind === "team" && key === (bot.section?.trim() || ""))) allowed.add(id);
  }
  return [...allowed];
}

/** Is everyone this access answers to the workspace owner: the thread's human
 * and, for this turn, words proven to be the owner's. */
export function memoryAccessIsOwnerAudience(access: MemoryAccess): boolean {
  const trusted = contexts.get(access);
  return Boolean(trusted) && trusted!.claim.notOwnerAudience !== true && isWorkspaceOwner(access.humanPrincipal);
}

/** The turn's words were not proven to be the owner's (the claim flag). Its
 * verdicts are about this reader, never about the receipts themselves. */
export function memoryAccessNotOwnerAudience(access: MemoryAccess): boolean {
  return contexts.get(access)?.claim.notOwnerAudience === true;
}

/** True when this access is a room member's. Owner-private identity records
 * (continuity, canon, reveal state) are never read in a room. */
export function accessIncludesRoom(access: Pick<MemoryAccess, "scopeIds" | "threadId">): boolean {
  // The turn's own thread decides (0.1.61 lane M): a direct turn also
  // recalls its owner-only rooms (recall both ways), and that does not make
  // it a room turn. A room thread and a project desk thread (whose work the
  // room reads) are. Without a trusted roster, any room scope counts.
  const trusted = contexts.get(access as MemoryAccess);
  if (trusted) {
    const roster = trusted.roster();
    return roster.groups.some(group => group.threadId === access.threadId || group.tasks?.some(task => task.threadId === access.threadId))
      || threadMemoryRoom(access.threadId, roster) !== null;
  }
  return Boolean(database().prepare("SELECT 1 FROM memory_scopes WHERE kind='room' AND id IN (SELECT value FROM json_each(?))").get(JSON.stringify(access.scopeIds)));
}

export function memoryAccess(registry: InternalCapabilities, claim: InternalCapability, roster: () => MemoryRoster): MemoryAccess {
  if (claim.kind !== "memory" || !registry.isActive(claim)) throw new Error("MEMORY_UNAUTHORIZED");
  const principal=threadHumanPrincipal(claim.threadId);
  assertHumanPrincipal(principal);
  if(claim.humanPrincipal && JSON.stringify(claim.humanPrincipal)!==JSON.stringify(principal))throw new Error("MEMORY_UNAUTHORIZED");
  if(!claim.humanPrincipal && !isWorkspaceOwner(principal))throw new Error("MEMORY_UNAUTHORIZED");
  const state = memoryState();
  if (policyRow()?.state !== "granted") throw new Error("MEMORY_POLICY_PENDING");
  const scopeIds = eligibleScopes(claim.botId,claim.threadId,roster(),claim.notOwnerAudience===true);
  if (!scopeIds.length) throw new Error("MEMORY_UNAUTHORIZED");
  const access = Object.freeze({botId:claim.botId,threadId:claim.threadId,generation:claim.generation,policyRevision:state.policyRevision,deletionEpoch:state.deletionEpoch,humanPrincipal:principal,scopeIds:Object.freeze(scopeIds)});
  contexts.set(access,{claim,registry,roster}); return access;
}

/** Host background processing reuses current audience policy without minting a
 * tool capability or an owner ticket. This is not a dispatch/disclosure grant. */
export function backgroundMemoryScopes(botId: string, threadId: string, roster: MemoryRoster): readonly string[] {
  const state = memoryState();
  if (!["active", "capture"].includes(state.mode) || policyRow()?.state !== "granted") return [];
  const excluded = database().prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=?").get(threadId);
  if (excluded) return [];
  return Object.freeze(eligibilityAnswer(database(), `${botId}\u0000${threadId}`, roster, () => eligibleScopes(botId, threadId, roster)));
}

export function backgroundMemoryAudience(botId: string, threadId: string, roster: MemoryRoster) {
  const scopeIds = backgroundMemoryScopes(botId, threadId, roster);
  if (!scopeIds.length) return null;
  const principal = threadHumanPrincipal(threadId);
  assertHumanPrincipal(principal);
  const room = roster.groups.find(group => group.threadId === threadId || group.tasks?.some(task => task.threadId === threadId));
  const owner = isWorkspaceOwner(principal);
  const bot = executionStore()?.bot(botId);
  const partition = bot?.partitionedAt !== undefined ? threadPartition(bot, threadId) : undefined;
  const composite = owner && partition && !isHomePartition(partition) ? partitionScopeKey(botId, partition) : null;
  if (partition?.kind === "isolated") return null;
  const kind = composite ? "bot" : room ? "room" : owner ? "bot" : "preferences";
  const key = composite ?? (room ? room.id : owner ? botId : "person:" + principal.personId);
  const scope = scopeRow(database(), kind, key);
  if (!scope || !scopeIds.includes(String(scope.id))) return null;
  return Object.freeze({ botId, threadId, scopeId: String(scope.id), scopeIds,
    audienceKey: composite ? `bot:${composite.replace("#", ":")}:owner` : room ? `room:${room.id}:bot:${botId}` : owner ? `bot:${botId}:owner` : `bot:${botId}:person:${principal.personId}`,
    humanPrincipal: principal });
}

/** Run synchronous `work` so every assertMemoryAccess inside it shares one audience computation. */
export function inMemoryAccessPass<T>(work: () => T): T { return inEligibilityPass(database(), work); }

export function assertMemoryAccess(access: MemoryAccess, scope?: string) {
  const trusted = contexts.get(access);
  if (!trusted || !trusted.registry.isActive(trusted.claim)) throw new Error("MEMORY_UNAUTHORIZED");
  // Inside a synchronous pass the meta row and the policy binding are read once (a row this connection writes ends the memo).
  const { state, granted } = passLookup(database(), "assert-memory-state", () => ({ state: memoryState(), granted: policyRow()?.state === "granted" }));
  if (state.policyRevision !== access.policyRevision || state.deletionEpoch !== access.deletionEpoch || !granted) throw new Error("MEMORY_CONTEXT_REVOKED");
  const roster = trusted.roster(), notOwner = trusted.claim.notOwnerAudience === true;
  // Inside a synchronous pass (hydrating one record, a hit loop) the audience is worked out once; the primary-key re-check still runs once per pass.
  const current = eligibilityAnswer(database(), `assert\u0000${access.botId}\u0000${access.threadId}\u0000${notOwner}`, roster, () => eligibleScopes(access.botId,access.threadId,roster,notOwner));
  if (!current.length || scope && (!current.includes(scope) || !access.scopeIds.includes(scope))) throw new Error("MEMORY_SCOPE_DENIED");
}
