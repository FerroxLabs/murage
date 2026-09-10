import assert from "node:assert/strict";
import test from "node:test";
import { createInstallationRecoveryController } from "./installation-recovery-controller.mjs";

function fixture(overrides = {}) {
  const event = {}, calls = [];
  const host = { isTrustedSender: value => value === event, isAvailable: () => true,
    chooseBackup: async () => ({ path: "/operator/selected.zip", name: "Selected backup" }),
    chooseDestination: async () => "/operator/new.zip", confirm: async () => true,
    run: async (operation, options) => { calls.push({ operation, options }); return { ok: true, operation, sha256: "a".repeat(64), snapshotId: "snapshot", activationAvailable: false }; },
    retry: async () => {}, openDiagnostics: async () => {}, ...overrides };
  return { event, calls, host, controller: createInstallationRecoveryController(host) };
}
test("rejects foreign frames and renderer-supplied paths before any host action", async () => {
  const f = fixture();
  await assert.rejects(f.controller.handle({}, { action: "backup" }), /UNTRUSTED/);
  await assert.rejects(f.controller.handle(f.event, { action: "restore", archive: "/arbitrary" }), /INVALID_RECOVERY_REQUEST/);
  assert.equal(f.calls.length, 0);
});
test("binds native confirmation to the main-owned selection and inspected hash", async () => {
  const f = fixture();
  const state = await f.controller.handle(f.event, { action: "choose-backup" });
  assert.equal(state.selection.path, undefined);
  assert.equal(state.busy, false);
  assert.equal((await f.controller.handle(f.event, { action: "restore", selectionId: "forged" })).error, "RECOVERY_SELECTION_EXPIRED");
  await f.controller.handle(f.event, { action: "restore", selectionId: state.selection.id });
  assert.deepEqual(f.calls[1], { operation: "restore", options: { archive: "/operator/selected.zip", sha256: "a".repeat(64) } });
  assert.equal((await f.controller.handle(f.event, { action: "restore", selectionId: state.selection.id })).error, "RECOVERY_SELECTION_EXPIRED");
});
test("navigation while a native dialog is open prevents subsequent work", async () => {
  let trusted = true;
  const f = fixture({ isTrustedSender: () => trusted, chooseBackup: async () => { trusted = false; return { path: "/selected", name: "Selected" }; } });
  const result = await f.controller.handle(f.event, { action: "choose-backup" });
  assert.equal(result.error, "UNTRUSTED_RECOVERY_SENDER");
  assert.equal(f.calls.length, 0);
});
test("confirmation cancellation leaves installation untouched", async () => {
  const f = fixture({ confirm: async () => false });
  const state = await f.controller.handle(f.event, { action: "choose-backup" });
  await f.controller.handle(f.event, { action: "restore", selectionId: state.selection.id });
  await f.controller.handle(f.event, { action: "rollback" });
  assert.equal(f.calls.length, 1);
});
test("single flight covers dialogs as well as worker execution", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture({ chooseDestination: () => waiting });
  const first = f.controller.handle(f.event, { action: "backup" });
  assert.equal((await f.controller.handle(f.event, { action: "rollback" })).error, "RECOVERY_BUSY");
  release(null); await first;
  assert.equal((await f.controller.handle(f.event, { action: "state" })).busy, false);
});
test("missing ownership fails closed and diagnostic errors never expose arbitrary details", async () => {
  const f = fixture({ isAvailable: () => false, openDiagnostics: async () => { throw new Error("private-content-canary"); } });
  assert.equal((await f.controller.handle(f.event, { action: "backup" })).error, "RECOVERY_OWNERSHIP_REQUIRED");
  assert.equal((await f.controller.handle(f.event, { action: "diagnostics" })).error, "RECOVERY_OPERATION_FAILED");
  assert.equal(f.calls.length, 0);
});
test("ownership lost while selecting a destination prevents backup", async () => {
  let available = true;
  const f = fixture({ isAvailable: () => available, chooseDestination: async () => { available = false; return "/selected"; } });
  assert.equal((await f.controller.handle(f.event, { action: "backup" })).error, "RECOVERY_OWNERSHIP_REQUIRED");
  assert.equal(f.calls.length, 0);
});
test("an uppercase private error message is not mistaken for a public error code", async () => {
  const f = fixture({ openDiagnostics: async () => { throw new Error("PRIVATESECRET123"); } });
  assert.equal((await f.controller.handle(f.event, { action: "diagnostics" })).error, "RECOVERY_OPERATION_FAILED");
});
test("separate recovery binds archive and destination without granting original ownership", async () => {
  const plan = { dataDirectory: "/new-owned/data", originalRoot: "/foreign/original" };
  const calls = [];
  const f = fixture({ isAvailable: () => false, canRestoreSeparate: () => true, planSeparate: () => plan,
    confirm: async (_event, action, name, destination) => { calls.push({ action, name, destination }); return true; },
    runSeparate: async (parameters, selected) => { assert.equal(selected, plan); calls.push(parameters); return { ok: true }; }, retry: async () => calls.push("retry") });
  for (const action of ["backup", "restore", "rollback", "activate", "review-installation", "choose-backup"]) assert.equal((await f.controller.handle(f.event, { action })).error, "RECOVERY_OWNERSHIP_REQUIRED");
  const selected = await f.controller.handle(f.event, { action: "choose-separate-backup" });
  assert.equal(selected.selection.destination, plan.dataDirectory);
  assert.equal(selected.selection.path, undefined);
  await assert.rejects(f.controller.handle(f.event, { action: "restore-separate", selectionId: selected.selection.id, destination: "/forged" }), /INVALID_RECOVERY_REQUEST/);
  assert.equal((await f.controller.handle(f.event, { action: "restore-separate", selectionId: "expired" })).error, "RECOVERY_SELECTION_EXPIRED");
  await f.controller.handle(f.event, { action: "restore-separate", selectionId: selected.selection.id });
  assert.deepEqual(calls, [{ action: "restore-separate", name: "Selected backup", destination: "/new-owned/data" }, { archive: "/operator/selected.zip", sha256: "a".repeat(64) }, "retry"]);
});
test("separate confirmation cancellation and changed capability never dispatch restore", async () => {
  let allowed = true, confirm = false, restored = 0;
  const f = fixture({ isAvailable: () => false, canRestoreSeparate: () => allowed, planSeparate: () => ({ dataDirectory: "/new/data" }),
    confirm: async () => { if (confirm) allowed = false; return confirm; }, runSeparate: async () => { restored++; } });
  const selected = await f.controller.handle(f.event, { action: "choose-separate-backup" });
  await f.controller.handle(f.event, { action: "restore-separate", selectionId: selected.selection.id });
  assert.equal(restored, 0);
  confirm = true;
  assert.equal((await f.controller.handle(f.event, { action: "restore-separate", selectionId: selected.selection.id })).error, "RECOVERY_OWNERSHIP_REQUIRED");
  assert.equal(restored, 0);
});
test("pathless snapshot action requires native confirmation and a paused restored result", async () => {
  const calls = [];
  const f = fixture({ isAvailable: () => false, canRestoreSeparate: () => true, canCaptureSeparate: () => true,
    runCaptureSeparate: async confirm => { calls.push("prepare"); assert.equal(await confirm({ destination: "/private/copy", installation: "/new/data" }), true); calls.push("capture-restore"); return { ok: true, status: "restored-review-required", activationAvailable: false }; },
    confirm: async (_event, action, _name, destination, installation) => { assert.equal(action, "capture-separate"); assert.equal(destination, "/private/copy"); assert.equal(installation, "/new/data"); calls.push("confirm"); return true; },
    retry: async () => calls.push("restart") });
  await assert.rejects(f.controller.handle(f.event, { action: "capture-separate", source: "/forged" }), /INVALID_RECOVERY_REQUEST/);
  assert.equal((await f.controller.handle(f.event, { action: "state" })).captureAvailable, true);
  assert.equal((await f.controller.handle(f.event, { action: "capture-separate" })).error, null);
  assert.deepEqual(calls, ["prepare", "confirm", "capture-restore", "restart"]);
});
test("snapshot confirmation cannot survive navigation or publish an incomplete result", async () => {
  let trusted = true, restarted = false;
  const f = fixture({ isTrustedSender: () => trusted, isAvailable: () => false, canRestoreSeparate: () => true, canCaptureSeparate: () => true,
    runCaptureSeparate: async confirm => { await confirm({ destination: "/private", installation: "/new" }); return { status: "copied", activationAvailable: false }; },
    confirm: async () => { trusted = false; return true; }, retry: async () => { restarted = true; } });
  assert.equal((await f.controller.handle(f.event, { action: "capture-separate" })).error, "UNTRUSTED_RECOVERY_SENDER"); assert.equal(restarted, false);
});
