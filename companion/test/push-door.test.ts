import { readFileSync } from "node:fs";
import { Agent, createServer, request, type IncomingMessage, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarnessCall, handlePushBearer, handlePushSession, isPushSessionRoute, pushBearerScope, type HarnessCall, type PushDoorOptions } from "../src/push-door.ts";
import { createBrowserHandler, originGate, type BoundIdentity, type BrowserDeviceStore } from "../src/browser.ts";

const B = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const PROOF = "a".repeat(64);
const REF = "9b1f0c4e2a7d3e8f5c6b1a0d9e8f7c6b5a4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f";
const DETAIL = "murage_pd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
function options(harness: HarnessCall, known = true): PushDoorOptions {
  return {
    companionToken: PROOF, harness,
    devices: {
      authenticatePush: vi.fn((token: string | undefined, scope: "detail" | "respond") => (known && token === DETAIL && scope === "detail" ? { deviceId: "d1", bindingId: B } : null)),
      issuePushTokens: vi.fn(() => ({ detail: DETAIL, respond: "murage_pr_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", expiresAt: 99 })),
      pushBinding: vi.fn(() => B),
    },
  };
}

describe("which routes are push routes", () => {
  it("forwards preview settings only as session routes with the proven device identity", async () => {
    const path = "/api/mobile/push/preferences";
    for (const method of ["GET", "POST"]) {
      expect(isPushSessionRoute(method, path)).toBe(true);
      expect(pushBearerScope(method, path)).toBeNull();
      const answer = { status: 200, body: { previewContent: method === "POST" } };
      const harness = vi.fn<HarnessCall>(async () => answer);
      const body = Buffer.from(JSON.stringify({ previewContent: true }));
      expect(await handlePushSession({ method, path, deviceId: "d1", body }, options(harness))).toEqual(answer);
      expect(harness).toHaveBeenCalledWith({ method, path, body: method === "POST" ? body : null,
        headers: expect.objectContaining({ "x-murage-push-device": "d1", "x-murage-companion-token": PROOF }) });
    }
  });
  it("names exactly three bearer routes and two session routes", () => {
    expect(pushBearerScope("GET", `/api/mobile/push/${REF}`)).toBe("detail");
    expect(pushBearerScope("GET", "/api/mobile/push/pending")).toBe("detail");
    expect(pushBearerScope("POST", "/api/mobile/push/respond")).toBe("respond");
    expect(pushBearerScope("POST", `/api/mobile/push/${REF}`)).toBeNull();
    expect(pushBearerScope("GET", "/api/mobile/push/enrol")).toBeNull();
    expect(pushBearerScope("GET", `/api/mobile/push/${REF.toUpperCase()}`)).toBeNull();
    expect(isPushSessionRoute("POST", "/api/mobile/push/enrol")).toBe(true);
    expect(isPushSessionRoute("POST", "/api/mobile/push/tokens")).toBe(true);
    expect(isPushSessionRoute("GET", "/api/mobile/push/tokens")).toBe(false);
  });
});

describe("bearer routes", () => {
  it("forward with the proof and the proven ids, never the token", async () => {
    const harness = vi.fn<HarnessCall>(async () => ({ status: 200, body: { title: "Scout needs approval", body: "rm x", target: { bindingId: B, threadId: "t1" } } }));
    const result = await handlePushBearer({ method: "GET", path: `/api/mobile/push/${REF}`, authorization: `Bearer ${DETAIL}`, body: null }, options(harness));
    expect(result.status).toBe(200);
    const sent = harness.mock.calls[0][0];
    expect(sent.headers).toEqual({ accept: "application/json", "x-murage-companion": "1", "x-murage-companion-token": PROOF, "x-murage-push-device": "d1", "x-murage-push-binding": B, "x-murage-push-scope": "detail" });
    expect(JSON.stringify(sent)).not.toContain(DETAIL);
  });

  it("a revoked device's detail token answers 401 and reaches nothing", async () => {
    const harness = vi.fn<HarnessCall>();
    const result = await handlePushBearer({ method: "GET", path: `/api/mobile/push/${REF}`, authorization: `Bearer ${DETAIL}`, body: null }, options(harness, false));
    expect(result).toEqual({ status: 401, body: { error: "sign in" } });
    expect(harness).not.toHaveBeenCalled();
  });

  it("answers 503 when the door has no usable launch proof", async () => {
    const o = { ...options(vi.fn<HarnessCall>()), companionToken: undefined };
    expect(await handlePushBearer({ method: "GET", path: "/api/mobile/push/pending", authorization: `Bearer ${DETAIL}`, body: null }, o))
      .toEqual({ status: 503, body: { error: "Notifications need Murage and its companion to be started together by the desktop app or murage start." } });
  });
});

describe("session routes", () => {
  it("enrol forwards the grant, then mints the tokens for the binding the harness made", async () => {
    const harness = vi.fn<HarnessCall>(async () => ({ status: 200, body: { bindingId: B } }));
    const o = options(harness);
    const result = await handlePushSession({ method: "POST", path: "/api/mobile/push/enrol", deviceId: "d1", body: Buffer.from(JSON.stringify({ grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" })) }, o);
    expect(result).toEqual({ status: 200, body: { bindingId: B, detail: DETAIL, respond: "murage_pr_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", expiresAt: 99 } });
    expect(harness.mock.calls[0][0]).toMatchObject({ method: "POST", path: "/api/mobile/push/enrol", headers: { "x-murage-push-device": "d1" } });
    expect(o.devices.issuePushTokens).toHaveBeenCalledWith("d1", B);
  });

  it("enrol refuses a body that is not exactly {grant}", async () => {
    const harness = vi.fn<HarnessCall>();
    const result = await handlePushSession({ method: "POST", path: "/api/mobile/push/enrol", deviceId: "d1", body: Buffer.from(JSON.stringify({ grant: "x", more: 1 })) }, options(harness));
    expect(result.status).toBe(400);
    expect(harness).not.toHaveBeenCalled();
  });

  it("tokens reissues only when the harness still holds the same binding", async () => {
    const same = await handlePushSession({ method: "POST", path: "/api/mobile/push/tokens", deviceId: "d1", body: Buffer.from("{}") },
      options(async () => ({ status: 200, body: { bindingId: B } })));
    expect(same.status).toBe(200);
    const lost = await handlePushSession({ method: "POST", path: "/api/mobile/push/tokens", deviceId: "d1", body: Buffer.from("{}") },
      options(async () => ({ status: 404, body: { code: "not_enrolled" } })));
    expect(lost).toEqual({ status: 404, body: { code: "not_enrolled", error: "This phone is not set up for notifications yet." } });
  });

  // Only the harness saying "not enrolled" may make the phone enrol afresh
  // (a replace): an outage must never read as one.
  const tokens = (harness: HarnessCall) =>
    handlePushSession({ method: "POST", path: "/api/mobile/push/tokens", deviceId: "d1", body: Buffer.from("{}") }, options(harness));
  it("a harness that is not answering (502 or 503) is 503, not not_enrolled", async () => {
    for (const answer of [
      { status: 502, body: { error: "Murage is not answering on this computer." } },
      { status: 503, body: { code: "push_off" } },
      { status: 500, body: {} },
    ]) {
      const o = options(async () => answer);
      const result = await handlePushSession({ method: "POST", path: "/api/mobile/push/tokens", deviceId: "d1", body: Buffer.from("{}") }, o);
      expect(result.status, String(answer.status)).toBe(503);
      expect((result.body as { code?: unknown }).code).not.toBe("not_enrolled");
      expect(o.devices.issuePushTokens).not.toHaveBeenCalled();
    }
  });
  it("push off on the harness reaches the page as push_off, and mints nothing", async () => {
    const o = options(async () => ({ status: 503, body: { code: "push_off" } }));
    const result = await handlePushSession({ method: "POST", path: "/api/mobile/push/tokens", deviceId: "d1", body: Buffer.from("{}") }, o);
    expect(result).toEqual({ status: 503, body: { code: "push_off", error: "Notifications are turned off on this computer." } });
    expect(o.devices.issuePushTokens).not.toHaveBeenCalled();
  });
  it("a harness 404 without code not_enrolled is 503", async () => {
    for (const body of [{}, { error: "not found" }, { code: "something_else" }, null]) {
      expect((await tokens(async () => ({ status: 404, body }))).status, JSON.stringify(body)).toBe(503);
    }
  });
  it("a harness holding another binding, or a door that knows none, is still not_enrolled", async () => {
    expect((await tokens(async () => ({ status: 200, body: { bindingId: "4f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3" } }))).status).toBe(404);
    const o = options(async () => ({ status: 200, body: { bindingId: B } }));
    o.devices.pushBinding = vi.fn(() => null);
    expect((await handlePushSession({ method: "POST", path: "/api/mobile/push/tokens", deviceId: "d1", body: Buffer.from("{}") }, o)).status).toBe(404);
  });
});

describe("the origin gate", () => {
  const identity: BoundIdentity = { scheme: "https", hosts: new Set(["mac.tailnet123.ts.net"]) };
  const req = (headers: Record<string, string>, method = "GET", url = `/api/mobile/push/${REF}`) =>
    ({ method, url, headers: { host: "mac.tailnet123.ts.net", ...headers } }) as unknown as IncomingMessage;

  it("lets a native bearer request through without Origin or Sec-Fetch", () => {
    expect(originGate(req({ authorization: `Bearer ${DETAIL}` }), identity)).toBeNull();
  });
  it("a bearer route with no Authorization header faces the origin gate", () => {
    expect(originGate(req({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }), identity)?.status).toBe(403);
  });
  it("still applies the Host allowlist", () => {
    const foreign = { method: "GET", url: `/api/mobile/push/${REF}`, headers: { host: "evil.example", authorization: `Bearer ${DETAIL}` } } as unknown as IncomingMessage;
    expect(originGate(foreign, identity)?.status).toBe(403);
  });
  it("a bearer on any other route still faces the origin gate", () => {
    const hostile = { "sec-fetch-site": "cross-site", origin: "https://evil.example", authorization: `Bearer ${DETAIL}` };
    for (const [method, url] of [
      ["GET", "/api/threads"],
      ["POST", "/api/mobile/push/enrol"],
      ["POST", "/api/mobile/push/tokens"],
      ["POST", `/api/mobile/push/${REF}`],
      ["GET", "/api/mobile/push/respond"],
      ["GET", `/api/mobile/push/${REF}/extra`],
      ["GET", "/api/mobile/push/binding"],
    ]) {
      expect(originGate(req(hostile, method, url), identity)?.status, `${method} ${url}`).toBe(403);
    }
  });
  it("a malformed or wrongly scoped bearer on a push route faces the origin gate", () => {
    const hostile = { "sec-fetch-site": "cross-site", origin: "https://evil.example" };
    const RESPOND = "murage_pr_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    for (const authorization of ["Bearer", "Bearer x", "Basic abc", `Bearer ${DETAIL}x`, `Bearer ${RESPOND}`]) {
      expect(originGate(req({ ...hostile, authorization }), identity)?.status, authorization).toBe(403);
    }
    expect(originGate(req({ ...hostile, authorization: `Bearer ${DETAIL}` }, "POST", "/api/mobile/push/respond"), identity)?.status).toBe(403);
    expect(originGate(req({ authorization: `Bearer ${RESPOND}` }, "POST", "/api/mobile/push/respond"), identity)).toBeNull();
  });
});

describe("through the door", () => {
  const RESPOND = "murage_pr_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const HOST = "mac.tailnet123.ts.net";
  let harness: Server;
  let door: Server;
  let doorPort = 0;
  let seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const store: BrowserDeviceStore = {
    redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null, signOutDevice: () => null,
    resolveSession: () => null, sessionDeadline: () => null,
    issuePushTokens: () => null, pushBinding: () => null, approvalIdentity: () => null,
    authenticatePush: (token, scope) =>
      (token === DETAIL && scope === "detail") || (token === RESPOND && scope === "respond") ? { deviceId: "d1", bindingId: B } : null,
  };

  beforeAll(async () => {
    harness = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
    const harnessPort = (harness.address() as AddressInfo).port;
    door = createServer(createBrowserHandler({
      harnessPort, companionToken: PROOF, devices: store,
      identity: () => ({ scheme: "https", hosts: new Set([HOST]) }),
    }));
    await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
    doorPort = (door.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => door.close(() => r()));
    await new Promise<void>((r) => harness.close(() => r()));
  });
  beforeEach(() => { seen = []; });

  const call = (method: string, path: string, headers: Record<string, string>, body?: string | Buffer, agent: Agent | false = false) =>
    new Promise<{ status: number; body: string; connection: string | undefined; closed: Promise<void> }>((resolve, reject) => {
      const out = request({ host: "127.0.0.1", port: doorPort, method, path, agent, headers: { host: HOST, ...headers } }, (res) => {
        const closed = new Promise<void>((r) => res.socket.once("close", () => r()));
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), connection: res.headers.connection, closed }));
      });
      out.on("error", reject);
      out.end(body);
    });

  it("forwards only the headers it built, never the caller's x-murage-*, cookie or token", async () => {
    const answer = await call("GET", `/api/mobile/push/${REF}`, {
      authorization: `Bearer ${DETAIL}`,
      cookie: "murage_session=forged",
      "x-murage-push-device": "someone-else",
      "x-murage-push-binding": "00000000-0000-4000-8000-000000000000",
      "x-murage-push-scope": "respond",
      "x-murage-companion-token": "f".repeat(64),
      "x-murage-surface": "desktop",
    });
    expect(answer.status).toBe(200);
    expect(seen).toHaveLength(1);
    const { host: _host, connection: _connection, ...headers } = seen[0].headers;
    expect(headers).toEqual({ accept: "application/json", "x-murage-companion": "1", "x-murage-companion-token": PROOF, "x-murage-push-device": "d1", "x-murage-push-binding": B, "x-murage-push-scope": "detail" });
    expect(JSON.stringify(seen[0])).not.toContain(DETAIL);
  });

  it("forwards the respond body with the respond scope", async () => {
    const answer = await call("POST", "/api/mobile/push/respond", { authorization: `Bearer ${RESPOND}`, "content-type": "text/plain" }, JSON.stringify({ ref: REF, action: "approve" }));
    expect(answer.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/mobile/push/respond", body: JSON.stringify({ ref: REF, action: "approve" }) });
    expect(seen[0].headers).toMatchObject({ "content-type": "application/json", "x-murage-push-scope": "respond" });
    expect(JSON.stringify(seen[0])).not.toContain(RESPOND);
  });

  it("an unknown token or a token of the other scope is a 401 that reaches nothing", async () => {
    expect((await call("GET", "/api/mobile/push/pending", { authorization: `Bearer ${RESPOND}` })).status).toBe(401);
    // A detail token is not a respond token's shape, so it earns no exemption
    // and meets the gate's rule 4 (a write with no Origin).
    expect((await call("POST", "/api/mobile/push/respond", { authorization: `Bearer ${DETAIL}` }, "{}")).status).toBe(403);
    expect((await call("POST", "/api/mobile/push/respond", { authorization: `Bearer ${DETAIL}`, origin: `https://${HOST}`, "sec-fetch-site": "same-origin" }, "{}")).status).toBe(401);
    expect((await call("GET", "/api/mobile/push/pending", { authorization: "Bearer murage_pd_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" })).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("answers 413 to a respond body over 4 KiB, declared or streamed", async () => {
    // A keep-alive client, so a close can only be the door's own decision.
    const keepAlive = new Agent({ keepAlive: true });
    const declared = await call("POST", "/api/mobile/push/respond", { authorization: `Bearer ${RESPOND}` }, Buffer.alloc(5000, 0x61), keepAlive);
    expect(declared.status).toBe(413);
    const streamed = await call("POST", "/api/mobile/push/respond", { authorization: `Bearer ${RESPOND}`, "transfer-encoding": "chunked" }, Buffer.alloc(5000, 0x61), keepAlive);
    expect(streamed.status).toBe(413);
    // ...and closes the connection rather than draining the rest of an
    // unbounded upload on a kept-alive socket.
    for (const answer of [declared, streamed]) {
      expect(answer.connection).toBe("close");
      await answer.closed;
    }
    keepAlive.destroy();
    expect(seen).toEqual([]);
  });

  it("checks the token before reading any body", async () => {
    // Unauthenticated: a 401, not a 413 — the oversized body was never read.
    const forged = await call("POST", "/api/mobile/push/respond", { authorization: "Bearer murage_pr_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" }, Buffer.alloc(5000, 0x61));
    expect(forged.status).toBe(401);
    // A GET's body is never read at all, so its size cannot matter.
    // (Node's client frames a GET body only with an explicit length.)
    const read = await call("GET", "/api/mobile/push/pending", { authorization: `Bearer ${DETAIL}`, "content-length": "5000" }, Buffer.alloc(5000, 0x61));
    expect(read.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe("");
  });

  it("the session routes need a session, bearer or not", async () => {
    expect((await call("POST", "/api/mobile/push/enrol", { authorization: `Bearer ${DETAIL}`, origin: `https://${HOST}`, "sec-fetch-site": "same-origin" }, "{}")).status).toBe(401);
    expect((await call("POST", "/api/mobile/push/tokens", { origin: `https://${HOST}`, "sec-fetch-site": "same-origin" }, "{}")).status).toBe(401);
    // ...and a bearer does not lift the gate off them either.
    expect((await call("POST", "/api/mobile/push/enrol", { authorization: `Bearer ${DETAIL}` }, "{}")).status).toBe(403);
    expect(seen).toEqual([]);
  });
});

describe("the session routes, past the happy path", () => {
  it("answer 503 when the door has no usable launch proof", async () => {
    const harness = vi.fn<HarnessCall>();
    for (const companionToken of [undefined, "short", "A".repeat(64)]) {
      const o = { ...options(harness), companionToken };
      const result = await handlePushSession({ method: "POST", path: "/api/mobile/push/tokens", deviceId: "d1", body: Buffer.from("{}") }, o);
      expect(result.status).toBe(503);
    }
    expect(harness).not.toHaveBeenCalled();
  });

  const GRANT = JSON.stringify({ grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" });
  it("enrol fails closed when the harness names a binding that is not a binding id", async () => {
    for (const bindingId of ["nope", B.toUpperCase(), `${B}\r\nx-evil: 1`, ""]) {
      const o = options(async () => ({ status: 200, body: { bindingId } }));
      const result = await handlePushSession({ method: "POST", path: "/api/mobile/push/enrol", deviceId: "d1", body: Buffer.from(GRANT) }, o);
      expect(result.status, bindingId).toBe(502);
      expect(o.devices.issuePushTokens).not.toHaveBeenCalled();
    }
  });

  it("enrol mints nothing for a device removed while the harness was enrolling it, and revokes the binding again", async () => {
    const revoked = vi.fn();
    const base = options(async () => ({ status: 200, body: { bindingId: B } }));
    const o: PushDoorOptions = { ...base, revoked, devices: { ...base.devices, issuePushTokens: vi.fn(() => null) } };
    const result = await handlePushSession({ method: "POST", path: "/api/mobile/push/enrol", deviceId: "d1", body: Buffer.from(GRANT) }, o);
    expect(result).toEqual({ status: 401, body: { error: "sign in" } });
    expect(revoked).toHaveBeenCalledWith("d1");
  });
});

describe("the harness call always settles", () => {
  const servers: Server[] = [];
  afterAll(async () => { for (const s of servers) await new Promise<void>((r) => s.close(() => r())); });
  const serve = async (handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };
  const within = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);

  it("when the harness dies mid-body", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"title":"half');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const answer = await within(createHarnessCall(port)({ method: "GET", path: "/x", headers: {}, body: null }), 2000);
    expect(answer).not.toBe("hung");
    expect((answer as { status: number }).status).toBe(502);
  });

  it("when the harness stalls after the headers, at the overall deadline", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"title":"half');
      // never ends, never closes
    });
    const started = Date.now();
    const answer = await within(createHarnessCall(port, { deadlineMs: 150 })({ method: "GET", path: "/x", headers: {}, body: null }), 2000);
    expect(answer).not.toBe("hung");
    expect((answer as { status: number }).status).toBe(502);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("when the harness never answers at all", async () => {
    const port = await serve(() => { /* silence */ });
    const answer = await within(createHarnessCall(port, { deadlineMs: 150 })({ method: "POST", path: "/x", headers: {}, body: Buffer.from("{}") }), 2000);
    expect((answer as { status: number }).status).toBe(502);
  });
});

describe("the door's revocation hop, end to end (H7 Minor 2)", () => {
  const HOST = "mac.tailnet123.ts.net";
  const DEVICE = { id: "dev_1", name: "Sam's iPhone", cloudDesktopAccess: false };
  const SESSION = "murage_browser_session_value";
  let harness: Server;
  let door: Server;
  let doorPort = 0;
  const pushRevoked = vi.fn();
  beforeAll(async () => {
    harness = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url === "/api/mobile/push/enrol" ? { bindingId: B } : { error: "unexpected" }));
      });
    });
    await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
    const store: BrowserDeviceStore = {
      redeem: () => ({ error: "unused" }), openSession: () => null, closeSession: () => false, renewSession: () => null, signOutDevice: () => null,
      resolveSession: (value) => (value === SESSION ? { device: DEVICE, session: { id: "s1", expiresAt: Date.now() + 60_000 }, sessionId: "s1" } : null),
      sessionDeadline: () => Date.now() + 60_000,
      // The device went while the harness was enrolling it: nothing to mint.
      issuePushTokens: () => null, pushBinding: () => null, approvalIdentity: () => null, authenticatePush: () => null,
    };
    door = createServer(createBrowserHandler({
      harnessPort: (harness.address() as AddressInfo).port, companionToken: PROOF, devices: store, pushRevoked,
      identity: () => ({ scheme: "https", hosts: new Set([HOST]) }),
    }));
    await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
    doorPort = (door.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => door.close(() => r()));
    await new Promise<void>((r) => harness.close(() => r()));
  });

  it("an enrolment that mints nothing reaches createBrowserHandler's pushRevoked", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const out = request({ host: "127.0.0.1", port: doorPort, method: "POST", path: "/api/mobile/push/enrol", agent: false, headers: {
        host: HOST, origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "content-type": "application/json",
        cookie: `__Host-murage_session=${SESSION}`,
      } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      out.on("error", reject);
      out.end(JSON.stringify({ grant: "murage_pg_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" }));
    });
    expect(status).toBe(401);
    expect(pushRevoked).toHaveBeenCalledWith("dev_1");
  });

  it("and the companion hands that hook to the revocation queue", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const handler = source.slice(source.indexOf("const browserOptions"));
    expect(handler.slice(0, handler.indexOf("\n};"))).toContain("pushRevoked: (deviceId) => pushRevocations.add(deviceId),");
    expect(source).toContain("const pushRevocations = createPushRevocations({");
  });
});
