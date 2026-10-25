import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIPBOARD_MAX_BYTES, writeClipboardText } from "./clipboard-write.mjs";

const ORIGIN = "http://127.0.0.1:8799";

function fixture({ url = `${ORIGIN}/index.html` } = {}) {
  const mainFrame = { url, detached: false };
  const webContents = { mainFrame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  return { window, event: { sender: webContents, senderFrame: mainFrame } };
}
function board() {
  const written = [];
  return { written, clipboard: { writeText: (text) => { written.push(text); } } };
}

test("writes text from the main window on its own origin", () => {
  const { window, event } = fixture(), { clipboard, written } = board();
  assert.equal(writeClipboardText(event, "hello", { clipboard, window, origin: ORIGIN }), true);
  assert.deepEqual(written, ["hello"]);
});

test("refuses another window, a foreign origin and a subframe", () => {
  const owned = fixture(), other = fixture(), foreign = fixture({ url: "https://example.com/" }), { clipboard, written } = board();
  assert.equal(writeClipboardText(other.event, "x", { clipboard, window: owned.window, origin: ORIGIN }), false);
  assert.equal(writeClipboardText(foreign.event, "x", { clipboard, window: foreign.window, origin: ORIGIN }), false);
  const sub = { sender: owned.window.webContents, senderFrame: { url: `${ORIGIN}/`, detached: false } };
  assert.equal(writeClipboardText(sub, "x", { clipboard, window: owned.window, origin: ORIGIN }), false);
  assert.deepEqual(written, []);
});

test("writes text only, and nothing empty", () => {
  const { window, event } = fixture(), { clipboard, written } = board();
  for (const bad of [undefined, null, 42, {}, ["a"], ""]) assert.equal(writeClipboardText(event, bad, { clipboard, window, origin: ORIGIN }), false);
  assert.deepEqual(written, []);
});

test("caps text at 1 MB measured in bytes", () => {
  const { window, event } = fixture(), { clipboard, written } = board();
  assert.equal(writeClipboardText(event, "a".repeat(CLIPBOARD_MAX_BYTES), { clipboard, window, origin: ORIGIN }), true);
  assert.equal(writeClipboardText(event, "a".repeat(CLIPBOARD_MAX_BYTES + 1), { clipboard, window, origin: ORIGIN }), false);
  // 3 bytes per character: under the character count, over the byte cap
  assert.equal(writeClipboardText(event, "€".repeat(400_000), { clipboard, window, origin: ORIGIN }), false);
  assert.equal(written.length, 1);
});

test("reports false when the system clipboard throws", () => {
  const { window, event } = fixture();
  assert.equal(writeClipboardText(event, "x", { clipboard: { writeText() { throw new Error("busy"); } }, window, origin: ORIGIN }), false);
});
