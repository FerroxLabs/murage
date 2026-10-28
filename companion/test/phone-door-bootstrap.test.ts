import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBrowserHandler, originGate, type BoundIdentity, type BrowserDeviceStore } from "../src/browser.ts";
import { handlePhoneBootstrap as realBootstrap, isPhoneSelfPath, PhoneChallenges, phoneBootstrapExempt, verifyPhoneJobsSignature, type PhoneDoorDevices } from "../src/phone-door.ts";
import { approvalKeyId, phoneJobsMessage, PHONE_TOKEN } from "../src/phone-jobs-shape.ts";

const ORIGIN = "https://desk.example.test";
const fixture = JSON.parse(readFileSync(new URL("../../apps/mobile/contract/phone-jobs.json", import.meta.url), "utf8"));

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { point, keyId: approvalKeyId(point)!, signMessage: (m: string) => sign("sha256", Buffer.from(m), { key: privateKey, dsaEncoding: "der" }).toString("base64url") };
}

let clock = 1_700_000_000_000;
let counter = 0;
const challenges = () => new PhoneChallenges({ now: () => clock, random: () => createHash("sha256").update(String(counter++)).digest("base64url") });

const PROOF = "c".repeat(64);
const okHarness = async () => ({ status: 200, body: { ok: true } });
// S5b: a mint now also asks the harness to clear the barrier; the S3 cases run against a harness that agrees.
const handlePhoneBootstrap: typeof realBootstrap = (req, o) => realBootstrap(req, { harness: okHarness, doorToken: PROOF, ...o });

function fakeDevices(entries: Record<string, { deviceId: string; point: string } | "many" | "none">) {
  const issued: string[] = [];
  const devices: PhoneDoorDevices = {
    deviceByApprovalKeyId: (keyId) => {
      const e = entries[keyId];
      if (!e || e === "none") return { ok: false, reason: "none" };
      if (e === "many") return { ok: false, reason: "many" };
      return { ok: true, ...e };
    },
    issuePhoneJobsToken: (deviceId) => { issued.push(deviceId); return `murage_pj_${"A".repeat(43)}`; },
    authenticatePhoneJobs: (token) => (token === `murage_pj_${"A".repeat(43)}` && issued.length > 0 ? { deviceId: issued[issued.length - 1] } : null),
    clearPhoneJobsToken: () => true,
  };
  return { devices, issued };
}

const offered = async () => true;
const q = (s: string) => new URLSearchParams(s);
const get = (key: string | null, extra = "") => ({ method: "GET", path: "/api/phones/self/challenge", query: q((key ? `key=${key}&` : "") + extra), body: null, source: "10.0.0.1", origin: ORIGIN });
const post = (body: unknown, source = "10.0.0.1") => ({ method: "POST", path: "/api/phones/self/token", query: q(""), body: Buffer.from(JSON.stringify(body)), source, origin: ORIGIN });

async function mint(k: ReturnType<typeof makeKey>, c: PhoneChallenges, devices: PhoneDoorDevices) {
  const ch = await handlePhoneBootstrap(get(k.keyId), { devices, challenges: c, offered });
  expect(ch.status).toBe(200);
  const { nonce, expiresAt } = ch.body as { nonce: string; expiresAt: number };
  const signature = k.signMessage(phoneJobsMessage({ origin: ORIGIN, keyId: k.keyId, nonce, expiresAt }));
  return { nonce, expiresAt, signature };
}

describe("phone bootstrap", () => {
  it("first mint works with no cookie and no bearer (F27)", async () => {
    const k = makeKey(); const c = challenges(); const { devices, issued } = fakeDevices({ [k.keyId]: { deviceId: "d1", point: k.point } });
    const m = await mint(k, c, devices);
    const r = await handlePhoneBootstrap(post({ keyId: k.keyId, ...m }), { devices, challenges: c, offered });
    expect(r.status).toBe(200);
    expect((r.body as { token: string }).token).toMatch(PHONE_TOKEN);
    expect(issued).toEqual(["d1"]);
    expect(m.expiresAt).toBe(clock + 60_000);
  });

  it("a cookie-only probe of both routes mints nothing and looks like a wrong signature (F3)", async () => {
    const k = makeKey(); const c = challenges(); const { devices, issued } = fakeDevices({ [k.keyId]: { deviceId: "d1", point: k.point } });
    const noKey = await handlePhoneBootstrap(get(null), { devices, challenges: c, offered });
    const m = await mint(k, c, devices);
    const badSig = await handlePhoneBootstrap(post({ keyId: k.keyId, ...m, signature: "A".repeat(96) }), { devices, challenges: c, offered });
    expect(noKey.status).toBe(403);
    expect(badSig.status).toBe(403);
    expect(noKey.body).toEqual(badSig.body);
    expect(issued).toEqual([]);
  });

  it("consumes the nonce on a failed POST", async () => {
    const k = makeKey(); const c = challenges(); const { devices, issued } = fakeDevices({ [k.keyId]: { deviceId: "d1", point: k.point } });
    const m = await mint(k, c, devices);
    const bad = await handlePhoneBootstrap(post({ keyId: k.keyId, ...m, signature: "A".repeat(96) }), { devices, challenges: c, offered });
    expect(bad.status).toBe(403);
    const again = await handlePhoneBootstrap(post({ keyId: k.keyId, ...m }), { devices, challenges: c, offered });
    expect(again.status).toBe(403);
    expect(issued).toEqual([]);
    // also consumed when the body is otherwise malformed
    const m2 = await mint(k, c, devices);
    const odd = await handlePhoneBootstrap(post({ keyId: k.keyId, ...m2, extra: 1 }), { devices, challenges: c, offered });
    expect(odd.status).toBe(400);
    expect((await handlePhoneBootstrap(post({ keyId: k.keyId, ...m2 }), { devices, challenges: c, offered })).status).toBe(403);
  });

  it("refuses zero and duplicate matches, and a removed device", async () => {
    const k = makeKey(); const c = challenges();
    const entries: Parameters<typeof fakeDevices>[0] = { [k.keyId]: "many" };
    const { devices } = fakeDevices(entries);
    expect((await handlePhoneBootstrap(get(k.keyId), { devices, challenges: c, offered })).status).toBe(403);
    expect((await handlePhoneBootstrap(get(makeKey().keyId), { devices, challenges: c, offered })).status).toBe(403);
    entries[k.keyId] = { deviceId: "d1", point: k.point };
    const m = await mint(k, c, devices);
    entries[k.keyId] = "none"; // removed between challenge and token
    expect((await handlePhoneBootstrap(post({ keyId: k.keyId, ...m }), { devices, challenges: c, offered })).status).toBe(403);
  });

  it("ignores ?device= and every field but key; a repeated key is refused", async () => {
    const k = makeKey(); const c = challenges(); const { devices } = fakeDevices({ [k.keyId]: { deviceId: "d1", point: k.point } });
    const o = { devices, challenges: c, offered };
    expect((await handlePhoneBootstrap(get(null, "device=d1"), o)).status).toBe(403);
    expect((await handlePhoneBootstrap(get(k.keyId, "device=other&x=1"), o)).status).toBe(200);
    expect((await handlePhoneBootstrap({ ...get(null), query: q(`key=${k.keyId}&key=${k.keyId}`) }, o)).status).toBe(403);
  });

  it("answers 429 past the per-key limit with no nonce, and per source", async () => {
    const k = makeKey(); const c = challenges(); const { devices } = fakeDevices({ [k.keyId]: { deviceId: "d1", point: k.point } });
    const o = { devices, challenges: c, offered };
    for (let i = 0; i < 32; i++) expect((await handlePhoneBootstrap({ ...get(k.keyId), source: `10.0.${i}.1` }, o)).status).toBe(200);
    const over = await handlePhoneBootstrap({ ...get(k.keyId), source: "10.9.9.9" }, o);
    expect(over.status).toBe(429);
    expect(JSON.stringify(over.body)).not.toContain("nonce");
    const c2 = challenges(); const keys = Array.from({ length: 33 }, makeKey);
    const entries = Object.fromEntries(keys.map((x, i) => [x.keyId, { deviceId: `d${i}`, point: x.point }]));
    const o2 = { devices: fakeDevices(entries).devices, challenges: c2, offered };
    for (let i = 0; i < 32; i++) expect((await handlePhoneBootstrap({ ...get(keys[i].keyId), source: "same" }, o2)).status).toBe(200);
    expect((await handlePhoneBootstrap({ ...get(keys[32].keyId), source: "same" }, o2)).status).toBe(429);
  });

  it("holds at most 256 in total and frees expired ones", () => {
    const c = challenges();
    for (let i = 0; i < 256; i++) expect(c.issue(`k${i % 9}-${i}`, `s${i}`)).not.toBe("limited");
    expect(c.issue("kx", "sx")).toBe("limited");
    clock += 60_001;
    expect(c.issue("kx", "sx")).not.toBe("limited");
  });

  it("refuses a nonce issued to another keyId, and an expired one", async () => {
    const a = makeKey(); const b = makeKey(); const c = challenges();
    const { devices, issued } = fakeDevices({ [a.keyId]: { deviceId: "da", point: a.point }, [b.keyId]: { deviceId: "db", point: b.point } });
    const m = await mint(a, c, devices);
    const signature = b.signMessage(phoneJobsMessage({ origin: ORIGIN, keyId: b.keyId, nonce: m.nonce, expiresAt: m.expiresAt }));
    expect((await handlePhoneBootstrap(post({ keyId: b.keyId, nonce: m.nonce, expiresAt: m.expiresAt, signature }), { devices, challenges: c, offered })).status).toBe(403);
    const m2 = await mint(a, c, devices);
    clock += 60_001;
    expect((await handlePhoneBootstrap(post({ keyId: a.keyId, ...m2 }), { devices, challenges: c, offered })).status).toBe(403);
    expect(issued).toEqual([]);
  });

  it("signs the origin: a signature for another origin is refused", async () => {
    const k = makeKey(); const c = challenges(); const { devices } = fakeDevices({ [k.keyId]: { deviceId: "d1", point: k.point } });
    const ch = (await handlePhoneBootstrap(get(k.keyId), { devices, challenges: c, offered })).body as { nonce: string; expiresAt: number };
    const signature = k.signMessage(phoneJobsMessage({ origin: "https://other.example.test", keyId: k.keyId, nonce: ch.nonce, expiresAt: ch.expiresAt }));
    expect((await handlePhoneBootstrap(post({ keyId: k.keyId, ...ch, signature }), { devices, challenges: c, offered })).status).toBe(403);
  });

  it("is 404 when the harness does not offer phones, on both routes", async () => {
    const k = makeKey(); const c = challenges(); const { devices } = fakeDevices({ [k.keyId]: { deviceId: "d1", point: k.point } });
    for (const off of [async () => false, async () => { throw new Error("down"); }]) {
      expect((await handlePhoneBootstrap(get(k.keyId), { devices, challenges: c, offered: off })).status).toBe(404);
      expect((await handlePhoneBootstrap(post({}), { devices, challenges: c, offered: off })).status).toBe(404);
    }
  });

  it("verifies the contract fixture signature and refuses a changed message", () => {
    const v = fixture.mint.vector;
    expect(verifyPhoneJobsSignature(v.point, v.message, v.signature)).toBe(true);
    expect(verifyPhoneJobsSignature(v.point, `${v.message}x`, v.signature)).toBe(false);
    expect(verifyPhoneJobsSignature(v.point, v.message, "")).toBe(false);
  });
});

describe("which paths skip the gate", () => {
  it("allowlists exactly two method + path pairs", () => {
    expect(phoneBootstrapExempt("GET", "/api/phones/self/challenge")).toBe(true);
    expect(phoneBootstrapExempt("POST", "/api/phones/self/token")).toBe(true);
    for (const [m, p] of [["POST", "/api/phones/self/challenge"], ["GET", "/api/phones/self/token"], ["GET", "/api/phones/self/jobs"], ["GET", "/api/phones/self/challenge/"], ["GET", "/API/phones/self/challenge"], ["GET", "/api/phones/self/challenge%2f"], ["HEAD", "/api/phones/self/challenge"]]) {
      expect(phoneBootstrapExempt(m, p), `${m} ${p}`).toBe(false);
    }
  });
  it("treats encoded, backslash and doubled-slash spellings as self paths", () => {
    for (const p of ["/api/phones/self", "/api/phones/self/x", "/api/phones/%73elf/jobs", "/api/phones//self/jobs", "/api/phones/SELF/jobs", "/api/phones/self%2fjobs", "/api/phones/%zz", "/api/phones/./self/jobs", "/api/x/../phones/self", "/api/phones/%2e/self/jobs", "/api/phones/.%2e/phones/self"]) expect(isPhoneSelfPath(p), p).toBe(true);
    for (const p of ["/api/phones/offered", "/api/bots", "/api/mobile/push/respond"]) expect(isPhoneSelfPath(p), p).toBe(false);
  });
});

describe("originGate and the phone routes", () => {
  const identity: BoundIdentity = { scheme: "http", hosts: new Set(["desk.example.test"]) };
  const host = "desk.example.test:8813";
  const ask = (headers: Record<string, string>, method: string, url: string) => originGate({ headers: { host, ...headers }, method, url } as unknown as IncomingMessage, identity);

  it("lets the two bootstrap routes through with no Sec-Fetch-Site and no Origin", () => {
    expect(ask({}, "GET", "/api/phones/self/challenge?key=abc")).toBeNull();
    expect(ask({}, "POST", "/api/phones/self/token")).toBeNull();
  });
  it("refuses every other path under /api/phones/self, with or without a bearer, before cookie auth", () => {
    const junk = { authorization: `Bearer murage_pj_${"A".repeat(43)}`, cookie: "murage_session=anything" };
    for (const [m, u] of [["GET", "/api/phones/self/jobs/"], ["POST", "/api/phones/self/jobs"], ["POST", "/api/phones/self/unknown"], ["GET", "/api/phones/self"], ["POST", "/api/phones/self/challenge"], ["GET", "/api/phones/self/token"]]) {
      expect(ask({}, m, u)?.status, `${m} ${u} bare`).toBe(403);
      expect(ask(junk, m, u)?.status, `${m} ${u} junk bearer`).toBe(403);
      expect(ask({ ...junk, "sec-fetch-site": "same-origin", origin: `http://${host}` }, m, u)?.status, `${m} ${u} browser-like`).toBe(403);
    }
  });
  it("records how a missing Sec-Fetch-Site is treated on this tree: it falls through to Origin rules", () => {
    // Rule 2 enforces only when the header is present (plain-http phones send none).
    expect(ask({}, "GET", "/api/bots")).toBeNull();
    // ...so the refusal for a non-browser write comes from rule 4 (no Origin).
    expect(ask({}, "POST", "/api/bots")?.error).toBe("forbidden: cross-origin request");
    // A cross-origin Origin without Sec-Fetch is still refused by rule 3.
    expect(ask({ origin: "http://evil.example" }, "GET", "/api/bots")?.status).toBe(403);
    // Present and cross-site is refused by rule 2.
    expect(ask({ "sec-fetch-site": "cross-site" }, "GET", "/api/bots")?.status).toBe(403);
  });
});

describe("at the door", () => {
  let harness: Server; let door: Server; let doorPort = 0;
  const harnessSeen: string[] = [];
  const k = makeKey();
  const registry = fakeDevices({ [k.keyId]: { deviceId: "d1", point: k.point } });
  const resolveSession = vi.fn(() => ({ device: { id: "d1", name: "x", cloudDesktopAccess: false }, session: { expiresAt: Date.now() + 1e6 }, sessionId: "s1" }));
  let offeredNow = true;

  beforeAll(async () => {
    harness = createServer((req, res) => { harnessSeen.push(`${req.method} ${req.url}`); res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/api/phones/minted" ? '{"ok":true}' : "{}"); });
    await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
    const store = { resolveSession, sessionDeadline: () => Date.now() + 1e6, authenticatePush: () => null, ...registry.devices } as unknown as BrowserDeviceStore;
    door = createServer(createBrowserHandler({
      harnessPort: (harness.address() as AddressInfo).port,
      identity: () => ({ scheme: "http", hosts: new Set(["desk.example.test"]) }),
      devices: store,
      companionToken: PROOF,
      phonesOffered: async () => offeredNow,
    }));
    await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
    doorPort = (door.address() as AddressInfo).port;
  });
  afterAll(async () => {
    door.closeAllConnections?.(); harness.closeAllConnections?.();
    await new Promise<void>((r) => door.close(() => r())); await new Promise<void>((r) => harness.close(() => r()));
  });

  const knock = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => new Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
    const h: Record<string, string> = { host: `desk.example.test:${doorPort}`, ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    const req = request({ hostname: "127.0.0.1", port: doorPort, path, method, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
  const cookie = { cookie: "murage_session=valid", "sec-fetch-site": "same-origin", origin: "" };

  it("a junk murage_pj_ bearer plus a valid session cookie on a POST returns 403 and reaches nothing", async () => {
    harnessSeen.length = 0; resolveSession.mockClear();
    const headers = { authorization: `Bearer murage_pj_${"B".repeat(43)}`, cookie: "murage_session=valid", "sec-fetch-site": "same-origin", origin: `http://desk.example.test:${doorPort}` };
    for (const p of ["/api/phones/self/jobs", "/api/phones/self/jobs/abc/result", "/api/phones/self/nope", "/api/phones/self", "/api/phones/%73elf/jobs"]) {
      expect((await knock("POST", p, headers, {})).status, p).toBe(403);
    }
    expect((await knock("GET", "/api/phones/self/jobs", headers)).status).toBe(403);
    expect(harnessSeen).toEqual([]);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it("mints end to end with no Sec-Fetch, no cookie, no bearer, and sets no cookie", async () => {
    const ch = await knock("GET", `/api/phones/self/challenge?key=${k.keyId}`);
    expect(ch.status).toBe(200);
    expect(ch.headers["set-cookie"]).toBeUndefined();
    const { nonce, expiresAt } = JSON.parse(ch.body);
    const origin = `http://desk.example.test:${doorPort}`;
    const signature = k.signMessage(phoneJobsMessage({ origin, keyId: k.keyId, nonce, expiresAt }));
    const tok = await knock("POST", "/api/phones/self/token", {}, { keyId: k.keyId, nonce, expiresAt, signature });
    expect(tok.status).toBe(200);
    expect(JSON.parse(tok.body).token).toMatch(PHONE_TOKEN);
    expect(tok.headers["set-cookie"]).toBeUndefined();
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it("a cookie-only probe gets the same 403 and the harness is not asked to mint", async () => {
    const r = await knock("GET", "/api/phones/self/challenge", { cookie: cookie.cookie });
    expect(r.status).toBe(403);
    expect(r.body).toContain("phone sign-in refused");
  });

  it("is 404 on both routes when not offered", async () => {
    offeredNow = false;
    try {
      expect((await knock("GET", `/api/phones/self/challenge?key=${k.keyId}`)).status).toBe(404);
      expect((await knock("POST", "/api/phones/self/token", {}, {})).status).toBe(404);
    } finally { offeredNow = true; }
  });
});
