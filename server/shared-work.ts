// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { scopedTx } from "./tx-scope.ts";
import { DELETED_NOTE, findDelegationReceipt, handoffPhaseOf, handoffRow, recordDelegationReceipt } from "./delegations.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { hostLine } from "./host-words.ts";
import { cancelPeerApprovalsForRequest } from "./peer-approval.ts";
import { randomUUID } from "node:crypto";
import { database, transaction } from "./database.ts";
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
import { completeRequest, insertRoomRequest, isTerminalRoomRequestState, markRequestDispatched, queuedRoomRequests, recordRoomRequestRefusal, roomRequest, roomRequestByKey, type RoomRequest, type CompletionHooks } from "./room-requests.ts";
import type { AdmissionClaim, AdmissionInput, ExecutionAudience, WorkAdmission } from "./work-admission.ts";

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
  }catch(error){db.exec("ROLLBACK TO shared_enqueue; RELEASE shared_enqueue");throw error;}
  });
}
export function sharedCapacity(botId:string,teamId:string): "shared_team_cap"|"shared_total_cap"|null {
  const db=database();
  const rows=db.prepare("SELECT id FROM room_requests WHERE to_bot_id=? AND state IN ('running','waiting_owner','waiting_bot')").all(botId).map(r=>roomRequest(db,String(r.id))!).filter(r=>isSharedWorkRow(r));
  if(rows.some(r=>{const tag=sharedRowAudience(r);return tag?.kind==="team"&&tag.team===teamId;}))return "shared_team_cap";
  return new Set(rows.map(row=>row.targetThreadId)).size>=2?"shared_total_cap":null;
}
/** The shared requests this bot can start, in fair order. Q1 filtered by bot (the runnable ids, never a parked row), then each is classified by its own provenance
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
/** Where a team's walk has reached in one drain pass: the head of the team after this (created_at, id) is the next one considered. */
export type SharedCursors=Map<string,{at:number;id:string}>;
const TEAMS_SQL="WITH RECURSIVE t(team) AS (SELECT MIN(json_extract(execution_audience,'$.team')) FROM room_requests WHERE state='queued' AND refusal IS NOT 'retained_unresolved' AND to_bot_id=? AND json_extract(execution_audience,'$.team') IS NOT NULL UNION ALL SELECT (SELECT MIN(json_extract(execution_audience,'$.team')) FROM room_requests WHERE state='queued' AND refusal IS NOT 'retained_unresolved' AND to_bot_id=? AND json_extract(execution_audience,'$.team')>t.team) FROM t WHERE t.team IS NOT NULL) SELECT team FROM t WHERE team IS NOT NULL";
const TEAM_HEAD_SQL="SELECT id, created_at FROM room_requests WHERE state='queued' AND refusal IS NOT 'retained_unresolved' AND to_bot_id=? AND json_extract(execution_audience,'$.team')=? AND (created_at,id)>(?,?) ORDER BY created_at, id LIMIT 1";
export const SHARED_FAIR_SQL=Object.freeze({teams:TEAMS_SQL,head:TEAM_HEAD_SQL,last:LAST_TEAM_DISPATCH_SQL});
/** The request the shared fair order puts first for this bot, found without reading the queue: the teams with runnable work come from a loose scan of
 * `room_requests_runnable_team` (one seek per team), each team's head is its oldest runnable request after the team's cursor (one seek), and the winner is the
 * least (last start for the team, head's age, team). That is the order `sharedDispatchOrder` sorts the whole queue into, at O(teams x log n). A head it returns may
 * not be startable (not shared work, unresolved, refused): the caller decides, and moves that team's cursor past it. */
export function nextSharedRequest(botId:string,cursors:SharedCursors=new Map()):RoomRequest|null {return nextSharedHead(botId,cursors)?.row??null;}
/** `nextSharedRequest` with the team key its index holds, which is the key a cursor is kept under (a request whose audience does not read back as a team still has one). */
function nextSharedHead(botId:string,cursors:SharedCursors):{row:RoomRequest;team:string}|null {
  const db=database();
  const teams=(db.prepare(TEAMS_SQL).all(botId,botId) as Array<{team:string}>).map(r=>String(r.team));
  const head=db.prepare(TEAM_HEAD_SQL),last=db.prepare(LAST_TEAM_DISPATCH_SQL);
  let best:{id:string;at:number;last:number;team:string}|null=null;
  for(const team of teams){
    const cursor=cursors.get(team);
    const first=head.get(botId,team,cursor?.at??-1,cursor?.id??"") as {id:string;created_at:number}|undefined;
    if(!first)continue;
    const lastAt=teams.length>1?Number((last.get(botId,team) as {at:number|null}|undefined)?.at??-1):-1;
    const candidate={id:first.id,at:Number(first.created_at),last:lastAt,team};
    if(best===null||candidate.last-best.last<0||(candidate.last===best.last&&(candidate.at-best.at<0||(candidate.at===best.at&&candidate.team.localeCompare(best.team)<0))))best=candidate;
  }
  const row=best?roomRequest(db,best.id):null;
  return best&&row?{row,team:best.team}:null;
}
/** Whether this queued shared request is the one the fair order puts first for its bot (`nextSharedRequest`). A request that is no longer queued is not held back by it.
 * The hand-off dispatch asks this when an owner's drain would start shared work, so that drain cannot take a slot ahead of an older request of another team: it
 * leaves the request to `drainSharedWork`, which walks the same order. */
export function sharedRequestIsNext(request:RoomRequest):boolean {
  if(!request.toBotId||request.state!=="queued")return true;
  return nextSharedRequest(request.toBotId)?.id===request.id;
}
export interface SharedDrainDeps { admission:WorkAdmission; open():boolean; start(request:RoomRequest,claim:AdmissionClaim):void; closed(request:RoomRequest,line:string):void; changed():void; hooks?:CompletionHooks; now():number }
let drainDeps: SharedDrainDeps | undefined;
export function configureSharedDrain(deps:SharedDrainDeps):void {drainDeps=deps;}
const draining=new Set<string>();
function recordClosedSharedDelegation(row:RoomRequest,line:string,db:DatabaseSync=database()):void {
  if(!handoffRow(row.id)||!row.toBotId)return;   // a hand-off's request is the one with a hand-off row of its id (never the spelling of its key)
  const sourceThreadId=requestSourceThread(row.id,db);if(!sourceThreadId)return;
  const terminal=roomRequest(db,row.id);if(!terminal||!isTerminalRoomRequestState(terminal.state))return;
  recordDelegationReceipt({id:row.id,sourceThreadId,toBotId:row.toBotId,toBotName:executionStore()?.bot(row.toBotId)?.name??row.toBotId,
    status:terminal.state==="expired"?"expired":"failed",result:hostLine(line),lineage:true});
}

/** A queued shared request past its 24 hour deadline (`deadline_at`, fixed when it was created): closed expired, the requester told, a delegation receipt written. */
export function expireSharedRequest(row:RoomRequest,db:DatabaseSync=database()):RoomRequest|null {
  const deps=drainDeps,now=deps?.now()??Date.now();
  const done=completeRequest(db,row.id,{state:"expired",now,outcomeNote:"shared-expired"},deps?.hooks).request;
  const line=`${row.toBotId?executionStore()?.bot(row.toBotId)?.name??"This bot":"This bot"} could not get to this in a day. Ask again.`;
  recordClosedSharedDelegation(row,line,db);deps?.closed(row,line);
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
    if(sourceThreadId&&!findDelegationReceipt(id))recordDelegationReceipt({id,sourceThreadId,toBotId:row.toBotId,toBotName:executionStore()?.bot(row.toBotId)?.name??row.toBotId,status:"cancelled",result:DELETED_NOTE,lineage:true});
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
    case "cancel": completeRequest(database(), row.id, { state: "cancelled", now: sharedClock(), outcomeNote: verdict.note }, deps?.hooks); recordClosedSharedDelegation(row, verdict.line); deps?.closed(row, verdict.line); return;
    case "wait": if (verdict.record) recordRoomRequestRefusal(database(), row.id, verdict.reason); return;
    default: return;
  }
}
/** The most decisions one drain pass makes. A pass that used them all and still made progress asks for another (setImmediate), so a long queue never holds the event loop. */
export const SHARED_DRAIN_DECISIONS=100;
let lastDecisions=0;
/** How many decisions the last drain pass made (a diagnostic for the bounded-work tests). */
export function _lastDrainDecisions():number {return lastDecisions;}
let totalDecisions=0;
/** How many decisions every pass together has made since the last reset (a diagnostic for the forward-progress tests). */
export function _totalDrainDecisions():number {return totalDecisions;}
export function _resetDrainDiagnostics():void {totalDecisions=0;lastDecisions=0;}
/** Where each bot's walk of the shared queue has reached. It lives across passes and invocations (a pass that spends its decisions resumes where it stopped, so a
 * long run of waiting requests can never keep a runnable one behind it from being reached) and is reset when the walk reaches the end of the queue. A team whose head
 * is waiting is `held` until then: its cursor stays where it was, so retrying it later looks at that head again and nothing before it. Keyed by the database
 * handle, so a different data store never inherits another's position. */
interface Traversal { cursors: SharedCursors; held: Map<string,{at:number;id:string}|undefined> }
const traversals=new WeakMap<DatabaseSync,Map<string,Traversal>>();
function traversalOf(botId:string):Traversal {
  const db=database();let perBot=traversals.get(db);if(!perBot){perBot=new Map();traversals.set(db,perBot);}
  let walk=perBot.get(botId);if(!walk){walk={cursors:new Map(),held:new Map()};perBot.set(botId,walk);}
  return walk;
}
export function drainSharedWork(botId:string):void {
  const deps=drainDeps;if(!deps?.open()||draining.has(botId))return;
  draining.add(botId);
  let exhausted=false;
  const walk=traversalOf(botId),cursors=walk.cursors;
  try {
    // a walk that reaches the end with teams held (their heads waiting) lets them go and tries those heads once more: capacity that freed meanwhile is used by this
    // same invocation. A second end, or an end with nothing held, is the end of the walk: the position is cleared and the next invocation starts from the front.
    let retried=false;
    for(let decisions=0;;decisions++){
      lastDecisions=decisions;
      if(decisions>=SHARED_DRAIN_DECISIONS){exhausted=true;break;}
      const head=nextSharedHead(botId,cursors);
      const row=head?.row;
      if(row)totalDecisions++;
      if(!head||!row){
        if(walk.held.size&&!retried){retried=true;for(const [team,before] of walk.held){if(before)cursors.set(team,before);else cursors.delete(team);}walk.held.clear();continue;}
        cursors.clear();walk.held.clear();break;
      }
      const teamId=head.team;
      // this team's walk moves past the request it just decided on (a request that left the queue is not seen again anyway)
      const past=()=>cursors.set(teamId,{at:row.createdAt,id:row.id});
      // a refused head holds only its own team until the walk reaches the end: the others are still considered
      const hold=()=>{if(!walk.held.has(teamId))walk.held.set(teamId,cursors.get(teamId));cursors.set(teamId,{at:Number.MAX_SAFE_INTEGER,id:""});};
      if(!isSharedWorkRow(row)||sharedResolution(row)!=="resolved"){past();continue;}
      // A shared request that has a hand-off row is that hand-off's: it starts through the hand-off dispatch and nowhere else (server/handoff-dispatch.ts), decided
      // there before any shared write. The partner is found by the row's existence for the request's id, whatever the request's admission key is spelled like (an
      // import or a rebuild resolves ownership by id too), and a wake is no different. One whose hand-off already started (or is held for the owner) is never started from here.
      const handoff=handoffPhaseOf(row.id);
      if(handoff==="started"){past();continue;}
      if(handoff==="queued"){const lost=(error:unknown)=>console.error("[shared] a queued hand-off could not be dispatched; it stays queued",error);try{const outcome=dispatchHandoff(row.id);if(outcome instanceof Promise)outcome.catch(lost);}catch(error){lost(error);}past();continue;}
      const verdict=admitShared(row);
      if(verdict.kind==="skip"){past();continue;}
      if(verdict.kind!=="start"){settleShared(row,verdict);if(verdict.kind==="wait")hold();else past();continue;}
      const claim=verdict.claim!;
      // a hand-off's request whose hand-off is gone has nothing to run: it is never started as a plain request (its receipt says it was one)
      if(findDelegationReceipt(row.id)){claim.release();settleShared(row,{kind:"cancel",note:"handoff-gone",line:"This hand-off is no longer waiting."});past();continue;}
      // the owner's recorded deletions are decided inside the transaction that dispatches, so none can land between the check and the write
      const dispatched=transaction(()=>sharedRequestDeleted(row)?"deleted" as const:markRequestDispatched(database(),row.id,{now:deps.now(),targetThreadId:row.targetThreadId!})?"ok" as const:"lost" as const,{op:"shared-dispatch"});
      if(dispatched==="deleted"){claim.release();cancelDeletedSharedRequest(row);past();continue;}
      if(dispatched==="lost"){claim.release();past();continue;}
      past();
      try{deps.start(roomRequest(database(),row.id)!,claim);}catch(error){claim.release();completeRequest(database(),row.id,{state:"failed",now:deps.now(),outcomeNote:"start-failed"},deps.hooks);throw error;}
    }
    deps.changed();
  }finally{
    draining.delete(botId);
    // a continuation is owed whenever rows remain that this walk has not yet visited, whether or not anything it visited changed state
    let more=false;if(exhausted){try{more=nextSharedRequest(botId,walk.cursors)!==null;}catch{more=false;}}
    if(exhausted&&!more){walk.cursors.clear();walk.held.clear();}
    if(more)setImmediate(()=>{try{drainSharedWork(botId);}catch(error){console.error("[shared] the shared drain failed",error);}});
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
    const destination=requestSourceThread(row.id);if(destination)store.appendMessage(destination,{role:"bot",kind:"activity",tool:{name:`${bot.name} is no longer shared with this team.`,ok:false},requestId:row.id});
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
