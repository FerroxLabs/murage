// SPDX-License-Identifier: AGPL-3.0-or-later
// An owner's passkey browser gets the desktop owner's route access on a Cloud home; every other browser stays chat-level.
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessions } from "./cloud-sessions.ts";
import { createCloudRequestAuth, stepPurpose } from "./cloud-request-auth.ts";
import { cloudRouteDecision } from "./route-policy.ts";
import { isOwnerBrowser } from "./cloud-request-identity.ts";

const origin = "https://home.example", rpId = "home.example";
let sessions: CloudSessions, upstream: Server;
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
afterEach(async () => {
  if (upstream?.listening) { const closed = once(upstream, "close"); upstream.close(); upstream.closeAllConnections(); await closed; }
  if (sessions?.db.isOpen) sessions.db.close(); vi.unstubAllEnvs();
});
const p256 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = (key: { publicKey: import("node:crypto").KeyObject }) => key.publicKey.export({ format: "pem", type: "spki" }).toString();
function webauthn(key: ReturnType<typeof p256>, message: string, counter: number) {
  const client = Buffer.from(JSON.stringify({ type: "webauthn.get", origin, crossOrigin: false, challenge: Buffer.from(message).toString("base64url") }));
  const auth = Buffer.alloc(37); createHash("sha256").update(rpId).digest().copy(auth); auth[32] = 5; auth.writeUInt32BE(counter, 33);
  return { credentialId: "fixture-credential", clientDataJSON: client.toString("base64url"), authenticatorData: auth.toString("base64url"),
    signature: sign("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), key.privateKey).toString("base64url") };
}
/** A browser device row as it is stored. mint() no longer enrolls browsers (the door does, with no factor row), so the owner's passkey browser of an older home is written directly. */
function insertBrowser(keys: { key: ReturnType<typeof p256>; confirm: ReturnType<typeof p256> } | { key: ReturnType<typeof ed25519>; confirm: ReturnType<typeof ed25519> }, factor: boolean) {
  const id = randomUUID();
  sessions.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
  sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)").run(id, "owner", "browser", pem(keys.key), pem(keys.confirm), 0, 0);
  if (factor) sessions.db.prepare("INSERT INTO cloud_browser_factors VALUES (?,?)").run(id, JSON.stringify({ origin, rpId, credentialId: "fixture-credential", counter: 1 }));
  return { keys, ...sessions.issue(id) };
}
const ed25519 = () => generateKeyPairSync("ed25519");
/** The owner's passkey browser: P-256 device key plus a saved WebAuthn factor bound to the home hostname. */
function ownerBrowser() {
  const key = p256(), confirm = p256(), paired = insertBrowser({ key, confirm }, true);
  let counter = 1;
  const stepUp = (method: string, path: string, body: unknown) => {
    const purpose = stepPurpose(method, path, body), challenge = sessions.challenge(paired.deviceId, purpose), at = Date.now();
    const message = `murage:${sessions.environmentId}:${paired.deviceId}:${purpose}:${challenge}:${at}`;
    return { "x-murage-step-up": Buffer.from(JSON.stringify({ challenge, at, webauthn: webauthn(confirm, message, ++counter) })).toString("base64url") };
  };
  return { ...paired, cookie: { cookie: `__Host-murage=${paired.accessToken}` }, stepUp };
}
/** A chat-level browser: Ed25519 keys, no passkey (an older home's chat browser). */
function chatBrowser() {
  const paired = insertBrowser({ key: ed25519(), confirm: ed25519() }, false);
  return { ...paired, cookie: { cookie: `__Host-murage=${paired.accessToken}` } };
}
/** What the door enrolls: two P-256 keys and no factor row. */
function doorBrowser() {
  const paired = insertBrowser({ key: p256(), confirm: p256() }, false);
  return { ...paired, cookie: { cookie: `__Host-murage=${paired.accessToken}` } };
}
async function start() {
  sessions = new CloudSessions(new DatabaseSync(":memory:"), undefined, origin);
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => "fixture-bootstrap-key-32-characters" });
  upstream = createServer(async (req, res) => {
    if (await auth(req, res, new URL(req.url!, origin))) return;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ reachedHandler: true }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  return (upstream.address() as AddressInfo).port;
}
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown, requestOrigin = origin) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: "home.example", origin: requestOrigin, "content-type": "application/json", ...(data ? { "content-length": String(data.length) } : {}), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: t ? JSON.parse(t) : null }); });
    }); req.on("error", reject); req.end(data);
  });
}

describe("owner browser on a Cloud home", () => {
  it("is recognised only for a P-256 browser device with a saved passkey factor", async () => {
    await start();
    const owner = ownerBrowser(), chat = chatBrowser();
    expect(isOwnerBrowser(sessions.device(owner.deviceId))).toBe(true);
    expect(isOwnerBrowser(sessions.device(chat.deviceId))).toBe(false);
  });
  it("two P-256 keys without a factor row (a door browser) is not an owner browser", async () => {
    const port = await start(), door = doorBrowser();
    const device = sessions.device(door.deviceId)!;
    expect(device.factor).toBe(false);
    expect(isOwnerBrowser(device)).toBe(false);
    expect(isOwnerBrowser({ ...device, factor: true })).toBe(true); // the factor row is the only difference
    expect((await call(port, "GET", "/api/decisions", door.cookie)).status).toBe(403);
    expect((await call(port, "POST", "/api/bots/b1/messages", door.cookie, { text: "hi" })).status).toBe(200);
  });
  it("reaches owner routes the chat-level browser cannot", async () => {
    const port = await start(), owner = ownerBrowser(), chat = chatBrowser();
    for (const path of ["/api/decisions", "/api/team-map", "/api/setup/status", "/api/mcp/servers"]) {
      expect((await call(port, "GET", path, owner.cookie)).status).toBe(200);
      expect((await call(port, "GET", path, chat.cookie)).status).toBe(403);
    }
    expect((await call(port, "POST", "/api/bots/b1/messages", owner.cookie, { text: "hi" })).status).toBe(200);
    expect((await call(port, "POST", "/api/bots/b1/messages", chat.cookie, { text: "hi" })).status).toBe(200);
  });
  it("keeps the desktop's step-up on sensitive writes and the chat browser refused", async () => {
    const port = await start(), owner = ownerBrowser(), chat = chatBrowser(), path = "/api/provider-connections", body = { provider: "fixture" };
    expect((await call(port, "POST", path, owner.cookie, body)).status).toBe(403);
    expect((await call(port, "POST", path, { ...owner.cookie, ...owner.stepUp("POST", path, { provider: "other" }) }, body)).status).toBe(403);
    expect((await call(port, "POST", path, { ...owner.cookie, ...owner.stepUp("POST", path, body) }, body)).status).toBe(200);
    expect((await call(port, "POST", path, chat.cookie, body)).status).toBe(403);
    const full = { fullAccess: true };
    expect((await call(port, "PATCH", "/api/bots/b1", owner.cookie, full)).status).toBe(403);
    expect((await call(port, "PATCH", "/api/bots/b1", { ...owner.cookie, ...owner.stepUp("PATCH", "/api/bots/b1", full) }, full)).status).toBe(200);
  });
  it("still enforces the exact Origin on owner writes", async () => {
    const port = await start(), owner = ownerBrowser(), path = "/api/bots/b1/messages";
    expect((await call(port, "POST", path, owner.cookie, { text: "hi" }, "https://evil.example")).status).toBe(403);
    expect((await call(port, "POST", path, owner.cookie, { text: "hi" })).status).toBe(200);
  });
  it("refuses the credential terminal, the desktop secret and query tokens", async () => {
    const port = await start(), owner = ownerBrowser();
    expect(cloudRouteDecision("GET", "/api/desktop-secret", "owner-browser", {}, true)).toBe("deny");
    expect(cloudRouteDecision("GET", "/api/engine-login/codex", "owner-browser", {}, true)).toBe("deny");
    expect(cloudRouteDecision("GET", "/api/engine-login/codex", "owner-desktop", {}, true)).toBe("allow");
    expect((await call(port, "GET", "/api/decisions?token=" + owner.accessToken, owner.cookie)).status).toBe(400);
  });
  it("refuses an owner browser session once its device is revoked", async () => {
    const port = await start(), owner = ownerBrowser();
    expect((await call(port, "GET", "/api/decisions", owner.cookie)).status).toBe(200);
    sessions.revoke(owner.deviceId);
    expect((await call(port, "GET", "/api/decisions", owner.cookie)).status).toBe(403);
  });
});
