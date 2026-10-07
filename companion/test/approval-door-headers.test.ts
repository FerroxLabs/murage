// SEC-006 D7: both doors tell the harness which paired device is answering a
// card, from the registry, never from anything the client sent, and only
// beside the launch credential.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { cookieName, createBrowserHandler, type BrowserDeviceStore } from "../src/browser.ts";
import { createProxyHandler } from "../src/proxy.ts";

const LAUNCH = "c".repeat(64);
const DEVICE_ID = "4b7a3f6c-1a52-4d1e-9c2e-5a0d7e41b9f3";
const KEY = "B".repeat(87);
const REGISTRY = { id: DEVICE_ID, cls: "app" as const, key: KEY };
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
const lying = {
  "content-type": "application/json",
  "x-murage-approval-device": "11111111-2222-4333-8444-555555555555",
  "x-murage-approval-class": "browser",
  "x-murage-approval-key": "A".repeat(87),
};
const stub = async () => {
  const seen: IncomingHttpHeaders[] = [];
  const harness = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  return { harness, seen, port: await listen(harness) };
};
const store = (): BrowserDeviceStore => ({
  redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null, signOutDevice: () => null,
  issuePushTokens: () => null, pushBinding: () => null, authenticatePush: () => null,
  approvalIdentity: (id) => (id === "paired" ? REGISTRY : null),
  resolveSession: (value) => value === "paired-session" ? {
    device: { id: "paired", name: "Fixture", cloudDesktopAccess: false }, session: { expiresAt: Date.now() + 60_000 }, sessionId: "rec",
  } : null,
  sessionDeadline: (id) => (id === "rec" ? Date.now() + 60_000 : null),
});

describe("the browser door's approval headers", () => {
  const run = async (companionToken: string | undefined, path: string) => {
    const { harness, seen, port: harnessPort } = await stub();
    const door = createServer(createBrowserHandler({
      harnessPort, companionToken, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices: store(),
    }));
    const port = await listen(door);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", body: "{}",
        headers: { ...lying, origin: `http://127.0.0.1:${port}`, cookie: `${cookieName("http")}=paired-session` },
      });
      return { status: res.status, headers: seen.at(-1) };
    } finally { await close(door); await close(harness); }
  };
  it("forwards the registry values and never the client's own", async () => {
    const { status, headers } = await run(LAUNCH, "/api/threads/t1/respond");
    expect(status).toBe(200);
    expect(headers!["x-murage-approval-device"]).toBe(DEVICE_ID);
    expect(headers!["x-murage-approval-class"]).toBe("app");
    expect(headers!["x-murage-approval-key"]).toBe(KEY);
    expect(headers!["x-murage-companion-token"]).toBe(LAUNCH);
  });
  it("gives no trust without the launch credential, and strips the client's headers", async () => {
    const { headers } = await run(undefined, "/api/threads/t1/respond");
    for (const name of ["x-murage-approval-device", "x-murage-approval-class", "x-murage-approval-key", "x-murage-companion-token"]) expect(headers![name]).toBeUndefined();
  });
  it("drops duplicate, case-variant and comma-joined client headers too", async () => {
    const { harness, seen, port: harnessPort } = await stub();
    const door = createServer(createBrowserHandler({
      harnessPort, companionToken: LAUNCH, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices: store(),
    }));
    const port = await listen(door);
    try {
      const statuses: number[] = [];
      await new Promise<void>((resolve, reject) => {
        // raw bytes, so duplicate names, mixed case and a comma-joined value reach the door as written
        const lines = [
          "POST /api/threads/t1/respond HTTP/1.1", `Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`,
          `Cookie: ${cookieName("http")}=paired-session`, "Content-Type: application/json", "Content-Length: 2", "Connection: close",
          "X-Murage-Approval-Class: browser", "x-murage-approval-class: browser", "X-MURAGE-APPROVAL-DEVICE: 11111111-2222-4333-8444-555555555555",
          `X-Murage-Approval-Key: ${"A".repeat(87)}, ${"B".repeat(87)}`, `X-Murage-Companion-Token: ${"d".repeat(64)}`, "", "{}",
        ];
        const socket = connect(port, "127.0.0.1", () => socket.write(lines.join("\r\n")));
        let text = "";
        socket.on("data", (chunk) => { text += String(chunk); });
        socket.on("error", reject);
        socket.on("close", () => { statuses.push(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)); resolve(); });
      });
      expect(statuses).toEqual([200]);
      const headers = seen.at(-1)!;
      expect(headers["x-murage-approval-device"]).toBe(DEVICE_ID);
      expect(headers["x-murage-approval-class"]).toBe("app");
      expect(headers["x-murage-approval-key"]).toBe(KEY);
      expect(headers["x-murage-companion-token"]).toBe(LAUNCH);
    } finally { await close(door); await close(harness); }
  });
  it("does not forward the bots respond route at all (harness-direct only)", async () => {
    const { status, headers } = await run(LAUNCH, "/api/bots/b1/respond");
    expect([403, 404]).toContain(status);
    expect(headers).toBeUndefined();
  });
});

describe("the device door's approval headers", () => {
  const run = async (companionToken: string | undefined, path: string) => {
    const { harness, seen, port: harnessPort } = await stub();
    const door = createServer(createProxyHandler({
      harnessPort, companionToken,
      authenticate: (t) => (t === "murage_tok" ? { id: "paired", cloudDesktopAccess: false } : null),
      approvalIdentity: (id) => (id === "paired" ? REGISTRY : null),
      redeem: () => ({ error: "unused" }), serverName: () => "Test",
    }));
    const port = await listen(door);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: "{}", headers: { ...lying, authorization: "Bearer murage_tok" } });
      return { status: res.status, headers: seen.at(-1) };
    } finally { await close(door); await close(harness); }
  };
  it("forwards the registry values and never the client's own", async () => {
    const { status, headers } = await run(LAUNCH, "/api/threads/t1/respond?x=1");
    expect(status).toBe(200);
    expect(headers!["x-murage-approval-device"]).toBe(DEVICE_ID);
    expect(headers!["x-murage-approval-class"]).toBe("app");
    expect(headers!["x-murage-approval-key"]).toBe(KEY);
  });
  it("gives no trust without the launch credential, and strips the client's headers", async () => {
    const { headers } = await run(undefined, "/api/threads/t1/respond");
    for (const name of ["x-murage-approval-device", "x-murage-approval-class", "x-murage-approval-key", "x-murage-companion-token"]) expect(headers![name]).toBeUndefined();
  });
  it("does not forward the bots respond route at all (harness-direct only)", async () => {
    const { status, headers } = await run(LAUNCH, "/api/bots/b1/respond");
    expect([403, 404]).toContain(status);
    expect(headers).toBeUndefined();
  });
});
