// Archiving a channel. A bot has always had an end state that is not
// delete: `hidden`. A channel had only delete, which meant the one way to
// clear a finished room out of the list destroyed its transcript with it.
// These tests hold the new end state to the promise: everything is kept,
// the channel simply leaves the main list.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home: string;

async function freshStore() {
  home = mkdtempSync(join(tmpdir(), "murage-channel-archive-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), Store };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("archiving a channel", () => {
  it("keeps every member, message and task, and leaves the visible list", async () => {
    const { store } = await freshStore();
    const one = store.createBot();
    const two = store.createBot();
    const channel = store.createGroup("Winter catalogue", [one.id, two.id]);
    const first = channel.threadId;
    store.patchGroup(channel.id, { bulletin: "Ship it before the shops order." });
    store.appendMessage(first, { role: "user", kind: "text", text: "Where are we?" });
    const second = store.createGroupTask(channel.id)!;
    store.appendMessage(second.threadId, { role: "user", kind: "text", text: "Second conversation" });

    expect(store.visibleThreadIds()).toContain(first);
    expect(store.visibleThreadIds()).toContain(second.threadId);

    const archived = store.patchGroup(channel.id, { hidden: true })!;

    expect(archived.hidden).toBe(true);
    // Everything it had, it still has.
    expect(archived.memberIds).toEqual([one.id, two.id]);
    expect(archived.bulletin).toBe("Ship it before the shops order.");
    expect(store.group(channel.id)).toBeDefined();
    expect(store.messagesFor(first).map((message) => message.text)).toContain("Where are we?");
    expect(store.messagesFor(second.threadId).map((message) => message.text)).toContain("Second conversation");
    expect(store.groupTasks(channel.id)).toHaveLength(2);
    // ...and it is out of the list a remote door is shown, exactly as an
    // archived bot's threads are.
    expect(store.visibleThreadIds()).not.toContain(first);
    expect(store.visibleThreadIds()).not.toContain(second.threadId);
  });

  it("survives a restart and comes back when un-archived", async () => {
    const { store, Store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Winter catalogue", [bot.id]);
    store.patchGroup(channel.id, { hidden: true });

    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.group(channel.id)?.hidden).toBe(true);
    expect(reloaded.visibleThreadIds()).not.toContain(channel.threadId);

    const restored = reloaded.patchGroup(channel.id, { hidden: undefined })!;
    expect(restored.hidden).toBeUndefined();
    expect(reloaded.visibleThreadIds()).toContain(channel.threadId);

    const afterRestore = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(afterRestore.group(channel.id)?.hidden).toBeUndefined();
  });

  it("leaves an ordinary channel entirely alone", async () => {
    const { store, Store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Kitchen table", [bot.id]);
    store.appendMessage(channel.threadId, { role: "user", kind: "text", text: "Morning" });

    // The two new keys are absent on a channel nobody archived and nobody
    // gave a purpose to. A record written before either existed looks like
    // this, which is why neither needs a migration.
    expect(store.group(channel.id)).not.toHaveProperty("hidden");
    expect(store.group(channel.id)).not.toHaveProperty("channelProject");
    expect(store.visibleThreadIds()).toContain(channel.threadId);

    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.group(channel.id)).not.toHaveProperty("hidden");
    expect(reloaded.group(channel.id)).not.toHaveProperty("channelProject");
    expect(reloaded.messagesFor(channel.threadId).map((message) => message.text)).toContain("Morning");
  });

  it("stores a project block on a channel and gives it back unchanged", async () => {
    const { store, Store } = await freshStore();
    const bot = store.createBot();
    const channel = store.createGroup("Winter catalogue", [bot.id]);
    const project = { goal: "Get the winter range into the shops by October.", status: "active" as const, startedAt: 1_000, updatedAt: 1_000 };

    const patched = store.patchGroup(channel.id, { channelProject: project })!;
    expect(patched.channelProject).toEqual(project);

    // Archiving a project leaves the channel able to live on: the block and
    // the transcript are both still there when it comes back.
    store.patchGroup(channel.id, { hidden: true });
    const reloaded = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reloaded.group(channel.id)?.channelProject).toEqual(project);
    reloaded.patchGroup(channel.id, { hidden: undefined });
    expect(reloaded.group(channel.id)?.channelProject).toEqual(project);
  });
});
