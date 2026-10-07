// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import { createDefaultPeriodBudget, createDefaultGoalBudget, projectBudgetsForGroup } from "./project-defaults.ts";
import { resumeProjectGoal } from "./project-goals.ts";
import { stopRunsOverBudget, type ProjectUsageRun } from "./project-usage-dispatch.ts";
import { insertRoomRequest } from "./room-requests.ts";
import { settleProjectUsage, projectUsage } from "./usage-ledger.ts";
import { budgetPeriodStart, createProjectBudgetGate, patchProjectBudget } from "./project-budgets.ts";
let db: DatabaseSync;
const now = Date.parse("2026-03-10T12:00:00Z");
beforeEach(() => { db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  db.prepare(`INSERT INTO project_settings (group_id,mode,parts,work_roots,work_profile,run_state,updated_at) VALUES ('g','ongoing','{}','[]','ask','running',?)`).run(now);
});
afterEach(() => db.close());
it("finds local day, Monday and month across DST", () => {
  expect(budgetPeriodStart("day", "America/New_York", now)).toBe(Date.parse("2026-03-10T04:00:00Z"));
  expect(budgetPeriodStart("week", "America/New_York", now)).toBe(Date.parse("2026-03-09T04:00:00Z"));
  expect(budgetPeriodStart("month", "America/New_York", now)).toBe(Date.parse("2026-03-01T05:00:00Z"));
  expect(budgetPeriodStart("day", "America/New_York", Date.parse("2026-03-08T12:00:00Z"))).toBe(Date.parse("2026-03-08T05:00:00Z"));
});
it("warns once, pauses from running work, and raising never resumes", () => {
  const budget = createDefaultPeriodBudget(db, { groupId: "g", period: "week", tz: "UTC", now });
  let elapsed = 96 * 60000; const lines: string[] = [];
  const gate = createProjectBudgetGate(db, { running: () => [{ groupId: "g", workMs: elapsed }], line: (_g, line) => lines.push(line) });
  gate.check({ groupId: "g", kind: "card_run", now }); gate.check({ groupId: "g", kind: "card_run", now });
  expect(lines).toHaveLength(1); expect(projectBudgetsForGroup(db, "g")[0]!.state).toBe("warned");
  elapsed = 120 * 60000;
  expect(gate.check({ groupId: "g", kind: "card_run", now }).ok).toBe(false);
  expect(db.prepare("SELECT run_state FROM project_settings").get()?.run_state).toBe("paused");
  const current = projectBudgetsForGroup(db, "g")[0]!;
  expect(patchProjectBudget(db, { budgetId: budget.id, expectedRevision: current.revision, maxWorkMinutes: 240, now }, gate).ok).toBe(true);
  expect(gate.check({ groupId: "g", kind: "card_run", now }).ok).toBe(true);
  expect(db.prepare("SELECT run_state FROM project_settings").get()?.run_state).toBe("paused");
  expect(lines).toHaveLength(2);
});
it("zone changes recompute period start and rollover keeps the project paused", () => {
  const budget = createDefaultPeriodBudget(db, { groupId: "g", period: "day", tz: "UTC", now });
  const gate = createProjectBudgetGate(db);
  expect(patchProjectBudget(db, { budgetId: budget.id, expectedRevision: budget.revision, tz: "America/New_York", now }, gate).ok).toBe(true);
  expect(projectBudgetsForGroup(db, "g")[0]!.periodStart).toBe(Date.parse("2026-03-10T04:00:00Z"));
  db.prepare("UPDATE project_settings SET run_state='paused'").run();
  gate.check({ groupId: "g", kind: "wake", now: now + 86400000 });
  expect(projectBudgetsForGroup(db, "g")[0]!.periodStart).toBe(Date.parse("2026-03-11T04:00:00Z"));
  expect(db.prepare("SELECT run_state FROM project_settings").get()?.run_state).toBe("paused");
});
it("lowering below usage pauses immediately and rejects a stale revision", () => {
  const budget = createDefaultPeriodBudget(db, { groupId: "g", period: "week", tz: "UTC", now });
  const gate = createProjectBudgetGate(db, { running: () => [{ groupId: "g", workMs: 60 * 60000 }] });
  expect(patchProjectBudget(db, { budgetId: budget.id, expectedRevision: 0, maxWorkMinutes: 30, now }, gate).ok).toBe(true);
  expect(projectBudgetsForGroup(db, "g")[0]!.state).toBe("paused");
  expect(patchProjectBudget(db, { budgetId: budget.id, expectedRevision: 0, maxWorkMinutes: 200, now }, gate).ok).toBe(false);
});

it("fault: a used-up budget stops new starts and the card work already running, with no clock",async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);
  try {
    const budget=createDefaultPeriodBudget(db,{groupId:"g",period:"week",tz:"UTC",now});
    db.prepare("UPDATE project_budgets SET max_work_minutes=1 WHERE id=?").run(budget.id);
    const slots=3,evaluateEveryMs=30000;const runs=new Map<string,ProjectUsageRun>();
    const gate=createProjectBudgetGate(db,{running:()=>[...runs.values()].map(()=>({groupId:"g",startedAt:now,workMs:Date.now()-now})),
      stop:(groupId,goalId)=>{stopRunsOverBudget([...runs.values()],groupId,goalId);}});
    for(let n=0;n<slots;n++){
      expect(gate.check({groupId:"g",kind:"card_run",now:Date.now()}).ok).toBe(true);
      const id=String(n);const request=insertRoomRequest(db,{groupId:"g",verb:"assign",fromKind:"owner",toBotId:id,targetThreadId:id,admissionKey:id,state:"running",now,
        lineage:{rootThreadId:id,origin:"desktop",audienceFingerprint:"owner",notOwnerAudience:false,unattended:false}}).request;
      // a Stop lands as the turn's terminal event, which settles its usage
      const run:ProjectUsageRun={request,generation:id,botId:id,engine:"fake",stop:()=>{if(!runs.delete(id))return;run.settled=true;settleProjectUsage(db,request,{botId:id,threadId:id,engine:"fake",turnGeneration:id,at:Date.now(),ok:false});}};
      runs.set(id,run);
    }
    // the server's periodic evaluation (30 s): nothing ends the work but the budget
    // (the stop is deferred out of the evaluation, which may be inside an admission check)
    for(let t=0;t<4*evaluateEveryMs;t+=evaluateEveryMs){vi.advanceTimersByTime(evaluateEveryMs);gate.evaluate("g",Date.now());await Promise.resolve();}
    expect(runs.size).toBe(0);
    // bounded by the budget plus one evaluation interval per running slot, not by a per-run cap
    expect(projectUsage(db,{groupId:"g"}).totals.workMs).toBeLessThanOrEqual(slots*(60000+evaluateEveryMs));
    expect(gate.check({groupId:"g",kind:"card_run",now:Date.now()}).ok).toBe(false);
  }finally{vi.useRealTimers();}
});

it("goal and period ceilings both apply, and only an owner Resume runs the raised goal",()=>{
  db.prepare("UPDATE project_settings SET lead_bot_id='lead',parts=?").run(JSON.stringify({board:true}));
  db.prepare("INSERT INTO project_goals (id,group_id,title,state,created_at) VALUES ('goal','g','Finish','working',?)").run(now);
  const goalBudget=createDefaultGoalBudget(db,{groupId:"g",goalId:"goal",tz:"UTC",now});
  db.prepare("UPDATE project_budgets SET max_work_minutes=1 WHERE id=?").run(goalBudget.id);
  const period=createDefaultPeriodBudget(db,{groupId:"g",period:"week",tz:"UTC",now});
  const request=insertRoomRequest(db,{groupId:"g",projectGoalId:"goal",verb:"room_turn",fromKind:"owner",toBotId:"bot",targetThreadId:"room",admissionKey:"both",state:"running",now,
    lineage:{rootThreadId:"room",origin:"desktop",audienceFingerprint:"owner",notOwnerAudience:false,unattended:false}}).request;
  settleProjectUsage(db,request,{botId:"bot",threadId:"room",engine:"fake",turnGeneration:"both",at:now+60000,ok:true});
  const gate=createProjectBudgetGate(db);
  expect(gate.check({groupId:"g",goalId:"goal",kind:"card_run",now:now+60000})).toMatchObject({ok:false,budgetId:goalBudget.id});
  expect(db.prepare("SELECT state FROM project_goals").get()?.state).toBe("paused");
  expect(resumeProjectGoal(db,{goalId:"goal",actor:{kind:"owner"},now:now+60000,memberIds:["lead","bot"]}).ok).toBe(false);
  const current=projectBudgetsForGroup(db,"g").find(b=>b.id===goalBudget.id)!;
  expect(patchProjectBudget(db,{budgetId:current.id,expectedRevision:current.revision,maxWorkMinutes:2,now:now+60000},gate).ok).toBe(true);
  expect(db.prepare("SELECT state FROM project_goals").get()?.state).toBe("paused");
  expect(resumeProjectGoal(db,{goalId:"goal",actor:{kind:"owner"},now:now+60000,memberIds:["lead","bot"]}).ok).toBe(true);
  expect(patchProjectBudget(db,{budgetId:period.id,expectedRevision:period.revision,maxWorkMinutes:1,now:now+60000},gate).ok).toBe(true);
  expect(gate.check({groupId:"g",goalId:"goal",kind:"card_run",now:now+60000})).toMatchObject({ok:false,budgetId:period.id});
  expect(db.prepare("SELECT run_state FROM project_settings").get()?.run_state).toBe("paused");
});


it("checks learning against period and active goals without writes, pauses or room lines",()=>{
 const period=createDefaultPeriodBudget(db,{groupId:"g",period:"day",tz:"UTC",now});
 db.prepare("INSERT INTO project_goals (id,group_id,title,state,created_at) VALUES ('goal','g','Finish','working',?)").run(now);
 const goal=createDefaultGoalBudget(db,{groupId:"g",goalId:"goal",tz:"UTC",now});
 const line=vi.fn(),changed=vi.fn(),gate=createProjectBudgetGate(db,{running:()=>[{groupId:"g",goalId:"goal",workMs:60000}],line,changed});
 db.prepare("UPDATE project_budgets SET max_work_minutes=1 WHERE id=?").run(goal.id);
 const before=db.prepare("SELECT * FROM project_budgets ORDER BY id").all();
 expect(gate.checkLearning({groupId:"g",now})).toMatchObject({ok:false,budgetId:goal.id});
 expect(db.prepare("SELECT * FROM project_budgets ORDER BY id").all()).toEqual(before);expect(line).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();expect(db.prepare("SELECT run_state FROM project_settings").get()?.run_state).toBe("running");
 db.prepare("UPDATE project_budgets SET max_work_minutes=10 WHERE id=?").run(goal.id);expect(gate.checkLearning({groupId:"g",now}).ok).toBe(true);
 const request=insertRoomRequest(db,{groupId:"g",verb:"room_turn",fromKind:"owner",toBotId:"bot",targetThreadId:"room",admissionKey:"learning-token",state:"running",now,lineage:{rootThreadId:"room",origin:"desktop",audienceFingerprint:"owner",notOwnerAudience:false,unattended:false}}).request;
 expect(settleProjectUsage(db,request,{botId:"bot",threadId:"room",engine:"fake",turnGeneration:"learning-token",at:now,ok:true,usage:{input:1,output:0}})).toBe(true);
 db.prepare("UPDATE project_budgets SET max_tokens=1 WHERE id=?").run(period.id);expect(gate.checkLearning({groupId:"g",now})).toMatchObject({ok:false,budgetId:period.id});
 db.exec("UPDATE project_goals SET state='done';UPDATE project_budgets SET max_tokens=NULL WHERE period!='goal'");expect(gate.checkLearning({groupId:"g",now:now+86400000}).ok).toBe(true);
});
