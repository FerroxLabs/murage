import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createServerConnections, sameServerOrigin, serverOrigin } from "./server-connection.mjs";

test("server origins require an explicit HTTPS authority", () => {
  assert.equal(serverOrigin("https://EXAMPLE.com:443/"), "https://example.com");
  for (const value of [null, "example.com", " https://example.com", "https://example.com/path", "https://example.com/../", "https://example.com?", "https://example.com#", "https://user:pass@example.com", "https://example.com\\evil", "http://example.com", "http://localhost"]) assert.throws(() => serverOrigin(value));
  assert.equal(serverOrigin("http://127.0.0.1:8000", { allowLoopbackHttp: true }), "http://127.0.0.1:8000");
  assert.throws(() => serverOrigin("http://other.test", { allowLoopbackHttp: true }));
  assert.equal(sameServerOrigin("https://example.com/enter", "https://example.com"), true);
  for (const value of ["https://example.com.evil/", "https://example.com:444/", "http://example.com", "file:///tmp/test", "javascript:alert(1)", "https://user@example.com/"]) assert.equal(sameServerOrigin(value, "https://example.com"), false);
});

function fixture({ failCleanup = false, failLoad = false } = {}) {
  const partitions = new Map();
  const errors = [];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; }; }
    async loadURL(url) { this.url = url; if (failLoad) throw new Error("load failed"); }
    show() {} focus() {} isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const session = { fromPartition(name) {
    const partition = new EventEmitter(); partition.calls = [];
    partition.setPermissionRequestHandler = handler => { partition.requestPermission = handler; };
    partition.setPermissionCheckHandler = handler => { partition.checkPermission = handler; };
    for (const method of ["clearStorageData", "clearCache", "closeAllConnections"]) partition[method] = async () => { partition.calls.push(method); if (failCleanup && method === "clearStorageData") throw new Error("cleanup failed"); };
    partitions.set(name, partition); return partition;
  } };
  return { connections: createServerConnections({ BrowserWindow: Window, session, onError: error => errors.push(error) }), partitions, errors };
}

test("remote sessions and navigation never acquire desktop capabilities", async () => {
  const { connections, partitions } = fixture();
  const first = await connections.connect("https://one.test");
  const same = await connections.connect("https://one.test/");
  const second = await connections.connect("https://two.test");
  assert.equal(first, same);
  assert.equal(partitions.size, 2);
  assert.equal(first.url, "https://one.test/enter");
  assert.equal(first.options.webPreferences.preload, undefined);
  assert.equal(first.options.webPreferences.nodeIntegration, false);
  assert.equal(first.options.webPreferences.sandbox, true);
  assert.equal(first.options.webPreferences.contextIsolation, true);
  assert.equal(first.options.webPreferences.partition.startsWith("persist:"), false);
  assert.notEqual(first.options.webPreferences.partition, second.options.webPreferences.partition);
  assert.deepEqual(first.openHandler({ url: "https://one.test" }), { action: "deny" });
  const partition = partitions.get(first.options.webPreferences.partition);
  assert.equal(partition.checkPermission(), false);
  partition.requestPermission(null, "media", value => assert.equal(value, false));
  for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    let prevented = false;
    first.webContents.emit(name, { preventDefault() { prevented = true; } }, "https://evil.test");
    assert.equal(prevented, true, name);
  }
  await connections.disconnect(first);
  assert.deepEqual(partition.calls.sort(), ["clearCache", "clearStorageData", "closeAllConnections"]);
  assert.equal(second.isDestroyed(), false);
  assert.deepEqual(partitions.get(second.options.webPreferences.partition).calls, []);
  const replacement = await connections.connect("https://one.test");
  assert.notEqual(first.options.webPreferences.partition, replacement.options.webPreferences.partition);
});

test("load and cleanup failures are surfaced without leaving a remote window", async () => {
  const failedLoad = fixture({ failLoad: true });
  await assert.rejects(failedLoad.connections.connect("https://one.test"), /Could not connect/);
  assert.equal([...failedLoad.partitions.values()][0].calls.length, 3);
  const { connections, partitions } = fixture({ failCleanup: true });
  const window = await connections.connect("https://one.test");
  await assert.rejects(connections.disconnect(window), /could not be fully cleared/);
  assert.equal(window.isDestroyed(), true);
  assert.equal([...partitions.values()][0].calls.length, 3);
});
