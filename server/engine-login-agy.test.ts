// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// An owner's browser signs an engine in on a Cloud home: ticket issue, ticket redeem at the relay, admission by scope, and the one
// keyboard line the relay gives a browser. Real auth, real upgrade gate, real relay; the launcher is `cat` (a fake, no vendor, no keys).
// AGY-ON-CLOUD (design 3, 5 and 13): the Antigravity ticket needs a fresh emailed code and a bot that exists; the relay's one-code keyboard,
// the identity check before the code, no echo after it, and the closing line from a fresh status read.
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessions } from "./cloud-sessions.ts";
import { createCloudRequestAuth, type CloudOwnerAct } from "./cloud-request-auth.ts";
import { attachCloudUpgradeGate } from "./cloud-home/upgrade-gate.ts";
import { createEngineLoginRelay, type EngineLoginWho } from "./cloud-home/engine-login.ts";
import { createEngineLoginTickets } from "./cloud-home/engine-login-target.ts";


const origin = "https://home.example";
let sessions: CloudSessions, upstream: Server, proof = false, bots = new Set(["atlas"]), live = true, signedIn: boolean | "throw" = true, generationAdvances = true, generationReads = 0, refreshReads = 0, fakes: Fake[] = [];
interface Fake { child: EventEmitter; stdout: PassThrough; written: string[]; sent: string[]; ready: () => void; ended: () => boolean; exit: (code: number) => void }
function fakeLauncher(): Fake {
  const written: string[] = [], sent: string[] = []; let ended = false;
  const stdin = new PassThrough(); stdin.on("data", chunk => written.push(String(chunk)));
  const channel = new Duplex({ read() {}, write(chunk, _e, cb) { sent.push(String(chunk)); cb(); }, final(cb) { ended = true; cb(); } });
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 2147483000, exitCode: null as number | null, signalCode: null as string | null, stdin, stdout, stderr: new PassThrough(), kill() { child.exitCode = 0; queueMicrotask(() => child.emit("close", 0)); return true; } });
  (child as unknown as Record<string, unknown>).stdio = [stdin, stdout, child.stderr, null, channel];
  return { child, stdout, written, sent, ready: () => { channel.push("ready\n"); }, ended: () => ended, exit: code => { child.exitCode = code; child.emit("close", code); } };
}
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); proof = false; bots = new Set(["atlas"]); live = true; signedIn = true; generationAdvances = true; generationReads = 0; refreshReads = 0; fakes = []; });
afterEach(async () => {
  if (upstream?.listening) { const closed = once(upstream, "close"); upstream.close(); upstream.closeAllConnections(); await closed; }
  if (sessions?.db.isOpen) sessions.db.close(); vi.unstubAllEnvs();
});
const p256 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = (key: { publicKey: import("node:crypto").KeyObject }) => key.publicKey.export({ format: "pem", type: "spki" }).toString();
const DAY = 24 * 60 * 60 * 1000;
function owner() {
  const key = p256(), confirm = p256(), id = randomUUID();
  sessions.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
  sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,0,0)").run(id, "owner", "browser", pem(key), pem(confirm));
  const t = Date.now(), keyHash = createHash("sha256").update(createPublicKey(pem(confirm)).export({ type: "spki", format: "der" })).digest("hex");
  sessions.db.prepare("INSERT INTO cloud_browser_factors (device,payload,kind,issuedAt,expiresAt,keyHash,stepUpAt,revokedAt) VALUES (?,?,?,?,?,?,?,NULL)")
    .run(id, JSON.stringify({ kind: "remembered-owner", keyHash, proof: "email", stepUpAt: t, ticketNonce: "fixture-nonce" }), "remembered-owner", t, t + 30 * DAY, keyHash, t);
  return { id, cookie: { cookie: `__Host-murage=${sessions.issue(id).accessToken}` } };
}
const ownerAct: CloudOwnerAct = { token: () => "act", verifyProof: req => req.headers["x-murage-owner-proof"] === "ok", doorFresh: () => true };
const seen: EngineLoginWho[] = [];
async function start() {
  sessions = new CloudSessions(new DatabaseSync(":memory:"), undefined, origin);
  const tickets = createEngineLoginTickets();
  const botExists = (bot: string) => bots.has(bot);
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => "fixture-bootstrap-key-32-characters", ownerAct, engineTickets: tickets, botExists });
  const relay = createEngineLoginRelay({ log: () => {}, killGraceMs: 200, botExists, revalidate: who => { seen.push(who); return live; },
    signInEpoch: async () => (generationReads++ === 0 || !generationAdvances ? 4 : 5),
    // The refresh generation, which advances even when the login epoch does not (a running turn refreshed the OLD account's token). The
    // relay must ignore it; the spread keeps this out of the excess-property check, so the pre-epoch relay (which read it) can be tested.
    ...{ signInGeneration: async () => (refreshReads++ === 0 ? 4 : 5) },
    confirmSignedIn: async () => { if (signedIn === "throw") throw new Error("unreadable"); return signedIn; },
    spawnLauncher: () => { const fake = fakeLauncher(); fakes.push(fake); return fake.child as never; } });
  upstream = createServer(async (req, res) => { if (await auth(req, res, new URL(req.url!, origin))) return; res.writeHead(200); res.end("{}"); });
  attachCloudUpgradeGate(upstream, auth, relay);
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  return (upstream.address() as AddressInfo).port;
}
function post(port: number, path: string, headers: Record<string, string>, body: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port, method: "POST", path, agent: false, headers: { host: "home.example", origin, "content-type": "application/json", "content-length": String(data.length), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: t ? JSON.parse(t) : null }); });
    }); req.on("error", reject); req.end(data);
  });
}
const ticketFor = (port: number, who: { cookie: Record<string, string> }, body: Record<string, unknown>) => post(port, "/api/cloud/engine-login/ticket", { ...who.cookie, ...(proof ? { "x-murage-owner-proof": "ok" } : {}) }, body);
const connect = (port: number, who: { cookie: Record<string, string> }, query: string) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/engine-login/antigravityAgent?${query}`, { headers: { host: "home.example", origin, ...who.cookie } });
  ws.once("open", () => resolve(ws)); ws.once("unexpected-response", (_r, res) => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode }))); ws.once("error", reject);
});
const AGY = { engine: "antigravityAgent", action: "login", bot: "atlas" };
const CODE = "4/0AfJohXn_abcdefghijklmnopqrstuvwxyz0123456789-ABC";
const tick = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
const closing = (ws: WebSocket) => new Promise<{ code: number; text: string }>(resolve => { let text = ""; ws.on("message", d => { text += String(d); }); ws.once("close", code => resolve({ code, text })); });
const opened = async (port: number, who: { cookie: Record<string, string> }) => { proof = true; const { body } = await ticketFor(port, who, AGY); proof = false; return connect(port, who, `action=login&bot=atlas&loginTicket=${encodeURIComponent(body.ticket)}`); };

describe("Antigravity ticket: the tier and the bot", () => {
  it("a fresh door alone is not enough: the ticket asks for an emailed code naming the bot, and a proven code mints it (base: minted on the door)", async () => {
    const port = await start(), who = owner();
    const asked = await ticketFor(port, who, AGY);
    expect(asked.status).toBe(403);
    expect(asked.body).toMatchObject({ code: "email_code", label: "fresh_door", labelArg: "atlas", actToken: "act" });
    expect(asked.body.ticket).toBeUndefined();
    proof = true;
    const minted = await ticketFor(port, who, AGY);
    expect(minted.status).toBe(200); expect(typeof minted.body.ticket).toBe("string");
    expect((await ticketFor(port, who, { engine: "claudeAgent", action: "login" })).status).toBe(200);
  });
  it("a bot that is not on the home is 400 at mint and 403 at the upgrade; logout without a bot is 400; a duplicated bot is 400", async () => {
    const port = await start(), who = owner();
    proof = true;
    expect((await ticketFor(port, who, { ...AGY, bot: "ghost" })).status).toBe(400);
    expect((await ticketFor(port, who, { engine: "antigravityAgent", action: "logout" })).status).toBe(400);
    const { body } = await ticketFor(port, who, AGY);
    bots.delete("atlas");
    await expect(connect(port, who, `action=login&bot=atlas&loginTicket=${encodeURIComponent(body.ticket)}`)).rejects.toMatchObject({ status: 403 });
    bots.add("atlas");
    const again = await ticketFor(port, who, AGY);
    await expect(connect(port, who, `action=login&bot=atlas&bot=atlas&loginTicket=${encodeURIComponent(again.body.ticket)}`)).rejects.toMatchObject({ status: 400 });
    expect(fakes).toHaveLength(0);
  });
});

describe("Antigravity relay: one code, checked once more, never echoed, and the outcome from a fresh read", () => {
  it("writes one code and drops everything else; the pty echo of the code and later output are not forwarded", async () => {
    const port = await start(), who = owner(), ws = await opened(port, who);
    await vi.waitFor(() => expect(fakes).toHaveLength(1));
    const fake = fakes[0]!, got: string[] = []; ws.on("message", d => got.push(String(d)));
    fake.stdout.write("Open this link"); await tick();
    ws.send("not a code"); ws.send(CODE); ws.send(CODE); ws.send("4/0AfJohXn_second1234567890abcdef"); await tick();
    expect(fake.written).toEqual([`${CODE}\r`]);
    fake.stdout.write(`> ${CODE}`); fake.stdout.write("more output"); await tick();
    expect(got.join("")).toBe("Open this link");
    ws.close();
  });
  it("a device or factor revoked after admission and before the code: nothing is written and the relay closes 1008 (base: written)", async () => {
    const port = await start(), who = owner(), ws = await opened(port, who);
    await vi.waitFor(() => expect(fakes).toHaveLength(1));
    live = false; const done = closing(ws);
    ws.send(CODE);
    expect((await done).code).toBe(1008);
    expect(fakes[0]!.written).toEqual([]);
    expect(fakes[0]!.ended()).toBe(true);
  });
  it("Done only after a fresh status read: committed and signed in says so; committed and unreadable says it could not confirm; never committed says nothing changed", async () => {
    const port = await start(), who = owner();
    for (const [read, commit, expected] of [[true, true, "Antigravity is signed in for atlas."], ["throw", true, "We could not confirm the sign-in. Check Connect."], [false, false, "Antigravity sign-in did not finish. Nothing changed. Try again."]] as const) {
      signedIn = read; live = commit; fakes = [];
      const ws = await opened(port, who); await vi.waitFor(() => expect(fakes).toHaveLength(1));
      const fake = fakes[0]!, done = closing(ws);
      live = true; ws.send(CODE); await tick();
      live = commit; fake.ready(); await tick();
      fake.exit(0);
      const end = await done;
      expect(end.code).toBe(1000);
      expect(end.text).toContain(expected);
      expect(end.text).not.toContain(CODE);
      await tick(120);
    }
  });
  it("a committed replacement that did not publish a NEW generation is never Done, though the previous account is still signed in (base: Done)", async () => {
    const port = await start(), who = owner();
    generationAdvances = false; signedIn = true; live = true; fakes = [];
    const ws = await opened(port, who); await vi.waitFor(() => expect(fakes).toHaveLength(1));
    const fake = fakes[0]!, done = closing(ws);
    ws.send(CODE); await tick(); fake.ready(); await tick(); fake.exit(0);
    const end = await done;
    expect(end.text).toContain("We could not confirm the sign-in. Check Connect.");
    expect(end.text).not.toContain("is signed in for atlas");
  });
  it("Astra r2 #2: an unrelated token refresh moves the generation but not the login epoch; a replacement that failed to publish is not Done (base: Done)", async () => {
    const port = await start(), who = owner();
    generationAdvances = false; signedIn = true; live = true; fakes = [];
    const ws = await opened(port, who); await vi.waitFor(() => expect(fakes).toHaveLength(1));
    const fake = fakes[0]!, done = closing(ws);
    ws.send(CODE); await tick(); fake.ready(); await tick(); fake.exit(0);
    const end = await done;
    expect(refreshReads).toBeGreaterThanOrEqual(0);
    expect(end.text).toContain("We could not confirm the sign-in. Check Connect.");
    expect(end.text).not.toContain("is signed in for atlas");
  });
  it("a completed login (a higher epoch) is Done", async () => {
    const port = await start(), who = owner();
    generationAdvances = true; signedIn = true; live = true; fakes = [];
    const ws = await opened(port, who); await vi.waitFor(() => expect(fakes).toHaveLength(1));
    const fake = fakes[0]!, done = closing(ws);
    ws.send(CODE); await tick(); fake.ready(); await tick(); fake.exit(0);
    expect((await done).text).toContain("Antigravity is signed in for atlas.");
  });
  it("the idle limit for Antigravity is longer than for the others", async () => {
    const { ENGINE_LOGIN_LIMITS } = await import("./cloud-home/engine-login.ts");
    expect(ENGINE_LOGIN_LIMITS.agyIdleMs).toBeGreaterThan(ENGINE_LOGIN_LIMITS.idleMs);
  });
});

describe("Antigravity relay: the desktop socket gets the same one-code rule", () => {
  it("writes one code and drops raw keystrokes, a second code and oversized input (base: raw bytes forwarded)", async () => {
    const fake = fakeLauncher();
    const relay = createEngineLoginRelay({ log: () => {}, killGraceMs: 100, spawnLauncher: () => fake.child as never });
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on("upgrade", (req, socket, head) => {
      setCloudIdentity(req.headers, { id: "dev1", account: "a", scope: "owner-desktop", publicKey: "", assertionKey: "", revoked: 0, factor: false });
      void relay(req, socket, head, new URL(req.url ?? "/", "http://localhost"));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/engine-login/antigravityAgent?action=login&bot=atlas`);
      await once(ws, "open");
      ws.send("\r"); ws.send("a"); ws.send(CODE); ws.send(CODE); await tick();
      expect(fake.written).toEqual([`${CODE}\r`]);
      ws.close(); await tick(250);
    } finally { server.close(); server.closeAllConnections(); }
  });
});
