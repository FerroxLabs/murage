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
  assert.deepEqual(await guard.refresh(), { fullscreen: true, sharing: false, focus: true, locked: false });
  assert.deepEqual((await read({ fullscreen: "yes", sharing: 1, focus: null }).refresh()), { fullscreen: false, sharing: false, focus: false, locked: false });
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
  assert.deepEqual(await guard.refresh(), { fullscreen: false, sharing: false, focus: false, locked: false });
  assert.equal(guard.reads, 3, "disposed: no more reads");
});

// ---- Astra round 1 (S3B) ----
test("an older read that finishes after a newer one is discarded: a stale 'not quiet' never overwrites a newer quiet", async () => {
  const reads = [];
  const heard = [];
  const guard = createPresenceGuard({ platform: "darwin", addon: { read: () => new Promise(resolve => reads.push(resolve)) }, lock: { state: () => "unlocked" } });
  guard.onChange(q => heard.push(q.sharing));
  const a = guard.refresh(), b = guard.refresh();
  await new Promise(resolve => setImmediate(resolve));
  reads[1]({ sharing: true }); // the newer read answers first
  await b;
  reads[0]({ sharing: false }); // the older answer arrives late
  await a;
  assert.equal(guard.quiet().sharing, true, "the newer answer stands");
  assert.deepEqual(heard, [true], "listeners were told once, and never told 'not quiet' by the stale read");
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
