// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { createGlobalShortcut, enableGlobalShortcutPortal, globalShortcutPortalAvailable, SHORTCUT_PORTAL_REASON } from "./global-shortcut.mjs";

function fixture(options = {}) {
  const calls = [], keys = new Map(), presses = [];
  let time = 0, refuse = false, throws = false;
  const globalShortcut = {
    register(key, cb) {
      calls.push(["register", key]);
      if (throws) throw Error("registration");
      if (refuse) return false;
      keys.set(key, cb); return true;
    },
    unregister(key) { calls.push(["unregister", key]); keys.delete(key); },
  };
  const owner = createGlobalShortcut({ globalShortcut, platform: "win32", now: () => time,
    onTrigger: (...args) => presses.push(args), ...options });
  return { owner, calls, keys, presses, setTime: value => { time = value; },
    refuse: () => { refuse = true; }, throws: () => { throws = true; } };
}

test("no key by default registers nothing", () => {
  const f = fixture();
  assert.deepEqual(f.owner.sync(null), { ok: true, active: false });
  assert.deepEqual(f.calls, []);
  assert.equal(f.owner.status().accelerator, null);
});
for (const failure of ["refuse", "throws"]) test(`${failure}: taken replacement keeps the old key and caller stores nothing`, () => {
  const f = fixture();
  let stored = "Control+A";
  f.owner.sync(stored); f[failure]();
  const result = f.owner.trySet("Control+B");
  if (result.ok) stored = "Control+B";
  assert.deepEqual(result, { ok: false, reason: "taken" });
  assert.equal(stored, "Control+A");
  assert.deepEqual([...f.keys.keys()], ["Control+A"]);
  f.keys.get(stored)(); assert.deepEqual(f.presses, [[]]);
});
test("success registers new before releasing old; identical sync is idempotent; clear and dispose release", () => {
  const f = fixture();
  f.owner.sync("Control+A"); const stale = f.keys.get("Control+A");
  assert.deepEqual(f.owner.trySet("Control+A"), { ok: true });
  assert.deepEqual(f.owner.sync("Control+B"), { ok: true, active: true });
  assert.deepEqual(f.calls, [["register", "Control+A"], ["register", "Control+B"], ["unregister", "Control+A"]]);
  stale(); assert.deepEqual(f.presses, []);
  f.owner.sync(null); assert.equal(f.keys.size, 0);
  f.owner.sync("Alt+F2"); const last = f.keys.get("Alt+F2");
  f.owner.dispose(); f.owner.dispose(); last();
  assert.equal(f.keys.size, 0); assert.deepEqual(f.presses, []);
  assert.equal(f.calls.filter(([action, key]) => action === "unregister" && key === "Alt+F2").length, 1);
  assert.deepEqual(f.owner.trySet("Control+C"), { ok: false, reason: "unsupported" });
});
test("invalid accelerators never reach registration", () => {
  const f = fixture();
  for (const key of [null, "", "A", "Control", "Control+Alt", "Control+A+B", "Control++", "Control+Control+A", {}]) {
    assert.deepEqual(f.owner.trySet(key), { ok: false, reason: "invalid" });
  }
  assert.deepEqual(f.calls, []);
});
test("Wayland without a confirmed portal refuses and explains, including probe exceptions", () => {
  for (const portal of [undefined, { available: () => false }, { available: () => { throw Error(); } }]) {
    const f = fixture({ platform: "linux", isWayland: () => true, portal });
    assert.deepEqual(f.owner.sync("Control+A"), { ok: false, active: false, reason: "unsupported" });
    assert.equal(f.owner.status().disabledReason, SHORTCUT_PORTAL_REASON);
    assert.deepEqual(f.calls, []);
  }
});
test("Wayland uses only the portal and releases each registration", () => {
  const calls = [], callbacks = [];
  const f = fixture({ platform: "linux", isWayland: () => true, portal: {
    available: () => true,
    register: (key, cb) => { calls.push(["register", key]); callbacks.push(cb); return () => calls.push(["unregister", key]); },
  } });
  f.owner.sync("Super+A"); callbacks[0]();
  assert.deepEqual(f.presses, [[]]);
  f.owner.trySet("Super+B"); f.owner.dispose();
  assert.deepEqual(calls, [["register", "Super+A"], ["register", "Super+B"], ["unregister", "Super+A"], ["unregister", "Super+B"]]);
  assert.deepEqual(f.calls, []);
});
test("a portal registration exception retains the active key", () => {
  let fail = false, removed = 0;
  const f = fixture({ platform: "linux", isWayland: () => true, portal: {
    available: () => true, register: () => { if (fail) throw Error(); return () => removed++; },
  } });
  f.owner.trySet("Super+A"); fail = true;
  assert.deepEqual(f.owner.trySet("Super+B"), { ok: false, reason: "taken" });
  assert.equal(f.owner.status().accelerator, "Super+A"); assert.equal(removed, 0);
});
test("presses inside 250 ms are ignored, with no arguments forwarded", () => {
  const f = fixture(); f.owner.sync("Control+A"); const press = f.keys.get("Control+A");
  press("native-event"); f.setTime(249); press();
  assert.deepEqual(f.presses, [[]]);
  f.setTime(250); press(); assert.deepEqual(f.presses, [[], []]);
});
test("portal feature switch preserves existing features and is idempotent", () => {
  let value = "OtherFeature", changes = 0;
  const commandLine = { getSwitchValue: () => value, appendSwitch: (name, next) => {
    assert.equal(name, "enable-features"); value = next; changes++;
  } };
  enableGlobalShortcutPortal(commandLine); enableGlobalShortcutPortal(commandLine);
  assert.equal(value, "OtherFeature,GlobalShortcutsPortal"); assert.equal(changes, 1);
});
test("bounded portal probe accepts a version and refuses absent or unreadable interfaces", async () => {
  for (const [error, stdout, expected] of [[null, "(<uint32 1>,)", true], [null, "(<uint32 0>,)", false], [null, "unknown", false], [Error(), "(<uint32 1>,)", false]]) {
    let calls = 0;
    assert.equal(await globalShortcutPortalAvailable((file, args, options, cb) => {
      calls++; assert.equal(file, "/usr/bin/gdbus");
      assert.ok(args.includes("org.freedesktop.portal.GlobalShortcuts"));
      assert.equal(options.timeout, 1500); cb(error, stdout);
    }), expected);
    assert.equal(calls, 1);
  }
  assert.equal(await globalShortcutPortalAvailable(() => { throw Error(); }), false);
});
