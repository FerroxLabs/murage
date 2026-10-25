// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { scopedTx } from "./tx-scope.ts";
import { findDelegationReceipt, handoffPhaseOf, handoffRow, recordDelegationReceipt } from "./delegations.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { hostLine } from "./host-words.ts";
import { botName, QUEUE_CLOSE_CODES, status, type MurageStatus, type QueueCloseCode } from "./murage-status.ts";
import { cancelPeerApprovalsForRequest } from "./peer-approval.ts";
import { randomUUID } from "node:crypto";
import { database, transaction } from "./database.ts";
import { delegationAdmissionHeld } from "./pending-delegations-schema.ts";
import { SHARED_WAKE_PAGE, SWEEP_MS, SWEEP_PAGE, applyReadyChanges, botsWithReadyTeams, hasBotWaiters, nextBotWithWaiting, readyPage, readyTeams, sweepWaitingTeams, wakeOldestWaiting, wakeSharedBot, wakeSharedThread, type ReadyChange, type WaitOn } from "./shared-ready.ts";
import type { DatabaseSync } from "node:sqlite";
import { botDeleted, groupDeletionKey, ownerDeletedThread } from "./owner-deletions.ts";
import type { Store, BotRecord } from "./store.ts";
import { audienceTask, authorizeWork, executionStore, issueExecutionAudience, issueWorkAudience, type WorkRefusal, requestExecutionAudience, sharedWithTeam, validExecutionAudience, requestSourceThread } from "./execution-audience.ts";
import { isLocalOwner, threadHumanPrincipal } from "./human-principals.ts";
import { teamChangeOpen, teamLabel } from "./team-identities.ts";
import { getOrCreateChannel } from "./comms-visibility.ts";
import { ROUTINE_PERMISSION_MODES, type RoutinePeerSource } from "./routine-permissions.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { writeFileAtomic } from "./atomic.ts";
import { completeRequest, insertRoomRequest, RequestEndedError, isTerminalRoomRequestState, markRequestDispatched, queuedRoomRequests, recordRoomRequestRefusal, roomRequest, roomRequestByKey, type RoomRequest, type CompletionHooks } from "./room-requests.ts";
import { ROOT_CAP_WAKES, type AdmissionClaim, type AdmissionInput, type ExecutionAudience, type WorkAdmission } from "./work-admission.ts";
import { murageLine } from "./murage-line.ts";

export function sharedRowAudience(row: RoomRequest): ExecutionAudience | null { return validExecutionAudience(row.executionAudience) ? row.executionAudience : null; }
/** Whether a request is shared work, decided by what the database recorded when the work was created, never by the live registry (Astra r18).
 * `enqueueSharedWork` is the only path that creates shared asks and messages, and it writes a `shared_request_provenance` row in the same savepoint
 * as the request. So a request is shared when it is an ask or message with such a row, or a wake whose parent is one. Everything else (an owner send,
 * a room turn, a routine, a card run, a plain channel or bot ask and their wakes) is not. Each check is a primary-key lookup. */
export function sharedByProvenance(db: DatabaseSync, row: Pick<RoomRequest,"id"|"verb"|"parentId">): boolean {
  const key = row.verb === "ask" || row.verb === "message" ? row.id : row.verb === "wake" ? row.parentId : null;
  if (!key) return false;
  try { return db.prepare("SELECT 1 AS x FROM shared_request_provenance WHERE request_id=?").get(key) !== undefined; }
  catch (error) { if (error instanceof Error && /no such table/.test(error.message)) return false; throw error; }
}
export function isSharedWorkRow(row: Pick<RoomRequest,"id"|"verb"|"parentId">): boolean {
  return sharedByProvenance(database(), row);
}
/** Whether shared work can run now: `resolved` (its bot and task thread are in the registry), `tombstoned` (the owner's deletion of the bot, the task
 * thread or the room was recorded: a durable terminal decision) or `unresolved` (the registry does not list them and no tombstone exists, for instance
 * a registry not loaded yet). Unresolved work is parked, never settled. */
export type SharedResolution = "resolved" | "tombstoned" | "unresolved";
export function sharedResolution(row: Pick<RoomRequest,"toBotId"|"targetThreadId"|"groupId">, store = executionStore(), db = database()): SharedResolution {
  if (row.toBotId && row.targetThreadId && store?.bot(row.toBotId)?.tasks?.some(t => t.threadId === row.targetThreadId)) return "resolved";
  if ((row.toBotId && botDeleted(db, row.toBotId)) || (row.targetThreadId && ownerDeletedThread(db, row.targetThreadId)) || (row.groupId && ownerDeletedThread(db, groupDeletionKey(row.groupId)))) return "tombstoned";
  return "unresolved";
}
/** The registry's own answer, used ONLY to fail closed on a routine ceiling for a chain member that records no provenance (never to classify work). */
function registryMarksShared(row: Pick<RoomRequest,"toBotId"|"targetThreadId">): boolean {
  return Boolean(row.toBotId && row.targetThreadId && executionStore()?.bot(row.toBotId)?.tasks?.some(t => t.threadId === row.targetThreadId && t.sharedWork));
}
/** The admission arbiter's reach check (SPEC-X V3 seam): every start the arbiter admits, as `authorizeWork` sees it. */
export function authorizeAdmission(input: AdmissionInput): { ok: true } | { ok: false; reason: WorkRefusal; retryable: boolean } {
  const row = input.requestId ? roomRequest(database(), input.requestId) : null;
  const allowed = authorizeWork({ edge: "dispatch", requestId: input.requestId ?? "owner", targetBotId: input.botId, targetThreadId: input.threadId,
    tag: row ? sharedRowAudience(row) : issueExecutionAudience(input.botId, input.threadId, "owner"),
    kind: input.kind === "card_run" || input.kind === "review" ? "card" : input.kind === "wake" ? "wake" : row && isSharedWorkRow(row) ? "shared" : input.kind === "delegation" ? "delegation" : "room",
    ownerOrigin: !row && (input.kind === "owner_direct" || input.kind === "room_turn") && input.ownerOrigin });
  return allowed.ok ? { ok: true } : { ok: false, reason: allowed.code, retryable: allowed.retry === "queue" };
}
/** The routine ceiling a shared request was asked under, by request id. A
 * shared teammate runs at no more than this level, after a restart too: the
 * ceilings live in a small file beside the queue, written before the request
 * commits. A restore expires every queued request, so the file is not backed
 * up. A damaged file fails closed: every request still open runs at Ask. */
const SHARED_AUTHORITY_FILE = "shared-routine-authority.json";
const CLOSED_CEILING: RoutinePeerSource = { permissionMode: "ask", triggerSource: "schedule" };
let sharedRoutineAuthority: Map<string, RoutinePeerSource> | null = null;
function validCeiling(value: unknown): RoutinePeerSource {
  const v = value as Partial<RoutinePeerSource> | null;
  return v && typeof v === "object" && ROUTINE_PERMISSION_MODES.includes(v.permissionMode as never) && (v.triggerSource === "manual" || v.triggerSource === "schedule")
    ? { permissionMode: v.permissionMode!, triggerSource: v.triggerSource } : { ...CLOSED_CEILING };
}
function ceilings(): Map<string, RoutinePeerSource> {
  if (sharedRoutineAuthority) return sharedRoutineAuthority;
  const map = new Map<string, RoutinePeerSource>();
  const file = join(DATA_DIR, SHARED_AUTHORITY_FILE);
  if (existsSync(file)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a record");
      for (const [id, value] of Object.entries(raw)) map.set(id, validCeiling(value));
    } catch {
      // Unknown ceilings for anything still open: Ask, never the teammate's own level.
      for (const row of database().prepare("SELECT id FROM room_requests WHERE state IN ('queued','running','waiting_owner','waiting_bot')").all()) map.set(String(row.id), { ...CLOSED_CEILING });
      sharedRoutineAuthority = map;
      saveCeilings();
    }
  }
  sharedRoutineAuthority = map;
  return map;
}
function saveCeilings(): void {
  const map = ceilings(), db = database();
  for (const id of [...map.keys()]) { const row = roomRequest(db, id); if (!row || isTerminalRoomRequestState(row.state)) map.delete(id); }
  writeFileAtomic(join(DATA_DIR, SHARED_AUTHORITY_FILE), JSON.stringify(Object.fromEntries(map), null, 2), { mode: 0o600 });
}
/** Routine PROVENANCE, recorded on each shared request in the database in the same savepoint that inserts it.
 * It is independent of any run's status: after a restart the routine run is marked failed and the authority
 * file may be gone, yet the row still says whether a routine asked ('routine', with the ceiling) or that none
 * did ('none', recorded explicitly). A request with no row at all is UNKNOWN, which is not the same as 'none'. */
type Provenance = { origin: "routine"; ceiling: RoutinePeerSource } | { origin: "none" };
function provenanceOf(requestId: string): Provenance | undefined {
  const db = database();
  const row = db.prepare("SELECT origin, permission_mode, trigger_source FROM shared_request_provenance WHERE request_id=?").get(requestId);
  if (!row) return undefined;
  if (row.origin !== "routine") return { origin: "none" };
  return { origin: "routine", ceiling: validCeiling({ permissionMode: row.permission_mode, triggerSource: row.trigger_source }) };
}
function recordProvenance(requestId: string, authority: RoutinePeerSource | undefined): void {
  const db = database();
  const c = authority ? validCeiling(authority) : null;
  db.prepare("INSERT OR REPLACE INTO shared_request_provenance (request_id, origin, permission_mode, trigger_source) VALUES (?,?,?,?)").run(requestId, c ? "routine" : "none", c?.permissionMode ?? null, c?.triggerSource ?? null);
}
/** The event run a shared request does work for (recorded with the request), found through its parents: a continuation or a
 * request the receiving bot makes in turn belongs to the same run, so the run's limits follow the work. */
export function recordSharedRequestEvent(requestId: string, eventId: string): void {
  database().prepare("INSERT OR REPLACE INTO shared_request_events (request_id, event_id) VALUES (?,?)").run(requestId, eventId);
}
export function sharedRequestEventId(request: Pick<RoomRequest, "id" | "parentId">): string | undefined {
  const db = database(), seen = new Set<string>();
  let current: Pick<RoomRequest, "id" | "parentId"> | null = request;
  while (current && !seen.has(current.id) && seen.size < 50) {
    seen.add(current.id);
    const row = db.prepare("SELECT event_id FROM shared_request_events WHERE request_id=?").get(current.id);
    if (row?.event_id) return String(row.event_id);
    current = current.parentId ? roomRequest(db, current.parentId) : null;
  }
  return undefined;
}
const lowest = (a: RoutinePeerSource, b: RoutinePeerSource): RoutinePeerSource => ({
  permissionMode: ROUTINE_PERMISSION_MODES[Math.min(ROUTINE_PERMISSION_MODES.indexOf(a.permissionMode), ROUTINE_PERMISSION_MODES.indexOf(b.permissionMode))]!,
  triggerSource: a.triggerSource === "schedule" || b.triggerSource === "schedule" ? "schedule" : "manual",
});
/** The ceiling of one request: the authority file's entry and the recorded provenance, whichever is lower.
 * A request recorded as routine-derived whose file entry is gone (absent file, `{}`) is Ask, never the
 * teammate's own level nor even the recorded one: when in doubt, Ask. */
export function sharedRequestRoutineAuthority(requestId: string): RoutinePeerSource | undefined {
  const file = ceilings().get(requestId), prov = provenanceOf(requestId);
  const recorded = prov?.origin === "routine" ? prov.ceiling : undefined;
  if (file && recorded) return lowest(file, recorded);
  if (file) return { ...file };
  return recorded ? { ...CLOSED_CEILING } : undefined;
}
/** The ceiling a WAKE runs under, from disk: the lowest ceiling persisted on any request in its parent chain.
 * A wake carries no ceiling of its own (it is queued by Murage when the last child finishes), so after a restart
 * the in-memory map is empty and only the persisted ancestry can say a routine started the chain.
 * Conservative by design: a chain that cannot be walked to its end (missing parent, cycle, over the 50-row limit)
 * is treated as routine-derived at Ask even if it never had a routine; a shared request in the chain with NO
 * provenance record is unknown, also Ask; and a missing lower ceiling is never replaced by a broader ancestor's.
 * A request recorded as explicitly non-routine, in an intact chain, changes nothing. `routineSourceThread` is a
 * live-only extra check for rows that carry no routine record; `live` (this process's ceiling for the thread)
 * can only lower the result. Undefined means no routine anywhere in the ancestry. */
export function sharedWakeRoutineAuthority(wake: RoomRequest, opts: { routineSourceThread?: (threadId: string) => boolean; live?: RoutinePeerSource | null } = {}): RoutinePeerSource | undefined {
  const db = database(), seen = new Set<string>();
  let found: RoutinePeerSource | undefined;
  const merge = (c: RoutinePeerSource) => { found = found ? lowest(found, c) : { ...c }; };
  let current: RoomRequest | null = wake, complete = false;
  while (current && !seen.has(current.id) && seen.size < 50) {
    seen.add(current.id);
    const file = ceilings().get(current.id), prov = provenanceOf(current.id);
    let routine = false;
    if (file) { merge(file); routine = true; }
    // routine-derived but the authority file lost its entry: Ask, not the recorded level (a lost file is a doubt)
    if (prov?.origin === "routine") { merge(file ? prov.ceiling : CLOSED_CEILING); routine = true; }
    if (!routine && current.id !== wake.id) {
      const source = requestSourceThread(current.id, db);
      if (source && opts.routineSourceThread?.(source)) merge(CLOSED_CEILING);
      // A synthetic continuation wake (Murage's own row) records no provenance by design: its ancestry decides.
      else if (!prov && current.verb !== "wake" && registryMarksShared(current)) merge(CLOSED_CEILING);
    }
    if (!current.parentId) { complete = true; break; }
    current = roomRequest(db, current.parentId);
  }
  if (!complete) merge(CLOSED_CEILING);
  if (opts.live) merge(opts.live);
  return found;
}
export function forgetSharedRequestRoutineAuthority(requestId: string): void { if (ceilings().delete(requestId)) saveCeilings(); }
/** Tests: forget the in-memory copy, as a fresh process would. */
export function _reloadSharedRoutineAuthority(): void { sharedRoutineAuthority = null; }
export function enqueueSharedWork(store: Store, input: { routineAuthority?: RoutinePeerSource; fromBotId: string; sourceThreadId: string; toBotId: string; message: string; admissionKey: string; ownerAudience: boolean; now: number; parentRequestId?: string; tag?: ExecutionAudience | null; verb?: "ask"|"message"; id?: string; unattended?: boolean; eventId?: string }) {
  store.markPartitions();
  const from = store.bot(input.fromBotId), target = store.bot(input.toBotId);
  const id=input.id??randomUUID();
  const inherited = input.parentRequestId ? requestExecutionAudience(input.fromBotId,input.sourceThreadId,input.parentRequestId,id) : input.tag ? {...input.tag,rootRequestId:id} : requestExecutionAudience(input.fromBotId,input.sourceThreadId,undefined,id);
  const allowed = authorizeWork({edge:"peer",requesterBotId:input.fromBotId,requesterThreadId:input.sourceThreadId,targetBotId:input.toBotId,verb:input.verb??"ask",ownerAudience:input.ownerAudience,tag:inherited,parentRequestId:input.parentRequestId});
  if(!allowed.ok)return allowed;
  if(!from||!target)return {ok:false as const,code:"not_reachable",retry:"never" as const};
  const tag=issueWorkAudience(from.id,target.id,input.sourceThreadId,inherited,id,input.ownerAudience);
  if(tag?.kind!=="team"||!sharedWithTeam(target,tag.team))return {ok:false as const,code:"not_reachable",retry:"never" as const};
  // The owner's chain opens the work thread first: while a team change is finishing, a plain line (C5).
  const principal=threadHumanPrincipal(input.sourceThreadId);
  const opened=isLocalOwner(principal)?store.openSharedWork(target.id,tag.team):null;
  const finishing={ok:false as const,code:"shared_paused" as const,retry:"queue" as const,line:`${target.name} can take work for ${teamLabel(tag.team)??"this team"} once the team change finishes. Try again in a moment.`};
  if(opened&&"refused" in opened)return {...finishing,line:opened.refused};
  let pair:ReturnType<typeof getOrCreateChannel>;
  try{pair=getOrCreateChannel(store,from,target,input.sourceThreadId,tag);}catch(error){if(teamChangeOpen())return finishing;throw error;}
  const task=audienceTask(store,target,principal,tag);
  if(!task?.sharedWork)return {ok:false as const,code:"not_reachable",retry:"never" as const};
  const db=database();
  return scopedTx(() => {
  db.exec("SAVEPOINT shared_enqueue");
  try {
    const old=roomRequestByKey(db,input.admissionKey);
    if(old){db.exec("RELEASE shared_enqueue");return {ok:true as const,request:old,created:false};}
    const count=db.prepare("SELECT count(*) AS n FROM room_requests WHERE to_bot_id=? AND target_thread_id=? AND state='queued'").get(target.id,task.threadId)!;
    if(Number(count.n)>=20){db.exec("RELEASE shared_enqueue");return {ok:false as const,code:"shared_queue_cap",retry:"never" as const,line:`${target.name} has 20 requests waiting from ${pair.section}. Try again later.`};}
    const parent=input.parentRequestId?roomRequest(db,input.parentRequestId):null;
    const roomParent=parent && store.groupByThread(input.sourceThreadId) && !isSharedWorkRow(parent);
    const inserted=insertRoomRequest(db,{id,groupId:pair.id,targetThreadId:task.threadId,verb:input.verb??"ask",fromKind:"bot",fromBotId:from.id,toBotId:target.id,parentId:parent?.id,payloadText:input.message,admissionKey:input.admissionKey,now:input.now,deadlineAt:input.now+86400000,returnThreadId:roomParent?input.sourceThreadId:undefined,returnBotId:roomParent?from.id:undefined,lineage:{rootThreadId:input.sourceThreadId,origin:"desktop",audienceFingerprint:"owner",notOwnerAudience:!input.ownerAudience,unattended:input.unattended===true||parent?.unattended===true,executionAudience:tag}});
    // persisted before the request commits: a crash in between leaves a ceiling with no request, never the reverse
    // provenance (routine or explicitly none) commits with the request itself, so a restart can always tell
    if(inserted.created){recordProvenance(inserted.request.id,input.routineAuthority);if(input.eventId)recordSharedRequestEvent(inserted.request.id,input.eventId);if(input.routineAuthority){ceilings().set(inserted.request.id,validCeiling(input.routineAuthority));saveCeilings();}}
    db.exec("RELEASE shared_enqueue");return {ok:true as const,...inserted};
  }catch(error){
    db.exec("ROLLBACK TO shared_enqueue; RELEASE shared_enqueue");
    // F3 fence: the request that asked was cancelled (inside this insert's transaction): a refusal, never a new request
    if(error instanceof RequestEndedError)return {ok:false as const,code:"request_ended" as const,retry:"never" as const,line:"The request that asked for this has ended, so nothing more can be handed on from it."};
    throw error;
  }
  });
}
export function sharedCapacity(botId:string,teamId:string): "shared_team_cap"|"shared_total_cap"|null {
  const db=database();
  const rows=db.prepare("SELECT id FROM room_requests WHERE to_bot_id=? AND state IN ('running','waiting_owner','waiting_bot')").all(botId).map(r=>roomRequest(db,String(r.id))!).filter(r=>isSharedWorkRow(r));
  if(rows.some(r=>{const tag=sharedRowAudience(r);return tag?.kind==="team"&&tag.team===teamId;}))return "shared_team_cap";
  return new Set(rows.map(row=>row.targetThreadId)).size>=2?"shared_total_cap":null;
}
/** A diagnostic only (no module calls it): every shared request this bot could start, sorted by the earlier fair order. The drain serves teams round-robin from the
 * ready-team set instead (shared-ready.ts). Q1 filtered by bot (the runnable ids, never a parked row), then each is classified by its own provenance
 * and by whether its bot and task are listed: an unresolved one is parked by the room sweep (room-dispatcher.ts), never run here. The `last(team)`
 * history lookup runs only when the runnable rows span more than one team: with one team there is nothing to order between. */
/** When this bot last started work for a team: one seek in `room_requests_team_dispatch` (the query repeats the index's expression and its literal term). */
export const LAST_TEAM_DISPATCH_SQL="SELECT MAX(dispatched_at) AS at FROM room_requests WHERE to_bot_id=? AND json_extract(execution_audience,'$.team')=? AND dispatched_at IS NOT NULL";
export function sharedDispatchOrder(botId:string):RoomRequest[] {
  const db=database(),rows=queuedRoomRequests(db,{toBotId:botId}).filter(r=>isSharedWorkRow(r)&&sharedResolution(r)==="resolved");
  const team=(r:RoomRequest)=>{const tag=sharedRowAudience(r);return tag?.kind==="team"?tag.team:"";};
  const teams=new Set(rows.map(team));
  const lastAt=new Map<string,number>(),oldestAt=new Map<string,number>();
  if(teams.size>1)for(const id of teams)lastAt.set(id,Number(db.prepare(LAST_TEAM_DISPATCH_SQL).get(botId,id)?.at??-1));
  for(const r of rows)oldestAt.set(team(r),Math.min(oldestAt.get(team(r))??Infinity,r.createdAt));
  const last=(id:string)=>lastAt.get(id)??-1;
  const oldest=(id:string)=>oldestAt.get(id)??Infinity;
  return rows.sort((a,b)=>last(team(a))-last(team(b))||oldest(team(a))-oldest(team(b))||team(a).localeCompare(team(b))||a.createdAt-b.createdAt||a.id.localeCompare(b.id));
}
const TEAMS_SQL="WITH RECURSIVE t(team) AS (SELECT MIN(json_extract(execution_audience,'$.team')) FROM room_requests WHERE state='queued' AND refusal IS NOT 'retained_unresolved' AND to_bot_id=? AND json_extract(execution_audience,'$.team') IS NOT NULL UNION ALL SELECT (SELECT MIN(json_extract(execution_audience,'$.team')) FROM room_requests WHERE state='queued' AND refusal IS NOT 'retained_unresolved' AND to_bot_id=? AND json_extract(execution_audience,'$.team')>t.team) FROM t WHERE t.team IS NOT NULL) SELECT team FROM t WHERE team IS NOT NULL";
// a team's FIFO is its SHARED rows (room_requests.shared_work, shared-ready.ts): a teammate's room ask or a card run of the same (bot, team) is not in it
const TEAM_HEAD_SQL="SELECT id, created_at FROM room_requests WHERE state='queued' AND refusal IS NOT 'retained_unresolved' AND shared_work=1 AND to_bot_id=? AND json_extract(execution_audience,'$.team')=? AND (created_at,id)>(?,?) ORDER BY created_at, id LIMIT 1";
/** A team's queued shared continuation wake (the next step of the request it is already running): one seek in `room_requests_shared_wake`. */
const TEAM_WAKE_SQL="SELECT id FROM room_requests WHERE state='queued' AND verb='wake' AND refusal IS NOT 'retained_unresolved' AND shared_work=1 AND to_bot_id=? AND json_extract(execution_audience,'$.team')=? ORDER BY created_at, id LIMIT 1";
export const SHARED_FAIR_SQL=Object.freeze({teams:TEAMS_SQL,head:TEAM_HEAD_SQL,wake:TEAM_WAKE_SQL,last:LAST_TEAM_DISPATCH_SQL});
/** The HEAD of one team's queue for this bot: its continuation wake if it has one (the next step of the request the team is already running, which holds the
 * team's slot), else its oldest queued request. Nothing behind the head is ever considered: a later request of a team never starts before an earlier one. */
export function sharedTeamHead(botId:string,team:string,db:DatabaseSync=database()):RoomRequest|null {
  const wake=db.prepare(TEAM_WAKE_SQL).get(botId,team) as {id:string}|undefined;
  const id=wake?.id??(db.prepare(TEAM_HEAD_SQL).get(botId,team,-1,"") as {id:string}|undefined)?.id;
  return id?roomRequest(db,String(id)):null;
}
/** The request the shared round puts first for this bot: the head of the first ready team (shared-ready.ts), found without reading the queue. A head it returns
 * may not be startable (not shared work, unresolved, refused): the drain decides. */
export function nextSharedRequest(botId:string):RoomRequest|null {
  const db=database();
  for(const team of readyTeams(db,botId,SHARED_WAKE_PAGE)){const head=sharedTeamHead(botId,team,db);if(head)return head;}
  return null;
}
/** Whether this queued shared request is the one the shared round puts first for its bot (`nextSharedRequest`). A request that is no longer queued is not held back by it.
 * The hand-off dispatch asks this when an owner's drain would start shared work, so that drain cannot take a slot ahead of the round: it leaves the request to
 * `drainSharedWork`. */
export function sharedRequestIsNext(request:RoomRequest):boolean {
  if(!request.toBotId||request.state!=="queued")return true;
  return nextSharedRequest(request.toBotId)?.id===request.id;
}
export interface SharedDrainDeps { admission:WorkAdmission; open():boolean; start(request:RoomRequest,claim:AdmissionClaim):void; closed(request:RoomRequest,line:string):void; changed():void; hooks?:CompletionHooks; now():number }
let drainDeps: SharedDrainDeps | undefined;
export function configureSharedDrain(deps:SharedDrainDeps):void {drainDeps=deps;}
const draining=new Set<string>();
/** Why the queue closed a request it never ran, as the kept line a bot's receipt reads again (the owner reads the same words). A reason with no
 * fixed line keeps the line as Murage composed it, which a receipt reads back as the plain failure. */
export function queueClosedStatus(code:string,botId:string):MurageStatus|undefined {
  if(code==="root_cap")return status("queue_paused_steps",{steps:ROOT_CAP_WAKES});
  const bot=executionStore()?.bot(botId);
  if(!bot)return undefined;
  // a reason with no line of its own is still a refusal, said as one (never the plain failure)
  const why=(QUEUE_CLOSE_CODES as readonly string[]).includes(code)?code as QueueCloseCode:"refused";
  return status("queue_closed",{name:botName(bot),why});
}
function recordClosedSharedDelegation(row:RoomRequest,line:string,db:DatabaseSync=database(),ended?:MurageStatus):void {
  if(!handoffRow(row.id)||!row.toBotId)return;   // a hand-off's request is the one with a hand-off row of its id (never the spelling of its key)
  const sourceThreadId=requestSourceThread(row.id,db);if(!sourceThreadId)return;
  const terminal=roomRequest(db,row.id);if(!terminal||!isTerminalRoomRequestState(terminal.state))return;
  recordDelegationReceipt({id:row.id,sourceThreadId,toBotId:row.toBotId,toBotName:executionStore()?.bot(row.toBotId)?.name??row.toBotId,
    status:terminal.state==="expired"?"expired":"failed",result:ended??hostLine(line),lineage:true});
}

/** A queued shared request past its 24 hour deadline (`deadline_at`, fixed when it was created): closed expired, the requester told, a delegation receipt written. */
export function expireSharedRequest(row:RoomRequest,db:DatabaseSync=database()):RoomRequest|null {
  const deps=drainDeps,now=deps?.now()??Date.now();
  const ended=row.toBotId?queueClosedStatus("expired",row.toBotId):undefined;
  const done=completeRequest(db,row.id,{state:"expired",now,outcomeNote:"shared-expired",...(ended?{ending:ended}:{})},deps?.hooks).request;
  const line=`${row.toBotId?executionStore()?.bot(row.toBotId)?.name??"This bot":"This bot"} could not get to this in a day. Ask again.`;
  recordClosedSharedDelegation(row,line,db,ended);deps?.closed(row,line);
  return done;
}
/** Shared work whose bot, task thread or room the owner deleted (a recorded tombstone): cancelled with a receipt the requester reads. */
export function cancelSharedRequest(row:RoomRequest,note:string,line:string,db:DatabaseSync=database()):RoomRequest|null {
  const deps=drainDeps;
  const done=completeRequest(db,row.id,{state:"cancelled",now:deps?.now()??Date.now(),outcomeNote:note},deps?.hooks).request;
  recordClosedSharedDelegation(row,line,db);deps?.closed(row,line);
  return done;
}
/** The owner's recorded deletion of the request's source conversation, its sender or its target bot (the three tombstones a hand-off is checked against). */
export function sharedRequestDeleted(row:Pick<RoomRequest,"id"|"fromBotId"|"toBotId">,db:DatabaseSync=database()):boolean {
  const source=requestSourceThread(row.id,db);
  return (source!==null&&source!==undefined&&ownerDeletedThread(db,source))||(!!row.fromBotId&&botDeleted(db,row.fromBotId))||(!!row.toBotId&&botDeleted(db,row.toBotId));
}
/** Shared work the owner's deletion covers: cancelled, never started, with the cancelled receipt in the deletion's words. */
export function cancelDeletedSharedRequest(row:RoomRequest,db:DatabaseSync=database()):void {
  const deps=drainDeps;
  completeRequest(db,row.id,{state:"cancelled",now:deps?.now()??Date.now(),outcomeNote:"deleted"},deps?.hooks);
  if((handoffRow(row.id)||findDelegationReceipt(row.id))&&row.toBotId){
    const sourceThreadId=requestSourceThread(row.id,db);const id=row.id;
    if(sourceThreadId&&!findDelegationReceipt(id))recordDelegationReceipt({id,sourceThreadId,toBotId:row.toBotId,toBotName:executionStore()?.bot(row.toBotId)?.name??row.toBotId,status:"cancelled",result:status("receipt_deleted"),lineage:true});
  }
}
/** What the shared arbiter says about one queued shared request (decided without writing; `settleShared` applies it). */
export type SharedVerdict =
  | { kind: "start"; claim?: AdmissionClaim }
  | { kind: "wait"; reason: string; record: boolean }
  | { kind: "cancel"; note: string; line: string }
  | { kind: "expired" }
  | { kind: "deleted" }
  /** not a team's work: left alone */
  | { kind: "skip" };
/** Whether the shared drain is attached and open (the engine is ready and admission is not closed). */
export function sharedDrainOpen(): boolean { return drainDeps?.open() === true; }
/** The shared drain's clock, so a dispatch stamps what the drain would have. */
export function sharedClock(): number { return drainDeps?.now() ?? Date.now(); }
/** The admission of one queued shared request: its deadline, the owner's deletions, the team boundary, the team and total capacity and the arbiter.
 * One function for the shared drain and for the hand-off dispatch (server/handoff-dispatch.ts), so a rule cannot hold on one path and not the other.
 *  - `probe`: the question only ("could it start?"): no claim is taken from the arbiter;
 *  - `reserved`: this dispatch already holds the request's capacity (it is asking again after waiting), so its own running state is not counted against it. */
export function admitShared(row: RoomRequest, options: { probe?: boolean; reserved?: boolean } = {}): SharedVerdict {
  const deps = drainDeps;
  if (!deps) return { kind: "wait", reason: "gate", record: false };
  const botId = row.toBotId!;
  if (row.deadlineAt !== null && row.deadlineAt <= deps.now()) return { kind: "expired" };
  if (sharedRequestDeleted(row)) return { kind: "deleted" };
  const allowed = authorizeWork({ edge: "dispatch", requestId: row.id, targetBotId: botId, targetThreadId: row.targetThreadId!, tag: sharedRowAudience(row), kind: row.verb === "wake" ? "wake" : "shared" });
  if (!allowed.ok) return allowed.retry === "queue" ? { kind: "wait", reason: allowed.code, record: true } : { kind: "cancel", note: allowed.code, line: allowed.line };
  const tag = sharedRowAudience(row);
  if (tag?.kind !== "team") return { kind: "skip" };
  if (options.reserved) return { kind: "start" };
  const parent = row.verb === "wake" && row.parentId ? roomRequest(database(), row.parentId) : null;
  const cap = parent?.state === "waiting_bot" && parent.targetThreadId === row.targetThreadId ? null : sharedCapacity(botId, tag.team);
  if (cap) return { kind: "wait", reason: cap, record: true };
  if (options.probe) return { kind: "start" };
  const decision = deps.admission.admit({ kind: row.verb === "wake" ? "wake" : "delegation", priority: row.priority, botId, threadId: row.targetThreadId!, requestId: row.id, rootId: row.rootId, ownerOrigin: true, audience: { ownerAudience: !row.notOwnerAudience, fingerprint: row.audienceFingerprint, execution: tag }, now: deps.now() });
  if (!decision.admit) return decision.retry === "never" ? { kind: "cancel", note: decision.reason, line: decision.line } : { kind: "wait", reason: decision.reason, record: true };
  return { kind: "start", claim: decision.claim };
}
/** Applies a verdict that is not "start": the writes a refusal, a cancellation, an expiry or a deletion owe (the requester's receipt and line included). */
export function settleShared(row: RoomRequest, verdict: SharedVerdict): void {
  const deps = drainDeps;
  switch (verdict.kind) {
    case "expired": expireSharedRequest(row); return;
    case "deleted": cancelDeletedSharedRequest(row); return;
    case "cancel": { const ended = row.toBotId ? queueClosedStatus(verdict.note, row.toBotId) : undefined; completeRequest(database(), row.id, { state: "cancelled", now: sharedClock(), outcomeNote: verdict.note, ...(ended ? { ending: ended } : {}) }, deps?.hooks); recordClosedSharedDelegation(row, verdict.line, database(), ended); deps?.closed(row, verdict.line); return; }
    // the refusal is written when it changes, never again on every look (an unchanged wait costs no write)
    case "wait": if (verdict.record && row.refusal !== verdict.reason) recordRoomRequestRefusal(database(), row.id, verdict.reason); return;
    default: return;
  }
}
/** The most teams one drain pass decides on (each at most once per pass). A pass that used them all, with ready teams left, asks for another (setImmediate), so a
 * long round never holds the event loop and a team that became ready is served within ceil(ready teams / SHARED_DRAIN_TEAMS) passes. */
export const SHARED_DRAIN_TEAMS=100;
/** The older name of the same bound (one decision per team per pass). */
export const SHARED_DRAIN_DECISIONS=SHARED_DRAIN_TEAMS;
let lastDecisions=0;
/** How many decisions the last drain pass made (a diagnostic for the bounded-work tests). */
export function _lastDrainDecisions():number {return lastDecisions;}
let totalDecisions=0;
/** How many decisions every pass together has made since the last reset (a diagnostic for the forward-progress tests). */
export function _totalDrainDecisions():number {return totalDecisions;}
export function _resetDrainDiagnostics():void {totalDecisions=0;lastDecisions=0;}
const continuing=new Set<string>();
/** A conversation's run ended: the teams whose shared work runs there are ready again (the server calls this when it releases a run). Never throws. */
export function sharedThreadFreed(threadId:string):void {
  try{wakeSharedThread(database(),threadId);}catch(error){console.error("[shared] could not mark a freed conversation's teams ready",error);}
}
/** A turn of this bot ended (a run, a room turn, an admitted claim): one of its slots is free, so the oldest teams waiting on the bot (its total cap, its thread
 * ceiling, a room turn) are ready again, directly (shared-ready.ts wakeSharedBot). Never throws. */
export function sharedBotFreed(botId:string):void {
  try{wakeSharedBot(database(),botId);}catch(error){console.error("[shared] could not mark the teams waiting on a freed bot ready",error);}
}
/** What a waiting head waits on, from the reason it was refused (shared-ready.ts WaitOn): the event that frees it wakes it directly. */
export function waitOnOf(reason:string|null|undefined):WaitOn {
  if(reason==="thread_running")return "thread";
  if(reason==="shared_team_cap")return "team";
  if(reason==="shared_total_cap"||reason==="bot_thread_ceiling"||reason==="speaking_in_room")return "bot";
  return "other";
}
/** How many bots one pump drains at most (the ones with a ready team, round-robin by id), and how many bots the safety sweep visits per pump: a pump's work is
 * bounded whatever the number of bots, and a bot with no ready team costs it nothing. */
export const SHARED_PUMP_BOTS=8;
export const SHARED_SWEEP_BOTS=4;
let pumpCursor="";
let sweepCursor="";
let sweepDueAt:number|undefined;
/** When the global safety sweep is next due (undefined: at the first pump of this process). A diagnostic for the tests. */
export function _sharedSweepDueAt():number|undefined {return sweepDueAt;}
export function _resetSharedPump():void {pumpCursor="";sweepCursor="";sweepDueAt=undefined;}
/** The server's pump (every event that may free work, and the 30 s room sweep): drains the bots that have a READY team, at most SHARED_PUMP_BOTS of them per
 * call (round-robin by id, so none is left behind), and moves the global safety sweep on by at most SHARED_SWEEP_BOTS bots. Waiting teams are not looked at:
 * the events that free them (their conversation, their team's run, the bot's slot) made them ready already. The statements of a pump do not grow with the
 * number of bots or of waiting teams. Never throws. */
export function pumpSharedWork(now:number=Date.now()):void {
  if(!drainDeps?.open())return;
  const db=database();
  try{
    let bots=botsWithReadyTeams(db,pumpCursor,SHARED_PUMP_BOTS);
    if(bots.length<SHARED_PUMP_BOTS&&pumpCursor){const more=botsWithReadyTeams(db,"",SHARED_PUMP_BOTS-bots.length).filter((bot)=>!bots.includes(bot));bots=[...bots,...more];}
    pumpCursor=bots.length>=SHARED_PUMP_BOTS?bots.at(-1)!:"";
    for(const bot of bots){try{drainSharedWork(bot,{continuation:true});}catch(error){console.error("[shared] the shared drain failed",error);}}
  }catch(error){console.error("[shared] the pump could not read the ready teams",error);}
  // the safety sweep: due every SWEEP_MS (and at the first pump of a process: a start is an event for every waiting team), bot by bot, a page of teams each
  if(sweepDueAt!==undefined&&now<sweepDueAt)return;
  const atomically=(writes:()=>void)=>{transaction(writes,{op:"shared-wake"});};
  try{
    for(let visited=0;visited<SHARED_SWEEP_BOTS;visited++){
      const bot=nextBotWithWaiting(db,sweepCursor);
      if(bot===null){sweepCursor="";sweepDueAt=now+SWEEP_MS;return;}
      // a bot whose own sweep is not due yet (it ran within SWEEP_MS) costs no statement; a full page keeps the cursor on the bot for the next pump
      if(sweepWaitingTeams(db,bot,now,atomically)>=SWEEP_PAGE){sweepDueAt=now;return;}
      sweepCursor=bot;
    }
    sweepDueAt=now;
  }catch(error){console.error("[shared] the safety sweep failed",error);}
}
/** One pass of the shared drain for this bot: round-robin over the bot's READY teams (shared-ready.ts), at most SHARED_DRAIN_TEAMS of them, each decided once.
 * Only a team's head is decided (strict FIFO per team). Its outcome moves the team in the set:
 *  - started (or dispatched and waiting for the owner): the team leaves the set; its next event (the run ending, a new head) brings it back behind the others;
 *  - waiting (target busy, team or total cap, refused for now, unresolved): the team is marked waiting and is not looked at by any pass until an event wakes it;
 *  - settled (expired, cancelled, deleted): the team goes behind the others, so a team that keeps settling never holds the round;
 *  - the dispatch gate is closed: the pass stops, nothing changes.
 * An invocation that is an event (not a continuation) first wakes a small fixed page of the oldest waiting teams and runs the bounded safety sweep when due. */
export function drainSharedWork(botId:string,options:{continuation?:boolean}={}):void {
  const deps=drainDeps;if(!deps?.open()||draining.has(botId))return;
  const db=database();
  if(!options.continuation){
    const atomically=(writes:()=>void)=>{transaction(writes,{op:"shared-wake"});};
    try{wakeOldestWaiting(db,botId,SHARED_WAKE_PAGE,atomically);sweepWaitingTeams(db,botId,Date.now(),atomically);}
    catch(error){console.error("[shared] could not wake waiting teams",error);}
  }
  draining.add(botId);
  let more=false;
  lastDecisions=0;
  // the round's next page of ready teams, read once: a team appears in it once, so each is decided at most once per pass; what the pass decides is written in one
  // commit at its end, each change only if the team still holds the place read here (shared-ready.ts applyReadyChanges)
  const changes:ReadyChange[]=[];
  let botWait=false;
  const started=new Set<string>();
  try {
    const page=readyPage(db,botId,SHARED_DRAIN_TEAMS);
    more=page.length>=SHARED_DRAIN_TEAMS;
    for(const {team,seq,gen} of page){
      if(delegationAdmissionHeld()){more=false;break;}
      lastDecisions++;totalDecisions++;
      const row=sharedTeamHead(botId,team,db);
      // a team that waits records what it waits on, and the conversation of the head it waits with (the conversation-freed wake follows the current head)
      const to=(next:ReadyChange["to"],on?:WaitOn)=>{if(on==="bot")botWait=true;changes.push({team,seq,gen,to:next,...(next==="wait"?{on:on??"other",thread:row?.targetThreadId??null}:{})});};
      if(!row){to("leave");continue;}
      // not shared work, or its bot or task is not listed (the room sweep parks it): not startable here, the team waits for its event or the sweep
      if(!isSharedWorkRow(row)||sharedResolution(row)!=="resolved"){to("wait");continue;}
      // A shared request that has a hand-off row is that hand-off's: it starts through the hand-off dispatch and nowhere else (server/handoff-dispatch.ts), decided
      // there before any shared write. The partner is found by the row's existence for the request's id, whatever the request's admission key is spelled like (an
      // import or a rebuild resolves ownership by id too), and a wake is no different. One whose hand-off already started (or is held for the owner) is never started from here.
      const handoff=handoffPhaseOf(row.id);
      if(handoff==="started"){to("wait","team");continue;}
      if(handoff==="queued"){
        let outcome:ReturnType<typeof dispatchHandoff>;
        // a hand-off that waits: what its request was refused for (the shared admission records it), else the target's conversation or the bot was busy
        const handoffWait=()=>{const on=waitOnOf(roomRequest(db,row.id)?.refusal);return on==="other"?"bot":on;};
        try{outcome=dispatchHandoff(row.id);}catch(error){console.error("[shared] a queued hand-off could not be dispatched; it stays queued",error);to("wait");continue;}
        if(outcome instanceof Promise){
          outcome.catch((error:unknown)=>console.error("[shared] a queued hand-off could not be dispatched; it stays queued",error));
          // what the dispatch did before it returned decides, not that it returned a promise: a start cut short before its first wait (preparing or mirroring the
          // turn threw) has put the request back in the queue already, and the trigger that wrote it found the team still ready here. Leaving would drop that
          // team for good; it waits instead (woken by its conversation freeing, the waiting page or the sweep). A start still under way leaves: its end is an event.
          if(roomRequest(db,row.id)?.state==="queued")to("wait",handoffWait());else{started.add(team);to("leave");}continue;
        }
        if(outcome==="started"){started.add(team);to("leave");continue;}
        if(outcome==="settled"){to("back");more=true;continue;}
        if(delegationAdmissionHeld()||!deps.open()){more=false;break;}
        to("wait",handoffWait());continue;
      }
      const verdict=admitShared(row);
      if(verdict.kind==="skip"){to("wait");continue;}
      if(verdict.kind==="wait"){settleShared(row,verdict);if(verdict.reason==="gate"){more=false;break;}to("wait",waitOnOf(verdict.reason));continue;}
      if(verdict.kind!=="start"){settleShared(row,verdict);to("back");more=true;continue;}
      const claim=verdict.claim!;
      // a hand-off's request whose hand-off is gone has nothing to run: it is never started as a plain request (its receipt says it was one)
      if(findDelegationReceipt(row.id)){claim.release();settleShared(row,{kind:"cancel",note:"handoff-gone",line:"This hand-off is no longer waiting."});to("back");more=true;continue;}
      // the owner's recorded deletions are decided inside the transaction that dispatches, so none can land between the check and the write
      const dispatched=transaction(()=>sharedRequestDeleted(row)?"deleted" as const:markRequestDispatched(database(),row.id,{now:deps.now(),targetThreadId:row.targetThreadId!})?"ok" as const:"lost" as const,{op:"shared-dispatch"});
      if(dispatched==="deleted"){claim.release();cancelDeletedSharedRequest(row);to("back");more=true;continue;}
      if(dispatched==="lost"){claim.release();to("wait","team");continue;}
      started.add(team);to("leave");
      // a start that throws ends its request: the team's head changed, so the team goes behind the others instead of leaving
      try{deps.start(roomRequest(database(),row.id)!,claim);}catch(error){changes[changes.length-1]!.to="back";claim.release();completeRequest(database(),row.id,{state:"failed",now:deps.now(),outcomeNote:"start-failed"},deps.hooks);throw error;}
    }
    deps.changed();
  }finally{
    draining.delete(botId);
    if(changes.length){try{transaction(()=>applyReadyChanges(db,botId,changes),{op:"shared-ready"});}catch(error){console.error("[shared] the round's places could not be saved; the teams are decided again on the next event",error);}}
    // the bot had room for every team this pass decided (none waited on the bot, none started, its total cap is not full), and teams still wait on it: a freed
    // slot woke a page of them that could not use it (their own conversation is busy now), so the next page is woken and decided, one page per pass, until one
    // waits on the bot again, one starts, or none is left
    if(changes.length&&!botWait&&started.size===0&&deps.open()&&!delegationAdmissionHeld()){try{if(hasBotWaiters(db,botId)&&sharedCapacity(botId,"")!=="shared_total_cap"&&wakeSharedBot(db,botId)>0)more=true;}catch(error){console.error("[shared] could not wake the teams waiting on the bot",error);}}
    if(more&&!continuing.has(botId)){continuing.add(botId);setImmediate(()=>{continuing.delete(botId);try{drainSharedWork(botId,{continuation:true});}catch(error){console.error("[shared] the shared drain failed",error);}});}
  }
}
let sharedRuntime: { generationFor?:(threadId:string)=>string|undefined; interrupt?:(threadId:string,generation?:string)=>void; closeApprovals?:(threadId:string)=>void } = {};
export function setSharedWorkRuntime(runtime: typeof sharedRuntime):void { sharedRuntime = runtime; }
export function interruptSharedThread(threadId:string):void {sharedRuntime.interrupt?.(threadId,sharedRuntime.generationFor?.(threadId));}
export function changeSharing(store:Store,botId:string,next:NonNullable<BotRecord["sharedWith"]>,running:"finish"|"stop",deps:{now:number;generationFor?:(threadId:string)=>string|undefined;interrupt?:(threadId:string,generation?:string)=>void;closeApprovals?:(threadId:string)=>void}):void {
 deps = { ...sharedRuntime, ...deps };
 const bot=store.bot(botId);if(!bot)return;
 const covered=(teamId:string)=>sharedWithTeam({...bot,sharedWith:next},teamId);
 for(const task of bot.tasks??[]){const work=task.sharedWork;if(!work||work.quarantined)continue;
  if(covered(work.teamId)){delete work.closedAt;delete work.closedReason;delete work.finishing;continue;}
  const rows=database().prepare("SELECT id FROM room_requests WHERE to_bot_id=? AND target_thread_id=? AND state IN ('queued','running','waiting_owner','waiting_bot')").all(bot.id,task.threadId).map(r=>roomRequest(database(),String(r.id))!);
  const active=rows.find(r=>r.state!=="queued");
  for(const row of rows)if(running==="stop"||row.state==="queued"&&!(running==="finish"&&active&&row.verb==="wake"&&(row.parentId===active.id||!!sharedRowAudience(active)?.rootRequestId&&sharedRowAudience(row)?.rootRequestId===sharedRowAudience(active)?.rootRequestId))) {
    completeRequest(database(),row.id,{state:"cancelled",now:deps.now,outcomeNote:"sharing-removed"});
    // A cancelled request's approval card can no longer be answered (Astra r3 #1).
    cancelPeerApprovalsForRequest(row.id);
    const destination=requestSourceThread(row.id);if(destination)store.appendMessage(destination,murageLine({role:"bot",kind:"activity",tool:{name:`${bot.name} is no longer shared with this team.`,ok:false},requestId:row.id}));
  }
  work.closedAt=deps.now;work.closedReason="revoked";delete work.finishing;
  const generation=deps.generationFor?.(task.threadId);
  if(running==="finish") {if(active)work.finishing={requestId:active.id,...(sharedRowAudience(active)?{rootRequestId:sharedRowAudience(active)!.rootRequestId}:{})};else if(generation)work.finishing={generation};}
  else {deps.interrupt?.(task.threadId,generation);deps.closeApprovals?.(task.threadId);if(active)cancelChildren(active.id,deps.now);}
 }
 store.patchBot(bot.id,{sharedWith:next,tasks:bot.tasks});
}
function cancelChildren(parentId:string,now:number):void {for(const row of database().prepare("SELECT id FROM room_requests WHERE parent_id=?").all(parentId)){const request=roomRequest(database(),String(row.id))!;if(!isTerminalRoomRequestState(request.state)){completeRequest(database(),request.id,{state:"cancelled",now,outcomeNote:"sharing-removed"});cancelPeerApprovalsForRequest(request.id);}cancelChildren(request.id,now);}}
export function clearSharedFinishing(store:Store,botId:string,identity:{requestId?:string;generation?:string}):void {
 const bot=store.bot(botId);if(!bot)return;let changed=false;
 for(const task of bot.tasks??[]){const finish=task.sharedWork?.finishing;if(finish&&(identity.requestId&&finish.requestId===identity.requestId||identity.generation&&finish.generation===identity.generation)){delete task.sharedWork!.finishing;changed=true;}}
 if(changed)store.patchBot(botId,{tasks:bot.tasks});
}
