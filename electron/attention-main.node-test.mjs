// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";
import { createAttentionMain, frameFromOffer, routerPrefsFrom } from "./attention-main.mjs";

function rig({ origin = "upgrade", platform = "linux", cards = new Map(), previews = [true], presence = { locked: false }, withSummary = false, edit, beforeDecision, watchPresence } = {}) {
  const state = notifySurfaceDefaults(origin, platform);
  if (edit) edit(state);
  const shows = [], counts = [], killed = [], logs = [], summaries = [], reads = [], timers = [], closes = [], previewMsgs = [];
  let previewIndex = 0;
  const quiet = { ...presence };
  const main = createAttentionMain({
    prefs: () => state, presence: () => quiet, sendShow: (home, ref) => { shows.push([home, ref]); return true; },
    sendClose: (home, ref) => { closes.push([home, ref]); return true; }, sendPreviews: (home, value) => { previewMsgs.push([home, value]); return true; },
    transportFor: () => ({ readCard: async (entry) => { reads.push(entry); const open = cards.get(`${entry.threadId}|${entry.messageId}`); return { open: open !== false }; } }),
    invalidateTokens: entry => killed.push(entry.key), onPreviewsChanged: () => killed.push("previews"),
    readPreviews: async () => previews[Math.min(previewIndex++, previews.length - 1)], onCounts: s => counts.push(s),
    ...(withSummary ? { onSummary: info => summaries.push(info) } : {}),
    ...(beforeDecision ? { beforeDecision } : {}), ...(watchPresence ? { watchPresence } : {}),
    pillAvailable: () => false, pinnedBotId: () => null, log: line => logs.push(line),
    now: () => 1_000_000, setTimer: (fn, ms) => { const handle = { fn, ms }; timers.push(handle); return handle; }, clearTimer: () => {},
  });
  return { main, state, shows, counts, killed, logs, summaries, reads, quiet, timers, closes, previewMsgs };
}
const approval = (n = 1, extra = {}) => ({ kind: "approval", botId: "b1", threadId: "t1", messageId: `m${n}`, requestId: `r${n}`, ref: `ref${n}`, ...extra });

test("an offer shows through the offering window by ref and carries no content", async () => {
  const r = rig();
  const result = await r.main.offer("local", { ...approval(), title: "Run rm -rf", body: "secret", subtitle: "also secret" });
  assert.deepEqual(result, { ok: true, decision: "notify" });
  assert.deepEqual(r.shows, [["local", "ref1"]]);
  assert.deepEqual(frameFromOffer({ ...approval(), title: "x", body: "y", subtitle: "z" }), { kind: "approval", botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1", ref: "ref1" });
});

test("bad payloads are refused and show nothing", async () => {
  const r = rig();
  for (const payload of [null, "x", {}, { kind: 5 }, { kind: "approval", threadId: 7 }, { kind: "approval", threadId: "x".repeat(300) }, { kind: "approval", ref: "r".repeat(65) }, { kind: "done", durationMs: -1 }, { kind: "x".repeat(65) }]) {
    assert.deepEqual(await r.main.offer("local", payload), { ok: false }, JSON.stringify(payload)?.slice(0, 60));
  }
  assert.deepEqual(await r.main.offer("", approval()), { ok: false }, "no home, no routing");
  assert.deepEqual(r.shows, []);
});

test("a window on screen suppresses a new install's approval, but an upgrade still gets its banner (D2)", async () => {
  const fresh = rig({ origin: "new" });
  assert.deepEqual(fresh.main.visible("local", { threadId: "t1", focused: true }), { ok: true });
  assert.equal((await fresh.main.offer("local", approval())).decision, "on-screen");
  assert.deepEqual(fresh.shows, []);
  const old = rig({ origin: "upgrade" });
  old.main.visible("local", { threadId: "t1", focused: true });
  assert.equal((await old.main.offer("local", approval())).decision, "notify");
  assert.equal(old.shows.length, 1);
  assert.deepEqual(old.main.visible("local", { threadId: 5, focused: true }), { ok: false });
  assert.deepEqual(old.main.visible("local", { threadId: null, focused: false }), { ok: true });
});

test("settled folds from the watcher and from a window, idempotently, and per home", async () => {
  const r = rig();
  await r.main.offer("local", approval(1));
  await r.main.offer("h-cloud", approval(1, { ref: "refc" }));
  assert.equal(r.main.router.size(), 2, "the same ids on two homes never collide");
  r.main.watcherFrame({ kind: "attention.settled", threadId: "t1", requestId: "r1" });
  assert.equal(r.main.router.size(), 1, "only the local home's card settled");
  r.main.watcherFrame({ kind: "attention.settled", threadId: "t1", requestId: "r1" });
  assert.equal(r.main.router.size(), 1, "repeated settle is a no-op");
  assert.deepEqual(await r.main.offer("h-cloud", { kind: "attention.settled", threadId: "t1", requestId: "r1" }), { ok: true, decision: "settled" });
  assert.equal(r.main.router.size(), 0);
  assert.deepEqual(await r.main.offer("h-cloud", { kind: "attention.settled", threadId: "t1", requestId: "r1" }), { ok: true, decision: "unknown" });
  r.main.watcherFrame({ kind: "bot", botId: "b1" });
  r.main.watcherFrame(null);
});

test("a previews change closes and invalidates once; the first read is only the baseline", async () => {
  const r = rig({ previews: [true, true, false, false, true] });
  await r.main.offer("local", approval());
  assert.equal(await r.main.previewsCheck(), false, "baseline");
  assert.equal(await r.main.previewsCheck(), false, "unchanged");
  assert.equal(await r.main.previewsCheck(), true, "true -> false");
  assert.ok(r.killed.includes("previews") && r.killed.length >= 2, "tokens of tracked cards and the global invalidation");
  assert.equal(await r.main.previewsCheck(), false, "still false");
  assert.equal(await r.main.previewsCheck(), true, "false -> true");
  const unknown = rig({ previews: [undefined] });
  assert.equal(await unknown.main.previewsCheck(), false, "an unreadable value is not a change");
});

test("a config frame from the watcher runs the previews check", async () => {
  const r = rig({ previews: [true, false] });
  r.main.watcherFrame({ kind: "config" });
  await new Promise(resolve => setImmediate(resolve));
  r.main.watcherFrame({ kind: "config" });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(r.killed.includes("previews"));
});

test("a new server run folds the local home and the same card is not a duplicate under the new epoch", async () => {
  const r = rig();
  await r.main.offer("local", approval());
  assert.equal((await r.main.offer("local", approval())).decision, "duplicate");
  r.main.serverChanged();
  assert.equal(r.main.router.size(), 0);
  assert.equal((await r.main.offer("local", approval())).decision, "notify");
  r.main.homeGone("h-cloud");
});

test("reconcile re-checks each card one at a time, folds the settled one and runs one at a time", async () => {
  const cards = new Map([["t1|m2", false]]);
  const r = rig({ cards });
  for (const n of [1, 2, 3]) await r.main.offer("local", approval(n));
  assert.equal(r.main.router.size(), 3);
  const first = r.main.reconcile(), second = r.main.reconcile();
  await Promise.all([first, second]);
  assert.equal(r.main.router.size(), 2, "the settled card folded");
  assert.ok(r.reads.every(entry => entry.threadId === "t1" && entry.messageId), "read through the transport by thread and message");
  assert.ok(r.reads.length >= 5 && r.reads.length <= 6, `one run plus at most one trailing run, got ${r.reads.length}`);
});

test("a card whose transport is gone counts as still open (never silently dropped)", async () => {
  const r = rig();
  const dead = createAttentionMain({ prefs: () => r.state, sendShow: () => true, transportFor: () => null, pillAvailable: () => false, now: () => 1, setTimer: () => ({}), clearTimer() {} });
  await dead.offer("local", approval());
  await dead.reconcile();
  assert.equal(dead.router.size(), 1);
});

test("while the screen is locked events are held; the release shows the newest once (no summary surface yet)", async () => {
  const r = rig({ origin: "new", platform: "darwin", presence: { locked: true } });
  r.state.surfaces.pill = false;
  assert.equal((await r.main.offer("local", approval(1))).decision, "held");
  assert.equal((await r.main.offer("local", approval(2))).decision, "held");
  assert.deepEqual(r.shows, []);
  await r.main.quietChanged();
  assert.deepEqual(r.shows, [], "still locked: nothing yet");
  r.quiet.locked = false;
  await r.main.quietChanged();
  assert.deepEqual(r.shows, [["local", "ref2"]], "one banner for the newest held card, the rest stay in the counts");
  assert.equal(r.main.router.size(), 2);
});

test("with a summary surface a release of several events is one summary and never a burst", async () => {
  const r = rig({ origin: "new", platform: "darwin", presence: { locked: true }, withSummary: true });
  await r.main.offer("local", approval(1));
  await r.main.offer("local", approval(2));
  r.quiet.locked = false;
  await r.main.quietChanged();
  assert.deepEqual(r.shows, []);
  assert.equal(r.summaries.length, 1);
  assert.equal(r.summaries[0].total, 2);
});

test("receipts route to the notification rung by delivery id, once", async () => {
  const r = rig({ edit: s => { s.surfaces.receipt = true; } });
  assert.equal((await r.main.offer("local", { kind: "done", botId: "b1", threadId: "t1", deliveryId: "d1", durationMs: 5, ref: "refd" })).decision, "receipt-notify");
  assert.equal((await r.main.offer("local", { kind: "done", botId: "b1", threadId: "t1", deliveryId: "d1", durationMs: 5, ref: "refd2" })).decision, "duplicate");
  assert.deepEqual(r.shows, [["local", "refd"]]);
});

test("an unreadable device file falls back to today's banners; prefs mapping is exact", async () => {
  assert.equal(routerPrefsFrom(null).origin, "upgrade");
  assert.equal(routerPrefsFrom({ origin: "weird", surfaces: {} }).notify, true);
  const state = notifySurfaceDefaults("new", "darwin");
  const mapped = routerPrefsFrom(state);
  assert.equal(mapped.origin, "new");
  assert.equal(mapped.pill, true);
  assert.equal(mapped.quietSummary, true);
  assert.equal(mapped.nudgeMinutes, 5);
  const broken = createAttentionMain({ prefs: () => { throw new Error("disk"); }, sendShow: () => true, transportFor: () => null, pillAvailable: () => false, now: () => 1, setTimer: () => ({}), clearTimer() {} });
  assert.equal((await broken.offer("local", approval())).decision, "notify");
});

test("a window that cannot be reached shows nothing and logs it", async () => {
  const state = notifySurfaceDefaults("upgrade", "linux"), logs = [];
  const main = createAttentionMain({ prefs: () => state, sendShow: () => false, transportFor: () => null, pillAvailable: () => false, log: l => logs.push(l), now: () => 1, setTimer: () => ({}), clearTimer() {} });
  assert.deepEqual(await main.offer("local", approval()), { ok: false, decision: "undelivered" }, "reported, so the window shows it itself");
  assert.ok(logs.some(line => line.includes("not delivered")));
});

test("a fresh presence read is awaited before each decision, so a share that just began holds the event", async () => {
  const order = [];
  const r = rig({ presence: { sharing: false }, beforeDecision: async () => { order.push("read"); r.quiet.sharing = true; } });
  const result = await r.main.offer("local", approval());
  assert.equal(result.decision, "held");
  assert.deepEqual(r.shows, []);
  assert.deepEqual(order, ["read"]);
  const failing = rig({ beforeDecision: async () => { throw new Error("read failed"); } });
  assert.equal((await failing.main.offer("local", approval())).decision, "notify", "a failed read never loses a notification");
});

test("the presence poll runs only while something is held and stops on release or settle", async () => {
  const events = [];
  const r = rig({ origin: "new", platform: "linux", presence: { sharing: true }, watchPresence: () => { events.push("watch"); return () => events.push("stop"); } });
  r.state.surfaces.notify = true;
  await r.main.offer("local", approval(1));
  await r.main.offer("local", approval(2));
  assert.deepEqual(events, ["watch"], "one poll for any number of held events");
  r.main.settled("local", "t1", "r1");
  assert.deepEqual(events, ["watch"], "one still held");
  r.main.settled("local", "t1", "r2");
  assert.deepEqual(events, ["watch", "stop"]);
  const idle = rig({ watchPresence: () => { events.push("idle-watch"); return () => {}; } });
  await idle.main.offer("local", approval(3));
  assert.ok(!events.includes("idle-watch"), "nothing held, nothing polled");
  await r.main.quietChanged();
  r.quiet.sharing = true;
  await r.main.offer("local", approval(4));
  r.quiet.sharing = false;
  await r.main.quietChanged();
  assert.equal(events.at(-1), "stop", "a release stops the poll");
});

test("a native banner surface takes the card first; when it shows nothing the window shows it; settle withdraws the banner", async () => {
  const state = notifySurfaceDefaults("new", "darwin");
  state.surfaces.pill = false;
  const calls = [], closed = [], shows = [];
  let result = ["mb:1"];
  const banner = { available: () => true, show: async spec => { calls.push(spec); return result; }, close: ids => closed.push(ids) };
  const record = { display: { botName: "Ada", title: "T", willRun: "x" }, outsideOk: { "banner-mac": true }, digest: "d".repeat(64), open: true };
  const main = createAttentionMain({ prefs: () => state, sendShow: (home, ref) => { shows.push(ref); return true; }, nativeBanner: banner, pillAvailable: () => false,
    transportFor: () => ({ readCard: async () => record }), now: () => 1, setTimer: () => ({}), clearTimer() {} });
  assert.equal((await main.offer("local", approval(1))).decision, "notify");
  assert.deepEqual(shows, [], "the native banner took it");
  assert.equal(calls[0].actionsOn, true, "a new install answers from the banner");
  assert.deepEqual(calls[0].plain, { title: "Murage", body: "Your attention is needed." });
  assert.equal(calls[0].record.digest, "d".repeat(64));
  main.settled("local", "t1", "r1");
  assert.deepEqual(closed, [["mb:1"]]);
  result = null;
  await main.offer("local", approval(2));
  assert.deepEqual(shows, ["ref2"], "nothing shown natively: the window shows it as today");
  state.notifyActions = false;
  result = ["mb:3"];
  await main.offer("local", approval(3));
  assert.equal(calls.at(-1).actionsOn, false, "an upgrade keeps buttons off");
  const throwing = createAttentionMain({ prefs: () => state, sendShow: (h, ref) => { shows.push(ref); return true; }, nativeBanner: { available: () => true, show: async () => { throw new Error("addon"); }, close() {} }, pillAvailable: () => false,
    transportFor: () => null, now: () => 1, setTimer: () => ({}), clearTimer() {} });
  await throwing.offer("local", approval(4));
  assert.equal(shows.at(-1), "ref4", "a native failure falls back, never loses the notification");
  const away = createAttentionMain({ prefs: () => state, sendShow: (h, ref) => { shows.push(ref); return true; }, nativeBanner: { available: () => false, show: async () => { throw new Error("must not run"); }, close() {} }, pillAvailable: () => false,
    transportFor: () => null, now: () => 1, setTimer: () => ({}), clearTimer() {} });
  await away.offer("local", approval(5));
  assert.equal(shows.at(-1), "ref5");
});

// ---- Astra round 1 (S3) ----
test("a settle shown through a window sends that window a close for the same ref; a held one is cancelled", async () => {
  const r = rig({ origin: "new", platform: "linux" });
  await r.main.offer("local", approval(1));
  r.main.settled("local", "t1", "r1");
  assert.deepEqual(r.closes, [["local", "ref1"]]);
  r.quiet.locked = true;
  await r.main.offer("local", approval(2));
  r.main.settled("local", "t1", "r2");
  assert.deepEqual(r.closes.at(-1), ["local", "ref2"], "a held event's window drops its waiting display");
});

test("a first read of previews OFF is treated as a change; a first read of ON is only the baseline", async () => {
  const off = rig({ previews: [false] });
  await off.main.offer("local", approval(1));
  assert.equal(await off.main.previewsCheck("local"), true);
  assert.deepEqual(off.previewMsgs, [["local", false]]);
  assert.ok(off.killed.includes("previews"));
  assert.deepEqual(off.closes, [["local", "ref1"]], "the shown surface was closed");
  const on = rig({ previews: [true] });
  assert.equal(await on.main.previewsCheck("local"), false);
  assert.deepEqual(on.previewMsgs, []);
});

test("previews are tracked per home: a Cloud change leaves the local surfaces alone, and the signal reaches only that window", async () => {
  const values = { local: true, "h-cloud": true };
  const state = notifySurfaceDefaults("upgrade", "linux"), msgs = [], closes = [];
  const main = createAttentionMain({ prefs: () => state, sendShow: () => true, sendClose: (h, ref) => closes.push([h, ref]), sendPreviews: (h, v) => msgs.push([h, v]), readPreviews: async home => values[home],
    transportFor: () => null, pillAvailable: () => false, now: () => 1, setTimer: () => ({}), clearTimer() {} });
  await main.offer("local", approval(1, { ref: "refL" }));
  await main.offer("h-cloud", approval(1, { ref: "refC" }));
  await main.previewsCheck("local"); await main.previewsCheck("h-cloud");
  values["h-cloud"] = false;
  assert.equal(await main.offer("h-cloud", { kind: "attention.config" }).then(r => r.decision), "config");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(msgs, [["h-cloud", false]]);
  assert.deepEqual(closes, [["h-cloud", "refC"]], "the local card was not touched");
});

test("a settle that lands while the presence read is still pending cancels the offer: the settled card is never shown", async () => {
  let release;
  const r = rig({ beforeDecision: () => new Promise(resolve => { release = resolve; }) });
  const pending = r.main.offer("local", approval(1));
  r.main.watcherFrame({ kind: "attention.settled", threadId: "t1", requestId: "r1" });
  release();
  assert.deepEqual(await pending, { ok: true, decision: "settled" });
  assert.deepEqual(r.shows, []);
  assert.equal(r.main.router.size(), 0);
});

test("a new server run while the presence read is pending makes the offer stale (it never enters the new epoch)", async () => {
  let release;
  const r = rig({ beforeDecision: () => new Promise(resolve => { release = resolve; }) });
  const pending = r.main.offer("local", approval(1));
  r.main.serverChanged();
  release();
  assert.deepEqual(await pending, { ok: true, decision: "stale" });
  assert.deepEqual(r.shows, []);
  assert.equal(r.main.router.size(), 0);
});

test("a show that cannot be delivered to the window is reported, so the window shows it itself", async () => {
  const state = notifySurfaceDefaults("upgrade", "linux"), logs = [];
  const main = createAttentionMain({ prefs: () => state, sendShow: () => false, transportFor: () => null, pillAvailable: () => false, log: l => logs.push(l), now: () => 1, setTimer: () => ({}), clearTimer() {} });
  assert.deepEqual(await main.offer("local", approval(1)), { ok: false, decision: "undelivered" });
  const thrower = createAttentionMain({ prefs: () => state, sendShow: () => { throw new Error("destroyed"); }, transportFor: () => null, pillAvailable: () => false, now: () => 1, setTimer: () => ({}), clearTimer() {} });
  assert.deepEqual(await thrower.offer("local", approval(2)), { ok: false, decision: "undelivered" });
});
