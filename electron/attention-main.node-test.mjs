// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";
import { createAttentionMain as createCore, frameFromOffer, routerPrefsFrom, LEDGER_MAX } from "./attention-main.mjs";

// S3R shape adapter: old routing assertions use bound sessions and complete the
// show/present exchange; every displayed surface is now an injected main notice.
function createAttentionMain(deps) {
  const sessions = new Map(), notices = [];
  const owner = home => {
    if (!sessions.has(home)) sessions.set(home, { home, session: `session${sessions.size}`.padEnd(25, "x"), webContentsId: sessions.size + 1, alive: true, ledger: new Set() });
    return sessions.get(home);
  };
  const core = createCore({ ...deps,
    presence: deps.presenceDouble ?? { rev: 0, async refresh() { try { await deps.beforeDecision?.(); } catch { /* reader failure is not detected */ } return { ...deps.presence?.(), rev: 0 }; }, markConservative() {} },
    sendToSession(home, session, message) {
      if (message.type === "show") return deps.sendShow?.(home, message.ref);
      // Old close assertions describe withdrawal; commit payload closes are covered in D22.
      if (message.type === "close") {
        if ([...core.records.values()].some(r => r.session === session && r.ref === message.ref && r.state === "SHOWN")) return true;
        const result = deps.sendClose?.(home, message.ref); core.freed(owner(home), [message.ref]); return result;
      }
      return deps.sendPreviews?.(home, message.previews);
    },
    createNotice(options) { const notice = { options, show() {}, close() {}, on() {}, removeAllListeners() {} }; notices.push(notice); return notice; },
  });
  return { ...core, notices, owner, async offer(home, payload) {
    const s = owner(home), result = await core.offer(s, { ...payload, session: s.session });
    const record = [...core.records.values()].find(r => r.owner === s && r.ref === payload?.ref);
    if (record?.state === "SENT") await core.present(s, { session: s.session, ref: record.ref, gen: record.gen, title: "Title", body: "Body", privatePreview: false, silent: false });
    // Successful presents push a terminal close even when the invoke reply is lost.
    core.freed(s, result.retired ?? []);
    const { retired, ...routing } = result; return routing;
  } };
}

function rig({ origin = "upgrade", platform = "linux", cards = new Map(), previews = [true], presence = { locked: false }, withSummary = false, edit, beforeDecision, watchPresence, pinned = null, presenceDouble } = {}) {
  const state = notifySurfaceDefaults(origin, platform);
  if (edit) edit(state);
  const shows = [], counts = [], killed = [], logs = [], summaries = [], reads = [], timers = [], closes = [], previewMsgs = [], surfaceShows = [], surfaceCloses = [];
  let previewIndex = 0;
  const quiet = { ...presence };
  const main = createAttentionMain({
    prefs: () => state, presence: () => quiet, sendShow: (home, ref) => { shows.push([home, ref]); return true; },
    sendClose: (home, ref) => { closes.push([home, ref]); return true; }, sendPreviews: (home, value) => { previewMsgs.push([home, value]); return true; },
    transportFor: () => ({ readCard: async (entry) => { reads.push(entry); const open = cards.get(`${entry.threadId}|${entry.messageId}`); return { open: open !== false }; } }),
    invalidateTokens: entry => killed.push(entry.key), onPreviewsChanged: () => killed.push("previews"),
    readPreviews: async () => previews[Math.min(previewIndex++, previews.length - 1)], onCounts: s => counts.push(s),
    ...(withSummary ? { onSummary: info => summaries.push(info) } : {}),
    ...(beforeDecision ? { beforeDecision } : {}), ...(watchPresence ? { watchPresence } : {}), ...(presenceDouble ? { presenceDouble } : {}),
    pillAvailable: () => false, pinnedBotId: () => pinned, log: line => logs.push(line),
    showSurface: (rung, entry) => { surfaceShows.push([rung, entry.frame.ref ?? entry.frame.botId]); return [`float:${rung}`]; },
    closeSurface: (ids, entry) => { surfaceCloses.push([ids, entry.frame.botId]); },
    now: () => 1_000_000, setTimer: (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return handle; }, clearTimer: handle => { if (handle) handle.cleared = true; },
  });
  return { main, state, shows, counts, killed, logs, summaries, reads, quiet, timers, closes, previewMsgs, surfaceShows, surfaceCloses };
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

test("a focused window keeps new and upgrade approvals in app (D2, GH24)", async () => {
  const fresh = rig({ origin: "new" });
  assert.deepEqual(fresh.main.visible(fresh.main.owner("local"), { threadId: "t1", focused: true }), { ok: true, retired: [] });
  assert.equal((await fresh.main.offer("local", approval())).decision, "on-screen");
  assert.deepEqual(fresh.shows, []);
  const old = rig({ origin: "upgrade" });
  old.main.visible(old.main.owner("local"), { threadId: "t1", focused: true });
  assert.equal((await old.main.offer("local", approval())).decision, "counts");
  assert.equal(old.shows.length, 0);
  assert.deepEqual(old.main.visible(old.main.owner("local"), { threadId: 5, focused: true }), { ok: false });
  assert.deepEqual(old.main.visible(old.main.owner("local"), { threadId: null, focused: false }), { ok: true, retired: [] });
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
  // S3R repeats of one ref are idempotent; a distinct ref still dedupes the card.
  assert.equal((await r.main.offer("local", approval(1, { ref: "repeat" }))).decision, "duplicate");
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

test("a window that cannot be reached retains a bounded hand-off and logs it", async () => {
  const state = notifySurfaceDefaults("upgrade", "linux"), logs = [];
  const main = createAttentionMain({ prefs: () => state, sendShow: () => false, transportFor: () => null, pillAvailable: () => false, log: l => logs.push(l), now: () => 1, setTimer: () => ({}), clearTimer() {} });
  // S3R removes renderer fallback: a failed push retains the hand-off deadline.
  assert.deepEqual(await main.offer("local", approval()), { ok: true, decision: "notify" });
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

// S3R replaces nativeBanner with the native prepare/present/close contract.
test("a native preparation uses the card ids, registers its handle and closes at settle", async () => {
  const state = notifySurfaceDefaults("new", "darwin"); state.surfaces.pill = false;
  const calls = [], closed = [], shows = [];
  const native = Object.assign(() => {}, {
    async prepare(input, { onSlot }) { calls.push(input); onSlot({ cancel() {} }); return { ok: true, prepared: { words: { title: "Server", body: "Review" } } }; },
    present(prepared, { key }) { shows.push(prepared.words); return { accepted: true, handle: "n:" + key }; },
    close(key) { closed.push(key); }, setOnEvict() {},
  });
  const main = createCore({ prefs: () => state, presence: { rev: 0, refresh: async () => ({ rev: 0 }) }, nativeApprovals: native,
    sendToSession: () => true, transportFor: () => null, readPreviews: async () => true, now: () => 1, setTimer: () => ({}), clearTimer() {} });
  const s = { home: "local", session: "s".repeat(25), alive: true, webContentsId: 1, ledger: new Set() };
  await main.previewsCheck();
  assert.equal((await main.offer(s, { ...approval(1), session: s.session })).decision, "notify");
  assert.deepEqual(shows, [], "a show push is not presentation");
  const record = [...main.records.values()][0];
  await main.present(s, { session: s.session, ref: record.ref, gen: record.gen, title: "Renderer", body: "Review", privatePreview: false, silent: false });
  assert.equal(calls[0].requestId, "r1"); assert.equal(calls[0].messageId, "m1");
  assert.deepEqual(shows, [{ title: "Server", body: "Review" }]);
  main.settled("local", "t1", "r1"); assert.equal(closed.length, 1);
  assert.match(closed[0], /\\|ref1\\|/);
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

test("F1: freed ignores a list longer than the ledger bound, whole, and accepts one at the bound", async () => {
  const r = rig();
  await r.main.offer("local", approval(1));
  const s = r.main.owner("local");
  assert.ok(s.ledger.has("ref1"), "the shown card still holds its ledger slot");
  r.main.freed(s, ["ref1", ...Array.from({ length: LEDGER_MAX }, (_, i) => `pad${i}`)]);
  assert.ok(s.ledger.has("ref1"), "LEDGER_MAX + 1 refs from a compromised top frame free nothing");
  r.main.freed(s, ["ref1", ...Array.from({ length: LEDGER_MAX - 1 }, (_, i) => `pad${i}`)]);
  assert.ok(!s.ledger.has("ref1"), "a list of exactly LEDGER_MAX refs is honoured");
});

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test("F2: a card shown on the router path is nudged once on the next rung down (nudgeMinutes works)", async () => {
  const r = rig({ origin: "upgrade", pinned: "b1", edit: s => { s.surfaces.bubble = true; s.nudgeMinutes = 5; } });
  const nudgeTimers = () => r.timers.filter(t => t.ms === 5 * 60_000);
  assert.equal((await r.main.offer("local", approval(1))).decision, "notify");
  assert.equal(nudgeTimers().length, 1, "one nudge timer is armed when the card reaches SHOWN");
  assert.deepEqual(r.surfaceShows, [], "nothing escalates before the timer");
  nudgeTimers()[0].fn(); await flush();
  assert.deepEqual(r.surfaceShows, [["bubble", "ref1"]], "the nudge shows the next rung (bubble) for this card, once");
  assert.equal(nudgeTimers().length, 1, "no second nudge is armed");
  nudgeTimers()[0].fn(); await flush();
  assert.equal(r.surfaceShows.length, 1, "a spent nudge never repeats");
  r.main.watcherFrame({ kind: "attention.settled", threadId: "t1", requestId: "r1" });
  assert.deepEqual(r.surfaceCloses.length, 1, "settling closes the nudged surface");
});

test("F2: a settle clears the pending nudge; nudgeMinutes 0 arms nothing; a nudge due while quiet is spent", async () => {
  const r = rig({ origin: "upgrade", pinned: "b1", edit: s => { s.surfaces.bubble = true; s.nudgeMinutes = 5; } });
  await r.main.offer("local", approval(1));
  const timer = r.timers.find(t => t.ms === 5 * 60_000);
  r.main.watcherFrame({ kind: "attention.settled", threadId: "t1", requestId: "r1" });
  assert.equal(timer.cleared, true, "a settled card cancels its nudge");
  timer.fn(); await flush();
  assert.deepEqual(r.surfaceShows, [], "a nudge that fires after the settle shows nothing");
  const off = rig({ origin: "upgrade", pinned: "b1", edit: s => { s.surfaces.bubble = true; s.nudgeMinutes = 0; } });
  await off.main.offer("local", approval(1));
  assert.equal(off.timers.filter(t => t.ms === 0 || t.ms % 60_000 === 0).length, 0, "nudgeMinutes 0 arms no timer");
  const quiet = rig({ origin: "upgrade", pinned: "b1", edit: s => { s.surfaces.bubble = true; s.nudgeMinutes = 5; } });
  await quiet.main.offer("local", approval(1));
  quiet.quiet.locked = true;
  quiet.timers.find(t => t.ms === 5 * 60_000).fn(); await flush();
  assert.deepEqual(quiet.surfaceShows, [], "a nudge never breaks the quiet hold");
  quiet.quiet.locked = false;
  quiet.timers.find(t => t.ms === 5 * 60_000).fn(); await flush();
  assert.deepEqual(quiet.surfaceShows, [], "and the one nudge was spent by the quiet moment");
});

test("Astra r1 #6: a nudge read that new presence evidence overtakes is read again, and never escalates on the stale answer", async () => {
  let rev = 0, sharing = false, overtake = "none", conservative = 0;
  const presenceDouble = { get rev() { return rev; }, markConservative() { conservative += 1; },
    async refresh() {
      const snapshot = { locked: false, sharing, rev };
      if (overtake === "once") { overtake = "none"; rev += 1; sharing = true; } // sharing began while this read was in flight
      else if (overtake === "always") rev += 1;
      return snapshot;
    } };
  const edit = s => { s.surfaces.bubble = true; s.nudgeMinutes = 5; };
  const once = rig({ origin: "upgrade", pinned: "b1", edit, presenceDouble });
  await once.main.offer("local", approval(1));
  overtake = "once";
  once.timers.find(t => t.ms === 5 * 60_000).fn(); await flush();
  assert.deepEqual(once.surfaceShows, [], "the stale not-sharing answer is dropped; the fresh read says sharing, so nothing escalates");
  assert.equal(conservative, 0);
  rev = 0; sharing = false; overtake = "none";
  const always = rig({ origin: "upgrade", pinned: "b1", edit, presenceDouble });
  await always.main.offer("local", approval(1));
  overtake = "always";
  always.timers.find(t => t.ms === 5 * 60_000).fn(); await flush();
  assert.deepEqual(always.surfaceShows, [], "evidence that keeps moving never lets a nudge through");
  assert.equal(conservative, 1, "and presence is marked conservative once");
  always.timers.find(t => t.ms === 5 * 60_000).fn(); await flush();
  assert.deepEqual(always.surfaceShows, [], "the dropped nudge is spent");
});

test("a show push failure never requests renderer fallback", async () => {
  const state = notifySurfaceDefaults("upgrade", "linux"), logs = [];
  const main = createAttentionMain({ prefs: () => state, sendShow: () => false, transportFor: () => null, pillAvailable: () => false, log: l => logs.push(l), now: () => 1, setTimer: () => ({}), clearTimer() {} });
  // S3R keeps SENT until hand-off or expiry; a send result is never delivery.
  assert.deepEqual(await main.offer("local", approval(1)), { ok: true, decision: "notify" });
  const thrower = createAttentionMain({ prefs: () => state, sendShow: () => { throw new Error("destroyed"); }, transportFor: () => null, pillAvailable: () => false, now: () => 1, setTimer: () => ({}), clearTimer() {} });
  assert.deepEqual(await thrower.offer("local", approval(2)), { ok: true, decision: "notify" });
});
