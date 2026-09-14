import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { ensureTaskWorkspace, selectFileWorkspace, taskWorkspacePath } from "./workspace.ts";
import { outputDestinationInstructions } from "./output-publication.ts";
import { resolveWorkspaceRoot } from "./workspace-files.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());
const fresh = () => new Store(() => ({ instanceId: "fixture", model: "fixture" }));

it("admits legacy output independently of CWD/cursor, persists it and resolves the same Files scope", () => {
  let store = fresh(); const bot = store.createBot(), threadId = bot.threadId;
  store.patchTask(bot.id, threadId, { cwd: null, resumeCursors: { fixture: "existing-session" } });
  expect(selectFileWorkspace(DATA_DIR, store, bot.id, threadId)).toBeUndefined();
  expect(selectFileWorkspace(DATA_DIR, store, bot.id, threadId, true)).toEqual({ root: taskWorkspacePath(DATA_DIR, bot.id, threadId), managed: true });
  ensureTaskWorkspace(bot.id, threadId); store.admitLocalOutputs(bot.id, threadId);
  store = fresh();
  expect(store.taskByThread(bot.id, threadId)).toMatchObject({ cwd: null, resumeCursors: { fixture: "existing-session" }, localOutputs: true });
  const selected = selectFileWorkspace(DATA_DIR, store, bot.id, threadId)!;
  const result = resolveWorkspaceRoot({ dataDir: DATA_DIR, store, database: () => { throw new Error("no DB read"); }, artifactScopes: () => [{ botId: bot.id, botName: bot.name, threadId, workspaceRoot: selected.root }] }, { botId: bot.id, threadId });
  expect(result.info).toMatchObject({ state: "ready", managed: true });
  expect(result.root).toBeDefined();
});

it("uses current room membership and separate admitted member desks while preserving custom roots", () => {
  const store = fresh(), a = store.createBot(), b = store.createBot();
  const room = store.createGroup("Room", [a.id, b.id]);
  store.pinGroupCwd(room.id, room.threadId);
  store.admitLocalOutputs(a.id, room.threadId); ensureTaskWorkspace(a.id, room.threadId);
  expect(selectFileWorkspace(DATA_DIR, store, a.id, room.threadId)).toEqual({ root: taskWorkspacePath(DATA_DIR, a.id, room.threadId), managed: true });
  expect(selectFileWorkspace(DATA_DIR, store, b.id, room.threadId)?.managed).toBe(false);
  expect(room.tasks![0]!.pinnedCwd).toBeNull();
  room.memberIds = [b.id];
  expect(selectFileWorkspace(DATA_DIR, store, a.id, room.threadId)).toBeUndefined();
  expect(() => store.admitLocalOutputs(a.id, room.threadId)).toThrow("unavailable");
  const project = join(DATA_DIR, "custom"); mkdirSync(project);
  store.patchTask(b.id, b.threadId, { cwd: project });
  expect(selectFileWorkspace(DATA_DIR, store, b.id, b.threadId, true)).toEqual({ root: project, managed: false });
});

it("new bot/group projections cannot import task admission and new tasks do not inherit it", () => {
  const store = fresh();
  const bot = store.createBot({ name: "Imported", localOutputs: true, tasks: [{ localOutputs: true }] } as never);
  expect(store.taskByThread(bot.id, bot.threadId)?.localOutputs).toBeUndefined();
  store.admitLocalOutputs(bot.id, bot.threadId);
  expect(store.createTask(bot.id)?.localOutputs).toBeUndefined();
  const room = store.createGroup("Imported room", [bot.id], false, undefined, { localOutputBotIds: [bot.id] } as never);
  expect(room.localOutputBotIds).toBeUndefined();
  expect(room.tasks![0]!.localOutputBotIds).toBeUndefined();
});

it("does not advertise remote outputs or promise unadmitted publication; custom registration is explicit", () => {
  expect(outputDestinationInstructions(undefined, false, true)).toBe("");
  const managed = { workspaceRoot: join(DATA_DIR, "space in name"), managed: true };
  const text = outputDestinationInstructions(managed, true, false);
  expect(text).toContain(JSON.stringify(join(managed.workspaceRoot, "outputs")));
  expect(text).toContain("replaces earlier scratch-folder advice");
  expect(text).toContain("checks new or changed files");
  expect(outputDestinationInstructions(managed, false, false)).toContain("Automatic publication is unavailable");
  expect(outputDestinationInstructions({ ...managed, managed: false }, false, true)).toContain("call register_artifact");
});
