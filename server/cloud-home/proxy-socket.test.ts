// SPDX-License-Identifier: AGPL-3.0-or-later
import { once } from "node:events";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudSessions } from "../cloud-sessions.ts";
import { cloudClientIp, createCloudRequestAuth } from "../cloud-request-auth.ts";
import { listenCloudProxy } from "./proxy-socket.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

let root: string, upstream: Server, proxy: Server | null, sessions: CloudSessions | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "murage-proxy-")); vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
afterEach(async () => {
  if (upstream?.listening) { const closed = once(upstream, "close"); upstream.close(); upstream.closeAllConnections(); await closed; }
  if (proxy?.listening) { const closed = once(proxy, "close"); proxy.close(); proxy.closeAllConnections(); await closed; }
  sessions?.db.close(); sessions = undefined; removeTempDirSync(root); vi.unstubAllEnvs();
});
async function tcp() { upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); return (upstream.address() as AddressInfo).port; }
async function get(port: number, path: string, headers: Record<string, string>, socketPath?: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ ...(socketPath ? { socketPath } : { host: "127.0.0.1", port }), path, headers, agent: false }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on("error", reject); req.end();
  });
}
it("trusts forwarded IP only over its configured Unix listener and keeps bare TCP service", async () => {
  const socketPath = join(root, "proxy.sock"), trustedProxy = `unix:${socketPath}`;
  sessions = new CloudSessions(new DatabaseSync(join(root, "sessions.db")));
  const auth = createCloudRequestAuth({ sessions, publicOrigin: "https://home.example", trustedProxy, bootstrapSecret: () => "fixture-bootstrap-key-32-characters" });
  upstream = createServer(async (req, res) => {
    if (await auth(req, res, new URL(req.url!, "https://home.example"))) return;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ip: cloudClientIp(req, trustedProxy) }));
  });
  const port = await tcp(); proxy = listenCloudProxy(upstream, socketPath)!; await once(proxy, "listening");
  expect(statSync(socketPath).mode & 0o777).toBe(0o660);
  expect(await get(port, "/api/health", { host: "local.invalid", "x-forwarded-host": "home.example", "x-forwarded-for": "203.0.113.9" }, socketPath)).toMatchObject({ status: 200, body: { ip: "203.0.113.9" } });
  expect(await get(port, "/api/health", { host: "home.example", "x-forwarded-for": "203.0.113.9" })).toMatchObject({ status: 200, body: { ip: "127.0.0.1" } });
  expect((await get(port, "/api/health", { host: "local.invalid", "x-forwarded-host": "home.example" })).status).toBe(403);
  expect((await get(port, "/api/health", { host: `127.0.0.1:${port}` })).status).toBe(200);
  expect((await get(port, "/api/decisions", { host: `127.0.0.1:${port}`, "x-murage-surface": "desktop", "x-murage-surface-secret": "forged" })).status).toBe(403);
});
it("forwards Unix upgrades to the existing dispatcher's upgrade handler", async () => {
  upstream = createServer(); const upgraded = vi.fn();
  upstream.on("upgrade", (req, socket) => { upgraded(req.url); socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n"); });
  await tcp(); const path = join(root, "upgrade.sock"); proxy = listenCloudProxy(upstream, path)!; await once(proxy, "listening");
  const socket = createConnection(path); await once(socket, "connect");
  const reply = new Promise<string>((resolve, reject) => { let bytes = ""; socket.on("data", chunk => { bytes += chunk; }); socket.on("end", () => resolve(bytes)); socket.on("error", reject); });
  socket.write("GET /upgrade HTTP/1.1\r\nHost: home.example\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n");
  expect(await reply).toContain("101 Switching Protocols"); expect(upgraded).toHaveBeenCalledWith("/upgrade"); socket.destroy();
});
it("is inert without the home role and refuses to replace a non-socket path", async () => {
  upstream = createServer(); await tcp(); const path = join(root, "not-a-socket"); writeFileSync(path, "fixture");
  vi.stubEnv("MURAGE_CLOUD_ROLE", ""); expect(listenCloudProxy(upstream, path)).toBeNull();
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); expect(() => listenCloudProxy(upstream, path)).toThrow("proxy address");
});
