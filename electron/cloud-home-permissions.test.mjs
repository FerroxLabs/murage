// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PARITYFIX E5: the Cloud window may use the microphone (audio only) and notifications for THIS home's origin, from the
// top frame of its own window. The handlers are the ones installCloudHome().open() really installs on the session.
import { describe, expect, it } from "vitest";
import { installCloudHome } from "./cloud-home-window.mjs";

const HOME = "home-a";
const OTHER = "home-b";

function openCloud() {
  const installed = {};
  const ses = {
    protocol: { handle() {} },
    webRequest: { onBeforeRequest() {} },
    setPermissionRequestHandler(fn) { installed.request = fn; },
    setPermissionCheckHandler(fn) { installed.check = fn; },
  };
  const contents = { on() {}, setWindowOpenHandler() {}, getURL: () => "", isDestroyed: () => false };
  function BrowserWindow() {
    this.webContents = contents;
    this.on = () => {};
    this.isDestroyed = () => false;
    this.loadURL = () => new Promise(() => {});
  }
  const timers = { set: () => 0, clear() {} };
  const cloud = installCloudHome({ protocol: { registerSchemesAsPrivileged() {} }, session: { fromPartition: () => ses }, BrowserWindow,
    shell: { openExternal: async () => {} }, net: { fetch: async () => null }, env: { MURAGE_DESKTOP_CLOUD: "1" }, packaged: false,
    distDir: "/nonexistent", timers });
  cloud.open(HOME);
  const request = (permission, details, wc = contents) => {
    let answer = "never answered";
    installed.request(wc, permission, (value) => { answer = value; }, details);
    return answer;
  };
  const check = (permission, origin, details, wc = null) => installed.check(wc, permission, origin, details);
  return { installed, contents, request, check };
}

const topAudio = (home = HOME, extra = {}) => ({ isMainFrame: true, requestingUrl: `murage-home://${home}/chat`, securityOrigin: `murage-home://${home}/`, mediaTypes: ["audio"], ...extra });

describe("E5 Cloud window permissions", () => {
  it("grants the microphone to this home's top frame", () => {
    const w = openCloud();
    expect(w.request("media", topAudio())).toBe(true);
  });

  it("grants notifications to this home's top frame, and the check agrees so Notification.permission reads granted", () => {
    const w = openCloud();
    expect(w.request("notifications", { isMainFrame: true, requestingUrl: `murage-home://${HOME}/` })).toBe(true);
    expect(typeof w.installed.check).toBe("function");
    expect(w.check("notifications", `murage-home://${HOME}`, { isMainFrame: true, requestingUrl: `murage-home://${HOME}/` }, w.contents)).toBe(true);
  });

  it("the microphone check agrees for this home", () => {
    const w = openCloud();
    expect(typeof w.installed.check, "the session has a permission check handler").toBe("function");
    expect(w.check("media", `murage-home://${HOME}`, { mediaType: "audio", isMainFrame: true }, w.contents)).toBe(true);
  });

  it("refuses another home's origin", () => {
    const w = openCloud();
    expect(w.request("media", topAudio(OTHER))).toBe(false);
  });

  it("refuses another home's origin in the notification check", () => {
    const w = openCloud();
    expect(typeof w.installed.check, "the session has a permission check handler").toBe("function");
    expect(w.check("notifications", `murage-home://${OTHER}`, { isMainFrame: true, requestingUrl: `murage-home://${OTHER}/` }, w.contents)).toBe(false);
  });

  it("refuses a subframe of this home", () => {
    const w = openCloud();
    expect(w.request("media", topAudio(HOME, { isMainFrame: false }))).toBe(false);
  });

  it("the check refuses a subframe and a frame Electron does not report as the top frame", () => {
    const w = openCloud();
    expect(typeof w.installed.check, "the session has a permission check handler").toBe("function");
    const answers = [{ isMainFrame: false }, {}].map((frame) => w.check("notifications", `murage-home://${HOME}`, { ...frame, requestingUrl: `murage-home://${HOME}/` }, w.contents));
    expect(answers).toEqual([false, false]);
  });

  it("the notification check refuses this home's browser pop-out page", () => {
    const w = openCloud();
    expect(typeof w.installed.check, "the session has a permission check handler").toBe("function");
    expect(w.check("notifications", `murage-home://${HOME}`, { isMainFrame: true, requestingUrl: `murage-home://${HOME}/?surface=browser-popout&bot=bot-1` }, w.contents)).toBe(false);
  });

  it("a frame-less check (a worker: no sender, isMainFrame false, no requestingUrl) is refused, even for this home", () => {
    const w = openCloud();
    expect(typeof w.installed.check, "the session has a permission check handler").toBe("function");
    expect([w.check("notifications", `murage-home://${HOME}`, { isMainFrame: false }), w.check("notifications", `murage-home://${OTHER}`, { isMainFrame: false }), w.check("media", `murage-home://${HOME}`, { isMainFrame: false, mediaType: "audio" })]).toEqual([false, false, false]);
  });

  it("a top-frame notification check with no sender (not the owned window) is refused", () => {
    const w = openCloud();
    expect(typeof w.installed.check, "the session has a permission check handler").toBe("function");
    expect(w.check("notifications", `murage-home://${HOME}`, { isMainFrame: true, requestingUrl: `murage-home://${HOME}/` })).toBe(false);
  });

  it("a microphone check with no sender (not the owned window) is refused", () => {
    const w = openCloud();
    expect(typeof w.installed.check, "the session has a permission check handler").toBe("function");
    expect(w.check("media", `murage-home://${HOME}`, { mediaType: "audio", isMainFrame: true, requestingUrl: `murage-home://${HOME}/` })).toBe(false);
  });

  it("refuses the camera, mixed media and the empty list Electron uses for screen capture", () => {
    const w = openCloud();
    const refused = [["video"], ["audio", "video"], []].map((mediaTypes) => w.request("media", topAudio(HOME, { mediaTypes })));
    expect(refused).toEqual([false, false, false]);
  });

  it("refuses a page that is not this home's own Cloud window (a pop-out on the same session)", () => {
    const w = openCloud();
    const popout = { isDestroyed: () => false };
    expect(w.request("media", topAudio(), popout)).toBe(false);
  });

  it("refuses every other permission, even for this home's top frame", () => {
    const w = openCloud();
    const refused = ["geolocation", "clipboard-read", "display-capture", "midi", "openExternal", "pointerLock"].map((permission) => w.request(permission, topAudio()));
    expect(refused).toEqual([false, false, false, false, false, false]);
  });
});
