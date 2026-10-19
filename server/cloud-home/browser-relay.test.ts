// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { BrowserDocumentGuard } from "../browser-document-guard.ts";
import { cloudRelayConnection } from "./browser-relay.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { vi.unstubAllEnvs(); while (cleanups.length) cleanups.pop()!(); });

// A fake relay child plus an in-process WebSocket server on the far end of its stdio.
function fakeRelay() {
  const toServer = new PassThrough(), fromServer = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: toServer, stdout: fromServer, stderr: new PassThrough(), kill: vi.fn((signal?: string) => { setImmediate(() => child.emit("close", null, signal)); return true; }) });
  const far = new Duplex({ read() {}, write(chunk, _e, cb) { fromServer.write(chunk, cb); } });
  Object.assign(far, { setTimeout() { return far; }, setNoDelay() { return far; }, setKeepAlive() { return far; } });
  toServer.on("data", chunk => far.push(chunk)); toServer.on("end", () => far.push(null));
  const http = createServer(); const seen: { host?: string; url?: string; methods: string[] } = { methods: [] };
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (socket, request) => {
    seen.host = request.headers.host; seen.url = request.url;
    socket.on("message", raw => { const message = JSON.parse(raw.toString()); seen.methods.push(message.method); socket.send(JSON.stringify({ id: message.id, result: { targetInfos: [] } })); });
  });
  http.emit("connection", far);
  cleanups.push(() => { wss.close(); far.destroy(); });
  return { child: child as unknown as ChildProcessWithoutNullStreams, raw: child, seen, wss };
}
const cdp = { cdpUrl: "ws://127.0.0.1:9/devtools/browser/abc" };

it("the guard speaks CDP over the relay child's stdio, never a TCP dial, and closing it kills the child", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const relay = fakeRelay(); const spawnRelay = vi.fn(() => relay.child);
  // Port 9 (discard) is closed: only the stdio path can answer.
  const guard = new BrowserDocumentGuard(async () => cdp, { connection: cloudRelayConnection("cdp", { MURAGE_CLOUD_BROWSER_BOT: "bot-1" }, spawnRelay) });
  await expect(guard.protected()).rejects.toThrow("Browser document inventory unavailable");
  expect(spawnRelay).toHaveBeenCalledWith(["relay", "cdp"], { MURAGE_CLOUD_BROWSER_BOT: "bot-1" });
  expect(relay.seen).toMatchObject({ host: "127.0.0.1:9", url: "/devtools/browser/abc", methods: ["Target.getTargets"] });
  guard.close();
  expect(relay.raw.kill).toHaveBeenCalledWith("SIGTERM");
  expect((relay.child.stdin as PassThrough).destroyed).toBe(true);
});
it("the relay child exiting closes the WebSocket and the guard reports it unavailable", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const relay = fakeRelay();
  const guard = new BrowserDocumentGuard(async () => cdp, { connection: cloudRelayConnection("cdp", {}, () => relay.child) });
  await expect(guard.protected()).rejects.toThrow("inventory");
  relay.raw.emit("close", 1, null);
  await new Promise(resolve => setImmediate(resolve));
  await expect(guard.protected()).rejects.toThrow(); // reconnects through a fresh relay child, which the fake no longer serves
});
it("a relay that cannot start surfaces as the guard's unavailable error", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const guard = new BrowserDocumentGuard(async () => cdp, { connection: cloudRelayConnection("cdp", {}, () => { throw new Error("cleanup pending"); }) });
  await expect(guard.protected()).rejects.toThrow("Browser guard unavailable");
  const none = new BrowserDocumentGuard(async () => cdp, { connection: cloudRelayConnection("cdp", {}, () => null) });
  await expect(none.protected()).rejects.toThrow("Browser guard unavailable");
});
it("uses the stream relay shape for the stream", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const relay = fakeRelay(); const spawnRelay = vi.fn(() => relay.child);
  const duplex = cloudRelayConnection("stream", {}, spawnRelay)!();
  expect(spawnRelay).toHaveBeenCalledWith(["relay", "stream"], {});
  duplex.destroy();
});
it("desktop gets no relay and the guard still dials TCP", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  expect(cloudRelayConnection("cdp", {}, () => { throw new Error("must not spawn"); })).toBeUndefined();
  const http = createServer(); const wss = new WebSocketServer({ server: http }); let methods: string[] = [];
  wss.on("connection", socket => socket.on("message", raw => { const message = JSON.parse(raw.toString()); methods.push(message.method); socket.send(JSON.stringify({ id: message.id, result: { targetInfos: [] } })); }));
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve)); cleanups.push(() => { wss.close(); http.close(); });
  const port = (http.address() as AddressInfo).port;
  const guard = new BrowserDocumentGuard(async () => ({ cdpUrl: `ws://127.0.0.1:${port}/devtools/browser/abc` }));
  await expect(guard.protected()).rejects.toThrow("Browser document inventory unavailable");
  expect(methods).toEqual(["Target.getTargets"]); guard.close();
});
