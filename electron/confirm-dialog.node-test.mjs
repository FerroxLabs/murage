// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A confirmation anchored to the Murage window. Adapted from OpenMausBot
// #1840 (Apache-2.0): window.confirm() has no parent, so tiling window
// managers drop it at the screen origin instead of over the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createConfirmDialogHandler } from "./confirm-dialog.mjs";

const ORIGIN = "http://127.0.0.1:48994";

function fixture(response = 1) {
  const calls = [];
  const frame = { url: `${ORIGIN}/` };
  const contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  const confirm = createConfirmDialogHandler({
    window: () => window,
    origin: () => ORIGIN,
    showMessageBox: async (...args) => { calls.push(args); return { response }; },
  });
  return { confirm, calls, window, event: { sender: contents, senderFrame: frame } };
}

test("the confirmation is parented to the Murage window, defaults to Cancel and accepts only the action button", async () => {
  for (const [response, expected] of [[1, true], [0, false], [-1, false]]) {
    const f = fixture(response);
    assert.equal(await f.confirm(f.event, "Delete the Local VM?", "Delete"), expected);
    const [parent, options] = f.calls[0];
    assert.equal(parent, f.window);
    assert.deepEqual(options, { type: "warning", message: "Delete the Local VM?", buttons: ["Cancel", "Delete"], defaultId: 0, cancelId: 0, noLink: true });
  }
});

test("the action button reads OK when none is given, and a bad label falls back to OK", async () => {
  for (const label of [undefined, "", "   ", 7, "x".repeat(41)]) {
    const f = fixture();
    await f.confirm(f.event, "Replace it?", label);
    assert.deepEqual(f.calls[0][1].buttons, ["Cancel", "OK"]);
  }
});

test("other windows, subframes and navigated-away pages never open a confirmation", async () => {
  const f = fixture();
  for (const event of [
    { sender: f.event.sender, senderFrame: { url: `${ORIGIN}/child` } },
    { sender: { mainFrame: f.event.senderFrame }, senderFrame: f.event.senderFrame },
    { sender: f.event.sender, senderFrame: { url: "https://untrusted.example/" } },
    { sender: f.event.sender },
    null,
  ]) {
    if (event?.senderFrame?.url === "https://untrusted.example/") f.event.sender.mainFrame = event.senderFrame;
    assert.equal(await f.confirm(event, "Delete?"), false);
    f.event.sender.mainFrame = f.event.senderFrame;
  }
  assert.equal(f.calls.length, 0);
});

test("a bad message or a closed window fails closed without a dialog", async () => {
  const f = fixture();
  for (const message of [null, {}, "", " ", "x".repeat(4097)]) assert.equal(await f.confirm(f.event, message), false);
  f.window.isDestroyed = () => true;
  assert.equal(await f.confirm(f.event, "Delete?"), false);
  assert.equal(f.calls.length, 0);
});

test("main registers it for the owned window and the preload exposes it", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /ipcMain\.handle\("dialog:confirm", createConfirmDialogHandler\(\{\s*\.\.\.ownedMainRenderer,/);
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /confirm: \(message, confirmLabel\) => ipcRenderer\.invoke\("dialog:confirm", message, confirmLabel\)/);
});
