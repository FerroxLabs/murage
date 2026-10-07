// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { recordDelegationReceipt } from "./delegations.ts";
import { cancelPeerApprovalsForRequest } from "./peer-approval.ts";
import { randomUUID } from "node:crypto";
import { database } from "./database.ts";
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
export function isSharedWorkRow(row: Pick<RoomRequest,"toBotId"|"targetThreadId">, store = executionStore()): boolean {
  return !!row.toBotId && !!row.targetThreadId && !!store?.bot(row.toBotId)?.tasks?.some(t => t.threadId === row.targetThreadId && t.sharedWork);
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
      else if (!prov && current.verb !== "wake" && isSharedWorkRow(current)) merge(CLOSED_CEILING);
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
export function enqueueSharedWork(store: Store, input: { routineAuthority?: RoutinePeerSource; fromBotId: string; sourceThreadId: string; toBotId: string; message: string; admissionKey: string; ownerAudience: boolean; now: number; parentRequestId?: string; tag?: ExecutionAudience | null; verb?: "ask"|"message"; id?: string; unattended?: boolean }) {
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
  const db=database();db.exec("SAVEPOINT shared_enqueue");
  try {
    const old=roomRequestByKey(db,input.admissionKey);
    if(old){db.exec("RELEASE shared_enqueue");return {ok:true as const,request:old,created:false};}
    const count=db.prepare("SELECT count(*) AS n FROM room_requests WHERE to_bot_id=? AND target_thread_id=? AND state='queued'").get(target.id,task.threadId)!;
    if(Number(count.n)>=20){db.exec("RELEASE shared_enqueue");return {ok:false as const,code:"shared_queue_cap",retry:"never" as const,line:`${target.name} has 20 requests waiting from ${pair.section}. Try again later.`};}
    const parent=input.parentRequestId?roomRequest(db,input.parentRequestId):null;
    const roomParent=parent && store.groupByThread(input.sourceThreadId) && !isSharedWorkRow(parent,store);
    const inserted=insertRoomRequest(db,{id,groupId:pair.id,targetThreadId:task.threadId,verb:input.verb??"ask",fromKind:"bot",fromBotId:from.id,toBotId:target.id,parentId:parent?.id,payloadText:input.message,admissionKey:input.admissionKey,now:input.now,deadlineAt:input.now+86400000,returnThreadId:roomParent?input.sourceThreadId:undefined,returnBotId:roomParent?from.id:undefined,lineage:{rootThreadId:input.sourceThreadId,origin:"desktop",audienceFingerprint:"owner",notOwnerAudience:!input.ownerAudience,unattended:input.unattended===true||parent?.unattended===true,executionAudience:tag}});
    // persisted before the request commits: a crash in between leaves a ceiling with no request, never the reverse
    // provenance (routine or explicitly none) commits with the request itself, so a restart can always tell
    if(inserted.created){recordProvenance(inserted.request.id,input.routineAuthority);if(input.routineAuthority){ceilings().set(inserted.request.id,validCeiling(input.routineAuthority));saveCeilings();}}
    db.exec("RELEASE shared_enqueue");return {ok:true as const,...inserted};
  }catch(error){db.exec("ROLLBACK TO shared_enqueue; RELEASE shared_enqueue");throw error;}
}
export function sharedCapacity(botId:string,teamId:string): "shared_team_cap"|"shared_total_cap"|null {
  const store=executionStore(),db=database();
  const rows=db.prepare("SELECT id FROM room_requests WHERE to_bot_id=? AND state IN ('running','waiting_owner','waiting_bot')").all(botId).map(r=>roomRequest(db,String(r.id))!).filter(r=>isSharedWorkRow(r,store));
  if(rows.some(r=>{const tag=sharedRowAudience(r);return tag?.kind==="team"&&tag.team===teamId;}))return "shared_team_cap";
  return new Set(rows.map(row=>row.targetThreadId)).size>=2?"shared_total_cap":null;
}
export function sharedDispatchOrder(botId:string):RoomRequest[] {
  const db=database(),rows=queuedRoomRequests(db).filter(r=>r.toBotId===botId&&isSharedWorkRow(r));
  const team=(r:RoomRequest)=>{const tag=sharedRowAudience(r);return tag?.kind==="team"?tag.team:"";};
  const last=(id:string)=>Number(db.prepare("SELECT MAX(dispatched_at) AS at FROM room_requests WHERE to_bot_id=? AND json_extract(execution_audience,'$.team')=?").get(botId,id)?.at??-1);
  const oldest=(id:string)=>Math.min(...rows.filter(r=>team(r)===id).map(r=>r.createdAt));
  return rows.sort((a,b)=>last(team(a))-last(team(b))||oldest(team(a))-oldest(team(b))||team(a).localeCompare(team(b))||a.createdAt-b.createdAt||a.id.localeCompare(b.id));
}
export interface SharedDrainDeps { admission:WorkAdmission; open():boolean; start(request:RoomRequest,claim:AdmissionClaim):void; closed(request:RoomRequest,line:string):void; changed():void; hooks?:CompletionHooks; now():number }
let drainDeps: SharedDrainDeps | undefined;
export function configureSharedDrain(deps:SharedDrainDeps):void {drainDeps=deps;}
const draining=new Set<string>();
function recordClosedSharedDelegation(row:RoomRequest,line:string):void {
  if(!row.admissionKey.startsWith("ask:delegation:")||!row.toBotId)return;
  const sourceThreadId=requestSourceThread(row.id);if(!sourceThreadId)return;
  const terminal=roomRequest(database(),row.id);if(!terminal||!isTerminalRoomRequestState(terminal.state))return;
  recordDelegationReceipt({id:row.admissionKey.slice("ask:delegation:".length),sourceThreadId,toBotId:row.toBotId,toBotName:executionStore()?.bot(row.toBotId)?.name??row.toBotId,
    status:terminal.state==="expired"?"expired":"failed",result:line,lineage:true});
}

export function drainSharedWork(botId:string):void {
  const deps=drainDeps;if(!deps?.open()||draining.has(botId))return;
  draining.add(botId);
  const closed=(row:RoomRequest,line:string)=>{recordClosedSharedDelegation(row,line);deps.closed(row,line);};
  try { for(const row of sharedDispatchOrder(botId)){
    if(row.deadlineAt!==null&&row.deadlineAt<=deps.now()){completeRequest(database(),row.id,{state:"expired",now:deps.now(),outcomeNote:"shared-expired"},deps.hooks);closed(row,`${executionStore()?.bot(botId)?.name??"This bot"} could not get to this in a day. Ask again.`);continue;}
    const allowed=authorizeWork({edge:"dispatch",requestId:row.id,targetBotId:botId,targetThreadId:row.targetThreadId!,tag:sharedRowAudience(row),kind:row.verb==="wake"?"wake":"shared"});
    if(!allowed.ok){if(allowed.retry==="queue")recordRoomRequestRefusal(database(),row.id,allowed.code);else{completeRequest(database(),row.id,{state:"cancelled",now:deps.now(),outcomeNote:allowed.code},deps.hooks);closed(row,allowed.line);}continue;}
    const tag=sharedRowAudience(row);if(tag?.kind!=="team")continue;
    const parent=row.verb==="wake"&&row.parentId?roomRequest(database(),row.parentId):null;
    const cap=parent?.state==="waiting_bot"&&parent.targetThreadId===row.targetThreadId?null:sharedCapacity(botId,tag.team);if(cap){recordRoomRequestRefusal(database(),row.id,cap);continue;}
    const decision=deps.admission.admit({kind:row.verb==="wake"?"wake":"delegation",priority:row.priority,botId,threadId:row.targetThreadId!,requestId:row.id,rootId:row.rootId,ownerOrigin:true,audience:{ownerAudience:!row.notOwnerAudience,fingerprint:row.audienceFingerprint,execution:tag},now:deps.now()});
    if(!decision.admit){if(decision.retry==="never"){completeRequest(database(),row.id,{state:"cancelled",now:deps.now(),outcomeNote:decision.reason},deps.hooks);closed(row,decision.line);}else recordRoomRequestRefusal(database(),row.id,decision.reason);continue;}
    if(!markRequestDispatched(database(),row.id,{now:deps.now(),targetThreadId:row.targetThreadId!})){decision.claim.release();continue;}
    try{deps.start(roomRequest(database(),row.id)!,decision.claim);}catch(error){decision.claim.release();completeRequest(database(),row.id,{state:"failed",now:deps.now(),outcomeNote:"start-failed"},deps.hooks);throw error;}
  }deps.changed();}finally{draining.delete(botId);}
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
