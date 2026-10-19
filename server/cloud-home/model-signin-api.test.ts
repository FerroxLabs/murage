// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessions, type CloudScope } from "../cloud-sessions.ts";
import { cloudBodies, createCloudRequestAuth, stepPurpose } from "../cloud-request-auth.ts";
import { createCloudModelSignInApi } from "./model-signin-api.ts";
import { HomeSignInError, type HomeSignInRequest } from "./model-signin.ts";
import { listenCloudProxy } from "./proxy-socket.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const origin = "https://home.example", base = "/api/cloud/model-signins", startPath = `${base}/chatgpt/start`;
const challenge = { provider: "chatgpt", attemptId: "attempt-1", state: "waiting", verificationUrl: "https://auth.openai.com/codex/device", userCode: "CODE-123", expiresAt: 9_000_000_000_000 };
const status = { providers: ["chatgpt", "supergrok"].map(provider => ({ provider, enabled: true, state: "signed-out", acceptsCode: false })) };
let root: string, sessions: CloudSessions, server: Server, proxy: Server | undefined, port: number;
let invoke: ReturnType<typeof vi.fn<(request: HomeSignInRequest) => Promise<unknown>>>;
let invalidate: ReturnType<typeof vi.fn<(deviceId: string) => void>>, remove: ReturnType<typeof vi.fn<(provider: string) => Promise<void>>>;
let active: boolean;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "home-signin-api-")); vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); active = true;
  sessions = new CloudSessions(new DatabaseSync(join(root, "sessions.db")));
  invoke = vi.fn(async (req: HomeSignInRequest) => req.operation === "status" ? status : ["start", "attempt"].includes(req.operation) ? challenge : null);
  invalidate = vi.fn(); remove = vi.fn(async () => {});
  const socketPath = join(root, "proxy.sock");
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, trustedProxy: `unix:${socketPath}`, bootstrapSecret: () => undefined });
  const api = createCloudModelSignInApi({ environmentId: sessions.environmentId, activeDevice: () => active, invoke, invalidateOwner: invalidate, removeConnection: remove,
    readBody: async (req, max) => { const cached = cloudBodies.get(req); if (cached) { if (cached.bytes > max) throw new HomeSignInError("invalid-request"); return cached.body; } const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); if (bytes.length > max) throw new HomeSignInError("invalid-request"); return bytes.length ? JSON.parse(bytes.toString()) : {}; },
  });
  server = createServer(async (req, res) => { const url = new URL(req.url!, origin); if (await auth(req, res, url)) return; if (await api(req, res, url)) return; res.writeHead(404); res.end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const s of [server, proxy]) if (s?.listening) { const closed = once(s, "close"); s.close(); s.closeAllConnections(); await closed; }
  proxy = undefined; sessions.db.close(); removeTempDirSync(root); vi.unstubAllEnvs();
});
function pair(scope: CloudScope) {
  const key = generateKeyPairSync("ed25519"), factorKey = generateKeyPairSync("ed25519");
  if (scope === "browser") {
    // mint() no longer enrolls browsers (the door does, with no factor row): the row is written as the door writes it.
    const id = randomUUID();
    sessions.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
    sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,0,0)").run(id, "owner", "browser", key.publicKey.export({ type: "spki", format: "pem" }).toString(), factorKey.publicKey.export({ type: "spki", format: "pem" }).toString());
    return { ...sessions.issue(id), factorKey };
  }
  const code = sessions.mint({ account: "owner", scope, publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), assertionKey: factorKey.publicKey.export({ type: "spki", format: "pem" }).toString() });
  const msg = Buffer.from(`murage-pair:${sessions.environmentId}:${code}:owner`);
  return { ...sessions.redeem(code, "owner", sign(null, msg, key.privateKey).toString("base64url"), sign(null, msg, factorKey.privateKey).toString("base64url")), factorKey };
}
type Device = ReturnType<typeof pair>;
function factor(device: Device, method: string, path: string, body: unknown = {}) {
  const purpose = stepPurpose(method, path, body), challenge = sessions.challenge(device.deviceId, purpose), at = Date.now();
  const signature = sign(null, Buffer.from(`murage:${sessions.environmentId}:${device.deviceId}:${purpose}:${challenge}:${at}`), device.factorKey.privateKey).toString("base64url");
  return { "x-murage-step-up": Buffer.from(JSON.stringify({ challenge, at, signature })).toString("base64url") };
}
function call(method: string, path: string, device?: Device, body?: unknown, headers: Record<string, string> = {}, socketPath?: string) {
  return new Promise<{ status: number; body: any; cache: string | undefined }>((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ ...(socketPath ? { socketPath } : { host: "127.0.0.1", port }), method, path, agent: false, headers: { host: "home.example", origin, ...(socketPath ? { "x-forwarded-host": "home.example" } : {}), ...(device ? { authorization: `Bearer ${device.accessToken}` } : {}), ...(bytes ? { "content-type": "application/json", "content-length": String(bytes.length) } : {}), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null, cache: res.headers["cache-control"] }); });
    }); req.on("error", reject); req.end(bytes);
  });
}
describe("Home model sign-in HTTP boundary with real paired factors", () => {
  it.each(["owner-desktop", "owner-phone"] as const)("%s reads status and starts only with its own fresh factor", async scope => {
    const device = pair(scope);
    expect((await call("GET", base, device)).body).toEqual(status);
    expect((await call("POST", startPath, device, {})).status).toBe(403);
    const signed = factor(device, "POST", startPath);
    const reply = await call("POST", startPath, device, {}, signed);
    expect(reply).toEqual({ status: 202, body: challenge, cache: "no-store" });
    expect(invoke).toHaveBeenLastCalledWith({ operation: "start", provider: "chatgpt", actor: { environmentId: sessions.environmentId, deviceId: device.deviceId } });
    expect((await call("POST", startPath, device, {}, signed)).status).toBe(403);
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("refuses browser cookie, loopback service and anonymous Unix clients", async () => {
    const browser = pair("browser"), cookie = { cookie: `__Host-murage=${browser.accessToken}` };
    const socketPath = join(root, "proxy.sock"); proxy = listenCloudProxy(server, socketPath)!; await once(proxy, "listening");
    for (const [method, path, body] of [["GET", base, undefined], ["POST", startPath, {}]] as const) {
      expect((await call(method, path, undefined, body, { ...cookie, ...factor(browser, method, path, body) })).status).toBe(403);
      expect((await call(method, path, undefined, body)).status).toBe(403);
      expect((await call(method, path, undefined, body, {}, socketPath)).status).toBe(403);
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it("binds assertions to method, path, body and device", async () => {
    const device = pair("owner-phone"), other = pair("owner-phone");
    for (const [method, path, body, actor] of [["DELETE", `${base}/chatgpt`, {}, device], ["POST", `${base}/supergrok/start`, {}, device], ["POST", startPath, { token: "FAKE-SECRET" }, device], ["POST", startPath, {}, other]] as const)
      expect((await call(method, path, actor, body, factor(device, "POST", startPath))).status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([{ token: "fake" }, { actor: { deviceId: "forged" } }, { verificationUrl: "https://evil.example" }, { args: [] }])("rejects extra caller fields even with valid factor: %j", async body => {
    const device = pair("owner-desktop");
    expect((await call("POST", startPath, device, body, factor(device, "POST", startPath, body))).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("polls only through the bound actor and handles cancel, sign-out and removal", async () => {
    const device = pair("owner-phone"), path = `${base}/chatgpt/attempts/attempt-1`;
    expect((await call("GET", path, device)).body).toEqual(challenge);
    expect(invoke).toHaveBeenLastCalledWith({ operation: "attempt", provider: "chatgpt", attemptId: "attempt-1", actor: { environmentId: sessions.environmentId, deviceId: device.deviceId } });
    for (const [method, target, operation] of [["POST", `${path}/cancel`, "cancel"], ["POST", `${base}/chatgpt/sign-out`, "signOut"], ["DELETE", `${base}/chatgpt`, "remove"]] as const) {
      expect((await call(method, target, device, {})).status).toBe(403);
      expect((await call(method, target, device, {}, factor(device, method, target))).status).toBe(204);
      expect(invoke.mock.lastCall?.[0].operation).toBe(operation);
    }
    expect(remove).toHaveBeenCalledExactlyOnceWith("chatgpt");
  });
  it.each([{ ...challenge, accessToken: "FAKE-SECRET" }, { ...challenge, verificationUrl: "https://evil.example/FAKE-SECRET" }, { ...challenge, userCode: "x".repeat(129) }])("refuses malformed or secret-bearing supervisor response", async value => {
    invoke.mockResolvedValue(value); const device = pair("owner-desktop");
    const reply = await call("POST", startPath, device, {}, factor(device, "POST", startPath));
    expect(reply.status).toBe(503); expect(JSON.stringify(reply.body)).not.toContain("FAKE-SECRET");
  });
  it("maps rate errors and hides arbitrary exception messages", async () => {
    const device = pair("owner-desktop");
    invoke.mockRejectedValueOnce(new HomeSignInError("rate-limited")).mockRejectedValueOnce(new Error("FAKE-SECRET"));
    const limited = await call("POST", startPath, device, {}, factor(device, "POST", startPath));
    expect(limited.status).toBe(429); expect(limited.body.code).toBe("rate-limited");
    const failed = await call("POST", startPath, device, {}, factor(device, "POST", startPath));
    expect(failed.status).toBe(503); expect(JSON.stringify(failed.body)).not.toContain("FAKE-SECRET");
  });
  it("invalidates an actor revoked while the supervisor is pending", async () => {
    const device = pair("owner-desktop"); let release!: (value: unknown) => void;
    let entered!: () => void; const enteredPromise = new Promise<void>(r => { entered = r; });
    invoke.mockImplementation(() => { entered(); return new Promise(r => { release = r; }); });
    const pending = call("POST", startPath, device, {}, factor(device, "POST", startPath));
    await enteredPromise; active = false; release(challenge);
    expect((await pending).status).toBe(403); expect(invalidate).toHaveBeenCalledExactlyOnceWith(device.deviceId);
  });
  it("invalidates interrupted response, but not ordinary incoming request completion", async () => {
    const device = pair("owner-desktop"); let release!: (value: unknown) => void;
    let entered!: () => void; const enteredPromise = new Promise<void>(r => { entered = r; });
    let invalidated!: () => void; const invalidatedPromise = new Promise<void>(r => { invalidated = r; });
    invalidate.mockImplementation(() => invalidated());
    invoke.mockImplementation(() => { entered(); return new Promise(r => { release = r; }); });
    const req = request({ host: "127.0.0.1", port, method: "POST", path: startPath, headers: { host: "home.example", origin, authorization: `Bearer ${device.accessToken}`, "content-type": "application/json", "content-length": "2", ...factor(device, "POST", startPath) } });
    req.on("error", () => {}); req.end("{}"); await enteredPromise;
    expect(invalidate).not.toHaveBeenCalled(); req.destroy(); await invalidatedPromise; release(challenge);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(device.deviceId);
  });
});
