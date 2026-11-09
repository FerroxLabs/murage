// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { createAttentionWindowHost } from "./attention-window-host.mjs";
import { createAttentionActions } from "./attention-actions.mjs";

const info = { kind: "flyout", windowId: 7 };
function fixture(overrides = {}) {
  const calls = [], invalidated = [];
  const record = { home: "local", epoch: "e", threadId: "t", messageId: "m", requestId: "r", digest: "a".repeat(64), outsideOk: { flyout: true }, display: { botName: "Chief", title: "Read", willRun: "cat notes.txt" } };
  let data = { previews: true, items: [record], running: [], receipts: [], chief: { name: "Chief" } };
  const transport = { current: () => "identity", readCard: async () => ({ ...record, open: true }), post: async body => { calls.push(body); return { ok: true }; } };
  const actions = createAttentionActions({ lock: { locked: () => false } });
  const invalidate = actions.invalidateSurface;
  actions.invalidateSurface = id => { invalidated.push(id); invalidate(id); };
  const host = createAttentionWindowHost({ actions, transportFor: () => transport, readItems: async () => data,
    surfaceFor: () => "flyout", openTarget: target => calls.push(["open", target]),
    sendToChief: text => { calls.push(["chief", text]); return { ok: true }; },
    sendToPinned: text => { calls.push(["pinned", text]); return { ok: true }; }, pauseAutomations: () => ({ ok: true }), ...overrides });
  return { host, actions, record, calls, invalidated, setData: value => { data = value; } };
}
test("actions require this surface, a digest, previews and the whole display", async () => {
  for (const patch of [{}, { outsideOk: { menu: true } }, { digest: undefined }, { display: null }]) {
    const f = fixture(); f.setData({ previews: true, items: [{ ...f.record, ...patch }] });
    const result = await f.host.items(info);
    assert.equal(Boolean(result.items[0].actionToken), Object.keys(patch).length === 0);
    assert.match(result.items[0].openToken, /^[a-f0-9]{32}$/);
  }
  for (const previews of [false, undefined]) {
    const f = fixture(); f.setData({ previews, items: [f.record], running: [{ botName: "private" }], receipts: [{ text: "private" }] });
    const result = await f.host.items(info);
    assert.equal(f.actions.size, 0); assert.equal(result.items[0].display, null);
    assert.doesNotMatch(JSON.stringify(result), /private|notes\.txt|threadId|requestId|digest/);
  }
  const unknown = fixture({ surfaceFor: () => "unknown" });
  unknown.record.outsideOk.unknown = true;
  assert.equal((await unknown.host.items(info)).items[0].actionToken, undefined);
});
test("four live receipts obey each surface's limit and floating content filter", async () => {
  const f = fixture({ floatWindows: { readState: () => ({ bots: [] }) } });
  const receipts = Array.from({ length: 4 }, (_, i) => ({ text: `Finished ${i + 1}` }));
  const running = [{ botName: "Bot", doing: "Reading notes" }], chief = { name: "Chief" };
  for (const kind of ["flyout", "popover", "popup", "bubble", "dock", "pill"]) {
    const floating = kind === "bubble" || kind === "dock";
    f.setData({ previews: true, receipts, running, chief });
    const result = await f.host.items({ ...info, kind });
    assert.deepEqual(result.receipts, floating ? [] : kind === "pill" ? receipts : receipts.slice(-3), kind);
    assert.deepEqual(result.running, floating ? [] : running, kind);
    assert.deepEqual(result.chief, floating ? null : chief, kind);
    f.setData({ previews: false, receipts, running, chief });
    const hidden = await f.host.items({ ...info, kind });
    assert.deepEqual(hidden.receipts, [], kind);
    assert.deepEqual(hidden.running, [], kind);
    assert.deepEqual(hidden.chief, floating ? null : { name: "" }, kind);
  }
  const many = Array.from({ length: 101 }, (_, i) => ({ text: `Finished ${i + 1}` }));
  f.setData({ previews: true, receipts: many });
  assert.deepEqual((await f.host.items({ ...info, kind: "pill" })).receipts, many.slice(-100));
});
test("act binds the window and uses the real action transport exactly once", async () => {
  const f = fixture(), first = await f.host.items(info);
  assert.equal((await f.host.act({ ...info, windowId: 8 }, first.items[0].actionToken, "allow")).reason, "window");
  assert.equal(f.calls.length, 0);
  const next = await f.host.items(info);
  assert.deepEqual(await f.host.act(info, next.items[0].actionToken, "allow"), { ok: true });
  await f.host.act(info, next.items[0].actionToken, "allow"); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].outside.surface, "flyout");
});
test("refresh spends old action and Open tokens; Open cannot answer or cross windows", async () => {
  const f = fixture(), old = await f.host.items(info), next = await f.host.items(info);
  assert.equal(f.invalidated.length, 1);
  assert.equal((await f.host.act(info, old.items[0].actionToken, "allow")).ok, false);
  assert.equal((await f.host.open(info, old.items[0].openToken)).ok, false);
  assert.equal((await f.host.act(info, next.items[0].openToken, "allow")).ok, false);
  assert.equal((await f.host.open(info, next.items[0].actionToken)).ok, false);
  assert.equal((await f.host.open({ ...info, windowId: 8 }, next.items[0].openToken)).ok, false);
  const fresh = await f.host.items(info);
  assert.equal((await f.host.open(info, fresh.items[0].openToken)).ok, true);
  assert.equal((await f.host.open(info, fresh.items[0].openToken)).ok, false);
  assert.deepEqual(f.calls, [["open", { kind: "approval", home: "local", threadId: "t", messageId: "m" }]]);
});
test("opaque card identity survives token refresh but changes with the request or privacy", async () => {
  const f = fixture(), first = await f.host.items(info);
  f.setData({ previews: true, items: [f.record], running: [{ botName: "Other", doing: "Working" }], receipts: [{ text: "Done" }] });
  const refreshed = await f.host.items(info);
  assert.match(first.items[0].cardId, /^[a-f0-9]{32}$/);
  assert.equal(refreshed.items[0].cardId, first.items[0].cardId);
  assert.notEqual(refreshed.items[0].openToken, first.items[0].openToken);
  assert.notEqual(refreshed.items[0].actionToken, first.items[0].actionToken);
  assert.equal((await f.host.open(info, first.items[0].cardId)).ok, false);
  assert.equal((await f.host.act(info, first.items[0].cardId, "allow")).ok, false);
  assert.equal(f.calls.length, 0);
  for (const patch of [{ home: "another" }, { epoch: "next" }, { threadId: "next" }, { messageId: "next" }, { requestId: "next" }, { digest: "b".repeat(64) }, { display: { ...f.record.display, willRun: "cat other.txt" } }]) {
    f.setData({ previews: true, items: [f.record] }); const before = await f.host.items(info);
    f.setData({ previews: true, items: [{ ...f.record, ...patch }] });
    assert.notEqual((await f.host.items(info)).items[0].cardId, before.items[0].cardId);
  }
  f.setData({ previews: true, items: [f.record] }); const beforePrivacy = await f.host.items(info);
  f.setData({ previews: false, items: [f.record] }); const hidden = await f.host.items(info);
  assert.equal(hidden.items[0].display, null); assert.notEqual(hidden.items[0].cardId, beforePrivacy.items[0].cardId);
  f.setData({ previews: true, items: [f.record] }); const restored = await f.host.items(info);
  assert.notEqual(restored.items[0].cardId, beforePrivacy.items[0].cardId);
  assert.notEqual(restored.items[0].cardId, hidden.items[0].cardId);
  const otherWindow = await f.host.items({ ...info, windowId: 8 });
  assert.notEqual(otherWindow.items[0].cardId, restored.items[0].cardId);
  f.host.invalidateWindow(info.windowId);
  assert.notEqual((await f.host.items(info)).items[0].cardId, restored.items[0].cardId);
});
test("Chief and pinned sends trim and strip controls, reject empty or long text, and stay on their injected route", async () => {
  const f = fixture();
  assert.equal((await f.host.sendToChief(info, " \u0000hello\nthere\t ")).ok, true);
  assert.deepEqual(f.calls, [["chief", "hello\nthere"]]);
  for (const text of [" \u0000 ", "x".repeat(4001), null]) assert.equal((await f.host.sendToChief(info, text)).ok, false);
  assert.equal((await f.host.sendToPinned({ kind: "bubble", windowId: 9 }, " pinned ")).ok, true);
  assert.deepEqual(f.calls[1], ["pinned", "pinned"]);
});
test("a superseded read cannot mint tokens and teardown spends the last generation", async () => {
  let release; const f = fixture();
  const pending = new Promise(resolve => { release = resolve; });
  f.setData(pending); const older = f.host.items(info);
  f.setData({ previews: true, items: [f.record] }); const newer = await f.host.items(info);
  release({ previews: true, items: [f.record] });
  assert.equal((await older).ok, false); assert.equal(f.actions.size, 1);
  f.host.invalidateWindow(info.windowId);
  assert.equal((await f.host.act(info, newer.items[0].actionToken, "allow")).ok, false);
  assert.equal((await f.host.open(info, newer.openToken)).ok, false);
});
test("send and pause return only a verdict, never the route's private payload", async () => {
  const f = fixture({ sendToChief: async () => ({ threadId: "private", messageId: "private" }), pauseAutomations: async () => ({ paused: true, internal: "private" }) });
  assert.deepEqual(await f.host.sendToChief(info, "hello"), { ok: true });
  assert.deepEqual(await f.host.pauseAutomations(info), { ok: true });
  const refused = fixture({ sendToChief: async () => ({ ok: false, reason: "private" }), pauseAutomations: async () => ({ ok: false, secret: "private" }) });
  assert.deepEqual(await refused.host.sendToChief(info, "hello"), { ok: false, reason: "refused" });
  assert.deepEqual(await refused.host.pauseAutomations(info), { ok: false, reason: "refused" });
});
test("a pushed refresh that retains card ids keeps the same cardId across invalidateWindow; a plain invalidation (privacy, teardown) does not", async () => {
  const f = fixture();
  const first = await f.host.items(info);
  f.host.invalidateWindow(info.windowId, { retainCards: true });
  const kept = await f.host.items(info);
  assert.equal(kept.items[0].cardId, first.items[0].cardId);
  assert.notEqual(kept.items[0].actionToken, first.items[0].actionToken, "tokens are always fresh");
  f.host.invalidateWindow(info.windowId);
  const dropped = await f.host.items(info);
  assert.notEqual(dropped.items[0].cardId, first.items[0].cardId);
});
