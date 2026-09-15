// Offline checks of the live run's stop path: no server, network, credentials or operator.
import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DurableDelivery } from "../server/channels/durable-delivery.ts";
import { discordPrompt } from "../server/channels/discord/event.ts";
import { abortableSleep, abortableWait, askOperator, createRunAbort, finalizeLive, LiveStop, realReplyProblems, expectedReplyProblems, receiptDiagnostics, startReceiptCapture } from "./channel-live-providers.ts";
import { chiefPromotionBody, engineEnv, harnessConfig, ROOT } from "./channel-live-harness.ts";

function fakeHarness({ revokeStatus = 200, pairedAfter = false, unreachable = false } = {}) {
  const calls = [], records = [];
  return {
    calls, records,
    async request(method, path) {
      calls.push(`${method} ${path}`);
      if (unreachable) throw new Error("connect ECONNREFUSED");
      if (path.endsWith("/revoke")) return { status: revokeStatus, body: {} };
      if (path.endsWith("/status")) return { status: 200, body: { paired: pairedAfter } };
      return { status: 200, body: {} };
    },
    record(step, data) { records.push({ step, data }); },
    async close() { calls.push("close"); return null; },
  };
}
const neverAnswers = () => {
  const rl = new EventEmitter();
  rl.question = (_query, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  return rl;
};
const base = { revokePath: "/api/slack/revoke", statusPath: "/api/slack/status", statePaired: status => status?.paired === true };

it("Ctrl-C at a prompt aborts the run, a second signal cannot, and cleanup revokes, demotes and closes in that order", async () => {
  const proc = new EventEmitter(), rl = neverAnswers(), notes = [];
  const abort = createRunAbort(rl, proc, text => notes.push(text));
  expect([proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM"), proc.listenerCount("SIGHUP"), rl.listenerCount("SIGINT")]).toEqual([1, 1, 1, 1]);
  const prompt = askOperator(rl, "Press Enter after sending it", abort.signal, 60_000);
  rl.emit("SIGINT");
  const stopped = await prompt.catch(error => error);
  expect(stopped).toBeInstanceOf(LiveStop);
  expect(stopped.message).toContain("SIGINT");
  proc.emit("SIGTERM");
  expect(notes.at(-1)).toContain("Cleanup is in progress");
  expect(abort.signal.reason).toBe(stopped);
  const harness = fakeHarness();
  const outcome = await finalizeLive({ ...base, harness, pairingStarted: true, revokeConfirmed: false, chiefId: "chief-1", chiefDemoted: false });
  expect(outcome).toMatchObject({ revoke: "confirmed", demote: "done", closed: true, order: ["revoke", "demote", "close"] });
  expect(harness.calls).toEqual(["POST /api/slack/revoke", "GET /api/slack/status", "PATCH /api/bots/chief-1", "close"]);
  expect(harness.records.map(r => [r.step, r.data.outcome])).toEqual([["stop-revoke", "confirmed"], ["stop-demote", "done"]]);
  abort.dispose();
  expect([proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM"), proc.listenerCount("SIGHUP"), rl.listenerCount("SIGINT")]).toEqual([0, 0, 0, 0]);
});

it("SIGHUP ends waits and sleeps as a LiveStop", async () => {
  const proc = new EventEmitter();
  const abort = createRunAbort(undefined, proc, () => {});
  const waiting = abortableWait("never", () => false, value => value === true, 60_000, 50, abort.signal);
  const sleeping = abortableSleep(60_000, abort.signal);
  setTimeout(() => proc.emit("SIGHUP"), 20);
  await expect(waiting).rejects.toBeInstanceOf(LiveStop);
  await expect(sleeping).rejects.toBeInstanceOf(LiveStop);
  abort.dispose();
});

it("the run's time limit at a prompt is a LiveStop, and a probe timeout is too", async () => {
  const abort = createRunAbort(undefined, new EventEmitter(), () => {});
  const error = await askOperator(neverAnswers(), "attest", abort.signal, 25).catch(e => e);
  expect(error).toBeInstanceOf(LiveStop);
  expect(error.message).toContain("time limit");
  await expect(abortableWait("reply", () => 0, n => n > 0, 30, 10, abort.signal)).rejects.toThrow("timed out waiting for reply");
  abort.dispose();
});

it("cleanup revokes when pairing started but the pair request never answered, and never assumes success", async () => {
  const inFlight = fakeHarness();
  expect(await finalizeLive({ ...base, harness: inFlight, pairingStarted: true, revokeConfirmed: false, chiefId: "chief-1", chiefDemoted: true }))
    .toMatchObject({ revoke: "confirmed", demote: "not-needed", order: ["revoke", "close"] });
  expect((await finalizeLive({ ...base, harness: fakeHarness({ revokeStatus: 500 }), pairingStarted: true, revokeConfirmed: false, chiefDemoted: true })).revoke).toBe("failed");
  expect((await finalizeLive({ ...base, harness: fakeHarness({ pairedAfter: true }), pairingStarted: true, revokeConfirmed: false, chiefDemoted: true })).revoke).toBe("failed");
  const down = fakeHarness({ unreachable: true });
  const outcome = await finalizeLive({ ...base, harness: down, pairingStarted: true, revokeConfirmed: false, chiefId: "chief-1", chiefDemoted: false });
  expect(outcome).toMatchObject({ revoke: "failed", demote: "failed", closed: true, order: ["revoke", "demote", "close"] });
});

it("cleanup does not revoke a pairing that never started or was already confirmed", async () => {
  const harness = fakeHarness();
  expect(await finalizeLive({ ...base, harness, pairingStarted: false, revokeConfirmed: false, chiefId: "chief-1", chiefDemoted: false })).toMatchObject({ revoke: "not-needed", order: ["demote", "close"] });
  const confirmed = fakeHarness();
  expect(await finalizeLive({ ...base, harness: confirmed, pairingStarted: true, revokeConfirmed: true, chiefId: "chief-1", chiefDemoted: true })).toMatchObject({ revoke: "not-needed", demote: "not-needed", order: ["close"] });
  expect(confirmed.calls).toEqual(["close"]);
});

// ── Optional real engine: rehearsal default unchanged, one admitted instance, reply identity ──
const engine = { instanceId: "qual-engine", driver: "fuigoAgent", displayName: "Qualification engine", config: { cli: "/opt/qualification/engine-cli", fullAuto: false } };
const descriptor = { ...engine, model: "synthetic-model", account: "synthetic", spend: { paid: false, reason: "synthetic" }, maxDispatches: 22 };

it("without an engine the harness keeps the exact fixture config, fake-engine env and Chief promotion body", () => {
  expect(JSON.stringify(harnessConfig())).toBe(JSON.stringify({ engineDiscovery: "explicit", instances: {
    ghost: { driver: "fixture-unavailable" },
    fixtureClaude: { driver: "claudeAgent", config: { cli: join(ROOT, "server", "testing", "fake-claude-cli.ts") } },
  } }));
  expect(engineEnv("/fixture-root")).toEqual({ FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: join("/fixture-root", "fake-claude-last-turn.json") });
  expect(chiefPromotionBody("Rehearsal Chief")).toEqual({ name: "Rehearsal Chief", chiefOfStaff: true, chiefScope: "workspace", computer: "off", modelSelection: { instanceId: "fixtureClaude", model: "claude-sonnet-5" } });
});

it("with an admitted engine the harness config names only that instance and sets no fake-engine switch", () => {
  const config = harnessConfig(engine);
  expect(Object.keys(config.instances)).toEqual(["qual-engine"]);
  expect(JSON.stringify(config)).not.toMatch(/fake|fixture/i);
  expect(engineEnv("/fixture-root", engine)).toEqual({});
  expect(chiefPromotionBody("Qualification Chief", { instanceId: "qual-engine", model: "synthetic-model" }, { browser: false, composio: false }))
    .toMatchObject({ modelSelection: { instanceId: "qual-engine", model: "synthetic-model" }, browser: false, composio: false, computer: "off" });
});

it("a real-engine reply must be the one completed Chief run's output, delivered once on a task pinned to the admitted engine", () => {
  const run = { id: "run-1", status: "completed", botId: "chief", threadId: "thread-1", output: "Here is the single reply to request one." };
  const record = { id: "delivery-1", state: "sent", runId: "run-1", response: "Here is the single reply to request one." };
  const task = { threadId: "thread-1", modelSelection: { instanceId: "qual-engine", model: "synthetic-model" }, lastInstanceId: "qual-engine", alwaysAllow: [] };
  const ok = realReplyProblems({ newRuns: [run], newRecords: [record], chiefId: "chief", chiefTasks: [task], descriptor });
  expect(ok.problems).toEqual([]);
  expect(ok.evidence).toMatchObject({ runId: "run-1", threadId: "thread-1", replyLength: record.response.length });
  expect(ok.evidence.replySha256).toMatch(/^[a-f0-9]{64}$/);
  const problems = (overrides) => realReplyProblems({ newRuns: [run], newRecords: [record], chiefId: "chief", chiefTasks: [task], descriptor, ...overrides }).problems.join("; ");
  expect(problems({ newRuns: [run, { ...run, id: "run-2" }] })).toContain("exactly one new run");
  expect(problems({ newRuns: [{ ...run, status: "failed" }] })).toContain("run status is failed");
  expect(problems({ newRuns: [{ ...run, botId: "other" }] })).toContain("other than the fixture Chief");
  expect(problems({ newRecords: [{ ...record, runId: "run-9" }] })).toContain("exactly one new delivery");
  expect(problems({ newRecords: [record, { ...record, id: "delivery-2" }] })).toContain("exactly one new delivery");
  expect(problems({ newRecords: [{ ...record, state: "uncertain" }] })).toContain("delivery state is uncertain");
  expect(problems({ newRecords: [{ ...record, response: "hello from fake claude" }] })).toContain("not the run's output");
  expect(problems({ newRuns: [{ ...run, output: undefined }] })).toContain("no model output");
  expect(problems({ chiefTasks: [{ ...task, lastInstanceId: "fixtureClaude" }] })).toContain("another instance");
  expect(problems({ chiefTasks: [{ ...task, modelSelection: { instanceId: "qual-engine", model: "other" } }] })).toContain("modelSelection differs");
  expect(problems({ chiefTasks: [{ ...task, alwaysAllow: ["Bash"] }] })).toContain("remembered grants");
  expect(problems({ chiefTasks: [] })).toContain("one Chief task");
});


it("an early Yes compacts the ack; its receipt must never pass the pairing step by count alone", async () => {
  // Real durable receipt lifecycle, fake transport, no server/network/credentials.
  const root = mkdtempSync(join(tmpdir(), "murage-review-receipt-"));
  const file = join(root, "receipts.json"), sends = [], runs = [];
  const ack = "Discord is paired with Murage. Before chatting, link this channel account in Murage Settings → Memory. Then send your message again.";
  const review = "Review approvals in Murage. Discord messages cannot approve actions.";
  const ledger = new DurableDelivery({ file, bindingKey: "binding", recipient: "dm", isCurrent: () => true,
    runs: { enqueue(input) { runs.push(input); return { id: "unexpected-run" }; }, result() { return null; } },
    send: async ({ recipient, text }) => { sends.push(text); return { recipient, messageId: `message-${sends.length}` }; },
  });
  const records = () => JSON.parse(readFileSync(file, "utf8")).records.map(r => ({ id: r.deliveryId, state: r.state, response: r.response }));
  const captured = new Map(), controller = new AbortController(), errors = [];
  const stop = startReceiptCapture(() => { for (const record of records()) captured.set(record.id, record); }, error => errors.push(error), controller.signal, 5);
  try {
    ledger.accept({ deliveryId: "pair", prompt: "", response: ack, occurredAt: Date.now() });
    await ledger.drain();
    expect(expectedReplyProblems(records(), ack)).toEqual([]);
    // Simulate waiting at the operator prompt while sampling remains active.
    await abortableSleep(20, controller.signal);
    const beforeReview = new Set(captured.keys());
    expect(beforeReview).toEqual(new Set(["pair"]));
    // Owner sends Yes before runner samples the pairing receipt.
    ledger.accept({ deliveryId: "review", ...discordPrompt("Yes"), occurredAt: Date.now() });
    await ledger.drain();
    await abortableSleep(20, controller.signal);
    expect(sends).toEqual([ack, review]);
    expect(expectedReplyProblems([...captured.values()].filter(r => !beforeReview.has(r.id)), review)).toEqual([]);
    expect(captured.get("pair")).toMatchObject({ state: "sent", response: ack });
    expect(runs).toEqual([]);
    expect(records()).toEqual([{ id: "review", state: "sent", response: review }]);
    expect(expectedReplyProblems(records(), ack)).toEqual(["receipt response does not match the requested step"]);
    expect(expectedReplyProblems(records(), review)).toEqual([]);
    expect(expectedReplyProblems([], review)).not.toEqual([]);
    expect(expectedReplyProblems([...records(), ...records()], review)).not.toEqual([]);
    const diagnostics = receiptDiagnostics(records());
    expect(diagnostics).toEqual([{ idSha256: expect.stringMatching(/^[a-f0-9]{64}$/), state: "sent",
      responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/), responseLength: review.length }]);
    expect(JSON.stringify(diagnostics)).not.toContain(review);
    controller.abort();
    captured.clear();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(captured.size).toBe(0);
    // Initial absent ledger is deliberately created below; no error after it exists.
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe("ENOENT");
  } finally { stop(); ledger.stop(); rmSync(root, { recursive: true, force: true }); }
});

// Actual isolated server, mounted permission host and scripted provider SDK.
// No model credentials, network or synthetic permission acceptance.
it.each(["slack", "discord"])("optional %s button phase reaches actual permission host through provider taps", async platform => {
  const { slackSpec, discordSpec, prepareButtonPilot, buttonDecisions, buttonTaskProblems } = await import("./channel-live-providers.ts");
  const { createHarness, promoteFixtureChief, linkChannelOwner, waitFor, sleep } = await import("./channel-live-harness.ts");
  const spec = platform === "slack" ? slackSpec() : discordSpec();
  const evidenceDir = mkdtempSync(join(tmpdir(), `murage-button-test-${platform}-`));
  const traces = [];
  let phase = false;
  const harness = await createHarness({ label: `button-${platform}`, evidenceDir, preload: spec.preload, ipc: true,
    env: () => phase ? { MURAGE_CHANNEL_BUTTON_FIXTURE: "1" } : {}, secretEnv: () => spec.tokens });
  harness.onMessage(trace => { if (trace?.kind === spec.traceKind) traces.push(trace); });
  const sends = () => traces.filter(trace => trace.op === "send");
  const cards = () => sends().filter(trace => trace.blocks?.some(block => block.type === "actions") || trace.components?.length);
  const runs = async () => (await harness.request("GET", "/api/routines")).body.runs.filter(run => run.channelOrigin?.platform === platform);
  const event = (id, text) => harness.child().send({ kind: spec.eventKind, body: spec.body(id, text, spec.owner, spec.dm) });
  try {
    await harness.boot();
    const chief = await promoteFixtureChief(harness, "Button qualification Chief");
    expect((await harness.request("PATCH", "/api/config?secretStorage=external", spec.save)).status).toBe(200);
    const pairing = await harness.request("POST", `/api/${platform}/pair`, { targetBotId: chief.id });
    event("EvPAIR", `${platform === "slack" ? "pair" : "/pair"} ${pairing.body.code}`);
    await waitFor("paired", async () => (await harness.request("GET", `/api/${platform}/status`)).body.paired, Boolean);
    await linkChannelOwner(harness, platform, spec.owner);
    await prepareButtonPilot(harness, chief.id, () => { phase = true; });
    await waitFor("resumed", async () => (await harness.request("GET", `/api/${platform}/status`)).body.state, value => value === "connected");
    for (const [index, behavior] of ["allow", "deny"].entries()) {
      event(`EvPERMISSION${index}`, `Qualification permission request: ${behavior}.`);
      await waitFor("actual permission card", cards, list => list.length === index + 1, 30000);
      const card = cards()[index];
      const records = buttonDecisions(harness.data);
      expect(records).toHaveLength(index * 2 + 1);
      expect(records.at(-1).phase).toBe("requested");
      const run = (await runs()).at(-1);
      expect(buttonTaskProblems(harness.data, chief.id, run)).toEqual([]);
      const actionId = platform === "slack" ? card.blocks.find(block => block.type === "actions").elements[index].action_id : card.components[0].components[index].custom_id;
      const body = platform === "slack" ? { type: "block_actions", api_app_id: "APP", team: { id: "TEAM" }, user: { id: spec.owner },
        channel: { id: spec.dm }, message: { ts: card.messageId, user: "UBOT", bot_id: "BOT" },
        container: { type: "message", channel_id: spec.dm, message_ts: card.messageId }, actions: [{ type: "button", action_id: actionId }] }
        : { guildId: null, channel: { type: 1 }, applicationId: "11", user: { id: spec.owner, bot: false }, channelId: spec.dm,
          message: { id: card.messageId, author: { id: "12" } }, customId: actionId };
      harness.child().send({ kind: `${platform}-fixture-action`, eventId: `tap-${index}`, body });
      await waitFor("actual host decision", () => buttonDecisions(harness.data), list => list.length === (index + 1) * 2, 20000);
      expect(buttonDecisions(harness.data).at(-1)).toMatchObject({ phase: "resolved", behavior, id: records.at(-1).id });
      await waitFor("result reply", sends, list => list.some(item => item.text === `Qualification permission ${behavior === "allow" ? "allowed once" : "denied"}; no tool was executed.`), 30000);
      await waitFor("card edit", () => traces.filter(trace => trace.op === "edit"), list => list.length === index + 1);
      expect(buttonTaskProblems(harness.data, chief.id, run)).toEqual([]);
    }
    await sleep(500);
    expect(cards()).toHaveLength(2);
    expect(traces.filter(trace => trace.op === "edit")).toHaveLength(2);
    expect(buttonDecisions(harness.data)).toHaveLength(4);
    expect(await runs()).toHaveLength(2);
  } finally { await harness.close(); }
}, 120000);

it("button opt-in refuses insufficient budgets and leaves the default sequence unchanged", async () => {
  const { buttonPilotProblems } = await import("./channel-live-providers.ts");
  const limits = { maxOperatorMessages: 7, maxOutboundMessages: 8, maxMinutes: 30 };
  expect(buttonPilotProblems("slack", limits, "yes")).toEqual([]);
  expect(buttonPilotProblems("slack", { ...limits, maxOutboundMessages: 4 }, "yes")).toContain("button pilot outbound budget is too small");
  expect(buttonPilotProblems("slack", { ...limits, maxMinutes: 45 }, "yes")).toContain("button pilot must be capped at 30 minutes");
  expect(buttonPilotProblems("slack", { maxOperatorMessages: 5, maxOutboundMessages: 4, maxMinutes: 45 })).toEqual([]);
  expect(buttonPilotProblems("slack", limits, "no")).toEqual(["--buttons must equal yes"]);
});


it("fixture folder trust: actual channel host gate is answered only for the canonical generated task folder", async () => {
  const { mkdirSync, writeFileSync, realpathSync, symlinkSync } = await import("node:fs");
  const { createHarness, promoteFixtureChief, linkChannelOwner, waitFor } = await import("./channel-live-harness.ts");
  const { slackSpec, handleFixtureReplySetup, fixtureFolderTrustProblems, LiveStop } = await import("./channel-live-providers.ts");
  const spec = slackSpec(), traces = [];
  const evidenceDir = mkdtempSync(join(tmpdir(), "murage-folder-setup-test-"));
  const fixtureEngine = { instanceId: "fixtureTrust", driver: "fuigoAgent", config: { cli: join(ROOT, "server/testing/fake-acp-cli.ts"), fullAuto: false } };
  const harness = await createHarness({ label: "folder-setup", evidenceDir, engine: fixtureEngine, preload: spec.preload, ipc: true,
    env: () => ({ FAKE_ACP_MODE: "folder-trust", FAKE_ACP_DUMP: join(harness.root, "acp.json") }), secretEnv: () => spec.tokens });
  const event = (id, text) => harness.child().send({ kind: spec.eventKind, body: spec.body(id, text, spec.owner, spec.dm) });
  const runs = async () => (await harness.request("GET", "/api/routines")).body.runs.filter(run => run.channelOrigin?.platform === "slack");
  harness.onMessage(trace => { if (trace?.kind === spec.traceKind) traces.push(trace); });
  try {
    mkdirSync(join(harness.root, ".fuigo"), { recursive: true });
    writeFileSync(join(harness.root, ".fuigo/auth.json"), "{}", { mode: 0o600 });
    await harness.boot();
    const chief = await promoteFixtureChief(harness, "Folder setup Chief", { instanceId: fixtureEngine.instanceId, model: "fake-acp-model" },
      { autoApprove: false, autoReview: "off", alwaysAllow: [], browser: false, composio: false });
    expect((await harness.request("PATCH", "/api/config?secretStorage=external", spec.save)).status).toBe(200);
    const pairing = await harness.request("POST", "/api/slack/pair", { targetBotId: chief.id });
    event("EvPAIR", `pair ${pairing.body.code}`);
    await waitFor("paired", async () => (await harness.request("GET", "/api/slack/status")).body.paired, Boolean);
    await linkChannelOwner(harness, "slack", spec.owner);
    const before = new Set((await runs()).map(run => run.id));
    event("EvTRUST", "Qualification request one: reply once.");
    const run = await waitFor("channel thread", async () => (await runs()).find(run => !before.has(run.id)), run => Boolean(run?.threadId));
    const messages = async () => (await harness.request("GET", `/api/threads/${run.threadId}/messages?limit=200`)).body.messages;
    const card = await waitFor("actual host folderTrust card", async () => (await messages()).find(message => message.card?.folderTrust && !message.card.answered), Boolean, 20000);
    const bots = JSON.parse(readFileSync(join(harness.data, "bots.json"), "utf8"));
    const bot = (Array.isArray(bots) ? bots : bots.bots).find(bot => bot.id === chief.id);
    const task = bot.tasks.find(task => task.threadId === run.threadId);
    expect(card.card.folderTrust.sources.sort()).toEqual([".agents/skills", ".claude/skills"]);
    expect(fixtureFolderTrustProblems(harness, chief.id, run, task, card.card)).toEqual([]);
    expect(fixtureFolderTrustProblems(harness, "other-chief", run, task, card.card)).not.toEqual([]);
    expect(fixtureFolderTrustProblems(harness, chief.id, run, task, { ...card.card, folderTrust: { ...card.card.folderTrust, sources: ["AGENTS.md"] } })).not.toEqual([]);
    expect(fixtureFolderTrustProblems(harness, chief.id, run, task, { ...card.card, folderTrust: { ...card.card.folderTrust, folder: harness.root } })).not.toEqual([]);
    expect(fixtureFolderTrustProblems(harness, chief.id, run, { ...task, alwaysAllow: ["Bash"] }, card.card)).not.toEqual([]);
    const escaped = join(task.cwd, ".agents/skills/unowned");
    symlinkSync(harness.root, escaped);
    expect(fixtureFolderTrustProblems(harness, chief.id, run, task, card.card)).not.toEqual([]);
    rmSync(escaped);
    // Refusal uses the exact captured host request; no POST may occur on wrong-instance authority.
    await expect(handleFixtureReplySetup(harness, "slack", chief.id, before, "other-engine", new Set())).rejects.toBeInstanceOf(LiveStop);
    expect((await messages()).find(message => message.id === card.id).card.answered).toBeUndefined();
    const handled = new Set();
    await handleFixtureReplySetup(harness, "slack", chief.id, before, fixtureEngine.instanceId, handled);
    expect(handled.size).toBe(1);
    await waitFor("one completed channel reply", async () => ({ run: (await runs()).find(item => item.id === run.id), sends: traces.filter(trace => trace.op === "send") }),
      state => state.run?.status === "completed" && state.sends.length >= 2, 30000);
    const settled = (await messages()).find(message => message.id === card.id);
    expect(settled.card).toMatchObject({ answered: "answer", answers: [{ id: "folderTrust", selected: ["Trust this folder"] }] });
    const record = await harness.request("GET", `/api/folder-trust?folder=${encodeURIComponent(realpathSync(task.cwd))}`);
    expect(record.body.record).toMatchObject({ decision: "trust", source: "card" });
    const dump = JSON.parse(readFileSync(join(harness.root, "acp.json"), "utf8"));
    expect(dump.argv).toContain("--trust");
    expect(traces.filter(trace => trace.op === "send")).toHaveLength(2);
    const after = JSON.parse(readFileSync(join(harness.data, "bots.json"), "utf8"));
    const afterBot = (Array.isArray(after) ? after : after.bots).find(bot => bot.id === chief.id);
    expect(afterBot.tasks.find(task => task.threadId === run.threadId).alwaysAllow ?? []).toEqual([]);
    await handleFixtureReplySetup(harness, "slack", chief.id, before, fixtureEngine.instanceId, handled);
    expect(handled.size).toBe(1);
  } finally { await harness.close(); }
}, 90000);
