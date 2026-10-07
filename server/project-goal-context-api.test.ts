// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AFTER-GOALDONE (next/0161 0db8a1f8, Fuigo on Haiku 4.5). finiteGoal: the
// lead's cards left out what the product was, the card runs never saw the
// goal they served, so every member asked for inputs, every review asked for
// changes and the lead asked the owner "what is Tallyroo?" (3 nudges).
// finiteCards: Wren's LAUNCH-PLAN.md was saved on her card, but her reviewer
// got only "Done, it is saved" and asked for changes: "no file contents".
// And the project's setup instructions never reached its brief, so every
// card's <project-brief> was empty. On a real server with fake engines:
// a goal card's run and review carry the goal, the review quotes the files
// the run saved, the lead's Start wake carries the goal's description, and
// finishing setup on a project writes its instructions into the brief.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const TESTING = join(dirname(fileURLToPath(import.meta.url)), "testing");
const FAKE_ACP = join(TESTING, "fake-acp-cli.ts");
let fixture: VerificationServer, proof: string, fixtureRoot: string, leadDump: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const withDb = <T>(read: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { db.exec("PRAGMA busy_timeout=5000"); return read(db); } finally { db.close(); }
};

const GOAL_DESCRIPTION = "Ship a launch plan for Tallyroo (an app that lets small teams split and track shared expenses).";

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".goal-context-fixtures-"));
  leadDump = join(fixtureRoot, "lead-prompt.json");
  vi.stubEnv("TMPDIR", fixtureRoot);
  chmodSync(FAKE_ACP, 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    const acp=${JSON.stringify(FAKE_ACP)};
    cfg.instances.cardlead={driver:'grokAgent',displayName:'Lead fixture',environment:{FAKE_ACP_MODE:'project-card-lead'},config:{cli:acp,fullAuto:true}};
    cfg.instances.leaddump={driver:'grokAgent',displayName:'Lead dump',environment:{FAKE_ACP_PROMPT_DUMP:${JSON.stringify(leadDump)}},config:{cli:acp,fullAuto:true}};
    cfg.instances['rev-grok']={driver:'grokAgent',displayName:'Grok reviewer',environment:{FAKE_REVIEW_VERDICT:'pass'},config:{cli:acp,fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  proof = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
}, 60000);
afterAll(async () => { await fixture?.close(); if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true }); vi.unstubAllEnvs(); });

let made = 0;
async function makeBot(name: string, instanceId: string) {
  const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
  expect(instance, instanceId).toBeTruthy();
  const model = instance.models.options[0]?.id || instance.models.default || "fixture-model";
  const result = await api("POST", "/api/bots", { name: `${name}${++made}`, modelSelection: { instanceId, model } });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  await api("PATCH", `/api/bots/${result.body.bot.id}`, { computer: "off", browser: false, composio: false });
  return result.body.bot as { id: string; name: string; threadId: string };
}
const cardOf = async (groupId: string, cardId: string) => (await api("GET", `/api/groups/${groupId}/board`)).body.cards.find((entry: any) => entry.id === cardId);
async function deskAsks(botId: string, groupId: string): Promise<string[]> {
  const desk = (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId).tasks.find((task: any) => task.channelProjectDesk?.groupId === groupId);
  const messages = (await api("GET", `/api/threads/${desk.threadId}/messages`)).body.messages;
  return messages.filter((message: any) => message.role === "user").map((message: any) => String(message.text ?? ""));
}

describe.skipIf(process.platform === "win32")("a goal card's run knows its goal and its review sees its files", () => {
  it("the card run and its review carry the goal; the review quotes the file the run saved", async () => {
    const lead = await makeBot("Nova", "cardlead"), worker = await makeBot("Wren", "verification"), reviewer = await makeBot("Reed", "rev-grok");
    const group = (await api("POST", "/api/groups", { name: `Goal ${made}`, memberIds: [lead.id, worker.id, reviewer.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } })).body.group;
    expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Ship the plan" } })).status).toBe(200);
    const goalId = `goal-${group.id}`;
    const criteria = [{ id: "k1", text: "LAUNCH-PLAN.md exists in the project folder", setBy: "owner", met: false }, { id: "k2", text: "It names three target customer segments", setBy: "owner", met: false }];
    withDb(db => {
      db.prepare("INSERT INTO project_goals(id,group_id,title,description,criteria,state,review,created_at,started_at) VALUES(?,?,'Tallyroo launch plan',?,?,'working',1,1,1)").run(goalId, group.id, GOAL_DESCRIPTION, JSON.stringify(criteria));
      db.prepare("UPDATE project_settings SET lead_bot_id=? WHERE group_id=?").run(lead.id, group.id);
    });
    // the fixture engine writes outputs/LAUNCH-PLAN.md when its prompt names it
    const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: `goal-${made}`, title: "Write the plan", description: "Write the plan. __fixture_write_output__:outputs/LAUNCH-PLAN.md", assigneeBotId: worker.id, writes: false })).body.card;
    expect(card).toBeTruthy();
    withDb(db => db.prepare("UPDATE project_work_items SET goal_id=? WHERE id=?").run(goalId, card.id));
    const fresh = await cardOf(group.id, card.id);
    expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: fresh.revision, action: "start" })).status).toBe(200);
    await expect.poll(async () => (await cardOf(group.id, card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done");

    const work = (await deskAsks(worker.id, group.id)).find(text => text.includes("Write the plan")) ?? "";
    expect(work).toContain("<project-goal>");
    expect(work).toContain("Goal: Tallyroo launch plan");
    expect(work).toContain(GOAL_DESCRIPTION);
    expect(work).toContain("- It names three target customer segments");

    const review = (await deskAsks(reviewer.id, group.id)).find(text => text.includes("Review card")) ?? "";
    expect(review).toContain(GOAL_DESCRIPTION);
    const saved = withDb(db => ({ artifacts: db.prepare("SELECT name, kind, thread_id, bot_id, created_at FROM artifacts").all(), runs: db.prepare("SELECT verb, dispatched_at, target_thread_id FROM room_requests WHERE work_item_id=?").all(card.id), card: db.prepare("SELECT request_id, desk_thread_id FROM project_work_items WHERE id=?").get(card.id), pubs: db.prepare("SELECT stage, path_token, error_category, thread_id FROM output_publications").all() }));
    expect(review, JSON.stringify(saved)).toContain('<file-to-review name="LAUNCH-PLAN.md">');
    expect(review).toContain("# Weekly report");
  }, 90000);

  it("the lead's Start wake carries the goal's description", async () => {
    const lead = await makeBot("Lead", "leaddump"), member = await makeBot("Cole", "verification");
    const group = (await api("POST", "/api/groups", { name: `Start ${made}`, memberIds: [lead.id, member.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } })).body.group;
    expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Ship the plan" } })).status).toBe(200);
    const created = await api("POST", `/api/groups/${group.id}/project/goals`, { title: "Tallyroo launch plan", description: GOAL_DESCRIPTION, criteria: ["LAUNCH-PLAN.md exists", "Three segments"], planFirst: false });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const started = await api("PATCH", `/api/groups/${group.id}/project/goals/${created.body.goal.id}`, { expectedRevision: created.body.goal.revision, action: "start" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await expect.poll(() => existsSync(leadDump) && readFileSync(leadDump, "utf8").includes("started the goal"), { timeout: 60000, interval: 250 }).toBe(true);
    const prompt = readFileSync(leadDump, "utf8");
    expect(prompt).toContain("an app that lets small teams split and track shared expenses");
    expect(prompt).toContain("<goal-description>");
  }, 90000);
});

describe("a project's setup instructions reach its brief", () => {
  it("finishing setup on a project writes the instructions into the brief's rules", async () => {
    const lead = await makeBot("Mira", "verification");
    const created = await api("POST", "/api/groups", { name: `Setup ${made}`, memberIds: [lead.id], channelProject: { goal: "Ship the plan" } });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const group = created.body.group;
    const done = await api("PATCH", `/api/groups/${group.id}/setup`, { action: "complete", cwd: null, bulletin: GOAL_DESCRIPTION, defaultResponder: { kind: "member", botId: lead.id } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const rules = withDb(db => (db.prepare("SELECT rules FROM project_briefs WHERE group_id=? ORDER BY version DESC LIMIT 1").get(group.id) as { rules: string } | undefined)?.rules);
    expect(rules).toBe(GOAL_DESCRIPTION);
  }, 60000);
});
