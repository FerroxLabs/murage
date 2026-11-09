import test from "node:test";
import assert from "node:assert/strict";
import { createAttentionIpc, ATTENTION_CHANNELS, validateAttentionArgs } from "./attention-ipc.mjs";

const URL_FLYOUT = "file:///app/dist/attention/flyout.html";
const URL_BUBBLE = "file:///app/dist/attention/bubble.html";
function rig() {
  const ipc = createAttentionIpc({ urlFor: kind => ({ flyout: URL_FLYOUT, bubble: URL_BUBBLE, pill: "file:///app/dist/attention/pill.html" })[kind] ?? null });
  const evt = (id, url = URL_FLYOUT, over = {}) => ({ sender: { id }, senderFrame: { url, parent: null, ...over.frame }, ...over.event });
  return { ipc, evt };
}

test("an unregistered window is refused on every channel", () => {
  const { ipc, evt } = rig();
  for (const channel of ATTENTION_CHANNELS.all) assert.equal(ipc.authorize(evt(7), channel).ok, false);
});

test("a registered window's top frame at its exact URL is honoured on its kind's channels only", () => {
  const { ipc, evt } = rig(); ipc.register(7, "flyout"); ipc.register(8, "bubble");
  assert.deepEqual(ipc.authorize(evt(7), "attention-window:items"), { ok: true, kind: "flyout", windowId: 7 });
  assert.equal(ipc.authorize(evt(7), "attention-window:send-to-chief").ok, true);
  assert.equal(ipc.authorize(evt(7), "attention-window:send-to-pinned").ok, false, "wrong kind channel");
  assert.equal(ipc.authorize(evt(8, URL_BUBBLE), "attention-window:send-to-pinned").ok, true);
  assert.equal(ipc.authorize(evt(8, URL_BUBBLE), "attention-window:pause-automations").ok, false);
});

test("subframes, navigated documents, query-string variants and a wrong URL are refused", () => {
  const { ipc, evt } = rig(); ipc.register(7, "flyout");
  assert.equal(ipc.authorize(evt(7, URL_FLYOUT, { frame: { parent: {} } }), "attention-window:items").reason, "subframe");
  assert.equal(ipc.authorize(evt(7, "https://evil.example/"), "attention-window:items").reason, "url");
  assert.equal(ipc.authorize(evt(7, URL_FLYOUT + "?x=1"), "attention-window:items").reason, "url");
  assert.equal(ipc.authorize(evt(7, URL_BUBBLE), "attention-window:items").reason, "url");
  assert.equal(ipc.authorize({ sender: { id: 7 } }, "attention-window:items").reason, "frame");
  assert.equal(ipc.authorize(null, "attention-window:items").reason, "frame");
});

test("an unknown channel and an unregistered-then-unregistered window are refused", () => {
  const { ipc, evt } = rig(); ipc.register(7, "flyout");
  assert.equal(ipc.authorize(evt(7), "attention-window:nope").ok, false);
  ipc.unregister(7); assert.equal(ipc.authorize(evt(7), "attention-window:items").ok, false);
});

test("an unknown kind cannot be registered", () => {
  const { ipc } = rig();
  assert.throws(() => ipc.register(1, "main"));
});

test("act passes the sender's window id as context, never anything from the payload", async () => {
  const { ipc, evt } = rig(); ipc.register(7, "flyout");
  const calls = [];
  const handlers = new Map();
  ipc.install({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    items: ({ kind, windowId }) => ({ kind, windowId, list: [] }),
    act: async (info, token, action, text) => { calls.push([info, token, action, text]); return { ok: true }; },
    open: async () => ({ ok: true }),
    sendToChief: async () => ({ ok: true }), pauseAutomations: async () => ({ ok: true }), sendToPinned: async () => ({ ok: true }),
  });
  const token = "a".repeat(32);
  assert.deepEqual(await handlers.get("attention-window:act")(evt(7), token, "allow"), { ok: true });
  assert.deepEqual(calls[0][0], { kind: "flyout", windowId: 7 });
  // From a window that was not registered: refused, the handler is not called.
  const before = calls.length;
  assert.deepEqual(await handlers.get("attention-window:act")(evt(9), token, "allow"), { ok: false, reason: "refused" });
  assert.equal(calls.length, before);
});

test("argument validation: token shape, action letter, text 1..4000 chars", () => {
  assert.equal(validateAttentionArgs("attention-window:act", ["a".repeat(32), "allow"]).ok, true);
  assert.equal(validateAttentionArgs("attention-window:act", ["a".repeat(32), "reply", "hi"]).ok, true);
  assert.equal(validateAttentionArgs("attention-window:act", ["short", "allow"]).ok, false);
  assert.equal(validateAttentionArgs("attention-window:act", ["a".repeat(32), "all-for-12h"]).ok, false);
  assert.equal(validateAttentionArgs("attention-window:act", ["a".repeat(32), "allow", "x".repeat(10)]).ok, false, "text only on reply");
  assert.equal(validateAttentionArgs("attention-window:send-to-chief", ["hello"]).ok, true);
  assert.equal(validateAttentionArgs("attention-window:send-to-chief", [""]).ok, false);
  assert.equal(validateAttentionArgs("attention-window:send-to-chief", ["x".repeat(4001)]).ok, false);
  assert.equal(validateAttentionArgs("attention-window:send-to-chief", [42]).ok, false);
  assert.equal(validateAttentionArgs("attention-window:open", ["a".repeat(32)]).ok, true);
  assert.equal(validateAttentionArgs("attention-window:items", []).ok, true);
});
