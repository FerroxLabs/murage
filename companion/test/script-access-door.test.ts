// Script access from a headless install (S1b review R2): the grant routes pass
// the companion only at the owner's own browser door, only with the launch
// proof. The matrix: who may reach them, and who may not.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { cookieName, createBrowserHandler, type BrowserDeviceStore } from "../src/browser.ts";

import { browserProofHeaders, denyReason, deviceProofHeaders, launchProofHeaders } from "../src/routes.ts";

const TOKEN = "e".repeat(64);
const ROUTES: Array<[string, string]> = [
  ["GET", "/api/mcp-grants"],
  ["POST", "/api/mcp-grants"],
  ["DELETE", "/api/mcp-grants/grant_1"],
];

describe("script access routes at the companion doors", () => {
  it.each(ROUTES)("browser door, signed in: %s %s is allowed", (method, path) => {
    expect(denyReason({ method, path, authenticated: true, surface: "browser" })).toBeNull();
  });

  it.each(ROUTES)("browser door, not signed in: %s %s is refused", (method, path) => {
    expect(denyReason({ method, path, authenticated: false, surface: "browser" })?.status).toBe(401);
  });

  it.each(ROUTES)("a paired phone (device door): %s %s is not a route", (method, path) => {
    expect(denyReason({ method, path, authenticated: true, surface: "device" })?.status).toBe(404);
    expect(denyReason({ method, path, authenticated: false, surface: "device" })?.status).toBe(401);
  });

  it.each(ROUTES)("owner proof is added at the browser door only: %s %s", (method, path) => {
    expect(browserProofHeaders(method, path, TOKEN)).toEqual({ "x-murage-companion-token": TOKEN });
    // no usable launch token, no proof: the harness then refuses it
    expect(browserProofHeaders(method, path, undefined)).toEqual({});
    expect(browserProofHeaders(method, path, "short")).toEqual({});
    // the phone's door and the shared owner-decision list never vouch for it
    expect(deviceProofHeaders(method, path, TOKEN)).toEqual({});
    expect(launchProofHeaders(method, path, TOKEN)).toEqual({});
  });

  it("only these exact routes, and no look-alike, ride the browser's new proof", () => {
    for (const [method, path] of [
      ["PATCH", "/api/mcp-grants"], ["PUT", "/api/mcp-grants/grant_1"], ["GET", "/api/mcp-grants/grant_1"],
      ["POST", "/api/mcp-grants/grant_1"], ["GET", "/api/mcp-grants/../bots"], ["GET", "/api/mcp-grants-x"], ["DELETE", "/api/mcp-grants/a/b"],
    ] as const) {
      expect(browserProofHeaders(method, path, TOKEN), `${method} ${path}`).toEqual({});
      expect(denyReason({ method, path, authenticated: true, surface: "browser" })?.status, `${method} ${path}`).toBe(404);
    }
  });
});

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
const store = (marked: ReadonlySet<string>): BrowserDeviceStore => ({
  redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null, signOutDevice: () => null,
  issuePushTokens: () => null, pushBinding: () => null, approvalIdentity: () => null, authenticatePush: () => null,
  resolveSession: (value) => (value === "owner-session" || value === "phone-session"
    ? {
        device: { id: value, name: value, cloudDesktopAccess: false, scriptAccess: marked.has(value) },
        session: { expiresAt: Date.now() + 60_000 },
        sessionId: `${value}-record`,
      }
    : null),
  sessionDeadline: () => Date.now() + 60_000,
});

describe("only a device the owner marked reaches script access at the browser door (S1c review)", () => {
  it("matrix: marked browser gets proof; unmarked phone, signed-out caller and look-alikes never reach the harness with it", async () => {
    const seen: Array<{ url: string; method: string; headers: IncomingHttpHeaders }> = [];
    const harness = createServer((req, res) => {
      seen.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ grants: [] }));
    });
    const harnessPort = await listen(harness);
    const door = createServer(createBrowserHandler({
      harnessPort, companionToken: TOKEN,
      identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices: store(new Set(["owner-session"])),
    }));
    const port = await listen(door);
    const as = (session: string | null) => ({
      "content-type": "application/json", origin: `http://127.0.0.1:${port}`,
      ...(session ? { cookie: `${cookieName("http")}=${session}` } : {}),
      "x-murage-companion-token": "attacker-supplied-proof",
    });
    try {
      for (const [method, path] of ROUTES) {
        const body = method === "POST" ? "{}" : undefined;
        // the owner's marked browser
        seen.length = 0;
        const owner = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: as("owner-session"), body });
        expect(owner.status, `owner ${method} ${path}`).toBe(200);
        expect(seen.at(-1)!.headers["x-murage-companion-token"]).toBe(TOKEN);
        // a phone paired with an ordinary code: refused, nothing forwarded
        seen.length = 0;
        const phone = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: as("phone-session"), body });
        expect(phone.status, `phone ${method} ${path}`).toBe(403);
        expect(await phone.text()).not.toContain(TOKEN);
        expect(seen).toEqual([]);
        // not signed in
        const nobody = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: as(null), body });
        expect(nobody.status, `anonymous ${method} ${path}`).toBe(401);
        expect(seen).toEqual([]);
      }
    } finally {
      await close(door);
      await close(harness);
    }
  });
});
