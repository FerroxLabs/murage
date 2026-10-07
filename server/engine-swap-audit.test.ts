import { readFileSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { mirrorReply } from "./comms-visibility.ts";
import { Store, type Message } from "./store.ts";
import { planExternalDelivery, promptRows, queueExternalUpdate } from "./external-context-delivery.ts";
import { checkReplyActions, toolAction } from "./reply-action-guard.ts";
import { detectActionClaims } from "../shared/reply-action-claims.ts";
import { fitRenderedReplay, buildTurnContext, renderDriverReplay, replayMetadata, transcriptForDriver } from "./turn-context.ts";
import { replayWindow } from "./memory/disclosures.ts";
import { captureSource, wholeTurnText } from "./memory/capture.ts";
import { claimExcerpts } from "../shared/chat-engine-notes.ts";

const row = (id: string, extra: Partial<Message> = {}): Message => ({ id, at: 1, role: "bot", kind: "text", turnId: "t", ...extra });
const check = (text: string, rows: Message[]) => { const reply = row("reply", { text }); return checkReplyActions({ reply, path: [...rows, reply] }); };

it("F1 excludes held actions from replay and quote targets while retaining plain teammate questions", () => {
  const rows = [row("action", { inboundKind: "action", text: "SEND_CANARY" }), row("question", { inboundKind: "question", text: "What format?" }), row("old-debt", { text: "LEGACY_CANARY" })];
  const kept = promptRows(rows, false, ["action", "question", "old-debt"]);
  expect(kept.map(row => row.id)).toEqual(["question"]);
  const plan = planExternalDelivery({ pending: rows.map(row => ({ id: row.id, text: row.text!, needsTools: row.inboundKind !== "question" })), branchReplay: { carriedIds: kept.map(row => row.id) }, routeHasTools: false });
  expect(plan.consumedIds).toEqual(["question"]);
  expect(plan.preamble).not.toMatch(/CANARY/);
  expect(promptRows(rows, true)).toEqual(rows);
});
it("F2 a tool-capable owner turn cannot consume or receive a held continuation", () => {
  const plan = planExternalDelivery({ pending: [], branchReplay: null, routeHasTools: true, heldContinuations: [{ id: "request", text: "ROUTINE_CANARY", at: 1, dispatcher: "direct", options: { eventId: "budget", routineAuthority: { permissionMode: "ask", triggerSource: "schedule" } } }] });
  expect(plan.preamble).not.toContain("ROUTINE_CANARY");
  expect(plan.consumedHeldIds ?? []).toEqual([]);
});
it("F4 requires relevant completed structured outcomes", () => {
  for (const tool of [{ name: "read_file", ok: true }, { name: "send_message" }, { name: "send_message", ok: false }, { name: "diagnostic", summary: "sent paid saved", ok: true }]) {
    expect(check("I sent it. I saved the file.", [row("tool", { kind: "activity", tool })]).state).toBe("flagged");
  }
  expect(check("I paid it.", [row("card", { kind: "options" })]).state).toBe("flagged");
  expect(check("I sent it.", [row("tool", { kind: "activity", tool: { name: "send_message", ok: true, action: toolAction("send_message", true) } })]).state).toBe("recorded");
  expect(check("I sent it.", [row("tool", { kind: "activity", tool: { name: "Bash", ok: true } })]).state).toBe("flagged");
  // Opaque shell evidence covers only local save/change/run claims.
  for (const claim of ["I saved the file.", "I changed the file.", "I ran the command."]) {
    expect(check(claim, [row("tool", { kind: "activity", tool: { name: "Bash", ok: true } })]).state).toBe("unverifiable");
  }
});
it("F5 checks all authored pieces and retains piece-aware spans on the terminal verdict", () => {
  const first = row("first", { text: "I sent it." }), last = row("last", { text: "Anything else?", turnTerminal: true });
  const verdict = checkReplyActions({ reply: last, path: [first, row("peer", { text: "I paid it.", from: { botId: "peer", name: "Peer", color: "blue" } }), last] });
  expect(verdict.state).toBe("flagged"); expect(verdict.claims).toHaveLength(1);
  expect(verdict.claims[0]).toMatchObject({ pieceId: first.id, span: [0, 6], text: "I sent" });
  expect(claimExcerpts(last.text!, verdict)[0].text).toBe("I sent");
  expect(first.actionCheck).toBeUndefined();
});
it("F6 scans long malformed quotes and repetitive clauses within a linear workload", () => {
  const start = performance.now();
  expect(detectActionClaims("“".repeat(100_000) + " I sent it.").claims).toEqual([]);
  const repeated = "I sent it and ".repeat(20_000) + "I sent it.";
  expect(detectActionClaims(repeated).claims).toHaveLength(20_001);
  expect(performance.now() - start).toBeLessThan(2000);
});
it.each([false, true])("F7 retains omission and continuity metadata even with no rows, native=%s", replaysNatively => {
  const out = buildTurnContext({ text: "now", transcript: [], omitted: 14, fresh: true, rewound: false, externallyUpdated: false, replaysNatively });
  expect(out.turnText).toContain("14 earlier lines"); expect(out.turnText).toContain("do not restate");
});
it("F7 recovery renders the shared metadata and engine headers", () => {
  const rows = transcriptForDriver([{ role: "assistant", text: "away", engine: { instanceId: "b", label: "Engine B" } }], "a");
  const replay = renderDriverReplay(rows, replayMetadata(12));
  expect(replay).toContain("12 earlier lines"); expect(replay).toContain("written on Engine B."); expect(replay).toContain("do not restate");
});
it("F8 budgets rendered replay including expanded quotes, roles and headers", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ role: "assistant" as const, text: `quoted: ${"é".repeat(1000)}`, engine: { instanceId: String(i % 2), label: "Engine " + i } }));
  const fitted = fitRenderedReplay(rows, "current", 3, 5000);
  expect(fitted.transcript.length).toBeLessThan(3);
  expect(fitted.omitted).toBe(43 - fitted.transcript.length);
  expect(Buffer.byteLength(renderDriverReplay(transcriptForDriver(fitted.transcript, "current"), replayMetadata(fitted.omitted)))).toBeLessThanOrEqual(5000);
  expect(replayWindow(rows, { maxBytes: 5000 }).length).toBe(2);
  expect(replayWindow([{ text: "x".repeat(200_000) }])).toEqual([]);
});
it.each(["'I sent it.'", "The file is saved if you click Save.", "If I had sent it, you would know."])("F12 excludes quoted and conditional claims: %s", text => {
  expect(detectActionClaims(text).claims).toEqual([]);
});
it("F12 keeps coordinated first-person actions distinct from reported speech", () => {
  expect(detectActionClaims("I wrote the file and I sent the email.").claims.map(claim => claim.class)).toEqual(["save", "send"]);
  expect(detectActionClaims("Sam wrote: I sent the email.").claims).toEqual([]);
});

describe("durable queue and capture", () => {
  beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); });
  const make = () => { const store = new Store(() => ({ instanceId: "a", model: "one" })); return { store, bot: store.createBot({}, { seedMessages: false }) }; };
  it("F1 classifies mirrored teammate questions separately from delegation results", () => {
    const { store, bot } = make();
    const group = store.createGroup("Questions", [bot.id]);
    const bus = { store } as Parameters<typeof mirrorReply>[0];
    mirrorReply(bus, bot, "Which format?", group, { threadId: bot.threadId, messageIds: ["question"] });
    mirrorReply(bus, bot, "Delegated action result", group, { threadId: bot.threadId, messageIds: ["result"] }, "action");
    const rows = store.messagesFor(group.threadId);
    expect(promptRows(rows, false).filter(row => row.text).map(row => row.text)).toEqual(["Which format?"]);
  });
  it("F2 and F11 retain identity, original dispatch authority and every accepted item across restart", () => {
    const { store, bot } = make();
    const context = { id: "request", cardId: "card", dispatcher: "direct" as const, runId: "run", principal: "owner", options: { eventId: "budget", unattended: true, routineAuthority: { permissionMode: "ask", triggerSource: "schedule" } } };
    store.holdTaskContinuation(bot.id, bot.threadId, "continue", context);
    store.holdTaskContinuation(bot.id, bot.threadId, "continue", context);
    for (let i = 0; i < 45; i++) store.holdTaskContinuation(bot.id, bot.threadId, `item ${i}`, { id: String(i) });
    const restarted = new Store(() => ({ instanceId: "a", model: "one" }));
    const held = restarted.taskByThread(bot.id, bot.threadId)!.heldContinuations!;
    expect(held).toHaveLength(46); expect(held[0]).toMatchObject(context);
    restarted.consumeTaskHeldContinuations(bot.id, bot.threadId, ["request"]);
    expect(restarted.taskByThread(bot.id, bot.threadId)!.heldContinuations).toHaveLength(45);
    expect(queueExternalUpdate(Array.from({ length: 50 }, (_, i) => String(i)), "new")).toHaveLength(51);
  });
  it("F13 updates the action verdict metadata without recapturing text or scheduling extraction", () => {
    const { store, bot } = make(); database().exec("UPDATE memory_meta SET mode='active' WHERE id=1");
    const message = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "I sent it.", turnId: "t" });
    store.markTerminalAssistantMessage(bot.threadId, "t");
    const jobs = () => database().prepare("SELECT id,source_revision FROM memory_jobs").all();
    const before = jobs(); const verdict = checkReplyActions({ reply: message, path: store.activePath(bot.threadId) });
    store.patchMessage(bot.threadId, message.id, { actionCheck: verdict });
    expect(jobs()).toEqual(before);
    const payload = JSON.parse(String(database().prepare("SELECT payload FROM memory_source_versions WHERE source_id=?").get(`message:${bot.threadId}:${message.id}`)!.payload));
    expect(payload.actionCheck.state).toBe("flagged"); expect(payload.text).toBe(message.text);
  });
  it("F13 metadata-only updates preserve earlier provenance when an older caller omits it", () => {
    const { bot } = make(); database().exec("UPDATE memory_meta SET mode='active' WHERE id=1");
    const source = { id: "source", threadId: bot.threadId, kind: "text", speaker: "assistant", outcome: "recorded", text: "reply" };
    const engine = { instanceId: "a", model: "one", capabilityHash: "hash" };
    captureSource(database(), { ...source, engine });
    captureSource(database(), { ...source, actionCheck: { state: "flagged", claims: [] } });
    const payload = JSON.parse(String(database().prepare("SELECT payload FROM memory_source_versions WHERE source_id='source'").get()!.payload));
    expect(payload.engine).toEqual(engine); expect(payload.actionCheck.state).toBe("flagged");
    expect(database().prepare("SELECT count(*) AS n FROM memory_source_versions WHERE source_id='source'").get()!.n).toBe(1);
  });
  it("F14 captures only the active authored branch using the shared whole-turn representation", () => {
    const { store, bot } = make(); database().exec("UPDATE memory_meta SET mode='active' WHERE id=1");
    const root = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "go" });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "abandoned", turnId: "t" });
    
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "first", turnId: "t", parentId: root.id });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "peer", turnId: "t", from: { botId: "peer", name: "Peer", color: "blue" } });
    const last = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "last", turnId: "t" });
    store.markTerminalAssistantMessage(bot.threadId, "t");
    expect(wholeTurnText(database(), bot.threadId, last)).toBe("first\n\nlast");
    const payload = JSON.parse(String(database().prepare("SELECT payload FROM memory_source_versions WHERE source_id=?").get(`message:${bot.threadId}:${last.id}`)!.payload));
    expect(payload.text).toBe("first\n\nlast");
  });
});
it("F16 keeps the engine-swap regression punctuation assertion escaped", () => {
  expect(readFileSync(new URL("./engine-swap-core.test.ts", import.meta.url), "utf8")).not.toContain("\u2014");
});
