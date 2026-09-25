// The Inbox is scoped by the harness to the threads a companion can see, and
// the harness only believes it is talking to the companion when the private
// launch proof arrives with the request. So the door has to add that proof on
// these two routes — its own, never one a browser sent — and on no others.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { cookieName, createBrowserHandler, type BrowserDeviceStore } from "../src/browser.ts";

const PRIVATE_TOKEN = "c".repeat(64);
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
};
const devices: BrowserDeviceStore = {
  redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null, signOutDevice: () => null,
  resolveSession: value => value === "paired-session" ? {
    device: { id: "paired", name: "Fixture", cloudDesktopAccess: false }, session: { expiresAt: Date.now() + 60_000 },
    sessionId: "paired-session-record",
  } : null,
  sessionDeadline: id => id === "paired-session-record" ? Date.now() + 60_000 : null,
};

describe("the browser door's Inbox", () => {
  it("forwards its own launch proof on the two Inbox routes and nowhere else", async () => {
    const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    const harness = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const harnessPort = await listen(harness);
    const door = createServer(createBrowserHandler({
      harnessPort, companionToken: PRIVATE_TOKEN,
      identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices,
    }));
    const port = await listen(door);
    const headers = {
      "content-type": "application/json", origin: `http://127.0.0.1:${port}`,
      cookie: `${cookieName("http")}=paired-session`, "x-murage-companion-token": "attacker-supplied-proof",
    };
    try {
      const listed = await fetch(`http://127.0.0.1:${port}/api/inbox?view=decisions&pageSize=1`, { headers });
      expect(listed.status).toBe(200);
      expect(seen.at(-1)!.url).toBe("/api/inbox?view=decisions&pageSize=1");
      expect(seen.at(-1)!.headers["x-murage-companion-token"]).toBe(PRIVATE_TOKEN);
      expect(seen.at(-1)!.headers["x-murage-companion"]).toBe("1");
      expect(await listed.text()).not.toContain(PRIVATE_TOKEN);

      const marked = await fetch(`http://127.0.0.1:${port}/api/inbox/state`, { method: "POST", headers, body: "{}" });
      expect(marked.status).toBe(200);
      expect(seen.at(-1)!.headers["x-murage-companion-token"]).toBe(PRIVATE_TOKEN);

      const other = await fetch(`http://127.0.0.1:${port}/api/bots`, { headers });
      expect(other.status).toBe(200);
      expect(seen.at(-1)!.headers["x-murage-companion-token"]).toBeUndefined();
    } finally { await close(door); await close(harness); }
  });

  it("forwards its own launch proof on a call's two routes too", async () => {
    const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    const harness = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const harnessPort = await listen(harness);
    const door = createServer(createBrowserHandler({
      harnessPort, companionToken: PRIVATE_TOKEN,
      identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices,
    }));
    const port = await listen(door);
    const headers = {
      "content-type": "application/json", origin: `http://127.0.0.1:${port}`,
      cookie: `${cookieName("http")}=paired-session`, "x-murage-companion-token": "attacker-supplied-proof",
    };
    try {
      for (const route of ["voice-host", "call-note"]) {
        const answer = await fetch(`http://127.0.0.1:${port}/api/bots/bot_1/${route}`, { method: "POST", headers, body: "{}" });
        expect(answer.status, route).toBe(200);
        expect(seen.at(-1)!.url).toBe(`/api/bots/bot_1/${route}`);
        expect(seen.at(-1)!.headers["x-murage-companion-token"], route).toBe(PRIVATE_TOKEN);
      }
    } finally { await close(door); await close(harness); }
  });

  it("explains a call refused because the sidecar was launched without the proof", async () => {
    const door = createServer(createBrowserHandler({
      harnessPort: 1, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices,
    }));
    const port = await listen(door);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bots/bot_1/voice-host`, {
        method: "POST", body: "{}",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}`, cookie: `${cookieName("http")}=paired-session` },
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("calls require");
    } finally { await close(door); }
  });

  it("explains itself when the sidecar was launched without the proof", async () => {
    const door = createServer(createBrowserHandler({
      harnessPort: 1, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices,
    }));
    const port = await listen(door);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/inbox`, {
        headers: { origin: `http://127.0.0.1:${port}`, cookie: `${cookieName("http")}=paired-session` },
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("started together");
    } finally { await close(door); }
  });
});
