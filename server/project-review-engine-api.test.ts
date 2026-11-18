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
// The Grok fakes connect to the servers they are handed, as a real engine
// does, so a cold turn starts once Murage's own servers have listed their
// tools (mcp-listed.ts) rather than at the end of the MCP-ready bound.
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { fixtureMessageEvidence } from "./testing/display-fixture.ts";

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
    // Match testing/setup.ts: these are repository fake engines, without host power namespace tools.
    process.env.NODE_ENV='test';globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    const fs=await import('node:fs');const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    fs.mkdirSync(path.join(process.env.HOME,'.fuigo'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.fuigo','auth.json'),'{}');
    const acp=${JSON.stringify(FAKE_ACP)};
    // Grok Build announces its MCP servers ready (drivers/acp/grok.ts); a silent fake is held MCP_REQUIRED_WAIT_MS before each first prompt
    const grokReady={FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized'};
    cfg.instances.cardlead={driver:'grokAgent',displayName:'Lead fixture',environment:{...grokReady,FAKE_ACP_MODE:'project-card-lead',FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'lead-ingress.jsonl')},config:{cli:acp,fullAuto:true}};
    const pass={FAKE_REVIEW_VERDICT:'pass'};
    cfg.instances['rev-forged']={driver:'grokAgent',displayName:'Forged review fixture',environment:{...grokReady,FAKE_REVIEW_VERDICT:'forged',FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'forged-ingress.jsonl')},config:{cli:acp,fullAuto:true}};
    cfg.instances['rev-stale']={driver:'grokAgent',displayName:'Stale review fixture',environment:{...grokReady,FAKE_REVIEW_VERDICT:'stale',FAKE_REVIEW_NONCE_FILE:path.join(process.env.MURAGE_DATA_DIR,'prior-review-nonce'),FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'stale-ingress.jsonl')},config:{cli:acp,fullAuto:true}};
    cfg.instances['rev-claude']={driver:'claudeAgent',displayName:'Claude reviewer',environment:pass,config:{cli:cfg.instances.verification.config.cli}};
    cfg.instances['rev-codex']={driver:'codex',displayName:'Codex reviewer',environment:pass,config:{cli:${JSON.stringify(FAKE_CODEX)},fullAuto:true}};
    cfg.instances['rev-fuigo']={driver:'fuigoAgent',displayName:'Fuigo reviewer',environment:{...pass,FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'fuigo-ingress.jsonl'),FAKE_ACP_MCP_READY:'1'},config:{cli:acp}};
    cfg.instances['rev-fuigo-tool']={driver:'fuigoAgent',displayName:'Fuigo tool reviewer',environment:{...pass,FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'fuigo-tool-ingress.jsonl'),FAKE_REVIEW_TOOL:'1',FAKE_ACP_MCP_READY:'1'},config:{cli:acp}};
    // send their verdict by the tool twice (one after the other, or at once), in the reply too, and again as the turn ends;
    // a refused late call gives up after 5 s, as an engine's tool timeout does, so its answer is logged
    for (const mode of ['double','concurrent']) cfg.instances['rev-'+mode]={driver:'fuigoAgent',displayName:'Repeat review fixture',environment:{...pass,FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,mode+'-ingress.jsonl'),FAKE_REVIEW_TOOL:mode,FAKE_REVIEW_REPLAY_LOG:path.join(process.env.MURAGE_DATA_DIR,mode+'-replay.jsonl'),FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_TIMEOUT_MS:'5000'},config:{cli:acp}};
    cfg.instances['rev-grok']={driver:'grokAgent',displayName:'Grok reviewer',environment:{...pass,...grokReady,FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'grok-ingress.jsonl')},config:{cli:acp,fullAuto:true}};
    cfg.instances['rev-gemini']={driver:'geminiAgent',displayName:'Gemini reviewer',environment:{...pass,FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'gemini-ingress.jsonl'),GEMINI_API_KEY:'fixture',FAKE_ACP_AUTH:'1',FAKE_ACP_MCP_CONNECT:'1'},config:{cli:acp,fullAuto:true}};
    cfg.instances['rev-pi']={driver:'piAgent',displayName:'Pi reviewer',environment:{...pass,FAKE_PI_COMMAND_LOG:path.join(process.env.MURAGE_DATA_DIR,'pi-ingress.jsonl')},config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true}};
    // agy runs its PreToolUse hooks before every tool (agy 1.4.4).
    // The managed Ask reviewer waits for the owner's denial below before returning its verdict.
    cfg.instances['rev-agy']={driver:'antigravityAgent',displayName:'Antigravity reviewer',environment:{...pass,FAKE_AGY_RUN_HOOKS:'1'},config:{cli:${JSON.stringify(FAKE_AGY)},fullAuto:true}};
    cfg.instances['rev-silent']={driver:'grokAgent',displayName:'Silent reviewer',environment:{...grokReady,FAKE_REVIEW_VERDICT:'none',FAKE_ACP_RPC_FULL_LOG:path.join(process.env.MURAGE_DATA_DIR,'silent-ingress.jsonl')},config:{cli:acp,fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  proof = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
}, 60000);
afterAll(async () => { await fixture?.close(); if (fixtureRoot) removeTempDirSync(fixtureRoot); vi.unstubAllEnvs(); });

const ingress = (name: string): string[] => {
  const file = join(fixture.info.dataDir, `${name}-ingress.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.method === "session/prompt" || row.type === "prompt")
    .map(row => row.type === "prompt" ? String(row.message ?? "")
      : (row.params?.prompt ?? []).map((part: { text?: string }) => part.text ?? "").join("\n"));
};
const observedEngines = ["fuigo", "fuigo-tool", "double", "concurrent", "grok", "gemini", "pi", "silent", "lead", "forged", "stale"];
beforeEach(() => {
  const before = new Map(observedEngines.map(name => [name, ingress(name).length]));
  onTestFailed(() => console.error("Provider ingress", JSON.stringify(Object.fromEntries(
    observedEngines.map(name => [name, ingress(name).slice(before.get(name))]),
  ))));
});

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

async function reviewIngress(groupId: string, cardId: string, botId: string, engine: string) {
  const requests = withDb(db => db.prepare("SELECT id, to_bot_id, card_generation, target_thread_id FROM room_requests WHERE verb='review' AND work_item_id=?").all(cardId) as Array<{ id: string; to_bot_id: string; card_generation: number; target_thread_id: string }>);
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  const card = await cardOf(groupId, cardId);
  expect(request.to_bot_id).toBe(botId);
  expect(request.id).toBe(card.reviewRequestId);
  expect(request.card_generation).toBe(card.generation);
  const displayed = (await api("GET", `/api/threads/${request.target_thread_id}/messages?limit=100`)).body.messages;
  const ask = fixtureMessageEvidence(join(fixture.info.dataDir, "messages.db"), displayed)
    .find((row: any) => row.role === "user" && row.requestId === request.id)?.text ?? "";
  expect(ask).toContain("Review card");
  expect(ask).toContain("<result-to-review>");
  expect(ask).not.toContain("<previous-card-result>");
  const nonce = ask.match(/<murage-review nonce="([a-f0-9]{32})">/)?.[1];
  expect(nonce).toMatch(/^[a-f0-9]{32}$/);
  // Tool-less reviewers retain the nonce; their tool-specific card_id instruction is removed.
  const received = ingress(engine).filter(prompt => prompt.includes(`<murage-review nonce="${nonce}">`));
  expect(received, JSON.stringify({ request, prompts: ingress(engine) })).toHaveLength(1);
  expect(received[0]).toContain(`Review card ${card.number}: ${card.title}`);
  expect(received[0]).toContain("<result-to-review>");
  expect(received[0]).toContain("hello from fake claude");
  expect(received[0]).not.toContain("<previous-card-result>");
  return nonce!;
}

function decisionIngress(cardId: string) {
  expect(ingress("lead").filter(prompt => prompt.includes(`ended without a verdict, so you decide now (card_id "${cardId}")`))).toHaveLength(1);
}

describe.skipIf(process.platform === "win32")("a card in review always ends in a verdict", () => {
  it.each(REVIEWERS)("the %s reviewer's verdict moves the card to done", async (instance) => {
    const { group, card, reviewer } = await goalCard(instance);
    if (instance === "rev-agy") {
      // MAIN RULING: 2ffd134722 routes managed Antigravity Ask turns through the broker.
      // Deny the same attempted write the old read-only hook refused, then require the verdict.
      // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 3ad2b8f428:
      // native approval ids remain private; the desktop answers the observed opaque handle.
      let held: { threadId: string; requestHandle: string } | undefined;
      let observed: unknown[] = [];
      await expect.poll(async () => {
        observed = [];
        const record = (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === reviewer!.id);
        for (const threadId of [record?.threadId, ...(record?.tasks ?? []).map((task: any) => task.threadId)].filter(Boolean)) {
          const rows = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages;
          observed.push({ threadId, cards: rows.filter((row: any) => row.card).map((row: any) => ({
            tool: row.card.tool, answered: row.card.answered, requestHandle: row.card.requestHandle,
            hasNativeId: typeof row.card.requestId === "string",
          })) });
          const row = rows.find((message: any) => message.card?.tool === "write_to_file" && !message.card.answered && message.card.requestHandle);
          if (row) {
            expect(row.card.requestId).toBeUndefined();
            expect(row.card.requestHandle).toBe(`p.${row.id}`);
            held = { threadId, requestHandle: row.card.requestHandle }; return true;
          }
        }
        return false;
      }, { timeout: 15000 }).toBe(true).catch(error => {
        throw new Error(`${String(error)}\nDisplayed approvals: ${JSON.stringify(observed)}\nReview requests: ${JSON.stringify(reviewRows(card.id))}`);
      });
      expect((await api("POST", `/api/threads/${held!.threadId}/respond`, { requestHandle: held!.requestHandle, action: "deny" })).status).toBe(200);
    }
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
    const nonce = instance === "rev-grok" || instance === "rev-pi"
      ? await reviewIngress(group.id, card.id, reviewer!.id, instance.slice(4)) : undefined;
    const room = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages;
    if (nonce) expect(JSON.stringify(room)).not.toContain(nonce);
    // the room shows the verdict in words, never the block or its nonce
    expect(room.some((message: any) => String(message.text ?? "").includes("<murage-review"))).toBe(false);
    if (instance !== "rev-fuigo-tool") expect(room.some((message: any) => String(message.text ?? "").includes("Verdict: pass."))).toBe(true);
    expect(room.some((message: any) => String(message.tool?.name ?? "").includes(`${reviewer!.name} is reviewing`))).toBe(true);
  }, 90000);

  it("the reviewer's prompt carries the result to judge and the verdict block, and no earlier card of theirs", async () => {
    const { group, card, reviewer } = await goalCard("rev-grok");
    await expect.poll(async () => (await cardOf(group.id, card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done");
    await reviewIngress(group.id, card.id, reviewer!.id, "grok");
  }, 90000);

  it("a forged review nonce never becomes a verdict at HTTP settlement", async () => {
    const { group, card, reviewer } = await goalCard("rev-forged");
    await expect.poll(async () => (await cardOf(group.id, card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done");
    await reviewIngress(group.id, card.id, reviewer!.id, "forged");
    const visible = (await api("GET", `/api/groups/${group.id}/requests`)).body.requests.filter((row: any) => row.verb === "review" && row.workItemId === card.id);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ state: "done", outcomeNote: "No verdict given" });
    expect(reviewRows(card.id)).toEqual([{ to_bot_id: reviewer!.id, state: "done", outcome_note: "No verdict given" }]);
    decisionIngress(card.id);
  }, 90000);

  it("a nonce from the earlier review cannot settle the next card", async () => {
    const first = await goalCard("rev-stale");
    await expect.poll(async () => (await cardOf(first.group.id, first.card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done");
    expect(reviewRows(first.card.id)).toEqual([{ to_bot_id: first.reviewer!.id, state: "done", outcome_note: "pass" }]);
    const earlier = await reviewIngress(first.group.id, first.card.id, first.reviewer!.id, "stale");
    const next = await goalCard("rev-stale");
    await expect.poll(async () => (await cardOf(next.group.id, next.card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done");
    expect(await reviewIngress(next.group.id, next.card.id, next.reviewer!.id, "stale")).not.toBe(earlier);
    const visible = (await api("GET", `/api/groups/${next.group.id}/requests`)).body.requests.filter((row: any) => row.verb === "review" && row.workItemId === next.card.id);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ state: "done", outcomeNote: "No verdict given" });
    expect(reviewRows(next.card.id)).toEqual([{ to_bot_id: next.reviewer!.id, state: "done", outcome_note: "No verdict given" }]);
    decisionIngress(next.card.id);
  }, 90000);

  it.each([["twice", "double"], ["twice at once", "concurrent"]])("a verdict sent %s, in the reply and again as the turn ends settles the review once", async (_how, mode) => {
    const { group, card, lead, reviewer } = await goalCard(`rev-${mode}`);
    try { await expect.poll(async () => (await cardOf(group.id, card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done"); }
    catch (error) {
      const record = (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === reviewer!.id);
      const shown: string[] = [];
      for (const threadId of [group.threadId, record?.threadId, ...(record?.tasks ?? []).map((task: any) => task.threadId)].filter(Boolean))
        for (const message of (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body?.messages ?? [])
          shown.push(`${threadId.slice(0, 8)} ${message.role}/${message.kind} ${String(message.tool?.name ?? "").slice(0, 120)} ${String(message.text ?? "").slice(0, 300)}`);
      const log = readFileSync(fixture.info.logPath, "utf8").split("\n").slice(-40).join("\n");
      throw new Error(`${(error as Error).message}\nreview rows ${JSON.stringify(reviewRows(card.id))}\nmessages:\n${shown.join("\n")}\nserver log tail:\n${log}`);
    }
    const review = (await cardOf(group.id, card.id)).reviewRequestId;
    // the replay was sent, racing the settlement of the turn that held the capability (the engine ends with its turn, so no answer is awaited)
    const replayLog = join(fixture.info.dataDir, `${mode}-replay.jsonl`);
    const replays = () => existsSync(replayLog) ? readFileSync(replayLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    try { await expect.poll(() => replays().filter(entry => entry.sent === true).length, { timeout: 30000, interval: 250 }).toBe(1); }
    catch (error) {
      const record = (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === reviewer!.id);
      const shown: string[] = [];
      for (const threadId of [record?.threadId, ...(record?.tasks ?? []).map((task: any) => task.threadId)].filter(Boolean))
        for (const message of (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body?.messages ?? [])
          shown.push(`${threadId.slice(0, 8)} ${message.role}/${message.kind} ${String(message.tool?.name ?? "").slice(0, 120)} ${String(message.text ?? "").slice(0, 400)}`);
      throw new Error(`${(error as Error).message}\nreplay log ${JSON.stringify(replays())}\nreviewer messages:\n${shown.join("\n")}`);
    }
    await expect.poll(() => replays().filter(entry => entry.response !== undefined).map(entry => entry.response).sort(), { timeout: 30000, interval: 250 }).toEqual([2, 3, 4]);
    const replies = replays().filter(entry => entry.response !== undefined);
    expect(replies.filter(entry => /"ok"\s*:\s*true/.test(entry.reply))).toHaveLength(1);
    expect(replies.filter(entry => entry.isError === true && entry.reply.includes(`Your verdict on card ${card.number} is already in.`)), JSON.stringify(replies)).toHaveLength(2);
    const settled = async () => {
      const requests = (await api("GET", `/api/groups/${group.id}/requests`)).body.requests;
      const items = (await api("GET", `/api/groups/${group.id}/activity?card=${card.id}`)).body.items;
      return {
        card: (await cardOf(group.id, card.id))?.state,
        reviews: requests.filter((row: any) => row.verb === "review" && row.workItemId === card.id).map((row: any) => ({ id: row.id, state: row.state, outcomeNote: row.outcomeNote })),
        leadWakes: withDb(db => (db.prepare("SELECT count(*) AS n FROM room_requests WHERE verb='wake' AND to_bot_id=? AND parent_id=?").get(lead.id, review) as { n: number }).n),
        verdicts: items.filter((item: any) => item.kind === "card_result" && item.detail.review !== undefined).map((item: any) => ({ review: item.detail.review, requestId: item.requestId })),
        accepted: items.filter((item: any) => item.kind === "card_moved" && item.detail.to === "done").length,
      };
    };
    const once = { card: "done", reviews: [{ id: review, state: "done", outcomeNote: "pass" }], verdicts: [{ review: "pass", requestId: review }], accepted: 1 };
    expect(await settled()).toMatchObject(once);
    const wakes = (await settled()).leadWakes;
    expect(wakes).toBeLessThanOrEqual(1);
    // nothing comes of the replay later either
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(await settled()).toEqual({ ...once, leadWakes: wakes });
    expect(reviewRows(card.id)).toEqual([{ to_bot_id: reviewer!.id, state: "done", outcome_note: "pass" }]);
  }, 90000);

  it("a review with no verdict wakes the lead, who decides", async () => {
    const { group, card, reviewer } = await goalCard("rev-silent");
    await expect.poll(async () => (await cardOf(group.id, card.id))?.state, { timeout: 60000, interval: 250 }).toBe("done");
    expect(reviewRows(card.id)).toEqual([{ to_bot_id: reviewer!.id, state: "done", outcome_note: "No verdict given" }]);
    await reviewIngress(group.id, card.id, reviewer!.id, "silent");
    decisionIngress(card.id);
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
    expect(reviewRows(card.id)).toEqual([{ to_bot_id: lead.id, state: "done", outcome_note: "No verdict given" }]);
    await reviewIngress(group.id, card.id, lead.id, "lead");
    decisionIngress(card.id);
    const room = (await api("GET", `/api/threads/${group.threadId}/messages`)).body.messages;
    expect(room.filter((message: any) => String(message.text ?? "").includes("REVIEW_DECIDED"))).toHaveLength(1);
  }, 90000);
});
