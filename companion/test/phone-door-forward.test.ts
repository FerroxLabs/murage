import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserHandler, forwardedHeaders, originGate, type BoundIdentity, type BrowserDeviceStore } from "../src/browser.ts";
import { handlePhoneBearer, phoneBearerExempt, phoneForwardHeaders, phoneJobRoute, phoneSelfRoute } from "../src/phone-door.ts";

const TOKEN_A = `murage_pj_${"A".repeat(43)}`;
const TOKEN_B = `murage_pj_${"B".repeat(43)}`;
const JUNK = `murage_pj_${"C".repeat(43)}`;
const DOOR = "d".repeat(64);
const OP = "0b9a1f6e-2c4d-4a7e-9b1f-3d5e7a9c1b2d";
const REF = "e".repeat(64);

const authenticatePhoneJobs = (t: string | undefined) => t === TOKEN_A ? { deviceId: "devA" } : t === TOKEN_B ? { deviceId: "devB" } : null;

describe("allowlist", () => {
  it("lists exactly the bearer job routes", () => {
    for (const [m, p] of [["PUT", "/api/phones/self"], ["DELETE", "/api/phones/self"], ["GET", "/api/phones/self/jobs"], ["GET", `/api/phones/self/jobs/${OP}`], ["POST", `/api/phones/self/jobs/${OP}/lease`], ["POST", `/api/phones/self/jobs/${OP}/decline`], ["POST", `/api/phones/self/jobs/${OP}/result`], ["POST", "/api/phones/self/foreground"]]) {
      expect(phoneSelfRoute(m, p), `${m} ${p}`).toBe(true);
    }
    for (const [m, p] of [["GET", "/api/phones/self"], ["POST", "/api/phones/self/jobs"], ["GET", "/api/phones/self/jobs/"], ["GET", "/api/phones/self/jobs/abc"], ["POST", `/api/phones/self/jobs/${OP}/other`], ["POST", `/api/phones/self/jobs/${OP}/result/`], ["get", "/api/phones/self/jobs"], ["GET", "/API/phones/self/jobs"], ["GET", "/api/phones/self/challenge"], ["POST", "/api/phones/self/token"], ["GET", "/api/phones/selfie"], ["GET", "/api/phones/self/jobs/%2e%2e"]]) {
      expect(phoneSelfRoute(m, p), `${m} ${p}`).toBe(false);
    }
  });
  it("sizes bodies: 300 KB for result, 8 KB for other writes, none for reads", () => {
    expect(phoneJobRoute("POST", `/api/phones/self/jobs/${OP}/result`)?.maxBody).toBe(300 * 1024);
    expect(phoneJobRoute("POST", `/api/phones/self/jobs/${OP}/lease`)?.maxBody).toBe(8 * 1024);
    expect(phoneJobRoute("GET", "/api/phones/self/jobs")?.maxBody).toBe(0);
  });
  it("phoneBearerExempt needs a listed route and a murage_pj_ shaped bearer", () => {
    expect(phoneBearerExempt("GET", "/api/phones/self/jobs", `Bearer ${TOKEN_A}`)).toBe(true);
    expect(phoneBearerExempt("GET", "/api/phones/self/jobs", undefined)).toBe(false);
    expect(phoneBearerExempt("GET", "/api/phones/self/jobs", "Bearer murage_pa_xxx")).toBe(false);
    expect(phoneBearerExempt("GET", "/api/phones/self/nope", `Bearer ${TOKEN_A}`)).toBe(false);
  });
  it("originGate: a valid-shape bearer passes on a listed route and is 403 on an unlisted one", () => {
    const identity: BoundIdentity = { scheme: "http", hosts: new Set(["desk.example.test"]) };
    const ask = (headers: Record<string, string>, method: string, url: string) => originGate({ headers: { host: "desk.example.test:8813", ...headers }, method, url } as unknown as IncomingMessage, identity);
    expect(ask({ authorization: `Bearer ${TOKEN_A}` }, "POST", `/api/phones/self/jobs/${OP}/result`)).toBeNull();
    expect(ask({ authorization: `Bearer ${TOKEN_A}` }, "POST", "/api/phones/self/other")?.status).toBe(403);
    expect(ask({}, "POST", `/api/phones/self/jobs/${OP}/result`)?.status).toBe(403);
  });
});

describe("phoneForwardHeaders", () => {
  it("is exactly the four fields", () => {
    expect(phoneForwardHeaders("devA", DOOR)).toEqual({ "x-murage-door-token": DOOR, "x-murage-phone-device": "devA", "x-murage-phone-scope": "jobs", accept: "application/json" });
  });
  it("forwardedHeaders drops client x-murage-phone-* headers", () => {
    const out = forwardedHeaders({ headers: { accept: "*/*", "x-murage-phone-device": "evil", "x-murage-phone-scope": "jobs", "x-murage-door-token": "x" } } as unknown as IncomingMessage);
    expect(Object.keys(out).filter((k) => k.startsWith("x-murage-phone") || k === "x-murage-door-token")).toEqual([]);
  });
});

describe("handlePhoneBearer", () => {
  const mk = () => ({ harness: vi.fn(async (_r: { method: string; path: string; headers: Record<string, string>; body: Buffer | null }) => ({ status: 200, body: { ok: 1 } })), jobsHarness: vi.fn(async (_r: { method: string; path: string; headers: Record<string, string>; body: Buffer | null }) => ({ status: 200, body: { jobs: [] } })) });
  it("uses the device the bearer proved, not the body", async () => {
    const h = mk();
    const r = await handlePhoneBearer({ method: "POST", path: `/api/phones/self/jobs/${OP}/lease`, authorization: `Bearer ${TOKEN_A}`, body: Buffer.from(JSON.stringify({ offerId: OP, deviceId: "devB" })) }, { devices: { authenticatePhoneJobs }, doorToken: DOOR, ...h });
    expect(r.status).toBe(200);
    expect(h.harness).toHaveBeenCalledTimes(1);
    const call = h.harness.mock.calls[0][0];
    expect(call.headers["x-murage-phone-device"]).toBe("devA");
    expect(Object.keys(call.headers).sort()).toEqual(["accept", "content-type", "x-murage-door-token", "x-murage-phone-device", "x-murage-phone-scope"]);
  });
  it("device B's token reaches the harness as device B", async () => {
    const h = mk();
    await handlePhoneBearer({ method: "POST", path: `/api/phones/self/jobs/${OP}/lease`, authorization: `Bearer ${TOKEN_B}`, body: Buffer.from("{}") }, { devices: { authenticatePhoneJobs }, doorToken: DOOR, ...h });
    expect(h.harness.mock.calls[0][0].headers["x-murage-phone-device"]).toBe("devB");
  });
  it("jobs GET uses the long caller and forwards only a valid eventRef", async () => {
    const h = mk();
    const o = { devices: { authenticatePhoneJobs }, doorToken: DOOR, ...h };
    await handlePhoneBearer({ method: "GET", path: "/api/phones/self/jobs", query: new URLSearchParams(`eventRef=${REF}&x=1`), authorization: `Bearer ${TOKEN_A}`, body: null }, o);
    expect(h.harness).not.toHaveBeenCalled();
    expect(h.jobsHarness.mock.calls[0][0].path).toBe(`/api/phones/self/jobs?eventRef=${REF}`);
    const bad = await handlePhoneBearer({ method: "GET", path: "/api/phones/self/jobs", query: new URLSearchParams("eventRef=nope"), authorization: `Bearer ${TOKEN_A}`, body: null }, o);
    expect(bad.status).toBe(400);
    expect(h.jobsHarness).toHaveBeenCalledTimes(1);
  });
  it("a junk bearer, an unlisted path, or no door token never reaches the harness", async () => {
    const h = mk();
    const o = { devices: { authenticatePhoneJobs }, doorToken: DOOR, ...h };
    expect((await handlePhoneBearer({ method: "GET", path: "/api/phones/self/jobs", authorization: `Bearer ${JUNK}`, body: null }, o)).status).toBe(403);
    expect((await handlePhoneBearer({ method: "GET", path: "/api/phones/self/nope", authorization: `Bearer ${TOKEN_A}`, body: null }, o)).status).toBe(403);
    expect((await handlePhoneBearer({ method: "GET", path: "/api/phones/self/jobs", authorization: `Bearer ${TOKEN_A}`, body: null }, { ...o, doorToken: undefined })).status).toBe(503);
    expect(h.harness).not.toHaveBeenCalled();
    expect(h.jobsHarness).not.toHaveBeenCalled();
  });
});

describe("at the door", () => {
  let harness: Server; let door: Server; let doorPort = 0;
  const seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const resolveSession = vi.fn(() => ({ device: { id: "devA", name: "x", cloudDesktopAccess: false }, session: { expiresAt: Date.now() + 1e6 }, sessionId: "s1" }));
  const authSpy = vi.fn(authenticatePhoneJobs);
  let offeredNow = true;
  let askNow = false;

  beforeAll(async () => {
    harness = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    });
    await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
    const store = { resolveSession, sessionDeadline: () => Date.now() + 1e6, authenticatePush: () => null, authenticatePhoneJobs: authSpy } as unknown as BrowserDeviceStore;
    door = createServer(createBrowserHandler({
      harnessPort: (harness.address() as AddressInfo).port,
      companionToken: DOOR,
      identity: () => ({ scheme: "http", hosts: new Set(["desk.example.test"]) }),
      devices: store,
      phonesOffered: async () => offeredNow,
      shareAskOffered: async () => askNow,
    }));
    await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
    doorPort = (door.address() as AddressInfo).port;
  });
  afterAll(async () => {
    door.closeAllConnections?.(); harness.closeAllConnections?.();
    await new Promise<void>((r) => door.close(() => r())); await new Promise<void>((r) => harness.close(() => r()));
  });
  beforeEach(() => { seen.length = 0; resolveSession.mockClear(); authSpy.mockClear(); });

  const knock = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const h: Record<string, string> = { host: `desk.example.test:${doorPort}`, ...headers };
    if (body !== undefined) { h["content-type"] = "application/json"; h["content-length"] = String(Buffer.byteLength(body)); }
    const req = request({ hostname: "127.0.0.1", port: doorPort, path, method, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  const bearer = (t = TOKEN_A) => ({ authorization: `Bearer ${t}` });
  const browserish = () => ({ cookie: "murage_session=valid", "sec-fetch-site": "same-origin", origin: `http://desk.example.test:${doorPort}` });

  it("cookie session on GET /api/phones/self/jobs is 403 and the harness is never called", async () => {
    const r = await knock("GET", "/api/phones/self/jobs", browserish());
    expect(r.status).toBe(403);
    expect(seen).toEqual([]);
    expect(resolveSession).not.toHaveBeenCalled();
  });
  it("junk bearer plus a valid cookie is 403 on every listed route", async () => {
    const h = { ...browserish(), ...bearer(JUNK) };
    for (const [m, p, b] of [["GET", "/api/phones/self/jobs"], ["PUT", "/api/phones/self", "{}"], ["DELETE", "/api/phones/self"], ["POST", `/api/phones/self/jobs/${OP}/result`, "{}"], ["POST", "/api/phones/self/foreground", "{}"]] as const) {
      expect((await knock(m, p, h, b)).status, `${m} ${p}`).toBe(403);
    }
    expect(seen).toEqual([]);
    expect(resolveSession).not.toHaveBeenCalled();
  });
  it("PUT /api/phones/self without a bearer is 403 (F27)", async () => {
    expect((await knock("PUT", "/api/phones/self", {}, "{}")).status).toBe(403);
    expect((await knock("PUT", "/api/phones/self", browserish(), "{}")).status).toBe(403);
    expect(seen).toEqual([]);
  });
  it("a valid bearer on an unlisted path is 403 and never forwarded", async () => {
    for (const [m, p] of [["GET", "/api/phones/self/nope"], ["POST", "/api/phones/self/jobs"], ["GET", "/api/phones/self"], ["GET", "/api/phones/%73elf/jobs"], ["GET", "/api/phones/self/jobs/"], ["POST", "/api/phones/self/targets"]] as const) {
      expect((await knock(m, p, bearer(), m === "POST" ? "{}" : undefined)).status, `${m} ${p}`).toBe(403);
    }
    expect(seen).toEqual([]);
  });
  it("a valid bearer is forwarded with the body intact", async () => {
    const r = await knock("POST", `/api/phones/self/jobs/${OP}/lease`, bearer(), JSON.stringify({ offerId: OP }));
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`/api/phones/self/jobs/${OP}/lease`);
    expect(seen[0].body).toBe(JSON.stringify({ offerId: OP }));
  });
  it("forwards exactly the envelope with the proven device and drops client phone headers", async () => {
    await knock("POST", `/api/phones/self/jobs/${OP}/lease`, { ...bearer(TOKEN_B), "x-murage-phone-device": "devA", "x-murage-phone-scope": "ask", "x-murage-door-token": "f".repeat(64), cookie: "murage_session=valid" }, JSON.stringify({ offerId: OP, deviceId: "devA" }));
    const h = seen[0].headers;
    expect(h["x-murage-phone-device"]).toBe("devB");
    expect(h["x-murage-phone-scope"]).toBe("jobs");
    expect(h["x-murage-door-token"]).toBe(DOOR);
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
  });
  it("the jobs GET carries eventRef through and rejects a malformed one", async () => {
    const r = await knock("GET", `/api/phones/self/jobs?eventRef=${REF}&junk=1`, bearer());
    expect(r.status).toBe(200);
    expect(seen[0].url).toBe(`/api/phones/self/jobs?eventRef=${REF}`);
    expect((await knock("GET", "/api/phones/self/jobs?eventRef=zz", bearer())).status).toBe(400);
  });
  it("result bodies up to 300 KB pass, over are 413; other writes cap at 8 KB", async () => {
    const big = JSON.stringify({ leaseToken: "x", ok: true, result: "y".repeat(200 * 1024) });
    expect((await knock("POST", `/api/phones/self/jobs/${OP}/result`, bearer(), big)).status).toBe(200);
    seen.length = 0;
    const over = JSON.stringify({ result: "y".repeat(301 * 1024) });
    expect((await knock("POST", `/api/phones/self/jobs/${OP}/result`, bearer(), over)).status).toBe(413);
    expect((await knock("POST", `/api/phones/self/jobs/${OP}/lease`, bearer(), JSON.stringify({ x: "y".repeat(9 * 1024) }))).status).toBe(413);
    expect(seen).toEqual([]);
  });
  it("hello shows phoneAsk: 1 only when share and ask is offered, independent of phoneJobs", async () => {
    expect(JSON.parse((await knock("GET", "/healthz")).body)).not.toHaveProperty("phoneAsk");
    askNow = true;
    try {
      const both = JSON.parse((await knock("GET", "/healthz")).body);
      expect(both.phoneAsk).toBe(1);
      expect(both.phoneJobs).toBe(1);
      offeredNow = false;
      const askOnly = JSON.parse((await knock("GET", "/healthz")).body);
      expect(askOnly.phoneAsk).toBe(1);
      expect(askOnly).not.toHaveProperty("phoneJobs");
    } finally { offeredNow = true; askNow = false; }
  });
  it("hello shows phoneJobs: 1 only when offered", async () => {
    const on = JSON.parse((await knock("GET", "/healthz")).body);
    expect(on.phoneJobs).toBe(1);
    expect(on.mobile).toBe(1);
    offeredNow = false;
    try { expect(JSON.parse((await knock("GET", "/healthz")).body)).not.toHaveProperty("phoneJobs"); } finally { offeredNow = true; }
  });
});
