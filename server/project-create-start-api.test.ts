// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Lane N round 6, task C: New project's "Start now". Create also starts the
// goal through the goal route's own Start (transition and lead wake together),
// once per clientId; a refused Start keeps the draft and says why.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>, leadId: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const read = <T,>(sql: string, ...args: string[]): T[] => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
  const made = await api("POST", "/api/bots", { name: "Start lead", modelSelection: { instanceId: "verification", model } });
  expect(made.status).toBe(201); leadId = made.body.bot.id;
  await api("PATCH", `/api/bots/${leadId}`, { computer: "off", browser: false, composio: false });
}, 30000);
afterAll(async () => { await fixture?.close(); });

const goalBody = (clientId: string, extra: Record<string, unknown> = {}) => ({ clientId, purpose: "Ship the report", mode: "goal", members: [leadId], leadBotId: leadId, goal: { title: "Ship the report" }, startGoal: true, ...extra });

it("C creates and starts the goal in one action: planning, a lead wake, a goal budget, plan-first off", async () => {
  const made = await api("POST", "/api/projects", goalBody("start-now"));
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body).not.toHaveProperty("startReason");
  const project = (await api("GET", "/api/groups/start-now/project")).body;
  expect(project.goal).toMatchObject({ title: "Ship the report", state: "planning" });
  const [goal] = read<{ id: string; plan_first: number }>("SELECT id,plan_first FROM project_goals WHERE group_id='start-now'");
  expect(goal!.plan_first).toBe(0);
  expect(read("SELECT id FROM room_requests WHERE group_id='start-now' AND verb='wake' AND admission_key=?", `wake:goal-start:${goal!.id}`)).toHaveLength(1);
  expect(read("SELECT id FROM project_budgets WHERE group_id='start-now' AND period='goal' AND goal_id=?", goal!.id)).toHaveLength(1);
  // a retried Create answers the same project and never starts it twice
  const again = await api("POST", "/api/projects", goalBody("start-now"));
  expect(again.status).toBe(200);
  expect(again.body.group.id).toBe("start-now");
  expect(again.body).not.toHaveProperty("startReason");
  expect(read("SELECT id FROM room_requests WHERE group_id='start-now' AND verb='wake'")).toHaveLength(1);
  expect(read("SELECT id FROM project_activity WHERE group_id='start-now' AND kind='goal_state' AND json_extract(detail,'$.to')='planning'")).toHaveLength(1);
}, 30000);

it("C a Start that is not allowed keeps the draft goal and says why", async () => {
  const made = await api("POST", "/api/projects", goalBody("start-refused", { leadBotId: null }));
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body.startReason).toBe("Pick a lead first.");
  expect((await api("GET", "/api/groups/start-refused/project")).body.goal).toMatchObject({ state: "draft" });
  expect(read("SELECT id FROM room_requests WHERE group_id='start-refused'")).toHaveLength(0);
}, 30000);

it("C without Start now the goal stays a draft, as before", async () => {
  const { startGoal: _startGoal, ...plain } = goalBody("start-later");
  expect((await api("POST", "/api/projects", plain)).status).toBe(200);
  expect((await api("GET", "/api/groups/start-later/project")).body.goal).toMatchObject({ state: "draft" });
}, 30000);

it("C Start now is strict: only true, and only with a goal", async () => {
  for (const body of [
    goalBody("start-strict-1", { goal: undefined }),
    goalBody("start-strict-2", { mode: "chat" }),
    goalBody("start-strict-3", { startGoal: false }),
    goalBody("start-strict-4", { startGoal: "yes" }),
  ]) expect((await api("POST", "/api/projects", body)).status, JSON.stringify(body)).toBe(400);
  expect(read("SELECT group_id FROM project_settings WHERE group_id LIKE 'start-strict-%'")).toHaveLength(0);
}, 30000);
