// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Lane N round 6, task B: afterProjectLeadTurn's two planning guards on a real
// server with the fake Claude CLI. The lead's reply in each held turn is a
// VALID goal envelope assigning a card to itself; every other guard in
// afterProjectLeadTurn passes when it lands, so only the guard under test
// keeps the project from planning:
//  (1) a close turn (the summary, and the lead's close lesson, which is still
//      running after Reopen, Resume and a new goal's Start) never plans and
//      never counts as a lead wake of the new goal. (Its envelope could not
//      create a card anyway: a close turn has no source message, and a card
//      must be bound to one. Without the guard it is refused with a Murage
//      line and counted as a wake without progress, which feeds the stop
//      rules that pause a goal.)
//  (2) a lead turn issued for a goal the owner has since signed off never
//      plans the goal started after it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer | undefined, headers: Record<string, string> = {};
afterEach(async () => { await fixture?.close(); fixture = undefined; });

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture!.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const read = <T,>(sql: string, ...args: string[]): T[] => {
  const db = new DatabaseSync(join(fixture!.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
};
const until = async <T,>(probe: () => T | undefined, what: () => string, tries = 200): Promise<T> => {
  for (let i = 0; i < tries; i++) { const value = probe(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`timed out: ${what()}`);
};
const requests = (groupId: string) => read<{ id: string; verb: string; state: string; admission_key: string; project_goal_id: string | null }>(
  "SELECT id,verb,state,admission_key,project_goal_id FROM room_requests WHERE group_id=? ORDER BY rowid", groupId);
const planned = (groupId: string) => ({
  cards: read<{ n: number }>("SELECT COUNT(*) AS n FROM project_work_items WHERE group_id=?", groupId)[0]!.n,
  cardActivity: read<{ n: number }>("SELECT COUNT(*) AS n FROM project_activity WHERE group_id=? AND kind LIKE 'card_%'", groupId)[0]!.n,
});
/** The new goal's wake count: only its own lead wakes may count (recordLeadWake). */
const wakes = (goalId: string) => read<{ lead_wakes: number; no_progress: number }>("SELECT lead_wakes,no_progress FROM project_goals WHERE id=?", goalId)[0];
const refusalLines = async (groupId: string) => {
  const group = (await api("GET", "/api/bots?messages=0")).body.groups.find((candidate: any) => candidate.id === groupId);
  return ((await api("GET", `/api/threads/${group.threadId}/messages?limit=200`)).body.messages as Array<{ text?: string }>).filter(message => message.text?.includes("Your plan could not be read") || message.text?.includes("plan was not used")).length;
};
const settled = (groupId: string) => requests(groupId).every(request => ["done", "failed", "cancelled", "expired", "unknown"].includes(request.state)) ? true : undefined;

/** Launch with one seeded project whose lead answers every turn from `replies`,
 * holding the turn whose prompt carries `holdMarker` until the gate opens.
 * The replies name the lead by its id, so they are written after it exists. */
async function launch(seed: string, holdMarker: string, replies: string) {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const dir=process.env.MURAGE_DATA_DIR;
    const {Store}=await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const {database}=await import(${JSON.stringify(new URL("./database.ts", import.meta.url).href)});
    const {createProjectRows}=await import(${JSON.stringify(new URL("./project-new.ts", import.meta.url).href)});
    const {materializeProjectCreation}=await import(${JSON.stringify(new URL("./project-migration.ts", import.meta.url).href)});
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const lead=store.createBot({name:'Guard lead'},{seedMessages:false});
    ${seed}
    const envelope=(title)=>'Here is my plan. <murage-goal>'+JSON.stringify({v:2,status:'assign',cards:[{key:'k-'+title.length,assignee:lead.id,title}]})+'</murage-goal>';
    process.env.FAKE_CLAUDE_REPLIES=JSON.stringify(${replies});
    process.env.FAKE_CLAUDE_REPLY_STATE=path.join(dir,'tmp','reply-state');
    process.env.FAKE_CLAUDE_HOLD_MARKER=${JSON.stringify(holdMarker)};
    process.env.FAKE_CLAUDE_HOLD_GATE=path.join(dir,'tmp','hold-gate');
    process.env.FAKE_CLAUDE_HOLD_SEEN=path.join(dir,'tmp','hold-seen');
    fs.writeFileSync(path.join(dir,'tmp','lead-id'),lead.id);
  ` });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const leadId = readFileSync(join(fixture.info.dataDir, "tmp", "lead-id"), "utf8");
  expect((await api("PATCH", `/api/bots/${leadId}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return leadId;
}
const held = () => existsSync(join(fixture!.info.dataDir, "tmp", "hold-seen")) && readFileSync(join(fixture!.info.dataDir, "tmp", "hold-seen"), "utf8").trim() ? true : undefined;
const release = () => writeFileSync(join(fixture!.info.dataDir, "tmp", "hold-gate"), "open");
const startNewGoal = async (base: string, title: string) => {
  const made = await api("POST", `${base}/project/goals`, { title });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const started = await api("PATCH", `${base}/project/goals/${made.body.goal.id}`, { expectedRevision: made.body.goal.revision, action: "start" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(started.body.goal.state).toBe("planning");
  return made.body.goal.id as string;
};

posixOnly("R6 task B: afterProjectLeadTurn's planning guards, end to end", () => {
  it("(1) close turns never plan: the summary, and the lead's lesson still running after Reopen and a new goal's Start, do not touch the new goal", async () => {
    await launch(`
      createProjectRows(database(),{clientId:'close-guard',purpose:'Close guard',mode:'goal',members:[lead.id],leadBotId:lead.id},[{id:lead.id,name:lead.name}],1);
      materializeProjectCreation(store,'close-guard');
    `, "Project closed: what I learned", "[envelope('From the summary'),envelope('From the lesson'),'Looking at the new goal.']");
    const base = "/api/groups/close-guard";
    const closed = await api("POST", `${base}/project/close`, {});
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.summaryRequestId).toEqual(expect.any(String));
    // the summary answered (with its envelope), the close finished, and the
    // lead's lesson turn is running, held before its reply
    await until(held, () => JSON.stringify(requests("close-guard")));
    const lesson = await until(() => requests("close-guard").find(request => request.admission_key.startsWith("close-lesson:") && request.state === "running"), () => JSON.stringify(requests("close-guard")));
    expect(lesson.project_goal_id).toBeNull();
    expect(requests("close-guard").find(request => request.id === closed.body.summaryRequestId)?.state).toBe("done");
    expect((await api("GET", `${base}/project`)).body.lifecycle).toBe("closed");
    expect(planned("close-guard")).toEqual({ cards: 0, cardActivity: 0 });
    // the owner reopens, resumes and starts a new goal while the lesson runs
    expect((await api("POST", `${base}/project/reopen`, {})).status).toBe(200);
    const resumed = await api("POST", `${base}/project/control/resume`, {});
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    const goalId = await startNewGoal(base, "The next goal");
    expect(requests("close-guard").find(request => request.id === lesson.id)?.state).toBe("running");
    // the lesson now answers with a valid plan for the new goal: nothing is planned
    release();
    await until(() => settled("close-guard"), () => JSON.stringify(requests("close-guard")));
    expect(requests("close-guard").find(request => request.admission_key === `wake:goal-start:${goalId}`)?.state).toBe("done");
    expect(planned("close-guard")).toEqual({ cards: 0, cardActivity: 0 });
    expect((await api("GET", `${base}/project`)).body.goal).toMatchObject({ id: goalId, state: "planning" });
    // only the new goal's own start wake counted, and no plan was read from the lesson
    expect(wakes(goalId)).toEqual({ lead_wakes: 1, no_progress: 1 });
    expect(await refusalLines("close-guard")).toBe(0);
  }, 60000);

  it("(2) a lead turn issued for a signed-off goal never plans the goal started after it", async () => {
    await launch(`
      createProjectRows(database(),{clientId:'goal-guard',purpose:'Goal guard',mode:'goal',members:[lead.id],leadBotId:lead.id,goal:{title:'The first goal'}},[{id:lead.id,name:lead.name}],1);
      materializeProjectCreation(store,'goal-guard');
      database().prepare("UPDATE project_goals SET state='awaiting_signoff' WHERE group_id='goal-guard'").run();
    `, "HOLD_THIS_TURN", "[envelope('For the next goal'),'Summary of the first goal.','Looking at the new goal.']");
    const base = "/api/groups/goal-guard";
    const first = (await api("GET", `${base}/project`)).body.goal as { id: string; revision: number; state: string };
    expect(first.state).toBe("awaiting_signoff");
    expect((await api("POST", `/api/groups/goal-guard/messages`, { text: "How is it going? HOLD_THIS_TURN" })).status).toBe(202);
    await until(held, () => JSON.stringify(requests("goal-guard")));
    const turn = await until(() => requests("goal-guard").find(request => request.verb === "room_turn" && request.state === "running"), () => JSON.stringify(requests("goal-guard")));
    expect(turn.project_goal_id).toBe(first.id);
    // the owner signs the first goal off and starts the next one while that turn runs
    const signed = await api("PATCH", `${base}/project/goals/${first.id}`, { expectedRevision: first.revision, action: "sign_off" });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    const goalId = await startNewGoal(base, "The next goal");
    expect(requests("goal-guard").find(request => request.id === turn.id)?.state).toBe("running");
    // the old turn answers with a valid plan: it does not plan the new goal
    release();
    await until(() => settled("goal-guard"), () => JSON.stringify(requests("goal-guard")));
    expect(requests("goal-guard").find(request => request.id === turn.id)?.state).toBe("done");
    expect(planned("goal-guard")).toEqual({ cards: 0, cardActivity: 0 });
    expect((await api("GET", `${base}/project`)).body.goal).toMatchObject({ id: goalId, state: "planning" });
    expect(wakes(goalId)).toEqual({ lead_wakes: 1, no_progress: 1 });
  }, 60000);
});
