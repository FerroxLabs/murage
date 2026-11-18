import { RecallPreparationPending, RecallViewLost } from './recall-recovery.ts';
import { assertIssuedRecallView, deferActiveRecallReaders, prepareActiveRecallReaders, recallViewHasScope, recallViewRoom, resolveRecallView, retainRecallView, type RecallViewHandle } from './recall-view.ts';
import { ConstructionBudget, constructionJson, constructionSort, constructionObjectKeys } from "./recall-construction.ts";
import { memoryReaderDenied } from "./deny.ts";
import { executionStore, threadPartition, isHomePartition, partitionScopeKey, sameThreadPartition } from "../execution-audience.ts";
import { teamChangeOpen, teamMemoryKey } from "../team-identities.ts";
import { isGroupPrincipal, threadHumanPrincipal, assertHumanPrincipal, isWorkspaceOwner, WORKSPACE_OWNER, type HumanPrincipal } from "../human-principals.ts";
import { createHash, randomUUID } from "node:crypto";
import { database, transaction } from "../database.ts";
import { beginRead, endWrite } from "../write-tx.ts";
import type { InternalCapability, InternalCapabilities } from "../internal-capabilities.ts";
import type { MemoryScopeKind } from "../../shared/memory.ts";
import { memoryState } from "./repository.ts";
import { threadMemoryRoom } from "./capture-scope.ts";
import { scopeRow, scopeRows } from "./scope-id.ts";
import { insertScope } from "./scope-insert.ts";
import { audienceStamp, cachedEligible } from "./audience-cache.ts";
import { eligibilityAnswer, inEligibilityPass, livePassLookup, passLookup } from "./eligibility-pass.ts";
import { revokeAllDisclosures, revokeThreadDisclosures } from "./revocation.ts";
import { bumpAuthorityThreads, bumpAuthorityScopes, bumpAuthorityHard } from "./authority-epoch.ts";
import type { DelegationPack, PackBinding } from "../delegation-pack/types.ts";
import { branchRows } from "../branch-store.ts";
import { commitRevoke } from './revoke-commit.ts';
import { readActiveLeafOrNewest, readMessage } from "../message-db.ts";

import type { PermissionSetting } from "../permission-inheritance.ts";

export interface MemoryRoster {
  memoryRosterRevision?: number;
  botRosterRevision?: number;
  threadIdsForBot?(botId: string): readonly string[];
  botByThread?(threadId: string): MemoryRoster["bots"][number] | null | undefined;
  taskByThread?(botId: string, threadId: string): NonNullable<MemoryRoster["bots"][number]["tasks"]>[number] | undefined;
  groupByThread?(threadId: string): MemoryRoster["groups"][number] | undefined;
  threadHolder?(threadId: string): { kind: "bot" | "group" | "alias"; id: string } | null;
  bots: Array<PermissionSetting & {name?: string; id: string; threadId: string; section?: string; sharedWith?: {mode:"none"|"all"}|{mode:"list";teams:Array<{id:string}>}; individual?:boolean;chiefOfStaff?:boolean;chiefScope?:"workspace"; tasks?: Array<{threadId: string; sharedWork?: {teamId: string; quarantined?: boolean}; channelProjectDesk?: {groupId: string; archivedAt?: number}}>; partitionedAt?: number}>;
  groups: Array<{name?: string; id: string; threadId: string; section?: string; memberIds: string[]; tasks?: Array<{threadId: string}>; dm?: boolean; channelProject?: unknown; partitionedFor?: Record<string, unknown>; dmAudience?: unknown}>;
}
export interface MemoryAccess {
  botId: string; threadId: string; generation: string; policyRevision: number; deletionEpoch: number;
  /** Compatibility snapshot constructed during maintenance; recall consumers use view. */
  scopeIds: readonly string[];
  view: RecallViewHandle;
  notOwnerAudience: boolean;
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
  // A new scope is held by no view, so it leaves the recall epoch where it was (insertScope): an issued view stays valid for the scopes it cites.
  transaction(d => { insertScope(d,id,kind,owner); }, { op: "scope" });
  return id;
}

/** The facts of a roster that decide who may read what (SCOPED-REVOKES.md section 1): every bot's id, section and threads, every room's id,
 * section (a non-dm room's only, F2), members and threads, and (v2) the partition facts filterPartitionScopes and threadMemoryRoom read: a bot's partition mark, a
 * task's project desk and shared-team work, a room's dm flag and audience, project flag and per-member partition marks. Active-task
 * selection changes presentation, not the authorized thread set: the active thread usually also appears in tasks; duplicate counts must
 * not revoke running background turns when the owner opens another task. */
type BotSnapshot = { id:string;section:string;threads:string[];partitioned:number;meta:Record<string,string>;sharing:string[];roles:boolean[];taskOrder?:Array<[string,string]> };
const botSnapshots = new WeakMap<object, { tasks: unknown; length: number; revision: number; shape: string; value: BotSnapshot }>();
function rosterSnapshot(roster: MemoryRoster) {
  const taskMeta = (task: NonNullable<MemoryRoster["bots"][number]["tasks"]>[number]) => {
    const desk = task.channelProjectDesk, team = task.sharedWork;
    return desk || team ? `${desk ? `desk:${desk.groupId}:${desk.archivedAt === undefined ? 0 : 1}` : ""}|${team ? `team:${team.teamId}:${team.quarantined ? 1 : 0}` : ""}` : "";
  };
  const bots = roster.bots.map(b => {
    const shape = JSON.stringify([b.id, b.section, b.threadId, b.partitionedAt,b.sharedWith,b.individual,b.chiefOfStaff,b.chiefScope]), held = botSnapshots.get(b);
    if (roster.botRosterRevision !== undefined && held && held.tasks === b.tasks && held.length === (b.tasks?.length ?? 0)
      && held.revision === roster.botRosterRevision && held.shape === shape) return held.value;
    const meta: Record<string, string> = {};
    for (const task of b.tasks ?? []) { const m = taskMeta(task); if (m && !(task.threadId in meta)) meta[task.threadId] = m; }
    const taskOrder = (b.tasks??[]).map(t=>[t.threadId,taskMeta(t)] as [string,string]);
    const duplicate = new Set(taskOrder.map(([id])=>id)).size !== taskOrder.length;
    const value:BotSnapshot = {id:b.id, section:b.section?.trim() || "", threads:[...new Set([b.threadId,...(b.tasks??[]).map(t=>t.threadId)])].sort(), partitioned: b.partitionedAt !== undefined ? 1 : 0, meta: Object.fromEntries(Object.entries(meta).sort(([a],[c]) => a.localeCompare(c))),sharing:b.sharedWith?.mode==='list'?b.sharedWith.teams.map(t=>t.id).sort():[b.sharedWith?.mode??'none'],roles:[b.individual===true,b.chiefOfStaff===true,b.chiefScope==='workspace'],...(duplicate?{taskOrder}:{})};
    if (roster.botRosterRevision !== undefined) botSnapshots.set(b, { tasks: b.tasks, length: b.tasks?.length ?? 0, revision: roster.botRosterRevision, shape, value });
    return value;
  }).sort((a,b)=>a.id.localeCompare(b.id));
  // DELEGATION-HOLD F2: a DM pair room's section is sidebar placement only. No access rule reads it (eligibleScopes and session-audience take a
  // member's team from bot.section; capture, homeSpace, markPartitions and threadPartition skip DMs), so it is not an audience fact. A non-dm
  // room's section stays one.
  const groups = roster.groups.map(g => ({id:g.id, section:g.dm ? "" : g.section?.trim() || "", members:[...g.memberIds].sort(), threads:[...new Set([g.threadId,...(g.tasks??[]).map(t=>t.threadId)])].sort(),
    dm: g.dm ? 1 : 0, project: g.channelProject ? 1 : 0, partitionedFor: Object.entries(g.partitionedFor ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, mark]) => [id, JSON.stringify(mark ?? null)]), audience: g.dmAudience === undefined ? null : JSON.stringify(g.dmAudience)})).sort((a,b)=>a.id.localeCompare(b.id));
  return {v: 2 as const, bots, groups, order:[roster.bots.map(b=>b.id),roster.groups.map(g=>g.id)]};
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
type RosterDelta = { kind: "same" } | { kind: "audience" } | { kind: "scoped"; removedThreads: string[]; removedScopes: string[]; removedRooms: boolean };
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
  for (const bot of snapshot.bots) {
    if(bot.taskOrder)return null;
    for (const thread of new Set(bot.threads)) {
    if (holders.has(thread)) return null;
    holders.set(thread, `bot:${bot.id}|${bot.meta?.[thread] ?? ""}`);
  }
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
    const removedScopes: string[] = [];
    for (const id of [...oldBots.keys()].filter(id => !nextBots.has(id))) {
      const scopes = db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND (owner_key=? OR substr(owner_key,1,?)=?)").all(id, id.length + 1, id + "#");
      if (!scopes.length) return audience; // an incomplete notebook identity is never a scoped proof
      removedScopes.push(...scopes.map(row => String(row.id)));
    }
    return { kind: "scoped", removedScopes, removedRooms: [...oldGroups.keys()].some(id => !nextGroups.has(id)), removedThreads: [...oldHolders.keys()].filter(thread => !nextHolders.has(thread)) };
  } catch { return audience; }
}
function policyGranted() { return !!database().prepare("SELECT 1 FROM memory_scope_bindings WHERE id=? AND state='granted'").get(POLICY_ID); }
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
  if (delta.kind === "same") { persist(); return true; }
  if (delta.kind === "scoped" && !delta.removedThreads.length) {
    persist();
    reconcileMemoryRoster(roster);
    return false;
  }
  transaction(db => {
    const scopeId = ensureScope("workspace", memoryState().installationId);
    if (delta.kind === "audience") db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,'system','roster',?,'pending',?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state='pending',intent=excluded.intent")
      .run(POLICY_ID,scopeId,memoryState().policyRevision,rosterIntent(roster));
    if (delta.kind === "audience") revokeAllDisclosures(db,"roster");
    else { for (const thread of delta.removedThreads) revokeThreadDisclosures(db,thread,"roster-removed"); bumpAuthorityThreads(db,delta.removedThreads); if (delta.removedRooms) bumpAuthorityHard(db); else bumpAuthorityScopes(db,delta.removedScopes); }
  });
  persist();
  reconcileMemoryRoster(roster);
  return false;
}

/** Caller supplies the already-validated durable roster, never model data.
 * Producer owner: recall-s3; consumer owner: recall-scope (S4 restart hydration).
 * The compatibility option never substitutes a process-local fingerprint for live authority. */
export function reconcileMemoryRoster(roster: MemoryRoster, _options: { unlessUnchanged?: boolean } = {}) {
  const reconcile = (db: ReturnType<typeof database>, apply: boolean): boolean => {
    const prior = db.prepare("SELECT state,intent,scope_id,revision,subject_type,subject_id FROM memory_scope_bindings WHERE id=?").get(POLICY_ID);
    const intent = rosterIntent(roster), state = memoryState();
    const delta: RosterDelta = prior ? rosterDelta(String(prior.intent), roster) : { kind: "same" };
    const priorEnsured = prior?.state === "granted" ? ensuredBy(String(prior.intent)) : null;
    // Verify the actual scopes, including on a cold connection. One set query uses the owner
    // index when present, or one pass before that optional upgrade; never one scan per owner.
    const required: Array<[MemoryScopeKind, string]> = [["workspace", state.installationId]];
    for (const bot of roster.bots) {
      required.push(["bot", bot.id], ["team", bot.section?.trim() || ""]);
      for (const id of new Set([bot.threadId, ...(bot.tasks ?? []).map(t => t.threadId)])) required.push(["conversation", id]);
    }
    for (const group of roster.groups) {
      required.push(["room", group.id]);
      for (const id of new Set([group.threadId, ...(group.tasks ?? []).map(t => t.threadId)])) required.push(["conversation", id]);
    }
    const present = new Map<string, string>();
    for (const row of db.prepare("SELECT id,kind,owner_key FROM memory_scopes WHERE (kind,owner_key) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))").all(JSON.stringify(required))) {
      const key = JSON.stringify([row.kind, row.owner_key]);
      // Duplicate legacy scope owners do not change a still-valid workspace binding.
      if (!present.has(key) || row.id === prior?.scope_id) present.set(key, String(row.id));
    }
    const missing = required.filter(pair => !present.has(JSON.stringify(pair)));
    const workspace = present.get(JSON.stringify(required[0]));
    // No INSERT/UPDATE at all: even writing identical binding bytes fires the epoch trigger.
    // A pending crash journal, noncanonical intent, changed grant or open team operation
    // always takes the normal reconciliation transaction below.
    if (priorEnsured && prior?.state === "granted" && delta.kind === "same" && !missing.length
      && prior.intent === intent && prior.scope_id === workspace
      && Number(prior.revision) === state.policyRevision
      && prior.subject_type === "system" && prior.subject_id === "roster" && !teamChangeOpen(db)) return true;
    if (!apply) return false;
    if (delta.kind === "audience") {
      db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
      revokeAllDisclosures(db,"roster-reconcile");
    } else if (delta.kind === "scoped" && delta.removedThreads.length) { for (const thread of delta.removedThreads) revokeThreadDisclosures(db,thread,"roster-reconcile-removed"); bumpAuthorityThreads(db,delta.removedThreads); if (delta.removedRooms) bumpAuthorityHard(db); else bumpAuthorityScopes(db,delta.removedScopes); }
    for (const [kind, owner] of missing) ensureScope(kind, owner);
    const scope = workspace ?? ensureScope("workspace", state.installationId);
    db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES(?,?,'system','roster',?,'granted',?) ON CONFLICT(id) DO UPDATE SET scope_id=excluded.scope_id,subject_type=excluded.subject_type,subject_id=excluded.subject_id,state='granted',intent=excluded.intent,revision=excluded.revision")
      .run(POLICY_ID,scope,memoryState().policyRevision,intent);
    return false;
  };
  // The normal write wrapper initializes temporary identity bookkeeping on a cold
  // connection. Prove the no-op in a read snapshot first, so it writes no rows at all.
  const db = database();
  beginRead(db, 'memory_roster_read');
  let unchanged: boolean;
  try { unchanged = reconcile(db, false); }
  finally { endWrite(db, 'memory_roster_read'); }
  if (!unchanged) deferActiveRecallReaders(() => transaction(db => { reconcile(db, true); }));
  // Also when nothing was written: after a reopen of the database a live reader has no current view on the new connection yet.
  prepareActiveRecallReaders();
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

/** Does the roster still seat this bot on this thread: a member of the thread's room, or the owner of the direct chat or task.
 * The same first test legacyRecallScopes makes, from roster lookups alone. */
function rosterSeats(botId: string, threadId: string, roster: MemoryRoster): boolean {
  const bot = roster.bots.find(b => b.id === botId);
  if (!bot) return false;
  const group = roster.groupByThread ? roster.groupByThread(threadId) : roster.groups.find(g => g.threadId === threadId || g.tasks?.some(t => t.threadId === threadId));
  if (group) return group.memberIds.includes(botId);
  return bot.threadId === threadId || Boolean(roster.taskByThread ? roster.taskByThread(botId, threadId) : bot.tasks?.some(t => t.threadId === threadId));
}

/** notOwnerAudience: the turn's words were not proven to be the owner's
 * (0.1.61). It reads like a stranger in the owner's own thread: the
 * conversation and room it runs in, never the bot's or team's memory, the
 * owner's preferences or anything the owner shared. */
export function legacyRecallScopes(botId: string, threadId: string, roster: MemoryRoster, notOwnerAudience = false, givenPrincipal?: HumanPrincipal): string[] {
  const bot = roster.bots.find(b => b.id === botId);
  if (!bot) return [];
  const group = roster.groupByThread ? roster.groupByThread(threadId) : roster.groups.find(g => g.threadId === threadId || g.tasks?.some(t => t.threadId === threadId));
  if (group && !group.memberIds.includes(botId)) return [];
  if (!group && bot.threadId !== threadId && !(roster.taskByThread ? roster.taskByThread(botId, threadId) : bot.tasks?.some(t => t.threadId === threadId))) return [];
  const db = database();
  const principal=givenPrincipal ?? threadHumanPrincipal(threadId);
  assertHumanPrincipal(principal);
  const owner=isWorkspaceOwner(principal) && !notOwnerAudience;
  const scopes: string[] = [];
  const add = (kind: string, owner: string) => {
    const row = scopeRow(db, kind,owner);
    if (row) scopes.push(String(row.id));
  };
  // Private continuity belongs to the bot's owned direct tasks, not its current
  // model/session. Never infer a private grant from an aliased room/other bot.
  const foreign = roster.threadHolder ? undefined : new Set([
    ...roster.bots.filter(other => other.id !== botId).flatMap(other => [other.threadId, ...(other.tasks ?? []).map(task => task.threadId)]),
    ...roster.groups.flatMap(room => [room.threadId, ...(room.tasks ?? []).map(task => task.threadId)]),
  ]);
  const foreignThread = (thread: string) => {
    if (foreign) return foreign.has(thread);
    const holder = roster.threadHolder!(thread);
    return holder !== null && (holder.kind !== "bot" || holder.id !== botId);
  };
  if (!group && foreignThread(threadId)) return [];
  add("conversation",threadId);
  if (isGroupPrincipal(principal)) return scopes;
  const excluded = new Set(db.prepare("SELECT e.value FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'").all().map(row=>String(row.value)));
  // One read of every bound thread's person instead of one binding read per task (1.0.2 bgwork).
  const persons = boundThreadPersons(db);
  const sameAudience = (thread: string) => (persons.has(thread) ? persons.get(thread) : WORKSPACE_OWNER) === principal.personId;
  /** The bot's own direct chat and tasks the owner keeps in memory. */
  const ownThreads = () => (roster.threadIdsForBot ? roster.threadIdsForBot(botId) : [...new Set([bot.threadId,...(bot.tasks??[]).map(task=>task.threadId)])])
    .filter(owned => !foreignThread(owned) && !excluded.has(owned) && sameAudience(owned));
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

/** Admission, background checks and assertions share this answer. Principal
 * validation remains live before reading a cache entry. */
function currentEligible(botId: string, threadId: string, roster: MemoryRoster, notOwner = false, givenPrincipal?: HumanPrincipal): readonly string[] {
  const db = database(), principal = givenPrincipal ?? threadHumanPrincipal(threadId);
  assertHumanPrincipal(principal);
  const key = `${botId}\u0000${threadId}\u0000${notOwner}\u0000${principal.personId}`;
  return eligibilityAnswer(db, key, roster, () => cachedEligible(key, audienceStamp(db, roster),
    () => legacyRecallScopes(botId, threadId, roster, notOwner, principal), { db, roster }));
}

/** Every owner-audience reader's scope set: each bot's direct chat and each room member's room turn (their task threads recall
 * the same scopes or fewer). Pin time (bundle.ts ownerPinUse) measures the owner pins each of these combines in one bundle; `room`
 * marks a room turn, which never reads the identity partition. */
export function ownerReaderScopeSets(roster: MemoryRoster): Array<{ scopeIds: readonly string[]; room: boolean }> {
  const sets: Array<{ scopeIds: readonly string[]; room: boolean }> = [], seen = new Set<string>();
  const reach = (botId: string, threadId: string, room: boolean) => {
    const key = `${botId}\u0000${threadId}`;
    if (seen.has(key)) return;
    seen.add(key);
    try { const scopeIds = legacyRecallScopes(botId, threadId, roster); if (scopeIds.length) sets.push({ scopeIds, room }); } catch { /* a thread with no readable audience reads no pins */ }
  };
  for (const bot of roster.bots) reach(bot.id, bot.threadId, false);
  for (const group of roster.groups) for (const member of group.memberIds) reach(member, group.threadId, true);
  return sets;
}

/** Final narrowing, after explicit grants; an owner grant cannot bridge a partition. */
export function filterPartitionScopes(botId: string, threadId: string, scopes: string[], owner: boolean): string[] {
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
/** Mount eligibility is a construction fact, never a turn-time roster enumeration. */
export function recallThreadsAvailable(access:MemoryAccess):boolean {
  const trusted=contexts.get(access);if(!trusted||!memoryAccessIsOwnerAudience(access))return false;
  assertMemoryAccess(access);
  const current=resolveRecallView({botId:access.botId,threadId:access.threadId,humanPrincipal:access.humanPrincipal,notOwnerAudience:access.notOwnerAudience},trusted.roster(),true);
  if(current.handle.viewId!==access.view.viewId||current.handle.generation!==access.view.generation)return false;
  return !!database().prepare('SELECT 1 FROM memory_recall_thread_readers WHERE view_id=? AND generation=? AND eligible=1').get(access.view.viewId,access.view.generation);
}
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

/** Server-owned dispatch facts, re-derived for each loan check, including at the provider write.
 * delegationId names the live delegation run, not an ID taken from the input row. Replay supplies an anchor instead. */
export interface PackLoanTurn {
  generation: string;
  driverKind: string;
  delegationId?: string;
  anchor?: PackBinding["anchor"];
  isUnattended(threadId: string): boolean;
}

/** The owner's loan overrides only the other-bot exclusion, for these source pairs and this dispatch.
 * Ordinary recall never receives this set. All policy, branch and run facts are read live; uncertainty grants nothing. */
export function packLoan(pack: DelegationPack, access: MemoryAccess, turn: PackLoanTurn): { sourceThreadId: string; ids: ReadonlySet<string> } | null {
  try {
    const trusted = contexts.get(access);
    if (!trusted || turn.generation !== access.generation || !trusted.registry.isActive(trusted.claim)
      || trusted.registry.activeGeneration(access.threadId) !== turn.generation || turn.driverKind === "antigravity") return null;
    assertMemoryAccess(access);
    if (pack.target_bot_id !== access.botId || pack.destination_thread_id !== access.threadId) return null;
    if (!memoryAccessIsOwnerAudience(access) || !isWorkspaceOwner(threadHumanPrincipal(access.threadId))
      || !isWorkspaceOwner(threadHumanPrincipal(pack.source_thread_id)) || turn.isUnattended(pack.source_thread_id)) return null;

    const roster = trusted.roster();
    const source = roster.bots.find(bot => bot.id === pack.source_bot_id), target = roster.bots.find(bot => bot.id === access.botId);
    const owns = (bot: MemoryRoster["bots"][number] | undefined, thread: string) => bot && (bot.threadId === thread || bot.tasks?.some(task => task.threadId === thread));
    if (!owns(source, pack.source_thread_id) || !owns(target, access.threadId)) return null;
    const inRoom = (thread: string) => roster.groups.some(room => room.threadId === thread || room.tasks?.some(task => task.threadId === thread));
    if (inRoom(pack.source_thread_id) || inRoom(access.threadId)
      || roster.bots.some(bot => bot.id !== access.botId && owns(bot, access.threadId))) return null;
    const db = database();
    if (db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=?").get(pack.source_thread_id)) return null;
    const storedSource = executionStore()?.bot(pack.source_bot_id), storedTarget = executionStore()?.bot(access.botId);
    if (!storedSource || !storedTarget) return null;
    // Identical to sameThreadPartition's key, applied across the two bots. Unpartitioned bots count as home.
    const key = (bot: typeof storedSource, thread: string): string | null => {
      if (bot.partitionedAt === undefined) return "home";
      const partition = threadPartition(bot, thread);
      if (partition.kind === "isolated") return null;
      return isHomePartition(partition) ? "home" : partition.kind === "project" ? `project:${partition.groupId}` : JSON.stringify(partition);
    };
    const sourceKey = key(storedSource, pack.source_thread_id), targetKey = key(storedTarget, access.threadId);
    if (sourceKey === null || targetKey === null || sourceKey !== targetKey) return null;

    if (turn.anchor) {
      const anchor = turn.anchor;
      const stored = db.prepare("SELECT rowid AS mrow FROM messages WHERE thread_id=? AND id=?").get(access.threadId, anchor.messageId);
      const message = readMessage(access.threadId, anchor.messageId) as (MessageWithPack | undefined);
      if (!stored || Number(stored.mrow) !== anchor.mrow || message?.packId !== pack.id || message.automation?.kind !== "delegation"
        || branchRows(access.threadId, readActiveLeafOrNewest(access.threadId)).contains(anchor.mrow) !== true) return null;
    } else {
      if (turn.delegationId !== pack.delegation_id) return null;
      if (!db.prepare("SELECT 1 FROM pending_delegations WHERE id=? AND source_thread_id=? AND from_bot_id=? AND to_bot_id=? AND target_thread_id=? AND phase='started'")
        .get(pack.delegation_id, pack.source_thread_id, pack.source_bot_id, access.botId, access.threadId)) return null;
    }
    return { sourceThreadId: pack.source_thread_id, ids: new Set(pack.refs) };
  } catch { return null; }
}

type MessageWithPack = import("../store.ts").Message & { packId?: string };

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
    const value=access as MemoryAccess;
    const current=resolveRecallView({botId:value.botId,threadId:value.threadId,humanPrincipal:value.humanPrincipal,notOwnerAudience:trusted.claim.notOwnerAudience===true},trusted.roster(),true);
    return current.room || recallViewRoom(value);
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
  if (!policyGranted()) throw new Error("MEMORY_POLICY_PENDING");
  const binding={botId:claim.botId,threadId:claim.threadId,humanPrincipal:principal,notOwnerAudience:claim.notOwnerAudience===true};
  let ready: ReturnType<typeof resolveRecallView>;
  try{ready=resolveRecallView(binding,roster());}
  catch(error){
    // A member the roster no longer seats on this thread has no audience at all: denied, not "try again". Roster lookups only.
    if(error instanceof RecallPreparationPending && !rosterSeats(claim.botId,claim.threadId,roster()))throw new RecallViewLost();
    throw error;
  }
  const scopeIds = ready.scopes;
  if (!scopeIds.length) throw new Error("MEMORY_UNAUTHORIZED");
  registry.retainMemoryView(claim,ready.handle.viewId,()=>retainRecallView(ready.handle,binding,()=>registry.isActive(claim),roster,true));
  const access = Object.freeze({botId:claim.botId,threadId:claim.threadId,generation:claim.generation,policyRevision:state.policyRevision,deletionEpoch:state.deletionEpoch,humanPrincipal:principal,scopeIds,view:ready.handle,notOwnerAudience:claim.notOwnerAudience===true});
  contexts.set(access,{claim,registry,roster}); return access;
}

/** Host background processing reuses current audience policy without minting a
 * tool capability or an owner ticket. This is not a dispatch/disclosure grant. */
/** `observeOnly`: reading what a skill or routine says right now (the recovery of a half-finished change) is not a use of memory, so it does not wait for memory
 * to be switched on: the mode check is skipped, every other check (the roster's grant, excluded threads, eligibility) is the same. */
export function backgroundMemoryScopes(botId: string, threadId: string, roster: MemoryRoster, observeOnly = false): readonly string[] {
  const state = memoryState();
  if ((!observeOnly && !["active", "capture"].includes(state.mode)) || !policyGranted()) return [];
  const excluded = database().prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=?").get(threadId);
  if (excluded) return [];
  return currentEligible(botId, threadId, roster);
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

// Producer owner: recall-fix-h; consumer owner: recall-prod-y (deny-only continuation).
/** Private issuance/liveness only; reads and resumes still require assertMemoryAccess. */
export function assertIssuedMemoryAccess(access: MemoryAccess): void {
  const trusted = contexts.get(access);
  if (!trusted || !trusted.registry.isActive(trusted.claim)) throw new Error("MEMORY_UNAUTHORIZED");
}

export function assertMemoryAccess(access: MemoryAccess, scope?: string) {
  assertIssuedMemoryAccess(access);
  const trusted = contexts.get(access)!;
  const roster = trusted.roster();
  const checks = livePassLookup(database(), access, () => ({ roster, revision: roster.memoryRosterRevision, scopes: new Set<string | undefined>() }));
  if (checks.roster !== roster || checks.revision !== roster.memoryRosterRevision) {
    checks.scopes.clear(); checks.roster = roster; checks.revision = roster.memoryRosterRevision;
  }
  // Inside a synchronous pass the meta row and the policy binding are read once (a row this connection writes ends the memo).
  const { state, granted } = passLookup(database(), "assert-memory-state", () => ({ state: memoryState(), granted: policyGranted() }));
  if (state.policyRevision !== access.policyRevision || state.deletionEpoch !== access.deletionEpoch || passLookup(database(), `assert-reader-denied:${access.botId}:${access.threadId}`, () => memoryReaderDenied(database(), access.threadId, access.botId)) || !granted) throw new Error("MEMORY_CONTEXT_REVOKED");
  const principal = threadHumanPrincipal(access.threadId); assertHumanPrincipal(principal);
  if (JSON.stringify(principal)!==JSON.stringify(access.humanPrincipal)) throw new Error('MEMORY_CONTEXT_REVOKED');
  if (checks.scopes.has(scope)) return;
  let current: ReturnType<typeof resolveRecallView>;
  const binding={botId:access.botId,threadId:access.threadId,humanPrincipal:principal,notOwnerAudience:trusted.claim.notOwnerAudience===true};
  // A roster widening is recomputed where the roster is written (persistMemoryRoster), so a live reader finds its current view here.
  try{current=resolveRecallView(binding,roster,true);}
  catch(error){if(error instanceof RecallPreparationPending)throw new RecallViewLost();throw error;}
  assertIssuedRecallView(database(),access.view);
  // S2: a cited scope must be in the view this access was issued AND in the current one, so a withdrawn or narrowed scope is refused.
  if (scope && (!recallViewHasScope(database(),access.view,scope) || !recallViewHasScope(database(),current.handle,scope))) throw new Error('MEMORY_SCOPE_DENIED');
  const view=current.handle;trusted.registry.retainMemoryView(trusted.claim,view.viewId,()=>retainRecallView(view,binding,()=>trusted.registry.isActive(trusted.claim),trusted.roster));
  checks.scopes.add(scope);
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


/** Indexed membership of the immutable issued reader. It never promotes lineage-only membership to recall authority. */
export function memoryAccessHasScope(access: MemoryAccess, scope: string): boolean {
  try{assertMemoryAccess(access,scope);return true;}catch(error){if(error instanceof Error && error.message==='MEMORY_SCOPE_DENIED')return false;throw error;}
}
/** Lineage can read access scopes union S(P). This separate handle must never drive retrieval. */
export function lineageReaderAudience(access: MemoryAccess): import('./lineage-types.ts').LineageAudience {
  assertMemoryAccess(access);
  return Object.freeze({owner:memoryAccessIsOwnerAudience(access),scopeIds:Object.freeze([]),view:access.view});
}

/** A memory-off/last-resort person reader holds S(P) alone, never the recall union. Unknown coverage keeps the legacy empty fallback. */
export function preparationLineageAudience(botId:string,threadId:string,roster:MemoryRoster,principal:HumanPrincipal,notOwnerAudience:boolean): import('./lineage-types.ts').LineageAudience {
  const empty=Object.freeze({owner:false,scopeIds:Object.freeze([])});
  if(isWorkspaceOwner(principal)||isGroupPrincipal(principal))return empty;
  try {const ready=resolveRecallView({botId,threadId,humanPrincipal:principal,notOwnerAudience},roster);return Object.freeze({...empty,view:ready.handle,personOnly:true});}
  catch{return empty;}
}

/** Construction-only publication fence. Never hash a roster on an admission or record-read path. */
export function recallRosterMatchesPolicy(roster: MemoryRoster): boolean {
  try{const row=policyRow();return row?.state==='granted' && JSON.parse(String(row.intent)).hash===fingerprint(roster);}catch{return false;}
}

/** Structural maintenance upgrades only an authentic legacy roster snapshot. Never called by admission.
 * Missing partition facts cannot certify a view: reconcile first, revoking legacy receipts before v2 publication. */
export function reconcileLegacyRecallRoster(roster: MemoryRoster): void {
  const row = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=? AND state='granted' AND json_type(intent,'$.snapshot.v') IS NULL").get(POLICY_ID);
  if (!row) return;
  let intent: {hash?: unknown; snapshot?: {v?: unknown}};
  try { intent = JSON.parse(String(row.intent)); } catch { return; }
  if (!intent.snapshot || intent.snapshot.v !== undefined) return;
  const current = rosterSnapshot(roster);
  const legacy = {
    bots: current.bots.map(({id, section, threads}) => ({id, section, threads})),
    groups: current.groups.map(({id, section, members, threads}) => ({id, section, members, threads})),
  };
  const bytes = JSON.stringify(legacy);
  if (JSON.stringify(intent.snapshot) !== bytes || intent.hash !== createHash('sha256').update(bytes).digest('hex')) return;
  reconcileMemoryRoster(roster);
}

/** Same publication hash as rosterSnapshot, computed cooperatively on the maintenance path. */
export function* recallRosterSnapshotSteps(roster: MemoryRoster,budget = new ConstructionBudget()): Generator<void,Snapshot> {
  const bots: Snapshot['bots']=[],groups: Snapshot['groups']=[],botOrder:string[]=[],groupOrder:string[]=[];
  const strings=(a:string,b:string)=>a<b?-1:a>b?1:0;
  for(const bot of roster.bots) {
    budget.add(bot.id,bot.threadId,bot.section??'');
    botOrder.push(bot.id);
    const threads=new Set<string>([bot.threadId]),meta=new Map<string,string>(),taskOrder:Array<[string,string]>=[],seenTasks=new Set<string>();let duplicate=false;
    for(const task of bot.tasks??[]) {
      budget.add(task.threadId);
      threads.add(task.threadId);const desk=task.channelProjectDesk,team=task.sharedWork;
      const m=desk||team?`${desk?`desk:${desk.groupId}:${desk.archivedAt===undefined?0:1}`:''}|${team?`team:${team.teamId}:${team.quarantined?1:0}`:''}`:'';
      if(seenTasks.has(task.threadId))duplicate=true;seenTasks.add(task.threadId);taskOrder.push([task.threadId,m]);
      if(m&&!meta.has(task.threadId)&&!(task.threadId in Object.prototype))meta.set(task.threadId,m);yield;
    }
    const ts:string[]=[];for(const thread of threads){ts.push(thread);yield;}
    const entries:Array<[string,string]>=[];for(const entry of meta){entries.push(entry);yield;}
    const ordered=yield* constructionSort(entries,([a],[b])=>a.localeCompare(b));
    const facts:Record<string,string>={},keys:string[]=[];for(const [key,value] of ordered){facts[key]=value;keys.push(key);yield;}constructionObjectKeys(facts,keys);
    const sharing:string[]=[];
    if(bot.sharedWith?.mode==='list')for(const team of bot.sharedWith.teams){budget.add(team.id);sharing.push(team.id);yield;}
    else sharing.push(bot.sharedWith?.mode??'none');
    bots.push({id:bot.id,section:bot.section?.trim()||'',threads:yield* constructionSort(ts,strings),partitioned:bot.partitionedAt!==undefined?1:0,meta:facts,sharing:yield* constructionSort(sharing,strings),roles:[bot.individual===true,bot.chiefOfStaff===true,bot.chiefScope==='workspace'],...(duplicate?{taskOrder}:{})});yield;
  }
  for(const group of roster.groups) {
    budget.add(group.id,group.threadId);groupOrder.push(group.id);
    const threads=new Set<string>([group.threadId]);for(const task of group.tasks??[]){budget.add(task.threadId);threads.add(task.threadId);yield;}
    const ts:string[]=[];for(const thread of threads){ts.push(thread);yield;}
    const members:string[]=[];for(const member of group.memberIds){budget.add(member);members.push(member);yield;}
    const marks:Array<[string,unknown]>=[];for(const key in group.partitionedFor??{})if(Object.hasOwn(group.partitionedFor!,key)){budget.add(key);marks.push([key,group.partitionedFor![key]]);yield;}
    const ordered=yield* constructionSort(marks,([a],[b])=>a.localeCompare(b));
    const partitionedFor:Array<[string,string]>=[];for(const [id,mark] of ordered){partitionedFor.push([id,JSON.stringify(mark??null)]);yield;}
    groups.push({id:group.id,section:group.dm?'':group.section?.trim()||'',members:yield* constructionSort(members,strings),threads:yield* constructionSort(ts,strings),dm:group.dm?1:0,project:group.channelProject?1:0,partitionedFor,audience:group.dmAudience===undefined?null:JSON.stringify(group.dmAudience)});yield;
  }
  return {v:2,bots:yield* constructionSort(bots,(a,b)=>a.id.localeCompare(b.id)),groups:yield* constructionSort(groups,(a,b)=>a.id.localeCompare(b.id)),order:[botOrder,groupOrder]};
}

/** Scalar JSON extraction must not parse the monolithic policy snapshot. Writers use canonical hash-first JSON.
 * Unknown encodings fail closed; the complete legacy bytes are compared cooperatively before any migration proof. */
export function recallPolicyHeader() {
  const row=database().prepare("SELECT state,CAST(substr(CAST(intent AS BLOB),1,128) AS TEXT) AS prefix FROM memory_scope_bindings WHERE id=? AND length(CAST(intent AS BLOB))<=1048576").get(POLICY_ID);
  if(row?.state!=='granted')return undefined;
  const match=/^\{"hash":"([a-f0-9]{64})","snapshot":\{("v":2,|"bots":)/.exec(String(row.prefix));
  return match?{hash:match[1],legacy:match[2]==='"bots":'}:undefined;
}
export function* recallRosterMatchesPolicySteps(roster: MemoryRoster,budget=new ConstructionBudget()): Generator<void,boolean> {
  const header=recallPolicyHeader();if(!header)return false;
  const snapshot=yield* recallRosterSnapshotSteps(roster,budget);
  const hash=createHash('sha256');for(const bytes of constructionJson(snapshot)){hash.update(bytes);yield;}
  const actual=hash.digest('hex');
  if(!header.legacy)return actual===header.hash;
  const proof=database().prepare('SELECT hash FROM memory_recall_roster_proof WHERE id=1').get();
  return proof?.hash===actual;
}

/** Legacy publication has no partition facts. Prove its complete canonical bytes, then revoke its
 * receipts and ensure scopes in bounded batches before publishing a fixed-size v2 proof.
 * The old binding remains intact; a later structural writer upgrades it through normal reconciliation. */
export function* prepareLegacyRecallRosterSteps(roster: MemoryRoster,budget:ConstructionBudget,
  advance:(write:()=>void)=>void): Generator<void> {
  const header=recallPolicyHeader();if(!header?.legacy)return;
  const db=database();
  if(db.prepare('SELECT 1 FROM memory_recall_roster_proof WHERE id=1').get())return;
  const snapshot=yield* recallRosterSnapshotSteps(roster,budget);
  const bots:Array<{id:string;section:string;threads:string[]}>=[],groups:Array<{id:string;section:string;members:string[];threads:string[]}>=[];
  for(const {id,section,threads} of snapshot.bots){bots.push({id,section,threads});yield;}
  for(const {id,section,members,threads} of snapshot.groups){groups.push({id,section,members,threads});yield;}
  const legacy={bots,groups},legacyHash=createHash('sha256');
  for(const part of constructionJson(legacy)){legacyHash.update(part);yield;}
  if(legacyHash.digest('hex')!==header.hash)return;
  const canonical=createHash('sha256');
  for(const part of constructionJson({hash:header.hash,snapshot:legacy})){canonical.update(part);yield;}
  const stored=createHash('sha256');
  for(let offset=1;;offset+=4096){
    const row=db.prepare('SELECT substr(CAST(intent AS BLOB),?,4096) AS bytes FROM memory_scope_bindings WHERE id=?').get(offset,POLICY_ID);
    const bytes=row?.bytes as Uint8Array|undefined;if(!bytes?.length)break;
    stored.update(bytes);yield;
  }
  if(stored.digest('hex')!==canonical.digest('hex'))return;
  const next=createHash('sha256');for(const part of constructionJson(snapshot)){next.update(part);yield;}
  const hash=next.digest('hex');
  advance(()=>{db.exec('UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1');commitRevoke(db,{kind:'policy',cause:'policy-bump'},{inline:false});});yield;
  for(;;){
    const result=db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE rowid IN (SELECT rowid FROM memory_disclosures WHERE state IN ('prepared','delivered') LIMIT 64)").run();
    yield;if(!Number(result.changes))break;
  }
  const ensure=function*(kind:MemoryScopeKind,key:string):Generator<void>{advance(()=>{ensureScope(kind,key);});yield;};
  for(const bot of snapshot.bots){yield* ensure('bot',bot.id);yield* ensure('team',bot.section);for(const thread of bot.threads)yield* ensure('conversation',thread);}
  for(const room of snapshot.groups){yield* ensure('room',room.id);for(const thread of room.threads)yield* ensure('conversation',thread);}
  db.prepare('INSERT INTO memory_recall_roster_proof VALUES(1,(SELECT epoch FROM memory_recall_epoch WHERE id=1),?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,hash=excluded.hash').run(hash);
}
