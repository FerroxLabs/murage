// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

import { createCloudLinkQueue } from "./cloud-link-queue.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ ready = false, live = false, loaded = false, probe } = {}) {
  const state = { ready, live, loaded };
  const handled = [], told = [];
  let probes = 0;
  const queue = createCloudLinkQueue({
    ready: () => state.ready, live: () => state.live, windowLoaded: () => state.loaded,
    handle: (link) => { handled.push(link); },
    probe: async () => { probes++; return probe ? probe(state) : false; },
    notLive: (link) => { told.push(link.kind); },
  });
  return { state, queue, handled, told, probes: () => probes };
}
const door = (n) => ({ kind: "door", url: `murage://door?n=${n}` });

test("queue: newer link replaces older", async () => {
  const h = harness();
  h.queue.enqueue(door(1));
  h.queue.enqueue({ kind: "connect-cloud", url: "murage://connect-cloud" });
  h.queue.enqueue(door(3));
  assert.equal(h.queue.pendingKind(), "door");
  Object.assign(h.state, { ready: true, live: true, loaded: true });
  h.queue.drain();
  await tick();
  assert.deepEqual(h.handled.map((link) => link.url), ["murage://door?n=3"]);
  h.queue.drain(); await tick();
  assert.equal(h.handled.length, 1, "a link is handled once");
});

test("queue: drains once after ready and window", async () => {
  const h = harness({ live: true });
  h.queue.enqueue(door(1)); // before ready (macOS open-url on a cold start, or argv at module load)
  await tick();
  assert.equal(h.handled.length, 0);
  assert.equal(h.probes(), 0, "nothing probes before ready");
  h.state.ready = true;
  h.queue.drain(); await tick(); // end of desktopStartup: the window has not loaded yet
  assert.equal(h.handled.length, 0);
  h.state.loaded = true;
  h.queue.drain(); h.queue.drain(); await tick(); // did-finish-load, twice
  assert.equal(h.handled.length, 1);
  assert.equal(h.queue.pendingKind(), null);
  // open-cloud and connect-cloud wait for the window too.
  h.state.loaded = false;
  h.queue.enqueue({ kind: "open-cloud", url: "murage://open-cloud?h=x" }); await tick();
  assert.equal(h.handled.length, 1);
  h.state.loaded = true; h.queue.drain(); await tick();
  assert.equal(h.handled.at(-1).kind, "open-cloud");
});

test("queue: drains on live flip", async () => {
  const h = harness({ ready: true, loaded: true, probe: () => false });
  h.queue.enqueue(door(1));
  await tick(); await tick();
  // Not live and the one probe said no: the person is told once and the link is dropped.
  assert.deepEqual(h.told, ["door"]);
  assert.equal(h.handled.length, 0);
  assert.equal(h.queue.pendingKind(), null);
  // The probe flips the gate: the queue drains in the same process.
  const g = harness({ ready: true, loaded: true, probe: (state) => { state.live = true; return true; } });
  g.queue.enqueue(door(2));
  await tick(); await tick(); await tick();
  assert.deepEqual(g.handled.map((link) => link.url), ["murage://door?n=2"]);
  assert.deepEqual(g.told, []);
  // A link that arrives before ready waits; the gate's onChange(true) drains it with no probe at all.
  const w = harness({ loaded: true });
  w.queue.enqueue(door(4));
  w.state.ready = true; w.state.live = true;
  w.queue.drain(); await tick();
  assert.equal(w.handled.length, 1);
  assert.equal(w.probes(), 0);
});

test("queue: one probe at a time; a link that arrives while probing replaces the waiting one", async () => {
  let release;
  const h = harness({ ready: true, loaded: true, probe: (state) => new Promise((resolve) => { release = () => { state.live = true; resolve(true); }; }) });
  h.queue.enqueue(door(1));
  await tick();
  h.queue.enqueue(door(2));
  await tick();
  assert.equal(h.probes(), 1);
  release();
  await tick(); await tick(); await tick();
  assert.deepEqual(h.handled.map((link) => link.url), ["murage://door?n=2"]);
});

test("queue: refuses what is not a link and never throws from a failing handler", async () => {
  const handled = [];
  const queue = createCloudLinkQueue({ ready: () => true, live: () => true, windowLoaded: () => true, handle: async (link) => { handled.push(link); throw new Error("boom"); } });
  assert.equal(queue.enqueue(null), false);
  assert.equal(queue.enqueue({ url: "murage://door" }), false);
  assert.equal(queue.enqueue(door(1)), true);
  await tick(); await tick();
  assert.equal(handled.length, 1);
});
