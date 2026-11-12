// SPDX-License-Identifier: AGPL-3.0-or-later
// The fresh emailed code step and the owner events outbox, against the real request gate and a real sessions database.
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { createCloudRequestAuth, routeActDigest } from "../cloud-request-auth.ts";
import { setCloudIdentity } from "../cloud-request-identity.ts";
import { cardActDigest, createOwnerCode, skillActDigest, type OwnerCodeService, type OwnerCodeDeps } from "./owner-code.ts";
import { OWNER_EVENT_KINDS, createOwnerEvents, ownerEvent, setOwnerEvents } from "./owner-events.ts";
import type { CpResult } from "./cp-client.ts";

const origin = "https://home.example", SECRET = "fixture-bootstrap-key-32-characters", HOME = "home-1";  // secret-scan: fixture
let sessions: CloudSessions, upstream: Server;
const p256 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const cp = p256();   // the control plane's signing key; the home pins its public half
const pem = (key: { publicKey: KeyObject }) => key.publicKey.export({ format: "pem", type: "spki" }).toString();
const jwk = cp.publicKey.export({ format: "jwk" }) as never;
let generation = 1, clock = Date.now();
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); generation = 1; clock = Date.now(); });
afterEach(async () => {
  setOwnerEvents(undefined);
  if (upstream?.listening) { const closed = once(upstream, "close"); upstream.close(); upstream.closeAllConnections(); await closed; }
  if (sessions?.db.isOpen) sessions.db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
function browser(factor: "remembered-owner" | false, account = "owner") {
  const id = randomUUID(), key = p256(), confirm = p256(), now = Date.now();
  sessions.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
  sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)").run(id, account, "browser", pem(key), pem(confirm), 0, 0);
  if (factor) {
    const keyHash = createHash("sha256").update(confirm.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    sessions.db.prepare("INSERT INTO cloud_browser_factors (device,payload,kind,issuedAt,expiresAt,keyHash,stepUpAt,revokedAt) VALUES (?,?,?,?,?,?,?,NULL)")
      .run(id, JSON.stringify({ kind: "remembered-owner", keyHash, proof: "email", stepUpAt: now, ticketNonce: "n" }), "remembered-owner", now, now + 30 * 86_400_000, keyHash, now);
  }
  const issued = sessions.issue(id);
  return { id, token: issued.accessToken, cookie: { cookie: `__Host-murage=${issued.accessToken}` } };
}
type Stub = (op: string, fields?: Record<string, unknown>) => Promise<CpResult>;
const down: Stub = async () => ({ ok: false, status: 0 });
let service: OwnerCodeService;
async function start(callStub: Stub = down, events?: ReturnType<typeof createOwnerEvents>, binding: OwnerCodeDeps["binding"] = () => ({ homeId: HOME, generation, publicJwk: jwk })) {
  sessions = new CloudSessions(new DatabaseSync(":memory:"), undefined, origin);
  service = createOwnerCode({ sessions, call: callStub, secret: () => SECRET, binding, now: () => clock, ...(events ? { events } : {}) });
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => SECRET, ownerAct: service });
  upstream = createServer(async (req, res) => {
    if (await auth(req, res, new URL(req.url!, origin))) return;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ reachedHandler: true }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  return (upstream.address() as AddressInfo).port;
}
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: "home.example", origin, "content-type": "application/json", ...(data ? { "content-length": String(data.length) } : {}), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: t ? JSON.parse(t) : null }); });
    }); req.on("error", reject); req.end(data);
  });
}
/** A proof as the control plane signs it, with any claim overridden. */
function proofHeader(over: Record<string, unknown>, key: { privateKey: KeyObject } = cp, algorithm?: string) {
  const claims = { type: "murage-owner-act-v1", homeId: HOME, generation, account: "owner", deviceId: "x", act: "0".repeat(64), nonce: randomUUID().replace(/-/g, ""), issuedAt: clock - 1000, expiresAt: clock + 119_000, ...over };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("sha256", Buffer.from(payload), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return Buffer.from(JSON.stringify({ payload, signature, ...(algorithm ? { algorithm } : {}) })).toString("base64url");
}
const revokePath = (id: string) => `/api/cloud/devices/${id}/owner/revoke`;
const actFor = (path: string) => routeActDigest("POST", path, {});

describe("a proof for exactly one act", () => {
  it("opens the act it was issued for, once", async () => {
    const port = await start(), owner = browser("remembered-owner"), target = browser("remembered-owner");
    const path = revokePath(target.id);
    const asked = await call(port, "POST", path, owner.cookie, {});
    expect(asked.status).toBe(403);
    expect(asked.body).toMatchObject({ code: "email_code", label: "device_remove" });
    expect(typeof asked.body.actToken).toBe("string");
    const header = proofHeader({ deviceId: owner.id, act: actFor(path) });
    expect((await call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": header }, {})).status).toBe(200);
    expect(sessions.device(target.id)!.factor).toBe(false);
    // the same proof again: its nonce is spent
    const again = browser("remembered-owner");
    expect((await call(port, "POST", revokePath(again.id), { ...owner.cookie, "x-murage-owner-proof": header }, {})).status).toBe(403);
    expect(sessions.device(again.id)!.factor).toBe("remembered-owner");
  });
  it("a replayed proof is refused for the very same act", async () => {
    const port = await start(), owner = browser("remembered-owner");
    const path = "/api/cloud/devices/00000000-0000-0000-0000-000000000000/owner/revoke";
    const header = proofHeader({ deviceId: owner.id, act: actFor(path) });
    expect((await call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": header }, {})).status).toBe(200);
    expect((await call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": header }, {})).status).toBe(403);
  });
  it("refuses a proof for another act, another device, another body, another generation, an expired one, a wrong signature, a wrong account and garbage", async () => {
    const port = await start(), owner = browser("remembered-owner"), other = browser("remembered-owner"), target = browser("remembered-owner");
    const path = revokePath(target.id), act = actFor(path);
    const send = (header: string) => call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": header }, {});
    expect((await send(proofHeader({ deviceId: owner.id, act: actFor(revokePath(other.id)) }))).status).toBe(403);   // another act
    expect((await send(proofHeader({ deviceId: other.id, act }))).status).toBe(403);                                 // another device
    expect((await call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": proofHeader({ deviceId: owner.id, act: routeActDigest("POST", path, { changed: true }) }) }, {})).status).toBe(403);   // body changed after the code
    expect((await send(proofHeader({ deviceId: owner.id, act, expiresAt: clock - 1 }))).status).toBe(403);           // expired
    expect((await send(proofHeader({ deviceId: owner.id, act, issuedAt: clock - 400_000, expiresAt: clock + 400_000 }))).status).toBe(403);   // lives longer than 120 s
    expect((await send(proofHeader({ deviceId: owner.id, act }, p256()))).status).toBe(403);                         // wrong signature
    expect((await send(proofHeader({ deviceId: owner.id, act, account: "someone-else" }))).status).toBe(403);       // wrong account
    expect((await send(proofHeader({ deviceId: owner.id, act, extra: 1 }))).status).toBe(403);                       // not the strict shape
    expect((await send(proofHeader({ deviceId: owner.id, act }, cp, "RS256"))).status).toBe(403);
    for (const garbage of ["", "!!", "e30", Buffer.from("[1]").toString("base64url"), "a".repeat(9000)]) expect((await send(garbage)).status).toBe(403);
    // a good proof for another generation: refused; the same proof at the pinned generation is not
    const stale = proofHeader({ deviceId: owner.id, act, generation: 2 });
    expect((await send(stale)).status).toBe(403);
    generation = 2;
    expect((await send(proofHeader({ deviceId: owner.id, act, generation: 1 }))).status).toBe(403);               // the pin moved
    expect(sessions.device(target.id)!.factor).toBe("remembered-owner");
    expect((await send(proofHeader({ deviceId: owner.id, act, generation: 2 }))).status).toBe(200);
  });
  it("a refused proof keeps its nonce for the request it was really issued for", async () => {
    const port = await start(), owner = browser("remembered-owner"), other = browser("remembered-owner"), target = browser("remembered-owner");
    const path = revokePath(target.id), header = proofHeader({ deviceId: owner.id, act: actFor(path) });
    expect((await call(port, "POST", path, { ...other.cookie, "x-murage-owner-proof": header }, {})).status).toBe(403);
    expect((await call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": header }, {})).status).toBe(200);
  });
  it("without the code service a code route answers the plain unavailable words and no token", async () => {
    sessions = new CloudSessions(new DatabaseSync(":memory:"), undefined, origin);
    const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => SECRET });
    upstream = createServer(async (req, res) => { if (await auth(req, res, new URL(req.url!, origin))) return; res.end("{}"); });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const owner = browser("remembered-owner"), res = await call((upstream.address() as AddressInfo).port, "POST", revokePath(browser("remembered-owner").id), owner.cookie, {});
    expect(res.status).toBe(403); expect(res.body.actToken).toBeUndefined();
  });
});

describe("owner proof failure diagnostics", () => {
  it("names an unreadable binding and accepts the same correct proof after the binding recovers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let readable = false;
    const port = await start(down, undefined, () => {
      if (!readable) throw new Error("private binding canary");
      return { homeId: HOME, generation, publicJwk: jwk };
    });
    const owner = browser("remembered-owner"), path = revokePath(browser("remembered-owner").id);
    const proof = proofHeader({ deviceId: owner.id, act: actFor(path) });
    const send = () => call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": proof }, {});
    expect((await send()).status).toBe(403);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[owner-code] proof refused:", "binding");
    readable = true;
    expect((await send()).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/canary|payload|signature/);
  });

  it.each(["DELETE FROM cloud_door_nonces", "INSERT INTO cloud_door_nonces"])("names a nonce-store failure at %s without spending the correct proof", async (sql) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = await start(), owner = browser("remembered-owner"), path = revokePath(browser("remembered-owner").id);
    const proof = proofHeader({ deviceId: owner.id, act: actFor(path) });
    const original = sessions.db.prepare.bind(sessions.db);
    const prepare = vi.spyOn(sessions.db, "prepare").mockImplementation(query => {
      if (query.startsWith(sql)) throw Object.assign(new Error("private nonce canary"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      return original(query);
    });
    const send = () => call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": proof }, {});
    expect((await send()).status).toBe(403);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[owner-code] proof refused:", "nonce-store");
    prepare.mockRestore();
    expect((await send()).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a spent proof from a broken nonce store and an invalid signature", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = await start(), owner = browser("remembered-owner");
    const path = "/api/cloud/devices/00000000-0000-0000-0000-000000000000/owner/revoke", act = actFor(path);
    const proof = proofHeader({ deviceId: owner.id, act });
    const send = (header: string) => call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": header }, {});
    expect((await send(proof)).status).toBe(200);
    expect((await send(proof)).status).toBe(403);
    expect(warn).toHaveBeenLastCalledWith("[owner-code] proof refused:", "proof-reused");
    expect((await send(proofHeader({ deviceId: owner.id, act }, p256()))).status).toBe(403);
    expect(warn).toHaveBeenLastCalledWith("[owner-code] proof refused:", "bad-proof");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(proof);
  });
});

describe("the act token and the two code routes", () => {
  const SENT: CpResult = { ok: true, status: 200, body: { sent: true, reused: false, challengeId: `oc_${"a".repeat(32)}`, maskedEmail: "s***@gmail.com", digits: 6, expiresIn: 600, resendIn: 30 } };
  const PROOF: CpResult = { ok: true, status: 200, body: { proof: { payload: "p", signature: "s", algorithm: "ES256" }, expiresAt: 1 } };
  const tokenFor = async (port: number, who: { cookie: Record<string, string> }) => (await call(port, "POST", revokePath(browser("remembered-owner").id), who.cookie, {})).body.actToken as string;
  it("send relays only what the token says and answers the page's shape", async () => {
    const seen: unknown[] = [];
    const port = await start(async (op, fields) => { seen.push([op, fields]); return SENT; });
    const owner = browser("remembered-owner"), actToken = await tokenFor(port, owner);
    const res = await call(port, "POST", "/api/cloud/owner-code/send", owner.cookie, { actToken, act: "f".repeat(64), label: "full_access" });
    expect(res).toEqual({ status: 200, body: { challengeId: `oc_${"a".repeat(32)}`, maskedEmail: "s***@gmail.com", resendIn: 30 } });
    expect(seen).toEqual([["owner-code-send", { deviceId: owner.id, act: expect.stringMatching(/^[0-9a-f]{64}$/), label: "device_remove" }]]);
    expect((seen[0] as any)[1].act).not.toBe("f".repeat(64));   // the page cannot choose the act or the words
  });
  it("another device, another sign-in, an expired or an altered token are all refused and nothing is sent", async () => {
    const seen: unknown[] = [];
    const port = await start(async (op) => { seen.push(op); return SENT; });
    const owner = browser("remembered-owner"), stranger = browser("remembered-owner"), actToken = await tokenFor(port, owner);
    const send = (cookie: Record<string, string>, token: string) => call(port, "POST", "/api/cloud/owner-code/send", cookie, { actToken: token });
    expect((await send(stranger.cookie, actToken)).status).toBe(403);                                     // another device
    const second = sessions.issue(owner.id);                                                              // the same device, another sign-in (access hash)
    expect((await send({ cookie: `__Host-murage=${second.accessToken}` }, actToken)).status).toBe(403);
    const [payload, mac] = actToken.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), label: "full_access" })).toString("base64url");
    expect((await send(owner.cookie, `${edited}.${mac}`)).status).toBe(403);                              // altered label
    expect((await send(owner.cookie, `${payload}.${"0".repeat(64)}`)).status).toBe(403);
    expect((await send(owner.cookie, "garbage")).status).toBe(403);
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), exp: clock + 60_000 })).toString("base64url");
    expect((await send(owner.cookie, `${forged}.${createHmac("sha256", "wrong-secret").update("murage-act-token-v1\n" + forged).digest("hex")}`)).status).toBe(403);
    clock += 11 * 60_000;                                                                                 // expired
    expect((await send(owner.cookie, actToken)).status).toBe(403);
    expect(seen).toEqual([]);
  });
  it("only an owner browser reaches send and verify", async () => {
    const port = await start(async () => SENT), owner = browser("remembered-owner"), chat = browser(false), actToken = await tokenFor(port, owner);
    for (const path of ["/api/cloud/owner-code/send", "/api/cloud/owner-code/verify"]) {
      expect((await call(port, "POST", path, chat.cookie, { actToken })).status).toBe(403);
      expect((await call(port, "POST", path, {}, { actToken })).status).toBe(403);
    }
  });
  it("answers a rate limit, a daily limit and an outage in plain shapes and changes nothing", async () => {
    let answer: CpResult = { ok: false, status: 429, body: { error: "rate_limited", retryAfter: 30, limit: "gap" } };
    const port = await start(async () => answer), owner = browser("remembered-owner"), actToken = await tokenFor(port, owner);
    const send = () => call(port, "POST", "/api/cloud/owner-code/send", owner.cookie, { actToken });
    expect(await send()).toEqual({ status: 429, body: { error: "rate", retryIn: 30, limit: "gap" } });
    answer = { ok: false, status: 429, body: { error: "rate_limited", retryAfter: 80000, limit: "day" } };
    expect(await send()).toEqual({ status: 429, body: { error: "rate", retryIn: 80000, limit: "day" } });
    for (const outage of [{ ok: false, status: 0 }, { ok: false, status: 503, body: { error: "email_unavailable" } }] as CpResult[]) {
      answer = outage;
      expect(await send()).toEqual({ status: 503, body: { error: "We couldn't send your code just now. Nothing was changed. Try again in a minute.", code: "code_unavailable" } });
    }
  });
  it("verify hands back a proof only when the control plane did, and maps wrong, expired and locked", async () => {
    let answer: CpResult = PROOF;
    const port = await start(async () => answer), owner = browser("remembered-owner"), actToken = await tokenFor(port, owner);
    const verify = (body: Record<string, unknown> = {}) => call(port, "POST", "/api/cloud/owner-code/verify", owner.cookie, { actToken, challengeId: `oc_${"a".repeat(32)}`, code: "123456", ...body });
    expect(await verify()).toEqual({ status: 200, body: { proof: { payload: "p", signature: "s", algorithm: "ES256" } } });
    answer = { ok: false, status: 403, body: { error: "code_refused" } };
    expect(await verify()).toEqual({ status: 400, body: { error: "wrong" } });
    answer = { ok: false, status: 403, body: { error: "code_expired" } };
    expect(await verify()).toEqual({ status: 400, body: { error: "expired" } });
    answer = { ok: false, status: 403, body: { error: "code_locked" } };
    expect(await verify()).toEqual({ status: 400, body: { error: "locked" } });
    answer = { ok: false, status: 0 };
    expect((await verify()).status).toBe(503);
    // a harness that guesses cannot get a proof: the control plane refuses and the answer has none
    answer = { ok: false, status: 403, body: { error: "code_refused" } };
    for (const bad of [{ code: "12" }, { code: "abcdef" }, { challengeId: "nope" }]) { const r = await verify(bad); expect(r.status).toBe(400); expect(r.body.proof).toBeUndefined(); }
    expect((await verify()).body.proof).toBeUndefined();
  });
  it("is limited per device", async () => {
    const port = await start(async () => SENT), owner = browser("remembered-owner"), actToken = await tokenFor(port, owner);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await call(port, "POST", "/api/cloud/owner-code/send", owner.cookie, { actToken })).status);
    expect(codes.slice(0, 10).every(c => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    const other = browser("remembered-owner");
    expect((await call(port, "POST", "/api/cloud/owner-code/send", other.cookie, { actToken: await tokenFor(port, other) })).status).toBe(200);
  });
  it("refuses a large body", async () => {
    const port = await start(async () => SENT), owner = browser("remembered-owner");
    expect((await call(port, "POST", "/api/cloud/owner-code/send", owner.cookie, { actToken: "x".repeat(6000) })).status).toBe(413);
  });
});

describe("act digests", () => {
  const base = { threadId: "t", requestId: "r", decision: "allow", approvalDigest: "d", riskReason: "why" };
  it("change with any field and ignore key order in extra", () => {
    const d = cardActDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    for (const k of Object.keys(base)) expect(cardActDigest({ ...base, [k]: "other" })).not.toBe(d);
    expect(cardActDigest({ ...base, extra: { a: 1, b: 2 } })).toBe(cardActDigest({ ...base, extra: { b: 2, a: 1 } }));
    expect(cardActDigest({ ...base, extra: { a: 1 } })).not.toBe(d);
    expect(skillActDigest("route", "hash1")).not.toBe(skillActDigest("route", "hash2"));
    expect(skillActDigest("route", "hash1")).not.toBe(skillActDigest("route2", "hash1"));
  });
});

describe("owner events outbox", () => {
  const rows = (db: DatabaseSync) => db.prepare("SELECT seq, kind, sent, tries FROM home_owner_events ORDER BY seq").all() as { seq: number; kind: string; sent: number; tries: number }[];
  it("keeps unsent rows across a restart, sends oldest first with only seq and kind, and dedupes on seq", async () => {
    const db = new DatabaseSync(":memory:");
    const first = createOwnerEvents({ db, call: down, now: () => clock });
    first.record("flux_key_changed"); first.record("webhook_added");
    first.record("not_a_kind" as never);
    await first.flush();
    expect(rows(db).map(r => [r.seq, r.kind, r.sent])).toEqual([[1, "flux_key_changed", 0], [2, "webhook_added", 0]]);
    const payloads: unknown[] = [];
    const second = createOwnerEvents({ db, call: async (op, fields) => { payloads.push([op, fields]); return { ok: true, status: 200, body: { recorded: true, duplicate: false } }; }, now: () => clock + 10 * 60_000 });
    await second.flush();
    expect(payloads).toEqual([["owner-event", { seq: 1, kind: "flux_key_changed" }], ["owner-event", { seq: 2, kind: "webhook_added" }]]);
    expect(rows(db).every(r => r.sent === 1)).toBe(true);
    await second.flush();
    expect(payloads).toHaveLength(2);   // nothing is resent
    for (const kind of OWNER_EVENT_KINDS) expect(kind).toMatch(/^[a-z_]+$/);
  });
  it("backs off after a failure and sends at most a few a pass", async () => {
    const db = new DatabaseSync(":memory:"); let t = clock; const seen: number[] = [];
    const events = createOwnerEvents({ db, call: async (_op, f) => { seen.push((f as { seq: number }).seq); return { ok: false, status: 503 }; }, now: () => t, perPass: 2 });
    for (let i = 0; i < 4; i++) events.record("code_used");
    await events.flush(); expect(seen).toEqual([1, 2]);
    await events.flush(); expect(seen).toEqual([1, 2, 3, 4]);   // 1 and 2 wait out their backoff
    t += 60_000; await events.flush(); expect(seen.slice(4)).toEqual([1, 2]);
  });
  it("records only for an owner browser; the desktop and phone record nothing", async () => {
    const db = new DatabaseSync(":memory:");
    const events = createOwnerEvents({ db, call: down }); setOwnerEvents(events);
    await start();
    const owner = browser("remembered-owner"), chat = browser(false);
    const req = (device: ReturnType<typeof sessions.device>) => { const r = { headers: {} } as IncomingMessage; if (device) setCloudIdentity(r.headers, device); return r; };
    ownerEvent(req(sessions.device(chat.id)), "flux_key_changed");
    ownerEvent(req({ ...sessions.device(owner.id)!, scope: "owner-desktop" }), "flux_key_changed");
    ownerEvent(req({ ...sessions.device(owner.id)!, scope: "owner-phone" }), "flux_key_changed");
    ownerEvent(req(undefined), "flux_key_changed");
    expect(rows(db)).toEqual([]);
    ownerEvent(req(sessions.device(owner.id)), "flux_key_changed");
    expect(rows(db)).toHaveLength(1);
  });
  it("a spent proof records code_used", async () => {
    const db = new DatabaseSync(":memory:"), events = createOwnerEvents({ db, call: down });
    const port = await start(down, events), owner = browser("remembered-owner");
    const path = "/api/cloud/devices/00000000-0000-0000-0000-000000000001/owner/revoke";
    expect((await call(port, "POST", path, { ...owner.cookie, "x-murage-owner-proof": proofHeader({ deviceId: owner.id, act: actFor(path) }) }, {})).status).toBe(200);
    expect(rows(db).map(r => r.kind)).toEqual(["code_used"]);
  });
});
