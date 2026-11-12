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

// ---- S8R: commit-time continuity, superseded vs discarded, rev (design Q6 H1..H6) ----
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function gated(overrides = {}, recordPatch = {}) {
  const gates = []; let f;
  const base = () => ({ previews: true, items: [{ ...f.record, ...recordPatch }], running: [], receipts: [], chief: { name: "Chief" } });
  f = fixture({ readItems: () => gates.length ? gates.shift().promise : Promise.resolve(base()), ...overrides });
  return { f, base, hold: () => { const gate = deferred(); gates.push(gate); return gate; } };
}
const botState = { bots: [{ botId: "b1", name: "Beta", state: "needs-you" }] };
const bubbleInfo = { kind: "bubble", windowId: 9 };
const settle = () => new Promise(resolve => setImmediate(resolve));

test("H1 a push (retainCards) during a pending read supersedes it, mints nothing, and the next read keeps the cardId", async () => {
  const { f, base, hold } = gated(); const first = await f.host.items(info);
  const gate = hold(), pending = f.host.items(info);
  f.host.invalidateWindow(info.windowId, { retainCards: true });
  const minted = f.actions.size; gate.resolve(base());
  assert.deepEqual(await pending, { ok: false, reason: "superseded" }); assert.equal(f.actions.size, minted);
  const second = await f.host.items(info);
  assert.equal(second.items[0].cardId, first.items[0].cardId);
  assert.notEqual(second.items[0].actionToken, first.items[0].actionToken);
});
test("H2 a discard (plain invalidateWindow) during a pending read is reported as discarded and drops identity", async () => {
  const { f, base, hold } = gated(); const first = await f.host.items(info);
  const gate = hold(), pending = f.host.items(info);
  f.host.invalidateWindow(info.windowId); const minted = f.actions.size; gate.resolve(base());
  assert.deepEqual(await pending, { ok: false, reason: "discarded" }); assert.equal(f.actions.size, minted);
  assert.notEqual((await f.host.items(info)).items[0].cardId, first.items[0].cardId);
});
test("H3 bubble: retainBotKeys + retainCards keeps the bot key and the bot item's cardId across a pending read", async () => {
  const { f, base, hold } = gated({ floatWindows: { readState: () => botState } }, { botId: "b1" });
  const first = await f.host.items(bubbleInfo);
  const gate = hold(), pending = f.host.items(bubbleInfo);
  f.host.invalidateWindow(bubbleInfo.windowId, { retainBotKeys: true, retainCards: true }); gate.resolve(base());
  assert.equal((await pending).reason, "superseded");
  const second = await f.host.items(bubbleInfo);
  assert.equal(second.bots[0].key, first.bots[0].key);
  assert.equal(second.bots[0].item.cardId, first.bots[0].item.cardId);
});
test("H3b bubble: retainBotKeys only keeps the key, the card id is new, and the read is superseded not discarded", async () => {
  const { f, base, hold } = gated({ floatWindows: { readState: () => botState } }, { botId: "b1" });
  const first = await f.host.items(bubbleInfo);
  const gate = hold(), pending = f.host.items(bubbleInfo);
  f.host.invalidateWindow(bubbleInfo.windowId, { retainBotKeys: true }); gate.resolve(base());
  assert.equal((await pending).reason, "superseded");
  const second = await f.host.items(bubbleInfo);
  assert.equal(second.bots[0].key, first.bots[0].key);
  assert.notEqual(second.bots[0].item.cardId, first.bots[0].item.cardId);
});
test("H4 rev strictly increases over commits and refused results carry none", async () => {
  const { f, base, hold } = gated();
  const a = await f.host.items(info), b = await f.host.items(info), c = await f.host.items(info);
  assert.ok(Number.isInteger(a.rev), "a commit carries an integer rev");
  assert.ok(b.rev > a.rev && c.rev > b.rev, `rev ${a.rev} ${b.rev} ${c.rev}`);
  const gate = hold(), pending = f.host.items(info); f.host.invalidateWindow(info.windowId, { retainCards: true }); gate.resolve(base());
  const refusedResult = await pending; assert.equal(refusedResult.ok, false); assert.equal("rev" in refusedResult, false);
});
test("H5 a retaining push still spends the old Open and action tokens", async () => {
  const { f } = gated(); const first = await f.host.items(info);
  f.host.invalidateWindow(info.windowId, { retainCards: true });
  assert.equal((await f.host.open(info, first.items[0].openToken)).ok, false);
  assert.equal((await f.host.act(info, first.items[0].actionToken, "allow")).ok, false);
  assert.equal(f.calls.length, 0);
});
for (const order of ["A then B", "B then A"]) test(`H6 (${order}) only the newest concurrent read commits; the older one mints nothing and identity carries over`, async () => {
  const { f, base, hold } = gated(); const committed = await f.host.items(info);
  const gateA = hold(), pendingA = f.host.items(info), gateB = hold(), pendingB = f.host.items(info);
  const mintedAtStart = f.actions.size;
  assert.equal((await f.host.open(info, committed.items[0].openToken)).ok, false);
  assert.equal((await f.host.act(info, committed.items[0].actionToken, "allow")).ok, false);
  if (order === "A then B") { gateA.resolve(base()); assert.deepEqual(await pendingA, { ok: false, reason: "superseded" }); assert.equal(f.actions.size, mintedAtStart); gateB.resolve(base()); }
  else { gateB.resolve(base()); await settle(); gateA.resolve(base()); assert.deepEqual(await pendingA, { ok: false, reason: "superseded" }); }
  const b = await pendingB; assert.equal(b.ok, true); assert.equal(b.items[0].cardId, committed.items[0].cardId);
  assert.equal(f.actions.size, 1);
});
for (const order of ["forward", "reverse"]) test(`H6e-${order === "forward" ? "fwd" : "rev"} superseded reads mint no Open tokens, completing ${order === "forward" ? "oldest" : "newest"} first (a flood of them cannot evict another window's token)`, async () => {
  const { f, base, hold } = gated(); const other = { kind: "flyout", windowId: 8 };
  const theirs = await f.host.items(other); const sizeAfterTheirs = f.actions.size;
  const gates = [], pendings = [], settled = [];
  for (let i = 0; i < 1100; i++) { gates.push(hold()); const index = i; pendings.push(f.host.items(info).then(r => { settled.push(index); return r; })); }
  if (order === "forward") for (const gate of gates) gate.resolve(base());
  else for (const gate of [...gates].reverse()) gate.resolve(base());
  const results = await Promise.all(pendings);
  if (order === "reverse") assert.equal(settled[0], 1099, `first settled index ${settled[0]}`);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results[1099].ok, true);
  assert.equal(f.actions.size, sizeAfterTheirs + 1, "only the committed read minted tokens");
  assert.equal((await f.host.open(other, theirs.openToken)).ok, true);
  assert.equal((await f.host.open(info, results[1099].items[0].openToken)).ok, true, "the committed window's own Open token works");
});
test("H6c a read pending across a discard cannot commit into the replacement record", async () => {
  const { f, base, hold } = gated(); const committed = await f.host.items(info);
  const gateA = hold(), pendingA = f.host.items(info); f.host.invalidateWindow(info.windowId);
  const gateB = hold(), pendingB = f.host.items(info);
  gateA.resolve(base()); assert.deepEqual(await pendingA, { ok: false, reason: "discarded" });
  gateB.resolve(base()); const b = await pendingB; assert.equal(b.ok, true); assert.equal(f.actions.size, 1);
  assert.notEqual(b.items[0].cardId, committed.items[0].cardId);
});
test("H6d the very first read of a window commits (its record is registered at the start)", async () => {
  const { f } = gated(); const first = await f.host.items(info);
  assert.equal(first.ok, true); assert.equal(f.actions.size, 1);
});
