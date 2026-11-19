import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createLockReader, createLogindWatcher, wireAttentionInvalidation } from "./attention-wiring.mjs";
import { createLockState } from "./lock-state.mjs";
import { createAttentionActions } from "./attention-actions.mjs";

const tick = () => new Promise(r => setImmediate(r));
function fakeSpawn() {
  const children = [];
  const spawn = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => { child.killed = true; }; children.push(child); return child; };
  return { spawn, children };
}

test("overlapping refreshes: the latest request wins, an older false cannot preserve unlocked", async () => {
  const power = new EventEmitter(); const pending = [];
  const lock = createLockState({ powerMonitor: power, readLocked: () => new Promise(resolve => pending.push(resolve)) });
  const a = lock.refresh(); const b = lock.refresh();
  pending[0](false); // the older read answers first with "unlocked"
  pending[1](true);  // the newer read says locked
  await Promise.all([a, b]);
  assert.equal(lock.locked(), true);
});

test("an event during a refresh still beats the refresh result", async () => {
  const power = new EventEmitter(); const pending = [];
  const lock = createLockState({ powerMonitor: power, readLocked: () => new Promise(resolve => pending.push(resolve)) });
  const a = lock.refresh();
  power.emit("lock-screen"); pending[0](false); await a;
  assert.equal(lock.locked(), true);
});

test("a logind signal makes the state unknown and kills tokens at once, before the refresh answers", async () => {
  const power = new EventEmitter(); const { spawn, children } = fakeSpawn();
  const watcher = createLogindWatcher({ spawn });
  const pending = []; let hold = false;
  const lock = createLockState({ powerMonitor: power, readLocked: () => hold ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(false) });
  const actions = createAttentionActions({ lock });
  wireAttentionInvalidation({ actions, lock, powerMonitor: power, logind: watcher });
  children[0].stdout.emit("data", Buffer.from("NameAcquired\n")); await tick(); await tick();
  assert.equal(lock.locked(), false);
  actions.mint({ home: "local", epoch: "e", threadId: "t", messageId: "m", requestId: "r", digest: "d", surfaceId: "s", surface: "banner-linux", identity: "i", transport: {} });
  hold = true;
  children[0].stdout.emit("data", Buffer.from("string \"LockedHint\"\n"));
  // The refresh has not answered yet.
  assert.equal(lock.locked(), true, "Allow and Reply are refused the moment the signal arrives");
  assert.equal(actions.size, 0);
  pending[0](false); await tick();
  assert.equal(lock.locked(), false, "and the refresh may unlock again");
});

test("before the monitor is ready nothing can unlock, and a signal lost before readiness cannot leave Allow enabled", async () => {
  const power = new EventEmitter(); const { spawn, children } = fakeSpawn();
  const watcher = createLogindWatcher({ spawn });
  const lock = createLockState({ powerMonitor: power, readLocked: createLockReader({ platform: "linux", env: {}, healthy: () => watcher.healthy(), execFile: (_f, _a, _o, cb) => cb(null, "no\n") }) });
  wireAttentionInvalidation({ actions: { invalidateAll() {} }, lock, powerMonitor: power, logind: watcher });
  await tick(); await tick();
  assert.equal(lock.locked(), true);
  children[0].stdout.emit("data", Buffer.from("NameAcquired\n")); await tick(); await tick();
  assert.equal(lock.locked(), false, "ready: the refresh after readiness reads the real state");
});

test("a LockedHint split across two chunks is still seen", () => {
  const { spawn, children } = fakeSpawn();
  const watcher = createLogindWatcher({ spawn });
  let events = 0; watcher.start(() => { events += 1; }, () => {});
  children[0].stdout.emit("data", Buffer.from("string \"Lock"));
  children[0].stdout.emit("data", Buffer.from("edHint\"\n"));
  assert.equal(events, 1);
  children[0].stdout.emit("data", Buffer.from("string \"IdleHint\"\n")); assert.equal(events, 1);
  children[0].stdout.emit("data", Buffer.from("LockedHint LockedHint")); assert.ok(events >= 2);
});

test("an unreadable or closed stream fails closed", () => {
  const { spawn, children } = fakeSpawn();
  const watcher = createLogindWatcher({ spawn });
  let lost = 0; watcher.start(() => {}, () => { lost += 1; });
  children[0].stdout.emit("error", new Error("EPIPE"));
  assert.equal(watcher.healthy(), false); assert.equal(lost, 1);
  const s2 = fakeSpawn(); const w2 = createLogindWatcher({ spawn: s2.spawn });
  let lost2 = 0; w2.start(() => {}, () => { lost2 += 1; });
  s2.children[0].stdout.emit("close");
  assert.equal(w2.healthy(), false); assert.equal(lost2, 1);
});

test("reader still reports unknown while unhealthy (regression)", async () => {
  const read = createLockReader({ platform: "linux", env: {}, healthy: () => false, execFile: (_f, _a, _o, cb) => cb(null, "no\n") });
  assert.equal(await read(), undefined);
});

test("loss is terminal for that watcher: data after exit or error cannot restore health or unlock", async () => {
  for (const how of ["exit", "error", "stdout-error"]) {
    const power = new EventEmitter(); const { spawn, children } = fakeSpawn();
    const watcher = createLogindWatcher({ spawn });
    const lock = createLockState({ powerMonitor: power, readLocked: createLockReader({ platform: "linux", env: {}, healthy: () => watcher.healthy(), execFile: (_f, _a, _o, cb) => cb(null, "no\n") }) });
    let events = 0;
    wireAttentionInvalidation({ actions: { invalidateAll() {} }, lock, powerMonitor: power, logind: watcher });
    children[0].stdout.emit("data", Buffer.from("NameAcquired\n")); await tick(); await tick();
    assert.equal(lock.locked(), false, how);
    if (how === "exit") children[0].emit("exit", 1); else if (how === "error") children[0].emit("error", new Error("x")); else children[0].stdout.emit("error", new Error("x"));
    assert.equal(lock.locked(), true, how);
    children[0].stdout.emit("data", Buffer.from("buffered LockedHint\n")); await tick(); await tick();
    assert.equal(watcher.healthy(), false, how); assert.equal(lock.locked(), true, how + ": still refused");
    assert.equal(events, 0);
  }
});
