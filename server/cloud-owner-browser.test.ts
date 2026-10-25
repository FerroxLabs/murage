// SPDX-License-Identifier: AGPL-3.0-or-later
// An owner's passkey browser gets the desktop owner's route access on a Cloud home; every other browser stays chat-level.
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessions } from "./cloud-sessions.ts";
import { createCloudRequestAuth, stepPurpose } from "./cloud-request-auth.ts";
import { cloudRouteDecision } from "./route-policy.ts";
import { isOwnerBrowser } from "./cloud-request-identity.ts";
import { cloudHomeCopy } from "./cloud-home/copy.ts";

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
const DAY = 24 * 60 * 60 * 1000;
function insertBrowser(keys: { key: ReturnType<typeof p256>; confirm: ReturnType<typeof p256> } | { key: ReturnType<typeof ed25519>; confirm: ReturnType<typeof ed25519> }, factor: false | "passkey" | "remembered-owner", opts: { expiresAt?: number; keyHash?: string } = {}) {
  const id = randomUUID();
  sessions.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
  sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)").run(id, "owner", "browser", pem(keys.key), pem(keys.confirm), 0, 0);
  if (factor === "passkey") sessions.db.prepare("INSERT INTO cloud_browser_factors (device,payload) VALUES (?,?)").run(id, JSON.stringify({ origin, rpId, credentialId: "fixture-credential", counter: 1 }));
  else if (factor === "remembered-owner") {
    const now = Date.now();
    const keyHash = opts.keyHash ?? createHash("sha256").update(createPublicKey(pem(keys.confirm)).export({ type: "spki", format: "der" })).digest("hex");
    const expiresAt = opts.expiresAt ?? now + 30 * DAY;
    sessions.db.prepare("INSERT INTO cloud_browser_factors (device,payload,kind,issuedAt,expiresAt,keyHash,stepUpAt,revokedAt) VALUES (?,?,?,?,?,?,?,NULL)")
      .run(id, JSON.stringify({ kind: "remembered-owner", keyHash, proof: "email", stepUpAt: now, ticketNonce: "fixture-nonce" }), "remembered-owner", now, expiresAt, keyHash, now);
  }
  return { id, keys, ...sessions.issue(id) };
}
const ed25519 = () => generateKeyPairSync("ed25519");
/** The owner's passkey browser: P-256 device key plus a saved WebAuthn factor bound to the home hostname. */
function ownerBrowser() {
  const key = p256(), confirm = p256(), paired = insertBrowser({ key, confirm }, "passkey");
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
/** A remembered-owner browser: P-256 keys plus a live remembered-owner factor bound to the assertion key. Its stepUp forges a
 *  plain-P256 x-murage-step-up signed by the assertion key, to prove even a valid one cannot widen a remembered-owner write. */
function rememberedOwnerBrowser(opts: { expiresAt?: number; keyHash?: string } = {}) {
  const key = p256(), confirm = p256(), paired = insertBrowser({ key, confirm }, "remembered-owner", opts);
  const stepUp = (method: string, path: string, body: unknown) => {
    const purpose = stepPurpose(method, path, body), challenge = sessions.challenge(paired.deviceId, purpose), at = Date.now();
    const message = `murage:${sessions.environmentId}:${paired.deviceId}:${purpose}:${challenge}:${at}`;
    const signature = sign("sha256", Buffer.from(message), { key: confirm.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return { "x-murage-step-up": Buffer.from(JSON.stringify({ challenge, at, signature })).toString("base64url") };
  };
  return { ...paired, confirm, cookie: { cookie: `__Host-murage=${paired.accessToken}` }, stepUp };
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
    expect(isOwnerBrowser({ ...device, factor: "passkey" })).toBe(true); // the factor row is the only difference
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

describe("remembered-owner browser on a Cloud home", () => {
  it("is an owner browser for reads but carries the remembered-owner factor kind", async () => {
    await start();
    const r = rememberedOwnerBrowser();
    const device = sessions.device(r.deviceId)!;
    expect(device.factor).toBe("remembered-owner");
    expect(isOwnerBrowser(device)).toBe(true);
  });
  it("admits the owner read set and refuses every other desktop-class GET", async () => {
    const port = await start(), r = rememberedOwnerBrowser(), chat = chatBrowser();
    for (const path of ["/api/inbox", "/api/decisions", "/api/team-map", "/api/setup"])
      expect((await call(port, "GET", path, r.cookie)).status).toBe(200);
    // The three desktop-class reads the gate opens for a remembered owner stay closed to a bare chat browser (/api/inbox is
    // companion class: the gate admits it for any browser and its own handler scopes it, so it is not a gate 403 here).
    for (const path of ["/api/decisions", "/api/team-map", "/api/setup"])
      expect((await call(port, "GET", path, chat.cookie)).status).toBe(403);
    expect((await call(port, "GET", "/api/storage", r.cookie)).status).toBe(403);
    expect((await call(port, "GET", "/api/cli-candidates", r.cookie)).status).toBe(403);
  });
  it("sends chat (the three writes) and nothing else", async () => {
    const port = await start(), r = rememberedOwnerBrowser();
    expect((await call(port, "POST", "/api/bots/b1/messages", r.cookie, { text: "hi" })).status).toBe(200);
    expect((await call(port, "POST", "/api/groups/g1/messages", r.cookie, { text: "hi" })).status).toBe(200);
    expect((await call(port, "POST", "/api/bots/b1/respond", r.cookie, { behavior: "deny" })).status).toBe(200);
    // room creation, fork move, workspace, ordinary and companion writes are all denied at the gate with pairedDeviceRequired (NOT step-up).
    for (const [method, path, body] of [["POST", "/api/groups", {}], ["POST", "/api/bots/b1/active-branch", {}],
      ["PUT", "/api/workspace-files/x", {}], ["PUT", "/api/bots/b1/general-notes", { text: "x" }], ["POST", "/api/inbox/state", {}]] as const) {
      const res = await call(port, method, path, r.cookie, body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(cloudHomeCopy.pairedDeviceRequired);
      expect(res.body.error).not.toBe(cloudHomeCopy.stepUpRequired);
    }
  });
  it("the gate decision matrix: reads allow, three writes allow, everything else deny, never step-up", () => {
    for (const p of ["/api/decisions", "/api/team-map", "/api/setup", "/api/setup/status", "/api/inbox", "/api/config"])
      expect(cloudRouteDecision("GET", p, "remembered-owner", {})).toBe("allow");
    for (const p of ["/api/storage", "/api/cli-candidates", "/api/deletions/owed"])
      expect(cloudRouteDecision("GET", p, "remembered-owner", {})).toBe("deny");
    for (const [m, p] of [["POST", "/api/bots/b1/messages"], ["POST", "/api/groups/g1/messages"], ["POST", "/api/bots/b1/respond"]] as const)
      expect(cloudRouteDecision(m, p, "remembered-owner", {})).toBe("allow");
    for (const [m, p] of [["POST", "/api/groups"], ["POST", "/api/bots/b1/active-branch"], ["PUT", "/api/bots/b1/general-notes"],
      ["POST", "/api/inbox/state"], ["PUT", "/api/workspace-files/x"]] as const)
      expect(cloudRouteDecision(m, p, "remembered-owner", {})).toBe("deny");
    // No step-up can widen a remembered-owner write.
    expect(cloudRouteDecision("PUT", "/api/bots/b1/general-notes", "remembered-owner", { text: "x" }, true)).toBe("deny");
  });
  it("no upgrade exists: a valid assertion-key step-up still 403s, and consumeAssertion on the row is false", async () => {
    const port = await start(), r = rememberedOwnerBrowser(), path = "/api/bots/b1/general-notes", body = { text: "x" };
    const res = await call(port, "PUT", path, { ...r.cookie, ...r.stepUp("PUT", path, body) }, body);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(cloudHomeCopy.pairedDeviceRequired);
    const challenge = sessions.challenge(r.deviceId, "p"), at = Date.now();
    const message = `murage:${sessions.environmentId}:${r.deviceId}:p:${challenge}:${at}`;
    const sig = sign("sha256", Buffer.from(message), { key: r.confirm.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    expect(sessions.consumeAssertion(r.deviceId, challenge, "p", at, sig)).toBe(false);
  });
  it("expired, keyHash-mismatched, factor-revoked and device-revoked rows all read chat-level", async () => {
    await start();
    const expired = rememberedOwnerBrowser({ expiresAt: Date.now() - 1 });
    expect(sessions.device(expired.deviceId)!.factor).toBe(false);
    const mismatch = rememberedOwnerBrowser({ keyHash: "0".repeat(64) });
    expect(sessions.device(mismatch.deviceId)!.factor).toBe(false);
    const revokedFactor = rememberedOwnerBrowser();
    sessions.revokeOwnerFactor(revokedFactor.deviceId);
    expect(sessions.device(revokedFactor.deviceId)!.factor).toBe(false);
    const revokedDevice = rememberedOwnerBrowser();
    sessions.revoke(revokedDevice.deviceId);
    expect(sessions.device(revokedDevice.deviceId)).toBeUndefined();
  });
  it("Make chat-only drives the owner-factor revoke route into the one atomic revoke+watermark chain", async () => {
    // The device list's "Make chat-only" button posts /api/cloud/devices/:id/owner/revoke (src/lib/cloud-door.ts makeChatOnly).
    // That sensitive route needs a paired owner step-up, and ends in revokeOwnerFactor: the factor row revoke AND the home-wide
    // watermark in one tx() BEGIN IMMEDIATE. This proves the button's call reaches that chain, not a shortcut or a direct mutation.
    const port = await start(), owner = ownerBrowser(), target = rememberedOwnerBrowser();
    const path = `/api/cloud/devices/${target.deviceId}/owner/revoke`;
    expect(sessions.watermarkFor("*")).toBe(0);
    expect(sessions.device(target.deviceId)!.factor).toBe("remembered-owner");
    expect((await call(port, "POST", path, owner.cookie, {})).status).toBe(403); // the sensitive route needs a step-up
    expect((await call(port, "POST", path, { ...owner.cookie, ...owner.stepUp("POST", path, {}) }, {})).status).toBe(200);
    expect(sessions.device(target.deviceId)!.factor).toBe(false);   // the factor row was revoked
    expect(sessions.watermarkFor("*")).toBeGreaterThan(0);          // and the home-wide watermark was written, together
  });
});
