// Tasks: a bot's separate contexts.
//
// The load-bearing property is isolation — each task keeps its own
// transcript AND its own provider session. If resume cursors leaked
// between tasks, a "fresh" task would silently resume the previous
// conversation, which is the exact thing tasks exist to prevent.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home: string;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "murage-tasks-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store, UNTITLED_TASK, titleFromMessage } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), UNTITLED_TASK, titleFromMessage };
}

afterEach(async () => {
  // freshStore resets the module graph, so this closes the same SQLite
  // module instance that the freshly imported Store used.
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("tasks", () => {
  it("gives every new bot one task pointing at its thread", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    expect(store.tasks(bot.id)).toHaveLength(1);
    expect(store.activeTask(bot.id)).toMatchObject({ threadId: bot.threadId, title: UNTITLED_TASK });
  });

  it("starts a new task on a fresh thread and makes it active", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const firstThread = bot.threadId;
    const task = store.createTask(bot.id)!;

    expect(task.threadId).not.toBe(firstThread);
    expect(store.bot(bot.id)!.threadId).toBe(task.threadId);
    expect(store.tasks(bot.id).map((t) => t.threadId)).toEqual([task.threadId, firstThread]);
    // a brand new context: nothing carried over from the greeting thread
    expect(store.messagesFor(task.threadId)).toHaveLength(0);
    expect(store.messagesFor(firstThread).length).toBeGreaterThan(0);
  });

  it("can create a detached routine task without changing the visible conversation", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const visibleThread = bot.threadId;
    const routineTask = store.createTask(bot.id, "Morning brief", false)!;

    expect(routineTask.threadId).not.toBe(visibleThread);
    expect(store.bot(bot.id)!.threadId).toBe(visibleThread);
    expect(store.botByThread(routineTask.threadId)?.id).toBe(bot.id);

    store.setResumeCursor(bot.id, "claude", "routine-session", routineTask.threadId);
    expect(store.taskByThread(bot.id, routineTask.threadId)?.resumeCursors.claude).toBe("routine-session");
    expect(store.activeTask(bot.id)?.resumeCursors.claude).toBeUndefined();
  });

  it("inherits the visible task's exact selection with fresh sessions and existing permission defaults", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const selection = { instanceId: "selected-claude", model: "opus", connectionId: "account-two", effort: "high" as const };
    store.patchTask(bot.id, bot.threadId, { modelSelection: selection, autoApprove: true, alwaysAllow: ["Bash"] });
    store.setResumeCursor(bot.id, selection.instanceId, "old-session");
    const task = store.createTask(bot.id)!;
    expect(task.modelSelection).toEqual(selection);
    expect(task.resumeCursors).toEqual({});
    expect(task.autoApprove).toBe(bot.autoApprove === true);
    expect(task.alwaysAllow).toEqual(bot.alwaysAllow ?? []);
    expect(task.modelSelection).not.toBe(store.tasks(bot.id)[1]!.modelSelection);
  });

  it("inherits a reopened older task and persists the new selection independently", async () => {
    const { store } = await freshStore();
    const bot = store.createBot(), first = bot.threadId;
    const selection = { instanceId: "selected-claude", model: "opus", connectionId: "account-two", effort: "high" as const };
    store.patchTask(bot.id, first, { modelSelection: selection });
    const newer = store.createTask(bot.id)!;
    store.patchTask(bot.id, newer.threadId, { modelSelection: { instanceId: "fuigo", model: "other" } });
    store.switchTask(bot.id, first);
    const { Store } = await import("./store.ts");
    const reopened = new Store(() => ({ instanceId: "fallback", model: "fallback" }));
    const task = reopened.createTask(bot.id)!;
    expect(task.modelSelection).toEqual(selection);
    reopened.patchTask(bot.id, first, { modelSelection: { instanceId: "different", model: "different" } });
    const persisted = new Store(() => ({ instanceId: "fallback", model: "fallback" }));
    expect(persisted.activeTask(bot.id)?.modelSelection).toEqual(selection);
    expect(persisted.activeTask(bot.id)?.resumeCursors).toEqual({});
  });

  it("keeps detached routine creation on owner defaults despite a different visible selection", async () => {
    const { store } = await freshStore();
    const bot = store.createBot(), visible = bot.threadId;
    store.patchTask(bot.id, visible, { modelSelection: { instanceId: "selected-claude", model: "opus" } });
    const task = store.createTask(bot.id, "Routine", false)!;
    expect(task.modelSelection).toEqual(bot.modelSelection);
    expect(bot.threadId).toBe(visible);
    expect(task.resumeCursors).toEqual({});
  });

  it("keeps provider sessions apart — the whole point of a task", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    store.setResumeCursor(bot.id, "claude", "session-one");

    const second = store.createTask(bot.id)!;
    // the new task must NOT inherit the old session
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBeUndefined();
    store.setResumeCursor(bot.id, "claude", "session-two");

    store.switchTask(bot.id, first);
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBe("session-one");
    store.switchTask(bot.id, second.threadId);
    expect(store.activeTask(bot.id)!.resumeCursors.claude).toBe("session-two");
  });

  it("names a task after the first thing you asked it", async () => {
    const { store, UNTITLED_TASK, titleFromMessage } = await freshStore();
    const bot = store.createBot();
    store.createTask(bot.id);
    expect(store.activeTask(bot.id)!.title).toBe(UNTITLED_TASK);

    store.titleTaskFromFirstMessage(bot.id, "Audit the payroll spreadsheet\nand flag anything odd");
    expect(store.activeTask(bot.id)!.title).toBe("Audit the payroll spreadsheet");

    // only the first message names it
    store.titleTaskFromFirstMessage(bot.id, "something else entirely");
    expect(store.activeTask(bot.id)!.title).toBe("Audit the payroll spreadsheet");
    expect(titleFromMessage("x".repeat(80))).toHaveLength(48);
  });

  it("deletes a task with its transcript, and deleting the last one leaves a fresh one", async () => {
    const { store } = await freshStore();
    const bot = store.createBot();
    const first = bot.threadId;
    const second = store.createTask(bot.id)!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "secret" });

    expect(store.deleteTask(bot.id, second.threadId)).toBeTruthy();
    expect(store.tasks(bot.id)).toHaveLength(1);
    // deleting the ACTIVE task falls back to one that still exists
    expect(store.bot(bot.id)!.threadId).toBe(first);
    expect(store.messagesFor(second.threadId)).toHaveLength(0);

    // The owner confirmed deleting the only conversation and was told "a bot
    // keeps at least one task". It is now deleted, like a channel's last one,
    // and a fresh empty conversation takes its place.
    store.appendMessage(first, { role: "user", kind: "text", text: "the only one" });
    const after = store.deleteTask(bot.id, first)!;
    expect(after).toBeTruthy();
    expect(store.tasks(bot.id)).toHaveLength(1);
    expect(after.threadId).not.toBe(first);
    expect(store.tasks(bot.id)[0]!.threadId).toBe(after.threadId);
    expect(store.tasks(bot.id)[0]!.title).toBe("New task");
    expect(store.messagesFor(first)).toHaveLength(0);
    expect(store.messagesFor(after.threadId)).toHaveLength(0);
    expect(store.deleteTask(bot.id, "no-such-thread")).toBeNull();
  });

  it("adopts a pre-tasks bot's endless thread as its first task", async () => {
    const { store, UNTITLED_TASK } = await freshStore();
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Plan the offsite" });
    // simulate a record saved before tasks existed
    const legacy = store.bot(bot.id)!;
    delete (legacy as { tasks?: unknown }).tasks;
    // patchBot persists, so what lands on disk is the pre-tasks shape
    store.patchBot(bot.id, { resumeCursors: { claude: "old-session" } });

    const { Store } = await import("./store.ts");
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    const migrated = reloaded.tasks(bot.id);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ threadId: bot.threadId, resumeCursors: { claude: "old-session" } });
    // and it is named from the conversation rather than left blank
    expect(migrated[0]!.title).not.toBe(UNTITLED_TASK);
  });

  it("names a peer handoff after what was asked, not after the shared preamble", async () => {
    const { titleFromMessage } = await freshStore();
    expect(titleFromMessage("[Message from @Kessler, another bot in this Murage workspace. Reply to them.]\n\nCheck the March invoices\nthen report"))
      .toBe("[Message from @Kessler] Check the March invoices");
    expect(titleFromMessage("[Delegated by @Kessler (Ops Manager), another bot in this Murage workspace. Do the work and reply directly.]\n\n" + "y".repeat(90)))
      .toBe(`[Delegated by @Kessler (Ops Manager)] ${"y".repeat(47)}…`);
    // a peer message with no body keeps the sender rather than the preamble
    expect(titleFromMessage("[Message from @Kessler, another bot in this Murage workspace. Reply to them.]")).toBe("[Message from @Kessler]");
    // an ordinary bracketed first line is left as it was
    expect(titleFromMessage("[draft] Message from @nobody")).toBe("[draft] Message from @nobody");
  });

  it("reports when a task last had a message, and nothing for a task that never did", async () => {
    const { store } = await freshStore();
    const bot = store.createBot(undefined, { seedMessages: false });
    const empty = store.createTask(bot.id)!;
    const used = store.createTask(bot.id)!;
    expect(store.lastActivityAt(empty.threadId)).toBeUndefined();
    store.appendMessage(used.threadId, { role: "user", kind: "text", text: "first", at: 1_000 });
    const reply = store.appendMessage(used.threadId, { role: "bot", kind: "text", text: "second" });
    expect(store.lastActivityAt(used.threadId)).toBe(reply.at);
    expect(store.lastActivityAt(empty.threadId)).toBeUndefined();
  });

  it("reads the last message time from disk for a thread this process has not loaded", async () => {
    const { store } = await freshStore();
    const bot = store.createBot(undefined, { seedMessages: false });
    const task = store.createTask(bot.id)!;
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: "hello", at: 5_000 });
    const { Store } = await import("./store.ts");
    const reopened = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reopened.lastActivityAt(task.threadId)).toBe(5_000);
    store.deleteTask(bot.id, task.threadId);
    expect(store.lastActivityAt(task.threadId)).toBeUndefined();
  });
});
