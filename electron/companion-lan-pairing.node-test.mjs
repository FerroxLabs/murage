// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

import { lanBindEnvironment, lanPairingView } from "./companion-lan-pairing.mjs";

test("the local network is only ever an explicit choice", () => {
  assert.equal(lanBindEnvironment({}, null), undefined);
  assert.equal(lanBindEnvironment({}, false), undefined);
  assert.equal(lanBindEnvironment({}, true), "lan");
});

test("an operator's own MURAGE_COMPANION_BIND always wins over the Settings choice", () => {
  assert.equal(lanBindEnvironment({ MURAGE_COMPANION_BIND: "loopback" }, true), undefined);
  assert.equal(lanBindEnvironment({ MURAGE_COMPANION_BIND: "  " }, true), "lan");
});

test("an install that never chose, with phones paired and the door narrowed, gets the note once", () => {
  const door = { mode: "loopback" };
  assert.deepEqual(lanPairingView({ setting: null, deviceDoor: door, deviceCount: 2 }), { on: false, chosen: false, mode: "loopback", unencrypted: false, note: "narrowed" });
  assert.equal(lanPairingView({ setting: null, deviceDoor: { mode: "tailnet" }, deviceCount: 1 }).note, "narrowed");
});

test("no note without phones, before the sidecar has said where it is, or once the person chose", () => {
  assert.equal(lanPairingView({ setting: null, deviceDoor: { mode: "loopback" }, deviceCount: 0 }).note, null);
  assert.equal(lanPairingView({ setting: null, deviceDoor: undefined, deviceCount: 3 }).note, null);
  assert.equal(lanPairingView({ setting: false, deviceDoor: { mode: "loopback" }, deviceCount: 3 }).note, null);
  assert.equal(lanPairingView({ setting: true, deviceDoor: { mode: "lan" }, deviceCount: 3 }).note, null);
});

test("on and unencrypted follow the choice and the door", () => {
  assert.deepEqual(lanPairingView({ setting: true, deviceDoor: { mode: "lan" }, deviceCount: 0 }), { on: true, chosen: true, mode: "lan", unencrypted: true, note: null });
  assert.equal(lanPairingView({ setting: false, deviceDoor: { mode: "tailnet" }, deviceCount: 0 }).on, false);
  assert.equal(lanPairingView({ setting: null, deviceDoor: { mode: "lan" }, deviceCount: 0 }).on, true);
});
