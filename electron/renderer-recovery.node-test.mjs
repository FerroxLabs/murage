import assert from "node:assert/strict";
import test from "node:test";
import { createRendererRecovery, repaintAfterGpuLoss, MAX_RENDERER_RELOADS_IN_WINDOW } from "./renderer-recovery.mjs";

function rig(over = {}) {
  let t = 0; const calls = [];
  const state = { server: "running", healthy: true, quitting: false };
  const r = createRendererRecovery({
    quitting: () => state.quitting,
    serverState: () => state.server,
    healthy: async () => state.healthy,
    showReconnecting: () => calls.push("reconnecting"),
    load: () => calls.push("load"),
    showRecovery: () => calls.push("recovery"),
    now: () => t,
    sleep: async (ms) => { t += ms; if (over.onSleep) over.onSleep(state); },
    ...over.deps,
  });
  return { r, calls, state, tick: (ms) => { t += ms; } };
}

test("a killed renderer shows reconnecting, then reloads once the server is healthy", async () => {
  const x = rig();
  assert.equal(await x.r.onGone({ reason: "killed" }), "reloaded");
  assert.deepEqual(x.calls, ["reconnecting", "load"]);
});

test("it waits through a server restart before loading", async () => {
  const x = rig({ onSleep: (s) => { s.server = "running"; } });
  x.state.server = "restarting";
  assert.equal(await x.r.onGone({ reason: "crashed" }), "reloaded");
  assert.deepEqual(x.calls, ["reconnecting", "load"]);
});

test("a server that cannot come back shows recovery, never a bare load", async () => {
  const x = rig();
  x.state.server = "failed";
  assert.equal(await x.r.onGone({ reason: "oom" }), "recovery");
  assert.deepEqual(x.calls, ["reconnecting", "recovery"]);
});

test("a server that never answers times out into recovery", async () => {
  const x = rig();
  x.state.healthy = false;
  assert.equal(await x.r.onGone({ reason: "killed" }), "recovery");
});

test("quitting and clean exits are ignored", async () => {
  const x = rig();
  x.state.quitting = true;
  assert.equal(await x.r.onGone({ reason: "killed" }), "ignored");
  x.state.quitting = false;
  assert.equal(await x.r.onGone({ reason: "clean-exit" }), "ignored");
  assert.deepEqual(x.calls, []);
});

test("a reload loop ends in recovery", async () => {
  const x = rig();
  for (let i = 0; i < MAX_RENDERER_RELOADS_IN_WINDOW; i++) assert.equal(await x.r.onGone({ reason: "killed" }), "reloaded");
  assert.equal(await x.r.onGone({ reason: "killed" }), "recovery");
});

test("GPU loss repaints live windows and skips destroyed ones", () => {
  let invalidated = 0;
  const live = { isDestroyed: () => false, webContents: { isDestroyed: () => false, invalidate: () => { invalidated++; } } };
  const dead = { isDestroyed: () => true, webContents: { invalidate: () => { throw new Error("no"); } } };
  repaintAfterGpuLoss([live, dead]);
  assert.equal(invalidated, 1);
});
