// SPDX-License-Identifier: AGPL-3.0-or-later
// Receipt-stamp producer and replay-proof consumer owner: new3-g5b.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { appendMessage, updateMessage } from "./message-db.ts";
import { assertSendReplayProof, captureSendReplayProof } from "./memory/replay-lineage.ts";
import { SEND_ATTEMPT_SCHEMA_SQL, SendAttemptStore } from "./send-attempt-state.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { createTurnAttribution } from "./turn-attribution.ts";

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  database().exec(SEND_ATTEMPT_SCHEMA_SQL);
});
afterEach(() => { closeDatabase(); });

function fixture(copy = false) {
  const original: Message = { id: "original", at: 1, role: "user", kind: "text", text: "Fixture words", parentId: null };
  appendMessage("source", original);
  const message: Message = { ...original, id: "current", ...(copy ? { copyOf: { threadId: "source", messageIds: [original.id] } } : {}) };
  appendMessage("conversation", message);
  const store = new SendAttemptStore(database());
  const attempt = store.create({ ownerId: "owner", botId: "fixture", threadId: "conversation", sendId: "send", fingerprint: "fixture" });
  store.link(attempt.attemptId, message.id);
  let key = store.bind([attempt.attemptId], { generation: "generation", providerInstanceId: "engine" })[0]!;
  store.transaction(() => {
    store.releaseWrite(key, store.byId(attempt.attemptId)!.revision, 1);
    key = store.allocateProvider(key, store.byId(attempt.attemptId)!.revision, "provider-turn");
    store.acknowledge(key, store.byId(attempt.attemptId)!.revision);
  });
  // Start with a delivered proof, including any copy's complete ancestry.
  // Receipt transitions have their own proof tests; this fixture isolates the stamp.
  return { message, state: { proof: captureSendReplayProof("conversation", [message.id], new Map(), database()) } };
}

it.each([false, true])("keeps the delivered replay proof through attribution and withdrawal (copy=%s)", copy => {
  const { message, state } = fixture(copy), before = state.proof;
  const attribution = createTurnAttribution({
    stamp: (_thread, _id, turnId) => updateMessage("conversation", { ...message, dispatchedIn: turnId }),
    unstamp: () => updateMessage("conversation", { ...message, dispatchedIn: undefined }),
  });
  attribution.begin("generation", "conversation", [message.id]);
  attribution.fencePassed("generation");
  attribution.accepted("generation", "provider-turn");
  expect(() => assertSendReplayProof(state.proof)).not.toThrow();
  expect(captureSendReplayProof("conversation", [message.id], new Map()).epochs).toEqual(before.epochs);
  attribution.notWritten("generation");
  expect(() => assertSendReplayProof(state.proof)).not.toThrow();
});

it("keeps the replay proof when the final publication adds only terminal receipt metadata", () => {
  const { message } = fixture();
  const reply: Message = { ...message, id: "reply", role: "bot", turnId: "provider-turn" };
  appendMessage("conversation", reply);
  const proof = captureSendReplayProof("conversation", [message.id, reply.id]);
  updateMessage("conversation", { ...reply, turnTerminal: true, turnHelpers: [] });
  expect(() => assertSendReplayProof(proof)).not.toThrow();
});

it.each([
  ["words", { text: "Changed fixture words" }],
  ["copy addition", { copyOf: { threadId: "source", messageIds: ["original"] } }],
  ["copy removal", { copyOf: undefined }],
  ["copy replacement", { copyOf: { threadId: "source", messageIds: ["missing"] } }],
  ["withheld mark", { withheldFromBots: true }],
  ["parent", { parentId: "another-parent" }],
  ["role", { role: "bot" }],
  ["other delivery metadata", { steerUnconfirmed: true }],
] as const)("still invalidates a stamp that also changes %s", (kind, patch) => {
  const { message, state } = fixture(kind === "copy removal" || kind === "copy replacement");
  updateMessage("conversation", { ...message, dispatchedIn: "provider-turn", ...patch } as Message);
  expect(() => assertSendReplayProof(state.proof)).toThrow("SEND_REPLAY_CHANGED");
});
