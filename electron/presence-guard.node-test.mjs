// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { ADDON_FILE, createLinuxReaders, createPresenceGuard, loadPresenceAddon } from "./presence-guard.mjs";

const stat = (over = {}) => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, mode: 0o100755, ...over });
const RES = "/Applications/Murage.app/Contents/Resources";
const FILE = `${RES}/${ADDON_FILE}`;

test("the loader refuses a link, a shared or writable file, a moved one, a relative folder and an addon without read()", () => {
  const ok = { resourcesPath: RES, load: () => ({ read: () => ({}) }), lstat: () => stat(), realpath: f => f };
  assert.equal(typeof loadPresenceAddon(ok).read, "function");
  for (const [label, over] of [
    ["symlink", { lstat: () => stat({ isSymbolicLink: () => true }) }],
    ["hard links", { lstat: () => stat({ nlink: 2 }) }],
    ["group writable", { lstat: () => stat({ mode: 0o100775 }) }],
    ["world writable", { lstat: () => stat({ mode: 0o100757 }) }],
    ["not a file", { lstat: () => stat({ isFile: () => false }) }],
    ["realpath elsewhere", { realpath: () => "/tmp/evil.node" }],
    ["relative folder", { resourcesPath: "resources" }],
    ["no read", { load: () => ({}) }],
    ["missing", { lstat: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } }],
  ]) assert.throws(() => loadPresenceAddon({ ...ok, ...over }), /PRESENCE_ADDON_UNAVAILABLE|ENOENT/, label);
});

test("an addon's booleans map to quiet(); anything else is not detected", async () => {
  const lock = { state: () => "unlocked" };
  const read = value => createPresenceGuard({ platform: "darwin", addon: { read: () => value }, lock });
  const guard = read({ fullscreen: true, sharing: false, focus: true });
  assert.deepEqual(guard.quiet(), { fullscreen: false, sharing: false, focus: false, locked: false }, "nothing is known before the first read");
  // R6 adds the revision of the committed read to refresh replies, but not quiet().
  assert.deepEqual(await guard.refresh(), { fullscreen: true, sharing: false, focus: true, locked: false, rev: 1 });
  assert.deepEqual((await read({ fullscreen: "yes", sharing: 1, focus: null }).refresh()), { fullscreen: false, sharing: false, focus: false, locked: false, rev: 0 });
  assert.equal((await read(undefined).refresh()).sharing, false);
  const throws = createPresenceGuard({ platform: "win32", addon: { read: () => { throw new Error("x"); } }, lock });
  assert.equal((await throws.refresh()).fullscreen, false);
  const shared = createPresenceGuard({ platform: "win32", addon: { read: async () => ({ sharing: true }) }, lock });
  assert.equal((await shared.refresh()).sharing, true);
});

test("without an addon on Mac or Windows nothing is detected and the reason is logged once", async () => {
  const logs = [];
  const guard = createPresenceGuard({ platform: "darwin", resourcesPath: RES, load: () => { throw new Error("no"); }, lock: { state: () => "unlocked" }, log: l => logs.push(l) });
  await guard.refresh(); await guard.refresh();
  assert.deepEqual(guard.quiet(), { fullscreen: false, sharing: false, focus: false, locked: false });
  assert.equal(logs.length, 1);
});

test("locked counts only when the lock state EXPLICITLY says locked (unknown never holds every notification)", async () => {
  for (const [state, expected] of [["locked", true], ["unlocked", false], ["unknown", false]]) {
    const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => ({}) }, lock: { state: () => state } });
    // R6 samples the lock only inside a committed read.
    await guard.refresh();
    assert.equal(guard.quiet().locked, expected, state);
  }
  assert.equal(createPresenceGuard({ platform: "darwin", addon: { read: () => ({}) } }).quiet().locked, false, "no lock module");
});

const runner = table => async (file, args) => { const key = `${file} ${args.join(" ")}`; for (const [pattern, out] of table) if (key.includes(pattern)) { if (out instanceof Error) throw out; return out; } throw new Error(`unexpected ${key}`); };

test("Linux X11: full screen from the active window's state; Focus from GNOME show-banners or the Inhibited property", async () => {
  const env = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };
  const full = createLinuxReaders({ env, run: runner([["-root", "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007"], ["-id 0x3a00007", "_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_FULLSCREEN"]]) });
  assert.equal(full.x11, true);
  assert.equal(await full.fullscreen(), true);
  const windowed = createLinuxReaders({ env, run: runner([["-root", "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007"], ["-id", "_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT"]]) });
  assert.equal(await windowed.fullscreen(), false);
  const none = createLinuxReaders({ env, run: runner([["-root", "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0"]]) });
  assert.equal(await none.fullscreen(), false, "no active window");
  assert.equal(await createLinuxReaders({ env, run: runner([["xprop", new Error("timeout")]]) }).fullscreen(), false, "a failed read is not detected");
  const gnome = createLinuxReaders({ env, run: runner([["show-banners", "false\n"]]) });
  assert.equal(await gnome.focus(), true);
  const kde = createLinuxReaders({ env, run: runner([["show-banners", new Error("no schema")], ["Inhibited", "b true\n"]]) });
  assert.equal(await kde.focus(), true);
  const off = createLinuxReaders({ env, run: runner([["show-banners", "true\n"], ["Inhibited", "b false\n"]]) });
  assert.equal(await off.focus(), false);
});

test("Linux Wayland: full screen is not detectable and is never guessed, and xprop is never run", async () => {
  const calls = [];
  const readers = createLinuxReaders({ env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, run: async (...args) => { calls.push(args); return ""; } });
  assert.equal(readers.x11, false);
  assert.equal(await readers.fullscreen(), false);
  assert.deepEqual(calls, []);
});

test("the poll exists only while something watches, and stops with the last watcher", async () => {
  const timers = [];
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => ({}) }, setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; }, clearTimer: t => { t.cleared = true; } });
  assert.equal(guard.polling, false);
  assert.equal(timers.length, 0, "nothing runs while nothing is held");
  const a = guard.watch(), b = guard.watch();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  assert.equal(guard.watching, 2);
  a(); a();
  assert.equal(guard.polling, true, "one watcher left");
  b();
  assert.equal(guard.polling, false);
  assert.equal(timers[0].cleared, true);
  assert.equal(guard.reads, 0, "no read happened without a decision or a tick");
});

test("a tick reads and listeners hear only real changes", async () => {
  let value = { fullscreen: false };
  const timers = [];
  const heard = [];
  const guard = createPresenceGuard({ platform: "win32", addon: { read: () => value }, setTimer: fn => { timers.push(fn); return { unref() {} }; }, clearTimer() {} });
  guard.onChange(q => heard.push(q.fullscreen));
  const stop = guard.watch();
  timers[0](); await new Promise(r => setImmediate(r));
  assert.deepEqual(heard, [], "same state, no change");
  value = { fullscreen: true };
  timers[0](); await new Promise(r => setImmediate(r));
  assert.deepEqual(heard, [true]);
  value = { fullscreen: false };
  timers[0](); await new Promise(r => setImmediate(r));
  assert.deepEqual(heard, [true, false]);
  assert.equal(guard.reads, 3);
  stop();
  guard.dispose();
  // A disposed guard returns its final committed snapshot, including its revision.
  assert.deepEqual(await guard.refresh(), { fullscreen: false, sharing: false, focus: false, locked: false, rev: 2 });
  assert.equal(guard.reads, 3, "disposed: no more reads");
});

// ---- Astra round 1 (S3B) ----
// R6 replaces superseding concurrent reads with serial commits. The older caller
// receives its own committed answer; the newer answer still becomes the cache.
test("reads commit in start order, and each caller receives its own read", async () => {
  const reads = [];
  const heard = [];
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => new Promise(resolve => reads.push(resolve)) }, lock: { state: () => "unlocked" } });
  guard.onChange(q => heard.push(q.sharing));
  const a = guard.refresh(), b = guard.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 1, "the newer read waits for the older one");
  reads[0]({ sharing: false });
  assert.equal((await a).sharing, false);
  await new Promise(resolve => setImmediate(resolve));
  reads[1]({ sharing: true });
  assert.equal((await b).sharing, true);
  assert.equal(guard.quiet().sharing, true, "the newer answer stands");
  assert.deepEqual(heard, [true], "listeners were told once, and never told 'not quiet' by the stale read");
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
// Thin cc2f adapter: an event used to request a read without a revision.
const noteEvent = guard => guard.noteEvent ? guard.noteEvent() : guard.refresh();
const markConservative = guard => guard.markConservative?.();
const values = (over = {}) => ({ fullscreen: false, sharing: false, focus: false, locked: false, ...over });

test("P2: an event during A queues B; A keeps its answer and later callers wait for B", async t => {
  let locked = false;
  const pending = [];
  const guard = createPresenceGuard({ platform: "darwin", lock: { state: () => locked ? "locked" : "unlocked" }, addon: { read() { const read = deferred(); pending.push(read); return read.promise; } } });
  t.after(() => guard.dispose());
  const a = guard.refresh();
  await flush();
  locked = true;
  const event = noteEvent(guard);
  let cDone = false;
  const c = guard.refresh().then(value => { cDone = true; return value; });
  await flush();
  assert.equal(pending.length, 1, "the event and C cannot overlap A");
  pending[0].resolve({ fullscreen: true });
  assert.deepEqual(await a, values({ fullscreen: true, locked: true, rev: 1 }));
  assert.equal(cDone, false);
  assert.equal(guard.rev, 2, "the event and changed commit each count once");
  await flush();
  assert.equal(pending.length, 2);
  locked = false;
  pending[1].resolve({ sharing: true });
  const expected = values({ sharing: true, rev: 3 });
  assert.deepEqual(await c, expected);
  assert.deepEqual(await event, expected);
  assert.deepEqual(guard.quiet(), values({ sharing: true }));
});

test("P3: many callers share one queued read and callers during that read queue the next", async t => {
  const pending = [];
  let active = 0, peak = 0;
  const guard = createPresenceGuard({ platform: "win32", addon: { read() {
    active += 1; peak = Math.max(peak, active);
    const read = deferred(); pending.push(read);
    return read.promise.finally(() => { active -= 1; });
  } } });
  t.after(() => guard.dispose());
  const a = guard.refresh();
  await flush();
  const callers = Array.from({ length: 100 }, () => guard.refresh());
  await flush();
  assert.equal(guard.reads, 1);
  assert.equal(pending.length, 1);
  pending[0].resolve({ focus: true });
  assert.deepEqual(await a, values({ focus: true, rev: 1 }));
  await flush();
  assert.equal(guard.reads, 2);
  const later = Array.from({ length: 100 }, () => guard.refresh());
  pending[1].resolve({ sharing: true });
  for (const reply of await Promise.all(callers)) assert.deepEqual(reply, values({ sharing: true, rev: 2 }));
  await flush();
  assert.equal(guard.reads, 3);
  pending[2].resolve({ fullscreen: true });
  for (const reply of await Promise.all(later)) assert.deepEqual(reply, values({ fullscreen: true, rev: 3 }));
  assert.equal(peak, 1);
  assert.equal(guard.reads, 3);
});

test("P4/P7: quiet and returned snapshots keep the committed lock when the live lock changes", async () => {
  let state = "locked";
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => ({}) }, lock: { state: () => state } });
  assert.equal(guard.quiet().locked, false, "no read has committed yet");
  const snapshot = await guard.refresh();
  state = "unlocked";
  assert.equal(guard.quiet().locked, true, "the live lock cannot change quiet()");
  assert.equal(snapshot.locked, true);
  await guard.refresh();
  assert.equal(guard.quiet().locked, false);
  assert.equal(snapshot.locked, true, "a later commit cannot change a caller's snapshot");
  guard.dispose();
});

test("revision changes only for events and changed commits, never calls, waiting or poll ticks", async t => {
  const ticks = [];
  let fullscreen = false;
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => ({ fullscreen }) }, setTimer: fn => { ticks.push(fn); return {}; }, clearTimer() {} });
  t.after(() => guard.dispose());
  assert.equal(guard.rev, 0);
  const first = guard.refresh(), second = guard.refresh();
  assert.equal(guard.rev, 0);
  assert.equal((await first).rev, 0);
  assert.equal((await second).rev, 0);
  const stop = guard.watch();
  ticks[0](); await flush();
  assert.equal(guard.rev, 0);
  const event = noteEvent(guard);
  assert.equal(guard.rev, 1, "event revision advances synchronously");
  assert.equal((await event).rev, 1);
  fullscreen = true;
  ticks[0](); await flush();
  assert.equal(guard.rev, 2);
  assert.equal((await guard.refresh()).rev, 2);
  stop();
});

test("snapshot revision uses startRev even when several events arrive during an unchanged read", async t => {
  const pending = [];
  const guard = createPresenceGuard({ platform: "darwin", addon: { read() { const read = deferred(); pending.push(read); return read.promise; } } });
  t.after(() => guard.dispose());
  const a = guard.refresh();
  await flush();
  const events = [noteEvent(guard), noteEvent(guard), noteEvent(guard)];
  pending[0].resolve({});
  assert.equal((await a).rev, 0, "unchanged commit returns its start revision");
  assert.equal(guard.rev, 3);
  await flush();
  assert.equal(pending.length, 2);
  pending[1].resolve({ focus: true });
  for (const reply of await Promise.all(events)) assert.equal(reply.rev, 4);
  assert.equal(guard.rev, 4);
});

test("P5/P7: conservative recheck runs one listener pass, clearing before listener reads", async t => {
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => ({}) } });
  t.after(() => guard.dispose());
  await guard.refresh();
  const heard = [], listenerReads = [], rechecks = [];
  guard.onChange(snapshot => {
    heard.push(snapshot);
    rechecks.push(guard.recheck);
    listenerReads.push(guard.refresh());
  });
  markConservative(guard); markConservative(guard);
  assert.equal(guard.recheck, true);
  assert.equal(guard.rev, 0, "a conservative decision is not presence evidence");
  assert.deepEqual(guard.quiet(), values());
  await guard.refresh();
  await Promise.all(listenerReads);
  assert.equal(heard.length, 1);
  assert.deepEqual(rechecks, [false], "clear before starting the listener pass");
  assert.equal(guard.recheck, false);
  assert.equal(guard.reads, 3, "the listener's read commits without another pass");
  assert.equal(guard.rev, 0);
});

test("a changed commit and recheck produce one pass, and listeners see the committed state", async t => {
  let fullscreen = false;
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => ({ fullscreen }) } });
  t.after(() => guard.dispose());
  const heard = [];
  guard.onChange(() => { throw new Error("listener"); });
  guard.onChange(snapshot => heard.push({ snapshot, quiet: guard.quiet(), recheck: guard.recheck }));
  markConservative(guard);
  fullscreen = true;
  await guard.refresh();
  await guard.refresh();
  assert.deepEqual(heard, [{ snapshot: values({ fullscreen: true, rev: 1 }), quiet: values({ fullscreen: true }), recheck: false }]);
});

test("P8 guard half: overlapping callers get two serial not-quiet reads without revision overtakes", async t => {
  const pending = [];
  let slow = false;
  const guard = createPresenceGuard({ platform: "darwin", addon: { read() {
    if (!slow) return { fullscreen: true };
    const read = deferred(); pending.push(read); return read.promise;
  } } });
  t.after(() => guard.dispose());
  await guard.refresh();
  slow = true;
  const a = guard.refresh(), b = guard.refresh();
  await flush();
  assert.equal(pending.length, 1);
  pending[0].resolve({});
  const first = await a;
  assert.deepEqual(first, values({ rev: 2 }));
  assert.equal(guard.rev, first.rev);
  await flush();
  assert.equal(pending.length, 2);
  pending[1].resolve({});
  const second = await b;
  assert.deepEqual(second, first);
  assert.equal(guard.rev, second.rev);
  assert.equal(guard.recheck, false);
  assert.equal(guard.reads, 3, "one seed read and two decision reads");
});

test("failed readers commit not-detected independently and release queued callers", async t => {
  let failing = false;
  const guard = createPresenceGuard({ platform: "linux", readers: {
    fullscreen() { if (failing) throw new Error("reader"); return true; },
    focus: async () => true,
  }, lock: { state: () => "unknown", refresh: async () => { throw new Error("lock"); } } });
  t.after(() => guard.dispose());
  await guard.refresh();
  failing = true;
  const replies = await Promise.all([guard.refresh(), guard.refresh()]);
  for (const reply of replies) assert.deepEqual(reply, values({ focus: true, rev: 2 }));
  assert.deepEqual(guard.quiet(), values({ focus: true }));
});

// Supplemental regression: cc2f already awaits the lock refresh before sampling.
test("GUARD (also green on cc2f, regression guard, not a red-first test): the lock is sampled only after its refresh completes, inside the read", async t => {
  const lockRead = deferred(), sampled = [];
  let state = "unlocked";
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => ({}) }, lock: {
    refresh: () => lockRead.promise,
    state: () => { sampled.push(state); return state; },
  } });
  t.after(() => guard.dispose());
  const read = guard.refresh();
  await flush();
  assert.deepEqual(sampled, []);
  state = "locked";
  lockRead.resolve();
  assert.equal((await read).locked, true);
  assert.deepEqual(sampled, ["locked"]);
});

test("each stalled reader is bounded at 1.5 seconds and its late result cannot overwrite a commit", async t => {
  const slow = deferred();
  let stalled = true;
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => stalled ? slow.promise : { focus: true } }, lock: { refresh: () => stalled ? slow.promise : undefined, state: () => "unknown" } });
  t.after(() => guard.dispose());
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve("still waiting"), 1800); });
  t.after(() => clearTimeout(timer));
  assert.deepEqual(await Promise.race([guard.refresh(), deadline]), values({ rev: 0 }));
  stalled = false;
  assert.deepEqual(await guard.refresh(), values({ focus: true, rev: 1 }));
  slow.resolve({ fullscreen: true });
  await flush();
  assert.deepEqual(guard.quiet(), values({ focus: true }));
});

test("a refresh also refreshes the lock, and listeners are compared with what they were last told", async () => {
  let state = "unlocked", refreshed = 0;
  const lock = { state: () => state, refresh: async () => { refreshed += 1; } };
  const heard = [];
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => ({}) }, lock });
  guard.onChange(q => heard.push(q.locked));
  await guard.refresh();
  assert.equal(refreshed, 1);
  assert.deepEqual(heard, [], "nothing changed");
  state = "locked";
  await guard.refresh();
  assert.deepEqual(heard, [true]);
  state = "unknown"; // locked -> unknown between polls: only an explicit locked holds, so this releases
  await guard.refresh();
  assert.deepEqual(heard, [true, false]);
  const failing = createPresenceGuard({ platform: "darwin", addon: { read: () => ({}) }, lock: { state: () => "unlocked", refresh: async () => { throw new Error("os"); } } });
  assert.equal((await failing.refresh()).locked, false, "a failed lock read never breaks the guard");
});

test("S3B: while watched, the addon change callback asks for a read at once; the subscription ends with the last watch and at dispose", async () => {
  let reads = 0, subscribed = 0, unsubscribed = 0, fire = null;
  const addon = { read: () => { reads += 1; return { sharing: reads > 1 }; },
    onChange(callback) { subscribed += 1; fire = callback; return () => { unsubscribed += 1; fire = null; }; } };
  const guard = createPresenceGuard({ platform: "darwin", addon, setTimer: () => ({ unref() {} }), clearTimer() {} });
  assert.equal(subscribed, 0, "nothing subscribes until something watches");
  const stopA = guard.watch(), stopB = guard.watch();
  assert.equal(subscribed, 1, "two watches share one subscription");
  const events = [];
  guard.onChange(snapshot => events.push(snapshot.sharing));
  const before = guard.rev;
  fire();
  assert.equal(guard.rev, before + 1, "the change callback is new evidence: the revision moves at once, before the read answers (Astra r1 #5)");
  await guard.refresh();
  assert.deepEqual(events, [true], "a share that starts between ticks is read and committed without waiting for the poll");
  stopA();
  assert.equal(unsubscribed, 0, "still watched");
  stopB();
  assert.equal(unsubscribed, 1, "the last watch releases the addon callback");
  const again = guard.watch();
  assert.equal(subscribed, 2, "a new watch subscribes again");
  guard.dispose();
  assert.equal(unsubscribed, 2, "dispose releases it");
  again();
  const bare = createPresenceGuard({ platform: "darwin", addon: { read: () => ({}) }, setTimer: () => ({ unref() {} }), clearTimer() {} });
  assert.doesNotThrow(() => bare.watch()(), "an addon without onChange is polled only");
  const throwing = createPresenceGuard({ platform: "win32", addon: { read: () => ({}), onChange() { throw new Error("x"); } }, setTimer: () => ({ unref() {} }), clearTimer() {} });
  assert.doesNotThrow(() => throwing.watch()(), "a failing subscribe never breaks watching");
});
