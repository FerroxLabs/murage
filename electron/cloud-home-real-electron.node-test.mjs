// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PARITYFIX E5/E6 on REAL Electron: cloud-home-real-electron.harness.mjs runs installCloudHome().open() in an Electron main
// process and lets the page ask for notifications, the microphone and downloads, so Electron itself delivers each permission
// check/request and will-download to the handlers open() installed (cloud-home-window.mjs). No handler is called by hand.
// Needs the Electron binary (MURAGE_REAL_ELECTRON, else the electron package) and a display (DISPLAY, else xvfb-run); without
// them the suite is skipped and says why. The owned display row also needs a D-Bus session bus and libnotify.so.4, else it FAILS
// (nothing displayed), never skips; the pop-out display row pins its page's "error" (refused), its desktop 0 holds either way.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function electronBinary() {
  if (process.env.MURAGE_REAL_ELECTRON) return process.env.MURAGE_REAL_ELECTRON;
  try { const bin = createRequire(import.meta.url)("electron"); return typeof bin === "string" && existsSync(bin) ? bin : null; } catch { return null; }
}
const has = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).status === 0;
const hasXvfb = () => has("xvfb-run");
const binary = electronBinary();
const skip = !binary ? "no Electron binary (set MURAGE_REAL_ELECTRON)" : !process.env.DISPLAY && !hasXvfb() ? "no display and no xvfb-run" : false;

describe("E5/E6 Cloud window on real Electron", { skip }, () => {
  let work = "";
  let run = null;
  before(() => {
    work = mkdtempSync(path.join(os.tmpdir(), "cloud-real-electron-"));
    const electron = [binary, "--no-sandbox", path.join(here, "cloud-home-real-electron.harness.mjs"), work];
    const argv = !process.env.DBUS_SESSION_BUS_ADDRESS && has("dbus-run-session") ? ["dbus-run-session", "--", ...electron] : electron;
    const child = process.env.DISPLAY ? spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 240_000 })
      : spawnSync("xvfb-run", ["-a", ...argv], { encoding: "utf8", timeout: 240_000 });
    const line = String(child.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `the harness printed no RESULT (exit ${child.status}): ${String(child.stderr ?? "").slice(-2000)}`);
    run = JSON.parse(line.slice("RESULT ".length));
    assert.equal(run.hung, undefined, "the harness ran to the end");
  });
  after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  // E5 display (ASTRA fcf336e0d0): the notification Electron shows reaches the desktop's notification server on the bus.
  it("a notification the Cloud page creates is displayed: it fires show and reaches the desktop notification server", () => {
    assert.deepEqual({ server: run.notifyServer, page: run.showNotification, desktop: run.desktopOwned }, { server: "ready", page: "show", desktop: 1 });
  });

  it("a notification the browser pop-out creates is never displayed: error in the page, nothing on the desktop", () => {
    assert.deepEqual({ server: run.notifyServer, page: run.popoutShowNotification, desktop: run.desktopPopout }, { server: "ready", page: "error", desktop: 0 });
  });

  // E6 (ASTRA fcf336e0d0): every download shape below is started by the page and delivered by Electron with its real URL chain.
  // MAIN-RULING cl-pf-l5-native-dialog: rows that save a file start at will-download and replace ONLY the OS dialog's result
  // (setSavePath at the dialog boundary, harness download()); they prove the options open() gives that dialog and the bytes
  // Electron writes, never the OS dialog itself (only the native-dialog row below looks at a real dialog window).
  it("a blob the Cloud page made on this home's origin gets open()'s save dialog options and, given only the dialog's answer (setSavePath), saves the page's bytes", () => {
    const { chain, state, dialog, bytes } = run.blobFile;
    assert.deepEqual({ blob: chain.length === 1 && chain[0].startsWith(`blob:murage-home://home-a/`), state, title: dialog.title, defaultPath: dialog.defaultPath, bytes },
      { blob: true, state: "completed", title: "Save file", defaultPath: path.join(run.downloadsDir, "notes.txt"), bytes: "fixture blob bytes\n" });
  });

  // ASTRA 7c83950ca9: the data: refusal at cloud-home-window.mjs:279 on real Electron (the page clicks a data: link).
  it("a data: URL download the Cloud page starts is refused: cancelled, no save dialog options, no byte written", () => {
    const { chain, state, dialog, bytes } = run.dataFile;
    assert.deepEqual({ chain, state, title: dialog.title, bytes }, { chain: ["data:application/octet-stream,fixture%20data%20bytes%0A"], state: "cancelled", title: "", bytes: null });
  });

  it("another home's file reaching the Cloud window (in a subframe) is cancelled before a byte is written", () => {
    const { chain, state, dialog, bytes } = run.otherHome;
    assert.deepEqual({ chain, state, title: dialog.title, bytes }, { chain: ["murage-home://home-b/api/files/att-1/other"], state: "cancelled", title: "", bytes: null });
  });

  it("a redirect chain that starts in another home and ends at this home's file is cancelled", () => {
    const { chain, state, dialog, bytes } = run.redirectIn;
    assert.deepEqual({ chain, state, title: dialog.title, bytes },
      { chain: ["murage-home://home-b/api/files/att-1/download", "murage-home://home-a/api/files/att-1/download"], state: "cancelled", title: "", bytes: null });
  });

  it("a redirect chain that starts at this home's file route and ends at an app file is cancelled", () => {
    const { chain, state, dialog, bytes } = run.redirectOut;
    assert.deepEqual({ chain, state, title: dialog.title, bytes },
      { chain: ["murage-home://home-a/api/files/att-1/moved", "murage-home://home-a/app.bin"], state: "cancelled", title: "", bytes: null });
  });

  it("Electron delivers the page's notification check to the handler open() installed, from the owned window's top frame", () => {
    const delivered = run.checks.find((c) => c.permission === "notifications" && c.sender === "owned" && c.isMainFrame === true);
    assert.equal(delivered?.answer, true);
  });

  it("the Cloud page's Notification.requestPermission() is granted", () => {
    assert.equal(run.notificationRequest, "granted");
  });

  it("Notification.permission reads granted in the Cloud page", () => {
    assert.equal(run.notificationPermission, "granted");
  });

  it("the Cloud page gets a microphone stream", () => {
    assert.equal(run.microphone, "stream");
  });

  it("the Cloud page's own microphone check reads granted, agreeing with the request", () => {
    assert.equal(run.microphoneQuery, "granted");
  });

  it("the Cloud page never gets the camera", () => {
    assert.equal(run.camera, "NotAllowedError");
  });

  it("a subframe of this home reads notifications denied (the check refuses it)", () => {
    assert.equal(run.subframe.notification, "denied");
  });

  it("a subframe of this home gets no microphone and its microphone check reads denied", () => {
    assert.deepEqual([run.subframe.stream, run.subframe.microphone], ["NotAllowedError", "denied"]);
  });

  it("a worker's frame-less notification check (no sender, no frame) reads denied: it cannot name its window", () => {
    assert.equal(run.workerNotification, "denied");
  });

  it("the browser pop-out on the same session reads notifications denied (the check refuses it)", () => {
    assert.equal(run.popoutNotificationPermission, "denied");
  });

  it("a worker in the browser pop-out reads notifications denied (same origin, but not the owned window)", () => {
    assert.equal(run.popoutWorkerNotification, "denied");
  });

  it("the browser pop-out's microphone check reads denied", () => {
    assert.equal(run.popoutMicrophoneQuery, "denied");
  });

  it("the browser pop-out's notification request and microphone request are refused", () => {
    assert.deepEqual([run.popoutNotificationRequest, run.popoutMicrophone], ["denied", "NotAllowedError"]);
  });

  it("the pop-out page that rewrote its URL to this home's entry still reads notifications and the microphone denied", () => {
    assert.deepEqual(run.popoutRewritten, { url: "murage-home://home-a/", notification: "denied", microphone: "denied" });
  });

  it("a file from this home's own route gets open()'s save dialog options: Downloads, named as the file", () => {
    assert.deepEqual({ title: run.homeFile.dialog.title, defaultPath: run.homeFile.dialog.defaultPath }, { title: "Save file", defaultPath: path.join(run.downloadsDir, "report.pdf") });
  });

  it("Electron opens its native save dialog for a file from this home's own route, titled as open() set it", () => {
    assert.deepEqual(run.nativeSaveDialog, { state: "progressing", opened: ["Save file"] });
  });

  it("given only the dialog's answer (setSavePath), the file from this home's own route is saved with the home's bytes", () => {
    assert.deepEqual([run.homeFile.state, run.homeFile.bytes], ["completed", "fixture report bytes\n"]);
  });

  it("a download of an app file (not a home file route) is cancelled before a byte is written", () => {
    assert.deepEqual([run.appAsset.state, run.appAsset.bytes], ["cancelled", null]);
  });

  it("a download started by the browser pop-out is cancelled", () => {
    assert.deepEqual([run.popoutDownload.state, run.popoutDownload.bytes], ["cancelled", null]);
  });
});
