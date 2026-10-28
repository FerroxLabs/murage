import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserHandler, originGate, type BoundIdentity, type BrowserDeviceStore } from "../src/browser.ts";
import { AskForwards, handlePhoneAsk, handlePhoneBearer, phoneAskExempt, phoneAskHeaders, phoneAskRoute } from "../src/phone-door.ts";
import { createHarnessStream } from "../src/push-door.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";

const PA = `murage_pa_${"A".repeat(43)}`;
const PJ = `murage_pj_${"B".repeat(43)}`;
const JUNK = `murage_pa_${"C".repeat(43)}`;
const DOOR = "d".repeat(64);
const MIB = 1024 * 1024;

describe("route table", () => {
  it("lists exactly GET targets, POST share, POST ask", () => {
    expect(phoneAskRoute("GET", "/api/phones/self/targets")).toBe("targets");
    expect(phoneAskRoute("POST", "/api/phones/self/share")).toBe("share");
    expect(phoneAskRoute("POST", "/api/phones/self/ask")).toBe("ask");
    for (const [m, p] of [["POST", "/api/phones/self/targets"], ["GET", "/api/phones/self/share"], ["GET", "/api/phones/self/ask"], ["POST", "/api/phones/self/ask/"], ["post", "/api/phones/self/ask"], ["POST", "/API/phones/self/ask"], ["POST", "/api/phones/self/share?x=1"], ["GET", "/api/phones/self/jobs"], ["DELETE", "/api/phones/self/ask"]]) {
      expect(phoneAskRoute(m, p), `${m} ${p}`).toBeNull();
    }
  });
  it("exempt needs the route and a murage_pa_ shaped bearer only", () => {
    expect(phoneAskExempt("GET", "/api/phones/self/targets", `Bearer ${PA}`)).toBe(true);
    expect(phoneAskExempt("GET", "/api/phones/self/targets", `Bearer ${PJ}`)).toBe(false);
    expect(phoneAskExempt("GET", "/api/phones/self/targets", undefined)).toBe(false);
    expect(phoneAskExempt("GET", "/api/phones/self/targets", "Bearer murage_pa_short")).toBe(false);
    expect(phoneAskExempt("GET", "/api/phones/self/jobs", `Bearer ${PA}`)).toBe(false);
  });
  it("envelope is exactly five headers", () => {
    expect(phoneAskHeaders("devA", 7, DOOR)).toEqual({ "x-murage-door-token": DOOR, "x-murage-phone-device": "devA", "x-murage-phone-scope": "ask", "x-murage-phone-ask-gen": "7", accept: "application/json" });
  });
  it("origin gate: pa bearer passes without Sec-Fetch-Site, a cookie does not, pj on ask is 403", () => {
    const identity: BoundIdentity = { scheme: "http", hosts: new Set(["desk.example.test"]) };
    const ask = (headers: Record<string, string>, method: string, url: string) => originGate({ headers: { host: "desk.example.test:8813", ...headers }, method, url } as unknown as IncomingMessage, identity);
    expect(ask({ authorization: `Bearer ${PA}` }, "GET", "/api/phones/self/targets")).toBeNull();
    expect(ask({ cookie: "murage_session=valid" }, "GET", "/api/phones/self/targets")?.status).toBe(403);
    expect(ask({ authorization: `Bearer ${PJ}` }, "POST", "/api/phones/self/share")?.status).toBe(403);
    expect(ask({ authorization: `Bearer ${PA}` }, "GET", "/api/phones/self/jobs")?.status).toBe(403);
  });
});

describe("AskForwards", () => {
  it("abortAll aborts only that device's live forwards and counts them", () => {
    const f = new AskForwards();
    const a1 = f.add("devA"); const a2 = f.add("devA"); const b = f.add("devB");
    expect(f.abortAll("devA")).toBe(2);
    expect(a1.signal.aborted && a2.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    b.done();
    expect(f.abortAll("devB")).toBe(0);
    expect(f.abortAll("devA")).toBe(0);
  });
});

async function* chunks(count: number, size: number) { for (let i = 0; i < count; i++) yield Buffer.alloc(size, 97); }
const mkDir = () => mkdtempSync(join(tmpdir(), "ask-spool-test-"));

describe("handlePhoneAsk", () => {
  const auth = (t: string | undefined) => t === PA ? { deviceId: "devA", generation: 3 } : null;
  const mk = (over: Partial<Parameters<typeof handlePhoneAsk>[1]> = {}) => {
    const spoolDir = mkDir();
    const harness = vi.fn(async (_r: { method: string; path: string; headers: Record<string, string>; body: Buffer | null }) => ({ status: 200, body: { ok: 1 } }));
    const seenFiles: { bytes: number; text: string; mode: number }[] = [];
    const stream = vi.fn(async (r: { method: string; path: string; headers: Record<string, string>; file: string; bytes: number; signal: AbortSignal }) => {
      seenFiles.push({ bytes: r.bytes, text: readFileSync(r.file, "utf8"), mode: statSync(r.file).mode & 0o777 });
      return { status: 200, body: { shared: 1 } };
    });
    const o = { devices: { authenticatePhoneAsk: auth }, harness, stream, doorToken: DOOR, spoolDir, forwards: new AskForwards(), ...over };
    return { o, harness, stream, spoolDir, seenFiles };
  };
  const spoolLeft = (d: string) => (existsSync(d) ? readdirSync(d) : []);

  it("targets: forwarded with the five headers and the token's device and generation", async () => {
    const { o, harness } = mk();
    const r = await handlePhoneAsk({ method: "GET", path: "/api/phones/self/targets", authorization: `Bearer ${PA}`, body: chunks(0, 0) }, o);
    expect(r.status).toBe(200);
    expect(harness).toHaveBeenCalledTimes(1);
    const call = harness.mock.calls[0][0];
    expect(call.headers).toEqual({ "x-murage-door-token": DOOR, "x-murage-phone-device": "devA", "x-murage-phone-scope": "ask", "x-murage-phone-ask-gen": "3", accept: "application/json" });
    expect(call.body).toBeNull();
  });
  it("ask: body forwarded with content-type json; over 8 KB is 413", async () => {
    const { o, harness } = mk();
    const r = await handlePhoneAsk({ method: "POST", path: "/api/phones/self/ask", authorization: `Bearer ${PA}`, body: chunks(1, 100) }, o);
    expect(r.status).toBe(200);
    expect(harness.mock.calls[0][0].body?.byteLength).toBe(100);
    expect(harness.mock.calls[0][0].headers["content-type"]).toBe("application/json");
    harness.mockClear();
    expect((await handlePhoneAsk({ method: "POST", path: "/api/phones/self/ask", authorization: `Bearer ${PA}`, body: chunks(1, 8 * 1024 + 1) }, o)).status).toBe(413);
    expect(harness).not.toHaveBeenCalled();
  });
  it("refuses a junk bearer, a pj bearer and an unlisted route without reading the body or calling out", async () => {
    const { o, harness, stream } = mk();
    const body = vi.fn(async function* () { yield Buffer.from("x"); });
    for (const [m, p, a] of [["POST", "/api/phones/self/share", `Bearer ${JUNK}`], ["POST", "/api/phones/self/share", `Bearer ${PJ}`], ["POST", "/api/phones/self/share", undefined], ["POST", "/api/phones/self/nope", `Bearer ${PA}`]] as const) {
      expect((await handlePhoneAsk({ method: m, path: p, authorization: a, body: body() }, o)).status, `${m} ${p}`).toBe(403);
    }
    expect(harness).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
  it("no door token is 503 and nothing is forwarded", async () => {
    const { o, harness } = mk({ doorToken: undefined });
    expect((await handlePhoneAsk({ method: "GET", path: "/api/phones/self/targets", authorization: `Bearer ${PA}`, body: chunks(0, 0) }, o)).status).toBe(503);
    expect(harness).not.toHaveBeenCalled();
  });
  it("share: spooled 0600, piped from the file, and the file is gone after success", async () => {
    const { o, stream, spoolDir, seenFiles } = mk();
    const r = await handlePhoneAsk({ method: "POST", path: "/api/phones/self/share", authorization: `Bearer ${PA}`, body: chunks(8, 256 * 1024) }, o);
    expect(r.status).toBe(200);
    expect(stream).toHaveBeenCalledTimes(1);
    const call = stream.mock.calls[0][0];
    expect(call.bytes).toBe(2 * MIB);
    expect(call.file.startsWith(spoolDir)).toBe(true);
    expect(call.headers["x-murage-phone-ask-gen"]).toBe("3");
    expect(seenFiles[0].bytes).toBe(2 * MIB);
    expect(seenFiles[0].text.length).toBe(2 * MIB);
    expect(seenFiles[0].mode).toBe(0o600);
    expect(Object.keys(call)).not.toContain("body");
    expect(spoolLeft(spoolDir)).toEqual([]);
  });
  it("share: a device removed while the body uploads is 401 after the body, nothing forwarded, spool gone", async () => {
    let live = true;
    const { o, stream, harness, spoolDir } = mk({ devices: { authenticatePhoneAsk: (t) => (live ? auth(t) : null) } });
    async function* body() { yield Buffer.alloc(1024, 1); live = false; yield Buffer.alloc(1024, 1); }
    const r = await handlePhoneAsk({ method: "POST", path: "/api/phones/self/share", authorization: `Bearer ${PA}`, body: body() }, o);
    expect(r.status).toBe(401);
    expect(stream).not.toHaveBeenCalled();
    expect(harness).not.toHaveBeenCalled();
    expect(spoolLeft(spoolDir)).toEqual([]);
  });
  it("share: a re-minted token (new generation) during the upload is 401 too", async () => {
    let gen = 3;
    const { o, stream } = mk({ devices: { authenticatePhoneAsk: (t) => (t === PA ? { deviceId: "devA", generation: gen } : null) } });
    async function* body() { yield Buffer.alloc(10, 1); gen = 4; yield Buffer.alloc(10, 1); }
    expect((await handlePhoneAsk({ method: "POST", path: "/api/phones/self/share", authorization: `Bearer ${PA}`, body: body() }, o)).status).toBe(401);
    expect(stream).not.toHaveBeenCalled();
  });
  it("share: 65 MiB is 413, nothing forwarded, spool gone; the declared length refuses before reading", async () => {
    const { o, stream, spoolDir } = mk();
    expect((await handlePhoneAsk({ method: "POST", path: "/api/phones/self/share", authorization: `Bearer ${PA}`, body: chunks(65, MIB) }, o)).status).toBe(413);
    expect(stream).not.toHaveBeenCalled();
    expect(spoolLeft(spoolDir)).toEqual([]);
    let pulled = false;
    async function* next() { pulled = true; yield Buffer.from("x"); }
    expect((await handlePhoneAsk({ method: "POST", path: "/api/phones/self/share", authorization: `Bearer ${PA}`, declaredLength: 64 * MIB + 1, body: next() }, o)).status).toBe(413);
    expect(pulled).toBe(false);
  });
  it("exactly 64 MiB passes", async () => {
    const { o, stream } = mk();
    expect((await handlePhoneAsk({ method: "POST", path: "/api/phones/self/share", authorization: `Bearer ${PA}`, body: chunks(64, MIB) }, o)).status).toBe(200);
    expect(stream.mock.calls[0][0].bytes).toBe(64 * MIB);
  });
  it("an abort during the forward cancels it, answers non-200 and removes the spool file", async () => {
    const forwards = new AskForwards();
    const spoolDir = mkDir();
    const stream = vi.fn((r: { signal: AbortSignal }) => new Promise<{ status: number; body: unknown }>((resolve) => { r.signal.addEventListener("abort", () => resolve({ status: 502, body: { error: "aborted" } })); }));
    const o = { devices: { authenticatePhoneAsk: auth }, harness: vi.fn(), stream: stream as never, doorToken: DOOR, spoolDir, forwards };
    const p = handlePhoneAsk({ method: "POST", path: "/api/phones/self/share", authorization: `Bearer ${PA}`, body: chunks(1, 100) }, o);
    await vi.waitFor(() => expect(stream).toHaveBeenCalled());
    expect(forwards.abortAll("devA")).toBe(1);
    expect((await p).status).not.toBe(200);
    expect(spoolLeft(spoolDir)).toEqual([]);
  });
  it("an abort during a non-share forward does not wait for the harness", async () => {
    const forwards = new AskForwards();
    const harness = vi.fn(() => new Promise<{ status: number; body: unknown }>(() => {}));
    const o = { devices: { authenticatePhoneAsk: auth }, harness, stream: vi.fn() as never, doorToken: DOOR, spoolDir: mkDir(), forwards };
    const p = handlePhoneAsk({ method: "POST", path: "/api/phones/self/ask", authorization: `Bearer ${PA}`, body: chunks(1, 10) }, o);
    await vi.waitFor(() => expect(harness).toHaveBeenCalled());
    forwards.abortAll("devA");
    expect((await p).status).toBe(401);
  });
  it("handlePhoneBearer refuses a murage_pa_ bearer on a jobs route even if the store would accept it", async () => {
    const authenticatePhoneJobs = vi.fn(() => ({ deviceId: "devA" }));
    const harness = vi.fn(async () => ({ status: 200, body: {} }));
    const r = await handlePhoneBearer({ method: "GET", path: "/api/phones/self/jobs", authorization: `Bearer ${PA}`, body: null }, { devices: { authenticatePhoneJobs }, harness, jobsHarness: harness, doorToken: DOOR });
    expect(r.status).toBe(403);
    expect(harness).not.toHaveBeenCalled();
  });
});

describe("createHarnessStream", () => {
  let srv: Server; let port = 0; let mode: "echo" | "hang" = "echo";
  const seen: { url?: string; headers: IncomingMessage["headers"]; bytes: number; sample: string }[] = [];
  beforeAll(async () => {
    srv = createServer((req, res) => {
      let bytes = 0; let sample = "";
      req.on("data", (c: Buffer) => { if (!sample) sample = c.subarray(0, 4).toString("utf8"); bytes += c.byteLength; });
      req.on("end", () => { seen.push({ url: req.url, headers: req.headers, bytes, sample }); if (mode === "hang") return; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ got: bytes })); });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(async () => { srv.closeAllConnections?.(); await new Promise<void>((r) => srv.close(() => r())); });
  beforeEach(() => { seen.length = 0; mode = "echo"; });
  const file = (n: number) => { const f = join(mkDir(), "f"); writeFileSync(f, Buffer.alloc(n, 98)); return f; };

  it("pipes the file with its length and headers", async () => {
    const f = file(3 * MIB);
    const r = await createHarnessStream(port, { deadlineMs: 5000 })({ method: "POST", path: "/api/phones/self/share", headers: { "x-test": "1", "content-type": "multipart/form-data; boundary=x" }, file: f, bytes: 3 * MIB, signal: new AbortController().signal });
    expect(r).toEqual({ status: 200, body: { got: 3 * MIB } });
    expect(seen[0].headers["content-length"]).toBe(String(3 * MIB));
    expect(seen[0].headers["x-test"]).toBe("1");
    expect(seen[0].sample).toBe("bbbb");
  });
  it("the deadline and an abort both settle as 502", async () => {
    mode = "hang";
    const f = file(100);
    const slow = await createHarnessStream(port, { deadlineMs: 150 })({ method: "POST", path: "/x", headers: {}, file: f, bytes: 100, signal: new AbortController().signal });
    expect(slow.status).toBe(502);
    const ac = new AbortController();
    const p = createHarnessStream(port, { deadlineMs: 5000 })({ method: "POST", path: "/x", headers: {}, file: f, bytes: 100, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    expect((await p).status).toBe(502);
    expect((await createHarnessStream(port, { deadlineMs: 5000 })({ method: "POST", path: "/x", headers: {}, file: f, bytes: 100, signal: AbortSignal.abort() })).status).toBe(502);
  });
  it("a missing file settles as 502", async () => {
    expect((await createHarnessStream(port, { deadlineMs: 2000 })({ method: "POST", path: "/x", headers: {}, file: join(tmpdir(), "no-such-ask-spool-file"), bytes: 10, signal: new AbortController().signal })).status).toBe(502);
  });
});

describe("at the door", () => {
  let harness: Server; let door: Server; let doorPort = 0; let spoolDir = "";
  const seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: Buffer }[] = [];
  const resolveSession = vi.fn(() => ({ device: { id: "devA", name: "x", cloudDesktopAccess: false }, session: { expiresAt: Date.now() + 1e6 }, sessionId: "s1" }));
  let paLive = true;
  const authenticatePhoneAsk = vi.fn((t: string | undefined) => (t === PA && paLive ? { deviceId: "devA", generation: 5 } : null));
  const authenticatePhoneJobs = vi.fn((t: string | undefined) => (t === PJ ? { deviceId: "devA" } : null));
  const forwards = new AskForwards();

  beforeAll(async () => {
    spoolDir = mkDir();
    harness = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts) }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    });
    await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
    const store = { resolveSession, sessionDeadline: () => Date.now() + 1e6, authenticatePush: () => null, authenticatePhoneJobs, authenticatePhoneAsk } as unknown as BrowserDeviceStore;
    door = createServer(createBrowserHandler({
      harnessPort: (harness.address() as AddressInfo).port,
      companionToken: DOOR,
      identity: () => ({ scheme: "http", hosts: new Set(["desk.example.test"]) }),
      devices: store,
      phonesOffered: async () => true,
      shareAskOffered: async () => true,
      askSpoolDir: spoolDir,
      askForwards: forwards,
    }));
    await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
    doorPort = (door.address() as AddressInfo).port;
  });
  afterAll(async () => {
    door.closeAllConnections?.(); harness.closeAllConnections?.();
    await new Promise<void>((r) => door.close(() => r())); await new Promise<void>((r) => harness.close(() => r()));
    await removeTempDir(spoolDir);
  });
  beforeEach(() => { seen.length = 0; paLive = true; resolveSession.mockClear(); });

  const knock = (method: string, path: string, headers: Record<string, string> = {}, body?: Buffer | string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const h: Record<string, string> = { host: `desk.example.test:${doorPort}`, ...headers };
    if (body !== undefined) h["content-length"] = String(Buffer.byteLength(body));
    const req = request({ hostname: "127.0.0.1", port: doorPort, path, method, headers: h }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  const bearer = (t = PA) => ({ authorization: `Bearer ${t}` });
  const browserish = () => ({ cookie: "murage_session=valid", "sec-fetch-site": "same-origin", origin: `http://desk.example.test:${doorPort}` });
  const routes = [["GET", "/api/phones/self/targets"], ["POST", "/api/phones/self/share"], ["POST", "/api/phones/self/ask"]] as const;

  it("a cookie session on each ask route is 403 and the harness is never called", async () => {
    for (const [m, p] of routes) expect((await knock(m, p, browserish(), m === "POST" ? "{}" : undefined)).status, `${m} ${p}`).toBe(403);
    expect(seen).toEqual([]);
    expect(resolveSession).not.toHaveBeenCalled();
  });
  it("a murage_pj_ bearer on each ask route is 403; a murage_pa_ bearer on a jobs route is 403", async () => {
    for (const [m, p] of routes) expect((await knock(m, p, bearer(PJ), m === "POST" ? "{}" : undefined)).status, `${m} ${p}`).toBe(403);
    expect((await knock("GET", "/api/phones/self/jobs", bearer(PA))).status).toBe(403);
    expect((await knock("PUT", "/api/phones/self", bearer(PA), "{}")).status).toBe(403);
    expect(seen).toEqual([]);
  });
  it("a valid bearer is forwarded with exactly the five headers and no client phone headers", async () => {
    const r = await knock("POST", "/api/phones/self/ask", { ...bearer(), "x-murage-phone-device": "evil", "x-murage-phone-ask-gen": "99", "x-murage-phone-scope": "jobs", cookie: "murage_session=valid", "content-type": "application/json" }, JSON.stringify({ askId: "a", text: "hi" }));
    expect(r.status).toBe(200);
    const h = seen[0].headers;
    expect(h["x-murage-phone-device"]).toBe("devA");
    expect(h["x-murage-phone-scope"]).toBe("ask");
    expect(h["x-murage-phone-ask-gen"]).toBe("5");
    expect(h["x-murage-door-token"]).toBe(DOOR);
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
    expect(seen[0].body.toString()).toBe(JSON.stringify({ askId: "a", text: "hi" }));
    expect((await knock("GET", "/api/phones/self/targets", bearer())).status).toBe(200);
    expect(seen[1].url).toBe("/api/phones/self/targets");
  });
  it("a share is streamed to the harness whole and the spool is empty afterwards", async () => {
    const payload = Buffer.alloc(3 * MIB, 99);
    const r = await knock("POST", "/api/phones/self/share", { ...bearer(), "content-type": "multipart/form-data; boundary=zz" }, payload);
    expect(r.status).toBe(200);
    expect(seen[0].body.equals(payload)).toBe(true);
    expect(seen[0].headers["content-type"]).toBe("multipart/form-data; boundary=zz");
    expect(readdirSync(spoolDir)).toEqual([]);
  });
  it("a device removed during the upload is 401 and the spool is empty", async () => {
    const r = await new Promise<{ status: number }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: doorPort, path: "/api/phones/self/share", method: "POST", headers: { host: `desk.example.test:${doorPort}`, ...bearer(), "content-length": "2048" } }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0 })); });
      req.on("error", reject);
      req.write(Buffer.alloc(1024, 1));
      setTimeout(() => { paLive = false; req.end(Buffer.alloc(1024, 1)); }, 100);
    });
    expect(r.status).toBe(401);
    expect(seen).toEqual([]);
    expect(readdirSync(spoolDir)).toEqual([]);
  });
  it("an upload declaring 65 MiB is 413 before any body arrives", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: doorPort, path: "/api/phones/self/share", method: "POST", headers: { host: `desk.example.test:${doorPort}`, ...bearer(), "content-length": String(65 * MIB) } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy(); });
      req.on("error", () => {});
      req.flushHeaders();
      void reject;
    });
    expect(status).toBe(413);
    expect(seen).toEqual([]);
    expect(readdirSync(spoolDir)).toEqual([]);
  });
});
