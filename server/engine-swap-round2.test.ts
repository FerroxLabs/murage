import { readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store, type Message } from "./store.ts";
import { promptRows, planExternalDelivery, deliveredExternalIds } from "./external-context-delivery.ts";
import { turnIsBackground } from "./message-automation.ts";
import { buildTurnContext, fitRenderedReplay } from "./turn-context.ts";
import { replayWindow } from "./memory/disclosures.ts";
import { detectActionClaims } from "../shared/reply-action-claims.ts";
import { checkReplyActions, toolAction } from "./reply-action-guard.ts";
import { routePolicy } from "./route-policy.ts";
import { CONNECTED_APP_TOOLS } from "../shared/bot-access.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function execute(code: string, scope: Record<string, unknown>) { return runInNewContext(stripTypeScriptTypes(code), scope); }
function definition(name: string, end: string) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return "";
  return source.slice(start, source.indexOf(end, start));
}
const noop = () => undefined;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); });
function fixture() {
  const store = new Store(() => ({ instanceId: "a", model: "one" }));
  return { store, bot: store.createBot({}, { seedMessages: false }) };
}

it("N1 queued questions dispatch as questions and tool work resumes the original room request", async () => {
  const { store, bot } = fixture(), group = store.createGroup("Room", [bot.id]);
  const request: any = { id: "original", groupId: group.id, targetThreadId: group.threadId, toBotId: bot.id, verb: "room_turn", state: "running" };
  const pending = new Map(), queues = new Map(), rounds = new Map(), accepted: string[] = [];
  let tools = false;
  const scope: any = { store, turnIsBackground, pendingRoomTurnRequests: pending, groupQueues: queues, roomRounds: rounds,
    roomTurnRequestKey: (thread: string, bot: string) => `${thread}:${bot}`, roomRoots: new Map(),
    registry: { get: () => ({ adapter: { capabilities: { tools } } }) }, routeHasTools: (caps: any) => caps?.tools,
    threadHumanPrincipal: () => "owner", botPermissionMode: () => "ask", database: noop, noteHeldQueue: noop,
    // the pinned-root lookup the mobile lane added to startRoomRequestTurn (no pinned root here)
    roomRequest: () => null,
    requeueRoomRequest: (_db: any, id: string) => { expect(id).toBe(request.id); request.state = "queued"; },
    wakeContinuationPrompt: () => "Continue the action", routineRoomTurnPrompt: (text: string) => text, queuedRoomTurnPrompt: () => "What format?",
    wakeGoalAction: () => null, wakeRedirectText: () => null, markUnattended: noop, clearUnattended: noop,
    queuedRoomTurnHop: () => 0, beginGroupTurnOperation: () => ({ cancelled: false }), finishGroupTurnOperation: noop,
    groupProviderHandshakeStarted: noop, groupProviderHandshakeSettled: noop,
    settleRoomTurnRequest: (thread: string, bot: string) => { if (pending.has(`${thread}:${bot}`)) request.state = "failed"; },
    runGroupMemberTurn: async (...args: any[]) => {
      // Execute the production continuation gate, including the old overloaded argument.
      const gateStart = source.indexOf('  if (', source.indexOf('    murageFailureLine(message);', source.indexOf('async function runGroupMemberTurn')));
      const gateEnd = source.indexOf('  // One admission arbiter', gateStart);
      const held = execute(`(function(){${source.slice(gateStart, gateEnd)} return true;})()`, { ...scope,
        bot, botId: bot.id, threadId: group.threadId, instance: { adapter: { capabilities: { tools } } },
        continuationPrompt: args[5], cardContinuation: args[5], continuationKind: args[16], continuationCardId: undefined, heldContinuation: args[14],
        routines: undefined, routinePeerSource: noop, turnSessionAudience: () => "owner", latestRoomUserMessage: noop, leaveRound: noop });
      if (!held) return false;
      const key = `${group.threadId}:${bot.id}`;
      accepted.push(pending.get(key).requestId); pending.delete(key); request.state = "done";
      // noMentionChain (mobile lane) sits before memoryRedispatch, so the held item is argument 14
      if (args[14]) store.consumeTaskHeldContinuations(bot.id, group.threadId, [args[14].id]);
      return true;
    },
  };
  // the deferred turn is told its provenance by the real queuedRequestAutomation, not a stub
  const code = definition("queuedRequestAutomation", "\n}\n") + "\n}\n" + definition("holdQueuedRoomContinuation", "/** Start a queued member") + definition("startRoomRequestTurn", "/** One writer per project");
  const start = execute(code + "\nstartRoomRequestTurn;", scope);
  const claim = { release: vi.fn() };
  start(request, claim); await queues.get(group.id);
  expect(request.state).toBe("done"); expect(accepted).toEqual(["original"]);
  request.verb = "wake"; request.state = "running"; accepted.length = 0;
  start(request, claim); await queues.get(group.id);
  expect(request.state).toBe("queued"); expect(claim.release).toHaveBeenCalled();
  expect(store.continuationHolder(bot.id, group.threadId)?.heldContinuations?.[0]).toMatchObject({ requestId: "original", dispatcher: "room-request" });
  tools = true; request.state = "running";
  start(request, claim); await queues.get(group.id);
  expect(accepted).toEqual(["original"]); expect(request.state).toBe("done");
  expect(store.continuationHolder(bot.id, group.threadId)?.heldContinuations).toEqual([]);
});

it("N2 final fitting delivers row identities and only delivered debt is consumed", () => {
  const rows = [{ id: "large", role: "assistant" as const, text: "x".repeat(5000) }, { id: "small", role: "assistant" as const, text: "hello" }];
  const fitted = fitRenderedReplay(rows, "a", 0, 1500);
  expect(fitted.transcript.map(row => row.id)).toEqual(["small"]);
  const plan = planExternalDelivery({ pending: rows, branchReplay: { carriedIds: rows.map(row => row.id) } });
  const mixed = planExternalDelivery({ pending: rows, branchReplay: { carriedIds: ["small"] } });
  expect(mixed.preamble).toContain(rows[0].text);

  const replay = source.slice(source.indexOf("  const externalDelivery ="), source.indexOf("  const skillAuthoring =", source.indexOf("  const externalDelivery =")));
  const produced = execute(replay + "\nexternalDelivery;", { planExternalDelivery, turnRouteHasTools: true, task: { externalUpdates: ["large", "small"] }, rewound: true, fresh: true,
    transcript: fitted.transcript, replayedMessages: rows, messagesById: new Map(rows.map(row => [row.id, { ...row, kind: "text" }])), memoryNotOwner: false });
  expect(produced.preamble).toContain(rows[0].text);
  expect(deliveredExternalIds(plan, fitted.transcript)).toEqual(["small"]);
  expect(deliveredExternalIds(mixed, fitted.transcript)).toEqual(["large", "small"]);
});

it.each(CONNECTED_APP_TOOLS.filter(tool => tool.writes).map(tool => tool.tool))("N3 production action %s records completion", name => {
  const reply: Message = { id: "reply", at: 1, role: "bot", kind: "text", text: "I sent it.", turnId: "turn" };
  const row: Message = { id: "action", at: 0, role: "bot", kind: "activity", turnId: "turn", tool: { name: `mcp__apps__${name}`, ok: true } };
  expect(checkReplyActions({ reply, path: [row, reply] }).state).toBe("recorded");
  row.tool!.action = { classes: [], outcome: "pending" };
  expect(checkReplyActions({ reply, path: [row, reply] }).state).toBe("recorded");
  row.tool!.ok = false;
  expect(checkReplyActions({ reply, path: [row, reply] }).state).toBe("flagged");
});
it("N3 wrapper receipts distinguish completed, failed and unreported operations", () => {
  const input = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }, { tool_slug: "SLACK_SEND_MESSAGE" }] };
  const result = { results: [{ tool_slug: "GMAIL_SEND_EMAIL", response: { successful: true } }, { tool_slug: "SLACK_SEND_MESSAGE", response: { successful: false } }] };
  const action = toolAction("apps_MULTI_EXECUTE_TOOL", true, input, result);
  expect(action.classes).toEqual(["send"]);
  expect(action.operations?.map(operation => operation.outcome)).toEqual(["completed", "failed"]);
  expect(toolAction("apps_MULTI_EXECUTE_TOOL", true, input).outcome).toBe("opaque");
  expect(toolAction("GMAIL_SEND_EMAIL", true, undefined, { successful: false }).outcome).toBe("failed");
  expect(toolAction("GMAIL_FETCH_EMAILS", true).classes).toEqual([]);
  expect(toolAction("execute_tool", true, { tool_name: "GMAIL_SEND_EMAIL", arguments: {} }).outcome).toBe("completed");
  const partial = toolAction("apps_MULTI_EXECUTE_TOOL", true, { tools: [{ tool_slug: "write_file" }, { tool_slug: "SLACK_SEND_MESSAGE" }] },
    { results: [{ tool_slug: "write_file", response: { successful: true } }] });
  const reply: Message = { id: "reply", at: 1, role: "bot", kind: "text", text: "I saved the file. I sent it.", turnId: "turn" };
  const tool: Message = { id: "tool", at: 0, role: "bot", kind: "activity", turnId: "turn", tool: { name: "wrapper", action: partial } };
  expect(checkReplyActions({ reply, path: [tool, reply] }).claims.map(claim => claim.state)).toEqual(["recorded", "unverifiable"]);
});

it("N4 primary shared-question delivery remains in tool-less history", () => {
  const { store, bot } = fixture(), target = store.createBot({}, { seedMessages: false });
  const result = store.appendMessage(target.threadId, { role: "bot", kind: "text", text: "Which format?" });
  const deliver = execute(definition("deliverSharedResult", "configureSharedDrain(") + "\ndeliverSharedResult;", { store,
    requestSourceThread: () => bot.threadId, authorizeWork: () => ({ ok: true }), mirrorReply: noop, commsBus: {},
    database: () => ({ prepare: () => ({ run: noop }) }), SHARED_RESULT_DELIVERED: "delivered", recordDelegationReceipt: noop, clearSharedFinishing: noop });
  deliver({ id: "question", toBotId: target.id, targetThreadId: target.threadId, resultMessageId: result.id, verb: "ask", state: "done", admissionKey: "ask:question" });
  expect(promptRows(store.messagesFor(bot.threadId), false).map(row => row.text)).toEqual(["Which format?"]);
});

it.each(["After lunch, I sent it.", "I sent it after lunch.", "I sent it and can send another.", "I sent it and I can send another.", "I sent it without an attachment."])("N5 retains the independent completed claim: %s", text => {
  expect(detectActionClaims(text).claims.map(claim => claim.class)).toEqual(["send"]);
});
it.each(["The file is saved, if you click Save.", "The file is saved if you click Save.", "If I had sent it, you would know.", "I can say I sent it."])("N5 governing conditions and modality remain excluded: %s", text => {
  expect(detectActionClaims(text).claims).toEqual([]);
});

it("N6 dispatch retry revalidates authority and retains identity after a transient failure", async () => {
  const { store, bot } = fixture(); let now = Date.now(), principal = "owner", calls = 0;
  store.holdTaskContinuation(bot.id, bot.threadId, "continue", { id: "held", dispatcher: "direct", principal: JSON.stringify(principal) });
  const drain = execute("const heldDispatches = new Set();\nasync " + definition("drainHeldContinuations", "store.onChange(") + "\ndrainHeldContinuations;", {
    store, roomEngine: { ready: true }, registry: { get: () => ({ adapter: { capabilities: {} } }) }, routeHasTools: () => true,
    threadHumanPrincipal: () => principal, Date: { now: () => now }, noteHeldQueue: noop, routines: undefined,
    startTurn: async (_bot: string, _text: string, opts: any) => { calls++; if (calls === 1) { opts.onDispatchError("Engine is reconnecting."); return; } store.consumeTaskHeldContinuations(bot.id, bot.threadId, [opts.heldContinuationId]); },
  });
  await drain(bot.id);
  expect(store.taskByThread(bot.id, bot.threadId)?.heldContinuations?.[0]).toMatchObject({ id: "held", state: "retry" });
  await drain(bot.id); expect(calls).toBe(1);
  now += 31_000; principal = "changed"; await drain(bot.id); expect(calls).toBe(1);
  expect(store.taskByThread(bot.id, bot.threadId)?.heldContinuations?.[0].state).toBe("authority");
  principal = "owner"; store.holdTaskContinuation(bot.id, bot.threadId, "continue", { id: "held", state: "ready", error: undefined, retryAt: undefined });
  await drain(bot.id); expect(calls).toBe(2); expect(store.taskByThread(bot.id, bot.threadId)?.heldContinuations).toEqual([]);
});

it("N7 persisted legacy entries require explicit owner recovery and can be reauthorized", async () => {
  const { store, bot } = fixture();
  store.holdTaskContinuation(bot.id, bot.threadId, "saved instruction", { id: "legacy" });
  const entry = store.taskByThread(bot.id, bot.threadId)!.heldContinuations![0];
  delete entry.botId; store.patchBot(bot.id, { name: "Saved" });
  const restarted = new Store(() => ({ instanceId: "a", model: "one" }));
  expect(restarted.taskByThread(bot.id, bot.threadId)?.heldContinuations?.[0]).toMatchObject({ id: "legacy", botId: bot.id, state: "recovery" });
  expect(routePolicy("POST", `/api/bots/${bot.id}/held-continuations/legacy/retry`)?.class).toBe("desktop");
  const begin = source.indexOf('    m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/held-continuations');
  expect(begin).toBeGreaterThan(0);
  const end = source.indexOf('    m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/respond', begin);
  const drain = vi.fn();
  const retry = (approved: boolean) => execute(`(async function(){let m;${source.slice(begin, end)}})()`, {
    path: `/api/bots/${bot.id}/held-continuations/legacy/retry`, method: "POST", req: {}, res: {}, url: {}, readBody: async () => ({ threadId: bot.threadId }),
    store: restarted, connectorThread: () => ({ bot }), mayApprove: () => approved, turnAudienceIsOwner: () => true,
    threadHumanPrincipal: () => "owner", turnSessionAudience: () => "owner", latestRoomUserMessage: noop,
    noteHeldQueue: noop, drainHeldContinuations: drain, APPROVAL_NEEDS_OWNER: "Owner required", json: (_res: any, status: number) => status,
  });
  expect(await retry(false)).toBe(403); expect(drain).not.toHaveBeenCalled();
  expect(await retry(true)).toBe(200); expect(drain).toHaveBeenCalledWith(bot.id);
  expect(restarted.taskByThread(bot.id, bot.threadId)?.heldContinuations?.[0]).toMatchObject({ state: "ready", dispatcher: "direct", options: { continuationPermissionMode: "ask" } });
  expect(restarted.taskByThread(bot.id, bot.threadId)?.heldContinuations?.[0].error).toBeUndefined();
});

it.each([false, true])("P7 counts original eligible history with memory inactive, native=%s", replaysNatively => {
  const original = [{ id: "withheld", at: 1, kind: "text", role: "bot", text: "withheld" }];
  const begin = source.indexOf("  const replayableMessages ="), end = source.indexOf("  // After a rewind", begin);
  const replay = execute(source.slice(begin, end) + "\n({transcript, omitted: replayOmitted});", { opts: undefined, replayFloor: { messages: [] }, activeMessages: original,
    skipTranscript: new Set(), replayOptions: { maxBytes: 5000 }, replayWindow, fitRenderedReplay, messagesById: new Map(), instanceId: "a", cfg: {},
    replayEntry: (row: any, text: string) => ({ id: row.id, role: row.role, text }), transcriptText: (row: any) => row.text });
  expect(replay.omitted).toBe(1);
  expect(buildTurnContext({ ...replay, text: "now", fresh: true, rewound: false, externallyUpdated: false, replaysNatively }).turnText).toContain("1 earlier line");
});

it("N6 room dispatch retries retain the request and respect revalidation delays", () => {
  const { store, bot } = fixture(), group = store.createGroup("Retry", [bot.id]);
  store.holdTaskContinuation(bot.id, group.threadId, "continue", { id: "held", requestId: "original", dispatcher: "room-request", principal: "owner" });
  const request = { id: "original", toBotId: bot.id, targetThreadId: group.threadId, state: "running" };
  const release = vi.fn(), claims = new Map([["key", { release }]]), running = new Map([["key", request.id]]);
  let now = 1;
  const scope = { store, database: noop, roomTurnRequestKey: () => "key", pendingRoomTurnRequests: new Map(), roomTurnClaims: claims, roomTurnRequests: running,
    noteHeldQueue: noop, Date: { now: () => now }, registry: { get: () => ({ adapter: { capabilities: {} } }) }, routeHasTools: () => true,
    requeueRoomRequest: (_db: any, id: string) => { expect(id).toBe("original"); request.state = "queued"; return true; } };
  const retry = execute(definition("retryHeldRoomRequest", "/** Start a queued member") + "\nretryHeldRoomRequest;", scope);
  retry(request, "Engine is reconnecting.", { retryable: true });
  expect(request.state).toBe("queued"); expect(release).toHaveBeenCalledOnce(); expect(running.size).toBe(0);
  const readyStart = source.indexOf("  ready: request =>", source.indexOf("const roomDispatcher ="));
  const readyEnd = source.indexOf("  authorize:", readyStart);
  const ready = execute("({" + source.slice(readyStart, readyEnd) + "}).ready", scope);
  expect(ready(request)).toBe(false); now = 31_000; expect(ready(request)).toBe(true);
  request.state = "running"; retry(request, "Review the previous attempt before continuing.", { retryable: false });
  expect(store.continuationHolder(bot.id, group.threadId)?.heldContinuations?.[0].state).toBe("authority");
  now += 31_000; expect(ready(request)).toBe(false);
});

it("N3 driver events carry structured call input and completion results into the fold", () => {
  const input = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] }, result = [{ type: "text", text: JSON.stringify({ successful: true }) }];
  const emitted: any[] = [];
  const base = () => ({}), emit = (event: unknown) => emitted.push(event);
  const first = readFileSync(new URL("./drivers/claude.ts", import.meta.url), "utf8");
  for (const pattern of [/emit\(\{[^\n]+itemId: b.id, title: b.name[^\n]+\);/, /emit\(\{[^\n]+itemId: b.tool_use_id, ok:[^\n]+\);/]) {
    execute(first.match(pattern)![0], { base, emit, threadId: "thread", currentTurnId: () => "turn", b: { id: "id", tool_use_id: "id", name: "wrapper", input, content: result } });
  }
  const second = readFileSync(new URL("./drivers/codex.ts", import.meta.url), "utf8");
  execute(second.match(/emit\(\{[^\n]+itemId: item.id, title[^\n]+\);/)![0], { base, emit, threadId: "thread", turnId: "turn", title: "wrapper", item: { id: "id", arguments: input } });
  const end = second.indexOf('ok: item.status !== "failed"');
  execute(second.slice(second.lastIndexOf("emit({", end), second.indexOf("});", end) + 3), { base, emit, threadId: "thread", turnId: "turn", item: { id: "id", status: "completed", result } });
  const third = readFileSync(new URL("./drivers/acp/core.ts", import.meta.url), "utf8");
  for (const marker of ["summary: label.summary,", 'ok: u.status !== "failed",']) {
    const at = third.indexOf(marker), begin = third.lastIndexOf("emit({", at), close = third.slice(at).match(/\n\s*\}\);/)!;
    execute(third.slice(begin, at + close.index! + close[0].length), { base, emit, threadId: "thread", turnId: "turn", label: { name: "wrapper" }, identity: "wrapper", turn: {}, detail: undefined,
      u: { toolCallId: "id", rawInput: input, rawOutput: result, status: "completed" } });
  }
  expect(emitted.filter(event => event.type === "item.started").map(event => event.input)).toEqual([input, input, input]);
  expect(emitted.filter(event => event.type === "item.completed").map(event => event.result)).toEqual([result, result, result]);
});
