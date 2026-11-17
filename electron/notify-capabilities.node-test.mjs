import test from "node:test";
import assert from "node:assert/strict";
import { notifyCapabilities, linuxSessionType } from "./notify-capabilities.mjs";

test("session type", () => {
  assert.equal(linuxSessionType({ XDG_SESSION_TYPE: "wayland" }), "wayland");
  assert.equal(linuxSessionType({ DISPLAY: ":0" }), "x11");
  assert.equal(linuxSessionType({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "w0" }), "wayland");
  assert.equal(linuxSessionType({}), null);
});
test("pill is Mac only", () => {
  assert.equal(notifyCapabilities({ platform: "darwin" }).surfaces.pill.available, true);
  for (const p of ["win32", "linux"]) assert.deepEqual(notifyCapabilities({ platform: p }).surfaces.pill, { available: false, reason: "mac-only" });
});
test("bubble and dock: Linux X11 only, Wayland refused with its reason", () => {
  const w = notifyCapabilities({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } }).surfaces;
  assert.deepEqual(w.bubble, { available: false, reason: "wayland" }); assert.equal(w.dock.available, false);
  assert.equal(notifyCapabilities({ platform: "linux", env: { XDG_SESSION_TYPE: "x11" } }).surfaces.bubble.available, true);
  assert.equal(notifyCapabilities({ platform: "linux", env: {} }).surfaces.dock.reason, "no-session");
  for (const p of ["darwin", "win32"]) assert.equal(notifyCapabilities({ platform: p }).surfaces.bubble.available, true);
});
test("Linux tray host and Wayland shortcut portal notes", () => {
  assert.equal(notifyCapabilities({ platform: "linux", trayHost: false }).surfaces.tray.reason, "no-tray-host");
  assert.equal(notifyCapabilities({ platform: "linux", trayHost: true }).surfaces.tray.reason, undefined);
  assert.equal(notifyCapabilities({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } }).surfaces.shortcut.reason, "portal-needed");
});
