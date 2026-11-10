import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createLockReader, createLogindWatcher, wireAttentionInvalidation } from "./attention-wiring.mjs";
import { createLockState } from "./lock-state.mjs";
import { createAttentionActions } from "./attention-actions.mjs";

function fakeSpawn() {
  const children = [];
  const spawn = (file, args) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => { child.killed = true; }; child.file = file; child.args = args; children.push(child); return child; };
  return { spawn, children };
}
const tick = () => new Promise(r => setImmediate(r));

test("the logind watcher listens to the system bus for LockedHint changes and calls back", () => {
  const { spawn, children } = fakeSpawn();
  const watcher = createLogindWatcher({ spawn });
  let events = 0, lost = 0;
  const stop = watcher.start(() => { events += 1; }, () => { lost += 1; });
  assert.equal(children[0].file, "dbus-monitor");
  assert.ok(children[0].args.includes("--system"));
  assert.ok(children[0].args.some(a => a.includes("org.freedesktop.login1") && a.includes("PropertiesChanged")));
  assert.equal(watcher.healthy(), false, "not healthy until the monitor has spoken (its subscription is then in place)");
  children[0].stdout.emit("data", Buffer.from("NameAcquired\n"));
  assert.equal(watcher.healthy(), true);
  children[0].stdout.emit("data", Buffer.from("signal ... string \"LockedHint\"\n"));
  children[0].stdout.emit("data", Buffer.from("signal ... string \"IdleHint\"\n"));
  assert.equal(events, 1, "only LockedHint counts");
  stop(); assert.equal(children[0].killed, true); assert.equal(lost, 0);
});

test("a watcher that cannot start or dies is unhealthy and says it was lost (fail closed)", () => {
  const { spawn, children } = fakeSpawn();
  const watcher = createLogindWatcher({ spawn });
  let lost = 0;
  watcher.start(() => {}, () => { lost += 1; });
  children[0].stdout.emit("data", Buffer.from("x"));
  children[0].emit("exit", 1);
  assert.equal(watcher.healthy(), false); assert.equal(lost, 1);
  const w2 = createLogindWatcher({ spawn: () => { throw new Error("ENOENT"); } });
  let lost2 = 0; w2.start(() => {}, () => { lost2 += 1; });
  assert.equal(w2.healthy(), false); assert.equal(lost2, 1);
});

test("linux reader never says unlocked while the watcher is not healthy", async () => {
  let healthy = true;
  const read = createLockReader({ platform: "linux", env: {}, healthy: () => healthy, execFile: (_f, _a, _o, cb) => cb(null, "no\n") });
  assert.equal(await read(), false);
  healthy = false; assert.equal(await read(), undefined);
});

test("linux: a lock with no suspend (logind event) invalidates tokens; losing the watcher goes unknown", async () => {
  const power = new EventEmitter(); const { spawn, children } = fakeSpawn();
  let answer = false;
  const watcher = createLogindWatcher({ spawn });
  const lock = createLockState({ powerMonitor: power, readLocked: createLockReader({ platform: "linux", env: {}, healthy: () => watcher.healthy(), execFile: (_f, _a, _o, cb) => cb(null, answer ? "yes\n" : "no\n") }) });
  const actions = createAttentionActions({ lock });
  const wiring = wireAttentionInvalidation({ actions, lock, powerMonitor: power, logind: watcher });
  await tick(); assert.equal(lock.locked(), true, "startup is unknown (locked) until the monitor is ready, even though loginctl says no");
  children[0].stdout.emit("data", Buffer.from("NameAcquired\n"));
  await tick(); assert.equal(lock.locked(), false);
  actions.mint({ home: "local", epoch: "e", threadId: "t", messageId: "m", requestId: "r", digest: "d", surfaceId: "s", surface: "banner-linux", identity: "i", transport: {} });
  assert.equal(actions.size, 1);
  answer = true; children[0].stdout.emit("data", Buffer.from("string \"LockedHint\"")); await tick();
  assert.equal(lock.locked(), true); assert.equal(actions.size, 0, "tokens died on lock");
  answer = false; children[0].stdout.emit("data", Buffer.from("string \"LockedHint\"")); await tick();
  assert.equal(lock.locked(), false);
  children[0].emit("exit", 1); await tick();
  assert.equal(lock.locked(), true, "monitoring lost: Allow and Reply refused");
  wiring.dispose();
});
