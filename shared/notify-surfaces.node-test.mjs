import test from "node:test";
import assert from "node:assert/strict";
import { notifySurfaceDefaults, normalizeNotifySurfaces, checkNotifySurfaceKey, validAccelerator, SURFACE_IDS } from "./notify-surfaces.mjs";

test("new defaults per OS", () => {
  const mac = notifySurfaceDefaults("new", "darwin"), win = notifySurfaceDefaults("new", "win32"), lin = notifySurfaceDefaults("new", "linux");
  assert.deepEqual([mac.surfaces.tray, mac.surfaces.pill], [false, true]);
  assert.deepEqual([win.surfaces.tray, win.surfaces.pill], [true, false]);
  assert.deepEqual([lin.surfaces.tray, lin.surfaces.pill], [true, false]);
  for (const d of [mac, win, lin]) { assert.equal(d.surfaces.bubble || d.surfaces.dock || d.surfaces.shortcut, false); assert.equal(d.notifyActions, true); assert.equal(d.chooser, "unseen"); assert.equal(d.receiptMinMinutes, 2); }
  assert.deepEqual(Object.keys(mac.surfaces), [...SURFACE_IDS]);
});
test("upgrade is exactly yesterday", () => {
  const u = notifySurfaceDefaults("upgrade", "darwin");
  assert.deepEqual(Object.entries(u.surfaces).filter(([, on]) => on).map(([id]) => id), ["notify", "receipt", "badge"]);
  assert.equal(u.notifyActions, false); assert.equal(u.quietSummary, false); assert.equal(u.badgeCount, "unread"); assert.equal(u.badgeMenu, false);
  assert.equal(u.receiptMinMinutes, 0); assert.equal(u.nudgeMinutes, 0); assert.equal(u.hideFullscreen, false); assert.equal(u.respectFocus, false);
  assert.equal(u.chooser, "done"); assert.deepEqual(u.asks, { backgroundApproval: true, longJob: true });
});
test("normalize: wrong version or junk is null, never throws", () => {
  for (const bad of [null, undefined, 5, "x", [], { v: 2 }, { v: "1" }, {}]) assert.equal(normalizeNotifySurfaces(bad, "linux"), null);
});
test("normalize: bad fields fall back to the origin default, good fields kept", () => {
  const out = normalizeNotifySurfaces({ v: 1, origin: "upgrade", surfaces: { notify: false, tray: "yes", bogus: true }, nudgeMinutes: 7, receiptMinMinutes: 5, shortcut: "nope", pinnedBotId: 4 }, "win32");
  assert.equal(out.origin, "upgrade"); assert.equal(out.surfaces.notify, false); assert.equal(out.surfaces.tray, false);
  assert.equal(out.nudgeMinutes, 0); assert.equal(out.receiptMinMinutes, 5); assert.equal(out.shortcut, null); assert.equal(out.pinnedBotId, null);
  assert.equal("bogus" in out.surfaces, false);
});
test("normalize: pill never on off Mac", () => {
  assert.equal(normalizeNotifySurfaces({ v: 1, origin: "new", surfaces: { pill: true } }, "win32").surfaces.pill, false);
  assert.equal(normalizeNotifySurfaces({ v: 1, origin: "new", surfaces: { pill: true } }, "darwin").surfaces.pill, true);
});
test("accelerator", () => {
  for (const ok of ["CommandOrControl+Shift+M", "Alt+F12", "Ctrl+Space", "Super+1"]) assert.equal(validAccelerator(ok), true, ok);
  for (const bad of ["", "M", "Shift", "Ctrl+", "+M", "Ctrl+Ctrl+M", "Ctrl+Foo", "Ctrl+M+K", " Ctrl+M", "Ctrl+F25", "Ctrl+Shift", 5, null, "Ctrl+" + "A".repeat(80)]) assert.equal(validAccelerator(bad), false, String(bad));
});
test("one key per set: unknown keys, wrong types and bad choices refused", () => {
  assert.deepEqual(checkNotifySurfaceKey("surfaces.pill", true), { ok: true, value: true });
  for (const [k, v] of [["surfaces.nope", true], ["surfaces.pill", 1], ["origin", "new"], ["v", 1], ["nudgeMinutes", 9], ["badgeCount", "all"], ["shortcut", "M"], ["asks.x", true], ["__proto__", {}], [5, 5]]) assert.equal(checkNotifySurfaceKey(k, v).ok, false, String(k));
});
