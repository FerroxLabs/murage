import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { answerWhatsAppAuthKeyRequest, isWhatsAppAuthKeyRequest, WHATSAPP_AUTH_KEY_REPLY } from "./whatsapp-auth-key.mjs";

const KEY = "ab".repeat(32);
function harness({ unavailable = false, document = {}, failUpdate = false } = {}) {
  const state = { document: { ...document }, replies: [], updates: 0 };
  return {
    state,
    deps: {
      credentialStoreUnavailable: () => unavailable,
      readCredentials: () => state.document,
      updateCredentials: async (derive) => { state.updates++; if (failUpdate) throw new Error("disk"); state.document = derive(state.document); },
      reply: (message) => state.replies.push(message),
      mint: () => KEY,
    },
  };
}

test("recognises only the request message", () => {
  assert.equal(isWhatsAppAuthKeyRequest({ type: "murage:whatsapp-auth-key-request" }), true);
  assert.equal(isWhatsAppAuthKeyRequest({ type: "murage:whatsapp-auth-key" }), false);
  assert.equal(isWhatsAppAuthKeyRequest(null), false);
});

test("mints once on first request, persists it and replies with it", async () => {
  const { state, deps } = harness({ document: { other: "keep" } });
  await answerWhatsAppAuthKeyRequest(deps);
  assert.deepEqual(state.replies, [{ type: WHATSAPP_AUTH_KEY_REPLY, key: KEY }]);
  assert.equal(state.document.whatsappAuthKey, KEY);
  assert.equal(state.document.other, "keep");
});

test("an existing key is returned and never regenerated", async () => {
  const stored = "cd".repeat(32);
  const { state, deps } = harness({ document: { whatsappAuthKey: stored } });
  await answerWhatsAppAuthKeyRequest(deps);
  assert.equal(state.updates, 0);
  assert.equal(state.replies[0].key, stored);
});

test("a malformed stored key fails closed and is left exactly as it is", async () => {
  const { state, deps } = harness({ document: { whatsappAuthKey: "not-hex" } });
  await answerWhatsAppAuthKeyRequest(deps);
  assert.equal(state.replies[0].key, null);
  assert.equal(state.updates, 0);
  assert.equal(state.document.whatsappAuthKey, "not-hex");
});

test("an unavailable credential store answers null and writes nothing", async () => {
  const { state, deps } = harness({ unavailable: true });
  await answerWhatsAppAuthKeyRequest(deps);
  assert.equal(state.replies[0].key, null);
  assert.equal(state.updates, 0);
});

test("a failed write answers null", async () => {
  const { state, deps } = harness({ failUpdate: true });
  await answerWhatsAppAuthKeyRequest(deps);
  assert.equal(state.replies[0].key, null);
});

test("a key minted by another writer in the meantime wins", async () => {
  const other = "ef".repeat(32);
  const { state, deps } = harness();
  deps.updateCredentials = async (derive) => { state.document = { whatsappAuthKey: other }; state.document = derive(state.document); };
  await answerWhatsAppAuthKeyRequest(deps);
  assert.equal(state.replies[0].key, other);
});

test("main.mjs routes the request through this module and never logs the key", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(source, /isWhatsAppAuthKeyRequest\(message\)/);
  assert.doesNotMatch(source, /slog\([^)]*[wW]hatsappAuthKey/);
  const module = readFileSync(new URL("./whatsapp-auth-key.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(module, /console\.|slog\(/);
});
