import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { Store, type Message } from "./store.ts";
import { checkReplyActions, toolAction } from "./reply-action-guard.ts";
import { renderDriverReplay, replayMetadata } from "./turn-context.ts";
import { plainConnectedAppText } from "../shared/connected-app-tools.ts";
import { engineStamp } from "./engine-profile.ts";
import { memberTurnProvenance, turnIsBackground } from "./message-automation.ts";
import { isLiveRoutineRunStatus } from "./routines.ts";

/** Execute the production event fold with isolated storage and inert outside
 * services. This is a behavior test, not a census of source substrings. */
function foldFixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "one" }));
  const bot = store.createBot({}, { seedMessages: false });
  const instance = { instanceId: "fixture", driverKind: "fixture", adapter: { capabilities: {} }, models: { default: "one", options: [{ id: "one", contextWindow: 1000 }, { id: "reported", contextWindow: 5000 }] } } as any;
  const stamp = engineStamp(instance, "one");
  const stamps = new Map([[bot.threadId, stamp]]);
  const noop = () => undefined;
  const scope: Record<string, unknown> = {
    store, toolAction, engineStamp, plainConnectedAppMessage: (row: unknown) => row,
    accountProjectEvent: noop, shouldIgnoreProviderEvent: () => false, replyGuardContext: () => null,
    accountPresentedProjectEvent: () => true, presentedRequests: { publish: noop },
    localVmThreadTargets: new Map(), groupGoalCoordinatorTurns: new Map(), groupGoalCoordinatorTurnForEvent: () => null,
    liveSubtasks: new Map(), broadcast: noop, routines: undefined, botForDirectThread: () => bot,
    groupSpeakers: new Map(), turnEngineByThread: stamps, memoryDispatches: new Map(),
    toolMessageByItem: new Map(), toolRowByItem: new Map(), narrateTool: () => "Sending", screenTouchingTool: () => false,
    turnOutputRoots: new Map(), isMemoryProvenanceEcho: () => false, lastReply: new Map(), sessionAudienceByThread: new Map(), registry: { get: () => instance },
    isUnattended: () => false, exactAllowKeyFor: noop, routineRunLevel: () => null,
    routinePeerSources: new Map(), routinePeerApprover: (value: unknown) => value,
    questionFromChoices: (summary: string, choices: string[]) => ({ question: summary, options: choices }),
    lowRiskStamp: () => ({}), askMessageByRequest: new Map(), resolveAutoReviewMode: () => "off",
    appendDecision: noop, DATA_DIR: "fixture", workAdmission: { liveTurns: () => [] }, notify: noop, buildNotification: noop,
  };
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const plainStart = source.indexOf("function plainConnectedAppMessage");
  scope.plainConnectedAppMessage = runInNewContext(stripTypeScriptTypes(source.slice(plainStart, source.indexOf('const SETUP_TASK_TITLE', plainStart))) + "\nplainConnectedAppMessage;", { plainConnectedAppText });
  const start = source.indexOf("const foldRuntimeEvent =");
  const end = source.indexOf("\nbus.subscribe(foldRuntimeEvent)", start);
  const code = stripTypeScriptTypes(source.slice(start, end)) + "\nfoldRuntimeEvent;";
  const fold = runInNewContext(code, scope) as (event: Record<string, unknown>) => void;
  return { store, bot, fold, stamps, instance, scope };
}

it("F3 production fold stamps tool start, completion and options rows for the guard", () => {
  const { store, bot, fold } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", providerInstanceId: "fixture", eventId: "event" };
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "tool", title: "send_message" });
  const started = store.activePath(bot.threadId).at(-1)!;
  expect(started.turnId).toBe("turn"); expect(started.tool?.action?.outcome).toBe("pending");
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "tool", ok: true });
  expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ turnId: "turn", tool: { ok: true, action: { classes: ["send"], outcome: "completed" } } });
  fold({ ...base, type: "request.opened", requestType: "question", requestId: "question", summary: "Which format?", choices: ["Short", "Long"] });
  expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ kind: "options", turnId: "turn" });
  fold({ ...base, type: "item.completed", itemType: "assistant_text", text: "I sent it." });
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "ask", title: "mcp__team__ask_bot" });
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "ask", ok: true });
  expect(store.activePath(bot.threadId).at(-1)).toMatchObject({ turnId: "turn", tool: { action: { classes: ["send", "delegate"], outcome: "completed" } } });
  const reply = store.markTerminalAssistantMessage(bot.threadId, "turn")!;
  expect(checkReplyActions({ reply, path: store.activePath(bot.threadId) }).state).toBe("recorded");
});

it("F10 reported model updates the capability hash used by subsequent folded rows", () => {
  const { store, bot, fold, instance } = foldFixture();
  fold({ type: "session.started", threadId: bot.threadId, turnId: "turn", providerInstanceId: "fixture", model: "reported" });
  fold({ type: "item.started", itemType: "tool", threadId: bot.threadId, turnId: "turn", title: "write_file" });
  expect(store.activePath(bot.threadId).at(-1)?.engine).toEqual(engineStamp(instance, "reported"));
});

it("F10 a delayed final screen frame retains the settled turn's immutable provenance", async () => {
  const { store, bot, stamps } = foldFixture();
  const engine = stamps.get(bot.threadId)!;
  const last = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "done", turnId: "old" });
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const code = source.match(/void finalScreenFrame\(bot\.id, event.threadId\)\.then\([\s\S]*?\}\)\.finally\([^\n]+/u)![0];
  let release!: (frame: { png: string; mime: string }) => void;
  const promise = new Promise<{ png: string; mime: string }>(resolve => { release = resolve; });
  runInNewContext(stripTypeScriptTypes(code), { store, bot, event: { threadId: bot.threadId }, eventEngine: engine, completedTurnId: "old", settleLeafId: last.id, group: undefined, finalScreenFrame: () => promise, clearVpsTurn: () => {}, settleDirect: () => {} });
  stamps.set(bot.threadId, { ...engine, instanceId: "new" });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "next" });
  release({ png: "fixture", mime: "image/png" }); await promise; await Promise.resolve();
  expect(store.messagesFor(bot.threadId).find(row => row.kind === "screen")).toMatchObject({ engine, turnId: "old" });
});

it("F2 resumes held requests through their original dispatcher after authority revalidation", async () => {
  const { store, bot } = foldFixture();
  const principal = { kind: "owner", personId: "owner" };
  const options = { eventId: "original-budget", routineAuthority: { permissionMode: "ask", triggerSource: "schedule" }, unattended: true, notOwnerAudience: true, continuationPermissionMode: "ask" };
  store.holdTaskContinuation(bot.id, bot.threadId, "ROUTINE_REQUEST", { id: "request", dispatcher: "direct", principal: JSON.stringify(principal), runId: "original-run", options });
  store.setTaskAutomationEvent(bot.id, bot.threadId, "owner-budget");
  const calls: unknown[][] = [];
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("const heldDispatches =");
  const end = source.indexOf("\nstore.onChange(change =>", start);
  const scope = { store, roomEngine: { ready: true }, registry: { get: () => ({ adapter: { capabilities: { agentsMcp: true } } }) }, routeHasTools: () => true,
    threadHumanPrincipal: () => principal, routines: { listRuns: () => [{ id: "original-run", threadId: bot.threadId, status: "waiting" }], getEventBudget: () => ({ closed: false }) },
    startTurn: async (...args: unknown[]) => { calls.push(args); }, startCardContinuation: async () => { throw new Error("wrong dispatcher"); }, noteHeldQueue: () => {} };
  const drain = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\ndrainHeldContinuations;", scope);
  await drain(bot.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual([bot.id, "ROUTINE_REQUEST", expect.objectContaining({ ...options, heldContinuationId: "request", cardContinuation: true })]);
  (scope.routines.listRuns as () => unknown[]) = () => [];
  await drain(bot.id);
  expect(calls).toHaveLength(1);
  expect(store.taskByThread(bot.id, bot.threadId)?.heldContinuations?.[0].error).toContain("original routine run");
});

it.each(["bot", "project"])("skips a held %s route with no model selection and can resume later", async route => {
  const { store, bot } = foldFixture();
  const principal = { kind: "owner", personId: "owner" };
  store.holdTaskContinuation(bot.id, bot.threadId, "HELD_REQUEST", {
    id: "held", dispatcher: "direct", principal: JSON.stringify(principal),
  });
  const selection = bot.modelSelection;
  const routeBot = route === "bot" ? bot : { ...bot };
  Reflect.deleteProperty(routeBot, "modelSelection");
  const projection = vi.spyOn(store, "projectBotForTask").mockReturnValue(route === "project" ? routeBot : null);
  const get = vi.fn(() => ({ adapter: { capabilities: { agentsMcp: true } } }));
  const startTurn = vi.fn(async () => {});
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("const heldDispatches =");
  const end = source.indexOf("\nstore.onChange(change =>", start);
  const drain = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\ndrainHeldContinuations;", {
    store, roomEngine: { ready: true }, registry: { get }, routeHasTools: () => true,
    threadHumanPrincipal: () => principal, startTurn, noteHeldQueue: () => {},
  });
  try {
    await expect(drain(bot.id)).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(store.continuationHolder(bot.id, bot.threadId)?.heldContinuations).toEqual([
      expect.objectContaining({ id: "held", text: "HELD_REQUEST" }),
    ]);
    expect(store.continuationHolder(bot.id, bot.threadId)?.heldContinuations?.[0].error).toBeUndefined();
    routeBot.modelSelection = selection;
    await drain(bot.id);
    expect(startTurn).toHaveBeenCalledWith(bot.id, "HELD_REQUEST", expect.objectContaining({ heldContinuationId: "held" }));
  } finally { projection.mockRestore(); }
});

it("F7 production ACP recovery preserves headers, omissions and the continuity rule", () => {
  const source = readFileSync(new URL("./drivers/acp/core.ts", import.meta.url), "utf8");
  const start = source.indexOf("const replayTurn =");
  const end = source.indexOf("const replayGrokTurn", start);
  const turn = { text: "latest", transcript: [{ role: "assistant", text: "away", header: "[Written on Engine B.]" }], replayMetadata: replayMetadata(5) };
  const replay = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\nreplayTurn;", { turn, renderDriverReplay })("[Recovery]");
  expect(replay.text).toContain("5 earlier lines"); expect(replay.text).toContain("Written on Engine B"); expect(replay.text).toContain("do not restate");
});

it("F1 room card continuations stay in a visible durable queue before prompt construction", async () => {
  const { store, bot } = foldFixture();
  const group = store.createGroup("Room fixture", [bot.id]);
  const card = store.appendMessage(group.threadId, { role: "bot", kind: "options", card: { title: "Request", subtitle: "Continue this request", options: ["Continue"], requestId: "room-card" } });
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function startCardContinuation(");
  const end = source.indexOf("\n/** T22", start);
  const queueStart = source.indexOf("function noteHeldQueue(");
  const queueEnd = source.indexOf("\nconst heldDispatches", queueStart);
  const scope = { store, connectorThread: () => ({ bot, group }), registry: { get: () => ({ adapter: { capabilities: {} } }) },
    routeHasTools: () => false, threadHumanPrincipal: () => ({ kind: "owner" }), routines: { listRuns: () => [] },
    botPermissionMode: () => "ask", routinePeerSource: () => undefined, turnSessionAudience: () => "original-room-audience", latestRoomUserMessage: () => ({ origin: "desktop" }),
    heldQueueText: (count: number) => `Waiting for a tool-capable engine: ${count} item(s). Open now`,
    runGroupMemberTurn: () => { throw new Error("A held request reached the room engine"); } };
  const run = runInNewContext(stripTypeScriptTypes(source.slice(queueStart, queueEnd) + source.slice(start, end)) + "\nstartCardContinuation;", scope);
  await run(bot.id, group.threadId, "ROOM_ACTION_CANARY", undefined, card.id);
  await run(bot.id, group.threadId, "ROOM_ACTION_CANARY", undefined, card.id);
  const held = store.continuationHolder(bot.id, group.threadId)?.heldContinuations!;
  expect(held).toHaveLength(1); expect(held[0]).toMatchObject({ dispatcher: "room", cardId: card.id, options: { roomAudience: "original-room-audience", continuationPermissionMode: "ask" } });
  const queued = store.activePath(group.threadId).find(row => row.murage?.held);
  expect(queued?.murage?.held).toMatchObject({ count: 1, items: [{ text: "ROOM_ACTION_CANARY", rowId: card.id }] });
  expect(store.activePath(group.threadId).find(row => row.id === card.id)?.card?.held).toContain("Waiting");
});

it("F11 room continuation admission preserves the originating connection card", async () => {
  const { store, bot } = foldFixture();
  const group = store.createGroup("Connection room", [bot.id]);
  const original = store.appendMessage(group.threadId, { role: "bot", kind: "activity", text: "Original connection" });
  store.appendMessage(group.threadId, { role: "bot", kind: "options", card: { title: "Other request", subtitle: "Unrelated", options: [], requestId: "other" } });
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function runGroupMemberTurn(");
  const end = source.indexOf("  // One admission arbiter", start);
  // the real provenance seam: a room turn is told its automation by memberTurnAutomation, so it is extracted, not stubbed
  const memberStart = source.indexOf("function memberTurnAutomation(");
  const memberEnd = source.indexOf("/** The message the owner pinned", memberStart);
  const scope = { store, memberTurnProvenance, turnIsBackground, isLiveRoutineRunStatus, backupRestartAdmission: { held: () => false }, routineRunLevel: () => null, roomRounds: new Map(), cfg: {},
    registry: { get: () => ({ adapter: { capabilities: {} } }) }, routeHasTools: () => false,
    threadHumanPrincipal: () => ({ kind: "owner" }), routines: { listRuns: () => [] },
    botPermissionMode: () => "ask", routinePeerSource: () => undefined, turnSessionAudience: () => "audience", latestRoomUserMessage: () => undefined, noteHeldQueue: () => {} };
  const run = runInNewContext(stripTypeScriptTypes(source.slice(memberStart, memberEnd) + source.slice(start, end) + "\n}") + "\nrunGroupMemberTurn;", scope);
  // noMentionChain (mobile lane) precedes memoryRedispatch, heldContinuation and continuationCardId
  expect(await run(group.id, group.threadId, bot.id, 0, new Set(), "Continue", undefined, undefined, undefined, undefined, undefined, undefined, false, false, undefined, original.id)).toBe(false);
  expect(store.continuationHolder(bot.id, group.threadId)?.heldContinuations?.[0].cardId).toBe(original.id);
});

it.each(["GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"])("N3 production fold records %s and wrapper outcomes", name => {
  const { store, bot, fold } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", providerInstanceId: "fixture", eventId: "event" };
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "direct", title: name });
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "direct", ok: true });
  expect(store.activePath(bot.threadId).at(-1)?.tool?.action).toMatchObject({ classes: ["send"], outcome: "completed" });
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "wrapper", title: readFileSync(new URL("./routine-brief-approval-diagnosis.test.ts", import.meta.url), "utf8").match(/\b[A-Z]+_MULTI_EXECUTE_TOOL\b/)![0], input: { tools: [{ tool_slug: name }] } });
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "wrapper", ok: true, result: { results: [{ tool_slug: name, response: { successful: true } }] } });
  expect(store.activePath(bot.threadId).at(-1)?.tool?.action).toMatchObject({ classes: ["send"], outcome: "completed", operations: [{ name, outcome: "completed" }] });
});

it.each(["pi", "codex", "acp"])("N9/N10 %s production events preserve action evidence through the fold", async (engine) => {
  const { PiDriver } = await import("./drivers/pi.ts");
  const { CodexDriver } = await import("./drivers/codex.ts");
  const { createAcpDriver } = await import("./drivers/acp/core.ts");
  const { recordEvents } = await import("./testing/events.ts");
  const { ensureDirs } = await import("./config.ts");
  ensureDirs();
  const acp = createAcpDriver({ driverKind: "guardFixture", displayName: "Guard fixture", defaultCli: "fixture",
    nativeSource: "fixture.acp", models: { default: "one", options: [{ id: "one", label: "One" }] },
    loginNote: "fixture", spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true });
  const driver = engine === "pi" ? PiDriver : engine === "codex" ? CodexDriver : acp;
  // fileURLToPath, not URL.pathname: on Windows a pathname is "/D:/..." and the fake CLI never starts
  const cli = fileURLToPath(new URL(`./testing/fake-${engine === "codex" ? "codex-app-server" : engine + "-cli"}.ts`, import.meta.url));
  const instance = await driver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true,
    environment: { [`FAKE_${engine.toUpperCase()}_MODE`]: "action-guard" }, config: { cli, fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  try {
    const { store, bot, fold } = foldFixture();
    const { turnId } = await instance.adapter.sendTurn({ threadId: bot.threadId, text: "fixture", cwd: process.env.HOME });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    for (const event of recorder.events) if ((event.type === "item.started" || event.type === "item.completed") && event.itemType === "tool") fold(event as unknown as Record<string, unknown>);
    const action = store.activePath(bot.threadId).find(row => row.tool?.action?.name !== "web_search")?.tool?.action;
    if (engine === "pi") {
      expect(action?.operations).toMatchObject([{ name: "GMAIL_SEND_EMAIL", outcome: "completed" }, { name: "GMAIL_SEND_EMAIL", outcome: "failed" }]);
    } else {
      expect(action).toMatchObject({ name: "shell", outcome: "opaque", classes: ["save", "change", "run"] });
      expect(store.activePath(bot.threadId)[0]?.tool?.name).toBe("printf hello > notes.txt");
    }
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", turnId,
      text: "I saved the file. I changed it. I ran tests. I sent it. I paid it. I delegated it." });
    const claims = checkReplyActions({ reply, path: store.activePath(bot.threadId) }).claims;
    expect(claims.map(claim => claim.state)).toEqual(engine === "pi"
      ? ["flagged", "flagged", "flagged", "recorded", "flagged", "flagged"]
      : ["unverifiable", "unverifiable", "unverifiable", "flagged", "flagged", "flagged"]);
  } finally { recorder.stop(); await instance.dispose(); }
});

it("N11 the production fold retains wrapper call identities for reordered receipts", () => {
  const { store, bot, fold } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", itemType: "tool", itemId: "wrapper" };
  fold({ ...base, type: "item.started", title: "MULTI_EXECUTE_TOOL", input: { tools: [
    { tool_slug: "GMAIL_SEND_EMAIL", call_id: "first" }, { tool_slug: "GMAIL_SEND_EMAIL", call_id: "second" },
  ] } });
  fold({ ...base, type: "item.completed", ok: true, result: { results: [
    { tool_slug: "GMAIL_SEND_EMAIL", call_id: "second", response: { successful: false } },
    { tool_slug: "GMAIL_SEND_EMAIL", call_id: "first", response: { successful: true } },
  ] } });
  expect(store.activePath(bot.threadId).at(-1)?.tool?.action?.operations).toMatchObject([
    { callId: "first", outcome: "completed" }, { callId: "second", outcome: "failed" },
  ]);
});


it("N10 an ACP execute kind remains shell evidence with a stamped engine tool name", () => {
  const { store, bot, fold } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", itemType: "tool", itemId: "shell" };
  fold({ ...base, type: "item.started", title: "printf hello > notes.txt", toolKind: "execute", toolIdentity: { namespace: "engine", name: "run_shell_command" } });
  fold({ ...base, type: "item.completed", ok: true, result: { exitCode: 0 } });
  expect(store.activePath(bot.threadId).at(-1)?.tool?.action).toMatchObject({ name: "shell", outcome: "opaque", classes: ["save", "change", "run"] });
});

/** Fuigo hosted tools (web_search and the like) through the production fold:
 * what is saved, and what a reload reads, is text before the row, the row,
 * text after it. */
describe("Fuigo hosted tool rows in the saved transcript", () => {
  const transcript = async (variant: string) => {
    const { createAcpDriver } = await import("./drivers/acp/core.ts");
    const { recordEvents } = await import("./testing/events.ts");
    const { ensureDirs } = await import("./config.ts");
    ensureDirs();
    const driver = createAcpDriver({ driverKind: "hostedFixture", displayName: "Hosted fixture", defaultCli: "fixture",
      nativeSource: "fuigo.acp", models: { default: "one", options: [{ id: "one", label: "One" }] },
      loginNote: "fixture", spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true });
    const instance = await driver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true,
      environment: { FAKE_ACP_MODE: `fuigo-retry:disc-${variant}` },
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)), fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    try {
      const { store, bot, fold } = foldFixture();
      await instance.adapter.sendTurn({ threadId: bot.threadId, text: "fixture", cwd: process.env.HOME });
      expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
      for (const event of recorder.events) {
        if (event.type === "item.started" || (event.type === "item.completed" && (event.itemType === "tool" || event.itemType === "assistant_text"))) {
          fold({ ...event, providerInstanceId: "fixture" } as unknown as Record<string, unknown>);
        }
      }
      const shape = (path: Message[]) => path.map(row => row.kind === "text" ? `text:${row.text}` : `row:${row.tool?.name}:${row.tool?.ok === false ? "interrupted" : "ok"}`);
      // a reload reads SQLite afresh: a new store, the same thread
      const reloaded = new Store(() => ({ instanceId: "fixture", model: "one" }));
      return { live: shape(store.activePath(bot.threadId)), reloaded: shape(reloaded.activePath(bot.threadId)) };
    } finally { recorder.stop(); await instance.dispose(); }
  };

  it("an ordinary hosted search saves and reloads as text, row, text", async () => {
    const { live, reloaded } = await transcript("hosted-ok");
    expect(live).toEqual(["text:Let me search.", "row:web_search:ok", "text:Here is what I found."]);
    expect(reloaded).toEqual(live);
  });

  it("two hosted rows in a row: the text reads before the first", async () => {
    const { live, reloaded } = await transcript("hosted-twin");
    expect(live).toEqual(["text:Let me search.", "row:web_search:ok", "row:web_search:ok", "text:Found."]);
    expect(reloaded).toEqual(live);
  });

  it("a discarded attempt: the resend's text shows once, before its row; both rows stay", async () => {
    const { live, reloaded } = await transcript("hosted");
    expect(live).toEqual(["row:web_search:ok", "text:A2", "row:web_search:ok", "text: Answer."]);
    expect(reloaded).toEqual(live);
  });

  it("a client-executed row or an untagged hosted row keeps text, row, text, committed at the row", async () => {
    const { live, reloaded } = await transcript("hosted-local");
    expect(live).toEqual(["text:Let me read.", "row:read:ok", "text:A", "row:web_search:ok", "text:B"]);
    expect(reloaded).toEqual(live);
  });

  it("a retry without discardEmitted keeps text, row, text", async () => {
    const { live, reloaded } = await transcript("hosted-nodiscard");
    expect(live).toEqual(["text:A", "row:web_search:ok", "text:B"]);
    expect(reloaded).toEqual(live);
  });

  it("a discard without streamStartMs ends a row-only attempt's running row interrupted", async () => {
    const { live, reloaded } = await transcript("hosted-rowonly");
    expect(live).toEqual(["row:web_search:interrupted", "row:web_search:ok", "text:A2"]);
    expect(reloaded).toEqual(live);
  });

  it("a discard without streamStartMs leaves a row of an earlier, completed response running", async () => {
    const { live } = await transcript("hosted-rowonly-done");
    expect(live).toEqual(["row:web_search:ok", "text:B"]);
  });

  it("a discard without streamStartMs drops the attempt's text and ends its row interrupted", async () => {
    const { live, reloaded } = await transcript("hosted-epoch");
    expect(live).toEqual(["row:web_search:interrupted", "text:A2"]);
    expect(reloaded).toEqual(live);
  });
});

// 600 rows (past the old 512 anchor cap) are 1,200 folded events, each saved
// in its own committed transaction (synchronous=FULL). That is about 1.5 s on
// Linux and a Windows desktop, but 26 s on a GitHub Windows runner, whose disk
// flushes slowly: the limit covers that runner; the test asserts no timing.
it("a hosted row's lead-in still lands before it after 600 earlier tool rows in the same turn", () => {
  const { store, bot, fold } = foldFixture();
  const base = { threadId: bot.threadId, turnId: "turn", providerInstanceId: "fixture", eventId: "event" };
  for (let index = 0; index < 600; index++) {
    fold({ ...base, type: "item.started", itemType: "tool", itemId: `read-${index}`, title: "read" });
    fold({ ...base, type: "item.completed", itemType: "tool", itemId: `read-${index}`, ok: true });
  }
  fold({ ...base, type: "item.started", itemType: "tool", itemId: "hosted", title: "web_search" });
  fold({ ...base, type: "item.completed", itemType: "tool", itemId: "hosted", ok: true });
  fold({ ...base, type: "item.completed", itemType: "assistant_text", text: "Let me search.", beforeItemId: "hosted" });
  const tail = store.activePath(bot.threadId).slice(-3).map(row => row.kind === "text" ? `text:${row.text}` : `row:${row.tool?.name}`);
  expect(tail).toEqual(["row:read", "text:Let me search.", "row:web_search"]);
}, 120_000);

/** Hosted-row anchors held for a thread, whatever shape the map keeps. */
const heldAnchors = (map: Map<string, unknown>, threadId: string): number => {
  const entry = map.get(threadId) as { rows?: Map<string, string> } & Map<string, string> | undefined;
  return entry ? (entry.rows ?? entry).size : 0;
};

it("a turn that ended without turn.completed leaves no anchors once the thread's next turn starts", () => {
  const { store, bot, fold, scope } = foldFixture();
  const anchors = scope.toolRowByItem as Map<string, unknown>;
  const at = (turnId: string) => ({ threadId: bot.threadId, turnId, providerInstanceId: "fixture", eventId: "event" });
  // turn A: 600 rows, then its provider is reloaded away (no turn.completed)
  for (let index = 0; index < 600; index++) fold({ ...at("a"), type: "item.started", itemType: "tool", itemId: `read-${index}`, title: "read" });
  expect(heldAnchors(anchors, bot.threadId)).toBe(600);
  fold({ ...at("b"), type: "item.started", itemType: "tool", itemId: "hosted", title: "web_search" });
  expect(heldAnchors(anchors, bot.threadId)).toBe(1);
  // turn B's lead-in still anchors to its own row
  fold({ ...at("b"), type: "item.completed", itemType: "assistant_text", text: "Let me search.", beforeItemId: "hosted" });
  expect(store.activePath(bot.threadId).slice(-2).map(row => row.kind)).toEqual(["text", "activity"]);
});

describe("provider reload retires hosted-row anchors", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const slice = (from: string, to: string) => {
    const start = source.indexOf(from);
    return stripTypeScriptTypes(source.slice(start, source.indexOf(to, start)));
  };
  const code = [
    slice("function forgetToolRowAnchors(", "\n/** Every conversation the owner has"),
    slice("async function reloadProviders(", "\n/** The instance a direct run dispatched on"),
    slice("async function reloadScopedProviders(", "\n// Config writes rebuild the whole provider registry."),
  ].join("\n");
  /** Run the production reload with inert services: every name not given
   * here is a no-op function. */
  const reload = async (anchors: Map<string, unknown>, scope?: Set<string>, scopedReload: () => Promise<void> = async () => undefined) => {
    const run = { threadId: "scoped-thread", botId: "bot", snapshot: { modelSelection: { instanceId: "off" } } };
    const given: Record<string, unknown> = {
      toolRowByItem: anchors, providerFleetReady: true, browserSetup: undefined, browserExtension: undefined, cfg: {},
      store: { bots: [{ id: "bot", threadId: "room-thread", busy: false }] },
      directRuns: { forBot: () => [run], current: () => false },
      directRunInstanceId: (entry: typeof run) => entry.snapshot.modelSelection.instanceId,
      projectTurnLeases: { generations: () => [], generationsForThreads: () => [], disposed: () => undefined },
      bus: { detachAll: () => undefined, detach: () => undefined, attach: () => undefined },
      registry: { disposeAll: async () => undefined, load: async () => undefined, reload: scopedReload, instances: () => [] },
      scopedReloadUnsafe: () => false, Set, Promise,
    };
    const context = new Proxy(given, {
      has: () => true,
      get: (target, key) => key in target ? target[key as string] : key === Symbol.unscopables ? undefined : (globalThis as Record<PropertyKey, unknown>)[key] ?? (() => undefined),
    });
    const { reloadProviders } = runInNewContext(code + "\n({ reloadProviders });", context) as { reloadProviders: (scope?: Set<string>) => Promise<void> };
    await reloadProviders(scope);
  };
  const filled = () => new Map<string, unknown>([
    ["room-thread", { turnId: "room", rows: new Map([["ws-1", "row-1"]]) }],
    ["scoped-thread", { turnId: "direct", rows: new Map([["ws-2", "row-2"]]) }],
  ]);

  it("a full reload ends every turn, rooms included, and forgets every anchor", async () => {
    const anchors = filled();
    await reload(anchors);
    expect(anchors.size).toBe(0);
  });

  it("a scoped reload forgets the anchors of the turns it ends, and only those", async () => {
    const anchors = filled();
    await reload(anchors, new Set(["off"]));
    expect([...anchors.keys()]).toEqual(["room-thread"]);
  });

  it("a scoped reload whose disposal is rejected still forgets the anchors of the turns it retired", async () => {
    const anchors = filled();
    await expect(reload(anchors, new Set(["off"]), async () => { throw new Error("dispose failed"); })).rejects.toThrow("dispose failed");
    expect([...anchors.keys()]).toEqual(["room-thread"]);
  });
});
