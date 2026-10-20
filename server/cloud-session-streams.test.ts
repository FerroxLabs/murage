// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { closeSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeSync } from "node:fs";
import { createServer, request, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudSessions } from "./cloud-sessions.ts";
import { cloudBodies, createCloudRequestAuth, stepPurpose } from "./cloud-request-auth.ts";
import { requestSurface } from "./sse-visibility.ts";
import { SseWriter } from "./sse-buffer.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { __resetMediaAssetsForTests, issueMediaCapability, mediaActiveStreamCount, mediaAssetsRoute, mediaWorkspaceRevision, verifyMediaCapability } from "./media-assets.ts";
import { sendDelegated } from "./route-delegation.ts";

import { removeTempDirSync } from "./testing/cleanup.ts";
const origin = "https://home.example", clients: ClientRequest[] = [], databases: DatabaseSync[] = [], dirs: string[] = [], servers: Server[] = [];
beforeEach(() => {
  // DATA_DIR is canonical (realpath), and on macOS os.tmpdir() is reached through /var -> /private/var
  if (![tmpdir(), realpathSync(tmpdir())].some(root => DATA_DIR.startsWith(root + sep))) throw new Error("The media fixture requires a temporary data directory");
  removeTempDirSync(DATA_DIR); __resetMediaAssetsForTests(); vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
  __resetMediaAssetsForTests(); vi.useRealTimers(); vi.unstubAllEnvs();
});
type Device = { deviceId: string; accessToken: string; factor: { privateKey: KeyObject; publicKey: KeyObject } };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-stream-")); dirs.push(root);
  const db = new DatabaseSync(join(root, "sessions.db")); databases.push(db); const sessions = new CloudSessions(db);
  const pair = (): Device => {
    const key = generateKeyPairSync("ed25519"), factor = generateKeyPairSync("ed25519");
    const code = sessions.mint({ account: "fixture-owner", scope: "owner-desktop", publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), assertionKey: factor.publicKey.export({ type: "spki", format: "pem" }).toString() });
    const message = Buffer.from(`murage-pair:${sessions.environmentId}:${code}:fixture-owner`);
    return { ...sessions.redeem(code, "fixture-owner", sign(null, message, key.privateKey).toString("base64url"), sign(null, message, factor.privateKey).toString("base64url")), factor };
  };
  const a = pair(), b = pair(), store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Stream fixture" }), workspace = join(DATA_DIR, "workspaces", bot.id); mkdirSync(workspace, { recursive: true });
  const mediaDb = new DatabaseSync(join(root, "media.db")); databases.push(mediaDb); initializeArtifacts(mediaDb);
  const file = join(workspace, "long.wav"), size = 128 * 1024 * 1024, header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(size - 8, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(8000, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write("data", 36); header.writeUInt32LE(size - 44, 40);
  const fd = openSync(file, "w"); try { writeSync(fd, header); ftruncateSync(fd, size); } finally { closeSync(fd); }
  const deps = { dataDir: DATA_DIR, database: () => mediaDb, store, artifactScopes: () => [{ botId: bot.id, botName: bot.name, threadId: bot.threadId, workspaceRoot: workspace }] };
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => "fixture-bootstrap-key-32-characters" });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    if (await auth(req, res, url)) return;
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" }); const writer = new SseWriter(res, () => {}); writer.send("data: fixture\n\n"); return;
    }
    if (url.pathname.startsWith("/api/media/")) {
      return sendDelegated(res, req.method!, await mediaAssetsRoute({ method: req.method!, path: url.pathname, url, headers: req.headers,
        desktop: requestSurface(req.headers) === "desktop", readBody: async () => cloudBodies.get(req)?.body }, deps));
    }
    res.writeHead(404); res.end();
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ref = { source: "workspace", scope: { botId: bot.id, threadId: bot.threadId }, relativePath: "long.wav", revision: mediaWorkspaceRevision(realpathSync.native(workspace), "long.wav", lstatSync(file)) };
  return { a, b, sessions, base, ref };
}
function headers(device?: Device) { return { host: "home.example", origin, ...(device ? { authorization: `Bearer ${device.accessToken}` } : {}) }; }
async function api(f: Awaited<ReturnType<typeof fixture>>, method: string, path: string, device?: Device, body?: unknown, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(f.base + path, { method, headers: { ...headers(device), "content-type": "application/json", ...(encoded ? { "content-length": String(encoded.length) } : {}), ...extra }, agent: false }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : null }));
    }); req.on("error", reject); req.end(encoded);
  });
}
async function openStream(f: Awaited<ReturnType<typeof fixture>>, path: string, device?: Device, cookie = false) {
  return new Promise<{ res: IncomingMessage; closed: boolean }>((resolve, reject) => {
    const h = cookie && device ? { host: "home.example", origin, cookie: `__Host-murage=${device.accessToken}` } : headers(device);
    const req = request(f.base + path, { headers: h, agent: false }, res => {
      const state = { res, closed: false }; res.on("error", () => {}); res.once("close", () => { state.closed = true; });
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Stream fixture returned ${res.statusCode}`)); return; }
      res.once("data", () => { res.pause(); resolve(state); });
    }); clients.push(req); req.on("error", reject); req.end();
  });
}
async function resolvedMedia(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await api(f, "POST", "/api/media/resolve", f.a, { ref: f.ref }); expect(response.status).toBe(200); expect(response.body.asset.availability).toBe("ready");
  const url = response.body.url as string, cap = new URL(url, origin).searchParams.get("cap")!, checked = verifyMediaCapability(cap, response.body.asset.assetId ?? response.body.asset.id);
  return { url, cap, checked };
}
async function revoke(f: Awaited<ReturnType<typeof fixture>>, path: string, operator: Device) {
  const purpose = stepPurpose("DELETE", path, {}), challenge = await api(f, "POST", "/api/cloud/challenge", operator, { deviceId: operator.deviceId, purpose }), at = Date.now();
  expect(challenge.status).toBe(200);
  const signature = sign(null, Buffer.from(`murage:${f.sessions.environmentId}:${operator.deviceId}:${purpose}:${challenge.body.challenge}:${at}`), operator.factor.privateKey).toString("base64url");
  return api(f, "DELETE", path, operator, {}, { "x-murage-step-up": Buffer.from(JSON.stringify({ challenge: challenge.body.challenge, at, signature })).toString("base64url") });
}
it.each(["device", "account"])("%s revocation cuts SSE and cap-only in-flight media and acknowledges the control request", async kind => {
  const f = await fixture(), sseA = await openStream(f, "/api/events", f.a), sseB = await openStream(f, "/api/events", f.b), media = await resolvedMedia(f);
  expect(media.checked.ok).toBe(true);
  const download = await openStream(f, media.url), alternate = await openStream(f, media.url, f.b, true);
  expect(download.res.complete).toBe(false); expect(mediaActiveStreamCount()).toBe(2);
  expect((await api(f, "GET", `/api/events?cap=${media.cap}`)).status).toBe(403);
  expect((await revoke(f, kind === "device" ? `/api/cloud/devices/${f.a.deviceId}` : "/api/cloud/account", f.b)).status).toBe(200);
  sseA.res.resume(); download.res.resume(); alternate.res.resume(); if (kind === "account") sseB.res.resume();
  await expect.poll(() => sseA.closed && download.closed && alternate.closed, { timeout: 5000 }).toBe(true);
  await expect.poll(mediaActiveStreamCount, { timeout: 5000 }).toBe(0);
  expect((await api(f, "GET", media.url, kind === "device" ? f.b : undefined)).status).toBe(403);
  if (kind === "device") expect(sseB.closed).toBe(false); else await expect.poll(() => sseB.closed).toBe(true);
}, 20_000);
it("access deletion is rechecked at thirty seconds for both SSE and cap-only media", async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const sse = await openStream(f, "/api/events", f.a), media = await resolvedMedia(f), download = await openStream(f, media.url);
  expect(mediaActiveStreamCount()).toBe(1); f.sessions.db.prepare("DELETE FROM cloud_access WHERE device=?").run(f.a.deviceId);
  expect(sse.closed).toBe(false); await vi.advanceTimersByTimeAsync(30_000);
  sse.res.resume(); download.res.resume();
  await expect.poll(() => sse.closed && download.closed).toBe(true); await expect.poll(mediaActiveStreamCount).toBe(0);
}, 20_000);
it("a cap issuer stays distinct from the authenticated requester and desktop claims stay unchanged", async () => {
  const f = await fixture(), media = await resolvedMedia(f), download = await openStream(f, media.url, f.b);
  expect((await revoke(f, `/api/cloud/devices/${f.b.deviceId}`, f.a)).status).toBe(200);
  download.res.resume();
  await expect.poll(() => download.closed).toBe(true);
  expect((await api(f, "HEAD", media.url)).status).toBe(200);
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const issued = issueMediaCapability("ma1_" + "a".repeat(32), "fixture-revision", Date.now(), { deviceId: f.a.deviceId, accessHash: createHash("sha256").update(f.a.accessToken).digest("hex") });
  const claims = JSON.parse(Buffer.from(issued.token.split(".")[1]!, "base64url").toString());
  expect(Object.keys(claims).sort()).toEqual(["assetId", "exp", "revision", "surface", "v"]);
}, 20_000);
