import assert from "node:assert/strict";
import test from "node:test";
import { closedVolumeProblem, CLOSED_VOLUME_SENTENCES } from "./backup-closed-volume.mjs";

// Device numbers as macOS reported them on the test Mac: "/", the system data
// volume, /Applications and the home folder share one; the external drive has another.
const devices = { "/": 16777229, "/System/Volumes/Data": 16777229, "/Applications/Murage.app/Contents/MacOS/Murage": 16777229,
  "/Users/me/.murage": 16777229, "/Users/me/Library/Application Support/murage": 16777229,
  "/Volumes/Mando/Murage.app/Contents/MacOS/Murage": 16777239, "/Volumes/Mando/murage-data": 16777239, "/Volumes/Second/Murage.app/Contents/MacOS/Murage": 16777300 };
const device = file => { if (!(file in devices)) throw Object.assign(Error("missing"), { code: "ENOENT" }); return devices[file]; };
const check = (app, data, extra = {}) => closedVolumeProblem({ appPaths: [app], dataPaths: data, device, platform: "darwin", ...extra });
const home = ["/Users/me/.murage", "/Users/me/Library/Application Support/murage"];

test("the app and data on this Mac's own disk pass", () => {
  assert.equal(check("/Applications/Murage.app/Contents/MacOS/Murage", home), null);
});
test("the app on an external drive is refused", () => {
  assert.equal(check("/Volumes/Mando/Murage.app/Contents/MacOS/Murage", home), "app");
});
test("the data folder on an external drive is refused", () => {
  assert.equal(check("/Applications/Murage.app/Contents/MacOS/Murage", ["/Volumes/Mando/murage-data", home[1]]), "data");
});
test("both elsewhere name both, and any other volume counts, not only external ones", () => {
  assert.equal(check("/Volumes/Mando/Murage.app/Contents/MacOS/Murage", ["/Volumes/Mando/murage-data"]), "both");
  assert.equal(check("/Volumes/Second/Murage.app/Contents/MacOS/Murage", home), "app");
});
test("other platforms and unreadable facts never block", () => {
  assert.equal(check("/Volumes/Mando/Murage.app/Contents/MacOS/Murage", home, { platform: "linux" }), null);
  assert.equal(check("/nowhere/Murage", ["/also/nowhere"]), null);
  assert.equal(closedVolumeProblem({ appPaths: ["/Volumes/Mando/Murage.app/Contents/MacOS/Murage"], dataPaths: [], platform: "darwin", device: () => { throw Error("no"); } }), null);
});
test("each sentence says where and what to do, in the copy rules", () => {
  for (const text of Object.values(CLOSED_VOLUME_SENTENCES)) {
    assert.match(text, /this Mac's own disk/); assert.match(text, /then turn this on again\.$/);
    assert.doesNotMatch(text, /—|\bsaf(?:e|ely)\b/i);
  }
});
test("the real stat of this computer's own folders passes", () => {
  assert.equal(closedVolumeProblem({ appPaths: [process.execPath], dataPaths: [process.env.HOME ?? "/"], platform: "darwin" }), process.execPath.startsWith("/Volumes/") ? "app" : null);
});
