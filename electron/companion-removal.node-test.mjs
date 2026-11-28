// P3 (settings v10): the removal status the renderer gets through the bridge, with per-step fields and `uncertain`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { controlOutcomeUncertain, removalStatusOf } from "./companion-removal.mjs";

test("a recorded removal keeps its overall state, notifications step and id, and is not uncertain", () => {
  assert.deepEqual(removalStatusOf({ state: "pending", notifications: "harness-queued", removalId: "rm-1" }),
    { state: "pending", notifications: "harness-queued", removalId: "rm-1", uncertain: false });
  assert.deepEqual(removalStatusOf({ state: "removed", notifications: "confirmed" }), { state: "removed", notifications: "confirmed", uncertain: false });
});

test("a timeout or a dropped reply is uncertain, never Removed", () => {
  assert.equal(controlOutcomeUncertain(Object.assign(new Error("timed out"), { name: "TimeoutError" })), true);
  assert.equal(controlOutcomeUncertain(Object.assign(new Error("companion control 500"), { status: 500 })), false);
  const status = removalStatusOf(null, { uncertain: true });
  assert.equal(status.uncertain, true);
  assert.notEqual(status.state, "removed");
});

test("nothing recorded is unknown and uncertain; a foreign value is never trusted", () => {
  assert.deepEqual(removalStatusOf(null), { state: "unknown", notifications: "unknown", uncertain: true });
  assert.deepEqual(removalStatusOf({ state: "removed!", notifications: "x", removalId: "../x" }), { state: "unknown", notifications: "unknown", uncertain: true });
});

test("the bridge exposes revoke and removalStatus only through the preload and the main handlers", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), /removalStatus: \(deviceId\) => ipcRenderer\.invoke\("companion:removal-status", deviceId\)/);
  assert.match(readFileSync(new URL("./main.mjs", import.meta.url), "utf8"), /ipcMain\.handle\("companion:removal-status", \(_event, deviceId\) => companionRemovalStatus\(deviceId\)\)/);
});
