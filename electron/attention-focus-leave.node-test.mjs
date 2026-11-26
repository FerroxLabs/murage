// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// N3 (1.0.21, GitHub #33/#30): an Ask approval card stayed silent for 1 h 44 min. Real main + real router: a card that arrives while a
// Murage window has focus is kept in the app (D2/GH24: decision "counts", no banner). When the owner then leaves Murage with the card
// still open, nothing ever offers it again: no banner on blur, no nudge (rung "counts" is never armed), so with no phone paired the
// card waits in silence until the owner happens to come back. These witnesses assert the owner is told ONCE after leaving Murage.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createCloudTransport, createLocalTransport } from "./attention-transport.mjs";
import { createPresenceGuard } from "./presence-guard.mjs";
import { wirePresence } from "./presence-wiring.mjs";
import { watchInboxChanges } from "./inbox-watch.mjs";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";
import { createAttentionMain } from "./attention-main.mjs";

function rig({ origin = "upgrade", platform = "darwin", focused = true, nativeApprovals } = {}) {
  const state = notifySurfaceDefaults(origin, platform);
  const cards = new Map(), cloudCards = new Map(), shows = [], timers = [], handoffs = [], opened = [], reads = [];
  const controls = { trusted: true, localReady: true, cloudOpen: false, cloudGen: 1, notifyFailures: 0, preview: true, previewReads: 0 };
  let clock = 1_000_000, sensorChange, main;
  const quiet = { locked: false, sharing: false };
  const setTimer = (fn, ms) => {
    const handle = { fn, at: clock + ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  const clearTimer = handle => { if (handle) handle.cleared = true; };
  const lock = { state: () => quiet.locked ? "locked" : "unlocked", onChange: () => () => {} };
  const presence = createPresenceGuard({
    platform: "darwin", lock,
    addon: {
      read: () => controls.sensor?.() ?? quiet,
      onChange(fn) { sensorChange = fn; return () => { sensorChange = undefined; }; },
    },
    setTimer: (fn, ms) => {
      const repeat = setTimer(fn, ms);
      repeat.interval = ms;
      return repeat;
    },
    clearTimer,
  });
  async function fetchFor(home, input) {
    const path = new URL(input, "http://fixture.invalid");
    const table = home === "local" ? cards : cloudCards;
    const recovering = path.searchParams.get("recover") === "1";
    const isCard = path.pathname.endsWith("/card");
    const id = path.searchParams.get("messageId");
    if (recovering) reads.push({ home, id, at: clock });
    const card = table.get(id);
    const respond = () => isCard
      ? card && !card.closed ? Response.json({ ...card, epoch: "run", notifyOk: true, quietStartsInMs: null, ...(card.read ?? {}) })
        : Response.json({}, { status: 404 })
      : Response.json({ mode: "recover", epoch: "run", items: [...table.values()].filter(card => !card.hidden), more: false });
    return (recovering ? controls.response?.({ home, id, card, respond }) : undefined) ?? respond();
  }
  const local = createLocalTransport({ origin: "http://fixture.invalid", secret: "", identity: () => controls.localReady ? "fixture" : "gone",
    fetchImpl: url => fetchFor("local", url) });
  const cloud = createCloudTransport({ homeId: "cloud", windowId: () => controls.cloudOpen ? 2 : -1,
    client: { sessionGeneration: () => controls.cloudGen, fetch(home, path, { beforeSend }) { beforeSend(); return fetchFor(home, path); } } });
  main = createAttentionMain({
    prefs: () => controls.prefs?.() ?? state, prefsTrusted: () => controls.trusted, isAppFocused: () => focused,
    shuttingDown: () => controls.shuttingDown === true, presence, nativeApprovals,
    sendToSession: (home, _session, message) => { if (message.type === "show") handoffs.push({ home, ...message }); return true; },
    createNotice(input) {
      const notice = new EventEmitter();
      return Object.assign(notice, { input, at: clock, show() {
        shows.push(notice);
        if (controls.throwOnShow) throw new Error("OS refused");
        if (controls.notifyFailures > 0) { controls.notifyFailures--; notice.emit("failed"); }
      }, close() { this.closed = true; } });
    },
    onOpen: target => opened.push(target), openRecovered: target => opened.push(target),
    transportFor: home => home === "local" ? controls.localReady && local || null : controls.cloudOpen && cloud || null,
    homeExpected: home => home === "local" || controls.cloudOpen,
    homes: () => controls.cloudOpen ? ["local", "cloud"] : ["local"],
    readPreviews: async () => { controls.previewReads++; return controls.preview; },
    pillAvailable: () => false, pinnedBotId: () => null, log: () => {},
    now: () => clock, setTimer, clearTimer,
  });
  wirePresence({ lock, presenceGuard: presence, attentionMain: main, powerMonitor: new EventEmitter() });
  const session = home => ({ home, session: home.padEnd(25, "x"), webContentsId: home === "local" ? 1 : 2, alive: true, ledger: new Set() });
  const s = session("local"), c = session("cloud");
  const turn = () => new Promise(resolve => setImmediate(resolve));
  const tick = async ms => {
    await turn();
    const until = clock + ms;
    for (;;) {
      const due = timers.filter(h => !h.cleared && h.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      if (due.interval) due.at += due.interval;
      else due.cleared = true;
      void due.fn(); await turn();
    }
    clock = until;
    await turn();
  };
  const focus = (value, { report = true, signal = true } = {}) => {
    focused = value;
    if (report) main.visible(s, { threadId: "t2", focused: value });
    if (signal) main.focusChanged?.();
  };
  const offer = async (card = approval, owner = s) => main.offer(owner, { ...card, session: owner.session });
  const present = async (words = {}) => {
    for (const { ref, gen, home } of handoffs.splice(0)) {
      const owner = home === "cloud" ? c : s;
      assert.equal((await main.present(owner, { session: owner.session, ref, gen, title: "Review", body: "Please review", silent: true, privatePreview: false, ...words })).ok, true);
    }
  };
  const insert = (card = approval, extra = {}, home = "local") => (home === "cloud" ? cloudCards : cards).set(card.messageId, { ...card, at: clock, ...extra });
  return { main, s, c, shows, tick, cards, cloudCards, quiet, focus, offer, present, insert, opened, timers, state, controls, presence, reads, setTimer, clearTimer,
    signalSensor: () => sensorChange?.(), turn, now: () => clock,
    control: (kind, fields = {}, owner = s) => main.offer(owner, { kind, ...fields, session: owner.session }),
    leave: async () => { focus(true); focus(false); await tick(1500); },
  };
}
const approval = { kind: "approval", botId: "b1", threadId: "t1", messageId: "m1", requestId: "r1", ref: "ref1" };
const ONE_H_44 = 104 * 60_000;

for (const [origin, platform] of [["upgrade", "darwin"], ["upgrade", "win32"], ["new", "win32"]]) {
  test(`R0 ${origin} ${platform}: a card kept while focused reaches the OS once after leaving`, async () => {
    const r = rig({ origin, platform });
    r.focus(true);
    r.insert();
    const kept = await r.offer();
    assert.equal(kept.decision, "counts", "precondition (D2/GH24): a focused Murage keeps the card in the app");
    assert.equal(r.shows.length, 0);
    r.focus(false);
    await r.tick(1499);
    assert.equal(r.shows.length, 0);
    await r.tick(1);
    assert.equal(r.shows.length, 1, "an open approval must reach the owner once after they leave Murage");
    r.shows[0].emit("click");
    assert.deepEqual(r.opened.map(({ threadId, messageId }) => [threadId, messageId]), [["t1", "m1"]]);
    await r.tick(ONE_H_44);
    assert.equal(r.shows.length, 1);
  });
}

test("R0 control: a card answered before the owner leaves Murage is never offered", async () => {
  const r = rig();
  r.focus(true);
  r.insert();
  assert.equal((await r.offer()).decision, "counts");
  r.cards.delete("m1");
  r.main.settled("local", "t1", "r1");
  r.focus(false);
  await r.tick(ONE_H_44);
  assert.equal(r.shows.length, 0);
});

test("R0 control: changing Murage windows is not leaving", async () => {
  const r = rig();
  r.focus(true);
  r.insert();
  assert.equal((await r.offer()).decision, "counts");
  r.main.visible(r.s, { threadId: "t1", focused: true });
  await r.tick(ONE_H_44);
  assert.equal(r.shows.length, 0);
});

test("R0 sensitivity: an unfocused live card posts now and does not repeat on a later leave", async () => {
  const r = rig({ focused: false });
  r.insert();
  assert.equal((await r.offer()).decision, "notify");
  await r.present();
  assert.equal(r.shows.length, 1);
  await r.tick(ONE_H_44);
  r.focus(true);
  r.focus(false);
  await r.tick(1500);
  assert.equal(r.shows.length, 1);
});

test("R1: brief blurs do not show a banner, then a settled leave shows one", async () => {
  const r = rig();
  r.insert();
  for (const duration of [10, 1000]) {
    r.focus(false);
    await r.tick(duration);
    r.focus(true);
    await r.tick(2000);
    assert.equal(r.shows.length, 0);
  }
  r.focus(false);
  await r.tick(1500);
  assert.equal(r.shows.length, 1);
});

const other = n => ({ kind: "question", ref: `ref${n}`, botId: `b${n}`, threadId: `t${n}`, messageId: `m${n}`, requestId: `r${n}` });
const later = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
const picked = r => {
  r.shows.at(-1)?.emit("click");
  return r.opened.at(-1)?.messageId;
};
const unknown = () => Response.json({}, { status: 503 });

test("R2: Electron tray focus prevents a recovery post until the tray hides", async () => {
  const r = rig();
  r.insert();
  await r.tick(8000);
  assert.equal(r.shows.length, 0);
  r.focus(false, { report: false });
  await r.tick(2000);
  assert.equal(r.shows.length, 1);
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(source, /app\.on\("browser-window-blur",attentionMain\.focusChanged\)/);
  assert.match(source, /app\.on\("browser-window-focus",attentionMain\.focusChanged\)/);
});

test("R3: missed blur is observed by the poll and stale thread focus clears", async () => {
  const r = rig();
  r.insert();
  r.focus(true);
  assert.equal((await r.offer()).decision, "counts");
  r.focus(false, { signal: false, report: false });
  await r.tick(31_499);
  assert.equal(r.shows.length, 0);
  await r.tick(1);
  assert.equal(r.shows.length, 1);
  assert.equal((await r.offer({ ...other(2), threadId: "t2" })).decision, "notify");
  await r.present();
  assert.equal(r.shows.length, 2);
  const idle = rig({ focused: false });
  await idle.tick(1500);
  idle.focus(true);
  assert.equal(idle.timers.filter(timer => !timer.cleared).length, 0);
});

test("R4: each leave recovers only the newest still unnoticed card", async () => {
  const r = rig();
  for (let i = 1; i <= 3; i++) r.insert(other(i), { at: i });
  await r.leave();
  assert.equal(r.shows.length, 1);
  assert.equal(picked(r), "m3");
  await r.leave();
  assert.equal(r.shows.length, 2);
  assert.equal(picked(r), "m2");
  assert.equal(r.shows[0].closed, true);
});

test("R4: a live card that posts during the recovery read spends the leave", async () => {
  const r = rig();
  const gate = later();
  r.controls.response = ({ id, respond }) => id ? gate.promise.then(respond) : undefined;
  r.insert();
  await r.leave();
  assert.equal(r.reads.at(-1)?.id, "m1");
  assert.equal((await r.offer(other(2))).decision, "notify");
  await r.present();
  gate.release();
  await r.tick(0);
  assert.equal(r.shows.length, 1);
  assert.equal(picked(r), "m2");
});

test("R4: a live card awaiting present and a card already recovered each post once", async () => {
  const waiting = rig({ focused: false });
  waiting.insert();
  assert.equal((await waiting.offer()).decision, "notify");
  await waiting.tick(1500);
  assert.equal(waiting.shows.length, 0);
  await waiting.present();
  assert.equal(waiting.shows.length, 1);
  const recovered = rig();
  recovered.insert();
  await recovered.leave();
  assert.equal(recovered.shows.length, 1);
  assert.equal((await recovered.offer()).decision, "notify");
  await recovered.present();
  assert.equal(recovered.shows.length, 1);
});

test("R4: a short-leave live post does not spend the following settled leave", async () => {
  const r = rig();
  r.insert();
  r.focus(false);
  await r.tick(500);
  assert.equal((await r.offer(other(2))).decision, "notify");
  await r.present();
  await r.tick(500);
  r.focus(true);
  await r.tick(1);
  await r.leave();
  assert.equal(r.shows.length, 2);
  assert.equal(picked(r), "m1");
});

test("R5: startup and restart watermarks cover the batch, with one credit for each stream generation", async () => {
  const r = rig({ focused: false });
  for (let i = 1; i <= 5; i++) r.insert(other(i), { at: i });
  await r.tick(1500);
  assert.equal(r.shows.length, 1);
  assert.equal(picked(r), "m5");
  await r.tick(60_000);
  for (let i = 0; i < 3; i++) r.main.serverChanged();
  for (let i = 0; i < 2; i++) r.main.homeGone("cloud");
  await r.tick(0);
  assert.equal(r.shows.length, 1);
  r.insert(other(6));
  await r.control("attention.resync", { gen: 1 });
  await r.tick(0);
  assert.equal(r.shows.length, 2);
  assert.equal(picked(r), "m6");
  await r.tick(10_000);
  r.insert(other(7));
  await r.tick(35_000);
  await r.control("attention.resync", { gen: 1 });
  await r.tick(0);
  assert.equal(r.shows.length, 2);
  await r.control("attention.resync", { gen: 2 });
  await r.tick(0);
  assert.equal(r.shows.length, 3);
  assert.equal(picked(r), "m7");
  for (let i = 1; i <= 4; i++) r.cards.delete(`m${i}`);
  await r.leave();
  assert.equal(r.shows.length, 3);
});

function tray(r) {
  let stream, connectCount = 0;
  const disconnect = watchInboxChanges(change => {
    if (change.connected === true) { connectCount++; r.main.trayConnected?.(); }
  }, {
    ready: () => true, url: () => "http://fixture.invalid/events", headers: () => ({}),
    setTimeout: r.setTimer, clearTimeout: r.clearTimer, onFrame: r.main.watcherFrame,
    fetch: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) { stream = controller; signal.addEventListener("abort", () => { try { controller.close(); } catch {} }); },
    })),
  });
  return { disconnect, drop: () => stream.close(), count: () => connectCount,
    send: frame => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)) };
}

test("R5: a tray-only stream reconnect recovers a card raised in the gap", async () => {
  const r = rig({ focused: false }), watch = tray(r);
  try {
    await r.tick(1500);
    assert.equal(r.shows.length, 0);
    assert.equal(watch.count(), 1);
    watch.drop();
    r.insert();
    await r.tick(4999);
    assert.equal(r.shows.length, 0);
    await r.tick(1);
    assert.equal(r.shows.length, 1);
    assert.equal(watch.count(), 2);
    r.insert(other(2));
    watch.send({ kind: "config" });
    await r.tick(0);
    assert.equal(r.shows.length, 1);
    assert.equal(watch.count(), 2);
  } finally { watch.disconnect(); }
});

test("R6: a 503 or an unresolved list retries after its bounded wait", async () => {
  for (const hangs of [false, true]) {
    const r = rig();
    r.insert();
    let first = true;
    r.controls.response = ({ id }) => {
      if (id || !first) return;
      first = false;
      return hangs ? new Promise(() => {}) : unknown();
    };
    await r.leave();
    assert.equal(r.shows.length, 0);
    await r.tick((hangs ? 3000 : 0) + 4999);
    assert.equal(r.shows.length, 0);
    await r.tick(1);
    assert.equal(r.shows.length, 1);
  }
});

test("R6: three newer unknown or closed cards cannot strand the fourth open card", async () => {
  for (const hangs of [false, true]) {
    const r = rig();
    r.controls.cloudOpen = true;
    r.insert(approval, { at: 1 });
    for (let i = 2; i <= 4; i++) r.insert(other(i), { at: i, closed: !hangs }, "cloud");
    if (hangs) r.controls.response = ({ home, id }) => home === "cloud" && id ? new Promise(() => {}) : undefined;
    await r.leave();
    await r.tick(hangs ? 6000 : 0);
    assert.equal(r.shows.length, 1);
    assert.equal(picked(r), "m1");
  }
});

test("R6: a failed exact read never serves as liveness and focusing cancels its retry", async () => {
  const r = rig();
  r.insert(approval, { closed: true });
  r.controls.response = ({ id }) => { if (id) throw new Error("read unavailable"); };
  await r.leave();
  assert.equal(r.shows.length, 0);
  assert.ok(r.timers.some(timer => !timer.cleared && timer.at === r.now() + 5000));
  r.focus(true);
  assert.ok(!r.timers.some(timer => !timer.cleared && timer.at === r.now() + 5000));
  r.controls.response = undefined;
  r.insert(approval);
  await r.leave();
  assert.equal(r.shows.length, 1);
});

test("R6: an expected missing transport retries, and a closed Cloud home does not", async () => {
  const r = rig({ focused: false });
  await r.tick(1500);
  r.insert();
  r.controls.localReady = false;
  r.main.serverChanged();
  await r.tick(0);
  assert.equal(r.shows.length, 0);
  r.controls.localReady = true;
  await r.tick(5000);
  assert.equal(r.shows.length, 1);
  r.main.homeGone("cloud");
  await r.tick(0);
  assert.equal(r.timers.filter(timer => !timer.cleared).length, 0);
});

test("R6: an unsnoozed card gets another exact read after a new leave earn", async () => {
  const r = rig();
  r.insert(approval, { read: { notifyOk: false } });
  r.controls.cloudOpen = true;
  r.controls.response = ({ home }) => home === "cloud" ? unknown() : undefined;
  await r.leave();
  assert.equal(r.shows.length, 0);
  r.cards.get("m1").read.notifyOk = true;
  await r.leave();
  assert.equal(r.shows.length, 1);
});

test("R8: quiet-hours exclusion holds all night and permits the next leave", async () => {
  const r = rig();
  r.insert(approval, { hidden: true });
  await r.leave();
  await r.tick(9 * 60 * 60_000);
  assert.equal(r.shows.length, 0);
  r.cards.get("m1").hidden = false;
  await r.leave();
  assert.equal(r.shows.length, 1);
});

test("R8: a quiet card or a malformed deadline is refused during the exact read", async () => {
  for (const read of [{ notifyOk: false, quietStartsInMs: 0 }, { notifyOk: false, quietStartsInMs: null }, { quietStartsInMs: undefined }]) {
    const r = rig();
    r.insert(approval, { read });
    await r.leave();
    assert.equal(r.shows.length, 0);
    r.cards.get("m1").read = undefined;
    await r.leave();
    assert.equal(r.shows.length, 1);
  }
});

test("R8: the quiet boundary refuses one home and still permits the older home", async () => {
  for (const fallback of [false, true]) {
    const r = rig();
    const presence = later();
    r.controls.cloudOpen = true;
    if (fallback) r.insert(approval, { at: 1 });
    r.insert(other(2), { at: 2, read: { quietStartsInMs: 500 } }, "cloud");
    r.controls.sensor = () => r.presence.reads === 2 ? presence.promise : r.quiet;
    await r.leave();
    assert.equal(r.reads.at(-1)?.id, "m2");
    await r.tick(1000);
    presence.release(r.quiet);
    await r.tick(0);
    assert.equal(r.shows.length, Number(fallback));
    if (fallback) assert.equal(picked(r), "m1");
    else {
      r.cloudCards.get("m2").read.quietStartsInMs = null;
      await r.leave();
      assert.equal(r.shows.length, 1);
      assert.equal(picked(r), "m2");
    }
  }
});

test("R8: config and matching tray bot controls fence a clean card read; unrelated bots do not", async () => {
  for (const signal of ["config", "candidate", "other"]) {
    const r = rig();
    const watch = tray(r);
    const gate = later();
    try {
      r.insert();
      r.controls.sensor = () => r.presence.reads === 2 ? gate.promise : r.quiet;
      await r.leave();
      assert.equal(r.reads.at(-1)?.id, "m1");
      if (signal !== "other") r.cards.get("m1").read = { notifyOk: false };
      if (signal === "config") watch.send({ kind: "config" });
      else watch.send({ kind: "bot", bot: { id: signal === "candidate" ? "b1" : "b2" } });
      await r.tick(0);
      gate.release(r.quiet);
      await r.tick(0);
      assert.equal(r.shows.length, signal === "other" ? 1 : 0);
      if (signal === "other") assert.equal(r.reads.filter(read => read.id === "m1").length, 1);
      else {
        r.cards.get("m1").read = undefined;
        await r.leave();
        assert.equal(r.shows.length, 1);
      }
    } finally { watch.disconnect(); }
  }
});

test("R8: renderer bot controls do not request the Cloud configuration", async () => {
  const r = rig();
  for (let i = 0; i < 25; i++) await r.control("attention.bot", { botId: `bot-${i}` }, r.c);
  assert.equal(r.controls.previewReads, 0);
});

test("R9: untrusted, fallback, disabled and post-read switched-off banner choices suppress recovery", async () => {
  for (const mode of ["off", "invalid", "untrusted", "switched"]) {
    const r = rig();
    r.insert();
    if (mode === "off") r.state.surfaces.notify = false;
    if (mode === "invalid") r.controls.prefs = () => ({});
    if (mode === "untrusted") r.controls.trusted = false;
    if (mode === "switched") r.controls.response = ({ id }) => { if (id) r.state.surfaces.notify = false; };
    await r.leave();
    assert.equal(r.shows.length, 0);
    assert.equal(r.reads.length, mode === "switched" ? 2 : 0);
    r.state.surfaces.notify = true;
    r.controls.trusted = true;
    r.controls.prefs = r.controls.response = undefined;
    await r.leave();
    assert.equal(r.shows.length, 1);
  }
});

test("R10: recovery only uses fresh server preview words and closes on unconfirmed previews", async () => {
  for (const preview of [false, null]) {
    const r = rig();
    r.controls.cloudOpen = true;
    r.controls.preview = false;
    await r.main.previewsCheck("cloud");
    r.insert(approval, { read: { words: { botName: "Fixture bot", title: "Private card" } } }, "cloud");
    await r.leave();
    assert.equal(r.shows.length, 1);
    assert.deepEqual(r.shows[0].input, { title: "Fixture bot", body: "Private card", silent: true });
    r.controls.preview = preview;
    await r.control("attention.config", {}, r.c);
    await r.tick(0);
    assert.equal(r.shows[0].closed, true);
    r.insert(other(2), {}, "cloud");
    await r.leave();
    assert.equal(r.shows.length, 2);
    assert.deepEqual(r.shows[1].input, { title: "Murage", body: "Your attention is needed.", silent: true });
  }
});

test("R10/R13: previews-off recovery uses a plain notice even after a private live attempt", async () => {
  let nativePrepares = 0;
  const r = rig({ nativeApprovals: { async prepare() { nativePrepares++; return { ok: false }; } } });
  r.insert(approval);
  await r.main.previewsCheck();
  r.focus(false);
  await r.tick(250);
  const question = { ...approval, kind: "question" };
  assert.equal((await r.offer(question)).decision, "notify");
  await r.present({ title: "Private sender", body: "Private question" });
  assert.equal(r.shows[0].input.body, "Private question");
  r.shows[0].emit("failed");
  // The server's latest exact read has no words, and its config frame was missed.
  await r.tick(1250);
  assert.equal(r.shows.length, 2);
  assert.deepEqual(r.shows[1].input, { title: "Murage", body: "Your attention is needed.", silent: true });
  assert.equal(nativePrepares, 0);
});

test("R10: a steady previews-off config signal requeues an unspent credit exactly once", async () => {
  const r = rig();
  const read = later(), reread = later(), config = later();
  r.controls.preview = false;
  await r.main.previewsCheck();
  r.insert();
  let attempts = 0;
  r.controls.response = ({ id, respond }) => id ? (++attempts === 1 ? read.promise : reread.promise).then(respond) : undefined;
  await r.leave();
  r.controls.preview = config.promise;
  await r.control("attention.config");
  read.release();
  await r.tick(0);
  assert.equal(attempts, 2);
  config.release(false);
  await r.tick(0);
  reread.release();
  await r.tick(0);
  assert.equal(r.shows.length, 1);
  assert.equal(r.reads.filter(read => read.id === "m1").length, 2);
  assert.equal(r.shows[0].input.body, "Your attention is needed.");
});

test("R11: focus on the list, settle and new server epoch on the card, and Cloud identity each fence a stale read", async () => {
  for (const action of ["focus", "settle", "server", "identity", "preselect"]) {
    const r = rig();
    const read = later();
    const home = action === "identity" ? "cloud" : "local";
    r.controls.cloudOpen = home === "cloud";
    r.insert(approval, {}, home);
    let first = true;
    r.controls.response = ({ id, card, respond }) => {
      const match = ["focus", "preselect"].includes(action) ? !id : id === "m1";
      if (!match || !first) return;
      first = false;
      const staleResponse = respond();
      return read.promise.then(() => staleResponse);
    };
    await r.leave();
    if (action === "focus") r.focus(true);
    if (action === "server") { r.cards.clear(); r.main.serverChanged(); }
    if (action === "identity") { r.cloudCards.clear(); r.controls.cloudGen++; }
    if (action === "settle" || action === "preselect") {
      r.main.settled("local", "t1", "r1");
      if (action === "settle") r.cards.delete("m1");
    }
    read.release();
    await r.tick(0);
    assert.equal(r.shows.length, 0, action);
    if (action === "preselect") r.cards.delete("m1");
    r.insert(other(2), {}, home);
    await r.leave();
    assert.equal(r.shows.length, 1, action);
    assert.equal(picked(r), "m2");
  }
});

test("R11: a late empty list cannot cancel an intervening live offer", async () => {
  const r = rig();
  const list = later();
  r.controls.response = ({ id, respond }) => id === null ? list.promise.then(respond) : undefined;
  await r.leave();
  assert.equal(r.reads.length, 1);
  assert.equal((await r.offer(other(2))).decision, "notify");
  await r.present();
  list.release();
  await r.tick(0);
  assert.equal(r.shows.length, 1);
  assert.equal(picked(r), "m2");
});

test("R11: settling the newer chosen card lets the older open card through", async () => {
  const r = rig();
  const gate = later();
  r.insert(approval, { at: 1 });
  r.insert(other(2), { at: 2 });
  r.controls.response = ({ id, respond }) => id === "m2" ? gate.promise.then(respond) : undefined;
  await r.leave();
  assert.equal(r.reads.at(-1)?.id, "m2");
  const close = r.control("attention.settled", { threadId: "t2", requestId: "r2" });
  r.cards.delete("m2");
  gate.release();
  await close;
  await r.tick(0);
  assert.equal(r.shows.length, 1);
  assert.equal(picked(r), "m1");
});

test("R11: the second presence read detects a share that starts with no watch running", async () => {
  const r = rig();
  const gate = later();
  r.insert();
  r.controls.response = ({ id, respond }) => id ? gate.promise.then(respond) : undefined;
  await r.leave();
  assert.equal(r.presence.watching, 0);
  r.quiet.sharing = true;
  gate.release();
  await r.tick(0);
  assert.equal(r.shows.length, 0);
  assert.equal(r.presence.watching, 1);
  r.quiet.sharing = false;
  r.signalSensor();
  await r.tick(0);
  assert.equal(r.shows.length, 1);
});

test("R11: an unchanged-value revision during the final presence read requires a fresh observation", async () => {
  const r = rig();
  const gate = later();
  r.insert();
  r.controls.sensor = () => r.presence.reads === 2 ? gate.promise : r.quiet;
  await r.leave();
  assert.equal(r.presence.reads, 2);
  void r.presence.noteEvent();
  gate.release(r.quiet);
  await r.tick(0);
  assert.equal(r.shows.length, 1);
  assert.equal(r.reads.filter(read => read.id === "m1").length, 2);
});

test("R11: a 4.3-second-old card observation is rejected before the fresh read posts", async () => {
  const r = rig();
  const card = later(), earlierPresence = later(), finalPresence = later();
  r.insert();
  let first = true;
  r.controls.response = ({ id, respond }) => {
    if (!id || !first) return;
    first = false;
    return card.promise.then(respond);
  };
  r.controls.sensor = () => r.presence.reads === 2 ? earlierPresence.promise : r.presence.reads === 3 ? finalPresence.promise : r.quiet;
  await r.leave();
  await r.tick(1500);
  void r.presence.refresh();
  await r.tick(400);
  card.release();
  await r.tick(0);
  await r.tick(1000);
  earlierPresence.release(r.quiet);
  await r.tick(0);
  await r.tick(1400);
  assert.equal(r.shows.length, 0);
  finalPresence.release(r.quiet);
  await r.tick(0);
  assert.equal(r.shows.length, 1);
  assert.equal(r.reads.filter(read => read.id === "m1").length, 2);
});

test("R12: a held recovery watch posts only if the owner is still away on release", async () => {
  for (const returning of [false, true]) {
    const r = rig();
    r.quiet.sharing = true;
    r.insert();
    await r.leave();
    assert.equal(r.shows.length, 0);
    assert.equal(r.presence.watching, 1);
    if (returning) r.focus(true);
    r.quiet.sharing = false;
    if (returning) await r.presence.noteEvent();
    else r.signalSensor();
    await r.tick(0);
    assert.equal(r.shows.length, returning ? 0 : 1);
    if (returning) await r.leave();
    r.signalSensor();
    await r.tick(0);
    assert.equal(r.shows.length, 1);
  }
});

test("R12: a quiet release that counts a live card pays a fresh recovery credit", async () => {
  const r = rig({ origin: "new", focused: false });
  r.state.quietSummary = false;
  await r.tick(1500);
  r.quiet.sharing = true;
  r.insert();
  assert.equal((await r.offer()).decision, "held");
  assert.equal(r.shows.length, 0);
  r.quiet.sharing = false;
  r.signalSensor();
  await r.tick(0);
  assert.equal(r.shows.length, 1);
});

test("R13: two OS refusals use the single refund and leave the card eligible for a later leave", async () => {
  for (const throws of [false, true]) {
    const r = rig();
    r.insert();
    if (throws) r.controls.throwOnShow = true;
    else r.controls.notifyFailures = 3;
    await r.leave();
    assert.equal(r.shows.length, 2);
    assert.ok(r.shows.every(notice => notice.closed));
    r.controls.notifyFailures = 0;
    r.controls.throwOnShow = false;
    await r.leave();
    assert.equal(r.shows.length, 3);
  }
});

for (const settled of [false, true]) {
  test(`R13: ${settled ? "a settled OS-failed card cannot make reconnect walk backward" : "a late OS failure keeps the delta watermark until the next leave"}`, async () => {
    const r = rig({ focused: false });
    r.insert(other(2), { at: 1 });
    r.insert(approval, { at: 2 });
    await r.tick(1500);
    assert.equal(r.shows.length, 1);
    assert.equal(picked(r), "m1");
    r.shows[0].emit("failed");
    if (settled) {
      r.cards.delete("m1");
      r.main.settled("local", "t1", "r1");
    }
    await r.control("attention.resync", { gen: 1 });
    await r.tick(0);
    assert.equal(r.shows.length, 1);
    if (!settled) {
      await r.leave();
      assert.equal(r.shows.length, 2);
      assert.equal(picked(r), "m1");
    }
  });
}

test("R13: a failed live banner restores the unspent leave", async () => {
  const r = rig();
  r.insert();
  r.focus(false);
  await r.tick(250);
  assert.equal((await r.offer(other(2))).decision, "notify");
  await r.present();
  r.shows[0].emit("failed");
  await r.tick(1250);
  assert.equal(r.shows.length, 2);
  assert.equal(picked(r), "m1");
});

test("R13: recovery opens and closes the correct home and follows the last sounds report", async () => {
  const r = rig();
  r.controls.cloudOpen = true;
  r.insert(approval, {}, "cloud");
  r.main.visible(r.c, { threadId: null, focused: false, sounds: true });
  await r.leave();
  assert.equal(r.shows.length, 1);
  assert.equal(r.shows[0].input.silent, false);
  r.shows[0].emit("click");
  assert.deepEqual(r.opened.at(-1), { home: "cloud", threadId: "t1", messageId: "m1", botId: "b1" });
  r.controls.cloudOpen = false;
  r.main.homeGone("cloud");
  assert.equal(r.shows[0].closed, true);
  r.controls.cloudOpen = true;
  r.insert(other(2), {}, "cloud");
  await r.leave();
  assert.equal(r.shows[1].input.silent, true);
  r.main.settled("cloud", "t2", "r2");
  assert.equal(r.shows[1].closed, true);
});

test("R13: Electron click routing focuses main without a foreign open after the Cloud window is gone", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("openRecovered:target=>");
  assert.notEqual(start, -1);
  const end = source.indexOf("transportFor:attentionTransportFor,", start);
  const windows = new Map();
  const actions = [];
  const mainWindow = { isDestroyed: () => false, isMinimized: () => false, show: () => actions.push("show-main"), focus: () => actions.push("focus-main") };
  const open = runInNewContext(`({${source.slice(start, end)}}).openRecovered`, {
    mainWindow, cloudHome: { windows: () => windows, client: { homeOrigin: () => "https://fixture.invalid" } },
    bannerOpen: (target, home) => actions.push([target.messageId, home]),
  });
  const target = { home: "cloud", threadId: "t1", messageId: "m1", botId: "b1" };
  const cloudWindow = { isDestroyed: () => false };
  windows.set("cloud", cloudWindow);
  open(target);
  windows.delete("cloud");
  open(target);
  windows.set("cloud", cloudWindow);
  open(target);
  assert.deepEqual(actions, [["m1", "cloud"], "show-main", "focus-main", ["m1", "cloud"]]);
});

test("R15: teardown disarms the recovery retry and closes a still-open notice", async () => {
  const r = rig({ focused: false });
  await r.tick(1500);
  r.controls.cloudOpen = true;
  r.insert(approval, {}, "cloud");
  await r.control("attention.resync", { gen: 1 }, r.c);
  await r.tick(0);
  assert.equal(r.shows.length, 1);
  r.controls.response = ({ home }) => home === "local" ? unknown() : undefined;
  r.main.serverChanged();
  await r.tick(0);
  assert.ok(r.timers.some(timer => !timer.cleared && timer.at === r.now() + 5000));
  assert.equal(r.shows[0].closed, undefined);
  r.controls.shuttingDown = true;
  const count = r.timers.length;
  r.main.serverChanged();
  assert.equal(r.timers.length, count);
  assert.equal(r.shows[0].closed, undefined);
  r.main.stopRecovery?.();
  assert.equal(r.timers.filter(timer => !timer.cleared).length, 0);
  assert.equal(r.shows[0].closed, true);
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(source, /attentionMain\?\.stopRecovery\(\);attentionSurfaces\?\.dispose\(\)/);
});

test("R16: an old home is unsupported with no retry; an eligible sibling can still recover", async () => {
  const r = rig();
  const legacy = () => Response.json({ open: [] });
  r.controls.response = ({ home, id }) => home === "local" && !id ? legacy() : undefined;
  await r.leave();
  assert.equal(r.shows.length, 0);
  assert.equal(r.timers.filter(timer => !timer.cleared).length, 0);
  r.controls.cloudOpen = true;
  r.insert(approval, {}, "cloud");
  await r.leave();
  assert.equal(r.shows.length, 1);
  r.shows[0].emit("click");
  assert.equal(r.opened.at(-1).home, "cloud");
});
