import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionRestarter } from "./companion-restart.mjs";
import { MAX_CRASHES_IN_WINDOW } from "./server-supervisor.mjs";

function rig({ shutting = false } = {}) {
  const starts = []; const timers = [];
  const r = createCompanionRestarter({
    start: async () => { starts.push(1); },
    shuttingDown: () => shutting,
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  const flush = async () => { const t = timers.splice(0); for (const x of t) x.fn(); await new Promise((r) => setImmediate(r)); };
  return { r, starts, timers, flush };
}

test("an unasked companion exit restarts it", async () => {
  const x = rig();
  assert.equal(x.r.onExit({ expected: false, wasEnabled: true }).action, "restart");
  await x.flush();
  assert.equal(x.starts.length, 1);
});

test("an asked stop, a disabled companion and app quit do not restart", async () => {
  const x = rig();
  x.r.onExit({ expected: true, wasEnabled: true });
  x.r.onExit({ expected: false, wasEnabled: false });
  const q = rig({ shutting: true });
  q.r.onExit({ expected: false, wasEnabled: true });
  await x.flush(); await q.flush();
  assert.equal(x.starts.length + q.starts.length, 0);
});

test("a crash loop stops after the cap", async () => {
  const x = rig();
  const actions = [];
  for (let i = 0; i <= MAX_CRASHES_IN_WINDOW; i++) { actions.push(x.r.onExit({ expected: false, wasEnabled: true }).action); await x.flush(); }
  assert.equal(actions.at(-1), "give-up");
  assert.equal(x.starts.length, MAX_CRASHES_IN_WINDOW);
});

test("a restart that does not come up is retried, within the cap", async () => {
  const timers = []; let starts = 0;
  const r = createCompanionRestarter({ start: async () => { starts++; return { enabled: false, error: "x" }; }, shuttingDown: () => false, schedule: (fn, ms) => timers.push(fn) });
  r.onExit({ expected: false, wasEnabled: true });
  for (let i = 0; i < 10 && timers.length; i++) { timers.shift()(); await new Promise((r) => setImmediate(r)); }
  assert.equal(starts, MAX_CRASHES_IN_WINDOW);
});

const timedOutRestart = { enabled: false, error: "the companion did not come up in time" };
test("a failed restart whose child already exited on its own counts that crash once (U3-G17-F1)", async () => {
  let gen = 0; let decides = 0; const timers = [];
  const supervisor = { decide: () => { decides++; return { action: "restart", delayMs: 1_000, attempt: decides }; } };
  let r;
  let starts = 0;
  r = createCompanionRestarter({
    start: async () => {
      starts++;
      gen++;
      if (starts === 1) {
        // The restarted child dies while start probes it: the listener moves
        // the generation and hands the exit to onExit before start resolves.
        gen++;
        r.onExit({ expected: false, wasEnabled: true });
        return timedOutRestart;
      }
      return { enabled: true };
    },
    shuttingDown: () => false,
    generation: () => gen,
    supervisor,
    schedule: (fn) => timers.push(fn),
  });
  gen++; r.onExit({ expected: false, wasEnabled: true }); // the first crash
  assert.equal(decides, 1);
  timers.shift()(); await new Promise((res) => setImmediate(res));
  // The child's own exit was counted once; the failed start adds no second count.
  assert.equal(decides, 2);
  assert.equal(timers.length, 1);
  timers.shift()(); await new Promise((res) => setImmediate(res));
  assert.equal(starts, 2);
  assert.equal(decides, 2);
  assert.equal(timers.length, 0);
});

// Launch start retries (G17): one owner for every automatic start.
const up = { enabled: true };
const timedOut = { enabled: false, error: "the companion did not come up in time" };

function launchRig(states, { wanted = () => true, shutting = () => false } = {}) {
  const box = { gen: 0, starts: 0, timers: [], lines: [] };
  box.r = createCompanionRestarter({
    start: async () => {
      box.starts++;
      box.gen++;
      const next = states.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    shuttingDown: shutting,
    wanted,
    generation: () => box.gen,
    schedule: (fn, ms) => box.timers.push({ fn, ms }),
    log: (line) => box.lines.push(line),
  });
  box.settle = () => new Promise((r) => setImmediate(r));
  box.fire = async () => { const t = box.timers.shift(); t.fn(); await box.settle(); return t.ms; };
  return box;
}

test("a launch start that fails twice is retried at 5 s and 15 s and comes up", async () => {
  const x = launchRig([timedOut, timedOut, up]);
  const done = x.r.launchStart();
  await x.settle();
  assert.equal(await x.fire(), 5_000);
  assert.equal(await x.fire(), 15_000);
  assert.deepEqual(await done, up);
  assert.equal(x.starts, 3);
  assert.equal(x.timers.length, 0);
});

test("a launch start that never comes up stops after 5, 15 and 30 s", async () => {
  const x = launchRig([timedOut, timedOut, timedOut, timedOut, up]);
  const done = x.r.launchStart();
  await x.settle();
  const gaps = [await x.fire(), await x.fire(), await x.fire()];
  assert.deepEqual(gaps, [5_000, 15_000, 30_000]);
  assert.deepEqual(await done, timedOut);
  assert.equal(x.starts, 4);
  assert.match(x.lines.at(-1), /giving up until the app restarts/);
});

test("turning the phone off during a wait cancels the retry", async () => {
  let on = true;
  const x = launchRig([timedOut, up], { wanted: () => on });
  const done = x.r.launchStart();
  await x.settle();
  on = false;
  await x.fire();
  assert.deepEqual(await done, timedOut);
  assert.equal(x.starts, 1);
});

test("a manual start during a wait takes over and the retry does not start again", async () => {
  const x = launchRig([timedOut, up]);
  const done = x.r.launchStart();
  await x.settle();
  x.gen++; // the person pressed start (or stop) meanwhile
  await x.fire();
  assert.deepEqual(await done, timedOut);
  assert.equal(x.starts, 1);
});

test("quitting during a wait cancels the retry", async () => {
  let quitting = false;
  const x = launchRig([timedOut, up], { shutting: () => quitting });
  const done = x.r.launchStart();
  await x.settle();
  quitting = true;
  await x.fire();
  assert.deepEqual(await done, timedOut);
  assert.equal(x.starts, 1);
});

test("a thrown launch start (policy refusal) is never retried and never rejects", async () => {
  const x = launchRig([new Error("remote access is turned off by your organisation"), up]);
  assert.equal(await x.r.launchStart(), null);
  assert.equal(x.starts, 1);
  assert.equal(x.timers.length, 0);
});

test("an unasked exit during a launch start hands over to the exit restarter, never both", async () => {
  const x = launchRig([]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const order = [];
  x.r = createCompanionRestarter({
    start: async () => {
      x.gen++;
      order.push("start");
      if (order.length === 1) {
        // The child dies while the launch start probes it: the listener moves
        // the generation and calls onExit before this start resolves.
        x.gen++;
        x.r.onExit({ expected: false, wasEnabled: true });
        await gate;
        return timedOut;
      }
      return up;
    },
    shuttingDown: () => false,
    wanted: () => true,
    generation: () => x.gen,
    schedule: (fn, ms) => x.timers.push({ fn, ms }),
  });
  const done = x.r.launchStart();
  await x.settle();
  // The exit restarter's timer fires while the launch start is still blocked:
  // its start must wait for the launch start to settle.
  assert.equal(x.timers.length, 1);
  await x.fire();
  assert.deepEqual(order, ["start"]);
  release();
  assert.deepEqual(await done, timedOut);
  await x.settle();
  assert.deepEqual(order, ["start", "start"]);
  // The launch run scheduled no retry of its own.
  assert.equal(x.timers.length, 0);
});

test("an automatic start that gave way to a stop or a newer start is not retried by either path", async () => {
  const gaveWay = { enabled: false, superseded: true };
  const x = launchRig([gaveWay]);
  assert.deepEqual(await x.r.launchStart(), gaveWay);
  assert.equal(x.timers.length, 0);
  const y = launchRig([gaveWay, up]);
  y.r.onExit({ expected: false, wasEnabled: true });
  await y.fire();
  assert.equal(y.starts, 1);
  assert.equal(y.timers.length, 0);
});

test("an exit restart that is pending stops a launch retry from starting", async () => {
  const x = launchRig([timedOut, up, up]);
  const done = x.r.launchStart();
  await x.settle();
  x.r.onExit({ expected: false, wasEnabled: true });
  // Fire the launch run's 5 s wait first: it must stand down.
  await x.fire();
  assert.deepEqual(await done, timedOut);
  assert.equal(x.starts, 1);
  await x.fire(); // the exit restarter's own start
  assert.equal(x.starts, 2);
});

test("a Stop pressed while an exit restart waits behind a launch start keeps the companion off", async () => {
  const x = launchRig([]);
  let release;
  const gate = new Promise((r) => { release = r; });
  let starts = 0;
  x.r = createCompanionRestarter({
    start: async () => {
      x.gen++;
      starts++;
      if (starts === 1) {
        x.gen++;
        x.r.onExit({ expected: false, wasEnabled: true });
        await gate;
        return timedOut;
      }
      return up;
    },
    shuttingDown: () => false,
    wanted: () => true,
    generation: () => x.gen,
    schedule: (fn, ms) => x.timers.push({ fn, ms }),
  });
  const done = x.r.launchStart();
  await x.settle();
  await x.fire(); // the exit restart queues behind the blocked launch start
  x.gen++; // the person presses Stop
  release();
  assert.deepEqual(await done, timedOut);
  await x.settle();
  assert.equal(starts, 1);
  assert.equal(x.timers.length, 0);
});

test("a Stop pressed during an exit restart's delay keeps the companion off", async () => {
  const x = launchRig([up]);
  x.r.onExit({ expected: false, wasEnabled: true });
  x.gen++; // Stop
  await x.fire();
  assert.equal(x.starts, 0);
});

test("a crash of a manually started companion replaces a stale pending restart", async () => {
  const x = launchRig([up]);
  x.gen++; x.r.onExit({ expected: false, wasEnabled: true }); // first crash
  x.gen++; // manual start before the restart timer fired
  x.gen++; x.r.onExit({ expected: false, wasEnabled: true }); // that companion crashes too
  assert.equal(x.timers.length, 2);
  await x.fire(); // the stale restart stands down
  assert.equal(x.starts, 0);
  await x.fire(); // the newer one starts
  assert.equal(x.starts, 1);
});
