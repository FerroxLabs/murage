// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MAIN-RULING propose-500 (2026-11-22, binding): the Chief's hidden New project proposal turn gets proven decision authority through
// the existing issueDecisionAuthority path, scoped to that one turn. /api/internal/project/propose awaits issueDecisionAuthority before
// its body read; the proposal thread is neither a task nor a room thread, so the provenance reader's live() had no settings for it,
// authority() stayed 'unproven', saveContinuation threw and every proposal turn got 500 (since NOLIMITS v1 V6).
// Owners: lane fix1021-propose-fable owns these rows, the scoped live() branch and the route order (server/index.ts), the grant in
// ChiefProposalTurns (held / holds / submit) and store.chiefOffice. The PROPOSE row's 20 MiB read was first written by lane
// cause22-main-fable (group A), which owns the body read. The decision core (server/decision) is not edited.
// The rows boot the REAL server (scripts/control-murage.ts), start the proposal turn with the owner's POST /api/projects/proposal on an
// engine that holds the turn open (testing/fake-late-terminal-driver.ts, as in project-proposal-api.test.ts) and post as that turn.
// RED on c187b11166 and on 2b910678c8: the first propose call of every row answers 500 {"error":"unproven-continuation"}.
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const ITEM = 20 * 1024 * 1024;
const instrumentation = `
const fs = await import('node:fs');
const path = await import('node:path');
const dir = process.env.MURAGE_DATA_DIR;
const file = path.join(dir, 'config.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL("./drivers/builtIn.ts", import.meta.url).href)});
const { makeLateTerminalDriver } = await import(${JSON.stringify(new URL("./testing/fake-late-terminal-driver.ts", import.meta.url).href)});
const lateDriver = makeLateTerminalDriver();
const createLate = lateDriver.create;
// the holding engine's answer to a native ask is recorded here (the gate file's name + .answers), as an engine would see it
lateDriver.create = async (input) => {
  const instance = await createLate(input);
  const gate = input.environment.FAKE_LATE_ASK_GATE;
  if (gate) instance.adapter.respondToRequest = async (threadId, requestId, decision) => { fs.appendFileSync(gate + '.answers', JSON.stringify({ threadId, requestId, behavior: decision.behavior }) + '\\n'); return decision.behavior === 'allow' ? 'allowed-once' : 'rejected'; };
  return instance;
};
BUILT_IN_DRIVERS.push(lateDriver);
// the held-turn fixture engine stands in for an engine that mounts project_propose
const { proposalSettings } = await import(${JSON.stringify(new URL("./project-proposal-engines.ts", import.meta.url).href)});
proposalSettings.toolEngines.add('fakeLateTerminal');
// the hidden turn's own bound, shortened so a lost proposal shows as the plain form well inside the row's time
proposalSettings.turnTimeoutMs = 15000;
fs.writeFileSync(path.join(dir, 'heldP-terminal'), '');
cfg.instances.heldP = { driver: 'fakeLateTerminal', displayName: 'Held proposal fixture', environment: { FAKE_LATE_SESSION_GATE: path.join(dir, 'heldP-session'), FAKE_LATE_TERMINAL_GATE: path.join(dir, 'heldP-terminal'), FAKE_LATE_AGENTS_ENV: path.join(dir, 'heldP-agents.json'), FAKE_LATE_ASK_GATE: path.join(dir, 'heldP-ask') } };
fs.writeFileSync(file, JSON.stringify(cfg));
process.env.FAKE_CLAUDE_DUMP_EACH_TURN = '1';
`;

let server: VerificationServer;
let owner: Record<string, string> = {};
let chiefId = "";
let helperToken = "";
let helperId = "";
let lastToken = "";
let modelOf: (instanceId: string) => string = () => "fixture-model";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ownerApi = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(server.info.url + path, { method, headers: { ...owner, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
/** A POST exactly as the turn's own agents proxy issues project_propose: the bearer is the whole authority. */
const propose = async (token: string, body: unknown) => {
  const response = await fetch(server.info.url + "/api/internal/project/propose", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, answer: (await response.text()).slice(0, 200) };
};
type Answer = { status: number; answer: string };
/** The proposal turn's own saved continuations (issueDecisionAuthority -> saveContinuation), read from the server's own database. */
const proposalContinuations = () => {
  const db = new DatabaseSync(join(server.info.dataDir, "messages.db"), { readOnly: true });
  try { return (db.prepare("SELECT key, value FROM decision_continuations").all() as Array<{ key: string; value: string }>).filter((row) => row.key.includes("project-proposal-")); }
  finally { db.close(); }
};
/** Rows a killed server left behind (row RESTART): never counted as a later turn's. */
const deadRows = new Set<string>();
const liveContinuations = () => proposalContinuations().filter((row) => !deadRows.has(row.key));
/** The same POST as an upload the test holds open. The body carries 48 MiB of padding and all of it but the last kilobyte is written
 * at once: far more than the loopback socket buffers hold, so that write can only finish once the server is reading THIS request's body,
 * and the route reads a body only after its authority step. `paused()` resolves true when both hold: this upload was taken in (its own
 * evidence, one per POST) and the turn's continuation is saved. It resolves false at once when the POST is answered first (the route
 * never got that far), so a row never waits on it. `release()` sends the last kilobyte. */
const HELD_PAD = 48 * 1024 * 1024;
const proposeHeld = (token: string, body: Record<string, unknown>) => {
  const text = JSON.stringify({ ...body, pad: "h".repeat(HELD_PAD) }), cut = text.length - 1024;
  let settle: (answer: Answer) => void = () => undefined, fail: (error: unknown) => void = () => undefined;
  const answered = new Promise<Answer>((resolve, reject) => { settle = resolve; fail = reject; });
  const call = request(new URL(server.info.url + "/api/internal/project/propose"), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } }, (response) => {
    let answer = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { answer += chunk; }); response.on("end", () => settle({ status: response.statusCode ?? 0, answer: answer.slice(0, 200) }));
  });
  call.on("error", fail);
  let early = false, takenIn = false;
  void answered.then(() => { early = true; }, () => { early = true; });
  call.write(text.slice(0, cut), () => { takenIn = true; });
  return {
    answered,
    paused: async (rows = 1) => {
      for (let waited = 0; waited < 30_000 && !early && !(takenIn && liveContinuations().length >= rows); waited += 50) await sleep(50);
      // a few turns of the loop, so an answer that was already on its way is seen
      await sleep(300);
      return !early && takenIn && liveContinuations().length >= rows;
    },
    release: () => { call.end(text.slice(cut)); return answered; },
  };
};
/** Every owner request a row opened. A row that stops early closes its own (the owner closing the request stops the Chief's turn), so
 * no held turn of one row is still there in the next. */
const openRequests = new Set<AbortController>();
let roleMoved = false, engineMoved = false;
afterEach(async () => {
  for (const closing of openRequests) closing.abort();
  openRequests.clear();
  // a row that moved the Chief role or the Chief's engine and stopped early leaves neither moved for the next row
  if (roleMoved) { roleMoved = false; await ownerApi("PATCH", `/api/bots/${chiefId}`, { chiefOfStaff: true, chiefScope: "workspace" }); }
  if (engineMoved) { engineMoved = false; await ownerApi("PATCH", `/api/bots/${chiefId}`, { modelSelection: { instanceId: "heldP", model: modelOf("heldP") } }); }
  for (let waited = 0; waited < 20_000 && liveContinuations().length; waited += 50) await sleep(50);
  // rows that outlive their turn are set aside, so the next row's pause signal counts only its own
  for (const row of liveContinuations()) deadRows.add(row.key);
  await sleep(200);
});
/** The owner's New project request, and the bearer of the Chief's hidden turn it started on the held engine (a new one each time). */
const startProposal = async () => {
  const closing = new AbortController();
  openRequests.add(closing);
  const waiting = fetch(server.info.url + "/api/projects/proposal", { method: "POST", signal: closing.signal, headers: { ...owner, "content-type": "application/json" }, body: JSON.stringify({ purpose: "Write the quarterly report" }) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) as any })).catch(() => ({ status: 0, body: null as any }));
  const gate = join(server.info.dataDir, "heldP-session.waiting"), envFile = join(server.info.dataDir, "heldP-agents.json");
  let token = "";
  for (let waited = 0; waited < 30_000 && (!token || token === lastToken); waited += 100) {
    try { readFileSync(gate); token = JSON.parse(readFileSync(envFile, "utf8")).MURAGE_COMMS_TOKEN ?? ""; } catch { token = ""; }
    if (!token || token === lastToken) await sleep(100);
  }
  expect(token && token !== lastToken, "the held proposal turn was handed its own agents capability").toBeTruthy();
  lastToken = token;
  return { waiting, token, closing };
};
const proposal = (summary = "Route body proposal") => ({ members: [chiefId], leadBotId: null, mode: "goal", brief: { summary, doneMeans: "A report", rules: "Be brief" }, budget: { minutes: 90, tokens: 2_000_000 }, planOutline: ["Read the brief"] });
const ENDED_TURN = { status: 403, answer: JSON.stringify({ error: "This proposal turn has ended." }) };
const makeChief = async (botId: string) => { roleMoved = botId !== chiefId; return expect((await ownerApi("PATCH", `/api/bots/${botId}`, { chiefOfStaff: true, chiefScope: "workspace" })).status, "the owner hands the Chief role over").toBe(200); };
/** The holding engine's native asks (FAKE_LATE_ASK_GATE): every held turn raises one per round; its answers and any raw read of its input. */
let askRound = 0;
const lines = (file: string) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>); } catch { return []; } };
const nativeAsk = async (turns: number) => {
  const gate = join(server.info.dataDir, "heldP-ask"), round = `round${++askRound}`;
  writeFileSync(gate, round);
  const answersOf = () => lines(`${gate}.answers`).filter((entry) => entry.requestId.startsWith(`ask-${round}-`));
  for (let waited = 0; waited < 20_000 && answersOf().length < turns; waited += 50) await sleep(50);
  // the raw read, if any, happens in the same event delivery as the answer; a moment more costs nothing
  await sleep(200);
  // rawReads: the module of every enumeration of the ask's deep input (a raw copy by the decision core reads "wipe-input.ts")
  return { answers: answersOf().map((entry) => entry.behavior), rawReads: lines(`${gate}.rawread`).filter((entry) => entry.round === round).map((entry) => entry.by) };
};

beforeAll(async () => {
  server = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation, portRange: { from: 45_500, span: 90 } });
  const proof = await (await fetch(server.info.url + "/api/desktop-secret")).json() as { secret: string };
  owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const engines = (await ownerApi("GET", "/api/instances")).body.instances as Array<{ instanceId: string; models: { options: Array<{ id: string }>; default?: string } }>;
  modelOf = (instanceId: string) => { const engine = engines.find((entry) => entry.instanceId === instanceId); return engine?.models.options[0]?.id || engine?.models.default || "fixture-model"; };
  const made = await ownerApi("POST", "/api/bots", { name: "Proposal Chief", modelSelection: { instanceId: "verification", model: modelOf("verification") } });
  chiefId = made.body?.bot?.id ?? "";
  expect((await ownerApi("PATCH", `/api/bots/${chiefId}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await ownerApi("PATCH", `/api/bots/${chiefId}`, { chiefOfStaff: true, chiefScope: "workspace" })).status).toBe(200);
  // The Chief at No limits: the proposal turn must still be proven at Ask (row LEVEL).
  const seen = (await ownerApi("POST", `/api/bots/${chiefId}/permissions/refresh`, { scope: "open", targetLevel: "no-limits" })).body;
  const raised = await ownerApi("PATCH", `/api/bots/${chiefId}`, { settingsScope: "defaults", previewId: seen?.previewId, ifRev: seen?.botRev, fullAccess: true, acknowledgeFullAccess: true, noLimits: true, acknowledgeNoLimits: true });
  expect(raised.status, JSON.stringify(raised.body)).toBe(200);
  expect(raised.body?.bot?.noLimits, "the Chief is at No limits").toBe(true);
  expect((await ownerApi("PATCH", `/api/bots/${chiefId}`, { modelSelection: { instanceId: "heldP", model: modelOf("heldP") } })).status).toBe(200);
  // The bots the fixture came with are hidden, so the Chief made above is the oldest visible bot (row VACANT: setup then seats it again).
  for (const other of ((await ownerApi("GET", "/api/bots")).body?.bots ?? []) as Array<{ id: string }>) {
    if (other.id !== chiefId) expect((await ownerApi("PATCH", `/api/bots/${other.id}`, { hidden: true })).status, "a fixture bot is hidden").toBe(200);
  }
  // An ordinary bot's held task turn on the verification engine: its own agents capability is a real non-proposal bearer (row NONPROP).
  const helper = (await ownerApi("POST", "/api/bots", { name: "Task helper", modelSelection: { instanceId: "verification", model: modelOf("verification") } })).body.bot;
  helperId = helper.id;
  expect((await ownerApi("PATCH", `/api/bots/${helper.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await ownerApi("POST", `/api/bots/${helper.id}/messages`, { threadId: helper.threadId, text: "__fixture_hold_authority__ propose-authority-helper" })).status).toBe(202);
  const dump = () => { try { return withTurnSecrets(JSON.parse(readFileSync(server.fixtureDumpPath, "utf8"))); } catch { return null; } };
  for (let waited = 0; waited < 30_000 && !JSON.stringify(dump()?.prompt ?? "").includes("propose-authority-helper"); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  helperToken = Object.values((dump()?.mcpConfig?.mcpServers ?? {}) as Record<string, { env?: Record<string, string> }>).map((entry) => entry.env?.MURAGE_COMMS_TOKEN).find(Boolean) ?? "";
}, 90_000);
afterAll(async () => { await server?.close(); });

describe("propose-500: the Chief's own proposal turn is proven for project_propose, and nothing else is", () => {
  // NONPROP and FORGED are regression controls: both answers come from doors this fix does not change, so they are green on the base
  // too. The base-sensitive form (the same two bearers refused while a proposal turn is live and proven) is inside the PROPOSE row.
  it("NONPROP (regression control): an ordinary task turn's own bearer still gets 403 from project_propose, its body unread", async () => {
    expect(helperToken, "NONPROP: the task turn was handed its agents capability").toBeTruthy();
    expect(await propose(helperToken, proposal()), "NONPROP").toEqual({ status: 403, answer: JSON.stringify({ error: "Only a New project proposal can use this tool." }) });
  });

  it("FORGED (regression control): a bearer no turn was handed gets the uniform refusal, never the route", async () => {
    expect((await propose("f".repeat(64), proposal())).status, "FORGED").toBe(409);
  });

  it("PROPOSE + LEVEL + ENDED: the proposal turn's 20 MiB request is read whole, its proposal reaches the owner, the turn is proven at Ask, and the ended turn's bearer is refused", async () => {
    const row = "PROPOSE project_propose route";
    expect(chiefId, `${row}: the Chief bot was made`).toBeTruthy();
    // the owner's own request: it waits for the Chief's hidden turn, which the fixture engine holds open
    const { waiting, token } = await startProposal();
    // control: a small request that is not a proposal gets the route's own validation answer (the turn stays open)
    const small = await propose(token, { pad: "s" });
    expect(small, `${row} control`).toEqual({ status: 400, answer: expect.stringContaining("Check the proposal") });
    // LEVEL: the proof the route took (issueDecisionAuthority -> saveContinuation, live while the turn waits) is the owner's turn at
    // Ask, though the Chief itself is at No limits
    const saved = liveContinuations().map((entry) => JSON.parse(entry.value) as { level: string; actor: string });
    expect(saved, "LEVEL: the proposal turn's saved continuation").toEqual([expect.objectContaining({ actor: "owner", level: "ask" })]);
    // NONPROP and FORGED alongside the live, proven proposal turn: another turn's real bearer and a made-up one are still refused,
    // and neither disturbs the held turn (it goes on to deliver below)
    expect(await propose(helperToken, proposal("Draft of another turn")), "NONPROP while a proposal turn is proven").toEqual({ status: 403, answer: JSON.stringify({ error: "Only a New project proposal can use this tool." }) });
    expect((await propose("f".repeat(64), proposal("Draft of no turn"))).status, "FORGED while a proposal turn is proven").toBe(409);
    const text = "z".repeat(ITEM);
    const large = await propose(token, { pad: text });
    expect(large, `${row}: the 20 MiB request is not refused for its size`).toEqual(small);
    // every byte was read and parsed: the same 20 MiB request, now carrying a valid proposal, is accepted
    const sent = await propose(token, { ...proposal(), pad: text });
    expect(sent, `${row}: the 20 MiB proposal is accepted`).toEqual({ status: 200, answer: expect.stringContaining('"ok":true') });
    // and it is the answer to the owner's waiting request
    const answered = await waiting;
    expect(JSON.stringify(answered.body), `${row}: the owner's request got the proposal that was sent`).toContain("Route body proposal");
    expect(JSON.stringify(answered.body), `${row}: and nothing the other bearers posted`).not.toMatch(/Draft of another turn|Draft of no turn/);
    // ENDED: the turn is over (the proposal went to the owner), so its bearer is refused and nothing more is accepted
    expect((await propose(token, proposal())).status, "ENDED: the ended proposal turn's bearer").toBe(401);
    // and the turn's end retired the proof it took (the retirement runs after the turn's end, so it is given a few seconds)
    for (let waited = 0; waited < 5_000 && liveContinuations().length; waited += 50) await sleep(50);
    expect(liveContinuations(), "ENDED: the proposal turn's continuation is retired with the turn").toEqual([]);
  }, 120_000);

  it("ASK: a native engine ask on the held No-limits proposal turn is denied and its input is never read raw, before and after the route's authority step", async () => {
    const { waiting, token } = await startProposal();
    // before any project_propose call
    expect(await nativeAsk(1), "ASK before the route's authority step: denied, input not read raw").toEqual({ answers: ["deny"], rawReads: [] });
    // the route takes its authority step for this turn (the continuation is saved and stays while the turn is held)
    expect(await propose(token, { pad: "s" }), "ASK control").toEqual({ status: 400, answer: expect.stringContaining("Check the proposal") });
    expect(liveContinuations(), "ASK: the turn's continuation is saved").toHaveLength(1);
    // the same turn, now proven for project_propose: its native ask is still nobody's (no reader outside the route proves the turn)
    expect(await nativeAsk(1), "ASK after the route's authority step: denied, input not read raw").toEqual({ answers: ["deny"], rawReads: [] });
    // and the turn is still good for its one purpose
    expect(await propose(token, proposal("Draft after the asks")), "ASK: the turn still proposes").toEqual({ status: 200, answer: expect.stringContaining('"ok":true') });
    expect(JSON.stringify((await waiting).body), "ASK: the owner got the proposal").toContain("Draft after the asks");
  }, 120_000);

  it("VACANT: the Chief role cleared and given back (A, nobody, A) while the proposal is being read voids the turn's grant for good", async () => {
    const { waiting, token } = await startProposal();
    const held = proposeHeld(token, proposal("Draft from before the role was cleared"));
    const inRead = await held.paused();
    // the owner clears the Chief's role: a staged change, published only after its roster write returns
    roleMoved = true;
    expect((await ownerApi("PATCH", `/api/bots/${chiefId}`, { chiefOfStaff: false })).status, "VACANT: the owner clears the Chief role").toBe(200);
    expect((await ownerApi("GET", "/api/projects/new-options")).body?.chief, "VACANT: nobody is the Chief").toBeUndefined();
    // opening setup seats a Chief again: the oldest visible bot where no role is left and none was recorded, here the same bot
    expect((await ownerApi("GET", "/api/setup")).status, "VACANT: setup is opened").toBe(200);
    expect((await ownerApi("GET", "/api/projects/new-options")).body?.chief?.id, "VACANT: setup seated the first bot as the Chief again (its election changes the record in place, before its own save)").toBe(chiefId);
    roleMoved = false;
    expect(await held.release(), "VACANT: the POST that was being read while the role was cleared and given back").toEqual(ENDED_TURN);
    expect(inRead, "VACANT: the POST had passed the route's authority step and was in its body read when the role was cleared").toBe(true);
    expect(JSON.stringify((await waiting).body ?? null), "VACANT: the owner never got the draft from before the role was cleared").not.toContain("Draft from before the role was cleared");
  }, 120_000);

  it("ABA: the Chief role handed to another bot and back while the proposal is being read voids the turn's grant for good", async () => {
    const { waiting, token } = await startProposal();
    const held = proposeHeld(token, proposal("Draft from before the handover"));
    const inRead = await held.paused();
    // the owner makes another bot the Chief, then the first one again, while the first one's proposal is still being read
    await makeChief(helperId);
    await makeChief(chiefId);
    expect(await held.release(), "ABA: the POST that was being read across the two handovers").toEqual(ENDED_TURN);
    expect(inRead, "ABA: the POST had passed the route's authority step and was in its body read when the role moved").toBe(true);
    expect(await propose(token, proposal("Draft from before the handover")), "ABA: a later POST of the same turn").toEqual(ENDED_TURN);
    expect(JSON.stringify((await waiting).body ?? null), "ABA: the owner never got the draft from before the handover").not.toContain("Draft from before the handover");
  }, 120_000);

  it("HANDOVER: once another bot is the workspace Chief, the former Chief's proposal turn is refused, during its body read and after", async () => {
    const { waiting, token } = await startProposal();
    const held = proposeHeld(token, proposal("Draft of the former Chief"));
    const inRead = await held.paused();
    await makeChief(helperId);
    expect(await held.release(), "HANDOVER during the body read").toEqual(ENDED_TURN);
    expect(inRead, "HANDOVER: the POST had passed the route's authority step and was in its body read when the role moved").toBe(true);
    expect(await propose(token, proposal("Draft of the former Chief")), "HANDOVER after").toEqual(ENDED_TURN);
    expect(JSON.stringify((await waiting).body ?? null), "HANDOVER: the owner never got the former Chief's proposal").not.toContain("Draft of the former Chief");
  }, 120_000);

  it("REVOKED: a capability revoked while the body is read (the Chief's engine changed) refuses the proposal", async () => {
    const { waiting, token } = await startProposal();
    const held = proposeHeld(token, proposal("Draft of the revoked turn"));
    const inRead = await held.paused();
    engineMoved = true;
    expect((await ownerApi("PATCH", `/api/bots/${chiefId}`, { modelSelection: { instanceId: "verification", model: modelOf("verification") } })).status).toBe(200);
    expect(await held.release(), "REVOKED during the body read").toEqual({ status: 401, answer: JSON.stringify({ error: "internal turn capability is no longer active" }) });
    expect(inRead, "REVOKED: the POST had passed the route's authority step and was in its body read when the engine changed").toBe(true);
    expect(JSON.stringify((await waiting).body ?? null), "REVOKED: the owner never got the revoked turn's proposal").not.toContain("Draft of the revoked turn");
  }, 120_000);

  it("RACE1: two POSTs already admitted on one bearer deliver exactly one draft", async () => {
    const { waiting, token } = await startProposal();
    const first = proposeHeld(token, proposal("Draft one of one bearer")), second = proposeHeld(token, proposal("Draft two of one bearer"));
    // each upload is its own evidence: both were taken in by the route's body read before either is released
    const inRead = [await first.paused(), await second.paused()];
    const answers = await Promise.all([first.release(), second.release()]);
    const won = answers.filter((answer) => answer.status === 200), lost = answers.filter((answer) => answer.status !== 200);
    expect([won.length, lost.length], `RACE1: one POST is accepted and one refused (${JSON.stringify(answers)})`).toEqual([1, 1]);
    // the refused one meets "already sent" (409), the ended turn (403) or the retired capability or binding (401, 409), by its timing
    expect([401, 403, 409], "RACE1: the refused POST's answer").toContain(lost[0].status);
    expect(inRead, "RACE1: both uploads had been taken in by the route's body read (each its own evidence) before either was released").toEqual([true, true]);
    const got = JSON.stringify((await waiting).body), winner = answers[0].status === 200 ? "Draft one of one bearer" : "Draft two of one bearer", loser = answers[0].status === 200 ? "Draft two of one bearer" : "Draft one of one bearer";
    expect(got, "RACE1: the owner got the accepted draft").toContain(winner);
    expect(got, "RACE1: the owner did not get the refused draft").not.toContain(loser);
  }, 120_000);

  it("RACE2: two proposal turns at once each deliver their own draft to their own owner request, and neither proves the other's asks", async () => {
    const one = await startProposal(), two = await startProposal();
    // turn one's POST takes the route's authority step and waits in its body read (the first saved continuation is its own)
    const first = proposeHeld(one.token, proposal("Draft of turn one"));
    const firstInRead = await first.paused(1);
    const stepOne = liveContinuations().map((entry) => JSON.parse(entry.value) as { level: string; actor: string });
    // both held turns raise a native ask: denied on both, read raw on neither (turn one's proof does not reach turn two, or its own asks)
    const asked = await nativeAsk(2);
    // turn two's POST does the same (the second saved continuation is its own)
    const second = proposeHeld(two.token, proposal("Draft of turn two"));
    const inRead = [firstInRead, await second.paused(2)];
    const accepted = { status: 200, answer: expect.stringContaining('"ok":true') };
    // the HTTP outcome first: on a server without the fix both answers are the route's 500
    expect(await Promise.all([first.release(), second.release()]), "RACE2: both turns' proposals are accepted").toEqual([accepted, accepted]);
    expect(stepOne, "RACE2: turn one's real authority step had succeeded before the asks (its continuation was saved, at Ask)").toEqual([expect.objectContaining({ actor: "owner", level: "ask" })]);
    expect(asked, "RACE2: native asks on two live proposal turns, one of them proven for project_propose").toEqual({ answers: ["deny", "deny"], rawReads: [] });
    expect(inRead, "RACE2: both turns' uploads had been taken in by the route's body read (two saved continuations)").toEqual([true, true]);
    const gotOne = JSON.stringify((await one.waiting).body), gotTwo = JSON.stringify((await two.waiting).body);
    expect([gotOne.includes("Draft of turn one"), gotOne.includes("Draft of turn two")], "RACE2: owner request one got turn one's draft only").toEqual([true, false]);
    expect([gotTwo.includes("Draft of turn two"), gotTwo.includes("Draft of turn one")], "RACE2: owner request two got turn two's draft only").toEqual([true, false]);
  }, 120_000);

  it("CLOSED: the owner closing the request ends the turn; its bearer then delivers nothing", async () => {
    const { waiting, token, closing } = await startProposal();
    expect(await propose(token, { pad: "s" }), "CLOSED control").toEqual({ status: 400, answer: expect.stringContaining("Check the proposal") });
    closing.abort();
    await waiting;
    // the server sees the closed request a moment later; until then the turn is still held and a non-proposal is still only refused as one
    let after = await propose(token, { pad: "s" });
    for (let waited = 0; waited < 10_000 && after.status === 400; waited += 100) { await sleep(100); after = await propose(token, { pad: "s" }); }
    expect(after.status, `CLOSED: the turn's bearer after the owner closed the request (${after.answer})`).toBe(401);
    expect((await propose(token, proposal("Draft after the owner closed"))).status, "CLOSED: a proposal after the owner closed").toBe(401);
    for (let waited = 0; waited < 5_000 && liveContinuations().length; waited += 50) await sleep(50);
    expect(liveContinuations(), "CLOSED: the turn's continuation is retired with the turn").toEqual([]);
  }, 120_000);

  it("BOUND: a turn that reaches its time bound ends; its bearer then delivers nothing and the owner got no draft from it", async () => {
    const { waiting, token } = await startProposal();
    expect(await propose(token, { pad: "s" }), "BOUND control").toEqual({ status: 400, answer: expect.stringContaining("Check the proposal") });
    // the hidden turn's own bound (15 s in this fixture) answers the owner's request without a proposal
    const answered = await waiting;
    expect((await propose(token, proposal("Draft after the bound"))).status, "BOUND: the turn's bearer after its bound").toBe(401);
    expect(JSON.stringify(answered.body ?? null), "BOUND: the owner's request was answered without that draft").not.toContain("Draft after the bound");
  }, 120_000);

  it("RESTART: a server killed after the turn's continuation committed restarts with that row on disk; the old bearer is refused, no old draft is delivered, and a fresh turn works", async () => {
    const { token } = await startProposal();
    expect(await propose(token, { pad: "s" }), "RESTART control").toEqual({ status: 400, answer: expect.stringContaining("Check the proposal") });
    const before = liveContinuations().map((row) => row.key);
    expect(before, "RESTART: the turn's continuation is committed").toHaveLength(1);
    // an ungraceful stop: no shutdown path runs, so nothing retires the row
    const died = new Promise((resolve) => server.child.once("exit", resolve));
    process.kill(server.info.pid, "SIGKILL");
    await died;
    expect(proposalContinuations().map((row) => row.key), "RESTART: the committed row survived the kill").toEqual(expect.arrayContaining(before));
    await server.restart();
    const proof = await (await fetch(server.info.url + "/api/desktop-secret")).json() as { secret: string };
    owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    expect(proposalContinuations().map((row) => row.key), "RESTART: the row is still there after the same store was reopened").toEqual(expect.arrayContaining(before));
    for (const key of before) deadRows.add(key);
    // a fresh proposal turn after the restart, held; the old turn's bearer then posts its old draft
    const fresh = await startProposal();
    expect((await propose(token, proposal("Draft of the killed turn"))).status, "RESTART: the old bearer after the restart").toBe(409);
    expect(await propose(fresh.token, proposal("Draft of the fresh turn")), "RESTART: the fresh turn's proposal is accepted").toEqual({ status: 200, answer: expect.stringContaining('"ok":true') });
    const got = JSON.stringify((await fresh.waiting).body);
    expect([got.includes("Draft of the fresh turn"), got.includes("Draft of the killed turn")], "RESTART: the owner got the fresh draft and never the killed turn's").toEqual([true, false]);
  }, 180_000);

  // Last on purpose: it holds the server's database for a second, and no later row depends on what that does to a server without the fix.
  it("BUSY: while another writer holds the database a proposal call answers try-again, saves no continuation and delivers nothing; the same turn then proposes", async () => {
    const { waiting, token } = await startProposal();
    // another writer holds the server's database across the whole call (the turn's first continuation write is one of the writes it needs)
    const writer = new DatabaseSync(join(server.info.dataDir, "messages.db"));
    writer.exec("PRAGMA busy_timeout=5000");
    writer.exec("BEGIN IMMEDIATE");
    let refused: Answer;
    // (a connection closed without an answer is recorded as status 0, so the assertion below is what fails)
    try { refused = await propose(token, proposal("Draft sent while the database was held")).catch((error: unknown) => ({ status: 0, answer: String(error) })); }
    finally { writer.exec("ROLLBACK"); writer.close(); }
    expect(refused.status, `BUSY: the proposal while the database was held (${refused.answer})`).toBe(503);
    expect(liveContinuations(), "BUSY: no continuation was saved").toEqual([]);
    // the database is free again: a call that is not a proposal commits the turn's continuation (the write the held database refused), so the row proves the write ran
    expect(await propose(token, { pad: "s" }), "BUSY: the retry once the database was free").toEqual({ status: 400, answer: expect.stringContaining("Check the proposal") });
    expect(liveContinuations(), "BUSY: the retry saved the turn's continuation").toHaveLength(1);
    // the same turn proposes, and the owner gets that draft only
    expect(await propose(token, proposal("Draft sent once the database was free")), "BUSY: the same turn afterwards").toEqual({ status: 200, answer: expect.stringContaining('"ok":true') });
    const got = JSON.stringify((await waiting).body);
    expect([got.includes("Draft sent once the database was free"), got.includes("Draft sent while the database was held")], "BUSY: the owner got the later draft only").toEqual([true, false]);
  }, 120_000);
});
