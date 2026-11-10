// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createAttentionIpc, ATTENTION_CHANNELS, validateAttentionArgs } from "./attention-ipc.mjs";
import { createAttentionWindowHost } from "./attention-window-host.mjs";
import { createAttentionActions } from "./attention-actions.mjs";
import { ruleIds } from "../scripts/copy-lint.mjs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const urlFor = kind => `file:///fixture/${kind}.html`;
test("float controls accept only registered top frames at their exact entry and take no bot identity", async () => {
  const ipc = createAttentionIpc({ urlFor }), handlers = new Map(), calls = [];
  ipc.install({ handle: (name, callback) => handlers.set(name, callback) }, {
    hideForAnHour: info => { calls.push(info); return { ok: true }; },
    setExpanded: (info, expanded) => { calls.push([info, expanded]); return { ok: true }; },
  });
  const event = (kind, id = 1, extra = {}) => ({ sender: { id }, senderFrame: { url: urlFor(kind), parent: null, ...extra } });
  const hide = handlers.get("attention-window:hide-for-an-hour"), expand = handlers.get("attention-window:set-expanded");
  for (const kind of ["bubble", "dock"]) {
    ipc.register(1, kind);
    assert.equal((await hide(event(kind))).ok, true);
    assert.equal((await expand(event(kind), true)).ok, true);
    const before = calls.length;
    for (const e of [event(kind, 2), event(kind, 1, { parent: {} }), event(kind, 1, { url: urlFor(kind) + "?kind=bubble" })]) {
      assert.equal((await hide(e)).ok, false); assert.equal((await expand(e, true)).ok, false);
    }
    assert.equal((await hide(event(kind), "bot-id")).ok, false);
    assert.equal((await expand(event(kind), "true")).ok, false);
    assert.equal((await expand(event(kind), true, "bot-id")).ok, false);
    assert.equal(calls.length, before);
    if (kind === "dock") assert.equal(ipc.authorize(event(kind), "attention-window:send-to-pinned").ok, false);
    ipc.unregister(1); assert.equal((await hide(event(kind))).ok, false);
  }
  for (const kind of ["flyout", "popover", "popup", "pill"]) {
    ipc.register(1, kind); assert.equal((await hide(event(kind))).ok, false); assert.equal((await expand(event(kind), true)).ok, false);
  }
});
test("preload float controls use only gated channels; change callbacks cannot receive main payloads", async () => {
  let bridge, listener, removed; const calls = [];
  const source = read("./attention-window-preload.cjs");
  runInNewContext(source, { require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => { bridge = value; } },
    ipcRenderer: { invoke: (channel, ...args) => { calls.push([channel, ...args]); return Promise.resolve({ ok: true }); },
      on: (_, cb) => { listener = cb; }, removeListener: (_, cb) => { removed = cb; } } }) });
  await bridge.hideForAnHour(); await bridge.setExpanded(true); await bridge.setExpanded(false);
  assert.deepEqual(calls, [["attention-window:hide-for-an-hour"], ["attention-window:set-expanded", true], ["attention-window:set-expanded", false]]);
  for (const [channel, ...args] of calls) assert.equal(validateAttentionArgs(channel, args).ok, true);
  const channels = [...new Set([...source.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map(match => match[1]))].sort();
  assert.deepEqual(channels, [...ATTENTION_CHANNELS.all].sort());
  let received; const unsubscribe = bridge.onChange((...args) => { received = args; }); listener({}, { botId: "private" });
  assert.deepEqual(received, []); unsubscribe(); assert.equal(removed, listener);
});
test("host scopes cards to visible bots, keeps identities in main, binds actions, and refuses hidden reads", async () => {
  let visible = true, previews = true; const targets = [], minted = [], invalidated = [];
  const rows = [{ botId: "private-alpha", name: "Alpha", state: "needs-you" }, { botId: "private-beta", name: "Beta", state: "idle" }];
  const card = botId => ({ botId, threadId: "private-thread", messageId: "private-message", requestId: "private-request", home: "private-home", epoch: "private-epoch",
    digest: "a".repeat(64), outsideOk: { bubble: true, dock: true }, display: { botName: "Alpha", title: "Read notes", willRun: "cat notes.txt" } });
  const host = createAttentionWindowHost({
    actions: { invalidateSurface: id => invalidated.push(id), mint: entry => { minted.push(entry); return "a".repeat(32); }, act: (...args) => args },
    transportFor: () => ({ current: () => "identity" }),
    readItems: async () => ({ previews, items: [card("private-alpha"), card("hidden-bot")], running: [], receipts: [] }),
    surfaceFor: kind => kind, openTarget: target => targets.push(target),
    floatWindows: { readState: info => visible ? { bots: info.kind === "bubble" ? rows.slice(0, 1) : rows } : null,
      hideForAnHour: kind => ({ ok: kind === "bubble" }), setExpanded: (_, value) => ({ ok: value === true }) },
  });
  const info = { kind: "bubble", windowId: 1 }, first = await host.items(info);
  assert.equal(first.items.length, 1); assert.equal(first.bots.length, 1); assert.equal(first.bots[0].item.openToken, first.items[0].openToken);
  assert.match(first.bots[0].key, /^[0-9a-f]{32}$/); assert.doesNotMatch(JSON.stringify(first), /private-|hidden-bot|botId|threadId|requestId/);
  assert.equal(minted[0].windowId, 1); assert.equal(minted[0].surface, "bubble");
  const next = await host.items(info); assert.equal(next.bots[0].key, first.bots[0].key);
  assert.equal((await host.open(info, first.items[0].openToken)).ok, false);
  assert.equal((await host.open({ ...info, windowId: 2 }, next.items[0].openToken)).ok, false); assert.equal(targets.length, 0);
  host.invalidateWindow(info.windowId, { retainBotKeys: true });
  const retired = await host.items(info); assert.equal(retired.bots[0].key, first.bots[0].key);
  assert.equal((await host.open(info, next.bots[0].openToken)).ok, false);
  const dock = await host.items({ kind: "dock", windowId: 2 });
  assert.equal(dock.bots.length, 2); assert.equal(dock.bots[1].item, null);
  await host.open({ kind: "dock", windowId: 2 }, dock.bots[1].openToken);
  assert.deepEqual(targets, [{ kind: "bot", botId: "private-beta" }]);
  previews = false; const privateView = await host.items(info);
  assert.equal(privateView.bots[0].name, ""); assert.equal(privateView.items[0].actionToken, undefined);
  assert.doesNotMatch(JSON.stringify(privateView), /Alpha|cat notes/);
  visible = false; assert.equal((await host.items(info)).ok, false); assert.equal(host.hideForAnHour(info).ok, false);
  assert.equal((await host.sendToPinned(info, "hello")).ok, false);
  assert.ok(invalidated.length >= 3);
});
test("a float card uses the existing action authority once; unknown, wrong-window and retired tokens cannot answer", async () => {
  const posts = [], info = { kind: "dock", windowId: 1 };
  const record = { botId: "b", home: "local", epoch: "e", threadId: "t", messageId: "m", requestId: "r", digest: "a".repeat(64),
    outsideOk: { dock: true }, display: { botName: "Bot", title: "Read", willRun: "cat notes.txt" } };
  const actions = createAttentionActions({ lock: { locked: () => false } });
  const transport = { current: () => "identity", readCard: async () => ({ ...record, open: true }), post: async body => { posts.push(body); return { ok: true }; } };
  const host = createAttentionWindowHost({ actions, transportFor: () => transport, readItems: async () => ({ previews: true, items: [record] }),
    surfaceFor: kind => kind, openTarget: () => {}, floatWindows: { readState: () => ({ bots: [{ botId: "b", name: "Bot", state: "needs-you" }] }) } });
  let view = await host.items(info);
  assert.equal((await host.act({ ...info, windowId: 2 }, view.bots[0].item.actionToken, "allow")).ok, false);
  assert.equal((await host.act(info, "unknown", "allow")).ok, false); assert.equal(posts.length, 0);
  view = await host.items(info);
  assert.equal((await host.act(info, view.bots[0].item.actionToken, "allow")).ok, true);
  assert.equal((await host.act(info, view.bots[0].item.actionToken, "allow")).ok, false);
  assert.equal(posts.length, 1); assert.equal(posts[0].outside.surface, "dock");
  view = await host.items(info); host.invalidateWindow(info.windowId);
  assert.equal((await host.act(info, view.bots[0].item.actionToken, "allow")).ok, false); assert.equal(posts.length, 1);
});
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
  return entry.isDirectory() ? walk(url) : [url];
});
test("float source has no recurring work or privileged bridges and both entries have strict CSP and build inputs", () => {
  const forbidden = /\b(?:setInterval|requestAnimationFrame|setTimeout|fetch|XMLHttpRequest|WebSocket)\s*\(|\banimation(?:-iteration-count)?\s*:[^;}]*\binfinite\b|\bwindow\.(?:muragebox|murageNative|close)\b/;
  for (const file of walk(new URL("../src/float/", import.meta.url)).filter(url => !/\.test\./.test(url.pathname))) assert.doesNotMatch(readFileSync(file, "utf8"), forbidden);
  for (const kind of ["bubble", "dock"]) {
    const html = read(`../src/float/${kind}.html`);
    assert.match(html, /frame-src 'none'/); assert.match(html, /object-src 'none'/); assert.match(html, new RegExp(`data-float-kind="${kind}"`));
    assert.ok(read("../vite.config.ts").includes(`${kind}: fileURLToPath(new URL("./src/float/${kind}.html"`));
  }
  assert.doesNotMatch(read("../src/float/main.tsx"), /URLSearchParams|location\.search/);
  assert.match(read("../src/components/Sidebar.tsx"), /<PinToEdgeMenuItem key="pin-to-edge" botId=\{bot.id\}/);
});
test("float copy is translated in eight catalogues with matching keys, placeholders and source hashes", () => {
  const en = JSON.parse(read("../src/locales/en.json")), hashes = JSON.parse(read("../src/locales/source-hashes.json"));
  const keys = Object.keys(en).filter(key => key.startsWith("float.")).sort();
  const expected = Object.fromEntries(keys.map(key => [key, createHash("sha256").update(en[key]).digest("hex")]));
  assert.ok(keys.length >= 15);
  const placeholders = value => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
  for (const locale of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    const pack = JSON.parse(read(`../src/locales/${locale}.json`));
    assert.deepEqual(Object.keys(pack).filter(key => key.startsWith("float.")).sort(), keys);
    for (const key of keys) {
      assert.ok(pack[key].trim()); assert.deepEqual(placeholders(pack[key]), placeholders(en[key]));
      assert.doesNotMatch(pack[key], /—|\b(?:safe|free|Forge|Composio)\b/i);
      assert.deepEqual(ruleIds({ locale, value: pack[key] }, { english: en[key] }), [], `${locale}:${key}`);
    }
    if (locale !== "en") assert.deepEqual(Object.fromEntries(keys.map(key => [key, hashes.locales[locale][key]])), expected);
  }
});
