// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PARITYFIX E6: a file the Cloud window downloads from its own home opens the system save dialog in Downloads; any other
// download is cancelled before a byte is written. The listener is the one installCloudHome().open() puts on the session.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installCloudHome } from "./cloud-home-window.mjs";

const HOME = "home-a";
const DOWNLOADS = "/fixture/Downloads";

function openCloud() {
  const listeners = new Map();
  const ses = {
    protocol: { handle() {} },
    webRequest: { onBeforeRequest() {} },
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on(name, fn) { listeners.set(name, fn); },
  };
  const contents = { on() {}, setWindowOpenHandler() {}, getURL: () => "", isDestroyed: () => false };
  function BrowserWindow() {
    this.webContents = contents;
    this.on = () => {};
    this.isDestroyed = () => false;
    this.loadURL = () => new Promise(() => {});
  }
  const cloud = installCloudHome({ protocol: { registerSchemesAsPrivileged() {} }, session: { fromPartition: () => ses }, BrowserWindow,
    shell: { openExternal: async () => {} }, net: { fetch: async () => null }, env: { MURAGE_DESKTOP_CLOUD: "1" }, packaged: false,
    distDir: "/nonexistent", downloadsDir: () => DOWNLOADS, timers: { set: () => 0, clear() {} } });
  cloud.open(HOME);
  /** One download as Electron hands it over; what the listener did to it. No listener: Electron's own default, nothing set. */
  const download = (chain, { filename = "report.pdf", wc = contents } = {}) => {
    const item = { dialog: undefined, cancelled: false, prevented: false,
      getURLChain: () => chain, getURL: () => chain.at(-1), getFilename: () => filename,
      setSaveDialogOptions(options) { item.dialog = options; }, cancel() { item.cancelled = true; } };
    const event = { preventDefault() { item.prevented = true; } };
    listeners.get("will-download")?.(event, item, wc);
    return item;
  };
  return { download, contents };
}

const homeFile = `murage-home://${HOME}/api/files/att-1/download`;

describe("E6 Cloud window downloads", () => {
  it("a file from this home's own route opens the save dialog in Downloads, named as the file", () => {
    const w = openCloud();
    const item = w.download([homeFile]);
    expect(item.dialog).toEqual({ title: "Save file", defaultPath: path.join(DOWNLOADS, "report.pdf") });
  });

  it("a blob the page made on this home's origin opens the save dialog too", () => {
    const w = openCloud();
    const item = w.download([`blob:murage-home://${HOME}/0b1f6a2c-6d1e-4a0f-9c55-1d2b3c4d5e6f`], { filename: "notes.txt" });
    expect(item.dialog).toEqual({ title: "Save file", defaultPath: path.join(DOWNLOADS, "notes.txt") });
  });

  it("a download from another home is cancelled", () => {
    const w = openCloud();
    const item = w.download(["murage-home://home-b/api/files/att-1/download"]);
    expect([item.cancelled, item.dialog]).toEqual([true, undefined]);
  });

  it("a download of an app file (not a home file route) is cancelled", () => {
    const w = openCloud();
    const item = w.download([`murage-home://${HOME}/assets/index.js`]);
    expect([item.cancelled, item.dialog]).toEqual([true, undefined]);
  });

  it("a redirect chain that leaves this home is cancelled", () => {
    const w = openCloud();
    const item = w.download(["https://files.example/x.pdf", homeFile]);
    expect([item.cancelled, item.dialog]).toEqual([true, undefined]);
  });

  it("a download started by a page that is not this home's own Cloud window is cancelled", () => {
    const w = openCloud();
    const item = w.download([homeFile], { wc: { isDestroyed: () => false } });
    expect([item.cancelled, item.dialog]).toEqual([true, undefined]);
  });

  it("the suggested name is a plain file name: no folders and no control characters", () => {
    const w = openCloud();
    const item = w.download([homeFile], { filename: "../../secret/\u0007evil.sh" });
    expect(item.dialog?.defaultPath).toBe(path.join(DOWNLOADS, "evil.sh"));
  });
});
