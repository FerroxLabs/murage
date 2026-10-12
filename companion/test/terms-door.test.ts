// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Terms acceptance through both companion doors. The stand-in harness answers
// like server/index.ts does: reading is open, accepting only beside the launch
// proof. A phone must reach both routes; a door without the proof never accepts.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { cookieName, createBrowserHandler, type BrowserDeviceStore } from "../src/browser.ts";
import { createProxyHandler } from "../src/proxy.ts";

const LAUNCH = "e".repeat(64);
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
const harnessStub = async () => {
  const seen: IncomingHttpHeaders[] = [];
  const harness = createServer((req, res) => {
    seen.push(req.headers);
    const owner = req.headers["x-murage-companion-token"] === LAUNCH;
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/api/terms") return send(owner ? 200 : 404, { accepted: false, version: "v" });
    if (req.method === "POST" && req.url === "/api/terms/accept") return send(owner ? 200 : 403, { accepted: owner, version: "v" });
    send(404, {});
  });
  return { harness, seen, port: await listen(harness) };
};
const store = (): BrowserDeviceStore => ({
  redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null, signOutDevice: () => null,
  issuePushTokens: () => null, pushBinding: () => null, authenticatePush: () => null,
  approvalIdentity: () => null,
  resolveSession: (value) => value === "paired-session" ? {
    device: { id: "paired", name: "Fixture", cloudDesktopAccess: false }, session: { expiresAt: Date.now() + 60_000 }, sessionId: "rec",
  } : null,
  sessionDeadline: (id) => (id === "rec" ? Date.now() + 60_000 : null),
});

type Call = (method: string, path: string, body?: string) => Promise<{ status: number; body: { accepted?: boolean } }>;
const withDevice = async (companionToken: string | undefined, use: (call: Call) => Promise<void>) => {
  const { harness, port: harnessPort } = await harnessStub();
  const door = createServer(createProxyHandler({
    harnessPort, companionToken,
    authenticate: (t) => (t === "murage_tok" ? { id: "paired", cloudDesktopAccess: false } : null),
    redeem: () => ({ error: "unused" }), serverName: () => "Test",
  }));
  const port = await listen(door);
  try {
    await use(async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers: { authorization: "Bearer murage_tok", "content-type": "application/json" } });
      return { status: res.status, body: (await res.json()) as { accepted?: boolean } };
    });
  } finally { await close(door); await close(harness); }
};
const withBrowser = async (companionToken: string | undefined, use: (call: Call) => Promise<void>) => {
  const { harness, port: harnessPort } = await harnessStub();
  const door = createServer(createBrowserHandler({
    harnessPort, companionToken, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices: store(),
  }));
  const port = await listen(door);
  try {
    await use(async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, body,
        headers: { origin: `http://127.0.0.1:${port}`, cookie: `${cookieName("http")}=paired-session`, "content-type": "application/json" },
      });
      return { status: res.status, body: (await res.json()) as { accepted?: boolean } };
    });
  } finally { await close(door); await close(harness); }
};

describe.each([["device door", withDevice], ["browser door", withBrowser]] as const)("terms through the %s", (_name, run) => {
  it("the owner's paired phone reads the status and accepts", async () => {
    await run(LAUNCH, async (call) => {
      expect((await call("GET", "/api/terms")).status).toBe(200);
      const accepted = await call("POST", "/api/terms/accept", JSON.stringify({ version: "v", ageConfirmed: true }));
      expect(accepted.status).toBe(200);
      expect(accepted.body.accepted).toBe(true);
    });
  });
  it("a door without the launch proof never accepts", async () => {
    await run(undefined, async (call) => {
      const accepted = await call("POST", "/api/terms/accept", JSON.stringify({ version: "v", ageConfirmed: true }));
      expect(accepted.status).toBe(403);
      expect(accepted.body.accepted).not.toBe(true);
    });
  });
});
