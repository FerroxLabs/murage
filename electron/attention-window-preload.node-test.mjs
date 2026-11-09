// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ATTENTION_CHANNELS, validateAttentionArgs } from "./attention-ipc.mjs";

test("preload exposes only gated methods and a payload-less change subscription", async () => {
  const source = readFileSync(new URL("./attention-window-preload.cjs", import.meta.url), "utf8");
  const channels = [...source.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(channels)].sort(), [...ATTENTION_CHANNELS.all].sort());
  let bridge, listener, removed; const calls = [];
  runInNewContext(source, { require: name => {
    assert.equal(name, "electron"); return {
      contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "attentionWindow"); bridge = value; } },
      ipcRenderer: { invoke: (channel, ...args) => { calls.push([channel, ...args]); return Promise.resolve({ ok: true }); },
        on: (channel, cb) => { assert.equal(channel, "attention-window:changed"); listener = cb; },
        removeListener: (channel, cb) => { removed = channel; assert.equal(cb, listener); } },
    };
  } });
  assert.deepEqual(Object.keys(bridge).sort(), ["items", "act", "open", "sendToChief", "pauseAutomations", "sendToPinned", "onChange"].sort());
  await bridge.items(); await bridge.act("a".repeat(32), "allow"); await bridge.act("a".repeat(32), "reply", "hi");
  await bridge.open("a".repeat(32)); await bridge.sendToChief("hi"); await bridge.pauseAutomations(); await bridge.sendToPinned("hi");
  for (const [channel, ...args] of calls) assert.equal(validateAttentionArgs(channel, args).ok, true);
  let received; const unsubscribe = bridge.onChange((...args) => { received = args; });
  listener({ sender: "private" }, "private"); assert.deepEqual(received, []);
  unsubscribe(); assert.equal(removed, "attention-window:changed");
});
