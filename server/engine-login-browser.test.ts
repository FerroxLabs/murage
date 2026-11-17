// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// An owner's browser signs an engine in on a Cloud home: ticket issue, ticket redeem at the relay, admission by scope, and the one
// keyboard line the relay gives a browser. Real auth, real upgrade gate, real relay; the launcher is `cat` (a fake, no vendor, no keys).
import { spawn } from "node:child_process";
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
import { createEngineLoginRelay, type EngineLoginEngine, type EngineLoginExtra } from "./cloud-home/engine-login.ts";
import { ENGINE_LOGIN_BROWSER_CODE, browserStdin, createEngineLoginTickets, engineTicketPrincipal } from "./cloud-home/engine-login-target.ts";
import { cloudRouteDecision } from "./route-policy.ts";
import { browserOwnerTier } from "./browser-owner-policy.ts";

const origin = "https://home.example";
let sessions: CloudSessions, upstream: Server, fresh = true, now = 1_000_000, launches: Array<{ engine: string; action: string; extra: EngineLoginExtra }>;
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); fresh = true; now = 1_000_000; launches = []; });
afterEach(async () => {
  if (upstream?.listening) { const closed = once(upstream, "close"); upstream.close(); upstream.closeAllConnections(); await closed; }
  if (sessions?.db.isOpen) sessions.db.close(); vi.unstubAllEnvs();
});
const p256 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = (key: { publicKey: import("node:crypto").KeyObject }) => key.publicKey.export({ format: "pem", type: "spki" }).toString();
const DAY = 24 * 60 * 60 * 1000;
function browser(factor: false | "remembered-owner") {
  const key = p256(), confirm = p256(), id = randomUUID();
  sessions.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
  sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,0,0)").run(id, "owner", "browser", pem(key), pem(confirm));
  if (factor) {
    const t = Date.now(), keyHash = createHash("sha256").update(createPublicKey(pem(confirm)).export({ type: "spki", format: "der" })).digest("hex");
    sessions.db.prepare("INSERT INTO cloud_browser_factors (device,payload,kind,issuedAt,expiresAt,keyHash,stepUpAt,revokedAt) VALUES (?,?,?,?,?,?,?,NULL)")
      .run(id, JSON.stringify({ kind: "remembered-owner", keyHash, proof: "email", stepUpAt: t, ticketNonce: "fixture-nonce" }), "remembered-owner", t, t + 30 * DAY, keyHash, t);
  }
  const paired = sessions.issue(id);
  return { id, cookie: { cookie: `__Host-murage=${paired.accessToken}` } };
}
const owner = () => browser("remembered-owner");
const ownerAct: CloudOwnerAct = { token: () => "act", verifyProof: () => false, doorFresh: () => fresh };
async function start() {
  sessions = new CloudSessions(new DatabaseSync(":memory:"), undefined, origin);
  const tickets = createEngineLoginTickets({ now: () => now });
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => "fixture-bootstrap-key-32-characters", ownerAct, engineTickets: tickets });
  const relay = createEngineLoginRelay({ log: () => {}, killGraceMs: 200,
    spawnLauncher: (engine: EngineLoginEngine, action, extra) => { launches.push({ engine, action, extra }); return spawn("/bin/cat", [], { detached: true, stdio: ["pipe", "pipe", "pipe"] }); } });
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
const ticketFor = async (port: number, who: { cookie: Record<string, string> }, body: Record<string, unknown>) => post(port, "/api/cloud/engine-login/ticket", who.cookie, body);
const connect = (port: number, who: { cookie: Record<string, string> } | null, engine: string, query: string) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/engine-login/${engine}?${query}`, { headers: { host: "home.example", origin, ...(who ? who.cookie : {}) } });
  ws.once("open", () => resolve(ws)); ws.once("unexpected-response", (_r, res) => reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode }))); ws.once("error", reject);
});
const claudeQuery = (ticket: string) => `action=login&loginTicket=${encodeURIComponent(ticket)}`;
const CODE = "abcDEF1234567890xyz-_#state12345";

describe("engine sign-in ticket: issue", () => {
  it("an owner browser with a fresh door gets one ticket; a stale door is asked for a code first; no ticket is minted for a stale door", async () => {
    const port = await start(), who = owner();
    const ok = await ticketFor(port, who, { engine: "claudeAgent", action: "login" });
    expect(ok.status).toBe(200); expect(typeof ok.body.ticket).toBe("string"); expect(ok.body.expiresIn).toBe(30);
    fresh = false;
    const stale = await ticketFor(port, who, { engine: "claudeAgent", action: "login" });
    expect(stale.status).toBe(403); expect(stale.body).toMatchObject({ code: "email_code", label: "fresh_door" }); expect(stale.body.ticket).toBeUndefined();
  });
  it("a chat-only browser, a bare door browser and an unsigned caller get no ticket", async () => {
    const port = await start();
    for (const who of [browser(false), { cookie: {} }]) expect((await ticketFor(port, who, { engine: "claudeAgent", action: "login" })).status).toBe(403);
  });
  it("refuses a target the relay would refuse: unknown engine, a per-bot engine with no bot, extra keys", async () => {
    const port = await start(), who = owner();
    for (const body of [{ engine: "nope", action: "login" }, { engine: "codex", action: "login" }, { engine: "claudeAgent", action: "enroll-key" }, { engine: "claudeAgent", action: "login", extra: "x" }])
      expect((await ticketFor(port, who, body)).status).toBe(400);
  });
});

describe("engine sign-in ticket: redeem at the relay", () => {
  it("admits an owner browser once, for exactly the target the ticket names, and starts the vendor sign-in on the home", async () => {
    const port = await start(), who = owner();
    const { body } = await ticketFor(port, who, { engine: "claudeAgent", action: "login" });
    const ws = await connect(port, who, "claudeAgent", claudeQuery(body.ticket));
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    expect(launches[0]).toMatchObject({ engine: "claudeAgent", action: "login" });
    ws.close();
  });
  it("a ticket is single use: a replay is refused", async () => {
    const port = await start(), who = owner();
    const { body } = await ticketFor(port, who, { engine: "claudeAgent", action: "login" });
    (await connect(port, who, "claudeAgent", claudeQuery(body.ticket))).close();
    await expect(connect(port, who, "claudeAgent", claudeQuery(body.ticket))).rejects.toMatchObject({ status: 403 });
  });
  it("a forged ticket, no ticket and a ticket for no one are refused; nothing launches", async () => {
    const port = await start(), who = owner();
    await expect(connect(port, who, "claudeAgent", claudeQuery("A".repeat(43)))).rejects.toMatchObject({ status: 403 });
    await expect(connect(port, who, "claudeAgent", "action=login")).rejects.toMatchObject({ status: 403 });
    await expect(connect(port, null, "claudeAgent", claudeQuery("A".repeat(43)))).rejects.toMatchObject({ status: 403 });
    expect(launches).toHaveLength(0);
  });
  it("a ticket is bound to its device: another owner browser cannot use it", async () => {
    const port = await start(), a = owner(), b = owner();
    const { body } = await ticketFor(port, a, { engine: "claudeAgent", action: "login" });
    await expect(connect(port, b, "claudeAgent", claudeQuery(body.ticket))).rejects.toMatchObject({ status: 403 });
    expect(launches).toHaveLength(0);
  });
  it("a ticket is bound to its target: another engine, action or bot is refused, and the wrong try spends it", async () => {
    const port = await start(), who = owner();
    const claude = (await ticketFor(port, who, { engine: "claudeAgent", action: "login" })).body.ticket;
    await expect(connect(port, who, "grokAgent", `action=login&bot=atlas&loginTicket=${claude}`)).rejects.toMatchObject({ status: 403 });
    await expect(connect(port, who, "claudeAgent", claudeQuery(claude))).rejects.toMatchObject({ status: 403 });
    const codex = (await ticketFor(port, who, { engine: "codex", action: "login", bot: "atlas" })).body.ticket;
    await expect(connect(port, who, "codex", `action=login&bot=other&loginTicket=${codex}`)).rejects.toMatchObject({ status: 403 });
    const logout = (await ticketFor(port, who, { engine: "claudeAgent", action: "logout" })).body.ticket;
    await expect(connect(port, who, "claudeAgent", claudeQuery(logout))).rejects.toMatchObject({ status: 403 });
    expect(launches).toHaveLength(0);
  });
  it("a ticket expires after 30 seconds", async () => {
    const port = await start(), who = owner();
    const { body } = await ticketFor(port, who, { engine: "claudeAgent", action: "login" });
    now += 31_000;
    await expect(connect(port, who, "claudeAgent", claudeQuery(body.ticket))).rejects.toMatchObject({ status: 403 });
    expect(launches).toHaveLength(0);
  });
  it("a chat-only browser and a bare door browser are refused even with a ticket an owner minted", async () => {
    const port = await start(), who = owner();
    const { body } = await ticketFor(port, who, { engine: "claudeAgent", action: "login" });
    for (const other of [browser(false)]) await expect(connect(port, other, "claudeAgent", claudeQuery(body.ticket))).rejects.toMatchObject({ status: 403 });
    expect(launches).toHaveLength(0);
  });
  it("without a ticket the policy still refuses an owner browser at the relay's path, and with one it allows it", () => {
    const path = "/api/engine-login/claudeAgent";
    expect(cloudRouteDecision("GET", path, "remembered-owner", {}, false, {})).toBe("deny");
    expect(cloudRouteDecision("GET", path, "remembered-owner", {}, false, { engineTicket: true })).toBe("allow");
    for (const scope of ["browser", "service", "anonymous"] as const) expect(cloudRouteDecision("GET", path, scope, {}, false, { engineTicket: true })).toBe("deny");
    expect(browserOwnerTier("POST", "/api/cloud/engine-login/ticket", {}).tier).toBe("fresh-door");
  });
});

describe("the relay's keyboard for a browser", () => {
  it("passes one pasted Claude code (with a carriage return) and drops everything else", async () => {
    const port = await start(), who = owner();
    const { body } = await ticketFor(port, who, { engine: "claudeAgent", action: "login" });
    const ws = await connect(port, who, "claudeAgent", claudeQuery(body.ticket));
    const seen: string[] = []; ws.on("message", data => seen.push(String(data)));
    ws.send("rm -rf /; echo hi"); ws.send("\u0003"); ws.send("short");
    ws.send(`${CODE}\r`);
    await vi.waitFor(() => expect(seen.join("")).toContain(CODE));
    ws.send("second-code-attempt-123456789"); await new Promise(r => setTimeout(r, 150));
    expect(seen.join("")).not.toContain("rm -rf"); expect(seen.join("")).not.toContain("second-code");
    ws.close();
  });
  it("an engine that takes no typing (Codex device code) drops every message", async () => {
    const port = await start(), who = owner();
    const { body } = await ticketFor(port, who, { engine: "codex", action: "login", bot: "atlas" });
    const ws = await connect(port, who, "codex", `action=login&bot=atlas&loginTicket=${body.ticket}`);
    const seen: string[] = []; ws.on("message", data => seen.push(String(data)));
    ws.send(`${CODE}\r`); await new Promise(r => setTimeout(r, 200));
    expect(seen).toEqual([]);
    ws.close();
  });
});

describe("engine sign-in unit rules", () => {
  it("browserStdin: a code shaped for the engine, once, on login only", () => {
    expect(browserStdin("claudeAgent", "login", `${CODE}\r`, false)).toBe(`${CODE}\r`);
    expect(browserStdin("claudeAgent", "login", CODE, true)).toBeNull();
    expect(browserStdin("claudeAgent", "logout", CODE, false)).toBeNull();
    expect(browserStdin("claudeAgent", "login", "two words here 1234567890", false)).toBeNull();
    expect(browserStdin("claudeAgent", "login", `${CODE}\r\nrm -rf`, false)).toBeNull();
    expect(browserStdin("claudeAgent", "login", "x".repeat(2000), false)).toBeNull();
    expect(browserStdin("codex", "login", CODE, false)).toBeNull();
    expect(browserStdin("opencodeGo", "login", "\r", false)).toBeNull();
    expect(Object.keys(ENGINE_LOGIN_BROWSER_CODE)).toHaveLength(6);
  });
  it("the ticket principal differs for any device, token, engine, action, bot or provider", () => {
    const base = engineTicketPrincipal({ deviceId: "d", accessToken: "t" }, { engine: "codex", action: "login", bot: "a" });
    const others = [engineTicketPrincipal({ deviceId: "e", accessToken: "t" }, { engine: "codex", action: "login", bot: "a" }), engineTicketPrincipal({ deviceId: "d", accessToken: "u" }, { engine: "codex", action: "login", bot: "a" }),
      engineTicketPrincipal({ deviceId: "d", accessToken: "t" }, { engine: "grokAgent", action: "login", bot: "a" }), engineTicketPrincipal({ deviceId: "d", accessToken: "t" }, { engine: "codex", action: "logout", bot: "a" }),
      engineTicketPrincipal({ deviceId: "d", accessToken: "t" }, { engine: "codex", action: "login", bot: "b" }), engineTicketPrincipal({ deviceId: "d", accessToken: "t" }, { engine: "codex", action: "login" })];
    expect(new Set([base, ...others]).size).toBe(7);
    expect(base).not.toContain("\"t\""); // the token itself is never in the principal, only its hash
  });
});
