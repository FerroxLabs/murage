// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L4B-PHONE-TURNSTATE (1.0.20, designs/L4B-PHONE-TURNSTATE-1020.md): the help panel's turn-state read through both companion
// doors. The stand-in harness answers like server/index.ts does (mayApprove): a real state only beside the launch proof, else 403.
// A paired phone and a signed-in browser get the real state; a door without the secret gets 403; an unpaired or revoked device
// never reaches the harness; only GET turn-state gains the proof.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { cookieName, createBrowserHandler, type BrowserDeviceStore } from "../src/browser.ts";
import { createProxyHandler } from "../src/proxy.ts";
import { browserProofHeaders, deviceProofHeaders, launchProofHeaders } from "../src/routes.ts";

const LAUNCH = "e".repeat(64);
const PATH = "/api/bots/bot_123/turn-state";
const QUERY = "?threadId=thread_1&sendId=help-question-0001&turnId=turn-9";
const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};
const harnessStub = async () => {
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];
  const harness = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const owner = req.headers["x-murage-companion-token"] === LAUNCH;
    const forwarded = req.headers["x-murage-door-token"] === LAUNCH;
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    // the route gate (no door proof: 404, server/route-policy.ts), then mayApprove (403)
    if (req.url?.startsWith(`${PATH}?`)) {
      if (!forwarded) return send(404, { error: "no such route" });
      return owner ? send(200, { state: "running" }) : send(403, { error: "Turn state is read in the Murage app or on your paired phone." });
    }
    send(404, {});
  });
  return { harness, seen, port: await listen(harness) };
};
let revoked = false;
const store = (): BrowserDeviceStore => ({
  redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null, signOutDevice: () => null,
  issuePushTokens: () => null, pushBinding: () => null, authenticatePush: () => null,
  approvalIdentity: () => null,
  resolveSession: (value) => value === "paired-session" && !revoked ? {
    device: { id: "paired", name: "Fixture", cloudDesktopAccess: false }, session: { expiresAt: Date.now() + 60_000 }, sessionId: "rec",
  } : null,
  sessionDeadline: (id) => (id === "rec" && !revoked ? Date.now() + 60_000 : null),
});

type Reply = { status: number; body: { state?: string; error?: string } };
type Call = (method: string, path: string, credential?: string) => Promise<Reply>;
type Seen = Awaited<ReturnType<typeof harnessStub>>["seen"];
const withDevice = async (companionToken: string | undefined, use: (call: Call, seen: Seen) => Promise<void>) => {
  const { harness, seen, port: harnessPort } = await harnessStub();
  const door = createServer(createProxyHandler({
    harnessPort, companionToken,
    authenticate: (t) => (t === "murage_tok" && !revoked ? { id: "paired", cloudDesktopAccess: false } : null),
    redeem: () => ({ error: "unused" }), serverName: () => "Test",
  }));
  const port = await listen(door);
  try {
    await use(async (method, path, credential = "murage_tok") => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${credential}` } });
      return { status: res.status, body: (await res.json()) as Reply["body"] };
    }, seen);
  } finally { await close(door); await close(harness); }
};
const withBrowser = async (companionToken: string | undefined, use: (call: Call, seen: Seen) => Promise<void>) => {
  const { harness, seen, port: harnessPort } = await harnessStub();
  const door = createServer(createBrowserHandler({
    harnessPort, companionToken, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }), devices: store(),
  }));
  const port = await listen(door);
  try {
    await use(async (method, path, credential = "paired-session") => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: { origin: `http://127.0.0.1:${port}`, cookie: `${cookieName("http")}=${credential}` },
      });
      return { status: res.status, body: (await res.json()) as Reply["body"] };
    }, seen);
  } finally { await close(door); await close(harness); }
};

describe.each([["device door", withDevice], ["browser door", withBrowser]] as const)("turn-state through the %s", (_name, run) => {
  it("the owner's paired device gets the real state, with the query unchanged", async () => {
    revoked = false;
    await run(LAUNCH, async (call, seen) => {
      expect(await call("GET", `${PATH}${QUERY}`)).toEqual({ status: 200, body: { state: "running" } });
      expect(seen.at(-1)?.url).toBe(`${PATH}${QUERY}`);
      expect(seen.at(-1)?.headers["x-murage-companion-token"]).toBe(LAUNCH);
    });
  });
  it("a door without the launch secret is refused, never a state", async () => {
    revoked = false;
    await run(undefined, async (call, seen) => {
      const reply = await call("GET", `${PATH}${QUERY}`);
      expect([403, 404]).toContain(reply.status);
      expect(reply.body.state).toBeUndefined();
      expect(seen.at(-1)?.headers["x-murage-companion-token"]).toBeUndefined();
    });
  });
  it("an unpaired or revoked device never reaches the harness", async () => {
    revoked = false;
    await run(LAUNCH, async (call, seen) => {
      const stranger = await call("GET", `${PATH}${QUERY}`, "not-a-pairing");
      expect(stranger.status).toBe(401);
      expect(stranger.body.state).toBeUndefined();
      revoked = true;
      const gone = await call("GET", `${PATH}${QUERY}`);
      expect(gone.status).toBe(401);
      expect(gone.body.state).toBeUndefined();
      expect(seen).toHaveLength(0);
    });
    revoked = false;
  });
});

describe("turn-state proof is GET turn-state only", () => {
  it("adds the launch proof for GET turn-state on both doors", () => {
    for (const proof of [launchProofHeaders, deviceProofHeaders, browserProofHeaders]) {
      expect(proof("GET", PATH, LAUNCH)).toEqual({ "x-murage-companion-token": LAUNCH });
      expect(proof("GET", PATH, undefined)).toEqual({});
      expect(proof("GET", PATH, "short")).toEqual({});
    }
  });
  it("adds nothing for another method or a neighbouring path", () => {
    for (const proof of [launchProofHeaders, deviceProofHeaders, browserProofHeaders]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(proof(method, PATH, LAUNCH)).toEqual({});
      for (const path of ["/api/bots/bot_123/turn-state/x", "/api/bots/bot_123/turn-states", "/api/bots/a/b/turn-state", "/api/threads/t/turn-state"]) {
        expect(proof("GET", path, LAUNCH)).toEqual({});
      }
    }
  });
});
