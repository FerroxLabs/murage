// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPresenceGuard } from "./presence-guard.mjs";

// On cc2f this module does not exist. Exercise its actual three main.mjs wiring
// lines through this adapter so the baseline fails on behavior, not an import.
const { wirePresence } = await import("./presence-wiring.mjs").catch(error => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || !error.message.includes("presence-wiring.mjs")) throw error;
  return { wirePresence({ lock, presenceGuard, attentionMain, powerMonitor }) {
    lock.onChange(locked => { if (!locked) { void attentionMain.reconcile(); void attentionMain.quietChanged(); } });
    presenceGuard.onChange(() => { void attentionMain.quietChanged(); });
    powerMonitor.on("resume", () => { void attentionMain.reconcile(); });
    // The original wiring retained no disposer. Model that absence behaviorally.
    return () => {};
  } };
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function fakeLock(initial = "locked") {
  let state = initial;
  const listeners = new Set();
  return {
    state: () => state,
    refresh: async () => {},
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { state = next; for (const fn of [...listeners]) fn(next !== "unlocked"); },
    get listeners() { return listeners.size; },
  };
}

test("P1: unlock during a slow fullscreen read cannot release before a committed guard change", async t => {
  const lock = fakeLock(), powerMonitor = new EventEmitter(), pending = [];
  let slow = false, releases = 0, reconciles = 0, calls = 0, committedPass = false;
  const committedCalls = [];
  const guard = createPresenceGuard({ platform: "darwin", lock, addon: { read: () => slow ? new Promise(resolve => pending.push(resolve)) : {} } });
  t.after(() => guard.dispose());
  await guard.refresh();
  const realSubscribe = guard.onChange;
  const presenceGuard = { noteEvent: () => guard.noteEvent(), onChange(fn) {
    return realSubscribe(() => { committedPass = true; try { fn(); } finally { committedPass = false; } });
  } };
  const attentionMain = {
    reconcile() { reconciles += 1; },
    quietChanged() {
      calls += 1;
      const q = guard.quiet();
      if (!Object.values(q).some(Boolean)) releases += 1;
      committedCalls.push(committedPass);
    },
  };
  const off = wirePresence({ lock, presenceGuard, attentionMain, powerMonitor });
  t.after(off);
  slow = true;
  const read = guard.refresh();
  await flush();
  lock.set("unlocked");
  assert.equal(reconciles, 1);
  assert.equal(calls, 0, "unlock cannot release from cached readers");
  assert.equal(releases, 0);
  pending[0]({ fullscreen: true });
  await read;
  assert.equal(calls, 1);
  assert.equal(releases, 0);
  await flush();
  assert.equal(pending.length, 2, "unlock queues a complete read");
  pending[1]({ fullscreen: true });
  await flush();
  assert.equal(calls, 1, "unchanged queued commit does not release again");
  assert.equal(releases, 0);
  assert.deepEqual(committedCalls, [true], "quietChanged comes only from guard.onChange");
});

test("lock and all four power events synchronously note presence before reconcile", () => {
  const lock = fakeLock(), powerMonitor = new EventEmitter(), order = [];
  let listener;
  const off = wirePresence({ lock, powerMonitor, presenceGuard: {
    noteEvent() { order.push("event"); return Promise.resolve(); },
    onChange(fn) { listener = fn; return () => { listener = null; }; },
  }, attentionMain: { reconcile() { order.push("reconcile"); }, quietChanged() { order.push("quiet"); } } });
  lock.set("locked");
  assert.deepEqual(order.splice(0), ["event"]);
  lock.set("unlocked");
  assert.deepEqual(order.splice(0), ["event", "reconcile"]);
  for (const event of ["lock-screen", "unlock-screen", "suspend", "resume"]) {
    powerMonitor.emit(event);
    assert.deepEqual(order.splice(0), event === "resume" ? ["event", "reconcile"] : ["event"], event);
  }
  listener();
  assert.deepEqual(order, ["quiet"]);
  off(); off();
  assert.equal(listener, null);
  assert.equal(lock.listeners, 0);
  for (const event of ["lock-screen", "unlock-screen", "suspend", "resume"]) assert.equal(powerMonitor.listenerCount(event), 0);
});

test("power events advance the real guard revision before any reader starts", async t => {
  const lock = fakeLock("unlocked"), powerMonitor = new EventEmitter();
  const guard = createPresenceGuard({ platform: "darwin", lock, addon: { read: () => ({}) } });
  t.after(() => guard.dispose());
  const off = wirePresence({ lock, presenceGuard: guard, powerMonitor, attentionMain: { reconcile() {}, quietChanged() {} } });
  t.after(off);
  let rev = 0;
  for (const event of ["lock-screen", "unlock-screen", "suspend", "resume"]) {
    powerMonitor.emit(event);
    assert.equal(guard.rev, ++rev, event);
    await flush();
    assert.equal(guard.rev, rev, "unchanged commit adds no revision");
  }
  assert.equal(guard.reads, 4);
});

test("off removes only its own listeners and prevents later presence work", () => {
  const lock = fakeLock(), powerMonitor = new EventEmitter(), calls = [];
  const external = () => calls.push("external");
  powerMonitor.on("resume", external);
  const listeners = new Set();
  const off = wirePresence({ lock, powerMonitor, presenceGuard: {
    noteEvent() { calls.push("event"); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  }, attentionMain: { reconcile() { calls.push("reconcile"); }, quietChanged() { calls.push("quiet"); } } });
  off(); off();
  lock.set("unlocked");
  for (const event of ["lock-screen", "unlock-screen", "suspend", "resume"]) powerMonitor.emit(event);
  for (const listener of listeners) listener();
  assert.deepEqual(calls, ["external"]);
  assert.equal(powerMonitor.listenerCount("resume"), 1);
  assert.equal(lock.listeners, 0);
  assert.equal(listeners.size, 0);
});
