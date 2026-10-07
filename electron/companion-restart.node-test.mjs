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
