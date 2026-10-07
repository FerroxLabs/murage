import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnedMainSender, mainRendererOrigin } from "./main-trust.mjs";

const ORIGIN = "http://127.0.0.1:8799";

function fixture({ url = `${ORIGIN}/index.html`, destroyed = false, contentsDestroyed = false } = {}) {
  const mainFrame = { url, detached: false };
  const webContents = { mainFrame, isDestroyed: () => contentsDestroyed };
  const window = { webContents, isDestroyed: () => destroyed };
  return { window, webContents, mainFrame, event: { sender: webContents, senderFrame: mainFrame } };
}

test("accepts only the owned window's top frame on the expected origin", () => {
  const { window, event } = fixture();
  assert.equal(isOwnedMainSender(event, { window, origin: ORIGIN }), true);
  assert.equal(isOwnedMainSender(event, { window, origin: `${ORIGIN}/some/path` }), true, "origin comparison ignores path");
});

test("refuses a different window, a subframe and a detached frame", () => {
  const owned = fixture(), other = fixture();
  assert.equal(isOwnedMainSender(other.event, { window: owned.window, origin: ORIGIN }), false);
  const subframe = { url: `${ORIGIN}/`, detached: false };
  assert.equal(isOwnedMainSender({ sender: owned.webContents, senderFrame: subframe }, { window: owned.window, origin: ORIGIN }), false);
  owned.mainFrame.detached = true;
  assert.equal(isOwnedMainSender(owned.event, { window: owned.window, origin: ORIGIN }), false);
});

test("refuses navigated-away, look-alike and opaque origins", () => {
  for (const url of ["https://example.com/", "http://127.0.0.1:8800/", "http://localhost:8799/", "http://127.0.0.1:8799.evil.test/", "file:///index.html", "about:blank", "data:text/html,x", ""]) {
    const { window, event } = fixture({ url });
    assert.equal(isOwnedMainSender(event, { window, origin: ORIGIN }), false, url);
  }
});

test("fails closed on destroyed or missing state", () => {
  assert.equal(isOwnedMainSender(fixture({ destroyed: true }).event, { window: fixture({ destroyed: true }).window, origin: ORIGIN }), false);
  const gone = fixture({ contentsDestroyed: true });
  assert.equal(isOwnedMainSender(gone.event, { window: gone.window, origin: ORIGIN }), false);
  const { window, event, webContents } = fixture();
  assert.equal(isOwnedMainSender(undefined, { window, origin: ORIGIN }), false);
  assert.equal(isOwnedMainSender(event, { window: null, origin: ORIGIN }), false);
  assert.equal(isOwnedMainSender(event, { window, origin: "" }), false);
  assert.equal(isOwnedMainSender(event, { window, origin: "not a url" }), false);
  assert.equal(isOwnedMainSender(event, { window, origin: "file:///x" }), false, "opaque expected origin is never trusted");
  assert.equal(isOwnedMainSender({ sender: webContents, senderFrame: null }, { window, origin: ORIGIN }), false);
  assert.equal(isOwnedMainSender(event), false);
  const throwing = { webContents, isDestroyed: () => { throw new Error("destroyed"); } };
  assert.equal(isOwnedMainSender(event, { window: throwing, origin: ORIGIN }), false);
});

test("derives the packaged loopback origin or the dev origin", () => {
  assert.equal(mainRendererOrigin({ packaged: true, serverPort: 8799, devUrl: "http://127.0.0.1:5199" }), ORIGIN);
  assert.equal(mainRendererOrigin({ packaged: false, serverPort: 8799, devUrl: "http://127.0.0.1:5199/app" }), "http://127.0.0.1:5199");
  assert.equal(mainRendererOrigin({ packaged: false, serverPort: 8799, devUrl: "file:///x.html" }), null);
  assert.equal(mainRendererOrigin({ packaged: false, serverPort: 8799, devUrl: undefined }), null);
});

test("after a renderer restart the new top frame is accepted, stale and sub frames are not", () => {
  const { window, webContents } = fixture();
  // The process was replaced: the contents now report a new main frame, while the event carries
  // a different wrapper for the same frame in the same (new) process.
  webContents.getProcessId = () => 77;
  webContents.mainFrame = { url: `${ORIGIN}/`, detached: false, parent: null, processId: 77, routingId: 1 };
  const wrapper = { url: `${ORIGIN}/`, detached: false, parent: null, processId: 77, routingId: 1 };
  const ok = (frame, origin = ORIGIN) => isOwnedMainSender({ sender: webContents, senderFrame: frame }, { window, origin });
  assert.equal(ok(wrapper), true);
  assert.equal(ok({ ...wrapper, processId: 12 }), false, "frame left from the dead process");
  assert.equal(ok({ ...wrapper, routingId: 9 }), false, "another frame");
  assert.equal(ok({ ...wrapper, parent: webContents.mainFrame }), false, "subframe");
  assert.equal(ok({ ...wrapper, detached: true, processId: 12 }), false, "detached frame from the dead process");
  assert.equal(ok({ ...wrapper, detached: true, routingId: 9 }), false, "detached other frame");
  assert.equal(ok({ ...wrapper, url: "data:text/html,Reconnecting" }), false, "splash or recovery page");
  assert.equal(ok({ ...wrapper, url: `file:///recovery.html` }), false);
  assert.equal(ok(wrapper, "https://example.com"), false);
  const other = fixture();
  other.webContents.getProcessId = () => 77;
  assert.equal(isOwnedMainSender({ sender: other.webContents, senderFrame: wrapper }, { window, origin: ORIGIN }), false, "another window");
});

test("Electron 43 marks the live main frame detached after a renderer restart: still accepted", () => {
  // Measured on mobile.28: frame === mainFrame, detached=true, pid/rid match, origin matches.
  const { window, webContents } = fixture();
  webContents.getProcessId = () => 26;
  webContents.mainFrame = { url: `${ORIGIN}/`, detached: true, parent: null, processId: 26, routingId: 4 };
  const ok = (frame) => isOwnedMainSender({ sender: webContents, senderFrame: frame }, { window, origin: ORIGIN });
  assert.equal(ok(webContents.mainFrame), true);
  webContents.getProcessId = () => 31;
  assert.equal(ok(webContents.mainFrame), false, "detached main frame whose process is gone");
  webContents.getProcessId = () => 26;
  webContents.mainFrame.url = "data:text/html,Reconnecting";
  assert.equal(ok(webContents.mainFrame), false, "recovery page");
});
