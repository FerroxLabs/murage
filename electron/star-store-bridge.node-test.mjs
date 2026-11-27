// Row 50: the real preload, run with and without the store flag main passes (main's argument list is pinned in main-ipc-trust.node-test.mjs), says whether this is a store build.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://127.0.0.1:8799";

function bridgeFor(argv) {
  let exposed = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_key, value) => { exposed = value; } },
    ipcRenderer: { send() {}, sendSync: () => "", invoke: () => Promise.resolve(), on() {}, removeListener() {} },
    webUtils: { getPathForFile: () => "" },
  };
  vm.runInNewContext(fs.readFileSync(path.join(electronDir, "preload.cjs"), "utf8"), {
    require: () => electron, process: { platform: "darwin", argv: ["electron", `--murage-renderer-origin=${ORIGIN}`, ...argv] },
    location: { origin: ORIGIN }, URL, queueMicrotask, setTimeout, console,
  });
  assert.ok(exposed, "the main origin gets the bridge");
  return exposed;
}

test("the store flag makes storeBuild true; without it the window is not a store build", () => {
  assert.equal(bridgeFor(["--murage-store=1"]).storeBuild, true);
  assert.equal(bridgeFor([]).storeBuild, false);
  assert.equal(bridgeFor(["--murage-store=0"]).storeBuild, false);
});
