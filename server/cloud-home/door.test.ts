// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { createCloudRequestAuth } from "../cloud-request-auth.ts";
import { isOwnerBrowser } from "../cloud-request-identity.ts";
import { cloudRouteDecision } from "../route-policy.ts";
import { cloudHomeCopy } from "./copy.ts";
import { verifiedDoorTicket, type SignedHomeKey } from "./b1b-identity.ts";
import { doorOutcomeOf } from "./door-log.ts";
import { listenCloudProxy } from "./proxy-socket.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const origin = "https://h-abc.example", host = "h-abc.example", homeId = "home-1", generation = 3, secret = "x".repeat(32);
const cp = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), cpJwk = cp.publicKey.export({ format: "jwk" });
type Pair = { publicKey: KeyObject; privateKey: KeyObject };
const ec = (): Pair => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ed = (): Pair => generateKeyPairSync("ed25519");
const pem = (key: Pair) => key.publicKey.export({ format: "pem", type: "spki" }).toString();
const bindOf = (key: Pair) => createHash("sha256").update(key.publicKey.export({ format: "der", type: "spki" })).digest("hex");
const signWith = (key: Pair, message: string) => (key.privateKey.asymmetricKeyType === "ed25519" ? sign(null, Buffer.from(message), key.privateKey) : sign("sha256", Buffer.from(message), { key: key.privateKey, dsaEncoding: "ieee-p1363" })).toString("base64url");
const nonce = () => randomBytes(16).toString("base64url");
/** A device as the page or the app holds it: a session key and an assertion key. */
const mkDevice = (kind: "p256" | "ed25519" = "p256") => ({ key: kind === "p256" ? ec() : ed(), assertion: kind === "p256" ? ec() : ed() });
type Dev = ReturnType<typeof mkDevice>;
function ticket(now: number, over: Record<string, unknown> = {}, raw = false): string {
  const claims = { type: "murage-door-v2", homeId, generation, publicOrigin: origin, account: "owner", nonce: nonce(), stepUpAt: now - 1000, issuedAt: now - 500, expiresAt: now + 59_000, bind: "a".repeat(64), kind: "browser", ...over };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signed = raw ? Buffer.from(JSON.stringify(claims)) : Buffer.from(payload);
  return `${payload}.${sign("sha256", signed, { key: cp.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
/** A ticket minted for this device's session key, and the body the page posts for it. */
function enter(now: number, dev: Dev, over: Record<string, unknown> = {}, tamper: { proofKey?: Pair; proofOver?: string; deviceId?: unknown; assertionProofKey?: Pair; assertionProofOver?: string; omitAssertionProof?: boolean } = {}) {
  const t = ticket(now, { bind: bindOf(dev.key), ...over });
  const device: Record<string, unknown> = { deviceId: tamper.deviceId ?? null, publicKey: pem(dev.key), assertionKey: pem(dev.assertion), proof: signWith(tamper.proofKey ?? dev.key, `murage-door-v2:${tamper.proofOver ?? t}`) };
  if (!tamper.omitAssertionProof) device.assertionProof = signWith(tamper.assertionProofKey ?? dev.assertion, `murage-door-v2-assertion:${tamper.assertionProofOver ?? t}`);
  return { t, body: { ticket: t, device } };
}
const envelope = (t: string): SignedHomeKey => { const dot = t.indexOf("."); return { algorithm: "ES256", payload: t.slice(0, dot), signature: t.slice(dot + 1) }; };
const verify = (t: string, now: number) => verifiedDoorTicket(envelope(t), cpJwk, homeId, generation, origin, now);
const outcomeOf = (fn: () => unknown) => { try { fn(); } catch (error) { return doorOutcomeOf(error); } return "none"; };

describe("verifiedDoorTicket", () => {
  const now = 1_800_000_000_000;
  it("accepts a well-formed v2 ticket, with or without a pair hold", () => {
    expect(verify(ticket(now), now).kind).toBe("browser");
    expect(verify(ticket(now, { kind: "desktop", pairHold: "hold-0123456789abcdef" }), now).pairHold).toBe("hold-0123456789abcdef");
  });
  it("accepts a step-up up to 15 minutes before issue and refuses an older one", () => {
    expect(() => verify(ticket(now, { stepUpAt: now - 500 - 900_000 }), now)).not.toThrow();
    expect(outcomeOf(() => verify(ticket(now, { stepUpAt: now - 500 - 900_001 }), now))).toBe("ticket_stale_step_up");
  });
  it("names a ticket of another type ticket_wrong_type, before it could be called malformed", () => {
    for (const type of ["murage-door-v1", "murage-home-key-v1", "murage-recovery-v1", "x"]) expect(outcomeOf(() => verify(ticket(now, { type }), now)), type).toBe("ticket_wrong_type");
    const v1 = { type: "murage-door-v1", homeId, generation, publicOrigin: origin, account: "owner", nonce: nonce(), stepUpAt: now - 1000, issuedAt: now - 500, expiresAt: now + 59_000 };
    const payload = Buffer.from(JSON.stringify(v1)).toString("base64url");
    const t = `${payload}.${sign("sha256", Buffer.from(payload), { key: cp.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    expect(outcomeOf(() => verify(t, now))).toBe("ticket_wrong_type");
  });
  it("refuses forged, raw-JSON-signed, extra-field, bad bind, bad kind, bad hold, wrong-binding, expired, long-lived and stale step-up tickets", () => {
    const other = ec(), payload = ticket(now).split(".")[0]!;
    const forged = `${payload}.${sign("sha256", Buffer.from(payload), { key: other.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    for (const t of [forged, ticket(now, {}, true), ticket(now, { extra: 1 }),
      ticket(now, { bind: "short" }), ticket(now, { bind: "A".repeat(64) }), ticket(now, { bind: undefined }), ticket(now, { kind: "phone" }), ticket(now, { kind: undefined }), ticket(now, { pairHold: "short" }),
      ticket(now, { homeId: "home-2" }), ticket(now, { generation: generation + 1 }), ticket(now, { publicOrigin: "https://h-other.example" }),
      ticket(now, { expiresAt: now - 1 }), ticket(now, { expiresAt: now + 61_000 }), ticket(now, { stepUpAt: now - 1_000_000 }), ticket(now, { stepUpAt: now + 5000 }),
      ticket(now, { nonce: "short" }), ticket(now, { account: "" })]) expect(() => verify(t, now)).toThrow();
  });
  it("is not accepted by the other verifiers, nor do their envelopes verify as door tickets", async () => {
    const { verifiedHomeIdentity, verifiedRecoveryHold } = await import("./b1b-identity.ts");
    expect(() => verifiedHomeIdentity(envelope(ticket(now)), cpJwk, homeId, generation, origin, now)).toThrow();
    expect(() => verifiedRecoveryHold(envelope(ticket(now)), cpJwk, homeId, generation, now)).toThrow();
    const payload = Buffer.from(JSON.stringify({ type: "murage-home-key-v1", homeId, generation, publicOrigin: origin, homeKey: "k", issuedAt: now - 1, expiresAt: now + 1000 })).toString("base64url");
    const t = `${payload}.${sign("sha256", Buffer.from(payload), { key: cp.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    expect(() => verify(t, now)).toThrow();
  });
});

type Res = { status: number; body: any; cookies: string[] };
let servers: Server[] = [], dbs: DatabaseSync[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const s of servers) { s.closeAllConnections?.(); await new Promise<void>(r => s.close(() => r())); }
  for (const d of dbs) d.close(); for (const d of dirs) removeTempDirSync(d);
  servers = []; dbs = []; dirs = [];
});
async function home(opts: { unix?: boolean; now?: () => number; bound?: boolean } = {}) {
  let t = 1_800_000_000_000, verifies = 0;
  const clock = opts.now ?? (() => t);
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  const sessions = new CloudSessions(db, clock, origin);
  const proxy = opts.unix ? join(mkdtempSync(join(tmpdir(), "dr-")), "p.sock") : undefined;
  if (proxy) dirs.push(join(proxy, ".."));
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, trustedProxy: proxy ? `unix:${proxy}` : undefined, bootstrapSecret: () => "x".repeat(32),
    doorTicket: tk => { verifies++; return verifiedDoorTicket(tk, cpJwk, homeId, generation, origin, clock()); } });
  const server = createServer(async (req, res) => { if (await auth(req, res, new URL(req.url!, origin))) return; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  let unix: Server | null = null;
  if (proxy) { process.env.MURAGE_CLOUD_ROLE = "home"; unix = listenCloudProxy(server, proxy); await once(unix!, "listening"); delete process.env.MURAGE_CLOUD_ROLE; servers.push(unix!); }
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<Res>((resolve, reject) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const h: Record<string, string> = { host, ...(method === "POST" ? { origin } : {}), ...(raw ? { "content-type": "application/json", "content-length": String(raw.length) } : {}), ...headers };
    const opts2 = proxy ? { socketPath: proxy } : { host: "127.0.0.1", port: (server.address() as AddressInfo).port };
    const req = request({ ...opts2, path, method, headers: proxy ? { ...h, "x-forwarded-host": host } : h }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
      res.on("end", () => { let b: any = {}; try { b = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* empty */ } resolve({ status: res.statusCode!, body: b, cookies: res.headers["set-cookie"] ?? [] }); });
    });
    req.on("error", reject); req.end(raw);
  });
  return { sessions, db, call, tick: (ms: number) => { t += ms; }, now: clock, verifies: () => verifies };
}
const cookieOf = (r: Res, name = "__Host-murage") => r.cookies.find(c => c.startsWith(`${name}=`));
const sessionCookie = (r: Res) => ({ cookie: cookieOf(r)!.split(";")[0]! });
const xff = (n: number) => ({ "x-forwarded-for": `192.0.2.${n}` });
const rows = (h: { db: DatabaseSync }) => (h.db.prepare("SELECT COUNT(*) AS n FROM cloud_devices").get() as { n: number }).n;
const nonces = (h: { db: DatabaseSync }) => (h.db.prepare("SELECT COUNT(*) AS n FROM cloud_door_nonces").get() as { n: number }).n;
/** Signs and posts a HMAC-authenticated home management call, as the control plane does. */
function management(h: { call: Awaited<ReturnType<typeof home>>["call"]; now: () => number }, path: string, extra: Record<string, unknown> = {}, over: { operation?: string; nonce?: string } = {}) {
  const raw = JSON.stringify({ operation: over.operation ?? path, timestamp: h.now() / 1000, nonce: over.nonce ?? nonce(), ...extra });
  return h.call("POST", path, JSON.parse(raw), { "x-murage-signature": createHmac("sha256", secret).update(Buffer.from(raw)).digest("hex") });
}

describe("the door routes", () => {
  it("first browser: bound key and proof, exact cookie, no token in the body, then the key renews its session", async () => {
    const h = await home(); const dev = mkDevice();
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body);
    expect(r.status).toBe(200);
    expect(cookieOf(r)).toMatch(/^__Host-murage=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=900$/);
    expect(r.body).toEqual({ state: "signed-in", reason: "first-device", deviceId: expect.any(String), scope: "browser", expiresIn: 900, owner: false });
    expect(JSON.stringify(r.body)).not.toContain("ccessToken");
    expect(h.sessions.owner()).toBe("owner");
    const row = h.sessions.device(r.body.deviceId)!;
    expect(row.factor).toBe(false); expect(row.addedAt).toBe(h.now()); expect(row.lastSeenAt).toBe(h.now());
    const ch = await h.call("POST", "/api/cloud/challenge", { deviceId: r.body.deviceId });
    const at = h.now() - 1000;
    const refreshed = await h.call("POST", "/api/cloud/refresh", { deviceId: r.body.deviceId, challenge: ch.body.challenge, at, signature: signWith(dev.key, `murage:${h.sessions.environmentId}:${r.body.deviceId}:refresh:${ch.body.challenge}:${at}`) });
    expect(refreshed.status).toBe(200); expect(cookieOf(refreshed)).toBeDefined();
  });
  it("a refused challenge or refresh says revoked only for a removed device, suspended for a paused account, and nothing otherwise", async () => {
    const h = await home(); const dev = mkDevice();
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body);
    const id = r.body.deviceId;
    const refreshWith = async () => {
      const ch = await h.call("POST", "/api/cloud/challenge", { deviceId: id }); const at = h.now() - 1000;
      return h.call("POST", "/api/cloud/refresh", { deviceId: id, challenge: ch.body.challenge ?? "x", at, signature: signWith(dev.key, `murage:${h.sessions.environmentId}:${id}:refresh:${ch.body.challenge}:${at}`) });
    };
    // unknown device: refused with no reason, so a computer never forgets its sign-in on a guess
    const unknown = await h.call("POST", "/api/cloud/challenge", { deviceId: "no-such-device" });
    expect(unknown.status).toBe(403); expect(unknown.body.reason).toBeUndefined();
    // paused account: the device is still there
    h.sessions.db.prepare("INSERT OR REPLACE INTO cloud_meta VALUES ('suspended','1')").run();
    const paused = await h.call("POST", "/api/cloud/challenge", { deviceId: id });
    expect(paused.status).toBe(403); expect(paused.body.reason).toBe("suspended");
    expect(h.sessions.refusalReason(id)).toBe("suspended");
    h.sessions.db.prepare("DELETE FROM cloud_meta WHERE key='suspended'").run();
    expect((await refreshWith()).status).toBe(200);
    // a bad signature on a live device: refused, no reason
    const ch = await h.call("POST", "/api/cloud/challenge", { deviceId: id });
    const bad = await h.call("POST", "/api/cloud/refresh", { deviceId: id, challenge: ch.body.challenge, at: h.now() - 1000, signature: "AAAA" });
    expect(bad.status).toBe(403); expect(bad.body.reason).toBeUndefined();
    // removed: revoked
    h.sessions.revoke(id);
    const gone = await h.call("POST", "/api/cloud/challenge", { deviceId: id });
    expect(gone.status).toBe(403); expect(gone.body.reason).toBe("revoked");
  });
  it("lastSeenAt moves when a session is issued", async () => {
    const h = await home(); const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body);
    h.tick(120_000); h.sessions.issue(r.body.deviceId);
    expect(h.sessions.device(r.body.deviceId)!.lastSeenAt).toBe(h.now());
    expect(h.sessions.device(r.body.deviceId)!.addedAt).toBe(h.now() - 120_000);
  });
  it("refuses a key the ticket was not minted for, a bad proof and bad keys, and inserts nothing", async () => {
    const h = await home({ unix: true }); const now = h.now(), dev = mkDevice(); let n = 0;
    const cases: [Awaited<ReturnType<typeof enter>>, string][] = [
      [enter(now, dev, { bind: bindOf(ec()) }), "bind"],
      [enter(now, dev, {}, { proofKey: ec() }), "proof by another key"],
      [enter(now, dev, {}, { proofOver: "another ticket" }), "proof over another ticket"],
      [enter(now, dev, { bind: "0".repeat(64) }), "unrelated bind"],
    ];
    for (const [c, label] of cases) { const r = await h.call("POST", "/api/cloud/enter", c.body, xff(++n)); expect(r.status, label).toBe(403); expect(r.body).toEqual({ error: cloudHomeCopy.doorTicketRefused, reason: "refused" }); }
    const edDev = mkDevice("ed25519");
    expect((await h.call("POST", "/api/cloud/enter", enter(now, edDev).body, xff(++n))).status).toBe(403); // Ed25519 on a browser ticket
    const same = enter(now, dev); (same.body.device as any).assertionKey = (same.body.device as any).publicKey;
    expect((await h.call("POST", "/api/cloud/enter", same.body, xff(++n))).status).toBe(403); // equal keys
    const mixed = { key: ec(), assertion: ed() };
    expect((await h.call("POST", "/api/cloud/enter", enter(now, mixed).body, xff(++n))).status).toBe(403); // one Ed25519 key on a browser ticket
    expect(rows(h)).toBe(0); expect(nonces(h)).toBe(0); expect(h.sessions.owner()).toBeUndefined();
  });
  it("a wrong proof leaves the ticket usable by the key holder, which then spends it once", async () => {
    const h = await home(); const dev = mkDevice(); const good = enter(h.now(), dev);
    const bad = { ticket: good.t, device: { ...(good.body.device as object), proof: signWith(ec(), `murage-door-v2:${good.t}`) } };
    expect((await h.call("POST", "/api/cloud/enter", bad)).status).toBe(403);
    expect((await h.call("POST", "/api/cloud/enter", good.body)).status).toBe(200);
    const again = await h.call("POST", "/api/cloud/enter", good.body);
    expect(again.status).toBe(403); expect(again.body.reason).toBe("expired");
    expect(rows(h)).toBe(1); expect(nonces(h)).toBe(1);
  });
  it("spends a nonce once, even under 8 concurrent enters", async () => {
    const h = await home(); const e = enter(h.now(), mkDevice());
    const results = await Promise.all(Array.from({ length: 8 }, () => h.call("POST", "/api/cloud/enter", e.body)));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(nonces(h)).toBe(1); expect(rows(h)).toBe(1);
  });
  it("is idempotent on the key: the same key is known, a revoked row's key gets a new row, and deviceId decides nothing", async () => {
    const h = await home(); const dev = mkDevice();
    const first = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body);
    const known = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, {}, { deviceId: "00000000-0000-4000-8000-000000000000" }).body);
    expect(known.status).toBe(200); expect(known.body.reason).toBe("known-device"); expect(known.body.deviceId).toBe(first.body.deviceId); expect(rows(h)).toBe(1);
    const other = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice(), {}, { deviceId: first.body.deviceId }).body);
    expect(other.body.reason).toBe("device-added"); expect(other.body.deviceId).not.toBe(first.body.deviceId); expect(rows(h)).toBe(2);
    h.sessions.revoke(first.body.deviceId);
    const back = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, {}, { deviceId: first.body.deviceId }).body);
    expect(back.status).toBe(200); expect(back.body.reason).toBe("device-added"); expect(back.body.deviceId).not.toBe(first.body.deviceId); expect(rows(h)).toBe(3);
  });
  it("refuses the 11th active browser with too_many_devices, and a revoked one frees a place", async () => {
    const h = await home(); const ids: string[] = [];
    for (let i = 0; i < 10; i++) { const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body); expect(r.status).toBe(200); ids.push(r.body.deviceId); }
    const eleventh = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body);
    expect(eleventh.status).toBe(403); expect(eleventh.body.reason).toBe("too_many_devices"); expect(rows(h)).toBe(10);
    h.sessions.revoke(ids[0]!);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body)).status).toBe(200);
  });
  it("refuses a v1 ticket with a valid signature: ticket_wrong_type, nothing inserted, nonce untouched", async () => {
    const h = await home(); const dev = mkDevice(); const now = h.now();
    const v1 = ticket(now, { type: "murage-door-v1", bind: undefined, kind: undefined });
    const r = await h.call("POST", "/api/cloud/enter", { ticket: v1, device: { deviceId: null, publicKey: pem(dev.key), assertionKey: pem(dev.assertion), proof: signWith(dev.key, `murage-door-v2:${v1}`) } });
    expect(r.status).toBe(403); expect(r.body.reason).toBe("refused");
    expect(rows(h)).toBe(0); expect(nonces(h)).toBe(0);
  });
  it("refuses wrong-home, wrong-generation, wrong-account, foreign-origin and malformed-device requests", async () => {
    const h = await home({ unix: true }); const now = h.now(), dev = mkDevice(); let n = 0;
    for (const over of [{ expiresAt: now - 1 }, { homeId: "x" }, { generation: 9 }]) expect((await h.call("POST", "/api/cloud/enter", enter(now, dev, over).body, xff(++n))).status).toBe(403);
    expect((await h.call("POST", "/api/cloud/enter", enter(now, dev).body, { ...xff(++n), origin: "https://evil.example" })).status).toBe(403);
    const ok = enter(now, dev); const dv = ok.body.device as any;
    for (const device of [undefined, null, "x", [], { ...dv, publicKey: 5 }, { ...dv, assertionKey: "" }, { ...dv, proof: "p".repeat(4097) }, { ...dv, deviceId: "d".repeat(65) }, { ...dv, deviceId: 7 }]) {
      const r = await h.call("POST", "/api/cloud/enter", { ticket: ok.t, device }, xff(++n)); expect(r.status).toBe(403);
    }
    expect(nonces(h)).toBe(0);
    h.sessions.db.prepare("INSERT INTO cloud_meta VALUES ('account','someone-else')").run();
    expect((await h.call("POST", "/api/cloud/enter", enter(now, dev).body, xff(++n))).status).toBe(403);
    expect(rows(h)).toBe(0);
  });
  it("a desktop on an empty home or a home with only browsers is added without a hold, and gets its token in the body", async () => {
    const h = await home(); const dev = mkDevice("ed25519");
    const empty = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { kind: "desktop" }).body);
    expect(empty.status).toBe(200); expect(empty.body.scope).toBe("owner-desktop"); expect(empty.body.reason).toBe("first-device");
    expect(empty.body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(empty.cookies).toEqual([]);
    const g = await home(); await g.call("POST", "/api/cloud/enter", enter(g.now(), mkDevice()).body);
    const added = await g.call("POST", "/api/cloud/enter", enter(g.now(), mkDevice("ed25519"), { kind: "desktop" }).body);
    expect(added.status).toBe(200); expect(added.body.reason).toBe("device-added");
    // A browser ticket never mints owner-desktop; only the one desktop above exists.
    expect((g.db.prepare("SELECT COUNT(*) AS n FROM cloud_devices WHERE scope='owner-desktop'").get() as { n: number }).n).toBe(1);
    const b = await g.call("POST", "/api/cloud/enter", enter(g.now(), mkDevice(), { kind: "browser" }).body);
    expect(b.body.scope).toBe("browser");
  });
  it("r4.2 (a): an active desktop plus a completed hold adds a second desktop and the first stays active", async () => {
    const h = await home(); const first = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), { kind: "desktop" }).body);
    const second = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), { kind: "desktop", pairHold: "hold-0123456789abcdef" }).body);
    expect(second.status).toBe(200); expect(second.body.scope).toBe("owner-desktop"); expect(second.body.reason).toBe("device-added");
    expect(h.sessions.device(first.body.deviceId)).toBeDefined(); expect(h.sessions.device(second.body.deviceId)).toBeDefined();
    expect(h.db.prepare("SELECT state FROM cloud_recovery WHERE id=?").get("pair-hold-0123456789abcdef")).toEqual({ state: "device_added" });
  });
  it("r4.2 (b): an active desktop and no hold claim is hold_required", async () => {
    const h = await home(); await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), { kind: "desktop" }).body);
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), { kind: "desktop" }).body);
    expect(r.status).toBe(403); expect(r.body.reason).toBe("hold_required"); expect(rows(h)).toBe(1);
  });
  it("r4.2 (c): the same hold twice is pair_hold_refused and the second device is not added", async () => {
    const h = await home(); await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), { kind: "desktop" }).body);
    const claim = { kind: "desktop", pairHold: "hold-0123456789abcdef" };
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), claim).body)).status).toBe(200);
    const again = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), claim).body);
    expect(again.status).toBe(403); expect(again.body.reason).toBe("hold_required"); expect(rows(h)).toBe(2);
  });
  it("r4.2 (d): a home whose only desktop is revoked needs a hold claim too", async () => {
    const h = await home(); const first = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), { kind: "desktop" }).body);
    h.sessions.revoke(first.body.deviceId);
    const none = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), { kind: "desktop" }).body);
    expect(none.status).toBe(403); expect(none.body.reason).toBe("hold_required");
    const held = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice("ed25519"), { kind: "desktop", pairHold: "hold-abcdefghijklmnop" }).body);
    expect(held.status).toBe(200); expect(rows(h)).toBe(2);
    // The nonce of a refused hold is not spent, and a refused enter rolls back the hold too.
    const probe = enter(h.now(), mkDevice("ed25519"), { kind: "desktop" });
    await h.call("POST", "/api/cloud/enter", probe.body);
    expect(h.db.prepare("SELECT 1 FROM cloud_door_nonces WHERE nonce=?").get(JSON.parse(Buffer.from(probe.t.split(".")[0]!, "base64url").toString()).nonce)).toBeUndefined();
  });
  it("a known desktop signs in again without a hold", async () => {
    const h = await home(); const dev = mkDevice("ed25519");
    await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { kind: "desktop" }).body);
    const again = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { kind: "desktop" }).body);
    expect(again.status).toBe(200); expect(again.body.reason).toBe("known-device"); expect(rows(h)).toBe(1);
  });
  it("needs an exact Origin on both POST routes", async () => {
    const h = await home();
    for (const path of ["/api/cloud/enter", "/api/cloud/enter/report"]) {
      const r = await h.call("POST", path, { ticket: ticket(h.now()) }, { origin: "" });
      expect(r.status).toBe(403); expect(r.body.error).toBe(cloudHomeCopy.requestOriginRefused);
    }
    expect((await h.call("POST", "/api/cloud/enter/pair", {}, { origin: "" })).status).toBe(403);
  });
  it("the old pair route and door cookie are gone: nothing authenticates from them", async () => {
    const h = await home();
    expect((await h.call("POST", "/api/cloud/enter/pair", {})).status).toBe(403);
    for (const path of ["/api/health", "/api/bots", "/api/config"]) expect((await h.call("GET", path, undefined, { cookie: "__Host-murage-door=abc" })).status).toBe(path === "/api/health" ? 200 : 403);
  });
  it("door-state answers only hasDevices", async () => {
    const h = await home();
    const empty = await h.call("GET", "/api/cloud/door-state");
    expect(empty.status).toBe(200); expect(empty.body).toEqual({ hasDevices: false });
    await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body);
    const full = await h.call("GET", "/api/cloud/door-state");
    expect(full.body).toEqual({ hasDevices: true }); expect(Object.keys(full.body)).toEqual(["hasDevices"]); expect(full.cookies).toEqual([]);
  });
  it("locks out a source after 5 failures (Caddy's X-Forwarded-For on the Unix socket) and not another; TCP ignores the header", async () => {
    const h = await home({ unix: true }); const bad = (ip: string) => h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, { "x-forwarded-for": ip });
    for (let i = 0; i < 5; i++) expect((await bad("203.0.113.7")).status).toBe(403);
    expect((await bad("203.0.113.7")).status).toBe(429);
    expect((await bad("203.0.113.8")).status).toBe(403);
    const tcp = await home();
    for (let i = 0; i < 5; i++) await tcp.call("POST", "/api/cloud/enter", { ticket: "a.b" }, { "x-forwarded-for": `198.51.100.${i}` });
    expect((await tcp.call("POST", "/api/cloud/enter", { ticket: "a.b" }, { "x-forwarded-for": "198.51.100.99" })).status).toBe(429);
  });
  it("every device-level refusal counts toward the source lockout", async () => {
    const h = await home({ unix: true }); const dev = mkDevice();
    for (let i = 0; i < 5; i++) expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { bind: "b".repeat(64) }).body, xff(9))).status).toBe(403);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { bind: "b".repeat(64) }).body, xff(9))).status).toBe(429);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body, xff(10))).status).toBe(200);
  });
  /** A ticket with a valid shape whose signature belongs to another ticket: it reaches the verifier and fails there. */
  const forged = (now: number, dev: Dev) => { const e = enter(now, dev); const other = ticket(now); const t = `${e.t.split(".")[0]}.${other.split(".")[1]}`; return { ...e.body, ticket: t }; };
  it("five bad attempts from one source, then the owner's valid ticket from that source still enters", async () => {
    const h = await home({ unix: true }); const owner = mkDevice();
    for (let i = 0; i < 5; i++) expect((await h.call("POST", "/api/cloud/enter", forged(h.now(), mkDevice()), xff(9))).status).toBe(403);
    expect((await h.call("POST", "/api/cloud/enter", forged(h.now(), mkDevice()), xff(9))).status).toBe(429);
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), owner).body, xff(9));
    expect(r.status).toBe(200); expect(r.body.state).toBe("signed-in"); expect(cookieOf(r)).toBeTruthy(); expect(rows(h)).toBe(1);
    // The lock is still there for everything that does not verify, and for the other door routes.
    expect((await h.call("POST", "/api/cloud/enter", forged(h.now(), mkDevice()), xff(9))).status).toBe(429);
    expect((await h.call("GET", "/api/cloud/door-state", undefined, xff(9))).status).toBe(429);
  });
  it("bad tickets from a locked source stay locked, all with one answer, and none reveals whether its ticket was valid", async () => {
    const h = await home({ unix: true }); const dev = mkDevice();
    for (let i = 0; i < 5; i++) await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(9));
    const spent = enter(h.now(), dev); expect((await h.call("POST", "/api/cloud/enter", spent.body, xff(10))).status).toBe(200);
    const answers = await Promise.all([
      { ticket: "a.b" },                                                              // malformed
      forged(h.now(), mkDevice()),                                                    // bad signature
      enter(h.now(), mkDevice(), { bind: "b".repeat(64) }).body,                      // valid signature, wrong key
      enter(h.now(), mkDevice(), { homeId: "home-2" }).body,                          // valid signature, wrong home
      enter(h.now(), mkDevice(), { generation: generation + 1 }).body,                // valid signature, wrong generation
      enter(h.now(), mkDevice(), { expiresAt: h.now() - 1, issuedAt: h.now() - 2000, stepUpAt: h.now() - 3000 }).body, // expired
      spent.body,                                                                     // a nonce already spent
      enter(h.now(), mkDevice(), {}, { proofKey: ec() }).body,                        // wrong proof
    ].map(b => h.call("POST", "/api/cloud/enter", b, xff(9))));
    for (const a of answers) { expect(a.status).toBe(429); expect(a.body).toEqual(answers[0]!.body); expect(a.cookies).toEqual([]); }
    expect(rows(h)).toBe(1);
    const lock = h.db.prepare("SELECT failures FROM cloud_source_limits WHERE source=?").get("door:v4:192.0.2.9") as { failures: number };
    expect(lock.failures).toBe(5 + answers.length);
    // Locked failures never spend the home-wide failure budget other sources rely on.
    expect((await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(40))).status).toBe(403);
  });
  it("a flood from locked sources is held to the home-wide cap on verifications, and the cap reopens", async () => {
    const h = await home({ unix: true });
    for (const ip of [9, 11]) for (let i = 0; i < 5; i++) await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(ip));
    const before = h.verifies();
    for (let i = 0; i < 400; i += 20) await Promise.all(Array.from({ length: 20 }, (_, j) => h.call("POST", "/api/cloud/enter", forged(h.now(), mkDevice()), xff((i + j) % 2 ? 9 : 11))));
    expect(h.verifies() - before).toBe(300);
    // While the cap is spent a locked source is refused before anything is verified, even with a valid ticket; an unlocked source is not.
    const held = h.verifies();
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body, xff(9))).status).toBe(429);
    expect(h.verifies()).toBe(held);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body, xff(60))).status).toBe(200);
    h.tick(61_000);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body, xff(9))).status).toBe(200);
  });
  it("unauthenticated door-state floods never lock the owner out of /enter", async () => {
    const h = await home({ unix: true });
    for (let i = 0; i < 40; i++) expect((await h.call("GET", "/api/cloud/door-state", undefined, xff(i + 1))).status).toBe(200);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body, xff(250))).status).toBe(200);
  });
  it("door-state has its own per-source limit that never touches the enrollment budget", async () => {
    const h = await home({ unix: true }); let last = 0;
    for (let i = 0; i < 61; i++) last = (await h.call("GET", "/api/cloud/door-state", undefined, xff(7))).status;
    expect(last).toBe(429);
    expect((await h.call("GET", "/api/cloud/door-state", undefined, xff(8))).status).toBe(200);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body, xff(7))).status).toBe(200);
    h.tick(61_000);
    expect((await h.call("GET", "/api/cloud/door-state", undefined, xff(7))).status).toBe(200);
  });
  it("a flood of invalid tickets from many sources still caps the home, but a verified ticket passes", async () => {
    const h = await home({ unix: true });
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(i + 1))).status;
    expect(last).toBe(429);
    expect((await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(200))).status).toBe(429);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body, xff(202))).status).toBe(200);
    h.tick(61_000);
    expect((await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(204))).status).toBe(403);
  });
  it("a locked source consumes nothing shared", async () => {
    const h = await home({ unix: true });
    for (let i = 0; i < 5; i++) expect((await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(9))).status).toBe(403);
    for (let i = 0; i < 100; i++) expect((await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(9))).status).toBe(429);
    for (let i = 0; i < 100; i++) expect((await h.call("GET", "/api/cloud/door-state", undefined, xff(9))).status).toBe(429);
    for (let i = 0; i < 20; i++) expect((await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(20 + i))).status).toBe(403);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body, xff(100))).status).toBe(200);
  });
});

describe("a ticket browser is chat-level", () => {
  it("is not an owner browser, reaches only conversation routes and can never answer a factor assertion", async () => {
    const h = await home(); const dev = mkDevice();
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body);
    const d = h.sessions.device(r.body.deviceId)!;
    expect(d.scope).toBe("browser"); expect(d.factor).toBe(false); expect(isOwnerBrowser(d)).toBe(false);
    expect(cloudRouteDecision("GET", "/api/decisions", "browser", {})).toBe("deny");
    expect(cloudRouteDecision("POST", "/api/bots/b1/messages", "browser", { text: "hi" })).toBe("allow");
    expect((await h.call("GET", "/api/decisions", undefined, sessionCookie(r))).status).toBe(403);
    const purpose = "step:POST:/api/provider-connections:x", challenge = h.sessions.challenge(d.id, purpose), at = h.now() - 1;
    const sig = signWith(dev.assertion, `murage:${h.sessions.environmentId}:${d.id}:${purpose}:${challenge}:${at}`);
    expect(h.sessions.consumeAssertion(d.id, challenge, purpose, at, sig)).toBe(false);
  });
  it("mint() and redeem() refuse browser scope; desktop pairing is unchanged", async () => {
    const h = await home(); const dev = mkDevice();
    expect(() => h.sessions.mint({ account: "owner", scope: "browser", publicKey: pem(dev.key), assertionKey: pem(dev.assertion) })).toThrow();
    const code = "stored-browser-code";
    h.db.prepare("INSERT INTO cloud_codes VALUES (?,?,?)").run(createHash("sha256").update(code).digest("hex"), JSON.stringify({ account: "owner", scope: "browser", publicKey: pem(dev.key), assertionKey: pem(dev.assertion) }), h.now() + 60_000);
    h.db.prepare("INSERT INTO cloud_meta VALUES ('account','owner')").run();
    expect(() => h.sessions.redeem(code, "owner", signWith(dev.key, `murage-pair:${h.sessions.environmentId}:${code}:owner`), signWith(dev.assertion, `murage-pair:${h.sessions.environmentId}:${code}:owner`))).toThrow();
    expect(rows(h)).toBe(0);
    const desk = mkDevice("ed25519"), c2 = h.sessions.mint({ account: "owner", scope: "owner-desktop", publicKey: pem(desk.key), assertionKey: pem(desk.assertion) });
    const msg = `murage-pair:${h.sessions.environmentId}:${c2}:owner`;
    expect(h.sessions.redeem(c2, "owner", signWith(desk.key, msg), signWith(desk.assertion, msg)).scope).toBe("owner-desktop");
  });
  it("adds addedAt and lastSeenAt to an older database without losing its devices", () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    db.exec("CREATE TABLE cloud_devices (id TEXT PRIMARY KEY, account TEXT NOT NULL, scope TEXT NOT NULL, publicKey TEXT NOT NULL, assertionKey TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)");
    db.prepare("INSERT INTO cloud_devices VALUES ('old','owner','browser','k','k',0)").run();
    db.exec("CREATE TABLE cloud_door (hash TEXT PRIMARY KEY, account TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL); INSERT INTO cloud_door VALUES ('h','owner','c',9999999999999)");
    new CloudSessions(db, () => 1, origin); new CloudSessions(db, () => 1, origin); // twice: the ALTER is guarded
    expect(db.prepare("SELECT addedAt,lastSeenAt FROM cloud_devices WHERE id='old'").get()).toEqual({ addedAt: 0, lastSeenAt: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM cloud_door").get()).toEqual({ n: 0 });
  });
});

describe("device management", () => {
  it("lists and revokes by the control plane's signed call, once per nonce, and only for the named operation", async () => {
    const h = await home(); const dev = mkDevice();
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body);
    const listed = await management(h, "/api/cloud/devices/list");
    expect(listed.status).toBe(200);
    expect(listed.body.devices).toEqual([{ id: r.body.deviceId, scope: "browser", addedAt: h.now(), lastSeenAt: h.now(), keyHash: bindOf(dev.key), bind: bindOf(dev.key), factor: null }]);
    const reused = nonce();
    expect((await management(h, "/api/cloud/devices/list", {}, { nonce: reused })).status).toBe(200);
    expect((await management(h, "/api/cloud/devices/list", {}, { nonce: reused })).status).toBe(403);
    expect((await management(h, "/api/cloud/devices/revoke", { deviceId: r.body.deviceId }, { operation: "/api/cloud/devices/list" })).status).toBe(403);
    expect(h.sessions.device(r.body.deviceId)).toBeDefined();
    const revoked = await management(h, "/api/cloud/devices/revoke", { deviceId: r.body.deviceId });
    expect(revoked.status).toBe(200); expect(revoked.body).toEqual({ revoked: true });
    expect(h.sessions.device(r.body.deviceId)).toBeUndefined();
    expect((await management(h, "/api/cloud/devices/list")).body.devices).toEqual([]);
    expect((await h.call("POST", "/api/cloud/devices/list", {}, {})).status).toBe(403); // no signature
  });
  it("devices/list gives each active device a bind equal to the ticket bind of its key: 64 lowercase hex, and none once revoked", async () => {
    const h = await home(); const dev = mkDevice(); const other = mkDevice();
    const a = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body);
    const b = await h.call("POST", "/api/cloud/enter", enter(h.now(), other).body);
    const rows = (await management(h, "/api/cloud/devices/list")).body.devices as { id: string; bind?: string }[];
    const mine = rows.find(d => d.id === a.body.deviceId)!;
    expect(mine.bind).toBe(bindOf(dev.key)); expect(mine.bind).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.find(d => d.id === b.body.deviceId)!.bind).toBe(bindOf(other.key));
    await management(h, "/api/cloud/devices/revoke", { deviceId: a.body.deviceId });
    const after = (await management(h, "/api/cloud/devices/list")).body.devices as { id: string; bind?: string }[];
    expect(after.find(d => d.id === a.body.deviceId)).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain(bindOf(dev.key));
  });
  it("devices/list says whether a full-scope device ever enrolled (revoked included), and revoke of an unknown id is 404", async () => {
    const h = await home();
    expect((await management(h, "/api/cloud/devices/list")).body.fullScopeEver).toBe(false);
    await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body);
    expect((await management(h, "/api/cloud/devices/list")).body.fullScopeEver).toBe(false); // browsers never count
    h.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES ('0ff1ce-de5c','owner','owner-desktop','k','k',1,1,1)").run();
    const listed = await management(h, "/api/cloud/devices/list");
    expect(listed.body.fullScopeEver).toBe(true);
    expect(listed.body.devices.map((d: { id: string }) => d.id)).not.toContain("0ff1ce-de5c");
    expect((await management(h, "/api/cloud/devices/revoke", { deviceId: "0000-abcd" })).status).toBe(404);
    expect((await management(h, "/api/cloud/devices/revoke", { deviceId: "0ff1ce-de5c" })).status).toBe(200);
  });
  it("devices/list carries the spent pair holds, most recent first, at most 50", async () => {
    const h = await home();
    expect((await management(h, "/api/cloud/devices/list")).body.consumedHoldIds).toEqual([]);
    await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body); // sets the owner
    for (let i = 0; i < 52; i++) { expect(h.sessions.consumePairHold(`hold-${String(i).padStart(16, "0")}`, "owner")).toBe(true); h.tick(1000); }
    expect(h.sessions.consumePairHold(`hold-${"0".repeat(16)}`, "owner")).toBe(false); // spent once, ever
    const ids = (await management(h, "/api/cloud/devices/list")).body.consumedHoldIds as string[];
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe(`hold-${String(51).padStart(16, "0")}`);
    expect(ids[49]).toBe(`hold-${String(2).padStart(16, "0")}`);
  });
  it("a paired device lists the home's devices with itself marked, 30 a minute, and anonymous callers get nothing", async () => {
    const h = await home(); const a = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body);
    const b = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body);
    const mine = await h.call("GET", "/api/cloud/devices", undefined, sessionCookie(a));
    expect(mine.status).toBe(200); expect(mine.body.self).toBe(a.body.deviceId);
    expect(mine.body.devices.map((d: any) => d.id).sort()).toEqual([a.body.deviceId, b.body.deviceId].sort());
    expect([401, 403]).toContain((await h.call("GET", "/api/cloud/devices")).status);
    expect([401, 403]).toContain((await h.call("POST", "/api/cloud/devices/forget", {})).status);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await h.call("GET", "/api/cloud/devices", undefined, sessionCookie(b))).status;
    expect(last).toBe(429);
    expect((await h.call("GET", "/api/cloud/devices", undefined, sessionCookie(a))).status).toBe(200);
  });
  it("forget revokes the caller, clears the cookie and no step-up is needed", async () => {
    const h = await home(); const a = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body);
    const b = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body);
    const gone = await h.call("POST", "/api/cloud/devices/forget", {}, sessionCookie(a));
    expect(gone.status).toBe(200); expect(gone.body).toEqual({ forgotten: true });
    expect(cookieOf(gone)).toBe("__Host-murage=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0");
    expect(h.sessions.device(a.body.deviceId)).toBeUndefined(); expect(h.sessions.device(b.body.deviceId)).toBeDefined();
    expect([401, 403]).toContain((await h.call("GET", "/api/cloud/devices", undefined, sessionCookie(a))).status);
  });
});

describe("devices/list stays fast and answers while another writer holds the database", () => {
  it("walks indexes only, with thousands of revoked devices and spent holds", async () => {
    const h = await home();
    await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()).body); // sets the owner
    const insertDevice = h.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,1,?,?)");
    const insertHold = h.db.prepare("INSERT INTO cloud_recovery VALUES (?,?,?,?)");
    h.db.exec("BEGIN");
    for (let i = 0; i < 5000; i++) {
      insertDevice.run(`old-${i}`, "owner", i % 2 ? "owner-desktop" : "browser", "k", "k", i, i);
      insertHold.run(`pair-hold-${String(i).padStart(16, "0")}`, "owner", i, "device_added");
    }
    h.db.exec("COMMIT");
    const plan = (sql: string, ...args: unknown[]) => (h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as [])) as { detail: string }[]).map(r => r.detail);
    for (const steps of [
      plan("SELECT 1 FROM cloud_devices WHERE scope IN ('owner-desktop','owner-phone') LIMIT 1"),
      plan("SELECT id,scope,publicKey,addedAt,lastSeenAt FROM cloud_devices WHERE revoked=0 AND account=? AND scope!='service' ORDER BY addedAt,id", "owner"),
      plan("SELECT substr(id,6) AS hold FROM cloud_recovery WHERE id LIKE 'pair-%' AND state='device_added' ORDER BY started DESC, rowid DESC LIMIT 50"),
    ]) {
      expect(steps.some(d => /USING (?:COVERING )?INDEX/.test(d))).toBe(true);
      expect(steps.filter(d => /^SCAN cloud_(?:devices|recovery)$/.test(d))).toEqual([]);
    }
    const started = Date.now();
    const listed = await management(h, "/api/cloud/devices/list");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(listed.status).toBe(200);
    expect(listed.body.devices).toHaveLength(1);
    expect(listed.body.fullScopeEver).toBe(true);
    expect(listed.body.consumedHoldIds).toHaveLength(50);
    expect(listed.body.consumedHoldIds[0]).toBe(`hold-${String(4999).padStart(16, "0")}`);
  });
  it("a busy database is a retryable 503 for the signed call, never a refusal, and the reads still answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-")); dirs.push(dir);
    const file = join(dir, "home.db");
    const a = new DatabaseSync(file), b = new DatabaseSync(file); dbs.push(a, b);
    a.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;"); b.exec("PRAGMA busy_timeout=0;");
    const sessions = new CloudSessions(a, () => 1_800_000_000_000, origin);
    const secret = "x".repeat(32);
    const body = (n: string) => Buffer.from(JSON.stringify({ operation: "/api/cloud/devices/list", timestamp: 1_800_000_000, nonce: n }));
    const sig = (raw: Buffer) => createHmac("sha256", secret).update(raw).digest("hex");
    b.exec("BEGIN IMMEDIATE"); b.prepare("INSERT INTO cloud_meta VALUES ('held','1')").run();
    const raw = body(nonce());
    let thrown: unknown;
    try { sessions.verifyBootstrap(raw, sig(raw), secret); } catch (error) { thrown = error; }
    expect((thrown as { status?: number }).status).toBe(503);
    expect(sessions.listDevices()).toEqual([]); expect(sessions.fullScopeEver()).toBe(false); expect(sessions.consumedHoldIds()).toEqual([]);
    b.exec("COMMIT");
    expect(sessions.verifyBootstrap(raw, sig(raw), secret).operation).toBe("/api/cloud/devices/list"); // the same call, retried
    expect(() => sessions.verifyBootstrap(raw, sig(raw), secret)).toThrow("Pairing authorization refused"); // a replay is still refused
  });
});

describe("the remembered-owner factor", () => {
  const factorRow = (h: { db: DatabaseSync }, id: string) =>
    h.db.prepare("SELECT kind, expiresAt, revokedAt FROM cloud_browser_factors WHERE device=?").get(id) as { kind: string; expiresAt: number | null; revokedAt: number | null } | undefined;
  it("the assertion proof: required for a browser, verified when present, matched to the device on file", async () => {
    const h = await home(); const dev = mkDevice();
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, {}, { omitAssertionProof: true }).body)).status).toBe(403); // body_malformed
    expect(rows(h)).toBe(0);
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, {}, { assertionProofKey: ec() }).body)).status).toBe(403); // assertion_proof_refused
    expect(rows(h)).toBe(0);
    await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body); // on file now
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), { key: dev.key, assertion: ec() }).body); // known key, different assertion key
    expect(r.status).toBe(403); // device_key_invalid
    // a desktop ticket enters without an assertion proof (R7)
    expect((await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice(), { kind: "desktop" }, { omitAssertionProof: true }).body)).status).toBe(200);
  });
  it("a browser proof ticket issues the factor, answers owner:true, opens the reads and sends chat but not writes", async () => {
    const h = await home(); const dev = mkDevice();
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { proof: "email" }).body);
    expect(r.status).toBe(200); expect(r.body.owner).toBe(true); expect(typeof r.body.ownerUntil).toBe("number");
    const d = h.sessions.device(r.body.deviceId)!;
    expect(d.factor).toBe("remembered-owner"); expect(isOwnerBrowser(d)).toBe(true);
    const cookie = sessionCookie(r);
    expect((await h.call("GET", "/api/decisions", undefined, cookie)).status).toBe(200);
    expect((await h.call("POST", "/api/bots/b1/messages", { text: "hi" }, cookie)).status).toBe(200);
    expect((await h.call("PUT", "/api/bots/b1/general-notes", { text: "x" }, cookie)).status).toBe(403);
    // proof:"factor" issues the same way (R3)
    const f = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice(), { proof: "factor" }).body);
    expect(h.sessions.device(f.body.deviceId)!.factor).toBe("remembered-owner");
  });
  it("an unknown proof value is a malformed ticket, and a desktop proof ticket writes no factor", async () => {
    const now = 1_800_000_000_000;
    expect(outcomeOf(() => verify(ticket(now, { proof: "x" }), now))).toBe("ticket_malformed");
    const h = await home(); const desk = mkDevice();
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), desk, { kind: "desktop", proof: "email" }).body);
    expect(r.status).toBe(200); expect(r.body.owner).toBe(false);
    expect(h.sessions.device(r.body.deviceId)!.factor).toBe(false);
    expect(factorRow(h, r.body.deviceId)).toBeUndefined();
  });
  it("a bare ticket writes no factor (B1), and a known device renews only with a proof ticket, never a bare one; a passkey row is never replaced", async () => {
    const h = await home(); const dev = mkDevice();
    const bare = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body);
    expect(h.sessions.device(bare.body.deviceId)!.factor).toBe(false);
    const first = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { proof: "email" }).body); // same key, now with proof
    const firstExpiry = factorRow(h, first.body.deviceId)!.expiresAt!;
    h.tick(60_000);
    await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { proof: "email" }).body); // renew
    expect(factorRow(h, first.body.deviceId)!.expiresAt!).toBeGreaterThan(firstExpiry);
    h.tick(60_000);
    const renewed = factorRow(h, first.body.deviceId)!.expiresAt!;
    await h.call("POST", "/api/cloud/enter", enter(h.now(), dev).body); // a BARE ticket does not renew
    expect(factorRow(h, first.body.deviceId)!.expiresAt!).toBe(renewed);
    // a passkey row is never replaced by a remembered-owner issuance
    h.db.prepare("UPDATE cloud_browser_factors SET kind='passkey', expiresAt=NULL WHERE device=?").run(first.body.deviceId);
    await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { proof: "email" }).body);
    expect(factorRow(h, first.body.deviceId)!.kind).toBe("passkey");
  });
  it("after a revoke, only an emailed stepUpAt strictly after the mark re-issues, even for a never-seen key (R10)", async () => {
    const h = await home();
    const a = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice(), { proof: "email" }).body);
    const t1 = h.now();
    h.sessions.revoke(a.body.deviceId); // writes '*' at t1
    expect(h.sessions.watermarkFor("*")).toBe(t1);
    h.tick(20_000);
    const stale = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice(), { proof: "email", stepUpAt: t1 + 1_000 }).body);
    expect(h.sessions.device(stale.body.deviceId)!.factor).toBe(false); // not strictly after the mark + skew
    const fresh = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice(), { proof: "email", stepUpAt: t1 + 6_000 }).body);
    expect(h.sessions.device(fresh.body.deviceId)!.factor).toBe("remembered-owner");
    const factorProof = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice(), { proof: "factor", stepUpAt: t1 + 6_000 }).body);
    expect(h.sessions.device(factorProof.body.deviceId)!.factor).toBe(false); // email-only after a revoke
  });
  it("revokeOwnerFactor writes '*' and never clears a revoked row's revokedAt", async () => {
    const h = await home();
    const a = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice(), { proof: "email" }).body);
    h.sessions.revokeOwnerFactor(a.body.deviceId);
    expect(h.sessions.watermarkFor("*")).toBe(h.now());
    expect(h.sessions.device(a.body.deviceId)!.factor).toBe(false);
    const revokedAt = factorRow(h, a.body.deviceId)!.revokedAt;
    expect(typeof revokedAt).toBe("number");
    h.sessions.revokeOwnerFactor(a.body.deviceId); // a second watermark write never clears the old row
    expect(factorRow(h, a.body.deviceId)!.revokedAt).toBe(revokedAt);
  });
  it("Medium-2: a crash between revoked=1 and the watermark rolls back both", async () => {
    const h = await home();
    const r = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice(), { proof: "email" }).body);
    const id = r.body.deviceId;
    const real = h.db.prepare.bind(h.db);
    const breakWatermark = () => { (h.db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => { if (sql.includes("cloud_owner_watermarks")) throw new Error("boom"); return real(sql); }; };
    const restore = () => { (h.db as unknown as { prepare: unknown }).prepare = real; };
    breakWatermark();
    expect(() => h.sessions.revoke(id)).toThrow();
    restore();
    expect(h.sessions.device(id)).toBeDefined();        // the device is NOT revoked
    expect(h.sessions.watermarkFor("*")).toBe(0);       // the mark is unchanged
    breakWatermark();
    expect(() => h.sessions.revokeOwnerFactor(id)).toThrow();
    restore();
    expect(h.sessions.device(id)!.factor).toBe("remembered-owner"); // the factor is NOT revoked
  });
  it("transaction invariant: a replayed proof ticket adds no second device, factor or nonce; a revoke between enters withholds", async () => {
    const h = await home(); const dev = mkDevice();
    const e = enter(h.now(), dev, { proof: "email" });
    expect((await h.call("POST", "/api/cloud/enter", e.body)).status).toBe(200);
    const d1 = rows(h), n1 = nonces(h);
    expect((await h.call("POST", "/api/cloud/enter", e.body)).status).toBe(403); // ticket_reused
    expect(rows(h)).toBe(d1); expect(nonces(h)).toBe(n1);
    const r1 = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { proof: "email" }).body);
    h.sessions.revoke(r1.body.deviceId); // revokes the device and writes '*'
    const r2 = await h.call("POST", "/api/cloud/enter", enter(h.now(), dev, { proof: "email" }).body); // same key, new device, pre-revoke stepUpAt
    expect(r2.status).toBe(200);
    expect(h.sessions.device(r2.body.deviceId)!.factor).toBe(false);
  });
});
