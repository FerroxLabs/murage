import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { getOrCreateChannel, mirrorExchange, mirrorMurageLine, mirrorNotice } from "./comms-visibility.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("bot-to-bot channel context", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("keeps a new DM in the sender's semantic section", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });

    const channel = getOrCreateChannel(store, from, target);

    expect(channel.dm).toBe(true);
    expect(channel.section).toBe("Agents");
  });

  // B5: several bots share a room's thread, so the "Messaged @X" chip there
  // names who sent it. A direct chat's chip needs no sender.
  it("a Messaged chip in a room names the sender, in a direct chat it does not", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge" });
    const target = store.createBot({ name: "Quarry" });
    const room = store.createGroup("Launch", [from.id, target.id]);
    const bus = { store, broadcast: () => {} };
    const channel = getOrCreateChannel(store, from, target, room.threadId);

    mirrorExchange(bus, from, target, "hello", channel, room.threadId);
    mirrorExchange(bus, from, target, "hello", channel);

    const roomChip = store.messagesFor(room.threadId).find((m) => m.tool?.name === "Messaged @Quarry");
    const directChip = store.messagesFor(from.threadId).find((m) => m.tool?.name === "Messaged @Quarry");
    expect(roomChip?.from).toEqual({ botId: from.id, name: "Forge", color: from.color });
    expect(roomChip?.comm?.groupId).toBe(channel.id);
    expect(directChip).toBeDefined();
    expect(directChip?.from).toBeUndefined();
  });

  it("F1 marks tool-needing teammate requests while preserving plain questions", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Sender" }), target = store.createBot({ name: "Reader" });
    const channel = getOrCreateChannel(store, from, target);
    const bus = { store, broadcast: () => {} };
    mirrorExchange(bus, from, target, "Which format?", channel);
    mirrorExchange(bus, from, target, "Run the delegated task", channel, from.threadId, undefined, "action");
    expect(store.messagesFor(channel.threadId).filter(row => row.kind === "text").map(row => row.inboundKind)).toEqual(["question", "action"]);
  });

  it("updates an existing DM's context without turning Bot Chats into a stored section", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });
    const existing = store.createGroup("Forge ⇄ Quarry", [from.id, target.id], true, "Personal");

    const channel = getOrCreateChannel(store, from, target);

    expect(channel.id).toBe(existing.id);
    expect(channel.section).toBe("Agents");
    expect(channel.section).not.toBe("Bot Chats");
  });

  it("posts a Murage notice with no sender, so it never reads as a bot's own words", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Moss", section: "Agents" });
    const target = store.createBot({ name: "Sable", section: "Agents" });
    const channel = getOrCreateChannel(store, from, target);

    mirrorNotice({ store, broadcast: () => {} }, channel, "Sable could not start: this thread or its group is already working");

    const posted = store.messagesFor(channel.threadId).at(-1)!;
    expect(posted).toMatchObject({ role: "bot", kind: "activity", tool: { name: "Sable could not start: this thread or its group is already working", ok: false } });
    expect(posted.from).toBeUndefined();
    expect(posted.text).toBeUndefined();
    // envelope v2 (SPEC-P 10): said by Murage, as a failure row
    expect(posted.actorKind).toBe("murage");
    expect(posted.murage).toEqual({ kind: "failure" });
  });

  it("mirrorMurageLine carries the request and never a sender", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Moss", section: "Agents" });
    const target = store.createBot({ name: "Sable", section: "Agents" });
    const channel = getOrCreateChannel(store, from, target);
    mirrorMurageLine({ store, broadcast: () => {} }, channel, "Sable is busy right now", { kind: "queue", retry: { requestId: "r1" } }, { requestId: "r1" });
    const posted = store.messagesFor(channel.threadId).at(-1)!;
    expect(posted).toMatchObject({ role: "bot", kind: "activity", actorKind: "murage", requestId: "r1", murage: { kind: "queue", retry: { requestId: "r1" } }, tool: { name: "Sable is busy right now", ok: true } });
    expect(posted.from).toBeUndefined();
  });
});
