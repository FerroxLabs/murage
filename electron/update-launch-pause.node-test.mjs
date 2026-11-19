// fablehunt-1020q item 9: the OS jobs that start the Murage executable on a
// timer (macOS closed-app backup LaunchAgent, Windows Sentinel task) are taken
// down before quitAndInstall and put back after a failed install or at the
// next start. Real coordinator, real pause module; only launchctl/schtasks are
// recorded instead of run (this host has neither).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { createUpdateLaunchPause } from "./update-launch-pause.mjs";

const LABEL = `com.murage.backup.${"a".repeat(64)}`;
const TASK = `\\FerroxLabs\\Murage\\Sentinel\\${"b".repeat(32)}`;
// The pause refuses uid 0 (Murage never runs as root on a Mac); as root, the
// fixture files belong to an ordinary account instead.
const uid = process.getuid() === 0 ? 501 : process.getuid();
const own = file => { if (process.getuid() === 0) chownSync(file, uid, uid); };

function macHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "launch-pause-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agents = path.join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(agents, `${LABEL}.plist`), "<plist/>", { mode: 0o600 });
  own(path.join(agents, `${LABEL}.plist`));
  // Neither of these is a job this pause owns.
  writeFileSync(path.join(agents, "com.ferroxlabs.murage.sentinel.0123456789abcdef.plist"), "<plist/>", { mode: 0o600 });
  writeFileSync(path.join(agents, "com.example.other.plist"), "<plist/>", { mode: 0o600 });
  return { home, agents, plist: path.join(agents, `${LABEL}.plist`), markerPath: path.join(home, "update-launch-pause.json") };
}

function recorder(codes = {}) {
  const calls = [];
  const run = (file, args) => { calls.push([path.win32.basename(file), ...args]); return codes[args[0]] ?? 0; };
  return { calls, run };
}

function harness(options) {
  const updater = new EventEmitter();
  updater.on("error", () => {});
  let state = { status: "idle" };
  const coordinator = createUpdaterCoordinator(updater, patch => { state = { ...state, ...patch }; }, options);
  return { updater, coordinator, getState: () => state };
}
async function downloaded(h) {
  h.updater.downloadUpdate = () => { h.updater.emit("update-downloaded", { version: "2.0.0" }); return Promise.resolve(["update.zip"]); };
  await h.coordinator.download();
}
function macFallback(stallMs) {
  const events = new EventEmitter(), recovered = [];
  return { recovered, options: { events, stallMs, blocked: () => null, offer: version => ({ status: "error", action: "download-installer", version }), recover: info => { recovered.push(info); } } };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("macOS: the closed-app backup job is booted out before quitAndInstall, and only that job", async t => {
  const mac = macHome(t), os = recorder();
  const launchPause = createUpdateLaunchPause({ platform: "darwin", uid, home: mac.home, markerPath: mac.markerPath, run: os.run });
  const h = harness({ launchPause, installerFallback: macFallback(10_000).options, beforeInstall: () => {} });
  let atInstall = null;
  h.updater.quitAndInstall = () => { atInstall = { calls: [...os.calls], marker: JSON.parse(readFileSync(mac.markerPath, "utf8")) }; };
  await downloaded(h);
  await h.coordinator.install();
  assert.ok(atInstall, "quitAndInstall ran");
  assert.deepEqual(atInstall.calls, [["launchctl", "bootout", `gui/${uid}/${LABEL}`]]);
  assert.deepEqual(atInstall.marker, { version: 1, jobs: [{ kind: "launchd", label: LABEL, plist: mac.plist }] });
  assert.ok(existsSync(mac.plist), "the plist stays: the next sign-in loads it again on its own");
});

test("macOS: a stalled install puts the job back and clears the marker", async t => {
  const mac = macHome(t), os = recorder(), fallback = macFallback(20);
  const launchPause = createUpdateLaunchPause({ platform: "darwin", uid, home: mac.home, markerPath: mac.markerPath, run: os.run });
  const h = harness({ launchPause, installerFallback: fallback.options, beforeInstall: () => {} });
  h.updater.quitAndInstall = () => {};
  await downloaded(h);
  await h.coordinator.install();
  await sleep(80);
  assert.equal(fallback.recovered.length, 1, "the stall recovery ran");
  assert.deepEqual(os.calls, [["launchctl", "bootout", `gui/${uid}/${LABEL}`], ["launchctl", "bootstrap", `gui/${uid}`, mac.plist]]);
  assert.equal(existsSync(mac.markerPath), false);
});

test("macOS: an install error after quitAndInstall puts the job back", async t => {
  const mac = macHome(t), os = recorder();
  const launchPause = createUpdateLaunchPause({ platform: "darwin", uid, home: mac.home, markerPath: mac.markerPath, run: os.run });
  const h = harness({ launchPause, installerFallback: macFallback(10_000).options, beforeInstall: () => {} });
  h.updater.quitAndInstall = () => h.updater.emit("error", new Error("native staging failed"));
  await downloaded(h);
  await h.coordinator.install();
  await sleep(10);
  assert.deepEqual(os.calls.map(call => call[1]), ["bootout", "bootstrap"]);
  assert.equal(existsSync(mac.markerPath), false);
});

test("macOS: the next start (a fresh process) puts back what the install paused", async t => {
  const mac = macHome(t), first = recorder();
  createUpdateLaunchPause({ platform: "darwin", uid, home: mac.home, markerPath: mac.markerPath, run: first.run }).pause();
  assert.ok(existsSync(mac.markerPath));
  const next = recorder();
  createUpdateLaunchPause({ platform: "darwin", uid, home: mac.home, markerPath: mac.markerPath, run: next.run }).resume();
  assert.deepEqual(next.calls, [["launchctl", "bootstrap", `gui/${uid}`, mac.plist]]);
  assert.equal(existsSync(mac.markerPath), false);
  const again = recorder();
  createUpdateLaunchPause({ platform: "darwin", uid, home: mac.home, markerPath: mac.markerPath, run: again.run }).resume();
  assert.deepEqual(again.calls, [], "resumed once, never twice");
});

test("macOS: a job that was not loaded (turned off) is not loaded by the resume", async t => {
  const mac = macHome(t), os = recorder({ bootout: 3 });
  const pause = createUpdateLaunchPause({ platform: "darwin", uid, home: mac.home, markerPath: mac.markerPath, run: os.run });
  assert.deepEqual(pause.pause(), []);
  pause.resume();
  assert.deepEqual(os.calls, [["launchctl", "bootout", `gui/${uid}/${LABEL}`]]);
  assert.equal(existsSync(mac.markerPath), false);
});

test("macOS: a marker naming a plist outside LaunchAgents is never bootstrapped", async t => {
  const mac = macHome(t), os = recorder();
  const foreign = path.join(mac.home, `${LABEL}.plist`);
  writeFileSync(foreign, "<plist/>", { mode: 0o600 });
  own(foreign);
  writeFileSync(mac.markerPath, JSON.stringify({ version: 1, jobs: [{ kind: "launchd", label: LABEL, plist: foreign }] }));
  createUpdateLaunchPause({ platform: "darwin", uid, home: mac.home, markerPath: mac.markerPath, run: os.run }).resume();
  assert.deepEqual(os.calls, []);
});

test("Windows: the Sentinel task is disabled and ended before quitAndInstall and enabled again on failure", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "launch-pause-win-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markerPath = path.join(dir, "update-launch-pause.json"), os = recorder();
  const launchPause = createUpdateLaunchPause({ platform: "win32", markerPath, env: { SystemRoot: "C:\\Windows" }, windowsTasks: () => [TASK, "\\Other\\Task"], run: os.run });
  // Windows has no installerFallback: a quitAndInstall that throws routes the error.
  const h = harness({ launchPause });
  let atInstall = null;
  h.updater.quitAndInstall = () => { atInstall = [...os.calls]; throw new Error("installer missing"); };
  await downloaded(h);
  await h.coordinator.install();
  assert.deepEqual(atInstall, [["schtasks.exe", "/Change", "/TN", TASK, "/DISABLE"], ["schtasks.exe", "/End", "/TN", TASK]]);
  assert.deepEqual(os.calls.slice(2), [["schtasks.exe", "/Change", "/TN", TASK, "/ENABLE"]]);
  assert.equal(existsSync(markerPath), false);
  assert.equal(h.getState().status, "error");
});

test("Windows: the next start enables the task; a task gone since is dropped, not retried forever", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "launch-pause-win-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markerPath = path.join(dir, "update-launch-pause.json");
  createUpdateLaunchPause({ platform: "win32", markerPath, env: {}, windowsTasks: () => [TASK], run: recorder().run }).pause();
  const gone = recorder({ "/Change": 1, "/Query": 1 });
  createUpdateLaunchPause({ platform: "win32", markerPath, env: {}, run: gone.run }).resume();
  assert.deepEqual(gone.calls.map(call => call[1]), ["/Change", "/Query"]);
  assert.equal(existsSync(markerPath), false);
});

test("Windows: a hand-written marker with a UTF-8 BOM (the 1.0.19 -> 1.0.20 release step) is honoured", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "launch-pause-win-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markerPath = path.join(dir, "update-launch-pause.json"), os = recorder();
  writeFileSync(markerPath, `\uFEFF${JSON.stringify({ version: 1, jobs: [{ kind: "task", task: TASK }] })}`);
  createUpdateLaunchPause({ platform: "win32", markerPath, env: {}, run: os.run }).resume();
  assert.deepEqual(os.calls, [["schtasks.exe", "/Change", "/TN", TASK, "/ENABLE"]]);
  assert.equal(existsSync(markerPath), false);
});

test("no launchPause: the coordinator installs exactly as before", async () => {
  const h = harness({ installerFallback: macFallback(10_000).options, beforeInstall: () => {} });
  let installs = 0;
  h.updater.quitAndInstall = () => { installs++; };
  await downloaded(h);
  await h.coordinator.install();
  assert.equal(installs, 1);
});
