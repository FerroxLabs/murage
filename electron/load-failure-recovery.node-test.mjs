// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019 design rev 2.5 (A15/A16). Load-failure recovery is level-triggered on the live committed document: events only wake
// it, and every decision re-reads the document, the loading flag, the renderer, A14's state and health (after the await, with `gen`).
// The module is loaded dynamically with a no-op fallback so that on a base without it every positive test fails on its reload count,
// never on an import. LFR_MODULE / LFR_SHIM=old run the same tests against the 8e5a4722a module through an armed -> watching adapter.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOOP = { attachLoadFailureRecovery: () => ({ kick() {}, watching: () => false }) };
const loaded = await import(process.env.LFR_MODULE ? pathToFileURL(process.env.LFR_MODULE).href : "./load-failure-recovery.mjs").catch(() => NOOP);
const mod = process.env.LFR_SHIM === "old"
  ? { attachLoadFailureRecovery: (contents, d) => {
      const h = loaded.attachLoadFailureRecovery(contents, { healthy: d.healthy, reload: () => d.reload(`${d.origin()}/`), quitting: d.quitting, log: d.log, retryMs: 1500, setTimer: d.setTimer, clearTimer: d.clearTimer });
      return { kick: h.kick, watching: h.armed };
    } }
  : loaded;

const ORIGIN = "http://127.0.0.1:8799";
const APP = { committedUrl: `${ORIGIN}/`, frameUrl: `${ORIGIN}/`, frameOrigin: ORIGIN, entryUrl: `${ORIGIN}/` };
const ERR_A = { ...APP, frameUrl: "chrome-error://chromewebdata/", frameOrigin: "null" };
const ERR_B = { ...APP, frameOrigin: "null" };
const DATA = { committedUrl: "data:text/html,x", frameUrl: "data:text/html,x", frameOrigin: "null", entryUrl: "data:text/html,x" };

const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

function harness(opts = {}) {
  const h = { doc: opts.doc ?? APP, loading: false, crashed: false, destroyed: false, busy: false, state: "NOT_READY", mode: opts.mode ?? "true",
    origin: "origin" in opts ? opts.origin : ORIGIN, throwInspect: false, clock: 0, timers: [], probes: [], probeTimes: [], reloads: [], logs: [], nextId: 1 };
  const c = Object.assign(new EventEmitter(), { isDestroyed: () => h.destroyed, isCrashed: () => h.crashed, isLoadingMainFrame: () => h.loading });
  h.c = c;
  h.setTimer = (fn, ms) => { const t = { id: h.nextId++, at: h.clock + ms, fn, unref() {} }; h.timers.push(t); return t; };
  h.clearTimer = (t) => { h.timers = h.timers.filter((x) => x !== t); };
  h.advance = async (ms) => {
    await flush(); // settle already-queued continuations before the first timer is chosen
    const target = h.clock + ms;
    for (;;) {
      h.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = h.timers[0];
      if (!next || next.at > target) break;
      h.timers.shift();
      h.clock = Math.max(h.clock, next.at);
      next.fn();
      await flush();
    }
    h.clock = target;
    await flush();
  };
  h.healthy = () => {
    h.probeTimes.push(h.clock);
    if (h.mode === "hold") return new Promise((resolve) => h.probes.push(resolve));
    h.probes.push(null);
    return Promise.resolve(h.mode === "true");
  };
  h.resolve = async (i, value) => { h.probes[i]?.(value); await flush(); };
  // The renderer's own location.href (A15a documentHref stub). Default: ERR_A and ERR_B read chrome-error://, an app document its http URL.
  // opts.href: "hold" (a deferred per call, in h.hrefs) or a function (call index) -> value | promise; a test may reassign h.hrefMode.
  h.hrefCalls = 0; h.hrefs = []; h.hrefMode = opts.href ?? "auto";
  h.documentHref = () => {
    h.hrefCalls += 1;
    if (typeof h.hrefMode === "function") return h.hrefMode(h.hrefCalls - 1);
    if (h.hrefMode === "hold") return new Promise((resolve, reject) => h.hrefs.push({ resolve, reject }));
    const d = h.doc;
    return Promise.resolve(d.frameOrigin === "null" || String(d.frameUrl).startsWith("chrome-error://") ? "chrome-error://chromewebdata/" : d.frameUrl);
  };
  h.settle = async (i, value) => { assert.ok(h.hrefs[i], `documentHref call #${i} was made (${h.hrefCalls} calls)`); h.hrefs[i].resolve(value); await flush(); };
  h.loopTimers = () => h.timers.filter((t) => !t.fn.confirmDeadline);
  h.diag = () => h.logs.filter((l) => /load recovery: (candidate unconfirmed|late confirm settled)/.test(l));
  h.rec = mod.attachLoadFailureRecovery(c, {
    origin: () => h.origin,
    inspect: () => { if (h.throwInspect) throw new Error("no frame"); return { ...h.doc }; },
    readiness: () => h.state,
    documentHref: () => h.documentHref(), confirmMs: 1000,
    healthy: () => h.healthy(),
    reload: (target) => { h.reloads.push(target); h.loading = true; },
    quitting: () => false, busy: () => h.busy, log: (line) => h.logs.push(line),
    setTimer: h.setTimer, clearTimer: h.clearTimer, now: () => h.clock,
  });
  return h;
}
const startNav = (h, url = `${ORIGIN}/`) => h.c.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
const failProv = (h, code = -102, url = `${ORIGIN}/`) => h.c.emit("did-fail-provisional-load", {}, code, "", url, true);
const failLoad = (h, code = -102, url = `${ORIGIN}/`) => h.c.emit("did-fail-load", {}, code, "", url, true);
const stop = (h) => h.c.emit("did-stop-loading");
const navigated = (h, url = `${ORIGIN}/`, code = 200) => h.c.emit("did-navigate", {}, url, code, "");
// A navigation that ends on `doc` the way Electron reports it (a refused connection): error document committed, failure events, stop.
const endsOn = (h, doc) => { h.doc = doc; h.loading = false; failProv(h); failLoad(h); stop(h); };
// The first probe for a window that is on an error document (the new module probes at once; the old one on its first timer).
const armed = async (h, doc = ERR_A) => { startNav(h); endsOn(h, doc); await flush(); if (h.probes.length === 0) await h.advance(1500); };

for (const [name, ERR] of [["ERR_A", ERR_A], ["ERR_B", ERR_B]]) {
  test(`L1 S7 core: a window left on an error document (${name}) reloads when the server answers`, async () => {
    const h = harness({ mode: "false" });
    startNav(h); endsOn(h, ERR); await flush();
    assert.equal(h.reloads.length, 0, "the server is still down");
    h.mode = "true"; h.rec.kick(); await flush();
    assert.equal(h.reloads.length, 1, "the engine is back: exactly one reload");
    assert.deepEqual(h.reloads, [`${ORIGIN}/`]);
    assert.equal(h.rec.watching(), true);
    const errLines = h.logs.filter((l) => l.startsWith("load recovery: error document"));
    assert.equal(errLines.length, 1, "L16: the error document line is logged once, on the first confirmation");
    assert.match(errLines[0], /href=chrome-error:\/\//, "L16: and it carries the confirmed href");
    if (name === "ERR_A") assert.equal(h.hrefCalls, 0, "ERR_A is settled browser-side: no JavaScript runs in the page");
    const deep = harness({ mode: "false" });
    startNav(deep, `${ORIGIN}/s7?x=1`); endsOn(deep, { ...ERR, entryUrl: `${ORIGIN}/s7?x=1` }); await flush();
    deep.mode = "true"; deep.rec.kick(); await flush();
    assert.deepEqual(deep.reloads, [`${ORIGIN}/s7?x=1`], "a deep path is kept, as the meta refresh keeps it");
  });
}

test("L2 a stale same-URL late failure over a working page re-arms nothing (Astra r2)", async () => {
  const h = harness({ mode: "true" });
  startNav(h); startNav(h);
  failProv(h, -3); stop(h);
  failLoad(h, -102);
  for (let i = 0; i < 10; i += 1) await h.advance(1500);
  h.rec.kick(); await flush();
  assert.equal(h.reloads.length, 0, "the screen shows the app: nothing to recover");
  assert.equal(h.rec.watching(), false);
  assert.equal(h.probeTimes.length, 0, "no health call either");
  assert.equal(h.hrefCalls, 0, "no JavaScript runs in a page that is not a candidate");
});

test("L3 cancel then stop leaves a working page alone", async () => {
  const h = harness({ mode: "true" });
  startNav(h, `${ORIGIN}/x`); failProv(h, -3, `${ORIGIN}/x`); stop(h);
  h.rec.kick();
  for (let i = 0; i < 10; i += 1) await h.advance(1500);
  assert.equal(h.probeTimes.length, 0);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.hrefCalls, 0, "no JavaScript runs in a page that is not a candidate");
});

test("L4 re-arm: a stale probe never acts; the next tick does; a second kill recovers again", async () => {
  const h = harness({ mode: "hold" });
  startNav(h); endsOn(h, ERR_A); await flush();
  startNav(h); endsOn(h, ERR_A); await flush(); // gen moved, and its end is also an error document
  await h.resolve(0, true);
  assert.equal(h.reloads.length, 0, "the answer predates a navigation start: stale");
  h.mode = "true"; await h.advance(1500);
  assert.equal(h.reloads.length, 1, "the next tick reloads");
  h.doc = APP; h.loading = false; navigated(h); await flush();
  assert.equal(h.rec.watching(), false, "a non-error commit ends the watch");
  startNav(h); endsOn(h, ERR_B); h.rec.kick(); await flush();
  assert.equal(h.reloads.length, 2, "a second kill recovers once more");
});

test("L4b disarm and re-arm across a held probe", async () => {
  const h = harness({ mode: "hold" });
  startNav(h); endsOn(h, ERR_A); await flush();
  h.doc = APP; navigated(h); await flush();
  assert.equal(h.rec.watching(), false, "idle after the commit");
  startNav(h); endsOn(h, ERR_B); await flush();
  await h.resolve(0, true);
  assert.equal(h.reloads.length, 0, "probe #1 belongs to an earlier episode");
  h.mode = "true"; await h.advance(1500);
  assert.equal(h.reloads.length, 1, "the fresh probe reloads");
  assert.equal(h.probeTimes.length, 2);
});

test("L5 health race: every condition is read again after the await", async () => {
  // (a) the document changed with no event during the await: idle at once, no later probe
  let h = harness({ mode: "hold" });
  await armed(h);
  h.doc = APP;
  await h.resolve(0, true);
  assert.equal(h.reloads.length, 0, "(a) the screen shows the app now");
  assert.equal(h.rec.watching(), false, "(a) idle right after the post-await read");
  await h.advance(20000);
  assert.equal(h.probeTimes.length, 1, "(a) no later probe");
  // (b)-(e) each blocks the reload but keeps watching; restoring the condition reloads once
  const blockers = [
    ["b loading", (x) => { x.loading = true; }, (x) => { x.loading = false; }],
    ["c crashed", (x) => { x.crashed = true; }, (x) => { x.crashed = false; }],
    ["d busy", (x) => { x.busy = true; }, (x) => { x.busy = false; }],
    ["e ready", (x) => { x.state = "READY"; }, (x) => { x.state = "NOT_READY"; }],
  ];
  for (const [label, block, restore] of blockers) {
    h = harness({ mode: "hold" });
    await armed(h);
    block(h);
    await h.resolve(0, true);
    assert.equal(h.reloads.length, 0, `${label}: blocked`);
    restore(h); h.mode = "true";
    await h.advance(1500);
    assert.equal(h.reloads.length, 1, `${label}: exactly one reload once the condition is restored`);
    assert.equal(h.rec.watching(), true, `${label}: still watching`);
  }
});

test("L6 a newer navigation wins: a late failure after it costs no health call", async () => {
  for (const newer of ["app", "data"]) {
    const h = harness({ mode: "false" });
    startNav(h); endsOn(h, ERR_A); await flush();
    const n = h.probeTimes.length;
    startNav(h);
    if (newer === "app") { h.doc = APP; navigated(h); } else { h.doc = DATA; navigated(h, DATA.committedUrl); }
    stop(h); await flush();
    assert.equal(h.rec.watching(), false, `${newer}: idle after the newer commit`);
    failLoad(h, -102); await h.advance(5000);
    assert.equal(h.probeTimes.length, n, `${newer}: no additional health call`);
    assert.equal(h.reloads.length, 0);
    assert.equal(h.hrefCalls, 0, `${newer}: ERR_A was settled browser-side and the newer pages are not candidates: no JavaScript`);
  }
});

test("L7 not our origin is never recovered", async () => {
  const cases = [
    { ...ERR_A, entryUrl: "https://example.com/" },
    { ...ERR_B, committedUrl: "http://127.0.0.1.evil:8799/", entryUrl: "http://127.0.0.1.evil:8799/" },
    { ...ERR_B, committedUrl: "http://127.0.0.1:1234/", entryUrl: "http://127.0.0.1:1234/" },
    { ...ERR_A, entryUrl: "http://127.0.0.1:1234/" },
  ];
  for (const doc of cases) {
    const h = harness({ mode: "true" });
    startNav(h); endsOn(h, doc); h.rec.kick(); await h.advance(5000);
    assert.equal(h.reloads.length, 0, JSON.stringify(doc));
  }
});

// Rev 2.5.1 (A15a): Electron holds no route knowledge. An opaque origin on our URL is only a candidate; the renderer's own location.href decides.
const L7_PATHS = [
  "/mermaid-frame.html", "/mermaid-frame-0123456789abcdef.html", "/%6dermaid-frame.html", "/%6dermaid-frame-0123456789abcdef.html",
  "/mermaid%2Dframe-0123456789abcdef.html", "/api/artifacts/a1/preview", "/any/new/route",
];
const docAt = (p) => { const url = ORIGIN + p; return { url, doc: { ...ERR_B, committedUrl: url, frameUrl: url, entryUrl: url } }; };
const CHROME_ERR = "chrome-error://chromewebdata/";

test("L7b sandboxed top-level documents are never recovered (path-blind)", async () => {
  for (const p of L7_PATHS) {
    const { url, doc } = docAt(p);
    const h = harness({ mode: "true", href: () => Promise.resolve(url) });
    startNav(h, url); endsOn(h, doc); h.rec.kick(); await flush();
    assert.equal(h.rec.watching(), false, `${p}: IDLE after the first tick`);
    let wakes = 2; // the initial failure burst and the kick
    for (let i = 0; i < 20; i += 1) { stop(h); wakes += 1; await flush(); await h.advance(3000); }
    assert.equal(h.probeTimes.length, 0, `${p}: 0 health calls`);
    assert.equal(h.reloads.length, 0, `${p}: 0 reloads`);
    assert.equal(h.rec.watching(), false, `${p}: not watching`);
    assert.ok(h.hrefCalls >= 1 && h.hrefCalls <= wakes, `${p}: documentHref at most once per wake (${h.hrefCalls} calls, ${wakes} wakes)`);
  }
});

test("L7c a real error page on any URL recovers (path-blind the other way)", async () => {
  for (const p of L7_PATHS) {
    const { url, doc } = docAt(p);
    const h = harness({ mode: "true", href: () => Promise.resolve(CHROME_ERR) });
    startNav(h, url); endsOn(h, doc); await flush();
    assert.deepEqual(h.reloads, [url], `${p}: exactly one reload, to the same URL`);
  }
});

const hung = () => new Promise(() => {});
const confirmed = () => Promise.resolve(CHROME_ERR);
const errLine = (h) => h.logs.filter((l) => l.startsWith("load recovery: error document"));
const countLogs = (h, text) => h.logs.filter((l) => l.includes(text)).length;

test("L15a a rejecting confirm: no probe, no reload, one timer; the next attempt recovers", async () => {
  const h = harness({ mode: "true", href: (i) => (i === 0 ? Promise.reject(new Error("no frame")) : confirmed()) });
  startNav(h); endsOn(h, ERR_B); await flush();
  assert.equal(h.hrefCalls, 1);
  assert.equal(h.probeTimes.length, 0, "no health call");
  assert.equal(h.reloads.length, 0);
  assert.equal(h.rec.watching(), true);
  assert.equal(h.loopTimers().length, 1, "exactly one loop timer pending");
  assert.equal(countLogs(h, "candidate unconfirmed (reject)"), 1);
  await h.advance(1500);
  assert.equal(h.reloads.length, 1, "the next attempt resolves chrome-error:// and reloads once");
  assert.equal(countLogs(h, "candidate unconfirmed"), 1, "still the one line");
});

test("L15b the first call never settles; a fresh attempt recovers; late settlements change nothing", async () => {
  for (const late of ["page", "reject"]) {
    const held = [];
    const h = harness({ mode: "true", href: (i) => (i === 0 ? new Promise((resolve, reject) => held.push({ resolve, reject })) : confirmed()) });
    startNav(h); endsOn(h, ERR_B); await flush();
    await h.advance(1000);
    assert.equal(h.reloads.length, 0, "the deadline made it unknown");
    await h.advance(1500);
    assert.equal(h.reloads.length, 1, "the second tick's fresh attempt reloads once");
    const probes = h.probeTimes.length;
    if (late === "page") held[0].resolve(`${ORIGIN}/x`); else held[0].reject(new Error("late"));
    await flush();
    assert.equal(h.reloads.length, 1, `${late}: no extra reload`);
    assert.equal(h.probeTimes.length, probes, `${late}: no extra health call`);
    assert.equal(h.rec.watching(), true, `${late}: not IDLE`);
  }
});

test("L15c a confirm that returns undefined or 42 is unknown", async () => {
  for (const bad of [undefined, 42]) {
    const h = harness({ mode: "true", href: (i) => (i === 0 ? Promise.resolve(bad) : confirmed()) });
    startNav(h); endsOn(h, ERR_B); await flush();
    assert.equal(h.reloads.length, 0, `${String(bad)}: unknown, no reload`);
    assert.equal(h.probeTimes.length, 0);
    assert.equal(countLogs(h, "candidate unconfirmed (non-string)"), 1, `${String(bad)}: logged once`);
    await h.advance(1500);
    assert.equal(h.reloads.length, 1, `${String(bad)}: the next attempt reloads`);
  }
});

test("L15d a held confirm that resolves after the gen moved acts on nothing; the next timer tick confirms again", async () => {
  const h = harness({ mode: "true", href: "hold" });
  startNav(h); endsOn(h, ERR_B); await flush();
  startNav(h); endsOn(h, ERR_B); await flush();
  h.hrefMode = confirmed;
  await h.settle(0, CHROME_ERR);
  assert.equal(h.probeTimes.length, 0, "0 health calls for that tick");
  assert.equal(h.reloads.length, 0, "0 reloads for that tick");
  await h.advance(1500);
  assert.equal(h.reloads.length, 1, "the next timer tick, with no external wake, reloads once");
});

test("L15e a fresh page result is IDLE with no timer pending", async () => {
  const h = harness({ mode: "true", href: () => Promise.resolve(`${ORIGIN}/x`) });
  startNav(h); endsOn(h, ERR_B); await flush();
  assert.equal(h.rec.watching(), false);
  assert.equal(h.loopTimers().length, 0, "no timer pending");
  assert.equal(h.probeTimes.length, 0);
  assert.equal(h.reloads.length, 0);
});

test("L15f a stale page result after a newer navigation landed on an error document does not disarm recovery", async () => {
  const sandboxed = docAt("/%6dermaid-frame.html");
  const h = harness({ mode: "true", href: "hold" });
  startNav(h, sandboxed.url); endsOn(h, sandboxed.doc); await flush();
  startNav(h); endsOn(h, ERR_B); await flush();
  h.hrefMode = confirmed;
  await h.settle(0, sandboxed.url);
  assert.equal(h.rec.watching(), true, "not IDLE");
  assert.equal(h.probeTimes.length, 0, "0 health calls");
  await h.advance(1500);
  assert.equal(h.reloads.length, 1, "the next timer tick confirms chrome-error:// and reloads once");
});

test("L15g a stale rejection logs nothing; the next fresh rejection logs once; then recovery", async () => {
  const sandboxed = docAt("/%6dermaid-frame.html");
  const held = [];
  const h = harness({ mode: "true", href: (i) => (i === 0 ? new Promise((resolve, reject) => held.push({ resolve, reject })) : i === 1 ? Promise.reject(new Error("fresh")) : confirmed()) });
  startNav(h, sandboxed.url); endsOn(h, sandboxed.doc); await flush();
  startNav(h); endsOn(h, ERR_B); await flush();
  assert.ok(held[0], "the first documentHref call was made");
  held[0].reject(new Error("stale")); await flush();
  assert.equal(h.rec.watching(), true, "not IDLE");
  assert.equal(h.logs.length, 0, "0 log lines from the stale rejection");
  await h.advance(1500);
  assert.equal(countLogs(h, "candidate unconfirmed (reject)"), 1, "the next fresh attempt rejects: exactly one line");
  assert.equal(h.reloads.length, 0);
  await h.advance(1500);
  assert.equal(h.reloads.length, 1, "the tick after resolves chrome-error:// and reloads once");
  assert.equal(countLogs(h, "candidate unconfirmed"), 1);
});

test("L15b' an expired attempt that settles before the next attempt starts changes nothing", async () => {
  const sandboxed = docAt("/api/artifacts/a1/preview");
  for (const late of ["page", "reject"]) {
    const held = [];
    const h = harness({ mode: "true", href: (i) => (i === 0 ? new Promise((resolve, reject) => held.push({ resolve, reject })) : hung()) });
    startNav(h); endsOn(h, ERR_B); await flush();
    await h.advance(1000); // the deadline fires: unknown
    await h.advance(200);
    assert.ok(held[0], "the first documentHref call was made");
    if (late === "page") held[0].resolve(sandboxed.url); else held[0].reject(new Error("late"));
    await flush();
    assert.equal(h.rec.watching(), true, `${late}: still WATCHING`);
    assert.equal(h.probeTimes.length, 0, `${late}: no health call`);
    assert.equal(h.reloads.length, 0);
    assert.equal(h.logs.length, 2, `${late}: exactly two lines: ${JSON.stringify(h.logs)}`);
    assert.match(h.logs[0], /candidate unconfirmed \(timeout, unsettled\)/);
    assert.match(h.logs[1], new RegExp(`late confirm settled after \\d+ ms \\(${late}\\)`));
  }
});

test("L15h the cap: 4 unsettled calls under one gen; no 5th call, not even from kick; one late settlement frees a slot", async () => {
  const held = [];
  const h = harness({ mode: "true", href: (i) => (i < 4 ? new Promise((resolve, reject) => held.push({ resolve, reject })) : confirmed()) });
  startNav(h); endsOn(h, ERR_B); await flush();
  for (let i = 0; i < 3; i += 1) await h.advance(2500);
  await h.advance(1000);
  assert.equal(h.hrefCalls, 4, "4 calls under one gen");
  await h.advance(2500); await h.advance(2500); h.rec.kick(); await flush();
  assert.equal(h.hrefCalls, 4, "the 5th and 6th ticks and a kick() issue none");
  assert.equal(countLogs(h, "candidate unconfirmed (timeout, unsettled)"), 1);
  assert.equal(countLogs(h, "candidate unconfirmed (cap)"), 1);
  assert.equal(h.logs.length, 2, JSON.stringify(h.logs));
  assert.ok(held[0], "the first documentHref call was made");
  held[0].resolve(CHROME_ERR); await flush();
  assert.equal(countLogs(h, "(error)"), 1, "one late settle line");
  assert.match(h.logs.at(-1), /late confirm settled after \d+ ms \(error\)/);
  assert.equal(h.reloads.length, 0, "no state change");
  await h.advance(2500);
  assert.equal(h.hrefCalls, 5, "the next tick issues a fresh call");
  assert.equal(h.reloads.length, 1);
  assert.equal(errLine(h).length, 1);
  const diag = h.logs.filter((l) => !l.startsWith("load recovery: error document") && !l.includes("reloading"));
  assert.equal(diag.length, 3, `exactly three diagnostic lines: ${JSON.stringify(diag)}`);
  assert.ok(h.logs.indexOf(errLine(h)[0]) > h.logs.indexOf(diag[2]), "all three precede the error document line");
});

test("L15h' the cap is per gen: a navigation frees the budget", async () => {
  const h = harness({ mode: "true", href: (i) => (i < 4 ? hung() : confirmed()) });
  startNav(h); endsOn(h, ERR_B); await flush();
  for (let i = 0; i < 3; i += 1) await h.advance(2500);
  await h.advance(1000);
  assert.equal(h.hrefCalls, 4);
  startNav(h); endsOn(h, ERR_B); await flush();
  await h.advance(2500);
  assert.equal(h.hrefCalls, 5, "a fresh call although the 4 old ones are unsettled");
  assert.equal(h.reloads.length, 1);
});

test("L16 log only on confirmation: sandboxed rows never log an error document", async () => {
  for (const p of ["/%6dermaid-frame-0123456789abcdef.html", "/api/artifacts/a1/preview"]) {
    const { url, doc } = docAt(p);
    const h = harness({ mode: "true", href: () => Promise.resolve(url) });
    startNav(h, url); endsOn(h, doc); h.rec.kick(); await flush(); await h.advance(5000);
    assert.equal(errLine(h).length, 0, `${p}: no error document line`);
  }
});

test("L17 a pending timer ticks no JavaScript once the document is the app", async () => {
  const h = harness({ mode: "true", href: () => Promise.reject(new Error("unknown")) });
  startNav(h); endsOn(h, ERR_B); await flush();
  assert.equal(h.hrefCalls, 1, "the first tick confirms (unknown)");
  assert.equal(h.rec.watching(), true);
  h.doc = APP; // no event
  await h.advance(1500);
  assert.equal(h.hrefCalls, 1, "0 additional documentHref calls during the APP tick");
  assert.equal(h.rec.watching(), false, "IDLE");
});

test("L14 WATCHING always has one timer pending, also while a probe is held and a timer fires during it", async () => {
  const h = harness({ mode: "hold" });
  startNav(h); endsOn(h, ERR_A); await flush();
  assert.equal(h.rec.watching(), true);
  assert.equal(h.timers.length, 1, "a timer is pending while the first probe is in flight");
  await h.advance(1500);
  assert.equal(h.timers.length, 1, "the timer that fired during the held probe was re-armed");
  await h.advance(3000);
  assert.equal(h.timers.length, 1);
  assert.equal(h.probeTimes.length, 1, "still exactly one probe in flight");
  await h.resolve(0, false);
  assert.equal(h.timers.length, 1, "and one after the probe settles");
  assert.equal(h.rec.watching(), true);
});

test("L8 kick while healthy makes no health call", async () => {
  const h = harness({ mode: "true" });
  h.rec.kick(); await h.advance(3000);
  assert.equal(h.probeTimes.length, 0);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.hrefCalls, 0, "no JavaScript runs in a page that is not a candidate");
});

test("L9 a window destroyed mid-probe never reloads and leaves no timer", async () => {
  const h = harness({ mode: "hold" });
  await armed(h);
  h.destroyed = true; h.c.emit("destroyed");
  await h.resolve(0, true);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.timers.length, 0, "no timer pending");
});

test("L10 cadence: probes every 1.5 s while down, wakes never pull a tick forward, reloads back off, kick resets", async () => {
  // health down for 10 s: one probe per 1.5 s, no reload, and 20 duplicate wakes between ticks change nothing
  let h = harness({ mode: "false" });
  startNav(h); endsOn(h, ERR_A); await flush();
  await h.advance(2000);
  for (let i = 0; i < 20; i += 1) { failLoad(h); stop(h); h.c.emit("did-finish-load"); }
  await flush();
  await h.advance(8000);
  assert.deepEqual(h.probeTimes, [0, 1500, 3000, 4500, 6000, 7500, 9000], "one probe per 1.5 s, none from the duplicate wakes");
  assert.equal(h.reloads.length, 0);
  // health up, every reload ends on the error document again: reloads at 0, 1.5, 4.5, 10.5, 20.5, 30.5 s
  h = harness({ mode: "true" });
  const times = []; let seen = 0;
  const settle = () => { while (seen < h.reloads.length) { times.push(h.clock); seen += 1; startNav(h); endsOn(h, ERR_A); } };
  startNav(h); endsOn(h, ERR_A); await flush(); settle();
  for (let t = 0; t < 31000; t += 100) { await h.advance(100); settle(); }
  const expected = [0, 1500, 4500, 10500, 20500, 30500];
  assert.equal(times.length, expected.length, `reloads at ${times}`);
  times.forEach((t, i) => assert.ok(t >= expected[i] && t <= expected[i] + 100, `reload ${i} at ${t}, expected ${expected[i]}`));
  // kick resets the backoff to 1.5 s
  h = harness({ mode: "true" });
  const kt = []; let ks = 0;
  const settleK = () => { while (ks < h.reloads.length) { kt.push(h.clock); ks += 1; startNav(h); endsOn(h, ERR_A); } };
  startNav(h); endsOn(h, ERR_A); await flush(); settleK();
  await h.advance(1500); settleK();
  await h.advance(500); h.rec.kick(); await flush(); settleK();
  for (let t = 0; t < 3000; t += 100) { await h.advance(100); settleK(); }
  assert.deepEqual(kt.map((t) => Math.round(t / 100) * 100), [0, 1500, 2000, 3500], "kick reloads at once and the next one is 1.5 s later, not 3 s");
});

test("L11 an inspect that throws reloads nothing and escapes nothing", async () => {
  const h = harness({ mode: "true" });
  h.throwInspect = true;
  assert.doesNotThrow(() => { startNav(h); failProv(h); failLoad(h); stop(h); h.rec.kick(); });
  await h.advance(5000);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.rec.watching(), false);
});

test("L12 an unset, opaque or invalid origin fails closed", async () => {
  for (const origin of [undefined, "null", "not a url", "", "file:///x"]) {
    for (const doc of [ERR_A, { ...ERR_B, entryUrl: "data:," }, ERR_B]) {
      const h = harness({ mode: "true", origin });
      startNav(h); endsOn(h, doc); h.rec.kick(); await h.advance(5000);
      assert.equal(h.probeTimes.length, 0, `${String(origin)} ${JSON.stringify(doc)}`);
      assert.equal(h.reloads.length, 0);
    }
  }
});

test("L13 the renderer recovery flag blocks reloads while it is set and releases them when it clears", async () => {
  const h = harness({ mode: "true" });
  h.busy = true;
  startNav(h); endsOn(h, ERR_A); await h.advance(5000);
  assert.equal(h.reloads.length, 0, "renderer recovery owns the window");
  h.busy = false; await h.advance(1500);
  assert.equal(h.reloads.length, 1, "the finally cleared it: the next tick reloads once");
  assert.equal(h.rec.watching(), true);
});

test("S-kick publishServerLifecycle kicks the window's recovery only on running", () => {
  const source = readFileSync(path.join(here, "main.mjs"), "utf8");
  const from = source.indexOf("function publishServerLifecycle(");
  const body = source.slice(from, source.indexOf("/** Watch the child that actually became the engine", from));
  assert.ok(from > 0 && body.length > 50, "publishServerLifecycle found");
  const kicks = [];
  const wcs = { send() {}, isDestroyed: () => false };
  const run = (next, win) => {
    const ctx = vm.createContext({ serverLifecycleState: null, mainWindow: win, loadFailureRecoveries: new WeakMap([[wcs, { kick: () => kicks.push(next.state) }]]) });
    vm.runInContext(body, ctx);
    ctx.publishServerLifecycle(next);
    return ctx;
  };
  const live = { isDestroyed: () => false, webContents: wcs };
  run({ state: "running" }, live);
  assert.deepEqual(kicks, ["running"]);
  run({ state: "restarting" }, live); run({ state: "failed" }, live);
  assert.deepEqual(kicks, ["running"], "only running kicks");
  assert.doesNotThrow(() => run({ state: "running" }, { isDestroyed: () => true, webContents: wcs }));
  assert.doesNotThrow(() => run({ state: "running" }, null));
  assert.deepEqual(kicks, ["running"], "a destroyed or absent window kicks nothing");
});
