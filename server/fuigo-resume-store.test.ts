import { runInNewContext } from "node:vm";
import { mkdirSync, readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { FUIGO_POLICY_SHA256, fuigoRelocationSeams } from "./drivers/acp/fuigo-policy.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const policy = { root: DATA_DIR, sha256: FUIGO_POLICY_SHA256 };
const fixture = () => {
  const store = new Store(() => ({ instanceId: "fuigo", model: "fixture", effort: "medium" }));
  const bot = store.createBot();
  const task = () => store.taskByThread(bot.id, bot.threadId)!;
  const save = (cursor: string | undefined, pending = false) => store.setResumeCursor(bot.id, "fuigo", cursor, bot.threadId, undefined, undefined, false, undefined, undefined, { policy, replayPending: pending });
  return { store, bot, task, save };
};
it("T26s 1000 renewals replace one slot and mirror maps whole", () => {
  const { bot, task, save } = fixture();
  for (let i = 0; i < 1000; i++) save(`session-${i}`, true);
  expect(task().resumePolicies).toEqual({ fuigo: policy });
  expect(task().replayPending).toEqual({ fuigo: { cursor: "session-999" } });
  expect(bot.resumePolicies).toEqual(task().resumePolicies);
  expect(bot.replayPending).toEqual(task().replayPending);
});
it("pending survives a successful load record and clears only for its cursor", () => {
  const { store, bot, task, save } = fixture();
  save("X", true); save("X");
  expect(task().replayPending?.fuigo).toEqual({ cursor: "X" });
  store.clearReplayPending(bot.id, "fuigo", bot.threadId, "Y");
  expect(task().replayPending?.fuigo).toEqual({ cursor: "X" });
  store.clearReplayPending(bot.id, "fuigo", bot.threadId, "X");
  expect(task().replayPending?.fuigo).toBeUndefined();
  expect(bot.replayPending?.fuigo).toBeUndefined();
});
it("M2 cleared slot drops policy and pending", () => {
  const { task, save } = fixture(); save("X", true);
  task().resumePolicies = { fuigo: policy }; task().replayPending = { fuigo: { cursor: "X" } };
  save(undefined);
  expect(task().resumePolicies?.fuigo).toBeUndefined();
  expect(task().replayPending?.fuigo).toBeUndefined();
});
it("M2 whole cursor reset drops policy and pending", () => {
  const { store, bot, task, save } = fixture(); save("X", true);
  task().resumePolicies = { fuigo: policy }; task().replayPending = { fuigo: { cursor: "X" } };
  store.patchTask(bot.id, bot.threadId, { resumeCursors: {} });
  expect(task().resumePolicies).toBeUndefined(); expect(task().replayPending).toBeUndefined();
  expect(bot.resumePolicies).toBeUndefined(); expect(bot.replayPending).toBeUndefined();
});
it("M2 task switching replaces mirror maps and a new task has none", () => {
  const { store, bot, save } = fixture(); save("X", true);
  const original = bot.threadId;
  store.createTask(bot.id, "second");
  expect(bot.resumePolicies).toBeUndefined(); expect(bot.replayPending).toBeUndefined();
  store.switchTask(bot.id, original);
  expect(bot.resumePolicies).toEqual({ fuigo: policy });
  expect(bot.replayPending).toEqual({ fuigo: { cursor: "X" } });
});
it("M2 retiring an instance drops both private maps on every task and mirror", () => {
  const { store, bot, task } = fixture();
  task().resumePolicies = { fuigo: policy }; task().replayPending = { fuigo: { cursor: "X" } };
  bot.resumePolicies = { fuigo: policy }; bot.replayPending = { fuigo: { cursor: "X" } };
  store.retireFuigoResumeState("fuigo");
  expect(task().resumePolicies?.fuigo).toBeUndefined(); expect(task().replayPending?.fuigo).toBeUndefined();
  expect(bot.resumePolicies?.fuigo).toBeUndefined(); expect(bot.replayPending?.fuigo).toBeUndefined();
});
it.each(["bot reset", "bot account change", "task account change"])("M2 %s clears private state", kind => {
  const { store, bot, task, save } = fixture(); save("X", true);
  task().resumePolicies = { fuigo: policy }; task().replayPending = { fuigo: { cursor: "X" } };
  bot.resumePolicies = { fuigo: policy }; bot.replayPending = { fuigo: { cursor: "X" } };
  if (kind === "bot reset") store.patchBot(bot.id, { resumeCursors: {} });
  else if (kind === "bot account change") store.patchBot(bot.id, { modelSelection: { ...bot.modelSelection, connectionId: "new-account" } });
  else store.patchTask(bot.id, bot.threadId, { modelSelection: { ...bot.modelSelection, connectionId: "new-account" } });
  expect(task().resumePolicies).toBeUndefined(); expect(task().replayPending).toBeUndefined();
  expect(bot.resumePolicies).toBeUndefined(); expect(bot.replayPending).toBeUndefined();
});

it("wire projections keep the root, hash and pending cursor out of a phone bot frame", () => {
  // Exercise the actual destructuring expressions without starting the socket-bound server.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const taskPattern = /const wireTask = \((\{[\s\S]*?\}): TaskRecord/;
  const botPattern = /const (\{[^\n]+\}) = bot;/;
  const taskExpression = source.match(taskPattern)![1];
  const botExpression = source.slice(source.indexOf("const wireBot =")).match(botPattern)![1];
  const privateState = { resumePolicies: { fuigo: { root: "/PRIVATE_DATA_ROOT_CANARY", sha256: "POLICY_HASH_CANARY" } }, replayPending: { fuigo: { cursor: "PRIVATE_CURSOR_CANARY" } } };
  const task = runInNewContext(`const ${taskExpression} = input; task`, { input: { threadId: "t", ...privateState } });
  const bot = runInNewContext(`const ${botExpression} = input; rest`, { input: { id: "b", ...privateState } });
  const frame = JSON.stringify({ type: "bot", bot: { ...bot, tasks: [task] } });
  expect(frame).not.toContain("PRIVATE_DATA_ROOT_CANARY"); expect(frame).not.toContain("POLICY_HASH_CANARY");
  expect(frame).not.toContain("PRIVATE_CURSOR_CANARY"); expect(frame).not.toContain("resumePolicies"); expect(frame).not.toContain("replayPending");
});

it("M3 boot does no old-root inspection or provenance backfill", () => {
  const { store, bot, save } = fixture(); save("X", true);
  const probe = vi.spyOn(fuigoRelocationSeams, "lstat");
  try {
    const loaded = new Store(() => ({ instanceId: "fuigo", model: "fixture", effort: "medium" }));
    expect(loaded.taskByThread(bot.id, bot.threadId)?.resumePolicies).toEqual(store.taskByThread(bot.id, bot.threadId)?.resumePolicies);
    expect(probe).not.toHaveBeenCalled();
  } finally { probe.mockRestore(); }
});

import { DatabaseSync } from "node:sqlite";
import { join as joinPath } from "node:path";
import { writeFileSync } from "node:fs";
import { resetIncarnatedSessionCursors } from "./installation-memory-downgrade.ts";
it("selective downgrade clears the policy and pending entries with the cursor it removes, and keeps an unaffected instance", () => {
  const holder = () => ({
    resumeCursors: { fuigo: "X", other: "Y" }, resumeIncarnations: { fuigo: 2, other: 1 }, resumeSeals: { fuigo: "s", other: "t" },
    resumePolicies: { fuigo: policy, other: policy }, replayPending: { fuigo: { cursor: "X" }, other: { cursor: "Y" } },
  });
  const bot = { id: "b", ...holder(), tasks: [{ threadId: "t", ...holder() }] };
  writeFileSync(joinPath(DATA_DIR, "bots.json"), JSON.stringify([bot]));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE memory_session_incarnation (driver_instance TEXT, native_id TEXT, n INTEGER)");
  try { expect(resetIncarnatedSessionCursors(DATA_DIR, db)).toBe(2); } finally { db.close(); }
  const [saved] = JSON.parse(readFileSync(joinPath(DATA_DIR, "bots.json"), "utf8"));
  for (const h of [saved, saved.tasks[0]]) {
    expect(h.resumeCursors).toEqual({ other: "Y" });
    expect(h.resumePolicies).toEqual({ other: policy });
    expect(h.replayPending).toEqual({ other: { cursor: "Y" } });
  }
});
