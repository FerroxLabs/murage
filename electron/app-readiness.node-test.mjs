// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019 design rev 2.4 (A13 + A14). Readiness survives a navigation that never commits, but a restore is proved by the
// renderer: the stop of an uncommitted navigation sends one probe and only the renderer's ack gives the app back and drains. Tray and
// inbox events wait for the app like package installs and Cloud links, and readiness is keyed by navigation so a late failure of an
// older navigation never clears a newer one. Contents here never report isCrashed()/isDestroyed() (the real teardown race).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import * as readiness from "./app-readiness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(here, "main.mjs"), "utf8");
const preload = readFileSync(path.join(here, "preload.cjs"), "utf8");
const ORIGIN = "http://127.0.0.1:8799";
const fakeContents = () => Object.assign(new EventEmitter(), { id: Math.random(), isCrashed: () => false, isDestroyed: () => false, isLoadingMainFrame: () => false });
const start = (wc, url, extra = {}) => wc.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false, ...extra });
const commit = (wc, url, code) => wc.emit("did-navigate", {}, url, code, "");
const failed = (wc, url, code = -3, extra = []) => wc.emit("did-fail-load", {}, code, "", url, true, ...extra);
const ackOk = { top: true, url: `${ORIGIN}/`, frameOrigin: ORIGIN };
// Documents the live main frame can show (the same four fields main's inspect reads).
const APP = { committedUrl: `${ORIGIN}/`, frameUrl: `${ORIGIN}/`, frameOrigin: ORIGIN, entryUrl: `${ORIGIN}/` };
const ERR_A = { ...APP, frameUrl: "chrome-error://chromewebdata/", frameOrigin: "null" };
const NOOP_LFR = { attachLoadFailureRecovery: () => ({ kick() {}, watching: () => false }) };

// One window with a tracker whose probe and onRestored are recorded. `opts.probe` replaces the probe stub, `opts.onRestored(tracker, c)` runs on restore.
function harness(opts = {}) {
  const probes = [], restored = [];
  const h = { probes, restored };
  h.tracker = readiness.createAppReadiness({
    origin: () => ORIGIN,
    probe: opts.probe ?? ((contents, token) => { probes.push([contents, token]); }),
    ...(opts.doc ? { inspect: (contents) => { if (contents.throwInspect) throw new Error("no frame"); return contents.doc; } } : {}),
    onRestored: (contents) => { restored.push(contents); opts.onRestored?.(h.tracker, contents); },
  });
  h.wc = fakeContents();
  if (opts.doc) h.wc.doc = opts.doc;
  h.tracker.track(h.wc);
  h.token = () => probes.at(-1)?.[1];
  return h;
}
const onApp = (opts) => {
  const h = harness(opts);
  start(h.wc, `${ORIGIN}/`); commit(h.wc, `${ORIGIN}/`, 200); h.wc.emit("did-stop-loading");
  assert.equal(h.tracker.ready(h.wc), true);
  assert.equal(h.probes.length, 0, "a normal commit sends no probe");
  return h;
};
// The app committed, an external navigation started, and it stopped without a commit (renderer looks alive).
const stopped = (opts) => {
  const h = onApp(opts);
  start(h.wc, "https://example.com/x");
  h.wc.emit("did-stop-loading");
  return h;
};
// First assertion of every new probe test, made before any call to tracker.alive.
const notReadyYet = ({ tracker, wc, restored }) => {
  assert.equal(tracker.ready(wc), false, "not ready at the stop, before any ack");
  assert.equal(restored.length, 0, "nothing drained at the stop");
};

test("R1 a main-frame navigation that never commits gives the app back only after the renderer acks", () => {
  // a cancelled external link: it started, then stopped, and the app page never left
  let h = onApp();
  start(h.wc, "https://example.com/docs");
  h.wc.emit("did-stop-loading");
  assert.equal(h.tracker.ready(h.wc), false, "stopped without a commit: waiting for the proof");
  assert.equal(h.probes.length, 1, "one probe at the stop");
  assert.equal(h.tracker.alive(h.wc, h.token(), ackOk), true);
  assert.equal(h.tracker.ready(h.wc), true, "ready only after the reply");
  // a download, which is aborted as a navigation
  h = onApp();
  start(h.wc, `${ORIGIN}/export.zip`);
  failed(h.wc, `${ORIGIN}/export.zip`, -3);
  h.wc.emit("did-stop-loading");
  assert.equal(h.tracker.ready(h.wc), false, "ERR_ABORTED, then the stop every cancelled navigation ends with: probe first");
  assert.equal(h.probes.length, 1);
  h.tracker.alive(h.wc, h.token(), ackOk);
  assert.equal(h.tracker.ready(h.wc), true);
  // a real failure still clears it
  h = onApp();
  start(h.wc, `${ORIGIN}/x`);
  failed(h.wc, `${ORIGIN}/x`, -102);
  assert.equal(h.tracker.ready(h.wc), false, "connection refused is not the app");
  // a navigation that commits the 503 page still clears it, and the stop after it changes nothing
  h = onApp();
  start(h.wc, `${ORIGIN}/`); commit(h.wc, `${ORIGIN}/`, 503); h.wc.emit("did-stop-loading");
  assert.equal(h.tracker.ready(h.wc), false);
  assert.equal(h.probes.length, 0);
  // it does not make a window that was never ready ready, and it probes nothing
  const idle = fakeContents(); h.tracker.track(idle);
  start(idle, "https://example.com/"); idle.emit("did-stop-loading");
  assert.equal(h.tracker.ready(idle), false);
  assert.equal(h.probes.length, 0);
});

test("R1 a queued package install is delivered after a cancelled link and its ack, not stalled", () => {
  const { tracker, wc, probes } = onApp();
  const win = { webContents: Object.assign(wc, { send(channel, ...args) { win.sent.push([channel, ...args]); } }), isDestroyed: () => false, sent: [] };
  const ctx = vm.createContext({ appReadiness: tracker, pendingPackageInstallUrl: "murage://package/x" });
  const from = main.indexOf("function deliverPackageInstall("), to = main.indexOf("function queuePackageInstall(", from);
  assert.ok(from > 0 && to > from);
  vm.runInContext(main.slice(from, to), ctx);
  start(wc, "https://example.com/docs"); wc.emit("did-stop-loading");
  ctx.deliverPackageInstall(win);
  assert.deepEqual(win.sent, [], "nothing is sent while the probe is outstanding");
  tracker.alive(wc, probes.at(-1)[1], ackOk);
  ctx.deliverPackageInstall(win);
  assert.deepEqual(win.sent, [["package:install", "murage://package/x"]]);
});

function trayHarness(tracker, wc) {
  const win = { webContents: Object.assign(wc, { send(channel, ...args) { win.sent.push([channel, ...args]); } }), isDestroyed: () => false, sent: [] };
  const ctx = vm.createContext({ appReadiness: tracker, mainWindow: win });
  wc.on("did-finish-load", () => tracker.flush?.(wc)); // as the window's did-finish-load wiring in main.mjs does (R4)
  const from = main.indexOf("function sendWhenLoaded("), to = main.indexOf("/** The tray menu's reads and answers", from);
  assert.ok(from > 0 && to > from, "main.mjs has sendWhenLoaded");
  vm.runInContext(main.slice(from, to), ctx);
  return { win, send: (...a) => ctx.sendWhenLoaded(...a) };
}

test("R2 tray and inbox events wait on the setup page and arrive once when the app loads", () => {
  const { tracker, wc } = harness();
  const { win, send } = trayHarness(tracker, wc);
  start(wc, `${ORIGIN}/`); commit(wc, `${ORIGIN}/`, 503); wc.emit("did-stop-loading"); wc.emit("did-finish-load");
  send("tray:open", "inbox");
  send("startup-background:open-inbox");
  assert.deepEqual(win.sent, [], "nothing is sent to the setup page");
  // a reload of the setup page (still 503) delivers nothing either
  start(wc, `${ORIGIN}/`); commit(wc, `${ORIGIN}/`, 503); wc.emit("did-finish-load");
  assert.deepEqual(win.sent, []);
  start(wc, `${ORIGIN}/`); commit(wc, `${ORIGIN}/`, 200); wc.emit("did-finish-load");
  assert.deepEqual(win.sent, [["tray:open", "inbox"], ["startup-background:open-inbox"]], "in order, once");
  wc.emit("did-finish-load");
  assert.equal(win.sent.length, 2, "exactly once");
  send("tray:open", "chat");
  assert.equal(win.sent.length, 3, "a ready window gets the event at once");
});

test("R3 a late failure of an older navigation does not clear a newer navigation", () => {
  // by URL (no navigation id from Electron)
  let { tracker, wc } = onApp();
  start(wc, "https://example.com/a");
  start(wc, `${ORIGIN}/b`);
  commit(wc, `${ORIGIN}/b`, 200);
  failed(wc, "https://example.com/a", -3);
  assert.equal(tracker.ready(wc), true, "the older navigation failing late leaves the newer app page ready");
  // a late real failure (not just a cancel) of the older navigation, after the newer one committed
  ({ tracker, wc } = onApp());
  start(wc, "https://example.com/a");
  start(wc, `${ORIGIN}/b`);
  commit(wc, `${ORIGIN}/b`, 200);
  failed(wc, "https://example.com/a", -102);
  assert.equal(tracker.ready(wc), true, "connection-refused of the superseded navigation");
  // by navigation id (when Electron supplies one), even when the URLs are equal, committed or still in flight
  ({ tracker, wc } = onApp());
  start(wc, `${ORIGIN}/same`, { navigationId: 11 });
  start(wc, `${ORIGIN}/same`, { navigationId: 12 });
  commit(wc, `${ORIGIN}/same`, 200);
  wc.emit("did-fail-load", { navigationId: 11 }, -102, "", `${ORIGIN}/same`, true);
  assert.equal(tracker.ready(wc), true, "id 11 is not the committed navigation");
  wc.emit("did-fail-load", { navigationId: 12 }, -102, "", `${ORIGIN}/same`, true);
  assert.equal(tracker.ready(wc), false, "the committed navigation's own failure still counts");
  ({ tracker, wc } = onApp());
  start(wc, `${ORIGIN}/same`, { navigationId: 21 });
  start(wc, `${ORIGIN}/same`, { navigationId: 22 });
  wc.emit("did-fail-load", { navigationId: 21 }, -102, "", `${ORIGIN}/same`, true);
  commit(wc, `${ORIGIN}/same`, 200);
  assert.equal(tracker.ready(wc), true, "an older id failing while the newer is in flight does not end it");
  // an older failure while the newer navigation is still in flight does not end it; it then stops without committing
  let h = onApp();
  start(h.wc, "https://example.com/a");
  start(h.wc, "https://example.com/b");
  failed(h.wc, "https://example.com/a", -3);
  assert.equal(h.tracker.ready(h.wc), false, "the newer navigation is still in flight");
  h.wc.emit("did-stop-loading");
  assert.equal(h.tracker.ready(h.wc), false, "no commit anywhere, but the proof comes first");
  assert.equal(h.probes.length, 1, "one probe at the stop");
  h.tracker.alive(h.wc, h.token(), ackOk);
  assert.equal(h.tracker.ready(h.wc), true, "the app page is still on screen: ready after the reply");
  // a newer failure still counts
  ({ tracker, wc } = onApp());
  start(wc, "https://example.com/a");
  start(wc, `${ORIGIN}/b`);
  failed(wc, `${ORIGIN}/b`, -105);
  assert.equal(tracker.ready(wc), false);
});

test("R5 a redirect that fails is the current navigation's failure, never restored onto an error page", () => {
  const { tracker, wc, probes } = onApp();
  start(wc, "https://short.example/a");
  wc.emit("did-redirect-navigation", { url: "https://long.example/b", isMainFrame: true, isSameDocument: false });
  failed(wc, "https://long.example/b", -102);
  assert.equal(tracker.ready(wc), false, "the failure of the redirect target ends the navigation");
  wc.emit("did-stop-loading");
  assert.equal(tracker.ready(wc), false, "the stop after it restores nothing");
  assert.equal(probes.length, 0, "and probes nothing");
});

test("R5 two overlapping navigations to one URL: the cancel of the first leaves the second in flight", () => {
  const { tracker, wc } = onApp();
  start(wc, `${ORIGIN}/same`); start(wc, `${ORIGIN}/same`);
  failed(wc, `${ORIGIN}/same`, -3);
  assert.equal(tracker.ready(wc), false, "the second is still loading");
  commit(wc, `${ORIGIN}/same`, 503);
  assert.equal(tracker.ready(wc), false);
});

test("R5 giving readiness back tells the caller only after the ack, so queued deliveries drain without a did-finish-load", () => {
  const h = harness();
  const { tracker, wc, restored } = h;
  start(wc, `${ORIGIN}/`); commit(wc, `${ORIGIN}/`, 200); wc.emit("did-stop-loading");
  assert.equal(restored.length, 0, "a normal commit is not a restore");
  start(wc, "https://example.com/docs"); wc.emit("did-stop-loading");
  assert.equal(restored.length, 0, "the stop alone restores nothing");
  tracker.alive(wc, h.token(), ackOk);
  assert.deepEqual(restored, [wc]);
  start(wc, `${ORIGIN}/dl.zip`, { navigationId: 31 });
  wc.emit("did-fail-load", { navigationId: 31 }, -3, "", `${ORIGIN}/dl.zip`, true);
  assert.deepEqual(restored, [wc], "a cancel tied to this navigation by id gives nothing back by itself");
  wc.emit("did-stop-loading");
  assert.equal(h.probes.length, 2);
  tracker.alive(wc, h.token(), ackOk);
  assert.deepEqual(restored, [wc, wc], "the stop probes and the ack gives it back");
  // never for a window that was not on the app
  const idle = fakeContents(); tracker.track(idle);
  start(idle, "https://example.com/"); idle.emit("did-stop-loading");
  assert.equal(restored.length, 2);
  // the deferred tray event goes out only once readiness is proved
  const sent = [];
  tracker.defer(wc, () => sent.push("tray"));
  start(wc, "https://example.com/y"); wc.emit("did-stop-loading");
  tracker.flush(wc);
  assert.deepEqual(sent, [], "still probing");
  tracker.alive(wc, h.token(), ackOk);
  tracker.flush(wc);
  assert.deepEqual(sent, ["tray"]);
});

test("R6 a cancel that is not tied to the navigation in flight ends nothing (it may be the document being left)", () => {
  const { tracker, wc } = onApp();
  start(wc, "https://example.com/next");
  failed(wc, `${ORIGIN}/`, -3); // the app document's own load abort, a URL no navigation here has recorded as older
  assert.equal(tracker.ready(wc), false, "the new navigation is still in flight");
  commit(wc, `${ORIGIN}/`, 503);
  assert.equal(tracker.ready(wc), false, "and it commits the setup page");
});

test("R7 teardown: a stop during renderer teardown never drains, and a dead renderer cannot ack", () => {
  const h = stopped();
  notReadyYet(h); // first assertion, before any alive(); isCrashed and isDestroyed stay false
  assert.equal(h.probes.length, 1, "exactly one probe");
  assert.equal(h.probes[0][0], h.wc);
  h.wc.emit("render-process-gone");
  h.tracker.alive(h.wc, h.token(), ackOk);
  assert.equal(h.tracker.ready(h.wc), false);
  assert.equal(h.restored.length, 0);
});

test("R8 the ack grants readiness and drains once", () => {
  const h = stopped();
  notReadyYet(h);
  h.tracker.alive(h.wc, h.token(), ackOk);
  assert.equal(h.tracker.ready(h.wc), true);
  assert.equal(h.restored.length, 1);
  h.tracker.alive(h.wc, h.token(), ackOk);
  assert.equal(h.restored.length, 1, "a duplicate ack drains nothing more");
});

test("R9 a stale ack is ignored", () => {
  const h = stopped();
  notReadyYet(h);
  const t1 = h.token();
  start(h.wc, "https://example.com/other");
  h.tracker.alive(h.wc, t1, ackOk);
  assert.equal(h.tracker.ready(h.wc), false);
  commit(h.wc, `${ORIGIN}/`, 503);
  assert.equal(h.tracker.ready(h.wc), false);
  assert.equal(h.restored.length, 0);
});

test("R10 an ack from the wrong frame, origin or token is ignored", () => {
  const h = stopped();
  notReadyYet(h);
  const t = h.token();
  h.tracker.alive(h.wc, t, { top: false, url: `${ORIGIN}/` });
  h.tracker.alive(h.wc, t, { top: true, url: "https://evil.example/" });
  h.tracker.alive(h.wc, t + 1, ackOk);
  assert.equal(h.tracker.ready(h.wc), false);
  assert.equal(h.restored.length, 0);
  h.tracker.alive(h.wc, t, ackOk);
  assert.equal(h.tracker.ready(h.wc), true);
  assert.equal(h.restored.length, 1);
});

test("R11 a cancel by navigation id waits for the stop", () => {
  const h = onApp();
  h.wc.isLoadingMainFrame = () => true;
  start(h.wc, `${ORIGIN}/dl.zip`, { navigationId: 7 });
  h.wc.emit("did-fail-load", { navigationId: 7 }, -3, "", `${ORIGIN}/dl.zip`, true);
  assert.equal(h.tracker.ready(h.wc), false, "a cancel by id restores nothing");
  assert.equal(h.probes.length, 0, "no probe until the stop");
  assert.equal(h.restored.length, 0);
  h.wc.isLoadingMainFrame = () => false;
  h.wc.emit("did-stop-loading");
  assert.equal(h.probes.length, 1);
  h.tracker.alive(h.wc, h.token(), ackOk);
  assert.equal(h.tracker.ready(h.wc), true);
  assert.equal(h.restored.length, 1);
});

test("R12 entry points wait while probing and run once after the ack", () => {
  const h = stopped({ onRestored: (tracker, contents) => tracker.flush(contents) });
  notReadyYet(h);
  let ran = 0;
  h.tracker.defer(h.wc, () => { ran += 1; });
  assert.equal(h.tracker.flush(h.wc), 0);
  assert.equal(ran, 0, "not run while probing");
  h.tracker.alive(h.wc, h.token(), ackOk);
  assert.equal(ran, 1, "run by the restore");
  assert.equal(h.tracker.flush(h.wc), 0);
  assert.equal(ran, 1, "a second flush runs nothing more");
});

test("R13 a renderer that dies after the stop keeps the queue for the recovery load; the old ack is dead", () => {
  const h = stopped();
  notReadyYet(h);
  const old = h.token();
  h.wc.emit("render-process-gone");
  let ran = 0;
  h.tracker.defer(h.wc, () => { ran += 1; });
  start(h.wc, `${ORIGIN}/`); commit(h.wc, `${ORIGIN}/`, 200); // the recovery reload
  assert.equal(h.tracker.flush(h.wc), 1, "did-finish-load flush");
  assert.equal(ran, 1);
  h.tracker.alive(h.wc, old, ackOk);
  assert.equal(h.restored.length, 0, "the old token's ack restores nothing");
});

test("R14 a probe that throws leaves the window not ready, escapes nothing, and a commit still recovers", () => {
  const h = onApp({ probe: () => { throw new Error("the renderer is gone"); } });
  start(h.wc, "https://example.com/x");
  assert.doesNotThrow(() => h.wc.emit("did-stop-loading"));
  notReadyYet(h);
  commit(h.wc, `${ORIGIN}/`, 200);
  assert.equal(h.tracker.ready(h.wc), true);
});

test("R15 guard: gone, then stop, is not ready and sends no probe", () => {
  const h = onApp();
  start(h.wc, "https://example.com/y");
  h.wc.emit("render-process-gone");
  h.wc.emit("did-stop-loading");
  assert.equal(h.tracker.ready(h.wc), false);
  assert.equal(h.probes.length, 0);
  assert.equal(h.restored.length, 0);
});

test("R16 guard: destroyed, then stop, is not ready and sends no probe", () => {
  const h = onApp();
  start(h.wc, "https://example.com/z");
  h.wc.isDestroyed = () => true;
  h.wc.emit("did-stop-loading");
  assert.equal(h.tracker.ready(h.wc), false);
  assert.equal(h.probes.length, 0);
  assert.equal(h.restored.length, 0);
});

test("R4 main.mjs flushes the queue from did-finish-load", () => {
  assert.match(main, /did-finish-load", \(\) => \{ deliverPackageInstall\(win\); cloudLinks\.drain\(\); appReadiness\.flush\(win\.webContents\); \}\)/);
  // and from a restore: queued package installs, Cloud links and tray events drain when the renderer proves the app is back
  const wired = main.slice(main.indexOf("const appReadiness = createAppReadiness("), main.indexOf("// Cloud links: murage://open-cloud"));
  assert.match(wired, /onRestored: \(contents\) => \{[\s\S]*deliverPackageInstall\(win\);[\s\S]*cloudLinks\.drain\(\);[\s\S]*flushCloudLinkEvent\(win\);[\s\S]*appReadiness\.flush\(contents\);/);
  // the probe goes out through main, and the ack comes back over the owned IPC gate with the sender frame
  assert.match(wired, /probe: \(contents, token\) => \{[\s\S]*try \{[\s\S]*contents\.send\("app-readiness:probe", token\)[\s\S]*\} catch/);
  assert.match(main, /ipcMain\.on\("app-readiness:alive", \(event, token\) => \{[\s\S]{0,400}appReadiness\.alive\(event\.sender, token,[\s\S]{0,200}event\.senderFrame/);
  // the preload answers a probe with one replying listener
  assert.match(preload, /ipcRenderer\.on\("app-readiness:probe"[\s\S]{0,200}Number\.isInteger\(t\)[\s\S]{0,100}ipcRenderer\.send\("app-readiness:alive", t\)/);
});

// ---- A15.1 / A15.2 (rev 2.5) -------------------------------------------------------------------------------------------------------
const lateFail = (wc, url = `${ORIGIN}/`, code = -102) => wc.emit("did-fail-load", {}, code, "", url, true);

test("R17 an ack from an error document or a foreign frame origin never grants READY (A15.1)", () => {
  const h = stopped();
  notReadyYet(h);
  const t = h.token();
  for (const bad of [
    { top: true, url: `${ORIGIN}/`, frameOrigin: "null" },
    { top: true, url: `${ORIGIN}/` },
    { top: true, url: `${ORIGIN}/`, frameOrigin: "http://127.0.0.1:8798" },
    { top: true, url: "chrome-error://chromewebdata/", frameOrigin: ORIGIN },
    { top: true, url: undefined, frameOrigin: ORIGIN },
  ]) {
    assert.equal(h.tracker.alive(h.wc, t, bad), false, JSON.stringify(bad));
    assert.equal(h.restored.length, 0, `onRestored stays 0 for ${JSON.stringify(bad)}`);
  }
  assert.equal(h.tracker.ready(h.wc), false);
  // the trusted origin becomes unset, "null" or invalid while a valid probe token is outstanding: the ack is refused, then granted once it is back
  let current = ORIGIN, restoredN = 0;
  const probed = [];
  const mt = readiness.createAppReadiness({ origin: () => current, probe: (_c, tk) => { probed.push(tk); }, onRestored: () => { restoredN += 1; } });
  const wc2 = fakeContents(); mt.track(wc2);
  start(wc2, `${ORIGIN}/`); commit(wc2, `${ORIGIN}/`, 200); wc2.emit("did-stop-loading");
  start(wc2, "https://example.com/x"); wc2.emit("did-stop-loading");
  assert.equal(probed.length, 1, "a probe is outstanding");
  for (const bad of [undefined, "null", "not a url", ""]) {
    current = bad;
    assert.equal(mt.alive(wc2, probed[0], ackOk), false, `origin ${String(bad)}`);
  }
  assert.equal(restoredN, 0);
  current = ORIGIN;
  assert.equal(mt.alive(wc2, probed[0], ackOk), true, "the same token is accepted once the origin is valid");
  assert.equal(restoredN, 1);
  assert.equal(h.tracker.alive(h.wc, t, ackOk), true, "the right ack still grants READY");
  assert.equal(h.restored.length, 1);
});

// READY, then A and B (both ORIGIN/): B is cancelled, the stop probes, the ack gives the app back.
const afterCancelledB = (opts) => {
  const h = onApp({ doc: APP, ...opts });
  start(h.wc, `${ORIGIN}/`); start(h.wc, `${ORIGIN}/`);
  h.wc.emit("did-fail-provisional-load", {}, -3, "", `${ORIGIN}/`, true);
  h.wc.emit("did-stop-loading");
  assert.equal(h.probes.length, 1);
  assert.equal(h.tracker.alive(h.wc, h.token(), ackOk), true);
  assert.equal(h.tracker.ready(h.wc), true);
  assert.equal(h.restored.length, 1);
  return h;
};

test("R18 a late non-aborted failure over the unchanged app re-proves it by ack; over an error document it does not (A15.2)", () => {
  const h = afterCancelledB({ onRestored: (tracker, contents) => tracker.flush(contents) });
  let ran = 0;
  h.tracker.defer(h.wc, () => { ran += 1; });
  lateFail(h.wc); // doc is still APP
  assert.equal(h.tracker.ready(h.wc), false, "not ready until the app answers again");
  assert.equal(h.probes.length, 2, "one new probe, not NOT_READY with none");
  assert.equal(ran, 0, "nothing delivered before the ack");
  assert.equal(h.tracker.alive(h.wc, h.token(), ackOk), true);
  assert.equal(h.tracker.ready(h.wc), true);
  assert.equal(h.restored.length, 2, "onRestored once more");
  assert.equal(ran, 1, "every queued item drained exactly once");
  // the same late failure with an error document on screen: NOT_READY, and no probe
  const e = afterCancelledB();
  e.wc.doc = ERR_A;
  lateFail(e.wc);
  assert.equal(e.tracker.ready(e.wc), false);
  assert.equal(e.probes.length, 1, "no new probe");
  assert.equal(e.tracker.stateOf(e.wc), "NOT_READY");
  // loading variant: the late failure arrives while the main frame is loading: no probe until the stop (R19)
  const l = afterCancelledB();
  l.wc.isLoadingMainFrame = () => true;
  lateFail(l.wc);
  assert.equal(l.tracker.ready(l.wc), false);
  assert.equal(l.probes.length, 1, "no probe while loading");
  l.wc.isLoadingMainFrame = () => false;
  l.wc.emit("did-stop-loading");
  assert.equal(l.probes.length, 2, "one probe at the stop");
  assert.equal(l.tracker.alive(l.wc, l.token(), ackOk), true);
  // navigating variant (R20): the late failure in NAVIGATING makes no transition; B's own end decides
  const n = afterCancelledB({ onRestored: (tracker, contents) => tracker.flush(contents) });
  let drained = 0;
  start(n.wc, `${ORIGIN}/b`);
  n.tracker.defer(n.wc, () => { drained += 1; });
  lateFail(n.wc, `${ORIGIN}/b`);
  assert.equal(n.tracker.stateOf(n.wc), "NAVIGATING", "no transition");
  n.wc.emit("did-fail-provisional-load", {}, -3, "", `${ORIGIN}/b`, true);
  n.wc.emit("did-stop-loading");
  assert.equal(n.probes.length, 2, "one probe at B's stop");
  assert.equal(drained, 0);
  assert.equal(n.tracker.alive(n.wc, n.token(), ackOk), true);
  assert.equal(drained, 1, "drained exactly once");
});

test("R19 loading variant: commit 200 while loading, ambiguous failure, stop, fresh ack -> READY with one drain; start/cancel/stop re-probes", () => {
  const h = harness({ doc: APP, onRestored: (tracker, contents) => tracker.flush(contents) });
  h.wc.isLoadingMainFrame = () => true;
  start(h.wc, `${ORIGIN}/`); commit(h.wc, `${ORIGIN}/`, 200);
  let ran = 0;
  h.tracker.defer(h.wc, () => { ran += 1; });
  lateFail(h.wc);
  assert.equal(h.probes.length, 0, "no probe while loading");
  assert.equal(h.tracker.ready(h.wc), false);
  h.wc.isLoadingMainFrame = () => false;
  h.wc.emit("did-stop-loading");
  assert.equal(h.probes.length, 1);
  assert.equal(ran, 0, "no delivery before the ack");
  h.tracker.alive(h.wc, h.token(), ackOk);
  assert.equal(h.tracker.ready(h.wc), true);
  assert.equal(ran, 1, "one drain");
  // reprobeAtStop set, then a new start, a cancel and a stop: the app is still there, so PROBING; its ack gives READY
  const g = onApp({ doc: APP });
  g.wc.isLoadingMainFrame = () => true;
  lateFail(g.wc);
  g.wc.isLoadingMainFrame = () => false;
  start(g.wc, "https://example.com/x");
  g.wc.emit("did-fail-provisional-load", {}, -3, "", "https://example.com/x", true);
  g.wc.emit("did-stop-loading");
  assert.equal(g.tracker.stateOf(g.wc), "PROBING");
  assert.equal(g.tracker.alive(g.wc, g.token(), ackOk), true);
  assert.equal(g.tracker.ready(g.wc), true);
  // the stop consumes reprobeAtStop only while the same trusted app document is still shown
  const k = onApp({ doc: APP });
  k.wc.isLoadingMainFrame = () => true;
  lateFail(k.wc);
  k.wc.isLoadingMainFrame = () => false;
  k.wc.doc = ERR_A;
  k.wc.emit("did-stop-loading");
  assert.equal(k.probes.length, 0, "an error document at the stop: no probe");
  assert.equal(k.tracker.stateOf(k.wc), "NOT_READY");
  // two ambiguous failures while loading keep the deferred re-probe: the stop still sends it
  const d = onApp({ doc: APP });
  d.wc.isLoadingMainFrame = () => true;
  lateFail(d.wc); lateFail(d.wc);
  assert.equal(d.probes.length, 0, "no probe while loading");
  d.wc.isLoadingMainFrame = () => false;
  d.wc.emit("did-stop-loading");
  assert.equal(d.probes.length, 1, "the duplicate failure did not drop the re-probe");
  assert.equal(d.tracker.alive(d.wc, d.token(), ackOk), true);
  // a commit clears it: the next stop has nothing to re-probe
  const m = onApp({ doc: APP });
  m.wc.isLoadingMainFrame = () => true;
  lateFail(m.wc);
  commit(m.wc, `${ORIGIN}/`, 200);
  m.wc.isLoadingMainFrame = () => false;
  m.wc.emit("did-stop-loading");
  assert.equal(m.probes.length, 0);
  assert.equal(m.tracker.ready(m.wc), true);
});

test("R21 no ack for 60 s: still not ready, nothing drained, no recovery reload; a new commit gives READY and kills the old token", async () => {
  const { attachLoadFailureRecovery } = await import("./load-failure-recovery.mjs").catch(() => NOOP_LFR);
  const h = stopped({ doc: APP });
  let clock = 0, healthCalls = 0, hrefCalls = 0, ran = 0;
  let timers = []; const reloads = [];
  const rec = attachLoadFailureRecovery(h.wc, {
    origin: () => ORIGIN, inspect: () => h.wc.doc, readiness: () => h.tracker.stateOf(h.wc), healthy: async () => { healthCalls += 1; return true; },
    documentHref: async () => { hrefCalls += 1; return `${ORIGIN}/`; },
    reload: (t) => reloads.push(t), now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, at: clock + ms, unref() {} }; timers.push(t); return t; }, clearTimer: (t) => { timers = timers.filter((x) => x !== t); },
  });
  h.tracker.defer(h.wc, () => { ran += 1; });
  const old = h.token();
  // 60 s of fake time, advancing the clock and firing every timer that comes due, with the recovery kicked and woken throughout
  for (let t = 0; t < 60000; t += 1000) {
    clock += 1000;
    for (const due of timers.filter((x) => x.at <= clock)) { timers = timers.filter((x) => x !== due); due.fn(); }
    rec.kick(); h.wc.emit("did-stop-loading");
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(h.tracker.ready(h.wc), false, "no ack: not ready, with no timeout or health to grant it");
  assert.equal(h.tracker.flush(h.wc), 0, "nothing drains without an ack");
  assert.equal(ran, 0);
  assert.equal(h.restored.length, 0);
  assert.equal(healthCalls, 0, "the document is the app, not an error document: health is never even asked");
  assert.equal(reloads.length, 0, "a hung normal app is never reloaded");
  assert.equal(hrefCalls, 0, "and no JavaScript ever runs in the app document");
  start(h.wc, `${ORIGIN}/`); commit(h.wc, `${ORIGIN}/`, 200);
  assert.equal(h.tracker.ready(h.wc), true);
  assert.equal(h.tracker.alive(h.wc, old, ackOk), false, "the old token's ack is ignored");
  assert.equal(h.restored.length, 0);
});

test("S-static (A15, rev 2.5.1) main.mjs wires inspect, readiness, busy, the kick, the confirm and a finally; Electron holds no route knowledge", () => {
  const perms = readFileSync(path.join(here, "app-permissions.mjs"), "utf8");
  assert.match(perms, /export function webOrigin\(/);
  const attach = main.slice(main.indexOf("attachLoadFailureRecovery(win.webContents"), main.indexOf("did-finish-load\", () => { deliverPackageInstall"));
  assert.match(attach, /inspect: \(\) => inspectMainDocument\(win\.webContents\)/);
  assert.match(attach, /readiness: \(\) => appReadiness\.stateOf\(win\.webContents\)/);
  assert.match(attach, /busy: \(\) => mainRendererRecovering/);
  assert.match(attach, /origin: \(\) => trustedRendererOrigin\(\)/);
  const inspector = main.slice(main.indexOf("function inspectMainDocument("), main.indexOf("function inspectMainDocument(") + 900);
  assert.match(inspector, /mainFrame\.origin/);
  assert.match(inspector, /navigationHistory/);
  assert.match(main, /createAppReadiness\(\{[\s\S]*?inspect: inspectMainDocument/);
  assert.match(main, /if \(next\.state === "running"\) loadFailureRecoveries\.get\(win\.webContents\)\?\.kick\(\)/);
  assert.match(main, /rendererRecovery\.onGone\(details\)[\s\S]{0,200}\.finally\(\(\) => \{ mainRendererRecovering = false; \}\)/);
  assert.match(main, /senderFrame\?\.origin/);
  // Rev 2.5.1 (A15a): Electron holds NO route knowledge. A routing mismatch between the server's sandboxed routes and the recovery rule is
  // impossible only if the main process never looks at a path, so this asserts that and fails on any drift back.
  for (const file of ["load-failure-recovery.mjs", "app-readiness.mjs"]) {
    const text = readFileSync(path.join(here, file), "utf8");
    for (const banned of ["pathname", "mermaid", "decodeURI", "/api/artifacts", "SANDBOXED"]) {
      assert.ok(!text.includes(banned), `${file} holds no route knowledge: it must not contain ${banned}`);
    }
  }
  // The confirmation is the renderer's own location.href through Electron's frame executeJavaScript, here and in the real-window fixture.
  assert.match(attach, /documentHref: \(\) => win\.webContents\.mainFrame\.executeJavaScript\("location\.href", false\)/);
  const fixture = (() => { try { return readFileSync(path.join(here, "fixtures", "setup-page-window.mjs"), "utf8"); } catch { return null; } })();
  if (fixture !== null) assert.match(fixture, /documentHref: \(\) => [^\n]*mainFrame\.executeJavaScript\("location\.href", false\)/, "the fixture's recovery wiring passes the same documentHref");
});

// R18b (A15b): an opaque-origin top-level document on our URL (here a sandboxed route) is a recovery candidate only. The tracker goes
// NOT_READY on the ambiguous late failure, but the confirmation says it is a page, so recovery never probes health and never reloads.
test("R18b a late failure over a sandboxed top-level document: NOT_READY, and recovery confirms, then neither probes nor reloads", async () => {
  const { attachLoadFailureRecovery } = await import("./load-failure-recovery.mjs").catch(() => NOOP_LFR);
  const url = `${ORIGIN}/%6dermaid-frame.html`;
  const SANDBOXED = { committedUrl: url, frameUrl: url, frameOrigin: "null", entryUrl: url };
  for (const from of ["READY", "NAVIGATING"]) {
    const h = afterCancelledB({ doc: APP });
    let clock = 0, hrefCalls = 0, healthCalls = 0, timers = []; const reloads = [];
    attachLoadFailureRecovery(h.wc, {
      origin: () => ORIGIN, inspect: () => h.wc.doc, readiness: () => h.tracker.stateOf(h.wc),
      documentHref: async () => { hrefCalls += 1; return url; },
      healthy: async () => { healthCalls += 1; return true; }, reload: (t) => reloads.push(t), now: () => clock,
      setTimer: (fn, ms) => { const t = { fn, at: clock + ms, unref() {} }; timers.push(t); return t; }, clearTimer: (t) => { timers = timers.filter((x) => x !== t); },
    });
    assert.equal(h.tracker.stateOf(h.wc), "READY", `${from}: starts READY`);
    h.wc.doc = SANDBOXED;
    if (from === "NAVIGATING") start(h.wc, `${ORIGIN}/b`);
    const probes = h.probes.length;
    lateFail(h.wc, url);
    assert.equal(h.tracker.ready(h.wc), false, `${from}: NOT_READY`);
    assert.equal(h.probes.length, probes, `${from}: the late failure sends no probe`);
    if (from === "NAVIGATING") {
      assert.equal(h.tracker.stateOf(h.wc), "NOT_READY", "NAVIGATING: the A15b exception, NOT_READY rather than no transition");
      h.wc.emit("did-fail-provisional-load", {}, -3, "", `${ORIGIN}/b`, true);
      h.wc.emit("did-stop-loading");
    }
    for (let t = 0; t < 15000; t += 1000) {
      clock += 1000;
      for (const due of timers.filter((x) => x.at <= clock)) { timers = timers.filter((x) => x !== due); due.fn(); }
      h.wc.emit("did-stop-loading");
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(hrefCalls >= 1, `${from}: at least one confirm attempt`);
    assert.equal(healthCalls, 0, `${from}: 0 health calls`);
    assert.equal(reloads.length, 0, `${from}: 0 reloads over 15 s`);
  }
});
