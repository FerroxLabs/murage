import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { companionMarked } from "../../server/sse-visibility.ts";
import { createCompanionAuthority } from "../../server/companion-authority.ts";
import { upgradeAdmitted, upgradePrincipalFor } from "../../server/voice/stream-route.ts";
import { forwardStreamUpgrade, redactStreamQuery, rejectUpgrade } from "../src/stream-upgrade.ts";

let harness: Server;
let companion: Server;
let seen: Record<string, string | undefined> = {};
let seenHeaders: IncomingHttpHeaders = {};
const slots = new Map<string, number>();
let alive = true;
const token = "a".repeat(64);

beforeEach(async () => {
  const wss = new WebSocketServer({ noServer: true });
  harness = createServer();
  harness.on("upgrade", (req, socket, head) => {
    seenHeaders = req.headers;
    seen = { host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie, url: req.url,
      proof: req.headers["x-murage-companion-token"] as string, principal: req.headers["x-murage-stream-principal"] as string };
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (d) => ws.send(d)));
  });
  await new Promise<void>((r) => harness.listen(0, "127.0.0.1", () => r()));
  const harnessPort = (harness.address() as AddressInfo).port;
  alive = true;
  companion = createServer();
  companion.on("upgrade", (req, socket, head) => {
    const replace = new URL(req.url ?? "/", "http://x").searchParams.get("replace") === "1";
    forwardStreamUpgrade(req, socket, head, { harnessPort, companionToken: token, principal: "companion:dev-1:sess-1", slots, maxOpen: replace ? 2 : 1, live: () => alive });
  });
  await new Promise<void>((r) => companion.listen(0, "127.0.0.1", () => r()));
});
afterEach(async () => {
  await new Promise<void>((r) => companion.close(() => r()));
  await new Promise<void>((r) => harness.close(() => r()));
  slots.clear();
});

const url = (path: string) => `ws://127.0.0.1:${(companion.address() as AddressInfo).port}${path}`;

describe("forwardStreamUpgrade", () => {
  it("forwards with a loopback Host, the launch proof and the principal, and never the Origin or cookie", async () => {
    const ws = new WebSocket(url("/api/voice/stream?ticket=abc"), { headers: { cookie: "s=secret-cookie" } });
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send("ping");
    expect(await new Promise<string>((r) => ws.once("message", (d) => r(String(d))))).toBe("ping");
    expect(seen).toMatchObject({ url: "/api/voice/stream?ticket=abc", proof: token, principal: "companion:dev-1:sess-1" });
    expect(seen.host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(seen.origin).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
    ws.close();
  });

  it("presents what the committed harness upgrade admission requires", async () => {
    // the harness's own pure checks (server/voice/stream-route.ts), fed the
    // headers the harness actually received from this forwarder
    const ws = new WebSocket(url("/api/voice/stream?ticket=abc"), { origin: "https://evil.example", headers: { cookie: "s=secret-cookie" } });
    await new Promise<void>((r) => ws.once("open", () => r()));
    const loopback = (host: string | undefined) => /^127\.0\.0\.1(:\d+)?$/.test(host ?? "");
    expect(upgradeAdmitted(seenHeaders, { host: loopback, origin: () => false })).toBe(true);
    const authorized = createCompanionAuthority(token);
    expect(upgradePrincipalFor(seenHeaders, { marked: companionMarked, authorized })).toBe("companion:dev-1:sess-1");
    // and the proof is the thing that matters: the wrong one is not a principal
    expect(upgradePrincipalFor(seenHeaders, { marked: companionMarked, authorized: createCompanionAuthority("b".repeat(64)) })).toBeNull();
    ws.close();
  });

  it("allows one socket per principal, two while replacing", async () => {
    const a = new WebSocket(url("/api/voice/stream?ticket=a"));
    await new Promise<void>((r) => a.once("open", () => r()));
    const b = new WebSocket(url("/api/voice/stream?ticket=b"));
    expect(String(await new Promise<Error>((r) => b.once("error", r)))).toMatch(/429/);
    const c = new WebSocket(url("/api/voice/stream?ticket=c&replace=1"));
    await new Promise<void>((r) => c.once("open", () => r()));
    a.close();
    c.close();
  });

  it("frees the slot and drops the upstream request when the client leaves during the handshake", async () => {
    harness.removeAllListeners("upgrade");
    let upstreamEnded = false;
    // a harness that never answers; it lets go once the companion drops the request
    harness.on("upgrade", (_req, socket) => socket.on("end", () => {
      upstreamEnded = true;
      socket.destroy();
    }));
    const a = new WebSocket(url("/api/voice/stream?ticket=a"));
    a.on("error", () => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(slots.get("companion:dev-1:sess-1")).toBe(1);
    a.terminate();
    await new Promise((r) => setTimeout(r, 100));
    expect(slots.get("companion:dev-1:sess-1") ?? 0).toBe(0);
    expect(upstreamEnded).toBe(true);
  });

  it("refuses the upgrade when the session ended during the handshake", async () => {
    alive = false;
    const a = new WebSocket(url("/api/voice/stream?ticket=a"));
    expect(String(await new Promise<Error>((r) => a.once("error", r)))).toMatch(/401/);
    expect(slots.get("companion:dev-1:sess-1") ?? 0).toBe(0);
  });

  it("masks the ticket and keyterms in any URL it hands to a logger", () => {
    expect(redactStreamQuery("/api/voice/stream?ticket=abc&keyterms=Sable&eagerness=low")).toBe("/api/voice/stream?ticket=redacted&keyterms=redacted&eagerness=low");
  });

  it("releases the slot when the socket closes", async () => {
    const a = new WebSocket(url("/api/voice/stream?ticket=a"));
    await new Promise<void>((r) => a.once("open", () => r()));
    a.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(slots.get("companion:dev-1:sess-1") ?? 0).toBe(0);
  });
});

describe("rejected upgrade sockets", () => {
  const rejecting = async (handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) => {
    const server = createServer();
    server.on("upgrade", handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, port: (server.address() as AddressInfo).port };
  };
  const upgradeRequest = "GET /api/voice/stream?ticket=t HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
  const crashes: Error[] = [];
  const record = (e: Error) => void crashes.push(e);
  beforeEach(() => void process.on("uncaughtException", record));
  afterEach(() => void process.off("uncaughtException", record));

  it("survives a client reset after the refusal (no uncaught ECONNRESET)", async () => {
    crashes.length = 0;
    const { server, port } = await rejecting((_req, socket) => rejectUpgrade(socket, 401, "sign in"));
    const client = connect(port, "127.0.0.1");
    client.on("error", () => undefined);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(upgradeRequest);
    await new Promise<void>((r) => client.once("data", () => r()));
    client.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(crashes).toEqual([]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("survives a reset on the 429 path, which runs before the forwarder listens", async () => {
    crashes.length = 0;
    const full = new Map([["p", 1]]);
    const { server, port } = await rejecting((req, socket, head) => forwardStreamUpgrade(req, socket, head, { harnessPort: 1, companionToken: token, principal: "p", slots: full, maxOpen: 1 }));
    const client = connect(port, "127.0.0.1");
    client.on("error", () => undefined);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(upgradeRequest);
    await new Promise<void>((r) => client.once("data", () => r()));
    client.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(crashes).toEqual([]);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("closes a refused socket whose client never closes, within the grace period", async () => {
    const { server, port } = await rejecting((_req, socket) => rejectUpgrade(socket, 401, "sign in"));
    const client = connect(port, "127.0.0.1");
    client.on("error", () => undefined);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(upgradeRequest);
    client.resume();
    const started = Date.now();
    await new Promise<void>((r) => client.once("close", () => r())); // the client never ends its side
    expect(Date.now() - started).toBeLessThan(2500);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("delivers the 504 when the harness never answers", async () => {
    const silent = createServer();
    silent.on("upgrade", (_req, socket) => socket.on("end", () => socket.destroy()));
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const { server, port } = await rejecting((req, socket, head) => forwardStreamUpgrade(req, socket, head, { harnessPort: (silent.address() as AddressInfo).port, companionToken: token, principal: "q", slots: new Map(), maxOpen: 1, handshakeMs: 100 }));
    const client = connect(port, "127.0.0.1");
    client.on("error", () => undefined);
    await new Promise<void>((r) => client.once("connect", () => r()));
    client.write(upgradeRequest);
    let text = "";
    client.on("data", (d) => (text += String(d)));
    await new Promise<void>((r) => client.once("close", () => r()));
    expect(text).toMatch(/^HTTP\/1\.1 504/);
    silent.closeAllConnections?.();
    await new Promise<void>((r) => silent.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });
});
