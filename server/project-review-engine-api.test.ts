// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane review on a real server with fake engines. AFTER-PF: in every goal
// run the cards stopped in review and the goal never finished. Here an owner
// card of a goal with review on runs, the server names the reviewer (another
// member, not the lead), the reviewer's engine answers, and the card ends
// done. Each engine kind answers with the verdict block in its reply
// (fake-review.ts); Fuigo also answers through project_review_result. A
// reviewer that gives no verdict wakes the lead, who decides.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const TESTING = join(dirname(fileURLToPath(import.meta.url)), "testing");
const FAKE_ACP = join(TESTING, "fake-acp-cli.ts"), FAKE_CODEX = join(TESTING, "fake-codex-app-server.ts"), FAKE_PI = join(TESTING, "fake-pi-cli.ts"), FAKE_AGY = join(TESTING, "fake-agy-cli.ts");
let fixture: VerificationServer, proof: string, fixtureRoot: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const withDb = <T>(read: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  try { db.exec("PRAGMA busy_timeout=5000"); return read(db); } finally { db.close(); }
};

/** Reviewer engines: every kind answers with the block; fuigo-tool through the tool. */
const REVIEWERS = ["rev-claude", "rev-codex", "rev-fuigo", "rev-fuigo-tool", "rev-grok", "rev-gemini", "rev-pi", "rev-agy"];

beforeAll(async () => {
  // Outside the checkout: a data dir inside the repository makes every
  // workspace sit under its git root, whose AGENTS.md and .claude/skills
  // Fuigo would read, so Murage rightly asks "Trust this folder?" first and
  // the Fuigo reviewers wait on the owner (a CI checkout has .git).
  fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "review-fixtures-")));
  vi.stubEnv("TMPDIR", fixtureRoot);
  for (const path of [FAKE_ACP, FAKE_CODEX, FAKE_PI, FAKE_AGY]) chmodSync(path, 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    fs.mkdirSync(path.join(process.env.HOME,'.fuigo'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.fuigo','auth.json'),'{}');
    const acp=${JSON.stringify(FAKE_ACP)};
    cfg.instances.cardlead={driver:'grokAgent',displayName:'Lead fixture',environment:{FAKE_ACP_MODE:'project-card-lead'},config:{cli:acp,fullAuto:true}};
    const pass={FAKE_REVIEW_VERDICT:'pass'};
    cfg.instances['rev-claude']={driver:'claudeAgent',displayName:'Claude reviewer',environment:pass,config:{cli:cfg.instances.verification.config.cli}};
    cfg.instances['rev-codex']={driver:'codex',displayName:'Codex reviewer',environment:pass,config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true}};
    cfg.instances['rev-fuigo']={driver:'fuigoAgent',displayName:'Fuigo reviewer',environment:{...pass,FAKE_ACP_MCP_READY:'1'},config:{cli:acp}};
    cfg.instances['rev-fuigo-tool']={driver:'fuigoAgent',displayName:'Fuigo tool reviewer',environment:{...pass,FAKE_REVIEW_TOOL:'1',FAKE_ACP_MCP_READY:'1'},config:{cli:acp}};
    cfg.instances['rev-grok']={driver:'grokAgent',displayName:'Grok reviewer',environment:pass,config:{cli:acp,fullAuto:true}};
    cfg.instances['rev-gemini']={driver:'geminiAgent',displayName:'Gemini reviewer',environment:{...pass,GEMINI_API_KEY:'fixture',FAKE_ACP_AUTH:'1'},config:{cli:acp,fullAuto:true}};
    cfg.instances['rev-pi']={driver:'piAgent',displayName:'Pi reviewer',environment:pass,config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true}};
    cfg.instances['rev-agy']={driver:'antigravityAgent',displayName:'Antigravity reviewer',environment:pass,config:{cli:${JSON.stringify(FAKE_AGY)},fullAuto:true}};
    cfg.instances['rev-silent']={driver:'grokAgent',displayName:'Silent reviewer',environment:{FAKE_REVIEW_VERDICT:'none'},config:{cli:acp,fullAuto:true}};
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

/** A goal project with review on: lead, assignee and (optionally) a reviewer; one owner card started. */
async function goalCard(reviewerInstance: string | null) {
  const lead = await makeBot("Nova", "cardlead"), worker = await makeBot("Cole", "verification");
  // No warm-up turn for the lead: a brand new lead's first turns are its
  // room wake and its review, at the same moment (procedure-migration-busy-api.test.ts).
  const reviewer = reviewerInstance ? await makeBot("Reed", reviewerInstance) : null;
  const memberIds = [lead.id, worker.id, ...(reviewer ? [reviewer.id] : [])];
  const group = (await api("POST", "/api/groups", { name: `Review ${made}`, memberIds, setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } } })).body.group;
  expect((await api("PATCH", `/api/groups/${group.id}`, { channelProject: { goal: "Ship the plan" } })).status).toBe(200);
  const goalId = `goal-${group.id}`;
  withDb(db => {
    db.prepare("INSERT INTO project_goals(id,group_id,title,state,review,created_at,started_at) VALUES(?,?,'Ship the plan','working',1,1,1)").run(goalId, group.id);
    db.prepare("UPDATE project_settings SET lead_bot_id=? WHERE group_id=?").run(lead.id, group.id);
  });
  const card = (await api("POST", `/api/groups/${group.id}/board/cards`, { clientId: `review-${made}`, title: "Pricing section", description: "Give our real pricing.", assigneeBotId: worker.id, writes: false })).body.card;
  expect(card).toBeTruthy();
  withDb(db => db.prepare("UPDATE project_work_items SET goal_id=? WHERE id=?").run(goalId, card.id));
  const fresh = (await api("GET", `/api/groups/${group.id}/board`)).body.cards.find((entry: any) => entry.id === card.id);
  expect((await api("PATCH", `/api/groups/${group.id}/board/cards/${card.id}`, { expectedRevision: fresh.revision, action: "start" })).status).toBe(200);
  return { group, card, lead, worker, reviewer };
}
const cardOf = async (groupId: string, cardId: string) => (await api("GET", `/api/groups/${groupId}/board`)).body.cards.find((entry: any) => entry.id === cardId);
const reviewRows = (cardId: string) => withDb(db => db.prepare("SELECT to_bot_id, state, outcome_note FROM room_requests WHERE verb='review' AND work_item_id=?").all(cardId) as Array<{ to_bot_id: string; state: string; outcome_note: string | null }>);

describe.skipIf(process.platform === "win32")("a card in review always ends in a verdict", () => {
  it.each(REVIEWERS)("the %s reviewer's verdict moves the card to done", async (instance) => {
    const { group, card, reviewer } = await goalCard(instance);
    try { await expect.poll(async () => (await cardOf(group.id, card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done"); }
    catch (error) {
      // what the reviewer's run left: its review request and the server's last lines
      const log = readFileSync(fixture.info.logPath, "utf8").split("\n").slice(-40).join("\n");
      const record = (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === reviewer?.id);
      const threads = [group.threadId, record?.threadId, ...(record?.tasks ?? []).map((task: any) => task.threadId)].filter(Boolean);
      const shown: string[] = [];
      for (const threadId of threads) for (const message of (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body?.messages ?? [])
        if (message.kind !== "text" || message.role !== "user") shown.push(`${threadId.slice(0, 8)} ${message.role}/${message.kind} ${String(message.tool?.name ?? "").slice(0, 120)} ${String(message.text ?? "").slice(0, 200)} ${JSON.stringify(message.card ? { title: message.card.title, subtitle: message.card.subtitle, tool: message.card.tool, choices: message.card.choices?.map((choice: any) => choice.label ?? choice) } : "").slice(0, 600)}`);
      throw new Error(`${(error as Error).message}\nreview rows ${JSON.stringify(reviewRows(card.id))}\nmessages:\n${shown.join("\n")}\nserver log tail:\n${log}`);
    }
    expect(reviewRows(card.id)).toEqual([{ to_bot_id: reviewer!.id, state: "done", outcome_note: "pass" }]);
    const room = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages;
    // the room shows the verdict in words, never the block or its nonce
    expect(room.some((message: any) => String(message.text ?? "").includes("<murage-review"))).toBe(false);
    if (instance !== "rev-fuigo-tool") expect(room.some((message: any) => String(message.text ?? "").includes("Verdict: pass."))).toBe(true);
    expect(room.some((message: any) => String(message.tool?.name ?? "").includes(`${reviewer!.name} is reviewing`))).toBe(true);
  }, 90000);

  it("the reviewer's prompt carries the result to judge and the verdict block, and no earlier card of theirs", async () => {
    const { group, card, reviewer } = await goalCard("rev-grok");
    await expect.poll(async () => (await cardOf(group.id, card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done");
    const desk = (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === reviewer!.id).tasks.find((task: any) => task.channelProjectDesk?.groupId === group.id);
    const messages = (await api("GET", `/api/threads/${desk.threadId}/messages`)).body.messages;
    const ask = messages.find((message: any) => message.role === "user")?.text ?? "";
    expect(ask).toContain("Review card");
    expect(ask).toContain("<result-to-review>");
    expect(ask).toMatch(/<murage-review nonce="[a-f0-9]{32}">/);
    expect(ask).not.toContain("<previous-card-result>");
  }, 90000);

  it("a review with no verdict wakes the lead, who decides", async () => {
    const { group, card, reviewer } = await goalCard("rev-silent");
    await expect.poll(async () => (await cardOf(group.id, card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done");
    expect(reviewRows(card.id)).toEqual([{ to_bot_id: reviewer!.id, state: "done", outcome_note: "No verdict given" }]);
    const room = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages;
    expect(room.some((message: any) => String(message.text ?? "").includes("REVIEW_DECIDED"))).toBe(true);
  }, 90000);

  it("the lead reviews when no other member exists", async () => {
    const { group, card, lead } = await goalCard(null);
    await expect.poll(() => reviewRows(card.id).length, { timeout: 60000, interval: 250 }).toBe(1);
    expect(reviewRows(card.id)[0]!.to_bot_id).toBe(lead.id);
    // the fixture lead gives no verdict in its review, then decides on its wake
    try { await expect.poll(async () => (await cardOf(group.id, card.id))?.state, { timeout: 30000, interval: 250 }).toBe("done"); }
    catch (error) {
      const room = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages.map((message: any) => `${message.role}: ${message.text ?? message.tool?.name ?? ""}`.slice(0, 300));
      const rows = withDb(db => [...db.prepare("SELECT verb, state, to_bot_id, outcome_note, refusal, admission_key, target_thread_id, priority, created_at, dispatched_at FROM room_requests WHERE group_id=? ORDER BY created_at").all(group.id),
        ...db.prepare("SELECT state, state_reason, no_progress, lead_wakes FROM project_goals WHERE group_id=?").all(group.id), ...db.prepare("SELECT run_state, lead_bot_id FROM project_settings WHERE group_id=?").all(group.id)]);
      const strip = (await api("GET", `/api/groups/${group.id}/project`)).body;
      const bots = (await api("GET", "/api/bots?messages=0")).body.bots;
      const leadBot = bots.find((bot: any) => bot.id === lead.id);
      const groupState = (await api("GET", "/api/bots?messages=0")).body.groups.find((entry: any) => entry.id === group.id);
      const threads = [leadBot.threadId, ...(leadBot.tasks ?? []).map((task: any) => task.threadId)];
      const lines: string[] = [];
      for (const thread of threads) for (const message of (await api("GET", `/api/threads/${thread}/messages`)).body.messages ?? []) lines.push(`${thread.slice(0, 6)} ${message.role}/${message.kind}: ${JSON.stringify(message.text ?? message.tool ?? message.error ?? "").slice(0, 400)}`);
      const log = lines.join("\n");
      throw new Error(`${String(error)}\n${JSON.stringify(rows, null, 1)}\nBUSY ${JSON.stringify({ busy: groupState?.busyBotId, busyThread: groupState?.busyThreadId })}\n${JSON.stringify(strip).slice(0, 300)}\n${room.join("\n")}\nLOG\n${log}`);
    }
  }, 90000);
});
