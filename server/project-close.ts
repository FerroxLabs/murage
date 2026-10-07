// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import type { DatabaseSync } from 'node:sqlite';
import { activeProjectGoal, currentProjectClose, insertProjectActivity, projectCardsForGroup, projectSettingsFor } from './project-records.ts';
import { cancelProjectCard } from './project-cards.ts';
import { stopProjectGoal } from './project-goals.ts';
import { setProjectClosed, setProjectReopened, setProjectRunState } from './project-settings.ts';
import { completeRequest, insertRoomRequest, isTerminalRoomRequestState, roomRequest, type RoomRequest, type RoomRequestLineage, type CompletionHooks } from './room-requests.ts';

export class ProjectLifecycleError extends Error {
  // Plain field, not a parameter property: the dev server runs Node's strip-only TypeScript.
  readonly code: 'invalid' | 'not_allowed';
  constructor(code: 'invalid' | 'not_allowed', reason: string) { super(reason); this.code = code; }
}
export function projectLifecycleFailure(error: unknown) {
  if (error instanceof ProjectLifecycleError) return error.code === 'invalid'
    ? {status:400,body:{error:error.message}}
    : {status:409,body:{error:'not_allowed',reason:error.message}};
  return {status:500,body:{error:'The project action could not finish.'}};
}

export interface ProjectCloseDeps {
  groupId: string; threadId: string; memberIds: string[]; now: number; stopGoal?: boolean;
  lineage: RoomRequestLineage;
  completionHooks?: CompletionHooks;
  deliverables(): string[];
  routineNames(): string[];
  pausedRoutineNames?(): string[];
  pauseRoutines(): void;
  /** Durable idempotent message writer, called only after step 2 commits. */
  post(key: string, text: string): void;
  summary(request: RoomRequest): string | null;
  sync(): void;
}
interface CloseStep { closeSeq: number; step: number; summaryRequestId: string | null; stopGoal?: boolean; goalId?: string }
function steps(db: DatabaseSync, groupId: string): CloseStep[] {
  return (db.prepare("SELECT detail FROM project_activity WHERE group_id=? AND kind='close' ORDER BY rowid").all(groupId) as {detail:string}[])
    .map(row => JSON.parse(row.detail) as CloseStep).filter(row => Number.isInteger(row.closeSeq) && Number.isInteger(row.step));
}
function tx<T>(db: DatabaseSync, run: () => T): T {
  db.exec('SAVEPOINT project_close');
  try { const result = run(); db.exec('RELEASE project_close'); return result; }
  catch (error) { db.exec('ROLLBACK TO project_close; RELEASE project_close'); throw error; }
}
function record(db: DatabaseSync, deps: ProjectCloseDeps, step: CloseStep) {
  insertProjectActivity(db,{groupId:deps.groupId,kind:'close',actor:'owner',at:deps.now,requestId:step.summaryRequestId ?? undefined,detail:{...step}});
}
export function startProjectClose(db: DatabaseSync, deps: ProjectCloseDeps): {summaryRequestId: string | null} {
  return tx(db, () => {
    const settings = projectSettingsFor(db,deps.groupId);
    if (!settings) throw new ProjectLifecycleError('not_allowed','Not a project.');
    if (settings.endedAt !== null) throw new ProjectLifecycleError('not_allowed','This is a channel now.');
    if (settings.closedAt !== null) throw new ProjectLifecycleError('not_allowed','This project is closed.');
    const previous = currentProjectClose(db,deps.groupId);
    if (previous && previous.step < 3) return {summaryRequestId:previous.summaryRequestId};
    const goal = activeProjectGoal(db,deps.groupId);
    if (goal && ['planning','working','awaiting_plan_ok'].includes(goal.state)) throw new ProjectLifecycleError('not_allowed','Stop the active goal before closing this project.');
    if (goal && !deps.stopGoal) throw new ProjectLifecycleError('not_allowed','Sign off the goal first, or choose Stop the goal and close.');
    if (deps.lineage.notOwnerAudience) throw new ProjectLifecycleError('not_allowed','Close needs an owner conversation.');
    if (goal) stopProjectGoal(db,{goalId:goal.id,actor:{kind:'owner'},reason:'Project closed',now:deps.now});
    for (const row of db.prepare("SELECT id FROM room_requests WHERE group_id=? AND state IN ('queued','running','waiting_owner','waiting_bot')").all(deps.groupId)) {
      completeRequest(db,String(row.id),{state:'cancelled',now:deps.now,outcomeNote:'project closing'},deps.completionHooks,{continuation:false});
    }
    for (const card of projectCardsForGroup(db,deps.groupId,true)) {
      if (!['done','cancelled'].includes(card.state)) {
        const cancelled = cancelProjectCard(db,{cardId:card.id,actor:{kind:'owner'},now:deps.now});
        if (!cancelled.ok) throw new ProjectLifecycleError('not_allowed',cancelled.reason);
      }
    }
    setProjectRunState(db,{groupId:deps.groupId,runState:'paused',reason:'Closing project',actor:'owner',now:deps.now});
    // Never reused, even after retention pruned every earlier close row: the
    // sequence keys the summary request and its durable message.
    const closeSeq = Math.max(deps.now,...steps(db,deps.groupId).map(step=>step.closeSeq + 1));
    const goalId = goal?.id ?? db.prepare("SELECT id FROM project_goals WHERE group_id=? AND state IN ('done','stopped','failed') ORDER BY created_at DESC,rowid DESC LIMIT 1").get(deps.groupId)?.id as string | undefined;
    const summaryRequestId = settings.leadBotId ? insertRoomRequest(db,{groupId:deps.groupId,verb:'wake',fromKind:'murage',toBotId:settings.leadBotId,
      targetThreadId:deps.threadId,projectGoalId:goalId,lineage:deps.lineage,admissionKey:`close:${deps.groupId}:${closeSeq}`,priority:'coordinator',now:deps.now,
      payloadText:'Write a close summary of what was done, what remains open, and the deliverables. Do not start new work.'}).request.id : null;
    record(db,deps,{closeSeq,step:1,summaryRequestId,goalId,stopGoal:deps.stopGoal === true});
    return {summaryRequestId};
  });
}
/** Validate without effects, interrupt the group's live work, then commit step 1. */
export async function startProjectCloseWithInterrupt(db: DatabaseSync, deps: ProjectCloseDeps, interrupt: () => Promise<unknown>) {
  const current = currentProjectClose(db,deps.groupId);
  if (current && current.step < 3) return {summaryRequestId:current.summaryRequestId};
  db.exec('SAVEPOINT close_preflight');
  try { startProjectClose(db,{...deps,completionHooks:undefined}); }
  finally { db.exec('ROLLBACK TO close_preflight; RELEASE close_preflight'); }
  await interrupt();
  try { return startProjectClose(db,deps); }
  catch (error) {
    // The interrupt already paused the project as a Stop: say why it stays paused.
    // Not when another Close got there first: that project is closed or closing, not stuck.
    const settings = projectSettingsFor(db,deps.groupId);
    if (error instanceof ProjectLifecycleError && settings?.runState === 'paused' && settings.closedAt === null && !currentProjectClose(db,deps.groupId))
      setProjectRunState(db,{groupId:deps.groupId,runState:'paused',reason:`Close could not finish: ${error.message}`.slice(0,200),actor:'owner',now:deps.now});
    throw error;
  }
}

/** Only persisted server-issued close requests get the paused-project exception. */
export function isProjectCloseRequest(db: DatabaseSync, request: RoomRequest): boolean {
  if (request.verb !== 'wake' || request.fromKind !== 'murage' || request.notOwnerAudience) return false;
  const settings = projectSettingsFor(db,request.groupId);
  if (!settings || settings.endedAt !== null) return false;
  const step = currentProjectClose(db,request.groupId);
  if (!step || (step.step === 3 && settings.closedAt === null)) return false;
  const persisted = roomRequest(db, request.id);
  if (!persisted || persisted.admissionKey !== request.admissionKey || persisted.toBotId !== request.toBotId || persisted.parentId !== request.parentId) return false;
  if (request.admissionKey === `close:${request.groupId}:${step.closeSeq}`) return step.step < 3 && request.id === step.summaryRequestId;
  return step.step >= 2 && request.admissionKey === `close-lesson:${request.groupId}:${step.closeSeq}:${request.toBotId}` && request.parentId === step.summaryRequestId;
}
export function resumeProjectCloses(db: DatabaseSync, deps: ProjectCloseDeps): void {
  let step = currentProjectClose(db,deps.groupId);
  if (!step || projectSettingsFor(db,deps.groupId)?.endedAt !== null) return;
  if (step.step === 1) {
    let request = step.summaryRequestId ? roomRequest(db,step.summaryRequestId) : null;
    if (request?.state === 'queued' && (request.refusal === 'budget_reached' || deps.now-request.createdAt >= 60_000)) {
      completeRequest(db,request.id,{state:'cancelled',now:deps.now,outcomeNote:'Close summary could not start.'},deps.completionHooks,{continuation:false});
      request = roomRequest(db,request.id);
    }
    if (request && !isTerminalRoomRequestState(request.state)) return;
    tx(db,() => {
      for (const botId of deps.memberIds) insertRoomRequest(db,{groupId:deps.groupId,verb:'wake',fromKind:'murage',toBotId:botId,targetThreadId:deps.threadId,
        ...(step!.summaryRequestId ? {parentId:step!.summaryRequestId} : {lineage:deps.lineage,projectGoalId:step!.goalId}),
        admissionKey:`close-lesson:${deps.groupId}:${step!.closeSeq}:${botId}`,priority:'coordinator',now:deps.now,
        payloadText:`Use memory_save to save "Project closed: what I learned" as a candidate in your own bot:${botId} scope. Cite evidence from project ${deps.groupId}. Do not start other work.`});
      record(db,deps,{...step!,step:2});
    });
    step = {...step,step:2};
  }
  if (step.step === 2) {
    const request = step.summaryRequestId ? roomRequest(db,step.summaryRequestId) : null;
    const cards = projectCardsForGroup(db,deps.groupId,true);
    const fallback = `Project closed. ${cards.filter(c=>c.state==='done').length} cards done. ${cards.filter(c=>c.state==='cancelled').length} cards cancelled.`;
    const summary = request?.state === 'done' ? deps.summary(request)?.slice(0,6000) || fallback : fallback;
    const routines = deps.routineNames();
    deps.post(`close:${deps.groupId}:${step.closeSeq}`, [summary, 'Deliverables:', ...deps.deliverables(), ...(routines.length ? ['Paused routines:', ...routines, 'Resume each routine when you want it to run again.'] : [])].join('\n'));
    // Rows precede the idempotent routine JSON write. A crash repeats the
    // pause before committing step 3, never loses the summary or lessons.
    deps.pauseRoutines();
    finishProjectClose(db,deps);
  }
  else if (step.step === 3 && projectSettingsFor(db,deps.groupId)?.closedAt !== null) deps.sync();
}
export function finishProjectClose(db: DatabaseSync, deps: ProjectCloseDeps): void {
  tx(db,() => {
    const step = currentProjectClose(db,deps.groupId);
    if (!step || step.step !== 2) return;
    setProjectClosed(db,{groupId:deps.groupId,at:deps.now});
    record(db,deps,{...step,step:3});
  });
  deps.sync();
}
export function reopenProject(db: DatabaseSync, deps: Pick<ProjectCloseDeps,'groupId'|'now'|'sync'> & Partial<Pick<ProjectCloseDeps,'routineNames'|'pausedRoutineNames'|'post'>>) {
  const settings = projectSettingsFor(db,deps.groupId);
  if (!settings || settings.endedAt !== null) throw new ProjectLifecycleError('not_allowed','This is a channel now.');
  if (settings.closedAt === null) throw new ProjectLifecycleError('not_allowed','This project is not closed.');
  tx(db,() => setProjectReopened(db,{groupId:deps.groupId,at:deps.now}));
  deps.sync();
  const pausedRoutines = deps.pausedRoutineNames?.() ?? deps.routineNames?.() ?? [];
  const resumeHint = 'Resume each routine when you want it to run again.';
  deps.post?.(`reopen:${deps.groupId}:${deps.now}`,['Project reopened.',...(pausedRoutines.length ? ['Paused routines:',...pausedRoutines,resumeHint] : [])].join('\n'));
  return {settings:projectSettingsFor(db,deps.groupId)!,pausedRoutines,resumeHint};
}

/** Goal sign-off shares the summary and lessons, but keeps the project open
 * for its next goal. It grants no paused-project admission exception. */
interface GoalCloseStep { goalSummary: string; step: number; summaryRequestId: string | null }
function goalCloseSteps(db: DatabaseSync, groupId: string): GoalCloseStep[] {
  const latest = new Map<string,GoalCloseStep>();
  for (const row of db.prepare("SELECT detail FROM project_activity WHERE group_id=? AND kind='close' ORDER BY rowid").all(groupId)) {
    const detail = JSON.parse(String(row.detail)) as GoalCloseStep;
    if (typeof detail.goalSummary === 'string') latest.set(detail.goalSummary,detail);
  }
  return [...latest.values()];
}
export function startGoalCloseSummary(db:DatabaseSync,deps:ProjectCloseDeps,goalId:string):string|null {
  return tx(db,()=>{
    const prior=goalCloseSteps(db,deps.groupId).find(step=>step.goalSummary===goalId);
    if(prior)return prior.summaryRequestId;
    if(!db.prepare("SELECT id FROM project_goals WHERE id=? AND group_id=? AND state='done'").get(goalId,deps.groupId))throw new ProjectLifecycleError('not_allowed','Sign off the goal first.');
    // Without an owner conversation there is no lead summary: the fallback line still posts.
    const lead=deps.lineage.notOwnerAudience?null:projectSettingsFor(db,deps.groupId)?.leadBotId;
    const request=lead?insertRoomRequest(db,{groupId:deps.groupId,verb:'wake',fromKind:'murage',toBotId:lead,targetThreadId:deps.threadId,projectGoalId:goalId,lineage:deps.lineage,admissionKey:`goal-close:${deps.groupId}:${goalId}`,priority:'coordinator',now:deps.now,payloadText:'The owner signed off this goal. Summarise what was done, what is open, and the deliverables. Do not start new work.'}).request:null;
    insertProjectActivity(db,{groupId:deps.groupId,kind:'close',actor:'owner',at:deps.now,goalId,requestId:request?.id,detail:{goalSummary:goalId,step:1,summaryRequestId:request?.id??null}});
    return request?.id??null;
  });
}
export function isGoalCloseRequest(db:DatabaseSync,request:RoomRequest):boolean {
  if(request.verb!=='wake'||request.fromKind!=='murage'||request.notOwnerAudience)return false;
  return goalCloseSteps(db,request.groupId).some(step=>request.id===step.summaryRequestId || (request.parentId===step.summaryRequestId && request.admissionKey===`goal-close-lesson:${request.groupId}:${step.goalSummary}:${request.toBotId}`));
}
export function resumeGoalCloseSummaries(db:DatabaseSync,deps:ProjectCloseDeps):void {
  for(const step of goalCloseSteps(db,deps.groupId)){
    if(step.step===1){
      let request=step.summaryRequestId?roomRequest(db,step.summaryRequestId):null;
      // Same bound as Close: a summary the budget refuses, or that is not admitted in a minute, falls back.
      if(request?.state==='queued'&&(request.refusal==='budget_reached'||deps.now-request.createdAt>=60_000)){
        completeRequest(db,request.id,{state:'cancelled',now:deps.now,outcomeNote:'Goal summary could not start.'},deps.completionHooks,{continuation:false});
        request=roomRequest(db,request.id);
      }
      if(request&&!isTerminalRoomRequestState(request.state))continue;
      tx(db,()=>{
        // Lessons ride an owner conversation: the summary's own, or this pass's.
        if(request||!deps.lineage.notOwnerAudience)for(const botId of deps.memberIds)insertRoomRequest(db,{groupId:deps.groupId,verb:'wake',fromKind:'murage',toBotId:botId,targetThreadId:deps.threadId,projectGoalId:step.goalSummary,...(request?{parentId:request.id}:{lineage:deps.lineage}),admissionKey:`goal-close-lesson:${deps.groupId}:${step.goalSummary}:${botId}`,priority:'coordinator',now:deps.now,payloadText:`Use memory_save to save what you learned from the signed-off goal ${step.goalSummary} as a candidate in your own bot:${botId} scope. Cite project ${deps.groupId}. Do not start other work.`});
        insertProjectActivity(db,{groupId:deps.groupId,kind:'close',actor:'server',goalId:step.goalSummary,at:deps.now,detail:{...step,step:2}});
      });
    }
    else if(step.step!==2)continue;
    // Step 2 is committed before anything is shown; the durable writer dedupes a repeat after a crash.
    const request=step.summaryRequestId?roomRequest(db,step.summaryRequestId):null;
    const cards=projectCardsForGroup(db,deps.groupId,true).filter(card=>card.goalId===step.goalSummary);
    const fallback=`Goal signed off. ${cards.filter(card=>card.state==='done').length} cards done. ${cards.filter(card=>card.state==='cancelled').length} cards cancelled.`;
    deps.post(`goal-close:${deps.groupId}:${step.goalSummary}`,[request?.state==='done'?deps.summary(request)?.slice(0,6000)||fallback:fallback,'Deliverables:',...deps.deliverables()].join('\n'));
    tx(db,()=>insertProjectActivity(db,{groupId:deps.groupId,kind:'close',actor:'server',goalId:step.goalSummary,at:deps.now,detail:{...step,step:3}}));
  }
}

export function projectCloseDeliverables(files: ReadonlyArray<{relative_path:string}>): string[] {
  const paths = [...new Set(files.map(file=>file.relative_path))];
  return [...paths.slice(0,50),...(paths.length>50 ? [`and ${paths.length-50} more`] : [])];
}

export function isProjectCloseLesson(db: DatabaseSync, request: RoomRequest): boolean {
  return (isProjectCloseRequest(db,request) && request.admissionKey.startsWith('close-lesson:'))
    || (isGoalCloseRequest(db,request) && request.admissionKey.startsWith('goal-close-lesson:'));
}
/** Bound from the executing generation, never from model-supplied request ids. */
export function projectCloseToolRefusal(db: DatabaseSync, requestId: string | undefined, method: string, path: string) {
  const request = requestId ? roomRequest(db,requestId) : null;
  if (!request || request.verb !== 'wake' || request.fromKind !== 'murage' || request.notOwnerAudience) return null;
  if (!isCloseTurnRequest(db,request)) return null;
  const reads = ['/api/internal/memory/search','/api/internal/memory/get','/api/internal/project/peek','/api/internal/project/roster','/api/internal/project/read-messages'];
  const allowed = request.state === 'running' && (method === 'GET' || reads.includes(path) || (path === '/api/internal/memory/save' && isProjectCloseLesson(db,request)));
  return allowed ? null : {error:'not_allowed',reason:'This turn can only summarise the project or save its lesson.'};
}

/** A close summary or lesson turn, of a project close or a goal sign-off, by
 * its recorded receipt. Unlike admission this ignores later lifecycle markers:
 * such a turn stays restricted after a Reopen, and never plans work. */
export function isCloseTurnRequest(db: DatabaseSync, request: RoomRequest): boolean {
  if (request.verb !== 'wake' || request.fromKind !== 'murage') return false;
  if (steps(db,request.groupId).some(step => request.id === step.summaryRequestId ||
    (request.parentId === step.summaryRequestId && request.admissionKey === `close-lesson:${request.groupId}:${step.closeSeq}:${request.toBotId}`))) return true;
  return goalCloseSteps(db,request.groupId).some(step => request.id === step.summaryRequestId ||
    request.admissionKey === `goal-close-lesson:${request.groupId}:${step.goalSummary}:${request.toBotId}`);
}
