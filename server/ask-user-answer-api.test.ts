// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q1, Q1b, Q2 (1.0.4, items 165 and 174) end to end through the real server: a bot's question card (the agents server's
// ask_user, or a ```murage-question fence from an engine with no tools) is answered by the owner's NEXT MESSAGE. The card and
// the owner send it becomes are claimed in one transaction; the answer is steered only into the turn that asked, on an engine
// that can be steered, and otherwise waits in the queue like any owner message; a crash in the drain delivers it at most once.
// The engine is an in-process fixture (server/testing/fake-ask-driver.ts) in three shapes: steerable with tools (Claude,
// Fuigo), tools without steering (Codex, Pi, other ACP) and text only (no tools: the http and headless text routes).
// Fault points are load hooks on the real SendStore (a refused accept; a kill before or after the drain's dispatch marker; a
// kill right after Stop marks the waiting sends) and on beginInternalTurn (a turn forced to a not-owner audience).
// Each case names the failure it prevents; each fails without the QW change (no ask_user route, no fence fold, or the old
// late-answer flow that sent first and recorded second).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer;
let headers: Record<string, string> = {};

const CHANNELS = {
  questions: [{
    question: "Which channels should I post the launch note to?",
    options: [{ label: "Email" }, { label: "Slack" }, { label: "SMS" }, { label: "Discord" }],
    multiSelect: true,
  }],
};
const TWO_TICKED = [{ id: "q1", selected: ["Email", "Slack"] }];
const ANSWER_TEXT = "Email, Slack";
const LATE_TEXT = "Q: Which channels should I post the launch note to?\nA: Email, Slack";
const fenceReply = (body: unknown, before = "Before I post it:") => `${before}\n\n\`\`\`murage-question\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}\n\`\`\`\n`;

const askDir = () => join(fixture.info.dataDir, "ask");
const api = async (method: string, path: string, body?: unknown, proven = true) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(proven ? headers : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const connect = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const idle = async (id: string) => { await expect.poll(async () => (await botState(id))?.busy, { timeout: 20000 }).toBe(false); };
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const questionCards = async (threadId: string) => (await messages(threadId)).filter((message) => message.kind === "options" && message.card?.questions?.length);
const cardById = async (threadId: string, id: string) => (await messages(threadId)).find((message) => message.id === id);
type DumpRow = { turnId: string; threadId: string; text: string; steer?: true };
const dump = (): DumpRow[] => { const path = join(askDir(), "dump.jsonl"); return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; };
const turnsWith = (threadId: string, words: string) => dump().filter((row) => !row.steer && row.threadId === threadId && row.text.includes(words));
const steersOn = (threadId: string) => dump().filter((row) => row.steer && row.threadId === threadId);
const sendRows = (threadId: string) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT send_id AS sendId, status, notice, stopped FROM owner_sends WHERE thread_id=? AND send_id LIKE 'ask-%' ORDER BY seq").all(threadId) as Array<{ sendId: string; status: string; notice: string | null; stopped: number }>; }
  finally { db.close(); }
};
const arm = (name: string) => writeFileSync(join(askDir(), name), "");
const release = () => writeFileSync(join(askDir(), "release"), "");
const reset = () => { for (const name of ["hold", "agents-env.json", "live", "release", "reply.txt", "fail-accept", "fail-queue", "crash-before-dispatch", "crash-after-dispatch", "crash-after-stop", "not-owner.json"]) rmSync(join(askDir(), name), { force: true }); };
const roomSendRows = (threadId: string) => {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return db.prepare("SELECT send_id AS sendId, kind, owner_id AS ownerId, responder_id AS responderId, status FROM owner_sends WHERE thread_id=? AND send_id LIKE 'ask-%' ORDER BY seq").all(threadId) as Array<{ sendId: string; kind: string; ownerId: string; responderId: string | null; status: string }>; }
  finally { db.close(); }
};
const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createBot = async (name: string, instanceId: "steers" | "queues" | "text") => {
  const created = await api("POST", "/api/bots", { name, modelSelection: { instanceId, model: "ask-1" } });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
};
/** A held turn is live: its provider turn id and the agents env it was handed. */
const liveTurn = async () => {
  await expect.poll(() => existsSync(join(askDir(), "live")), { timeout: 15000 }).toBe(true);
  const turnId = readFileSync(join(askDir(), "live"), "utf8");
  await expect.poll(() => existsSync(join(askDir(), "agents-env.json")), { timeout: 15000 }).toBe(true);
  return { turnId, env: JSON.parse(readFileSync(join(askDir(), "agents-env.json"), "utf8")) as Record<string, string> };
};
const askUser = async (token: string, body: unknown) => {
  const response = await fetch(`${fixture.info.url}/api/internal/ask-user`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
/** The owner's bot asks the four-channel question from a turn that stays live. */
const openCard = async (bot: { id: string; threadId: string }, label: string) => {
  reset();
  arm("hold");
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `__hold__ ${label}` })).status).toBe(202);
  const { turnId, env } = await liveTurn();
  expect(env.MURAGE_THREAD_ID).toBe(bot.threadId);
  const asked = await askUser(env.MURAGE_COMMS_TOKEN!, CHANNELS);
  expect(asked.status).toBe(201);
  expect(asked.body.text).toBe("A question card is now visible. End this turn; the answer arrives as the owner's next message.");
  const card = await cardById(bot.threadId, asked.body.messageId);
  return { turnId, card, requestId: card.card.requestId as string, sendId: `ask-${card.id}` };
};
const respond = (threadId: string, body: Record<string, unknown>) => api("POST", `/api/threads/${threadId}/respond`, body);
const answer = (threadId: string, requestId: string, extra: Record<string, unknown> = {}) => respond(threadId, { requestId, behavior: "answer", answers: TWO_TICKED, ...extra });
/** Kill-point restarts: wait for the fixture's own SIGKILL, then boot the same data folder. */
const restartAfterKill = async () => {
  await expect.poll(() => fixture.child.signalCode !== null || fixture.child.exitCode !== null, { timeout: 15000 }).toBe(true);
  await fixture.restart();
  await connect();
};

posixOnly("a bot's question is answered by the owner's next message (QW Q1, Q1b, Q2)", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const dataDir=process.env.MURAGE_DATA_DIR;
      const askDir=path.join(dataDir,'ask');fs.mkdirSync(askDir,{recursive:true});
      const { registerHooks } = await import('node:module');
      // Fault points on the real send store, each one-shot (the file is taken when it fires).
      const sendStorePatch = \`
;{const __fs=process.getBuiltinModule('node:fs');const __dir=process.env.MURAGE_DATA_DIR+'/ask/';
const __armed=(name)=>{if(!__fs.existsSync(__dir+name))return false;__fs.rmSync(__dir+name,{force:true});return true;};
const __accept=SendStore.prototype.accept;
SendStore.prototype.accept=function(input){if(String(input?.sendId??'').startsWith('ask-')&&__armed('fail-accept'))throw new Error('fixture: the send could not be recorded');return __accept.call(this,input);};
const __queue=SendStore.prototype.queue;
SendStore.prototype.queue=function(...args){if(__armed('fail-queue'))throw new Error('fixture: the answer could not take its place in line');return __queue.apply(this,args);};
const __many=SendStore.prototype.markDispatchedMany;
SendStore.prototype.markDispatchedMany=function(seqs){if(__armed('crash-before-dispatch'))process.kill(process.pid,'SIGKILL');const out=__many.call(this,seqs);if(__armed('crash-after-dispatch'))process.kill(process.pid,'SIGKILL');return out;};
const __stopped=SendStore.prototype.markStopped;
SendStore.prototype.markStopped=function(threadId){const out=__stopped.call(this,threadId);if(__armed('crash-after-stop'))process.kill(process.pid,'SIGKILL');return out;};}
\`;
      // A turn on a listed thread is a not-owner audience (as a channel person's, or a chain unproven words started), attended.
      const anchor='internalTurnOwners.set(threadId, { botId, generation, depth, skillAuthoring, eventId, notOwnerAudience, ownerAudience,';
      registerHooks({ load(url, context, nextLoad) {
        if (url.endsWith('/server/send-store.ts')) { const loaded=nextLoad(url, context); return { ...loaded, source: String(loaded.source)+sendStorePatch }; }
        if (url.endsWith('/server/index.ts')) {
          const loaded=nextLoad(url, context); const source=String(loaded.source);
          if (!source.includes(anchor)) throw new Error('not-owner fixture anchor changed');
          return { ...loaded, source: source.replace(anchor, anchor.replace('notOwnerAudience,', 'notOwnerAudience: notOwnerAudience || __fixtureNotOwner(threadId),'))
            + "\\nfunction __fixtureNotOwner(threadId){try{return JSON.parse(process.getBuiltinModule('node:fs').readFileSync(process.env.MURAGE_DATA_DIR+'/ask/not-owner.json','utf8')).includes(threadId);}catch{return false;}}\\n" };
        }
        return nextLoad(url, context);
      } });
      // the drivers import the send store: registered after the hooks, so the store they load is the patched one
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "drivers", "builtIn.ts")).href)});
      const { makeAskDriver } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-ask-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeAskDriver());
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.steers={driver:'fakeAsk',displayName:'Steers',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'1',FAKE_ASK_STEER:'1'}};
      cfg.instances.queues={driver:'fakeAsk',displayName:'Queues',environment:{FAKE_ASK_DIR:askDir,FAKE_ASK_TOOLS:'1'}};
      cfg.instances.text={driver:'fakeAsk',displayName:'Text only',environment:{FAKE_ASK_DIR:askDir}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    mkdirSync(join(fixture.info.dataDir, "ask"), { recursive: true });
    await connect();
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("ask_user is refused for an unattended turn and a not-owner audience; the owner's own turn opens the card", async () => {
    // the owner's turn: the card is the existing options row, marked as answered by a send, naming the turn that asked
    const owner = await createBot("Ask owner turn", "steers");
    const { turnId, card } = await openCard(owner, "owner");
    expect(card).toMatchObject({ role: "bot", kind: "options", card: { answerAsSend: true, turnId, subtitle: CHANNELS.questions[0]!.question } });
    expect(card.card.requestId).toMatch(/^ask-/);
    expect(card.card.questions[0]).toMatchObject({ id: "q1", multiSelect: true, options: CHANNELS.questions[0]!.options });
    release(); await idle(owner.id);

    // words nobody proved are the owner's run unattended: no card asks the owner from that turn
    const unattended = await createBot("Ask unattended", "steers");
    reset();
    arm("hold");
    expect((await api("POST", `/api/bots/${unattended.id}/messages`, { threadId: unattended.threadId, text: "__hold__ unproven" }, false)).status).toBe(202);
    const unprovenTurn = await liveTurn();
    expect(await askUser(unprovenTurn.env.MURAGE_COMMS_TOKEN!, CHANNELS)).toEqual({ status: 403, body: { error: "Ask the owner from an owner conversation." } });
    expect(await questionCards(unattended.threadId)).toEqual([]);
    release(); await idle(unattended.id);

    // a not-owner audience on an attended thread
    const notOwner = await createBot("Ask not owner", "steers");
    reset();
    writeFileSync(join(askDir(), "not-owner.json"), JSON.stringify([notOwner.threadId]));
    arm("hold");
    expect((await api("POST", `/api/bots/${notOwner.id}/messages`, { threadId: notOwner.threadId, text: "__hold__ not owner" })).status).toBe(202);
    const notOwnerTurn = await liveTurn();
    expect((await askUser(notOwnerTurn.env.MURAGE_COMMS_TOKEN!, CHANNELS)).status).toBe(403);
    expect(await questionCards(notOwner.threadId)).toEqual([]);
    rmSync(join(askDir(), "not-owner.json"), { force: true });
    release(); await idle(notOwner.id);
  }, 120000);

  /** A room whose default responder is `other`; `member` is the one asked to hold a turn, and asks. */
  const roomAsk = async (label: string) => {
    const member = await createBot(`Ask room member ${label}`, "steers"), other = await createBot(`Ask room other ${label}`, "steers");
    const room = (await api("POST", "/api/groups", { name: `Ask room ${label}`, memberIds: [member.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: other.id } } })).body.group as { id: string; threadId: string };
    reset();
    arm("hold");
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: `__hold__ room ${label}`, responderId: member.id, sendId: `room-hold-${label}-${Date.now()}-pad` })).status).toBe(202);
    const { turnId, env } = await liveTurn();
    expect(env).toMatchObject({ MURAGE_THREAD_ID: room.threadId, MURAGE_BOT_ID: member.id });
    const asked = await askUser(env.MURAGE_COMMS_TOKEN!, CHANNELS);
    expect(asked.status).toBe(201);
    const card = await cardById(room.threadId, asked.body.messageId);
    return { member, other, room, turnId, card, requestId: card.card.requestId as string, sendId: `ask-${card.id}` };
  };

  it("B-165 rooms: a member's ask_user opens the room card stamped with that member; the answer is ONE room message to that member, queued, never steered into the live turn", async () => {
    const { member, room, turnId, card, requestId, sendId } = await roomAsk("answer");
    // the same options row a member's engine question opens in a room: who asked, answered by a send, the turn it was asked in
    expect(card).toMatchObject({ role: "bot", kind: "options", from: { botId: member.id }, card: { answerAsSend: true, turnId, subtitle: CHANNELS.questions[0]!.question } });
    // a double press from two clients at once, while the asking turn is still live on an engine that could be steered
    const [first, second] = await Promise.all([answer(room.threadId, requestId), answer(room.threadId, requestId)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first, second].find((reply) => reply.status === 409)!.body.code).toBe("already_settled");
    expect([first, second].find((reply) => reply.status === 200)!.body).toMatchObject({ ok: true, outcome: "answered", queued: true, text: ANSWER_TEXT });
    // a retry of the same press meets the same row
    expect((await answer(room.threadId, requestId)).body.code).toBe("already_settled");
    expect(roomSendRows(room.threadId)).toEqual([{ sendId, kind: "group", ownerId: room.id, responderId: member.id, status: "queued" }]);
    expect((await cardById(room.threadId, card.id)).card).toMatchObject({ answered: "answer", sendId, answers: TWO_TICKED });
    await quiet(400);
    expect(steersOn(room.threadId)).toEqual([]);
    expect(turnsWith(room.threadId, ANSWER_TEXT)).toEqual([]);
    // the asking turn ends: the answer starts the next room turn, the member who asked answering, once
    rmSync(join(askDir(), "agents-env.json"), { force: true });
    release();
    await expect.poll(() => turnsWith(room.threadId, ANSWER_TEXT).length, { timeout: 20000 }).toBe(1);
    await idle(member.id);
    expect(JSON.parse(readFileSync(join(askDir(), "agents-env.json"), "utf8")).MURAGE_BOT_ID).toBe(member.id);
    expect(roomSendRows(room.threadId)).toEqual([expect.objectContaining({ sendId, status: "started" })]);
    const line = (await messages(room.threadId)).find((message) => message.role === "user" && message.sendId === sendId);
    expect(line).toMatchObject({ kind: "text", text: ANSWER_TEXT });
    await quiet(500);
    expect(turnsWith(room.threadId, ANSWER_TEXT)).toHaveLength(1);
    expect(steersOn(room.threadId)).toEqual([]);
  }, 120000);

  it("rooms: a late answer to an expired room card takes the same claim (sent as a message, once); widgets stay refused there", async () => {
    const { member, room, card, requestId, sendId, turnId } = await roomAsk("late");
    expect(turnId).toBeTruthy();
    const token = JSON.parse(readFileSync(join(askDir(), "agents-env.json"), "utf8")).MURAGE_COMMS_TOKEN as string;
    const widget = await fetch(`${fixture.info.url}/api/internal/show-widget`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ widget: { type: "Card", title: "x", children: [] } }) });
    expect(widget.status).toBe(403);
    // a restart: the boot sweep expires the open card
    await fixture.restart();
    await connect();
    await expect.poll(async () => (await cardById(room.threadId, card.id)).card.expired, { timeout: 20000 }).toBe(true);
    expect((await answer(room.threadId, requestId)).body.code).toBe("question_expired");
    const late = await answer(room.threadId, requestId, { sentAsMessage: true });
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ ok: true, outcome: "sent-as-message", text: LATE_TEXT });
    expect((await answer(room.threadId, requestId, { sentAsMessage: true })).body.code).toBe("already_settled");
    expect((await cardById(room.threadId, card.id)).card).toMatchObject({ expired: true, sentAsMessage: true, sendId });
    await expect.poll(() => turnsWith(room.threadId, "A: Email, Slack").length, { timeout: 20000 }).toBe(1);
    await idle(member.id);
    expect(roomSendRows(room.threadId)).toEqual([expect.objectContaining({ sendId, kind: "group", responderId: member.id, status: "started" })]);
    expect(steersOn(room.threadId)).toEqual([]);
  }, 120000);

  it("an answer whose send cannot start after the claim is told as held (409 answer_held), not as answered: its words wait as a chip", async () => {
    const bot = await createBot("Ask held", "queues");
    const { card, requestId, sendId } = await openCard(bot, "held");
    release(); await idle(bot.id);
    arm("fail-queue");
    const held = await answer(bot.threadId, requestId);
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ ok: false, code: "answer_held", outcome: "held", noticeCode: "refused" });
    expect(held.body.outcome).not.toBe("answered");
    // the card is settled (one claim), the words are the refused chip (Send again / Dismiss), and nothing ran
    expect((await cardById(bot.threadId, card.id)).card).toMatchObject({ answered: "answer", sendId });
    expect(sendRows(bot.threadId)).toEqual([expect.objectContaining({ sendId, status: "refused", notice: "refused" })]);
    expect((await answer(bot.threadId, requestId)).body.code).toBe("already_settled");
    await quiet(800);
    expect(turnsWith(bot.threadId, ANSWER_TEXT)).toEqual([]);
  }, 60000);

  it("B-165: the model ends its turn, the owner ticks two of four channels, and the bot's next turn gets both; one press, one send, whatever the clients do", async () => {
    const bot = await createBot("Ask channels", "queues");
    const { card, requestId, sendId } = await openCard(bot, "channels");
    release(); await idle(bot.id);

    // a failure inside the claim (the send could not be recorded) changes neither the card nor the queue
    arm("fail-accept");
    const failed = await answer(bot.threadId, requestId);
    expect(failed.status).toBe(503);
    expect((await cardById(bot.threadId, card.id)).card).not.toHaveProperty("answered");
    expect((await cardById(bot.threadId, card.id)).card).not.toHaveProperty("sendId");
    expect(sendRows(bot.threadId)).toEqual([]);

    // two clients press at once (the conversation's route and the bot's route): one answer, the other is told it is settled
    const [first, second] = await Promise.all([
      answer(bot.threadId, requestId),
      api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "answer", answers: TWO_TICKED }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first, second].find((reply) => reply.status === 409)!.body.code).toBe("already_settled");
    expect([first, second].find((reply) => reply.status === 200)!.body).toMatchObject({ ok: true, outcome: "answered", text: ANSWER_TEXT });
    // a retry of the same press meets the same row
    expect((await answer(bot.threadId, requestId)).body.code).toBe("already_settled");
    expect(sendRows(bot.threadId).map((row) => row.sendId)).toEqual([sendId]);
    expect((await cardById(bot.threadId, card.id)).card).toMatchObject({ answered: "answer", sendId, answers: TWO_TICKED });

    // the turn had ended: the queued answer starts the next turn as an ordinary owner message, once
    await expect.poll(() => turnsWith(bot.threadId, ANSWER_TEXT).length, { timeout: 15000 }).toBe(1);
    await idle(bot.id);
    const line = (await messages(bot.threadId)).find((message) => message.role === "user" && message.sendId === sendId);
    expect(line).toMatchObject({ kind: "text", text: ANSWER_TEXT });
    expect(line.steered).toBeUndefined();
    await quiet(500);
    expect(turnsWith(bot.threadId, ANSWER_TEXT)).toHaveLength(1);
    expect(steersOn(bot.threadId)).toEqual([]);
  }, 90000);

  it("an answer while its own turn is live on a steering engine is steered into that turn, and runs no new one", async () => {
    const bot = await createBot("Ask steered", "steers");
    const { turnId, requestId, sendId } = await openCard(bot, "steered");
    const answered = await answer(bot.threadId, requestId);
    expect(answered.status).toBe(200);
    expect(answered.body.steered).toBe(true);
    expect(steersOn(bot.threadId)).toEqual([expect.objectContaining({ turnId, text: expect.stringContaining("Email, Slack") })]);
    const line = (await messages(bot.threadId)).find((message) => message.role === "user" && message.sendId === sendId);
    expect(line).toMatchObject({ steered: true, dispatchedIn: turnId, text: ANSWER_TEXT });
    release(); await idle(bot.id);
    await quiet(500);
    expect(turnsWith(bot.threadId, "Email, Slack")).toEqual([]);
  }, 60000);

  it("a newer turn is live when the answer arrives: queued, never steered into it, and it runs after", async () => {
    const bot = await createBot("Ask newer turn", "steers");
    const asked = await openCard(bot, "asking turn");
    release(); await idle(bot.id);
    reset();
    arm("hold");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__hold__ a newer turn" })).status).toBe(202);
    const newer = await liveTurn();
    expect(newer.turnId).not.toBe(asked.turnId);
    const answered = await answer(bot.threadId, asked.requestId);
    expect(answered.status).toBe(200);
    expect(answered.body.queued).toBe(true);
    expect(steersOn(bot.threadId)).toEqual([]);
    release();
    await expect.poll(() => turnsWith(bot.threadId, ANSWER_TEXT).length, { timeout: 15000 }).toBe(1);
    expect(turnsWith(bot.threadId, ANSWER_TEXT)[0]!.turnId).not.toBe(newer.turnId);
    await idle(bot.id);
    expect(steersOn(bot.threadId)).toEqual([]);
  }, 60000);

  it("an engine that cannot be steered (Codex-like) queues the answer and runs it when the turn settles", async () => {
    const bot = await createBot("Ask queued", "queues");
    const { requestId } = await openCard(bot, "queued");
    const answered = await answer(bot.threadId, requestId);
    expect(answered.status).toBe(200);
    expect(answered.body.queued).toBe(true);
    await quiet(400);
    expect(turnsWith(bot.threadId, ANSWER_TEXT)).toEqual([]);
    release();
    await expect.poll(() => turnsWith(bot.threadId, ANSWER_TEXT).length, { timeout: 15000 }).toBe(1);
    await idle(bot.id);
    expect(turnsWith(bot.threadId, ANSWER_TEXT)).toHaveLength(1);
  }, 60000);

  it("Stop expires the card; its late answer takes the same one-transaction claim, is queued even into a live steerable turn, and never steers", async () => {
    const bot = await createBot("Ask late", "steers");
    const { card, requestId, sendId } = await openCard(bot, "stopped");
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, {})).status).toBe(200);
    await expect.poll(async () => (await cardById(bot.threadId, card.id)).card.expired, { timeout: 15000 }).toBe(true);
    await idle(bot.id);
    expect((await answer(bot.threadId, requestId)).body.code).toBe("question_expired");
    reset();
    arm("hold");
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__hold__ after the stop" })).status).toBe(202);
    const live = await liveTurn();
    const late = await answer(bot.threadId, requestId, { sentAsMessage: true });
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ ok: true, outcome: "sent-as-message", queued: true, text: LATE_TEXT });
    expect((await answer(bot.threadId, requestId, { sentAsMessage: true })).body.code).toBe("already_settled");
    expect(sendRows(bot.threadId).map((row) => row.sendId)).toEqual([sendId]);
    expect((await cardById(bot.threadId, card.id)).card).toMatchObject({ expired: true, sentAsMessage: true, sendId });
    expect(steersOn(bot.threadId)).toEqual([]);
    release();
    await expect.poll(() => turnsWith(bot.threadId, "A: Email, Slack").length, { timeout: 15000 }).toBe(1);
    expect(turnsWith(bot.threadId, "A: Email, Slack")[0]!.turnId).not.toBe(live.turnId);
    await idle(bot.id);
    expect(steersOn(bot.threadId)).toEqual([]);
  }, 60000);

  it("a text-only engine asks with a fence: one card per message, the answer is an ordinary send and the turn runs (never held)", async () => {
    const bot = await createBot("Ask fence", "text");
    reset();
    // the second fence is the valid one: an invalid fence stays text and keeps its own place in the count
    writeFileSync(join(askDir(), "reply.txt"), `${fenceReply("{not json")}${fenceReply(CHANNELS, "And:")}`);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fence__ where should it go" })).status).toBe(202);
    await idle(bot.id);
    await expect.poll(async () => (await questionCards(bot.threadId)).length, { timeout: 15000 }).toBe(1);
    const said = (await messages(bot.threadId)).find((message) => message.role === "bot" && message.kind === "text" && message.text?.includes("murage-question"));
    const [card] = await questionCards(bot.threadId);
    expect(card.card).toMatchObject({ answerAsSend: true, fenceOf: { messageId: said.id, index: 1 } });
    // the bot's words are kept as written: the client hides only the fence that has its card
    expect(said.text).toContain("{not json");
    await quiet(400);
    expect(await questionCards(bot.threadId)).toHaveLength(1);

    const answered = await answer(bot.threadId, card.card.requestId);
    expect(answered.status).toBe(200);
    await expect.poll(() => turnsWith(bot.threadId, ANSWER_TEXT).length, { timeout: 15000 }).toBe(1);
    await idle(bot.id);
    const line = (await messages(bot.threadId)).find((message) => message.role === "user" && message.sendId === `ask-${card.id}`);
    expect(line).toMatchObject({ kind: "text", text: ANSWER_TEXT });
  }, 60000);

  it("a fence that is unclosed, invalid, over the limits or from a refused audience stays text; history is never materialised", async () => {
    const bot = await createBot("Ask fence refusals", "text");
    const replies = [
      "Thinking:\n\n```murage-question\n" + JSON.stringify(CHANNELS),
      fenceReply("{\"questions\": [}"),
      fenceReply({ questions: [{ question: "x".repeat(2001) }] }),
      fenceReply({ questions: [{ question: "Your key?", secret: true }] }),
    ];
    for (const reply of replies) {
      reset();
      writeFileSync(join(askDir(), "reply.txt"), reply);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fence__ refused shapes" })).status).toBe(202);
      await idle(bot.id);
    }
    // words nobody proved are the owner's: an unattended, not-owner turn
    reset();
    writeFileSync(join(askDir(), "reply.txt"), fenceReply(CHANNELS));
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fence__ from unproven words" }, false)).status).toBe(202);
    await idle(bot.id);
    await quiet(500);
    expect(await questionCards(bot.threadId)).toEqual([]);
    const fenced = (await messages(bot.threadId)).filter((message) => message.role === "bot" && message.text?.includes("murage-question"));
    expect(fenced).toHaveLength(5);
    // a restart reads those rows back as history: still no card
    await fixture.restart();
    await connect();
    await quiet(800);
    expect(await questionCards(bot.threadId)).toEqual([]);
  }, 90000);

  it("drain crash before the dispatch marker: the answer is still waiting after boot and is drained once", async () => {
    const bot = await createBot("Ask crash before", "queues");
    const { requestId, sendId } = await openCard(bot, "crash before");
    release(); await idle(bot.id);
    arm("crash-before-dispatch");
    await answer(bot.threadId, requestId).catch(() => undefined);
    await restartAfterKill();
    await expect.poll(() => turnsWith(bot.threadId, ANSWER_TEXT).length, { timeout: 20000 }).toBe(1);
    await idle(bot.id);
    expect(sendRows(bot.threadId)).toEqual([expect.objectContaining({ sendId, status: "started" })]);
    await quiet(500);
    expect(turnsWith(bot.threadId, ANSWER_TEXT)).toHaveLength(1);
  }, 90000);

  it("drain crash after the dispatch marker: boot shows the words as not confirmed and never runs them again", async () => {
    const bot = await createBot("Ask crash after", "queues");
    const { requestId, sendId } = await openCard(bot, "crash after");
    release(); await idle(bot.id);
    arm("crash-after-dispatch");
    await answer(bot.threadId, requestId).catch(() => undefined);
    await restartAfterKill();
    await expect.poll(async () => (await messages(bot.threadId)).find((message) => message.role === "user" && message.sendId === sendId)?.steerUnconfirmed, { timeout: 20000 }).toBe(true);
    expect(sendRows(bot.threadId)).toEqual([expect.objectContaining({ sendId, status: "unconfirmed", notice: "notConfirmed" })]);
    await quiet(1500);
    expect(turnsWith(bot.threadId, ANSWER_TEXT)).toEqual([]);
  }, 90000);

  it("Stop while the answer waits, then a restart: the answer is a chip (Send again / Dismiss) and never runs by itself", async () => {
    const bot = await createBot("Ask stop held", "queues");
    const { requestId, sendId } = await openCard(bot, "stop held");
    const answered = await answer(bot.threadId, requestId);
    expect(answered.body.queued).toBe(true);
    arm("crash-after-stop");
    await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
    await restartAfterKill();
    await expect.poll(() => sendRows(bot.threadId)[0]?.status, { timeout: 15000 }).toBe("refused");
    expect(sendRows(bot.threadId)).toEqual([{ sendId, status: "refused", notice: "notConfirmed", stopped: 1 }]);
    await quiet(1500);
    expect(turnsWith(bot.threadId, ANSWER_TEXT)).toEqual([]);
  }, 90000);

  it("a restart with an open card expires it at boot; a later answer is a late answer", async () => {
    const bot = await createBot("Ask restart open", "queues");
    const { card, requestId } = await openCard(bot, "restart open");
    await fixture.restart();
    await connect();
    await expect.poll(async () => (await cardById(bot.threadId, card.id)).card.expired, { timeout: 20000 }).toBe(true);
    expect((await answer(bot.threadId, requestId)).body.code).toBe("question_expired");
    const late = await answer(bot.threadId, requestId, { sentAsMessage: true });
    expect(late.body).toMatchObject({ ok: true, outcome: "sent-as-message" });
    await expect.poll(() => turnsWith(bot.threadId, "A: Email, Slack").length, { timeout: 15000 }).toBe(1);
    await idle(bot.id);
  }, 90000);

  it("B-165 QW rooms: a member's murage-question fence becomes a room card stamped with that member; answered once, queued, never steered", async () => {
    const member = await createBot("Ask room fence member", "text"), other = await createBot("Ask room fence other", "text");
    const room = (await api("POST", "/api/groups", { name: "Ask room fence", memberIds: [member.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: other.id } } })).body.group as { id: string; threadId: string };
    reset();
    writeFileSync(join(askDir(), "reply.txt"), fenceReply(CHANNELS));
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "__fence__ where should it go", responderId: member.id, sendId: `room-fence-${Date.now()}-pad` })).status).toBe(202);
    await expect.poll(async () => (await questionCards(room.threadId)).length, { timeout: 20000 }).toBe(1);
    await idle(member.id);
    const [card] = await questionCards(room.threadId);
    expect(card).toMatchObject({ role: "bot", kind: "options", from: { botId: member.id }, card: { answerAsSend: true } });
    rmSync(join(askDir(), "reply.txt"), { force: true });
    const requestId = card.card.requestId as string;
    expect((await answer(room.threadId, requestId)).status).toBe(200);
    expect((await answer(room.threadId, requestId)).body.code).toBe("already_settled");
    await expect.poll(() => turnsWith(room.threadId, ANSWER_TEXT).length, { timeout: 20000 }).toBe(1);
    await idle(member.id);
    await quiet(400);
    expect(turnsWith(room.threadId, ANSWER_TEXT)).toHaveLength(1);
    expect(steersOn(room.threadId)).toEqual([]);
  }, 120000);
});
