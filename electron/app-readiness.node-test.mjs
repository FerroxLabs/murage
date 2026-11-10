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
const ackOk = { top: true, url: `${ORIGIN}/` };

// One window with a tracker whose probe and onRestored are recorded. `opts.probe` replaces the probe stub, `opts.onRestored(tracker, c)` runs on restore.
function harness(opts = {}) {
  const probes = [], restored = [];
  const h = { probes, restored };
  h.tracker = readiness.createAppReadiness({
    origin: () => ORIGIN,
    probe: opts.probe ?? ((contents, token) => { probes.push([contents, token]); }),
    onRestored: (contents) => { restored.push(contents); opts.onRestored?.(h.tracker, contents); },
  });
  h.wc = fakeContents();
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
