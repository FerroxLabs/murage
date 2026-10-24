import { executionStore, threadPartition, isHomePartition, partitionScopeKey, sameThreadPartition } from "../execution-audience.ts";
import { teamMemoryKey } from "../team-identities.ts";
import { isGroupPrincipal, threadHumanPrincipal, assertHumanPrincipal, isWorkspaceOwner, WORKSPACE_OWNER, type HumanPrincipal } from "../human-principals.ts";
import { createHash, randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import type { InternalCapability, InternalCapabilities } from "../internal-capabilities.ts";
import type { MemoryScopeKind } from "../../shared/memory.ts";
import { memoryState } from "./repository.ts";
import { threadMemoryRoom } from "./capture-scope.ts";
import { scopeRow, scopeRows } from "./scope-id.ts";
import { eligibilityAnswer, inEligibilityPass, passLookup } from "./eligibility-pass.ts";
import { revokeAllDisclosures, revokeThreadDisclosures } from "./revocation.ts";
import { bumpAuthorityHard } from "./authority-epoch.ts";

export interface MemoryRoster {
  bots: Array<{name?: string; id: string; threadId: string; section?: string; tasks?: Array<{threadId: string; sharedWork?: {teamId: string; quarantined?: boolean}; channelProjectDesk?: {groupId: string; archivedAt?: number}}>; partitionedAt?: number}>;
  groups: Array<{name?: string; id: string; threadId: string; section?: string; memberIds: string[]; tasks?: Array<{threadId: string}>; dm?: boolean; channelProject?: unknown; partitionedFor?: Record<string, unknown>; dmAudience?: unknown}>;
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
  // inside transaction() (a SAVEPOINT in the caller's): a background caller (the idle notebook walk) takes the background budget, an owner the usual wait
  transaction(d => d.prepare("INSERT INTO memory_scopes VALUES(?,?,?,'[]',0)").run(id,kind,owner), { op: "scope" });
  return id;
}

/** The facts of a roster that decide who may read what (SCOPED-REVOKES.md section 1): every bot's id, section and threads, every room's id,
 * section, members and threads, and (v2) the partition facts filterPartitionScopes and threadMemoryRoom read: a bot's partition mark, a
 * task's project desk and shared-team work, a room's dm flag and audience, project flag and per-member partition marks. Active-task
 * selection changes presentation, not the authorized thread set: the active thread usually also appears in tasks; duplicate counts must
 * not revoke running background turns when the owner opens another task. */
function rosterSnapshot(roster: MemoryRoster) {
  const taskMeta = (task: NonNullable<MemoryRoster["bots"][number]["tasks"]>[number]) => {
    const desk = task.channelProjectDesk, team = task.sharedWork;
    return desk || team ? `${desk ? `desk:${desk.groupId}:${desk.archivedAt === undefined ? 0 : 1}` : ""}|${team ? `team:${team.teamId}:${team.quarantined ? 1 : 0}` : ""}` : "";
  };
  const bots = roster.bots.map(b => {
    const meta: Record<string, string> = {};
    for (const task of b.tasks ?? []) { const m = taskMeta(task); if (m && !(task.threadId in meta)) meta[task.threadId] = m; }
    return {id:b.id, section:b.section?.trim() || "", threads:[...new Set([b.threadId,...(b.tasks??[]).map(t=>t.threadId)])].sort(), partitioned: b.partitionedAt !== undefined ? 1 : 0, meta: Object.fromEntries(Object.entries(meta).sort(([a],[c]) => a.localeCompare(c)))};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const groups = roster.groups.map(g => ({id:g.id, section:g.section?.trim() || "", members:[...g.memberIds].sort(), threads:[...new Set([g.threadId,...(g.tasks??[]).map(t=>t.threadId)])].sort(),
    dm: g.dm ? 1 : 0, project: g.channelProject ? 1 : 0, partitionedFor: Object.entries(g.partitionedFor ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, mark]) => [id, JSON.stringify(mark ?? null)]), audience: g.dmAudience === undefined ? null : JSON.stringify(g.dmAudience)})).sort((a,b)=>a.id.localeCompare(b.id));
  return {v: 2 as const, bots, groups};
}
type Snapshot = ReturnType<typeof rosterSnapshot>;
function snapshotHash(snapshot: Snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
function fingerprint(roster: MemoryRoster) { return snapshotHash(rosterSnapshot(roster)); }
function rosterIntent(roster: MemoryRoster) {
  const snapshot = rosterSnapshot(roster);
  return JSON.stringify({hash:snapshotHash(snapshot),snapshot});
}
/** What one roster save changes for readers (SCOPED-REVOKES.md section 3):
 * - same: the granted binding already holds this exact snapshot (an active-task switch, a save that changed nothing memory reads);
 * - audience: a fact that can move content between readers changed (a bot's section or partition mark, a room's section, members, dm,
 *   audience or project flag, an existing thread under another owner or with another desk or team, a thread, bot or room with a past added
 *   anywhere, an unreadable snapshot): every receipt ends under a new policy revision, as before;
 * - scoped: only removals of threads, and additions of threads, bots and rooms that have no past. `removedThreads` are the threads nobody
 *   holds any more: their receipts end; what other threads were shown from them is judged live on their next continuation
 *   (disclosures.ts revokedReason hydrates every cited record and source under the live roster, after the hold is dropped). Nothing
 *   else is withdrawn: a thread that cited nothing of a removed thread keeps its session. */
type RosterDelta = { kind: "same" } | { kind: "audience" } | { kind: "scoped"; removedThreads: string[] };
/** A v2 snapshot of the right shape. A binding written before v2 (ids, sections, members and threads only) cannot say whether a desk, a
 * partition or a room's audience moved since, so it is not accepted: the first roster change after the upgrade is an audience change. */
function validSnapshot(snapshot: unknown): snapshot is Snapshot {
  const s = snapshot as Snapshot | undefined;
  if (!s || s.v !== 2 || !Array.isArray(s.bots) || !Array.isArray(s.groups)) return false;
  const threads = (item: { threads?: unknown }) => Array.isArray(item.threads) && item.threads.every(thread => typeof thread === "string");
  return s.bots.every(bot => typeof bot?.id === "string" && typeof bot.section === "string" && threads(bot))
    && s.groups.every(group => typeof group?.id === "string" && typeof group.section === "string" && Array.isArray(group.members) && threads(group));
}
/** Every thread of a snapshot and what holds it (its entry, and its desk and team facts), or null when one thread sits under two entries
 * (an alias). */
function threadHolders(snapshot: Snapshot): Map<string, string> | null {
  const holders = new Map<string, string>();
  for (const bot of snapshot.bots) for (const thread of new Set(bot.threads)) {
    if (holders.has(thread)) return null;
    holders.set(thread, `bot:${bot.id}|${bot.meta?.[thread] ?? ""}`);
  }
  for (const group of snapshot.groups) for (const thread of new Set(group.threads)) {
    if (holders.has(thread)) return null;
    holders.set(thread, `group:${group.id}`);
  }
  return holders;
}
/** The audience facts of one entry beyond its threads (section, members, partition facts). */
function entryFacts(entry: Snapshot["bots"][number] | Snapshot["groups"][number]): string {
  const { id: _id, threads: _threads, meta: _meta, ...facts } = entry as Snapshot["bots"][number] & Snapshot["groups"][number];
  return JSON.stringify(facts);
}
/** A thread nothing was ever shown from and nobody but the owner speaks in: no conversation scope (a fresh factory id cannot reuse a
 * previously registered scope absent from the roster), no message, no captured source, and the workspace owner as its human. */
function freshThread(db: ReturnType<typeof database>, thread: string): boolean {
  const principal = threadHumanPrincipal(thread); assertHumanPrincipal(principal);
  if (!isWorkspaceOwner(principal)) return false;
  return !db.prepare("SELECT 1 FROM memory_scopes WHERE kind='conversation' AND owner_key=?").get(thread)
    && !db.prepare("SELECT 1 FROM messages WHERE thread_id=? LIMIT 1").get(thread)
    && !db.prepare("SELECT 1 FROM memory_sources WHERE thread_id=? LIMIT 1").get(thread);
}
/** A bot or room id with no scope of its kind and no grant naming it: a reused id (a deleted bot's or room's, a package's) is not fresh. */
function freshEntry(db: ReturnType<typeof database>, kind: "bot" | "room", id: string): boolean {
  return !db.prepare("SELECT 1 FROM memory_scopes WHERE kind=? AND owner_key=?").get(kind, id)
    && !db.prepare("SELECT 1 FROM memory_scope_bindings WHERE subject_type=? AND subject_id=? LIMIT 1").get(kind, id);
}
function rosterDelta(intent: string, roster: MemoryRoster): RosterDelta {
  const audience: RosterDelta = { kind: "audience" };
  try {
    const previous = JSON.parse(intent) as { hash: string; snapshot?: unknown };
    const old = previous.snapshot, next = rosterSnapshot(roster);
    // rule 1: an unreadable or legacy snapshot fails closed; rule 2: the same authorized set
    if (!validSnapshot(old) || snapshotHash(old) !== previous.hash) return audience;
    if (snapshotHash(next) === previous.hash) return { kind: "same" };
    // rule 3: duplicate ids or a thread under two entries
    const oldBots = new Map(old.bots.map(bot => [bot.id, bot])), nextBots = new Map(next.bots.map(bot => [bot.id, bot]));
    const oldGroups = new Map(old.groups.map(group => [group.id, group])), nextGroups = new Map(next.groups.map(group => [group.id, group]));
    if (oldBots.size !== old.bots.length || nextBots.size !== next.bots.length || oldGroups.size !== old.groups.length || nextGroups.size !== next.groups.length) return audience;
    const oldHolders = threadHolders(old), nextHolders = threadHolders(next);
    if (!oldHolders || !nextHolders) return audience;
    // rule 4: a section, a membership or a partition fact of an existing bot or room moved
    for (const [id, bot] of oldBots) { const candidate = nextBots.get(id); if (candidate && entryFacts(candidate) !== entryFacts(bot)) return audience; }
    for (const [id, group] of oldGroups) { const candidate = nextGroups.get(id); if (candidate && entryFacts(candidate) !== entryFacts(group)) return audience; }
    // rule 5: an existing thread under another holder, desk or team
    for (const [thread, holder] of oldHolders) { const now = nextHolders.get(thread); if (now !== undefined && now !== holder) return audience; }
    // rules 6 and 7: every addition has no past
    const db = database();
    for (const thread of nextHolders.keys()) if (!oldHolders.has(thread) && !freshThread(db, thread)) return audience;
    for (const id of nextBots.keys()) if (!oldBots.has(id) && !freshEntry(db, "bot", id)) return audience;
    // A room whose id an existing task's desk already names changes that thread's recall from every owner-only room to the desk's room
    // (eligibleScopes :265-285): a narrowing by an addition, so it is an audience change, fresh or not.
    const desked = new Set(old.bots.flatMap(bot => Object.values(bot.meta ?? {}).flatMap(meta => { const m = /^desk:(.*):[01]\|/.exec(meta); return m ? [m[1]] : []; })));
    for (const id of nextGroups.keys()) if (!oldGroups.has(id) && (desked.has(id) || !freshEntry(db, "room", id))) return audience;
    // rule 8: what nobody holds any more
    return { kind: "scoped", removedThreads: [...oldHolders.keys()].filter(thread => !nextHolders.has(thread)) };
  } catch { return audience; }
}
function policyRow() { return database().prepare("SELECT state,intent,scope_id FROM memory_scope_bindings WHERE id=?").get(POLICY_ID); }
/** What a granted roster binding already ensured: reconcileMemoryRoster writes the binding in the same transaction, after every scope of its snapshot
 * exists, and scopes are never deleted. Null when the intent cannot say (an unreadable or legacy snapshot): then every scope is looked up. */
function ensuredBy(intent: string): { bots: Set<string>; teams: Set<string>; rooms: Set<string>; threads: Set<string> } | null {
  try {
    const snapshot = (JSON.parse(intent) as { snapshot?: ReturnType<typeof rosterSnapshot> }).snapshot;
    if (!snapshot || !Array.isArray(snapshot.bots) || !Array.isArray(snapshot.groups)) return null;
    const out = { bots: new Set<string>(), teams: new Set<string>(), rooms: new Set<string>(), threads: new Set<string>() };
    for (const bot of snapshot.bots) {
      if (typeof bot?.id !== "string" || typeof bot.section !== "string" || !Array.isArray(bot.threads)) return null;
      out.bots.add(bot.id); out.teams.add(bot.section); for (const thread of bot.threads) out.threads.add(String(thread));
    }
    for (const group of snapshot.groups) {
      if (typeof group?.id !== "string" || !Array.isArray(group.threads)) return null;
      out.rooms.add(group.id); for (const thread of group.threads) out.threads.add(String(thread));
    }
    return out;
  } catch { return null; }
}

/** Restriction is durable BEFORE the roster file changes. Failure leaves it closed.
 * What a save withdraws is what ends (SCOPED-REVOKES.md): an audience change ends every receipt under a new policy revision; a removal ends
 * the removed threads' receipts and nothing else; additions without a past end nothing and take the additive path (the file, then the
 * binding), so a failed additive write closes nothing. */
export function persistMemoryRoster(roster: MemoryRoster, persist: () => void) {
  const previous = policyRow();
  const delta: RosterDelta = previous?.state === "granted" ? rosterDelta(String(previous.intent), roster) : { kind: "audience" };
  if (delta.kind === "same") { persist(); return; }
  if (delta.kind === "scoped" && !delta.removedThreads.length) {
    persist();
    reconcileMemoryRoster(roster);
    return;
  }
  transaction(db => {
    const scopeId = ensureScope("workspace", memoryState().installationId);
    if (delta.kind === "audience") db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,'system','roster',?,'pending',?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state='pending',intent=excluded.intent")
      .run(POLICY_ID,scopeId,memoryState().policyRevision,rosterIntent(roster));
    if (delta.kind === "audience") revokeAllDisclosures(db,"roster");
    else { for (const thread of delta.removedThreads) revokeThreadDisclosures(db,thread,"roster-removed"); bumpAuthorityHard(db); }
  });
  persist();
  reconcileMemoryRoster(roster);
}

/** Caller supplies the already-validated durable roster on startup, never model data. */
let lastReconciled: { db: unknown; key: string } | null = null;
/** `unlessUnchanged`: the start reconciles twice (identities, then sharing) over the same roster; the second pass is skipped when this process already
 * reconciled this exact roster against this database at this policy revision (it would rewrite the same rows). */
export function reconcileMemoryRoster(roster: MemoryRoster, options: { unlessUnchanged?: boolean } = {}) {
  const handle = database();
  const key = `${fingerprint(roster)}\n${rosterIntent(roster)}\n${memoryState().policyRevision}`;
  if (options.unlessUnchanged && lastReconciled?.db === handle && lastReconciled.key === key) return;
  transaction(db => {
    const prior = policyRow();
    // A pending binding (a crash between the save's transaction and this) holds the intent that transaction wrote: what the file now differs
    // from it by is judged the same way, so an old file after a removal (its thread has a past) fails closed, a new file after one is settled.
    const delta: RosterDelta = prior ? rosterDelta(String(prior.intent), roster) : { kind: "same" };
    if (delta.kind === "audience") {
      db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
      revokeAllDisclosures(db,"roster-reconcile");
    } else if (delta.kind === "scoped" && delta.removedThreads.length) { for (const thread of delta.removedThreads) revokeThreadDisclosures(db,thread,"roster-reconcile-removed"); bumpAuthorityHard(db); }
    // Only what the last granted roster did not already ensure is looked up: a start over an unchanged roster (the first start after an upgrade among
    // them, before the scope-owner index exists) makes no search by owner, however many scopes the file holds. Its workspace scope is the binding's own,
    // confirmed by one primary-key read.
    const done = prior?.state === "granted" ? ensuredBy(String(prior.intent)) : null;
    const installation = memoryState().installationId;
    const held = done && prior?.scope_id ? db.prepare("SELECT id FROM memory_scopes WHERE id=? AND kind='workspace' AND owner_key=?").get(String(prior.scope_id), installation) : undefined;
    const scope = held ? String(held.id) : ensureScope("workspace", installation);
    for (const bot of roster.bots) {
      if (!done?.bots.has(bot.id)) ensureScope("bot",bot.id);
      if (!done?.teams.has(bot.section?.trim() || "")) ensureScope("team",bot.section?.trim() || "");
      for (const id of new Set([bot.threadId,...(bot.tasks??[]).map(t=>t.threadId)])) if (!done?.threads.has(id)) ensureScope("conversation",id);
    }
    for (const group of roster.groups) {
      if (!done?.rooms.has(group.id)) ensureScope("room",group.id);
      for (const id of new Set([group.threadId,...(group.tasks??[]).map(t=>t.threadId)])) if (!done?.threads.has(id)) ensureScope("conversation",id);
    }
    db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,'system','roster',?,'granted',?) ON CONFLICT(id) DO UPDATE SET state='granted',intent=excluded.intent,revision=excluded.revision")
      .run(POLICY_ID,scope,memoryState().policyRevision,rosterIntent(roster));
  });
  lastReconciled = { db: handle, key: `${fingerprint(roster)}\n${rosterIntent(roster)}\n${memoryState().policyRevision}` };
}

/** Every thread with a human binding and its person, in ONE indexed read (memory_bindings_subject):
 * the audience walk below asked threadHumanPrincipal once per task of the bot (about 900k reads a
 * minute in the RC1 routine burst). A thread with no binding is the workspace owner's, exactly as
 * threadHumanPrincipal answers. Remembered inside an eligibility pass like the single lookup. */
function boundThreadPersons(db: ReturnType<typeof database>): ReadonlyMap<string, string | null> {
  return passLookup(db, "human-thread-persons", () => {
    const persons = new Map<string, string | null>();
    for (const row of db.prepare("SELECT subject_id, json_extract(intent,'$.personId') AS person FROM memory_scope_bindings WHERE subject_type='human-thread'").all())
      persons.set(String(row.subject_id), row.person === null || row.person === undefined ? null : String(row.person));
    return persons;
  });
}

/** The conversation scope ids of `threads` (in that order, missing ones left out): one primary-key read once warm. */
function conversationScopes(db: ReturnType<typeof database>, threads: readonly string[]): string[] {
  if (!threads.length) return [];
  const byOwner = scopeRows(db, "conversation", threads);
  return threads.flatMap(thread => byOwner.get(thread) ?? []);
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
  // One read of every bound thread's person instead of one binding read per task (1.0.2 bgwork).
  const persons = boundThreadPersons(db);
  const sameAudience = (thread: string) => (persons.has(thread) ? persons.get(thread) : WORKSPACE_OWNER) === principal.personId;
  /** The bot's own direct chat and tasks the owner keeps in memory. */
  const ownThreads = () => [...new Set([bot.threadId,...(bot.tasks??[]).map(task=>task.threadId)])]
    .filter(owned => !foreignThreads.has(owned) && !excluded.has(owned) && sameAudience(owned));
  /** A room's own threads (main chat and task threads). Before 0.1.61 each
   * captured into its own conversation scope, so reaching a room means
   * reaching those scopes too (plan 3.8: existing sources are not moved). */
  const roomThreads = (room: MemoryRoster["groups"][number]) => [...new Set([room.threadId,...(room.tasks??[]).map(task=>task.threadId)])]
    .filter(thread => !excluded.has(thread));
  if (group) {
    add("room",group.id);
    // the room's other threads (its goal and task threads, R3): an
    // owner-audience turn only, same audience only (Astra r2 #17)
    if(owner)for(const thread of roomThreads(group))if(thread!==threadId && sameAudience(thread))add("conversation",thread);
    // A member is the same bot in a room as in a direct chat: when the room's
    // only human is the owner, it also recalls its OWN bot memory and its
    // team's memory (adapted from OpenMausBot), and since 0.1.61 (lane M,
    // "recall both ways") its own direct chat and tasks. A room whose audience
    // is a channel person keeps the room-only boundary; owner shares still
    // apply through the person bindings below. Never another member's scopes.
    if(owner){add("bot",botId); add("team",bot.section?.trim() || ""); scopes.push(...conversationScopes(db, ownThreads()));}
  } else {
    if(owner){add("bot",botId); add("team",bot.section?.trim() || "");}
    // A project desk thread (one of this bot's tasks tagged with a project it
    // is a member of) captures into the project's room scope
    // (capture-scope.ts), so it recalls that scope too: owner audience only.
    const deskRoom = owner ? threadMemoryRoom(threadId, roster) : null;
    // Threads bound to a channel person: never reached from here, whichever
    // room they sit in (their words never enter the room scope either,
    // capture-scope.ts).
    const personThreads = owner ? new Set([...persons].flatMap(([thread, person]) => person !== null && person !== WORKSPACE_OWNER ? [thread] : [])) : new Set<string>();
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
    scopes.push(...conversationScopes(db, ownThreads()));
  }
  if (notOwnerAudience && isWorkspaceOwner(principal)) return filterPartitionScopes(botId, threadId, scopes, owner);
  const subjectType = isWorkspaceOwner(principal) ? (group ? "room" : "bot") : "person", subjectId = isWorkspaceOwner(principal) ? (group?.id ?? botId) : principal.personId;
  // A person's grant only ever reaches the audiences the people screen offers; an older grant to any other kind (the owner's preferences, a bot) is ignored (1.0.4 gap D).
  for (const row of db.prepare(`SELECT b.scope_id FROM memory_scope_bindings b JOIN memory_scopes sc ON sc.id=b.scope_id WHERE b.subject_type=? AND b.subject_id=? AND b.state='granted'
    AND (b.subject_type!='person' OR sc.kind IN ('room','project','team','workspace'))`).all(subjectType,subjectId)) scopes.push(String(row.scope_id));
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
  // One read for every scope's kind and owner (a bot with many tasks has many conversation scopes).
  const rows = new Map(db.prepare("SELECT id,kind,owner_key FROM memory_scopes WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...new Set(scopes)])).map(row => [String(row.id), row] as const));
  for (const id of scopes) {
    const row = rows.get(id); if (!row) continue;
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

/** The threads thread recall may read for this access (THREAD-RECALL-DESIGN r6 rules 1 and 2): the bot's own direct chat and tasks, minus
 * another bot's or a room's threads, the owner's excluded threads and threads bound to a channel person, narrowed to the turn's partition.
 * Empty unless the turn runs in one of the bot's own threads and is an owner audience (a room, a channel person, a non-owner or unproven
 * turn, an isolated partition). Computed on every call from the live roster, never cached. */
export function recallThreads(access: MemoryAccess): string[] {
  const trusted = contexts.get(access);
  if (!trusted || !memoryAccessIsOwnerAudience(access)) return [];
  const roster = trusted.roster();
  const bot = roster.bots.find(candidate => candidate.id === access.botId);
  if (!bot) return [];
  const own = [...new Set([bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)])];
  if (!own.includes(access.threadId)) return [];
  const foreign = new Set([
    ...roster.bots.filter(other => other.id !== access.botId).flatMap(other => [other.threadId, ...(other.tasks ?? []).map(task => task.threadId)]),
    ...roster.groups.flatMap(room => [room.threadId, ...(room.tasks ?? []).map(task => task.threadId)]),
  ]);
  if (foreign.has(access.threadId)) return [];
  const db = database();
  const excluded = new Set(db.prepare("SELECT e.value FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'").all().map(row => String(row.value)));
  const persons = boundThreadPersons(db);
  const principal = access.humanPrincipal;
  let set = own.filter(thread => !foreign.has(thread) && !excluded.has(thread) && (persons.has(thread) ? persons.get(thread) : WORKSPACE_OWNER) === principal.personId);
  const store = executionStore(), stored = store?.bot(access.botId);
  if (stored && stored.partitionedAt !== undefined) {
    if (threadPartition(stored, access.threadId).kind === "isolated") return [];
    set = set.filter(thread => sameThreadPartition(stored, access.threadId, thread));
  }
  return set;
}

/** The turn's words were not proven to be the owner's (the claim flag). Its
 * verdicts are about this reader, never about the receipts themselves. */
export function memoryAccessNotOwnerAudience(access: MemoryAccess): boolean {
  return contexts.get(access)?.claim.notOwnerAudience === true;
}

/** May this reader see an identity-partition record held in this scope: only the
 * bot's own bot scope (or a conversation scope), and never in a room. A grant
 * that reaches another bot's scope does not carry that bot's private identity.
 * One rule for memory_get (bundle hydration) and memory_search. */
export function identityRecordReadable(scopeId: string, access: Pick<MemoryAccess, "botId" | "scopeIds" | "threadId">): boolean {
  const own = database().prepare("SELECT 1 FROM memory_scopes WHERE id=? AND ((kind='bot' AND owner_key=?) OR kind='conversation')").get(scopeId, access.botId);
  return Boolean(own) && !accessIncludesRoom(access);
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
/** `observeOnly`: reading what a skill or routine says right now (the recovery of a half-finished change) is not a use of memory, so it does not wait for memory
 * to be switched on: the mode check is skipped, every other check (the roster's grant, excluded threads, eligibility) is the same. */
export function backgroundMemoryScopes(botId: string, threadId: string, roster: MemoryRoster, observeOnly = false): readonly string[] {
  const state = memoryState();
  if ((!observeOnly && !["active", "capture"].includes(state.mode)) || policyRow()?.state !== "granted") return [];
  const excluded = database().prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=?").get(threadId);
  if (excluded) return [];
  return Object.freeze(eligibilityAnswer(database(), `${botId}\u0000${threadId}`, roster, () => eligibleScopes(botId, threadId, roster)));
}

export function backgroundMemoryAudience(botId: string, threadId: string, roster: MemoryRoster, observeOnly = false) {
  const scopeIds = backgroundMemoryScopes(botId, threadId, roster, observeOnly);
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

/** SL-E r3.2 S(P) (lanes/release104/designs/SL-E.md sections 10 and 18 R1): the memory scopes a linked person may read, judged live now. A
 * scope is in it only when it is (a) the conversation scope of a thread bound to this person (the 'human-thread' bindings), (b) this person's
 * own preferences scope, or (c) a scope of a kind the share screen offers (room, project, team, workspace: human-principals.ts
 * SHAREABLE_SCOPE_KINDS) that the owner granted to this
 * person and has not withdrawn. A grant of any other kind never enters it: bot (identity records the person may not read; a footprint is
 * scope-level), conversation or preferences (the owner's private conversations, which sharing never offers). "unknown" when any read
 * throws: every caller reads that as an unknown. */
export function personReadableScopes(db: ReturnType<typeof database>, principal: HumanPrincipal): ReadonlySet<string> | "unknown" {
  try {
    const scopes = new Set<string>();
    for (const row of db.prepare("SELECT s.id FROM memory_scope_bindings b JOIN memory_scopes s ON s.kind='conversation' AND s.owner_key=b.subject_id WHERE b.subject_type='human-thread' AND json_extract(b.intent,'$.personId')=?").all(principal.personId)) scopes.add(String(row.id));
    for (const row of db.prepare("SELECT id FROM memory_scopes WHERE kind='preferences' AND owner_key=?").all("person:" + principal.personId)) scopes.add(String(row.id));
    for (const row of db.prepare("SELECT s.id FROM memory_scope_bindings b JOIN memory_scopes s ON s.id=b.scope_id AND s.kind IN ('room','project','team','workspace') WHERE b.subject_type='person' AND b.subject_id=? AND b.state='granted'").all(principal.personId)) scopes.add(String(row.id));
    return scopes;
  } catch { return "unknown"; }
}

/** SL-E r3.2 R1 (section 11 (A)): the scopes of the write-time lineage READER for a turn with this memory access, at the sites that judge
 * "whose memory is this line made of" (the send fence, the session lookup, the replay reader). A linked person's turn reads
 * `access.scopeIds` together with S(P), the person's own audience across every conversation bound to them, so a released hand-off result
 * in the person's DM does not withhold the person's own next turn; never narrower than `access.scopeIds`, and S(P) unknown leaves it
 * `access.scopeIds` alone. Every other audience (the owner, words nobody proved in the owner's thread) keeps `access.scopeIds`. What a turn
 * may be SHOWN from memory is unchanged. A group's conversation keeps `access.scopeIds`. */
export function lineageReaderScopes(access: Pick<MemoryAccess, "scopeIds" | "humanPrincipal">, db: ReturnType<typeof database> = database()): string[] {
  // (a group's conversation is not one person's audience: it keeps today's thread-local set)
  if (isWorkspaceOwner(access.humanPrincipal) || isGroupPrincipal(access.humanPrincipal)) return [...access.scopeIds];
  const own = personReadableScopes(db, access.humanPrincipal);
  return own === "unknown" ? [...access.scopeIds] : [...new Set([...access.scopeIds, ...own])];
}

