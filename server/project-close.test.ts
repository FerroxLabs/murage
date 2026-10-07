// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { initializeProjectTables, pruneProjectRows } from './project-tables.ts';
import { channelToProjectRows, endProjectRows, setProjectRunState, setProjectReopened } from './project-settings.ts';
import { createProjectGoal, startProjectGoal } from './project-goals.ts';
import { projectSettingsFor, projectCardById } from './project-records.ts';
import { completeRequest, roomRequest, insertRoomRequest, pruneTerminalRoomRequests } from './room-requests.ts';
import { startProjectClose, resumeProjectCloses, reopenProject, isProjectCloseRequest, startGoalCloseSummary, resumeGoalCloseSummaries, isCloseTurnRequest, startProjectCloseWithInterrupt } from './project-close.ts';
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
function fixture(lead: string | null = 'lead') {
  const db = new DatabaseSync(':memory:'); dbs.push(db); initializeProjectTables(db);
  channelToProjectRows(db, { groupId: 'g', bulletin: '', leadBotId: lead, now: 1 });
  const lines = new Map<string,string>();
  const deps = { groupId: 'g', threadId: 'room', memberIds: ['lead','worker'], now: 10,
    lineage: { rootThreadId: 'room', origin: 'server' as const, audienceFingerprint: 'owner', notOwnerAudience: false, unattended: false },
    deliverables: () => ['Report: output/report.md'], routineNames: () => ['Daily report'], pauseRoutines: vi.fn(() => {}),
    post: (key: string, text: string) => { lines.set(key,text); }, summary: () => 'Delivered the report.', sync: vi.fn() };
  return { db, deps, lines };
}
it('closes once, requests lessons, pauses routines, and reconciles the JSON after step 2', () => {
  const {db,deps,lines} = fixture();
  const first = startProjectClose(db,deps);
  expect(startProjectClose(db,deps)).toEqual(first);
  expect(projectSettingsFor(db,'g')?.runState).toBe('paused');
  expect(isProjectCloseRequest(db,roomRequest(db,first.summaryRequestId!)!)).toBe(true);
  completeRequest(db,first.summaryRequestId!,{state:'done',now:11});
  deps.sync.mockImplementationOnce(() => { throw new Error('crash after rows'); });
  expect(() => resumeProjectCloses(db,deps)).toThrow('crash after rows');
  resumeProjectCloses(db,deps);
  expect(lines.size).toBe(1);
  expect([...lines.values()][0]).toContain('Delivered the report.');
  expect([...lines.values()][0]).toContain('Daily report');
  expect(projectSettingsFor(db,'g')?.closedAt).not.toBeNull();
  expect(db.prepare("SELECT * FROM room_requests WHERE admission_key LIKE 'close-lesson:%'").all()).toHaveLength(2);
});
it.each(['failed','cancelled','expired','unknown'] as const)('resumes after step 1 and falls back for %s', state => {
  const {db,deps,lines} = fixture(); const result = startProjectClose(db,deps);
  completeRequest(db,result.summaryRequestId!,{state,now:11});
  resumeProjectCloses(db,deps); resumeProjectCloses(db,deps);
  expect([...lines.values()][0]).toContain('Project closed.');
  expect([...lines.values()][0]).toContain('output/report.md');
  expect(lines.size).toBe(1);
});
it('closes with no lead and reopens paused, leaving routines paused', () => {
  const {db,deps} = fixture(null); startProjectClose(db,deps); resumeProjectCloses(db,deps);
  const calls = deps.pauseRoutines.mock.calls.length;
  reopenProject(db,deps);
  expect(projectSettingsFor(db,'g')).toMatchObject({closedAt:null,runState:'paused'});
  expect(deps.pauseRoutines).toHaveBeenCalledTimes(calls);
  expect(() => reopenProject(db,deps)).toThrow('not closed');
});
it.each(['awaiting_signoff','paused','working','planning','awaiting_plan_ok'])('checks the %s goal before changing rows', state => {
  const {db,deps} = fixture(); const made = createProjectGoal(db,{groupId:'g',title:'Goal',now:2});
  if (!made.ok) throw new Error(made.reason);
  db.prepare('UPDATE project_goals SET state=? WHERE id=?').run(state,made.goal.id);
  expect(() => startProjectClose(db,deps)).toThrow();
  expect(db.prepare('SELECT * FROM room_requests').all()).toHaveLength(0);
  if (state === 'paused' || state === 'awaiting_signoff') {
    startProjectClose(db,{...deps,stopGoal:true});
    expect(db.prepare('SELECT state FROM project_goals').get()?.state).toBe('stopped');
  } else expect(() => startProjectClose(db,{...deps,stopGoal:true})).toThrow();
});
it('rejects a forged close key without a sequence activity record', () => {
  const {db} = fixture();
  expect(isProjectCloseRequest(db,{id:'forged',groupId:'g',admissionKey:'close:g:1',verb:'wake',fromKind:'murage',notOwnerAudience:false,toBotId:'lead'} as never)).toBe(false);
});

it('does not authorize a fabricated lesson, and retires lessons after reopen', () => {
  const {db,deps} = fixture(null); startProjectClose(db,deps); resumeProjectCloses(db,deps);
  const row = db.prepare("SELECT id FROM room_requests WHERE admission_key LIKE 'close-lesson:%' LIMIT 1").get()!;
  const lesson = roomRequest(db,String(row.id))!;
  expect(isProjectCloseRequest(db,lesson)).toBe(true);
  expect(isProjectCloseRequest(db,{...lesson,id:'forged'})).toBe(false);
  reopenProject(db,deps);
  expect(isProjectCloseRequest(db,lesson)).toBe(false);
});
it('records the owner stop confirmation without model text', () => {
  const {db,deps} = fixture(); const goal = createProjectGoal(db,{groupId:'g',title:'Goal',now:2});
  if (!goal.ok) throw new Error(goal.reason);
  db.prepare("UPDATE project_goals SET state='paused'").run();
  startProjectClose(db,{...deps,stopGoal:true});
  const detail = JSON.parse(String(db.prepare("SELECT detail FROM project_activity WHERE kind='close'").get()!.detail));
  expect(detail.stopGoal).toBe(true);
  expect(detail).not.toHaveProperty('summary');
});

it('commits step 2 before final close and resumes without duplicate lessons or lines', () => {
  const {db,deps,lines}=fixture(null);startProjectClose(db,deps);
  db.exec("CREATE TRIGGER stop_finish BEFORE UPDATE OF closed_at ON project_settings WHEN NEW.closed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'crash after step 2'); END");
  expect(()=>resumeProjectCloses(db,deps)).toThrow('crash after step 2');
  expect(JSON.parse(String(db.prepare("SELECT detail FROM project_activity WHERE kind='close' ORDER BY rowid DESC LIMIT 1").get()!.detail)).step).toBe(2);
  db.exec('DROP TRIGGER stop_finish');resumeProjectCloses(db,deps);
  expect(lines.size).toBe(1);expect(deps.pauseRoutines).toHaveBeenCalledTimes(2);
  expect(projectSettingsFor(db,'g')?.closedAt).not.toBeNull();
  expect(db.prepare("SELECT id FROM room_requests WHERE admission_key LIKE 'close-lesson:%'").all()).toHaveLength(2);
});
it('keeps the closing goal budget attached to the summary and lessons', () => {
  const {db,deps}=fixture();const made=createProjectGoal(db,{groupId:'g',title:'Goal',now:2});if(!made.ok)throw new Error(made.reason);
  db.prepare("UPDATE project_goals SET state='paused'").run();
  const result=startProjectClose(db,{...deps,stopGoal:true});
  expect(roomRequest(db,result.summaryRequestId!)?.projectGoalId).toBe(made.goal.id);
  completeRequest(db,result.summaryRequestId!,{state:'done',now:11});resumeProjectCloses(db,deps);
  expect(db.prepare("SELECT project_goal_id FROM room_requests WHERE admission_key LIKE 'close-lesson:%'").all().every(row=>row.project_goal_id===made.goal.id)).toBe(true);
});

it('sign-off summarises and requests lessons without ending an ongoing project', () => {
  const {db,deps,lines}=fixture();const made=createProjectGoal(db,{groupId:'g',title:'Goal',now:2});if(!made.ok)throw new Error(made.reason);
  db.prepare("UPDATE project_goals SET state='done'").run();
  const first=startGoalCloseSummary(db,deps,made.goal.id);
  expect(startGoalCloseSummary(db,deps,made.goal.id)).toBe(first);
  completeRequest(db,first!,{state:'done',now:11});resumeGoalCloseSummaries(db,deps);resumeGoalCloseSummaries(db,deps);
  expect(lines.size).toBe(1);expect(projectSettingsFor(db,'g')).toMatchObject({closedAt:null,runState:'running'});
  expect(deps.pauseRoutines).not.toHaveBeenCalled();
  expect(db.prepare("SELECT id FROM room_requests WHERE admission_key LIKE 'goal-close-lesson:%'").all()).toHaveLength(2);
});

it('C3 refuses Resume, End and goal Start during an unfinished close', () => {
  const {db,deps}=fixture();
  const goal=createProjectGoal(db,{groupId:'g',title:'Next',now:2}); if(!goal.ok)throw new Error(goal.reason);
  startProjectClose(db,deps);
  const refusal={ok:false,error:'not_allowed',reason:'This project is closing.'};
  expect(setProjectRunState(db,{groupId:'g',runState:'running',actor:'owner',now:11})).toEqual(refusal);
  expect(endProjectRows(db,{groupId:'g',now:11})).toEqual(refusal);
  expect(startProjectGoal(db,{goalId:goal.goal.id,now:11,tz:'UTC'})).toEqual(refusal);
});
it('C3 never resumes a close older than Reopen and End after re-making the project', () => {
  const {db,deps}=fixture(); const {summaryRequestId}=startProjectClose(db,deps);
  completeRequest(db,summaryRequestId!,{state:'failed',now:11});
  // Defence in depth for an older release which permitted these transitions.
  setProjectReopened(db,{groupId:'g',at:12});
  expect(endProjectRows(db,{groupId:'g',now:13}).ok).toBe(true);
  channelToProjectRows(db,{groupId:'g',bulletin:'New',leadBotId:'lead',now:14});
  pruneProjectRows(db,100*86400000);
  resumeProjectCloses(db,{...deps,now:100*86400000});
  expect(projectSettingsFor(db,'g')).toMatchObject({closedAt:null,runState:'running'});
});
it.each(['budget_reached','timeout'])('C4 falls back when close admission is blocked by %s', reason => {
  const {db,deps,lines}=fixture(); const {summaryRequestId}=startProjectClose(db,deps);
  if(reason==='budget_reached')db.prepare("UPDATE room_requests SET refusal='budget_reached' WHERE id=?").run(summaryRequestId);
  resumeProjectCloses(db,{...deps,now:reason==='timeout'?deps.now+60001:deps.now+1});
  expect(roomRequest(db,summaryRequestId!)?.state).toBe('cancelled');
  expect(projectSettingsFor(db,'g')?.closedAt).not.toBeNull();
  expect([...lines.values()][0]).toContain('Project closed.');
});
it('C5 cancels restart-wait cards with owner authority', async () => {
  const {db,deps}=fixture(null); const {createProjectCard}=await import('./project-cards.ts');
  const card=createProjectCard(db,{groupId:'g',title:'Restarted',actor:{kind:'owner'},memberIds:['lead'],now:2});if(!card.ok)throw new Error(card.reason);
  db.prepare("UPDATE project_work_items SET state='waiting',waiting_on=? WHERE id=?").run(JSON.stringify({kind:'restart'}),card.card.id);
  startProjectClose(db,deps);resumeProjectCloses(db,deps);
  expect(projectCardById(db,card.card.id)).toMatchObject({state:'cancelled',archivedAt:10});
});
it('C8 does not publish a summary from a rolled back step 2', () => {
  const {db,deps,lines}=fixture(null); startProjectClose(db,deps);
  db.exec("CREATE TRIGGER fail_step2 BEFORE INSERT ON project_activity WHEN json_extract(NEW.detail,'$.step')=2 BEGIN SELECT RAISE(ABORT,'step 2 failed'); END");
  expect(()=>resumeProjectCloses(db,deps)).toThrow('step 2 failed');
  expect(lines.size).toBe(0);
  db.exec('DROP TRIGGER fail_step2');resumeProjectCloses(db,deps);expect(lines.size).toBe(1);
});
it('C9 boot pruning past retention preserves an unfinished close', async () => {
  const {db,deps,lines}=fixture(null);startProjectClose(db,deps);
  const {pruneProjectRows}=await import('./project-tables.ts');
  const now=100*86400000;pruneProjectRows(db,now);resumeProjectCloses(db,{...deps,now});
  expect(projectSettingsFor(db,'g')?.closedAt).toBe(now);expect(lines.size).toBe(1);
});
it('C10 lists distinct relative deliverable paths, at most 50 plus a count', async () => {
  const close=await import('./project-close.ts');
  const files=Array.from({length:53},(_,i)=>({name:`File ${i}`,relative_path:`output/${i}.md`}));
  const list=close.projectCloseDeliverables([...files,files[0]!]);
  expect(list).toHaveLength(51);expect(list[0]).toBe('output/0.md');expect(list[50]).toBe('and 3 more');
});
it('C11 GET project exposes the durable closing step', async () => {
  const {db,deps}=fixture();startProjectClose(db,deps);
  const {handleProjectRoute}=await import('./project-routes.ts');
  expect(handleProjectRoute(db,{method:'GET',path:'/api/groups/g/project',query:new URLSearchParams(),body:{},group:{id:'g',threadId:'room',memberIds:['lead']},now:11})).toMatchObject({status:200,body:{closing:true,closeStep:1}});
});

it('C2 interrupts the producing turn before cancelling and settles its ledger row', async () => {
  const {db,deps}=fixture(); const close=await import('./project-close.ts'); const {settleProjectUsage}=await import('./usage-ledger.ts');
  const live=insertRoomRequest(db,{groupId:'g',verb:'room_turn',fromKind:'owner',toBotId:'worker',targetThreadId:'room',lineage:deps.lineage,admissionKey:'live',state:'running',now:2}).request;
  let producing=true,effects=0;const tick=()=>{if(producing)effects++;};tick();
  const completionHooks={settleUsage:(database:DatabaseSync,request:import('./room-requests.ts').RoomRequest)=>{settleProjectUsage(database,request,{threadId:'room',botId:'worker',engine:'fixture',turnGeneration:'run',at:10,ok:false,usage:{input:3,output:effects}});}};
  await close.startProjectCloseWithInterrupt(db,{...deps,completionHooks},async()=>{tick();producing=false;});
  const before=effects;tick();expect(effects).toBe(before);expect(producing).toBe(false);
  expect(roomRequest(db,live.id)?.state).toBe('cancelled');
  expect(db.prepare('SELECT input,output,ok FROM usage_ledger WHERE request_id=?').all(live.id)).toEqual([{input:3,output:2,ok:0}]);
});
it('C1 route sign-off commits its summary request and receipt with the goal', async () => {
  const {db,deps}=fixture();const routes=await import('./project-routes.ts');
  const goal=createProjectGoal(db,{groupId:'g',title:'Complete',now:2});if(!goal.ok)throw new Error(goal.reason);
  db.prepare("UPDATE project_goals SET state='awaiting_signoff' WHERE id=?").run(goal.goal.id);
  const input={method:'PATCH',path:`/api/groups/g/project/goals/${goal.goal.id}`,query:new URLSearchParams(),body:{action:'sign_off',expectedRevision:0},group:{id:'g',threadId:'room',memberIds:['lead']},now:10,origin:'unproven' as const};
  const apply=()=>routes.handleProjectGoalRouteWithWake(db,input,()=>startGoalCloseSummary(db,deps,goal.goal.id));
  db.exec("CREATE TRIGGER fail_summary BEFORE INSERT ON room_requests BEGIN SELECT RAISE(ABORT,'summary failed'); END");
  expect(apply).toThrow('summary failed');expect(db.prepare('SELECT state FROM project_goals').get()?.state).toBe('awaiting_signoff');
  db.exec('DROP TRIGGER fail_summary');expect(apply()).toMatchObject({status:200,body:{goal:{state:'done'}}});
  expect(db.prepare("SELECT id FROM room_requests WHERE admission_key LIKE 'goal-close:%'").all()).toHaveLength(1);
  expect(db.prepare("SELECT id FROM project_activity WHERE json_extract(detail,'$.goalSummary')=?").all(goal.goal.id)).toHaveLength(1);
});
it('R1 lifecycle errors distinguish typed refusals, input and unexpected failures', async () => {
  const close=await import('./project-close.ts');
  expect(close.projectLifecycleFailure(new Error('internal database path'))).toEqual({status:500,body:{error:'The project action could not finish.'}});
  expect(close.projectLifecycleFailure(new close.ProjectLifecycleError('invalid','Choose a project work folder.'))).toEqual({status:400,body:{error:'Choose a project work folder.'}});
  expect(close.projectLifecycleFailure(new close.ProjectLifecycleError('not_allowed','This project is closing.'))).toEqual({status:409,body:{error:'not_allowed',reason:'This project is closing.'}});
});
it('R3 Reopen lists paused routines and a Resume hint', () => {
  const {db,deps,lines}=fixture(null);startProjectClose(db,deps);resumeProjectCloses(db,deps);
  const result=reopenProject(db,deps);
  expect(result).toMatchObject({settings:{closedAt:null,runState:'paused'},pausedRoutines:['Daily report'],resumeHint:'Resume each routine when you want it to run again.'});
  expect([...lines.values()].at(-1)).toBe('Project reopened.\nPaused routines:\nDaily report\nResume each routine when you want it to run again.');
});

it('C9 retention keeps a terminal summary needed to resume an unfinished close', () => {
  const {db,deps}=fixture();const {summaryRequestId}=startProjectClose(db,deps);
  completeRequest(db,summaryRequestId!,{state:'failed',now:11});
  const now=100*86400000;pruneProjectRows(db,now);pruneTerminalRoomRequests(db,now);
  expect(roomRequest(db,summaryRequestId!)).not.toBeNull();
  resumeProjectCloses(db,{...deps,now});expect(projectSettingsFor(db,'g')?.closedAt).toBe(now);
});

it('C9 a no-lead close does not retain unrelated terminal requests', () => {
  const {db,deps}=fixture(null);
  const other=insertRoomRequest(db,{groupId:'other',verb:'room_turn',fromKind:'owner',toBotId:'worker',lineage:deps.lineage,admissionKey:'other',now:1}).request;
  completeRequest(db,other.id,{state:'done',now:2});startProjectClose(db,deps);
  expect(pruneTerminalRoomRequests(db,100*86400000)).toBe(1);
  expect(roomRequest(db,other.id)).toBeNull();
});

it('lane N server files load under the strip-only TypeScript the dev server runs', async () => {
  const { stripTypeScriptTypes } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  for (const file of ['project-close.ts', 'project-new.ts', 'project-export.ts', 'project-migration.ts', 'memory/authority.ts'])
    expect(() => stripTypeScriptTypes(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')), file).not.toThrow();
});

const DAY = 86400000;
it('R5 a close after retention pruned an earlier one gets its own summary request and message', () => {
  const {db,deps,lines}=fixture();
  const first=startProjectClose(db,deps);completeRequest(db,first.summaryRequestId!,{state:'failed',now:11});
  resumeProjectCloses(db,deps);reopenProject(db,{...deps,now:12,post:undefined});
  const later=200*DAY;pruneProjectRows(db,later);pruneTerminalRoomRequests(db,later);
  const second=startProjectClose(db,{...deps,now:later});
  expect(second.summaryRequestId).not.toBe(first.summaryRequestId);
  expect(roomRequest(db,second.summaryRequestId!)?.state).toBe('queued');
  completeRequest(db,second.summaryRequestId!,{state:'failed',now:later+1});resumeProjectCloses(db,{...deps,now:later+1});
  expect(lines.size).toBe(2);
});
it('R5 pruning keeps only the live close: a close superseded by Reopen, later markers and plain settings rows age out', () => {
  const {db,deps}=fixture();
  const stale=startProjectClose(db,deps);
  setProjectReopened(db,{groupId:'g',at:12});
  db.prepare("INSERT INTO project_activity (id,group_id,at,kind,actor,detail) VALUES ('plain','g',13,'settings','owner','{}')").run();
  completeRequest(db,stale.summaryRequestId!,{state:'failed',now:14});
  const now=200*DAY;pruneProjectRows(db,now);pruneTerminalRoomRequests(db,now);
  expect(db.prepare("SELECT COUNT(*) AS n FROM project_activity WHERE group_id='g'").get()?.n).toBe(0);
  expect(roomRequest(db,stale.summaryRequestId!)).toBeNull();
});
it('R5 goal sign-off shows its summary only after its rows commit, and once', () => {
  const {db,deps,lines}=fixture();const made=createProjectGoal(db,{groupId:'g',title:'Goal',now:2});if(!made.ok)throw new Error(made.reason);
  db.prepare("UPDATE project_goals SET state='done'").run();
  const id=startGoalCloseSummary(db,deps,made.goal.id);completeRequest(db,id!,{state:'done',now:11});
  db.exec("CREATE TRIGGER fail_goal_lessons BEFORE INSERT ON room_requests WHEN NEW.admission_key LIKE 'goal-close-lesson:%' BEGIN SELECT RAISE(ABORT,'lessons failed'); END");
  expect(()=>resumeGoalCloseSummaries(db,deps)).toThrow('lessons failed');
  expect(lines.size).toBe(0);
  db.exec('DROP TRIGGER fail_goal_lessons');
  const post=vi.fn(deps.post);resumeGoalCloseSummaries(db,{...deps,post});resumeGoalCloseSummaries(db,{...deps,post});
  expect(post).toHaveBeenCalledTimes(1);expect(lines.size).toBe(1);
});
it.each(['budget_reached','timeout'])('R5 a goal summary blocked by %s falls back instead of waiting forever', reason => {
  const {db,deps,lines}=fixture();const made=createProjectGoal(db,{groupId:'g',title:'Goal',now:2});if(!made.ok)throw new Error(made.reason);
  db.prepare("UPDATE project_goals SET state='done'").run();
  const id=startGoalCloseSummary(db,deps,made.goal.id)!;
  if(reason==='budget_reached')db.prepare("UPDATE room_requests SET refusal='budget_reached' WHERE id=?").run(id);
  resumeGoalCloseSummaries(db,{...deps,now:reason==='timeout'?deps.now+60001:deps.now+1});
  expect(roomRequest(db,id)?.state).toBe('cancelled');
  expect([...lines.values()][0]).toContain('Goal signed off.');
});
it('R5 sign-off in a conversation that is not the owner\'s still records its summary, as the fallback', () => {
  const {db,deps,lines}=fixture();const made=createProjectGoal(db,{groupId:'g',title:'Goal',now:2});if(!made.ok)throw new Error(made.reason);
  db.prepare("UPDATE project_goals SET state='done'").run();
  const notOwner={...deps,lineage:{...deps.lineage,notOwnerAudience:true}};
  expect(startGoalCloseSummary(db,notOwner,made.goal.id)).toBeNull();
  resumeGoalCloseSummaries(db,notOwner);
  expect([...lines.values()][0]).toContain('Goal signed off.');
  expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests").get()?.n).toBe(0);
});
it('R5 a close summary or lesson stays a close turn after Reopen, so it can never plan work', () => {
  const {db,deps}=fixture();const {summaryRequestId}=startProjectClose(db,deps);
  completeRequest(db,summaryRequestId!,{state:'done',now:11});resumeProjectCloses(db,deps);
  const lesson=roomRequest(db,String(db.prepare("SELECT id FROM room_requests WHERE admission_key LIKE 'close-lesson:%' LIMIT 1").get()!.id))!;
  reopenProject(db,{...deps,now:12,post:undefined});
  expect(isCloseTurnRequest(db,roomRequest(db,summaryRequestId!)!)).toBe(true);
  expect(isCloseTurnRequest(db,lesson)).toBe(true);
  const ordinary=insertRoomRequest(db,{groupId:'g',verb:'wake',fromKind:'murage',toBotId:'lead',targetThreadId:'room',lineage:deps.lineage,admissionKey:'wake:other',now:13}).request;
  expect(isCloseTurnRequest(db,ordinary)).toBe(false);
});
it('R5 a Close that fails after the interrupt says why the project stays paused', async () => {
  const {db,deps}=fixture();
  const goal=createProjectGoal(db,{groupId:'g',title:'Late goal',now:2});if(!goal.ok)throw new Error(goal.reason);
  await expect(startProjectCloseWithInterrupt(db,deps,async()=>{
    setProjectRunState(db,{groupId:'g',runState:'paused',reason:'Stopped by you',actor:'owner',now:10});
    db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.goal.id);
  })).rejects.toThrow('Stop the active goal before closing this project.');
  expect(projectSettingsFor(db,'g')).toMatchObject({runState:'paused',runStateReason:'Close could not finish: Stop the active goal before closing this project.'});
});
it('R5 a second Close that loses the race to a first one does not relabel the closed project', async () => {
  const {db,deps}=fixture(null);
  await expect(startProjectCloseWithInterrupt(db,deps,async()=>{
    // The first Close (no lead) commits all three steps while this one waits on its interrupt.
    startProjectClose(db,deps);resumeProjectCloses(db,deps);
  })).rejects.toThrow('This project is closed.');
  expect(projectSettingsFor(db,'g')?.runStateReason).not.toMatch(/^Close could not finish/);
});
