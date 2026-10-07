// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine swap, core fix (CF-1, CF-2, CF-5): every bot row says which engine,
// model and route wrote it; a swap replays the thread with one header per
// run of replies, states what it leaves out, scales its window to the engine
// and captures a whole turn, not its last piece. Engine A and engine B are
// stand-ins; nothing here names a product.
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { ENGINE_SWITCH_KEYS, ENGINE_TOOL_KEYS } from "../shared/engine-switch.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { capabilitiesHaveTools, capabilityHash, engineProfile, engineStamp, instanceRouteHasTools, routeHasTools, type EngineProfile } from "./engine-profile.ts";
import { routeHasTools as flagsRouteHasTools } from "./engine-capabilities.ts";
import { DIRECT_REPLAY_LINES, REPLAY_BUDGET_CAP_BYTES, filterDirectReplay, replayBudgetBytes, replayWindow } from "./memory/disclosures.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { ROUTE_POLICY } from "./route-policy.ts";
import { transcriptText } from "./replies.ts";
import { Store, type Message } from "./store.ts";
import { buildTurnContext, engineIsFresh, runHeaders, transcriptForDriver, type TranscriptEntry } from "./turn-context.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");

type StubInstance = Parameters<typeof engineProfile>[0] & { instanceId: string };
function stub(caps: Record<string, unknown>, driverKind = "stubAgent", contextWindow = 200_000): StubInstance {
  return {
    instanceId: `${driverKind}-1`,
    driverKind,
    adapter: { capabilities: { sessionModelSwitch: "in-session", ...caps } },
    models: { default: "m1", options: [{ id: "m1", contextWindow }] },
  } as unknown as StubInstance;
}
const toolUsing = () => stub({ agentsMcp: true, composioMcp: true, images: true, queueing: true });
const toolLess = () => stub({ textOnlyTurn: true }, "stubChat", 32_000);

describe("CF-1 engine profile", () => {
  it("hashes equal profiles equal and different capabilities differently", () => {
    const a = engineProfile(toolUsing(), "m1");
    expect(capabilityHash(a)).toBe(capabilityHash(engineProfile(toolUsing(), "m1")));
    expect(capabilityHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(capabilityHash(a)).not.toBe(capabilityHash(engineProfile(toolLess(), "m1")));
    // key order never changes the hash
    const shuffled: EngineProfile = { effortLevels: a.effortLevels, queueing: a.queueing, modalities: a.modalities, contextWindow: a.contextWindow, tools: { ...a.tools }, driverKind: a.driverKind };
    expect(capabilityHash(shuffled)).toBe(capabilityHash(a));
  });

  it("answers routeHasTools for a tool-using and a tool-less route", () => {
    expect(routeHasTools(engineProfile(toolUsing(), "m1"))).toBe(true);
    expect(routeHasTools(engineProfile(toolLess(), "m1"))).toBe(false);
    expect(instanceRouteHasTools(toolUsing(), "m1")).toBe(true);
    expect(instanceRouteHasTools(toolLess())).toBe(false);
    expect(routeHasTools(engineProfile(stub({ runsOnOwnTools: true }), "m1"))).toBe(true);
  });

  it("counts an engine as tool-capable only if it can act on tool-needing items", () => {
    // memoryMcp alone reads and writes memory; it cannot answer a teammate message, delegation result or card
    expect(routeHasTools(engineProfile(stub({ memoryMcp: true }), "m1"))).toBe(false);
    expect(capabilitiesHaveTools({ memoryMcp: true })).toBe(false);
    expect(capabilitiesHaveTools({ memoryMcp: true, agentsMcp: true })).toBe(true);
    expect(capabilitiesHaveTools({ runsOnOwnTools: true })).toBe(true);
    expect(capabilitiesHaveTools({})).toBe(false);
    expect(capabilitiesHaveTools(undefined)).toBe(true);
    // the hold queue adapter agrees with the profile, flag set by flag set
    for (const flags of [{ memoryMcp: true }, { agentsMcp: true }, { runsOnOwnTools: true }, { composioMcp: true, memoryMcp: true }, {}]) {
      expect(flagsRouteHasTools(flags)).toBe(routeHasTools(engineProfile(stub(flags), "m1")));
    }
  });

  it("reads the context window of the resolved model", () => {
    expect(engineProfile(toolUsing(), "m1").contextWindow).toBe(200_000);
    expect(engineProfile(toolUsing(), "unknown-model").contextWindow).toBeNull();
  });

  it("stamps instance, driver, model, route and hash", () => {
    const instance = toolUsing();
    const stamp = engineStamp(instance, "m1", "conn-7");
    expect(stamp).toEqual({ instanceId: "stubAgent-1", driverKind: "stubAgent", model: "m1", connectionId: "conn-7", capabilityHash: capabilityHash(engineProfile(instance, "m1")) });
    expect("connectionId" in engineStamp(instance, "m1")).toBe(false);
    expect(engineStamp(instance, undefined).model).toBe("m1");
  });

  it("covers every flag the switch notice names, so the notice and the hash never drift", () => {
    const profile = engineProfile(toolUsing(), "m1");
    const covered = new Set<string>([...Object.keys(profile.tools), ...Object.keys(profile.modalities), ...Object.keys(profile)]);
    for (const key of ENGINE_SWITCH_KEYS) expect(covered.has(key), key).toBe(true);
    expect(ENGINE_TOOL_KEYS).toContain("runsOnOwnTools");
    expect(Object.keys(profile.tools).sort()).toEqual([...ENGINE_TOOL_KEYS].sort());
  });
});

const engineA = { instanceId: "inst-a", label: "Engine A" };
const engineB = { instanceId: "inst-b", label: "Engine B" };
const u = (text: string): TranscriptEntry => ({ role: "user", text });
const a = (text: string, engine?: { instanceId: string; label: string }): TranscriptEntry => ({ role: "assistant", text, ...(engine ? { engine } : {}) });
const base = { rewound: false, fresh: true, externallyUpdated: false, replaysNatively: false } as const;

describe("CF-2 run headers and the seam", () => {
  const swapped = [u("q1"), a("a1", engineA), u("q2"), a("b1", engineB), a("b2", engineB), u("q3"), a("b3", engineB)];

  it("heads each run of another engine once, with its reply count", () => {
    const headers = runHeaders(swapped, "inst-a");
    expect(headers).toEqual([undefined, undefined, undefined, "[The next 3 replies were written on Engine B.]", undefined, undefined, undefined]);
  });

  it("heads the current engine's run after another engine's run, and says it is answering now", () => {
    const back = [...swapped, u("q4"), a("a2", engineA)];
    const headers = runHeaders(back, "inst-a");
    expect(headers[3]).toBe("[The next 3 replies were written on Engine B.]");
    expect(headers[8]).toBe("[The next reply was written on Engine A, the engine answering now.]");
    // the very first run on the current engine is never headed
    expect(headers[1]).toBeUndefined();
  });

  it("heads unlabelled replies only when some other reply is labelled", () => {
    const mixed = [u("q"), a("old"), a("older"), u("q2"), a("new", engineB)];
    expect(runHeaders(mixed, "inst-b")).toEqual([undefined, "[The next 2 replies carry no engine label.]", undefined, undefined, "[The next reply was written on Engine B, the engine answering now.]"]);
  });

  it("gives a transcript with no label anywhere no header at all, byte for byte as before", () => {
    const plain = [u("my dog is named Biscuit"), a("Noted."), u("and?"), a("Fine.")];
    expect(runHeaders(plain, "inst-a").every((h) => h === undefined)).toBe(true);
    const out = buildTurnContext({ text: "hi", transcript: plain, currentInstanceId: "inst-a", ...base });
    const body = out.turnText.split("\n").slice(out.turnText.split("\n").indexOf("") + 1);
    expect(body).toEqual(["User: my dog is named Biscuit", "Assistant: Noted.", "User: and?", "Assistant: Fine.", "", "[Now reply to the user's latest message:]", "", "hi"]);
  });

  it("puts the header line right before the run's first reply in the inline replay", () => {
    const out = buildTurnContext({ text: "now", transcript: swapped, currentInstanceId: "inst-a", ...base });
    const lines = out.turnText.split("\n");
    const at = lines.indexOf("[The next 3 replies were written on Engine B.]");
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe("Assistant: b1");
    expect(lines[at + 2]).toBe("Assistant: b2");
    expect(lines.filter((l) => l.startsWith("[The next")).length).toBe(1);
  });

  it("carries the history-is-fixed sentence in the fresh preamble (CF-5)", () => {
    const out = buildTurnContext({ text: "now", transcript: swapped, currentInstanceId: "inst-a", ...base });
    expect(out.turnText).toContain("Replies written on other engines are part of this bot's record; do not restate, summarise, correct or disown them.");
    expect(out.turnText).toContain("Where your own limits differ, say your own limit and continue with what you can do.");
    expect(out.turnText).not.toContain("\u2014");
  });

  it("opens with an omitted-count line only when lines were left out", () => {
    const some = buildTurnContext({ text: "now", transcript: swapped, currentInstanceId: "inst-a", omitted: 12, ...base });
    expect(some.turnText.split("\n")[1]).toBe("[12 earlier lines of this conversation are not shown.]");
    const one = buildTurnContext({ text: "now", transcript: swapped, currentInstanceId: "inst-a", omitted: 1, ...base });
    expect(one.turnText).toContain("[1 earlier line of this conversation is not shown.]");
    const none = buildTurnContext({ text: "now", transcript: swapped, currentInstanceId: "inst-a", omitted: 0, ...base });
    expect(none.turnText).not.toContain("not shown");
  });

  it("hands a replaying driver the same header on the first reply of the run and no engine object", () => {
    const out = transcriptForDriver(swapped, "inst-a");
    expect(out[3]).toEqual({ role: "assistant", text: "b1", header: "[The next 3 replies were written on Engine B.]" });
    expect(out[4]).toEqual({ role: "assistant", text: "b2" });
    expect(out.every((entry) => !("engine" in entry))).toBe(true);
  });

  it("source: a replaying driver prefixes the header to the reply as its first line", () => {
    expect(source("drivers/openai-chat.ts")).toContain("message.header ? `${message.header}\\n\\n${message.text}` : message.text");
  });
});

describe("CF-2 legacy engineIsFresh fallback", () => {
  const history = (engine?: { instanceId: string; label: string }) => [u("q"), a("answer", engine)];

  it("keeps a lone cursor of ours resuming when nothing records another engine", () => {
    expect(engineIsFresh({ instanceId: "inst-a", lastInstanceId: undefined, resumeCursors: { "inst-a": "s" }, transcript: history() })).toBe(false);
  });

  it("is fresh when the last labelled reply came from another engine, even with only our cursor", () => {
    expect(engineIsFresh({ instanceId: "inst-a", lastInstanceId: undefined, resumeCursors: { "inst-a": "s" }, transcript: history(engineB) })).toBe(true);
  });

  it("resumes when the last labelled reply is ours and we hold a cursor", () => {
    expect(engineIsFresh({ instanceId: "inst-a", lastInstanceId: undefined, resumeCursors: { "inst-a": "s" }, transcript: history(engineA) })).toBe(false);
    expect(engineIsFresh({ instanceId: "inst-a", lastInstanceId: undefined, resumeCursors: {}, transcript: history(engineA) })).toBe(true);
  });

  it("is fresh with several cursors and no label", () => {
    expect(engineIsFresh({ instanceId: "inst-a", lastInstanceId: undefined, resumeCursors: { "inst-a": "s", "inst-b": "t" }, transcript: history() })).toBe(true);
  });

  it("still trusts the task's own record when it has one", () => {
    expect(engineIsFresh({ instanceId: "inst-a", lastInstanceId: "inst-a", resumeCursors: { "inst-a": "s" }, transcript: history(engineB) })).toBe(false);
  });
});

describe("CF-2 replay budget and window", () => {
  const line = (i: number, size = 100) => ({ id: `m${i}`, text: "x".repeat(size) });

  it("scales with the context window and never passes the cap", () => {
    expect(replayBudgetBytes(undefined)).toBeUndefined();
    expect(replayBudgetBytes(0)).toBeUndefined();
    expect(replayBudgetBytes(10_000)).toBe(14_000);
    expect(replayBudgetBytes(1_000_000)).toBe(REPLAY_BUDGET_CAP_BYTES);
  });

  it("is the plain newest-40 window with no byte budget", () => {
    const lines = Array.from({ length: 100 }, (_, i) => line(i));
    expect(replayWindow(lines).map((l) => l.id)).toEqual(lines.slice(-DIRECT_REPLAY_LINES).map((l) => l.id));
  });

  it("widens to the budget, dropping the oldest lines first and never a middle one", () => {
    const lines = Array.from({ length: 100 }, (_, i) => line(i, 100));
    const wide = replayWindow(lines, { maxBytes: 5_000 });
    expect(wide.length).toBe(50);
    expect(wide[0]!.id).toBe("m50");
    expect(wide[wide.length - 1]!.id).toBe("m99");
    // contiguous tail
    wide.forEach((l, i) => expect(l.id).toBe(`m${50 + i}`));
  });

  it("makes the line target subordinate to the byte ceiling", () => {
    const lines = Array.from({ length: 100 }, (_, i) => line(i, 1_000));
    expect(replayWindow(lines, { maxBytes: 2_000 }).length).toBe(2);
  });

  it("carries a whole away leg longer than 40 lines before any older line when it fits", () => {
    const lines = [...Array.from({ length: 30 }, (_, i) => line(i)), ...Array.from({ length: 70 }, (_, i) => line(100 + i))];
    const wide = replayWindow(lines, { maxBytes: 8_000 });
    expect(wide.slice(0, 70).every((l) => Number(l.id.slice(1)) >= 100)).toBe(false);
    expect(wide.filter((l) => Number(l.id.slice(1)) >= 100).length).toBe(70);
  });
});

describe("CF-2 filterDirectReplay counts what it leaves out", () => {
  beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
  function access() {
    const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private", section: "secret-team" }], groups: [] };
    reconcileMemoryRoster(roster);
    const registry = new InternalCapabilities();
    const generation = registry.begin("bot", "private");
    const token = registry.mint({ botId: "bot", threadId: "private", generation, kind: "memory", depth: 100, skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  }
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "bot" : "user", kind: "text", text: `line ${i} ${"y".repeat(100)}` }));

  it("reports the lines the window dropped", () => {
    const out = filterDirectReplay("private", rows(100), access(), new Set());
    expect(out.replayed.length).toBe(40);
    expect(out.omitted).toBe(60);
  });

  it("reports zero when everything fits, and widens to the budget on a roomy engine", () => {
    expect(filterDirectReplay("private", rows(30), access(), new Set()).omitted).toBe(0);
    const wide = filterDirectReplay("private", rows(100), access(), new Set(), { maxBytes: 192 * 1024 });
    expect(wide.replayed.length).toBe(100);
    expect(wide.omitted).toBe(0);
    const mid = filterDirectReplay("private", rows(100), access(), new Set(), { maxBytes: 8_000 });
    expect(mid.replayed.length).toBeGreaterThan(40);
    expect(mid.replayed.length).toBeLessThan(100);
    expect(mid.omitted).toBe(100 - mid.replayed.length);
    expect(mid.replayed[mid.replayed.length - 1]!.id).toBe("m99");
  });
});

describe("CF-1 and CF-2 on stored rows", () => {
  beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); });
  const selection = () => ({ instanceId: "inst-a", model: "m1" });
  const stampA = { instanceId: "inst-a", driverKind: "stubAgent", model: "m1", capabilityHash: "h".repeat(64) };
  const stampB = { instanceId: "inst-b", driverKind: "stubChat", model: "m9", connectionId: "c1", capabilityHash: "g".repeat(64) };

  it("keeps Message.engine through a restart and through a copy of the database", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const row = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "from B", turnId: "t1", engine: stampB });
    expect(new Store(selection).messagesFor(bot.threadId).find((m) => m.id === row.id)?.engine).toEqual(stampB);
    // the backup snapshot is the database file itself; a restored copy reads the same JSON
    const copy = join(DATA_DIR, "restored.db");
    database().exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    const json = database().prepare("SELECT json FROM messages WHERE id=?").get(row.id) as { json: string };
    expect(JSON.parse(json.json).engine).toEqual(stampB);
    closeDatabase();
    const restored = new DatabaseSync(copy);
    const restoredJson = restored.prepare("SELECT json FROM messages WHERE id=?").get(row.id) as { json: string };
    restored.close();
    expect((JSON.parse(restoredJson.json) as Message).engine).toEqual(stampB);
  });

  it("survives an older build patching the row by spreading what it read", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const row = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "from B", turnId: "t1", engine: stampB });
    // the older build knows no engine field: it reads the JSON and writes {...message, turnTerminal: true}
    const older = { ...(JSON.parse((database().prepare("SELECT json FROM messages WHERE id=?").get(row.id) as { json: string }).json) as Message), turnTerminal: true };
    database().prepare("UPDATE messages SET json=? WHERE id=?").run(JSON.stringify(older), row.id);
    expect(new Store(selection).messagesFor(bot.threadId).find((m) => m.id === row.id)).toMatchObject({ turnTerminal: true, engine: stampB });
  });

  it("reads a row written before the field existed as unlabelled", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const row = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "old", turnId: "t0" });
    expect(new Store(selection).messagesFor(bot.threadId).find((m) => m.id === row.id)?.engine).toBeUndefined();
  });

  it("stores the folded text whole and replays it unchanged (I-21)", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const text = `${"long reply with café and 😀 ".repeat(2_000)}end`;
    const row = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text, turnId: "t1", engine: stampA });
    const stored = new Store(selection).messagesFor(bot.threadId).find((m) => m.id === row.id)!;
    expect(Buffer.byteLength(stored.text!)).toBe(Buffer.byteLength(text));
    expect(transcriptText(stored, new Map([[stored.id, stored]]))).toBe(text);
  });

  it("captures one source per turn carrying every piece, with the engine in the payload", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    database().prepare("UPDATE memory_meta SET mode='active' WHERE id=1").run();
    const first = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Checking the calendar.", turnId: "t1", engine: stampB });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Found two slots.", turnId: "t1", engine: stampB });
    const last = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Tuesday works best.", turnId: "t1", engine: stampB });
    // nothing is captured for pieces on their own
    const sourceIds = () => (database().prepare("SELECT id FROM memory_sources WHERE thread_id=?").all(bot.threadId) as Array<{ id: string }>).map((r) => r.id);
    expect(sourceIds()).not.toContain(`message:${bot.threadId}:${first.id}`);
    store.markTerminalAssistantMessage(bot.threadId, "t1");
    expect(sourceIds().filter((id) => id.startsWith(`message:${bot.threadId}:`))).toEqual([`message:${bot.threadId}:${last.id}`]);
    const payload = JSON.parse((database().prepare("SELECT payload FROM memory_source_versions WHERE source_id=?").get(`message:${bot.threadId}:${last.id}`) as { payload: string }).payload);
    expect(payload.text).toBe("Checking the calendar.\n\nFound two slots.\n\nTuesday works best.");
    expect(payload.engine).toEqual({ instanceId: "inst-b", model: "m9", capabilityHash: "g".repeat(64) });
    // the stored rows themselves are untouched
    expect(store.messagesFor(bot.threadId).find((m) => m.id === first.id)?.text).toBe("Checking the calendar.");
  });

  it("captures a single-piece turn exactly as before", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    database().prepare("UPDATE memory_meta SET mode='active' WHERE id=1").run();
    const only = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Just this.", turnId: "t2" });
    store.markTerminalAssistantMessage(bot.threadId, "t2");
    const payload = JSON.parse((database().prepare("SELECT payload FROM memory_source_versions WHERE source_id=?").get(`message:${bot.threadId}:${only.id}`) as { payload: string }).payload);
    expect(payload.text).toBe("Just this.");
    expect(payload.engine).toBeUndefined();
  });
});

describe("CF-1 stamping census (I-20)", () => {
  const index = source("index.ts");

  it("stamps every bot row the event fold writes and builds the stamp at both turn builders", () => {
    expect(index).toContain("const turnEngine = m.role === \"bot\" && !m.engine && m.actorKind !== \"murage\" && !m.copyOf ? eventEngine : undefined;");
    expect(index).toContain("...(turnEngine ? { engine: turnEngine } : {}),");
    const builders = index.match(/turnEngineByThread\.set\(threadId, engineStamp\(/g) ?? [];
    expect(builders.length).toBe(2);
    expect(index).toContain("if (!replacementOwnsThread) turnEngineByThread.delete(event.threadId);");
  });

  it("labels replayed assistant lines from the row and hands the driver the headers", () => {
    expect(index).toContain("function replayEntry(");
    expect(index).toContain("transcript: transcriptForDriver(transcript, instanceId),");
    // Three builders since the mobile lane's ecd33144e: a resumed turn keeps its session over a
    // changed memory frame, so the post-bundle memoryContinuationChanged rebuild is gone; the
    // revoked rebuild, the reset rebuild and the turn-context header remain labelled.
    // b8f231378 adds a fourth: with memory off, a retained session that was shown memory is reset
    // and its replay rebuilt; that rebuild must carry the engine label like the other three.
    expect(index.match(/currentInstanceId:\s?instanceId/g)?.length).toBe(4);
  });
});

describe("CF-5 history is fixed (I-24)", () => {
  it("lets no message route edit an existing row", () => {
    const messageRoutes = ROUTE_POLICY.filter((entry) => (typeof entry.path === "string" ? entry.path : entry.path.source).includes("messages"));
    expect(messageRoutes.length).toBeGreaterThan(0);
    for (const entry of messageRoutes) {
      const methods = entry.methods === "*" ? ["*"] : entry.methods;
      // a send, an edit that forks a new branch, a reaction, a read: never a patch, put or delete of a row
      expect(methods.filter((m) => m === "*" || m === "PATCH" || m === "PUT" || m === "DELETE"), String(entry.path)).toEqual([]);
    }
  });

  it("keeps the modules that rewrite a row to the harness and its own cards", () => {
    const writers = readdirSync(here, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts") && !file.includes(".test.") && !file.startsWith("testing/"))
      .filter((file) => /\b(?:patchMessage|updateMessage|deleteMessage|removeMessage)\(/.test(source(file)))
      .sort();
    expect(writers).toEqual([
      "browser-extension-approvals.ts",
      "browser-extension-setup.ts",
      "delegations.ts",
      "host-computer-consent.ts",
      "image-operations.ts",
      "index.ts",
      "message-db.ts",
      "peer-approval.ts",
      "publish/publish-ops.ts",
      "routine-requests.ts",
      "steer-queue.ts",
      "store.ts",
    ]);
  });

  it("registers no agent tool that writes messages", () => {
    const tools = readdirSync(here, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts") && !file.includes(".test.") && /(?:^|\/)mcp-[\w-]*\.ts$|(?:^|\/)[\w-]*-tools\.ts$/.test(file));
    expect(tools.length).toBeGreaterThan(5);
    for (const file of tools) expect(source(file), file).not.toMatch(/\b(?:patchMessage|updateMessage|deleteMessage|removeMessage)\(/);
  });
});
