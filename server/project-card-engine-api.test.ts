// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
let fixture: VerificationServer;
let proof: string;
let fixtureRoot: string;
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  fixtureRoot = mkdtempSync(join(here, ".e2a-fixtures-"));
  vi.stubEnv("TMPDIR", fixtureRoot);
  const fake = join(here, "testing", "fake-acp-cli.ts");
  chmodSync(fake, 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.cardlead={driver:'grokAgent',displayName:'Card lead fixture',environment:{FAKE_ACP_MODE:'project-card-lead'},config:{cli:${JSON.stringify(fake)},fullAuto:true}};
    cfg.instances.reviewlead={driver:'grokAgent',displayName:'Review lead fixture',environment:{FAKE_ACP_MODE:'project-card-lead',FAKE_ACP_PROMPT_DUMP:path.join(process.env.MURAGE_DATA_DIR,'review-lead-prompt.json')},config:{cli:${JSON.stringify(fake)},fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  proof = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
}, 30000);
afterAll(async () => { await fixture?.close(); if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true }); vi.unstubAllEnvs(); });
it("an owner-started card runs in its bot desk and returns one result to the room", async () => {
  const instances = (await api("GET", "/api/instances")).body.instances;
  const engine = instances.find((instance: any) => instance.instanceId === "verification");
  const made = await api("POST", "/api/bots", { name: "Jax", modelSelection: { instanceId: "verification", model: engine.models.options[0].id } });
  expect(made.status).toBe(201);
  const bot = made.body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  const created = await api("POST", "/api/groups", { name: "Payments", memberIds: [bot.id], setup: { bulletin: "Reconcile payments", defaultResponder: { kind: "member", botId: bot.id } } });
  const group = created.body.group;
  expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Reconcile payments" } })).status).toBe(200);
  const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: "e2a-test-card", title: "Count payments", assigneeBotId: bot.id, writes: false })).body.card;
  expect(card).toBeTruthy();
  expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: card.revision, action: "start" })).status).toBe(200);
  await expect.poll(async () => (await api("GET", `/api/groups/${group.id}/board`)).body.cards.find((entry: any) => entry.id === card.id)?.state, { timeout: 45000 }).toBe("done");
  const completed = (await api("GET", `/api/groups/${group.id}/board`)).body.cards.find((entry: any) => entry.id === card.id);
  const desk = (await api("GET", `/api/threads/${completed.deskThreadId}/messages`)).body.messages;
  expect(desk.some((message: any) => message.role === "bot" && message.kind === "text")).toBe(true);
  const room = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages;
  expect(room.filter((message: any) => String(message.tool?.name ?? "").includes("result for 'Count payments'"))).toHaveLength(1);
}, 60000);

it("lead assignment runs in the member desk and reaches the room and lead exactly once", async () => {
  const instances = (await api("GET", "/api/instances")).body.instances;
  const makeBot = async (name: string, instanceId: string) => {
    const instance = instances.find((entry: any) => entry.instanceId === instanceId);
    const result = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: instance.models.options[0].id } });
    expect(result.status).toBe(201);
    await api("PATCH", `/api/bots/${result.body.bot.id}`, { computer: "off", browser: false, composio: false });
    return result.body.bot;
  };
  const lead = await makeBot("Finch", "cardlead"), worker = await makeBot("Ivy", "verification");
  const group = (await api("POST", "/api/groups", { name: "Card project", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } })).body.group;
  expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Finish one card" } })).status).toBe(200);
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES(?,?,'Finish one card','working',0,1,1)").run(`goal-${group.id}`, group.id);
  } finally { db.close(); }
  expect((await api("POST", `/api/groups/${group.id}/messages`, { text: `E2A_ASSIGN:${worker.id}` })).status).toBe(202);
  await expect.poll(async () => (await api("GET", `/api/groups/${group.id}/board`)).body.cards, { timeout: 45000 })
    .toEqual([expect.objectContaining({ title: "Assigned payments", state: "done", assigneeBotId: worker.id })]);
  await expect.poll(async () => (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages.some((message: any) => message.text?.includes("CARD_RESULT_RECEIVED")), { timeout: 45000 }).toBe(true);
  const room = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages;
  expect(room.filter((message: any) => message.murage?.kind === "result")).toHaveLength(1);
  // SPEC-P 10: the result's room copy answers the owner's message it came from
  const owner = room.find((message: any) => message.role === "user");
  expect(room.find((message: any) => message.copyOf && message.from?.botId === worker.id)?.replyToId).toBe(owner.id);
  const link = room.find((message: any) => message.murage?.kind === "result").murage.desk;
  expect(link.botId).toBe(worker.id);
  expect((await api("GET", `/api/threads/${link.threadId}/messages`)).body.messages.some((message: any) => message.kind === "text" && message.role === "bot")).toBe(true);
}, 100000);

// The AFTER-PF finiteCards run: owner cards reached review and stayed there,
// because nothing woke the lead or told it how to move them on.
// Lane review: the server names the reviewer (here the lead, the only other
// member); its review gives no verdict, so the lead is woken to decide.
it("an owner card that reaches review is reviewed and the lead decides on it", async () => {
  const instances = (await api("GET", "/api/instances")).body.instances;
  const makeBot = async (name: string, instanceId: string) => {
    const instance = instances.find((entry: any) => entry.instanceId === instanceId);
    const result = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: instance.models.options[0].id } });
    expect(result.status).toBe(201);
    await api("PATCH", `/api/bots/${result.body.bot.id}`, { computer: "off", browser: false, composio: false });
    return result.body.bot;
  };
  const lead = await makeBot("Nova", "reviewlead"), worker = await makeBot("Reed", "verification");
  // No warm-up turn for the lead: its first turns are its room wake and its
  // review in its desk, at the same moment (procedure-migration-busy-api.test.ts).
  const group = (await api("POST", "/api/groups", { name: "Review project", memberIds: [lead.id, worker.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } })).body.group;
  expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Ship the plan" } })).status).toBe(200);
  const goalId = `goal-${group.id}`;
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT INTO project_goals(id,group_id,title,criteria,state,review,created_at,started_at) VALUES(?,?,'Ship the plan',?,'working',1,1,1)")
      .run(goalId, group.id, JSON.stringify([{ id: "k1", text: "The plan exists", setBy: "owner", proposed: false, met: false }]));
  } finally { db.close(); }
  const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: "review-owner-card", title: "Three segments", assigneeBotId: worker.id, goalId, writes: false })).body.card;
  expect(card).toBeTruthy();
  expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: card.revision, action: "start" })).status).toBe(200);
  await expect.poll(async () => (await api("GET", `/api/groups/${group.id}/board`)).body.cards.find((entry: any) => entry.id === card.id)?.state, { timeout: 45000 }).toBe("review");
  const dump = join(fixture.info.dataDir, "review-lead-prompt.json");
  await expect.poll(() => existsSync(dump) && readFileSync(dump, "utf8").includes("ended without a verdict, so you decide now"), { timeout: 45000, interval: 20 }).toBe(true);
  const prompt = readFileSync(dump, "utf8");
  expect(prompt).toContain(`card_id \\"${card.id}\\"`);
  // the name is data, quoted (round 8), so the JSON dump escapes its quotes
  expect(prompt).toContain(`\\"Nova\\" (${lead.id})`);
  expect(prompt).toContain("project_criteria");
  expect(prompt).toContain("k1");
  await expect.poll(async () => (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages.some((message: any) => message.from?.botId === lead.id && message.text?.includes("CARD_RESULT_RECEIVED")), { timeout: 45000 }).toBe(true);
  await expect.poll(async () => (await api("GET", `/api/groups/${group.id}/board`)).body.cards.find((entry: any) => entry.id === card.id)?.state, { timeout: 45000 }).toBe("done");
}, 120000);
