import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createLockReader, wireAttentionInvalidation } from "./attention-wiring.mjs";
import { createLockState } from "./lock-state.mjs";
import { createAttentionActions } from "./attention-actions.mjs";

test("mac and windows: only an explicit state is a boolean; unknown is not", async () => {
  for (const platform of ["darwin", "win32"]) {
    const read = state => createLockReader({ platform, getSystemIdleState: () => state });
    assert.equal(await read("locked")(), true);
    assert.equal(await read("active")(), false);
    assert.equal(await read("idle")(), false);
    assert.equal(await read("unknown")(), undefined);
    assert.equal(await read("something-new")(), undefined);
    assert.equal(await createLockReader({ platform, getSystemIdleState: () => { throw new Error("no"); } })(), undefined);
  }
});

test("linux: logind LockedHint yes/no is a boolean; an error or other text is unknown", async () => {
  const run = (stdout, error = null, env = {}) => createLockReader({ platform: "linux", env, execFile: (file, args, _o, cb) => { run.last = [file, args]; cb(error, stdout); } })();
  assert.equal(await run("yes\n"), true);
  assert.equal(await run("no\n"), false);
  assert.equal(await run("maybe"), undefined);
  assert.equal(await run("", new Error("no loginctl")), undefined);
  await run("no", null, { XDG_SESSION_ID: "c2" });
  assert.deepEqual(run.last, ["loginctl", ["show-session", "c2", "-p", "LockedHint", "--value"]]);
  await run("no", null, { XDG_SESSION_ID: "../evil" });
  assert.equal(run.last[1][1], "auto");
  assert.equal(await createLockReader({ platform: "freebsd" })(), undefined);
});

test("Allow and Reply stay refused until the reader says unlocked; Deny does not need it", async () => {
  const power = new EventEmitter();
  let answer; const lock = createLockState({ powerMonitor: power, readLocked: async () => answer });
  assert.equal(lock.locked(), true);
  await lock.refresh(); assert.equal(lock.locked(), true); // undefined stays unknown
  answer = false; await lock.refresh(); assert.equal(lock.locked(), false);
});

test("every invalidating event kills outstanding tokens", async () => {
  const power = new EventEmitter(); let answer = false;
  const lock = createLockState({ powerMonitor: power, readLocked: async () => answer });
  const actions = createAttentionActions({ lock });
  const wiring = wireAttentionInvalidation({ actions, lock, powerMonitor: power });
  await lock.refresh();
  const mint = () => actions.mint({ home: "local", epoch: "e", threadId: "t", messageId: "m", requestId: "r", digest: "d", surfaceId: "s", surface: "banner-win", identity: "i", transport: {} });
  const fires = {
    "lock-screen": () => power.emit("lock-screen"),
    suspend: () => power.emit("suspend"),
    server: () => wiring.serverChanged(),
    "data-owner": () => wiring.ownerChanged(),
    "cloud-window": () => wiring.cloudWindowChanged(),
    previews: () => wiring.previewsChanged(),
  };
  for (const [name, fire] of Object.entries(fires)) {
    mint(); mint(); assert.equal(actions.size, 2, name);
    fire(); assert.equal(actions.size, 0, name);
  }
});

test("resume asks the OS again, and a locked result kills tokens", async () => {
  const power = new EventEmitter(); let answer = false;
  const lock = createLockState({ powerMonitor: power, readLocked: async () => answer });
  const actions = createAttentionActions({ lock });
  wireAttentionInvalidation({ actions, lock, powerMonitor: power });
  await new Promise(r => setImmediate(r));
  assert.equal(lock.locked(), false);
  power.emit("suspend"); assert.equal(lock.locked(), true);
  answer = true; power.emit("resume"); await new Promise(r => setImmediate(r));
  assert.equal(lock.locked(), true);
  answer = false; power.emit("resume"); await new Promise(r => setImmediate(r));
  assert.equal(lock.locked(), false);
});

test("dispose removes the listeners", () => {
  const power = new EventEmitter();
  const lock = createLockState({ powerMonitor: power });
  const w = wireAttentionInvalidation({ actions: { invalidateAll() {} }, lock, powerMonitor: power });
  const before = power.listenerCount("suspend"); w.dispose();
  assert.equal(power.listenerCount("suspend"), before - 1);
});
