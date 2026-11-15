// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store, type StoreChange } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { ThreadVersions } from "./thread-versions.ts";

// Execute the actual subscribers without starting channel transports. Extracting
// their callbacks leaves their production conditions and effects under test.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const callbacks: string[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "store.onChange") callbacks.push(node.arguments[0]!.getText(tree));
  ts.forEachChild(node, visit);
}
visit(tree);
const markers = ["listener()", "browserBusyStates", "directRuns.recheck", "change.botId === bot.id", "threadVersions.note", "broadcastBot", "wakesActivitySnooze", "drainHeldContinuations", "telegram.revalidateTarget", "slackRequiresRevoke", "discordRequiresRevoke", "whatsapp.pause"];
function subscriber(marker: string, scope: Record<string, unknown>): (change: StoreChange) => void {
  const matches = callbacks.filter(callback => callback.includes(marker));
  expect(matches, marker).toHaveLength(1);
  const js = ts.transpileModule(`const subscriber = ${matches[0]};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(scope), `${js}\nreturn subscriber;`)(...Object.values(scope));
}
const selection = () => ({ instanceId: "fixture", model: "model" });
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => { flushCoalesced(); vi.restoreAllMocks(); });
function world() {
  const store = new Store(selection), bot = store.createBot({ name: "Fixture" }, { seedMessages: false });
  store.createTask(bot.id, "Other");
  const tasks = bot.tasks!;
  const patch = (listener: (change: StoreChange) => void) => {
    store.onChange(listener);
    store.patchBot(bot.id, { unread: true });
    expect(bot.tasks).toBe(tasks);
  };
  return { store, bot, tasks, patch };
}

it("inventories every Store subscriber in index.ts", () => {
  expect(callbacks).toHaveLength(markers.length);
  for (const callback of callbacks) expect(markers.filter(marker => callback.includes(marker))).toHaveLength(1);
});

it("message waiters ignore bot metadata and still wake on their thread's message", () => {
  const { bot, patch } = world(), listener = vi.fn();
  const callback = subscriber("listener()", { threadId: bot.threadId, listener });
  patch(callback);
  expect(listener).not.toHaveBeenCalled();
  callback({ type: "message", threadId: "other", message: {} } as StoreChange);
  expect(listener).not.toHaveBeenCalled();
  callback({ type: "message", threadId: bot.threadId, message: {} } as StoreChange);
  expect(listener).toHaveBeenCalledOnce();
});

it("browser choices apply once on busy to idle and retain their held tasks", () => {
  const { store, bot, patch } = world(), applyPending = vi.fn(async () => {});
  Object.assign(bot, { browserRelease: true });
  const states = new Map([[bot.id, true]]);
  patch(subscriber("browserBusyStates", { store, browserBusyStates: states, browserChoices: { applyPending } }));
  expect(applyPending).toHaveBeenCalledExactlyOnceWith(bot.id);
  expect(states.get(bot.id)).toBe(false);
  store.patchBot(bot.id, { unread: false });
  expect(applyPending).toHaveBeenCalledOnce();
});

it("decision levels recheck the live bot and forget a missing bot", () => {
  const { store, bot, patch } = world(), recheck = vi.fn(), levels = vi.fn();
  const remembered = new Map([[bot.id, "level"]]);
  const callback = subscriber("directRuns.recheck", { store, directRuns: { recheck }, decisionBotLevels: remembered, recheckDecisionLevels: levels });
  patch(callback);
  expect(recheck).toHaveBeenCalledOnce();
  expect(levels).toHaveBeenCalledExactlyOnceWith(bot.id);
  expect(remembered.has(bot.id)).toBe(true);
  remembered.set("missing", "level");
  callback({ type: "bot", botId: "missing" });
  expect(remembered.has("missing")).toBe(false);
});

it("room goal waiters recheck only the bot they are waiting for", () => {
  const { bot, patch } = world(), check = vi.fn();
  const callback = subscriber("change.botId === bot.id", { bot, check });
  patch(callback);
  expect(check).toHaveBeenCalledOnce();
  callback({ type: "bot", botId: "other" });
  expect(check).toHaveBeenCalledOnce();
  callback({ type: "bot.deleted", botId: bot.id });
  expect(check).toHaveBeenCalledTimes(2);
});

it("thread versions ignore bot metadata and retain message deltas", () => {
  const { bot, patch } = world(), versions = new ThreadVersions("fixture");
  const token = versions.token();
  patch(subscriber("threadVersions.note", { threadVersions: versions }));
  expect(versions.token()).toBe(token);
  versions.note({ type: "message", threadId: bot.threadId, message: { id: "line" } } as StoreChange);
  expect(versions.since(bot.threadId, token, 10)).toEqual(["line"]);
});

it("SSE broadcasts the committed metadata and keeps hidden-bot removal numbering", () => {
  const { store, bot, tasks, patch } = world(), broadcast = vi.fn(), hidden = vi.fn(), shown = vi.fn();
  const broadcastBot = vi.fn((record: typeof bot) => {
    expect(record).toBe(bot); expect(record.unread).toBe(true); expect(record.tasks).toBe(tasks);
  });
  patch(subscriber("broadcastBot", { store, broadcastBot, broadcast, botRemovals: { hidden, shown }, taskDelta: { seq: () => 7, epoch: "fixture" }, responseSeq: () => ({ tasksSeq: 7 }) }));
  expect(broadcastBot).toHaveBeenCalledOnce();
  expect(shown).toHaveBeenCalledExactlyOnceWith(bot.id);
  store.patchBot(bot.id, { hidden: true });
  expect(hidden).toHaveBeenCalledExactlyOnceWith(bot.id, 7, "fixture");
  expect(broadcast).toHaveBeenCalledWith({ kind: "bot.deleted", botId: bot.id, audience: "remote", tasksSeq: 7 });
});

it("snoozes ignore bot metadata and still wake on qualifying bot messages", () => {
  const { bot, patch } = world(), wake = vi.fn(), sweep = vi.fn(), db = vi.fn(() => "db");
  const callback = subscriber("wakesActivitySnooze", { database: db, wakesActivitySnooze: () => true, wakeThreadOnActivity: wake,
    hasThreadSnooze: () => true, sweepThreadSnoozes: sweep, threadSnoozeDeps: {}, unsnoozeThread: vi.fn(), isWorkspaceOwner: () => true, threadHumanPrincipal: () => ({}), setImmediate: (run: () => void) => run() });
  patch(callback);
  expect(db).not.toHaveBeenCalled();
  callback({ type: "message", threadId: bot.threadId, message: { role: "bot", kind: "options" } } as StoreChange);
  expect(wake).toHaveBeenCalledWith("db", bot.threadId);
  expect(sweep).toHaveBeenCalledWith("db", {});
});

it("held continuations still drain in a microtask for the changed bot", async () => {
  const { bot, patch } = world(), drain = vi.fn(async () => {});
  patch(subscriber("drainHeldContinuations", { drainHeldContinuations: drain }));
  expect(drain).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(drain).toHaveBeenCalledExactlyOnceWith(bot.id);
});

it("Telegram revalidates its chosen Chief on the metadata event", () => {
  const { patch } = world(), revalidateTarget = vi.fn(async () => {});
  patch(subscriber("telegram.revalidateTarget", { telegram: { revalidateTarget } }));
  expect(revalidateTarget).toHaveBeenCalledOnce();
});

it.each(["slack", "discord", "whatsapp"])("%s pauses when its chosen Chief changes, and retains the current Chief", channel => {
  const { store, bot, patch } = world(), pause = vi.fn(async () => {});
  const cfg = { [channel]: { targetBotId: "former-chief" } };
  const scope = { store, cfg, [channel]: { pause }, [`${channel}RequiresRevoke`]: true };
  patch(subscriber(channel === "whatsapp" ? "whatsapp.pause" : `${channel}RequiresRevoke`, scope));
  expect(pause).toHaveBeenCalledOnce();
  // The channel's configured target still names the live Chief: keep it running.
  vi.spyOn(store, "workspaceChief").mockReturnValue(bot);
  cfg[channel]!.targetBotId = bot.id;
  store.patchBot(bot.id, { unread: false });
  expect(pause).toHaveBeenCalledOnce();
});
