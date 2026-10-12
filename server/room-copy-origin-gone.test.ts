// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review round 7, R7-01: a copy of a worker's answer, mirrored into the pair room, is shown to a bot's next turn only while the original it was
// copied from is still stored and still shareable. The check is the same one the result gate makes, and it holds when memory is off.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeDatabase, database } from "./database.ts";
import { getOrCreateChannel, mirrorReply } from "./comms-visibility.ts";
import { closeMessageDb, deleteThread } from "./message-db.ts";
import { partitionTranscriptMessages } from "./partition-sources.ts";
import { roomTranscriptWithoutMemory } from "./room-transcript.ts";
import { Store } from "./store.ts";
import { released } from "./testing/released.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
beforeEach(() => { closeMessageDb(); closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); });

function mirrored() {
  const store = new Store(selection);
  const asker = store.createBot({ name: "Asker" }), worker = store.createBot({ name: "Worker" });
  const channel = getOrCreateChannel(store, asker, worker);
  const original = store.appendMessage(worker.threadId, { role: "bot", kind: "text", text: "DELETED ANSWER" });
  const copyOf = { threadId: worker.threadId, messageIds: [original.id] };
  mirrorReply({ store, broadcast: () => {} }, worker, released("DELETED ANSWER", copyOf), channel, copyOf);
  const room = () => store.messagesFor(channel.threadId);
  return { store, asker, worker, channel, original, room };
}
const texts = (messages: Array<{ text?: string }>) => messages.map(message => message.text ?? "").join("\n");

describe("memory off: a surviving mirror does not outlive its original", () => {
  it("control: while the original is stored, the next turn reads the mirror", () => {
    const { asker, channel, room } = mirrored();
    const floor = roomTranscriptWithoutMemory(channel.threadId, room(), true);
    expect(texts(floor!.messages)).toContain("DELETED ANSWER");
    expect(texts(partitionTranscriptMessages(database(), asker.id, channel.threadId, floor!.messages))).toContain("DELETED ANSWER");
  });

  it("the owner deletes the worker's conversation: the next turn's transcript no longer carries the answer", () => {
    const { asker, worker, channel, room } = mirrored();
    deleteThread(worker.threadId);
    const owner = roomTranscriptWithoutMemory(channel.threadId, room(), true);
    expect(owner).toBeDefined();
    expect(texts(owner!.messages)).not.toContain("DELETED ANSWER");
    // a reader that is not the owner's audience never sees the line at all
    const other = roomTranscriptWithoutMemory(channel.threadId, room(), false);
    expect(texts(other!.messages)).not.toContain("DELETED ANSWER");
    // and the prompt's own filter agrees, for a bot with no partition
    expect(texts(partitionTranscriptMessages(database(), asker.id, channel.threadId, room()))).not.toContain("DELETED ANSWER");
  });

  it("an original withheld from bots takes its mirror with it", () => {
    const { asker, store, worker, channel, original, room } = mirrored();
    store.patchMessage(worker.threadId, original.id, { withheldFromBots: true });
    const floor = roomTranscriptWithoutMemory(channel.threadId, room(), false);
    expect(texts(floor!.messages)).not.toContain("DELETED ANSWER");
    expect(texts(partitionTranscriptMessages(database(), asker.id, channel.threadId, room()))).not.toContain("DELETED ANSWER");
  });
});
