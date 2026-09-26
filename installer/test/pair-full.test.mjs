// 0.1.60 audit M3: `murage pair` on a headless box whose fleet is at
// MAX_DEVICES. The phone is refused ("replace an old one on your computer"),
// while the CLI used to wait out the whole window and report only "expired",
// with no command to remove a device. Now it says so at once, names the
// devices and the command, and keeps waiting so the same code works once a
// device is removed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fullFleet, removeDevice, watchPairing } from "../lib/pair.mjs";

const token = `murage_pair_${"a".repeat(43)}`;
const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, name: `Phone ${i}`, createdAt: 1, lastSeenAt: 1 + i }));
const clockFrom = start => { let clock = start; return { now: () => clock, sleep: async () => { clock += 2_000; } }; };

test("a full fleet is reported to the headless owner at once, and the window that expires full says full", async () => {
  const clock = clockFrom(1_000);
  const send = async () => ({ status: 200, body: { pairing: { token, code: "123456", expiresAt: 5_000 }, devices: candidates, maxDevices: 20, replaceCandidates: candidates } });
  const told = [];
  const result = await watchPairing({ port: 1, token, expiresAt: 5_000, openedAt: 1_000, send, onFull: d => told.push(d), intervalMs: 1, ...clock });
  assert.equal(result.outcome, "full");
  assert.deepEqual(result.devices.map(d => d.id), candidates.map(d => d.id));
  assert.equal(told.length, 1, "said once, not on every poll");
  assert.deepEqual(told[0][0], { id: "d0", name: "Phone 0", lastSeenAt: 1 });
});

test("removing a device while the window is open lets the same code pair", async () => {
  const clock = clockFrom(1_000);
  let polls = 0;
  const send = async () => {
    polls++;
    if (polls < 3) return { status: 200, body: { pairing: { token, code: "123456", expiresAt: 60_000 }, devices: candidates, maxDevices: 20, replaceCandidates: candidates } };
    // `murage devices remove d0` ran; the phone retried the same code.
    return { status: 200, body: { pairing: null, devices: [...candidates.slice(1), { id: "new", name: "Sam's phone", createdAt: 5_000, lastSeenAt: 5_000 }], maxDevices: 20, replaceCandidates: [] } };
  };
  const result = await watchPairing({ port: 1, token, expiresAt: 60_000, openedAt: 1_000, send, intervalMs: 1, ...clock });
  assert.deepEqual(result, { outcome: "paired", device: "Sam's phone" });
});

test("a fleet below the limit still expires as expired", async () => {
  const clock = clockFrom(1_000);
  const send = async () => ({ status: 200, body: { pairing: { token, code: "123456", expiresAt: 5_000 }, devices: candidates.slice(0, 3), maxDevices: 20, replaceCandidates: [] } });
  const told = [];
  assert.equal((await watchPairing({ port: 1, token, expiresAt: 5_000, openedAt: 1_000, send, onFull: d => told.push(d), intervalMs: 1, ...clock })).outcome, "expired");
  assert.equal(told.length, 0);
});

test("fullFleet keeps only well-formed ids; removeDevice uses the control page's revoke and words its answers", async () => {
  assert.deepEqual(fullFleet({ replaceCandidates: [{ id: "ok-1", name: "", lastSeenAt: 5 }, { id: "../x" }, null] }), [{ id: "ok-1", name: "a device", lastSeenAt: 5 }]);
  assert.deepEqual(fullFleet(null), []);
  const calls = [];
  const send = status => async (port, method, path) => { calls.push([method, path]); return { status, body: {} }; };
  assert.deepEqual(await removeDevice({ port: 1, id: "d0", send: send(200) }), { ok: true });
  assert.deepEqual(calls, [["DELETE", "/devices/d0"]]);
  assert.match((await removeDevice({ port: 1, id: "nope", send: send(404) })).reason, /no paired device has that id/);
  assert.match((await removeDevice({ port: 1, id: "d0", send: send(500) })).reason, /could not remove/);
  assert.equal((await removeDevice({ port: 1, id: "../etc", send: async () => assert.fail("never sent") })).ok, false);
  assert.match((await removeDevice({ port: 1, id: "d0", send: async () => { throw Error("ECONNREFUSED"); } })).reason, /nothing answered/);
});
