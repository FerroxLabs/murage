// SPDX-License-Identifier: AGPL-3.0-or-later
// Every Cloud door outcome is one fixed, allow-listed log line with no secret in it (server/cloud-home/door-log.ts).
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { createCloudRequestAuth, type CloudAuthOptions } from "../cloud-request-auth.ts";
import { verifiedDoorTicket } from "./b1b-identity.ts";
import { listenCloudProxy } from "./proxy-socket.ts";
import { DOOR_BROWSERS, DOOR_LOG_EVENTS, DOOR_OPEN_CAUSES, DOOR_OUTCOMES, DOOR_PAGE_ERRORS, DOOR_PAGE_STAGES, DOOR_ROUTES, doorPageReport, doorRefusal, type DoorOutcome } from "./door-log.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const origin = "https://h-abc.example", host = "h-abc.example", homeId = "home-1", generation = 3;
const cp = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), cpJwk = cp.publicKey.export({ format: "jwk" });
type Pair = { publicKey: KeyObject; privateKey: KeyObject };
const ec = (): Pair => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ed = (): Pair => generateKeyPairSync("ed25519");
const pem = (key: Pair) => key.publicKey.export({ format: "pem", type: "spki" }).toString();
const bindOf = (key: Pair) => createHash("sha256").update(key.publicKey.export({ format: "der", type: "spki" })).digest("hex");
const signWith = (key: Pair, message: string) => (key.privateKey.asymmetricKeyType === "ed25519" ? sign(null, Buffer.from(message), key.privateKey) : sign("sha256", Buffer.from(message), { key: key.privateKey, dsaEncoding: "ieee-p1363" })).toString("base64url");
/** Every secret-bearing value a test sends: no logged line may contain any of them. */
const sent = new Set<string>();
function ticket(now: number, over: Record<string, unknown> = {}, key = cp.privateKey): string {
  const nonce = randomBytes(16).toString("base64url"); sent.add(nonce);
  const claims = { type: "murage-door-v2", homeId, generation, publicOrigin: origin, account: "owner-acct-7f3a", nonce, stepUpAt: now - 1000, issuedAt: now - 500, expiresAt: now + 59_000, bind: "a".repeat(64), kind: "browser", ...over };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const t = `${payload}.${sign("sha256", Buffer.from(payload), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  sent.add(t); sent.add(payload); return t;
}
const mkDevice = (kind: "p256" | "ed25519" = "p256") => ({ key: kind === "p256" ? ec() : ed(), assertion: kind === "p256" ? ec() : ed() });
type Dev = ReturnType<typeof mkDevice>;
/** The body a page posts: a ticket minted for this device's key and a proof by it. */
function enter(now: number, dev: Dev, over: Record<string, unknown> = {}, tamper: { proofKey?: Pair; assertionProofKey?: Pair; omitAssertionProof?: boolean } = {}) {
  const t = ticket(now, { bind: bindOf(dev.key), ...over });
  const proof = signWith(tamper.proofKey ?? dev.key, `murage-door-v2:${t}`);
  const assertionProof = signWith(tamper.assertionProofKey ?? dev.assertion, `murage-door-v2-assertion:${t}`);
  for (const v of [pem(dev.key), pem(dev.assertion), proof, assertionProof, bindOf(dev.key)]) sent.add(v);
  const device: Record<string, unknown> = { deviceId: null, publicKey: pem(dev.key), assertionKey: pem(dev.assertion), proof };
  if (!tamper.omitAssertionProof) device.assertionProof = assertionProof;
  return { ticket: t, device };
}

type Res = { status: number; body: any; cookies: string[] };
let servers: Server[] = [], dbs: DatabaseSync[] = [], dirs: string[] = [];
let lines: { level: "info" | "warn" | "error"; text: string }[] = [];
beforeEach(() => {
  lines = [];
  for (const level of ["info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push({ level, text: args.map(String).join(" ") }); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers) { s.closeAllConnections?.(); await new Promise<void>(r => s.close(() => r())); }
  for (const d of dbs) d.close(); for (const d of dirs) removeTempDirSync(d);
  servers = []; dbs = []; dirs = [];
});
async function home(opts: { unix?: boolean; doorTicket?: CloudAuthOptions["doorTicket"] | null } = {}) {
  let t = 1_800_000_000_000;
  const clock = () => t;
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  const sessions = new CloudSessions(db, clock, origin);
  const proxy = opts.unix ? join(mkdtempSync(join(tmpdir(), "dl-")), "p.sock") : undefined;
  if (proxy) dirs.push(join(proxy, ".."));
  const doorTicket = opts.doorTicket === null ? undefined : opts.doorTicket ?? (tk => verifiedDoorTicket(tk, cpJwk, homeId, generation, origin, clock()));
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, trustedProxy: proxy ? `unix:${proxy}` : undefined, bootstrapSecret: () => "x".repeat(32), doorTicket });
  const server = createServer(async (req, res) => { if (await auth(req, res, new URL(req.url!, origin))) return; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  if (proxy) { process.env.MURAGE_CLOUD_ROLE = "home"; const unix = listenCloudProxy(server, proxy)!; await once(unix, "listening"); delete process.env.MURAGE_CLOUD_ROLE; servers.push(unix); }
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<Res>((resolve, reject) => {
    const raw = body === undefined ? undefined : typeof body === "string" ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    const h: Record<string, string> = { host, ...(method === "POST" ? { origin } : {}), ...(raw ? { "content-type": "application/json", "content-length": String(raw.length) } : {}), ...headers };
    const target = proxy ? { socketPath: proxy } : { host: "127.0.0.1", port: (server.address() as AddressInfo).port };
    const req = request({ ...target, path, method, headers: proxy ? { ...h, "x-forwarded-host": host } : h }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
      res.on("end", () => {
        let b: any = {}; try { b = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* empty */ }
        const cookies = res.headers["set-cookie"] ?? []; for (const c of cookies) sent.add(c.split(";")[0]!.split("=")[1] ?? "");
        for (const v of [b.challenge, b.deviceId, b.environmentId, b.account]) if (typeof v === "string" && v) sent.add(v);
        resolve({ status: res.statusCode!, body: b, cookies });
      });
    });
    req.on("error", reject); req.end(raw);
  });
  return { sessions, db, call, tick: (ms: number) => { t += ms; }, now: clock };
}
const xff = (n: number) => ({ "x-forwarded-for": `192.0.2.${n}` });
const doorLines = () => lines.filter(l => l.text.startsWith("Cloud door "));
const last = () => doorLines().at(-1)?.text;
const allowed = DOOR_LOG_EVENTS.map(p => new RegExp(`^(?:${p})$`));
const seen = new Set<string>();
/** Asserts the last door line, records the outcome as covered and checks every line so far is allowed and secret-free. */
function expectLine(route: string, outcome: DoorOutcome) {
  expect(last()).toBe(`Cloud door ${route}: ${outcome}`);
  seen.add(outcome);
  for (const { text } of doorLines()) {
    expect(allowed.some(r => r.test(text)), text).toBe(true);
    for (const value of sent) if (value.length >= 6) expect(text.includes(value), `${text} carries a sent value`).toBe(false);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{32}|192\.0\.2\.|127\.0\.0\.1|owner-acct|BEGIN PUBLIC KEY/);
  }
}
/** One request, exactly one door line. */
async function once1<T>(call: () => Promise<T>): Promise<T> { const before = doorLines().length; const r = await call(); expect(doorLines().length - before).toBe(1); return r; }

describe("the door's outcome list", () => {
  it("is one allow-listed pattern per line kind, identical in the shared runner contract, the runner and the control plane", () => {
    const contract = JSON.parse(readFileSync(new URL("../../shared/self-service-contract.json", import.meta.url), "utf8")) as { logEvents: string[] };
    for (const p of DOOR_LOG_EVENTS) expect(contract.logEvents).toContain(p);
    const runner = readFileSync(new URL("../../deploy/cloud-home/murage-commands", import.meta.url), "utf8");
    for (const p of DOOR_LOG_EVENTS) expect(runner).toContain(`r"${p}"`);
    const plane = readFileSync(new URL("../../cloudflare/control-plane/src/self-service.ts", import.meta.url), "utf8");
    for (const p of DOOR_LOG_EVENTS) expect(plane).toContain(p);
  });
  it("has the v2 vocabulary: routes, outcomes and page stages", () => {
    expect([...DOOR_ROUTES]).toEqual(["state", "enter"]);
    for (const gone of ["door_opened", "device_known", "device_revoked", "device_not_browser", "device_not_found", "device_none", "door_cookie_invalid", "home_has_device", "browser_factor_invalid", "passkey_refused", "device_sig_refused", "session_set"]) expect(DOOR_OUTCOMES as readonly string[]).not.toContain(gone);
    for (const added of ["signed_in_first", "signed_in_known", "signed_in_added", "ticket_wrong_type", "device_bind_refused", "device_proof_refused", "device_limit", "desktop_hold_required", "pair_hold_refused", "body_malformed", "origin_refused", "query_token_refused", "bearer_refused", "body_too_large"]) expect(DOOR_OUTCOMES as readonly string[]).toContain(added);
    expect([...DOOR_PAGE_STAGES]).toEqual(["no_ticket", "device_load", "device_save", "device_forget", "refresh", "bounce", "v1_record", "unexpected", "unknown"]);
  });
  it("keeps every word under 24 characters (the runner's opaque-string scrubber rewrites longer ones, and a rewritten line is dropped)", () => {
    for (const word of [...DOOR_ROUTES, ...DOOR_OUTCOMES, ...DOOR_PAGE_STAGES, ...DOOR_PAGE_ERRORS, ...DOOR_OPEN_CAUSES, ...DOOR_BROWSERS]) {
      expect(word.length, word).toBeLessThan(24); expect(word).toMatch(/^[A-Za-z0-9_]+$/);
    }
    expect(new Set(DOOR_OUTCOMES).size).toBe(DOOR_OUTCOMES.length);
  });
  it("matches no line that carries a ticket-shaped token or a 64-hex value", () => {
    const t = ticket(1_800_000_000_000);
    for (const tail of [t, "a".repeat(64), `${"a".repeat(64)} ticket_expired`, "ticket_expired " + t]) for (const route of ["enter", "state"]) expect(allowed.some(r => r.test(`Cloud door ${route}: ${tail}`))).toBe(false);
    expect(allowed.some(r => r.test(`Cloud door page: bounce ${"a".repeat(64)}`))).toBe(false);
  });
  it("maps whatever the page sends to the fixed lists, else unknown", () => {
    expect(doorPageReport({ stage: "bounce", error: "NotAllowedError" })).toEqual({ stage: "bounce", error: "NotAllowedError" });
    expect(doorPageReport({ stage: "v1_record" })).toEqual({ stage: "v1_record", error: "unknown" });
    for (const body of [null, "x", 5, [], {}, { stage: "a".repeat(5000), error: "eyJhbGciOiJFUzI1NiJ9.x.y" }, { stage: "passkey_create", error: "NotAllowedError" }, { stage: "bounce\nCloud door enter: signed_in_first", error: "constructor" },
      { stage: "toString", error: { name: "NotAllowedError" } }].map(b => [b] as const)) expect(doorPageReport(body[0]).stage === "unknown").toBe(true);
  });
});

describe("one line per door outcome", () => {
  it("door-state: answered, rate limited, source locked", async () => {
    const h = await home({ unix: true });
    await h.call("GET", "/api/cloud/door-state", undefined, xff(1)); expectLine("state", "state_answered");
    expect(doorLines()[0]!.level).toBe("info");
    for (let i = 0; i < 60; i++) await h.call("GET", "/api/cloud/door-state", undefined, xff(2));
    expect((await h.call("GET", "/api/cloud/door-state", undefined, xff(2))).status).toBe(429); expectLine("state", "state_rate_limited");
    for (let i = 0; i < 5; i++) await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(3));
    expect((await h.call("GET", "/api/cloud/door-state", undefined, xff(3))).status).toBe(429); expectLine("state", "source_locked");
    expect(doorLines().at(-1)!.level).toBe("warn");
  });
  it("enter: each way a ticket is refused", async () => {
    const h = await home({ unix: true }); const now = h.now(), dev = mkDevice();
    const v1 = ticket(now, { type: "murage-door-v1", bind: undefined, kind: undefined });
    const cases: [unknown, DoorOutcome][] = [
      ["no-dot-here", "ticket_malformed"], [12, "ticket_malformed"],
      [ticket(now, {}, ec().privateKey), "ticket_bad_signature"], ["a.b", "ticket_bad_signature"],
      [v1, "ticket_wrong_type"], [ticket(now, { type: "murage-recovery-v1" }), "ticket_wrong_type"],
      [ticket(now, { extra: 1 }), "ticket_malformed"], [ticket(now, { bind: "short" }), "ticket_malformed"], [ticket(now, { kind: "phone" }), "ticket_malformed"],
      [ticket(now, { homeId: "home-2" }), "ticket_wrong_home"], [ticket(now, { generation: 9 }), "ticket_wrong_home"], [ticket(now, { publicOrigin: "https://h-other.example" }), "ticket_wrong_home"],
      [ticket(now, { expiresAt: now - 1 }), "ticket_expired"],
      [ticket(now, { expiresAt: now + 61_000 }), "ticket_bad_times"], [ticket(now, { issuedAt: now + 10, stepUpAt: now }), "ticket_bad_times"],
      [ticket(now, { stepUpAt: now - 1_000_000 }), "ticket_stale_step_up"],
    ];
    let n = 0;
    for (const [t, outcome] of cases) {
      const body = typeof t === "string" ? { ticket: t, device: enter(now, dev).device } : { ticket: t };
      const r = await once1(() => h.call("POST", "/api/cloud/enter", body, xff(++n))); // each from its own source, so none locks out
      expect(r.status, outcome).toBe(403); expectLine("enter", outcome);
    }
  });
  it("enter: success, reused, account mismatch, suspended, body_malformed", async () => {
    const h = await home(); const dev = mkDevice(), e = enter(h.now(), dev);
    expect((await once1(() => h.call("POST", "/api/cloud/enter", e))).status).toBe(200); expectLine("enter", "signed_in_first");
    expect(doorLines().at(-1)!.level).toBe("info");
    expect((await once1(() => h.call("POST", "/api/cloud/enter", e))).status).toBe(403); expectLine("enter", "ticket_reused");
    expect((await once1(() => h.call("POST", "/api/cloud/enter", enter(h.now(), dev)))).status).toBe(200); expectLine("enter", "signed_in_known");
    expect((await once1(() => h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice())))).status).toBe(200); expectLine("enter", "signed_in_added");
    const noDevice = { ticket: ticket(h.now()) };
    expect((await once1(() => h.call("POST", "/api/cloud/enter", noDevice))).status).toBe(403); expectLine("enter", "body_malformed");
    h.db.prepare("UPDATE cloud_meta SET value='someone-else' WHERE key='account'").run();
    expect((await once1(() => h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice())))).status).toBe(403); expectLine("enter", "account_mismatch");
    h.db.prepare("INSERT INTO cloud_meta VALUES ('suspended','1')").run();
    expect((await once1(() => h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice())))).status).toBe(403); expectLine("enter", "account_suspended");
  });
  it("enter: each way the device is refused", async () => {
    const h = await home({ unix: true }); const now = h.now(), dev = mkDevice(); let n = 0;
    const refused = async (body: unknown, outcome: DoorOutcome) => { expect((await once1(() => h.call("POST", "/api/cloud/enter", body, xff(++n)))).status, outcome).toBe(403); expectLine("enter", outcome); };
    await refused(enter(now, mkDevice("ed25519")), "device_key_invalid");
    await refused(enter(now, dev, { bind: bindOf(ec()) }), "device_bind_refused");
    await refused(enter(now, dev, {}, { proofKey: ec() }), "device_proof_refused");
    await refused(enter(now, dev, {}, { assertionProofKey: ec() }), "assertion_proof_refused");
    // ten browsers, then the eleventh
    const g = await home();
    for (let i = 0; i < 10; i++) expect((await g.call("POST", "/api/cloud/enter", enter(g.now(), mkDevice()))).status).toBe(200);
    expect((await once1(() => g.call("POST", "/api/cloud/enter", enter(g.now(), mkDevice())))).status).toBe(403); expectLine("enter", "device_limit");
    // desktops: a hold is needed once a full-scope device has existed, and a spent hold is refused
    const d = await home();
    expect((await d.call("POST", "/api/cloud/enter", enter(d.now(), mkDevice("ed25519"), { kind: "desktop" }))).status).toBe(200);
    expect((await once1(() => d.call("POST", "/api/cloud/enter", enter(d.now(), mkDevice("ed25519"), { kind: "desktop" })))).status).toBe(403); expectLine("enter", "desktop_hold_required");
    const claim = { kind: "desktop", pairHold: "hold-0123456789abcdef" };
    expect((await d.call("POST", "/api/cloud/enter", enter(d.now(), mkDevice("ed25519"), claim))).status).toBe(200);
    expect((await once1(() => d.call("POST", "/api/cloud/enter", enter(d.now(), mkDevice("ed25519"), claim)))).status).toBe(403); expectLine("enter", "pair_hold_refused");
  });
  it("enter: no verifier, an unbound home, an unexpected fault, the home-wide budget", async () => {
    const none = await home({ doorTicket: null });
    expect((await none.call("POST", "/api/cloud/enter", { ticket: ticket(none.now()) })).status).toBe(403); expectLine("enter", "door_unconfigured");
    const unbound = await home({ doorTicket: () => { throw doorRefusal("home_unbound", "binding unreadable"); } });
    expect((await unbound.call("POST", "/api/cloud/enter", { ticket: ticket(unbound.now()) })).status).toBe(403); expectLine("enter", "home_unbound");
    const broken = await home({ doorTicket: () => { throw new Error("disk on fire"); } });
    expect((await broken.call("POST", "/api/cloud/enter", { ticket: ticket(broken.now()) })).status).toBe(403); expectLine("enter", "internal_error");
    expect(doorLines().at(-1)!.level).toBe("error");
    const h = await home({ unix: true });
    for (let i = 0; i < 30; i++) await h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(i + 1));
    expect((await once1(() => h.call("POST", "/api/cloud/enter", { ticket: "a.b" }, xff(100)))).status).toBe(429); expectLine("enter", "budget_closed");
  });
  it("any other throw on a door path logs internal_error once", async () => {
    const h = await home();
    vi.spyOn(h.sessions, "doorSourceLocked").mockImplementation(() => { throw new Error("disk on fire"); });
    expect((await once1(() => h.call("GET", "/api/cloud/door-state"))).status).toBe(403); expectLine("state", "internal_error");
    expect((await once1(() => h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice())))).status).toBe(403); expectLine("enter", "internal_error");
  });
  it("early exits log once: origin_refused, query_token_refused, bearer_refused, body_too_large, body_malformed", async () => {
    const h = await home();
    expect((await once1(() => h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()), { origin: "https://evil.example" }))).status).toBe(403); expectLine("enter", "origin_refused");
    expect((await once1(() => h.call("GET", "/api/cloud/door-state", undefined, { host: "evil.example" }))).status).toBe(403); expectLine("state", "origin_refused");
    expect((await once1(() => h.call("POST", "/api/cloud/enter/report", { stage: "refresh" }, { origin: "https://evil.example" }))).status).toBe(403); expectLine("enter", "origin_refused");
    expect((await once1(() => h.call("POST", "/api/cloud/enter?token=abc", enter(h.now(), mkDevice())))).status).toBe(400); expectLine("enter", "query_token_refused");
    expect((await once1(() => h.call("GET", "/api/cloud/door-state?access_token=abc"))).status).toBe(400); expectLine("state", "query_token_refused");
    const signedIn = await h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()));
    const token = signedIn.cookies[0]!.split(";")[0]!.split("=")[1]!;
    expect((await once1(() => h.call("GET", "/api/cloud/door-state", undefined, { authorization: `Bearer ${token}` }))).status).toBe(401); expectLine("state", "bearer_refused");
    expect((await once1(() => h.call("POST", "/api/cloud/enter", enter(h.now(), mkDevice()), { authorization: `Bearer ${token}` }))).status).toBe(401); expectLine("enter", "bearer_refused");
    expect((await once1(() => h.call("POST", "/api/cloud/enter", { ticket: "x".repeat(1_100_000) }))).status).toBe(413); expectLine("enter", "body_too_large");
    expect((await once1(() => h.call("POST", "/api/cloud/enter", "{not json"))).status).toBe(403); expectLine("enter", "body_malformed");
    // a request that is not a door route logs no door line
    const before = doorLines().length; await h.call("GET", "/api/health"); await h.call("POST", "/api/cloud/enter/pair", {}); expect(doorLines()).toHaveLength(before);
  });
  it("covers every outcome in the list", () => {
    // Runs after the route tests above (vitest runs a file's tests in order).
    expect(DOOR_OUTCOMES.filter(o => !seen.has(o))).toEqual([]);
  });
});

describe("the door page's reports", () => {
  it("are logged as fixed words, answer nothing and have their own per-source limit", async () => {
    const h = await home({ unix: true });
    const r = await h.call("POST", "/api/cloud/enter/report", { stage: "bounce", error: "NotAllowedError" }, xff(1));
    expect(r.status).toBe(202); expect(r.body).toEqual({}); expect(r.cookies).toEqual([]);
    expect(last()).toBe("Cloud door page: bounce NotAllowedError");
    await h.call("POST", "/api/cloud/enter/report", { stage: "passkey_create", error: "secret-ticket-value.abc", ticket: "t.t", deviceId: "d" }, xff(1));
    expect(last()).toBe("Cloud door page: unknown unknown");
    for (let i = 0; i < 8; i++) await h.call("POST", "/api/cloud/enter/report", { stage: "refresh" }, xff(1));
    const before = doorLines().length;
    expect((await h.call("POST", "/api/cloud/enter/report", { stage: "refresh" }, xff(1))).status).toBe(429);
    expect(doorLines()).toHaveLength(before); // a limited report logs nothing
    expect((await h.call("GET", "/api/cloud/door-state", undefined, xff(1))).status).toBe(200); // and never spends door-state's limit
    for (const { text } of doorLines()) expect(allowed.some(p => p.test(text)), text).toBe(true);
  });
  it("log a key store that did not open as its cause and browser family, from the fixed lists only", async () => {
    expect([...DOOR_OPEN_CAUSES]).toEqual(["timeout", "blocked", "error", "unknown"]);
    expect([...DOOR_BROWSERS]).toEqual(["chrome", "safari", "firefox", "edge", "other", "unknown"]);
    expect(doorPageReport({ stage: "device_open", cause: "blocked", browser: "safari" })).toEqual({ stage: "device_open", cause: "blocked", browser: "safari" });
    expect(doorPageReport({ stage: "device_open", cause: "Mozilla/5.0 (Macintosh)", browser: "Safari/605.1.15", error: "TimeoutError" })).toEqual({ stage: "device_open", cause: "unknown", browser: "unknown" });
    const h = await home({ unix: true });
    for (const [body, line] of [
      [{ stage: "device_open", cause: "timeout", browser: "chrome" }, "Cloud door page: device_open timeout chrome"],
      [{ stage: "device_open", cause: "blocked", browser: "firefox" }, "Cloud door page: device_open blocked firefox"],
      [{ stage: "device_open", cause: "error", browser: "Mozilla/5.0 my-host.local" }, "Cloud door page: device_open error unknown"],
    ] as const) {
      expect((await once1(() => h.call("POST", "/api/cloud/enter/report", body, xff(4)))).status).toBe(202);
      expect(last()).toBe(line); expect(doorLines().at(-1)!.level).toBe("warn");
    }
    for (const { text } of doorLines()) expect(allowed.some(p => p.test(text)), text).toBe(true);
    expect(allowed.some(r => r.test("Cloud door page: device_open blocked Mozilla/5.0"))).toBe(false);
  });
  it("needs the exact Origin and opens nothing else", async () => {
    const h = await home();
    expect((await h.call("POST", "/api/cloud/enter/report", { stage: "refresh" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM cloud_devices").get()).toEqual({ n: 0 });
  });
});
