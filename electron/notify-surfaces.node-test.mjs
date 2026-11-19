import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync, writeFileSync, readFileSync, symlinkSync, statSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotifySurfaces, NOTIFY_SURFACES_FILE } from "./notify-surfaces.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const dirs = [];
const fixture = (files = {}) => { const d = mkdtempSync(join(tmpdir(), "ns-")); dirs.push(d); for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c); return d; };
test.after(() => { for (const d of dirs) safeWipeSync(d); });
const file = d => join(d, NOTIFY_SURFACES_FILE);

test("fresh profile is new, and the file is written at once", () => {
  const d = fixture(); const ns = createNotifySurfaces({ profileDir: d, platform: "darwin" });
  assert.equal(ns.get().origin, "new"); assert.equal(ns.get().chooser, "unseen");
  assert.equal(JSON.parse(readFileSync(file(d), "utf8")).origin, "new");
  if (process.platform !== "win32") assert.equal(statSync(file(d)).mode & 0o777, 0o600); // Windows has no POSIX mode bits (stat reports 0o666); owner-only is a POSIX property
});
test("a store file means upgrade, and it stays upgrade after the server has made the store", () => {
  const d = fixture({ "messages.db": "x" }); const ns = createNotifySurfaces({ profileDir: d, platform: "win32" });
  assert.equal(ns.get().origin, "upgrade"); assert.equal(ns.get().chooser, "done");
});
test("only startup-background.json is also an upgrade", () => {
  assert.equal(createNotifySurfaces({ profileDir: fixture({ "startup-background.json": "{}" }), platform: "linux" }).get().origin, "upgrade");
});
test("unfinished first run with a store file is an upgrade", () => {
  const d = fixture({ "messages.db": "" }); assert.equal(createNotifySurfaces({ profileDir: d, platform: "darwin" }).get().origin, "upgrade");
});
test("origin never changes once written: new stays new after the server makes messages.db", () => {
  const d = fixture(); createNotifySurfaces({ profileDir: d, platform: "linux" });
  writeFileSync(join(d, "messages.db"), "x");
  assert.equal(createNotifySurfaces({ profileDir: d, platform: "linux" }).get().origin, "new");
});
test("corrupt file: origin-correct defaults, no throw, file repaired", () => {
  const d = fixture({ "messages.db": "x", [NOTIFY_SURFACES_FILE]: "{not json" });
  const ns = createNotifySurfaces({ profileDir: d, platform: "linux" });
  assert.equal(ns.get().origin, "upgrade"); assert.equal(JSON.parse(readFileSync(file(d), "utf8")).v, 1);
});
test("oversized file: defaults, left alone", () => {
  const big = JSON.stringify({ v: 1, origin: "new", pad: "x".repeat(9000) });
  const d = fixture({ [NOTIFY_SURFACES_FILE]: big }); const ns = createNotifySurfaces({ profileDir: d, platform: "linux" });
  assert.equal(ns.get().origin, "new"); assert.equal(readFileSync(file(d), "utf8"), big);
});
test("symlinked file: never read, never written through", () => {
  const d = fixture(); const target = join(fixture(), "t.json"); writeFileSync(target, JSON.stringify({ v: 1, origin: "upgrade" }));
  symlinkSync(target, file(d));
  const ns = createNotifySurfaces({ profileDir: d, platform: "linux" });
  assert.equal(ns.get().origin, "new");
  assert.doesNotThrow(() => { try { ns.set("surfaces.tray", false); } catch { /* write refused is fine */ } });
  assert.equal(JSON.parse(readFileSync(target, "utf8")).origin, "upgrade");
});
test("wrong-version file: defaults in memory, file untouched", () => {
  const c = JSON.stringify({ v: 2, origin: "upgrade" }); const d = fixture({ [NOTIFY_SURFACES_FILE]: c });
  assert.equal(createNotifySurfaces({ profileDir: d, platform: "linux" }).get().origin, "new"); assert.equal(readFileSync(file(d), "utf8"), c);
});
test("valid file wins over disk markers", () => {
  const d = fixture({ "messages.db": "x" }); createNotifySurfaces({ profileDir: d, platform: "darwin" });
  const f = JSON.parse(readFileSync(file(d), "utf8")); f.origin = "new"; f.surfaces.tray = true; writeFileSync(file(d), JSON.stringify(f));
  const ns = createNotifySurfaces({ profileDir: d, platform: "darwin" }); assert.equal(ns.get().origin, "new"); assert.equal(ns.get().surfaces.tray, true);
});
test("atomic write leaves no temp file, one key per set", () => {
  const d = fixture(); const ns = createNotifySurfaces({ profileDir: d, platform: "darwin" });
  const after = ns.set("surfaces.bubble", true); assert.equal(after.surfaces.bubble, true); assert.equal(after.surfaces.dock, false);
  assert.deepEqual(readdirSync(d).filter(n => n.endsWith(".tmp")), []);
  assert.equal(JSON.parse(readFileSync(file(d), "utf8")).surfaces.bubble, true);
});
test("invalid key, value or accelerator refused and nothing stored", () => {
  const d = fixture(); const ns = createNotifySurfaces({ profileDir: d, platform: "darwin" }); const before = readFileSync(file(d), "utf8");
  for (const [k, v] of [["shortcut", "M"], ["shortcut", "Ctrl+Shift"], ["nudgeMinutes", 3], ["surfaces.x", true], ["origin", "upgrade"]]) assert.throws(() => ns.set(k, v), TypeError);
  assert.equal(readFileSync(file(d), "utf8"), before); assert.equal(ns.set("shortcut", "CommandOrControl+Shift+M").shortcut, "CommandOrControl+Shift+M");
});
test("pill cannot be turned on off Mac", () => {
  const ns = createNotifySurfaces({ profileDir: fixture(), platform: "win32" }); assert.throws(() => ns.set("surfaces.pill", true), TypeError);
});
test("failed write keeps memory unchanged", () => {
  const d = fixture(); createNotifySurfaces({ profileDir: d, platform: "linux" });
  const failing = createNotifySurfaces({ profileDir: d, platform: "linux", fs: { ...requireFs(), renameSync() { throw new Error("disk"); } } });
  assert.throws(() => failing.set("surfaces.tray", false)); assert.equal(failing.get().surfaces.tray, true);
});
test("no owned profile: new, in memory, set works without a file", () => {
  const ns = createNotifySurfaces({ profileDir: null, platform: "darwin" });
  assert.equal(ns.get().origin, "new"); assert.equal(ns.persisted, false); assert.equal(ns.set("chooser", "done").chooser, "done");
});
test("reset gives new-install defaults, keeps origin and chooser", () => {
  const d = fixture({ "messages.db": "x" }); const ns = createNotifySurfaces({ profileDir: d, platform: "darwin" });
  const r = ns.reset(); assert.equal(r.origin, "upgrade"); assert.equal(r.chooser, "done"); assert.equal(r.notifyActions, true); assert.equal(r.surfaces.pill, true);
});
import nodeFs from "node:fs";
function requireFs() { return nodeFs; }

// A3 (design section 13): installation origin lives in its own durable marker, written once and never rewritten.
const markerFile = d => join(d, "notify-origin.json");
test("A3: a fresh profile writes the origin marker once, owner-only", () => {
  const d = fixture(); createNotifySurfaces({ profileDir: d, platform: "linux" });
  assert.deepEqual(JSON.parse(readFileSync(markerFile(d), "utf8")), { v: 1, origin: "new" });
  if (process.platform !== "win32") assert.equal(statSync(markerFile(d)).mode & 0o777, 0o600); // Windows has no POSIX mode bits
});
test("A3: a new install whose preferences file is corrupted later is still new, even after the server made messages.db", () => {
  const d = fixture(); createNotifySurfaces({ profileDir: d, platform: "linux" });
  writeFileSync(join(d, "messages.db"), "x"); writeFileSync(file(d), "{not json");
  const ns = createNotifySurfaces({ profileDir: d, platform: "linux" });
  assert.equal(ns.get().origin, "new"); assert.equal(ns.get().chooser, "unseen");
});
test("A3: the same holds when the preferences file is deleted", () => {
  const d = fixture(); createNotifySurfaces({ profileDir: d, platform: "darwin" });
  writeFileSync(join(d, "messages.db"), "x"); rmSync(file(d));
  assert.equal(createNotifySurfaces({ profileDir: d, platform: "darwin" }).get().origin, "new");
});
test("A3: an upgrade marker keeps an upgrade even with no store file left", () => {
  const d = fixture({ "messages.db": "x" }); createNotifySurfaces({ profileDir: d, platform: "linux" });
  rmSync(join(d, "messages.db")); rmSync(file(d));
  assert.equal(createNotifySurfaces({ profileDir: d, platform: "linux" }).get().origin, "upgrade");
});
test("A3: an unreadable marker (corrupt, symlinked, oversized, wrong version) falls back to conservative upgrade defaults", () => {
  for (const make of [d => writeFileSync(markerFile(d), "{nope"), d => symlinkSync(join(d, "elsewhere"), markerFile(d)), d => writeFileSync(markerFile(d), "x".repeat(9000)), d => writeFileSync(markerFile(d), JSON.stringify({ v: 9, origin: "new" })), d => writeFileSync(markerFile(d), JSON.stringify({ v: 1, origin: "maybe" }))]) {
    const d = fixture(); make(d);
    const ns = createNotifySurfaces({ profileDir: d, platform: "linux" });
    assert.equal(ns.get().origin, "upgrade"); assert.equal(ns.get().chooser, "done"); assert.equal(ns.get().notifyActions, false);
  }
});
test("A3: a symlinked marker is never written through", () => {
  const d = fixture({ target: "keep" }); symlinkSync(join(d, "target"), markerFile(d));
  createNotifySurfaces({ profileDir: d, platform: "linux" });
  assert.equal(readFileSync(join(d, "target"), "utf8"), "keep");
});
test("A3: a profile from the first S2 build (file, no marker) gets its marker from the state, and the marker is never rewritten", () => {
  const d = fixture(); createNotifySurfaces({ profileDir: d, platform: "linux" }); rmSync(markerFile(d));
  createNotifySurfaces({ profileDir: d, platform: "linux" });
  assert.equal(JSON.parse(readFileSync(markerFile(d), "utf8")).origin, "new");
  writeFileSync(markerFile(d), JSON.stringify({ v: 1, origin: "upgrade" }));
  createNotifySurfaces({ profileDir: d, platform: "linux" });
  assert.equal(JSON.parse(readFileSync(markerFile(d), "utf8")).origin, "upgrade");
});

test("A3: only a missing marker counts as missing; any other failure to look at it is unreadable and nothing is written", () => {
  const d = fixture(); const failing = { ...nodeFs, lstatSync: p => { if (String(p).endsWith("notify-origin.json")) { const e = new Error("denied"); e.code = "EACCES"; throw e; } return nodeFs.lstatSync(p); } };
  const ns = createNotifySurfaces({ profileDir: d, platform: "linux", fs: failing });
  assert.equal(ns.get().origin, "upgrade"); assert.equal(existsSync(join(d, "notify-origin.json")), false);
});
