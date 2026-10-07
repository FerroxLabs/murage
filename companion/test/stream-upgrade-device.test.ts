// The streaming-voice websocket on the device door (paired native clients),
// against a fake harness: what is asserted is what the harness received.
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { createConnectedDeviceTracker } from "../src/connected-devices.ts";
import { createDeviceStreamUpgrade, createProxyHandler, type ProxyOptions } from "../src/proxy.ts";

const proof = "e".repeat(64);
const GOOD = "murage_dev_good_bearer";
let revoked = false;
const tracker = createConnectedDeviceTracker();
let harness: Server;
let door: Server;
let doorPort = 0;
let upgraded: IncomingMessage | null = null;
let ticketHeaders: IncomingMessage["headers"] | null = null;
let upgradeCount = 0;
const wss = new WebSocketServer({ noServer: true });

const options = (harnessPort: number, companionToken: string | undefined): ProxyOptions => ({
  harnessPort,
  companionToken,
  authenticate: (token) => (token === GOOD && !revoked ? { id: "dev_9", cloudDesktopAccess: false } : null),
  redeem: () => ({ error: "no" }),
  serverName: () => "test",
  connected: tracker.open,
});

beforeAll(async () => {
  harness = createServer((req, res) => {
    ticketHeaders = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  harness.on("upgrade", (req, socket, head) => {
    upgradeCount += 1;
    upgraded = req;
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (d) => ws.send(d)));
  });
  await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
  const harnessPort = (harness.address() as AddressInfo).port;
  door = createServer(createProxyHandler(options(harnessPort, proof)));
  door.on("upgrade", createDeviceStreamUpgrade(options(harnessPort, proof)));
  await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
  doorPort = (door.address() as AddressInfo).port;
});
afterAll(async () => {
  door.closeAllConnections?.();
  await new Promise<void>((r) => door.close(() => r()));
  harness.closeAllConnections?.();
  await new Promise<void>((r) => harness.close(() => r()));
  wss.close();
});

const connect = (headers: Record<string, string>, origin?: string) =>
  new WebSocket(`ws://127.0.0.1:${doorPort}/api/voice/stream?ticket=t`, { ...(origin ? { origin } : {}), headers });
const refusal = (ws: WebSocket) => new Promise<string>((r) => ws.once("error", (e) => r(String(e))));

describe("device door stream upgrade", () => {
  it("refuses an upgrade carrying an Origin, 403, even with a good bearer", async () => {
    const before = upgradeCount;
    expect(await refusal(connect({ authorization: `Bearer ${GOOD}` }, "https://evil.example"))).toMatch(/403/);
    expect(upgradeCount).toBe(before);
  });

  it("refuses without a valid bearer, 401", async () => {
    const before = upgradeCount;
    expect(await refusal(connect({}))).toMatch(/401/);
    expect(await refusal(connect({ authorization: "Bearer nope" }))).toMatch(/401/);
    expect(upgradeCount).toBe(before);
  });

  it("forwards with a bearer: principal companion:<deviceId>:bearer, the proof, no bearer upstream", async () => {
    const ws = connect({ authorization: `Bearer ${GOOD}` });
    await new Promise<void>((r) => ws.once("open", () => r()));
    expect(upgraded?.headers["x-murage-stream-principal"]).toBe("companion:dev_9:bearer");
    expect(upgraded?.headers["x-murage-companion-token"]).toBe(proof);
    expect(upgraded?.headers.authorization).toBeUndefined();
    expect(upgraded?.headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
    const closed = new Promise<void>((r) => ws.once("close", () => r()));
    expect(tracker.disconnect("dev_9")).toBe(true); // a revoke ends it
    await closed;
  });

  it("answers 503 without the launch proof", async () => {
    const bare = createServer();
    bare.on("upgrade", createDeviceStreamUpgrade(options(1, undefined)));
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const ws = new WebSocket(`ws://127.0.0.1:${(bare.address() as AddressInfo).port}/api/voice/stream`, { headers: { authorization: `Bearer ${GOOD}` } });
    expect(await refusal(ws)).toMatch(/503/);
    await new Promise<void>((r) => bare.close(() => r()));
  });

  it("stamps the ticket POST with the device principal and the proof, and drops a client's own copy", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port: doorPort, path: "/api/voice/stream/ticket", method: "POST",
          headers: { authorization: `Bearer ${GOOD}`, "content-type": "application/json", "x-murage-stream-principal": "desktop" } },
        (res) => { res.resume(); res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`)))); },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(ticketHeaders?.["x-murage-stream-principal"]).toBe("companion:dev_9:bearer");
    expect(ticketHeaders?.["x-murage-companion-token"]).toBe(proof);
  });
});

describe("device door hardening", () => {
  it("answers 503 to the ticket POST without the launch proof", async () => {
    const bare = createServer(createProxyHandler(options(1, undefined)));
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: (bare.address() as AddressInfo).port, path: "/api/voice/stream/ticket", method: "POST", headers: { authorization: `Bearer ${GOOD}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(503);
    await new Promise<void>((r) => bare.close(() => r()));
  });

  it("survives a reset after a 401 refusal", async () => {
    const crashes: Error[] = [];
    const record = (e: Error) => void crashes.push(e);
    process.on("uncaughtException", record);
    const client = netConnect(doorPort, "127.0.0.1");
    client.on("error", () => undefined);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write("GET /api/voice/stream HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await new Promise<void>((r) => client.once("data", () => r()));
    client.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 200));
    process.off("uncaughtException", record);
    expect(crashes).toEqual([]);
  });
});
