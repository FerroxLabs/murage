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
