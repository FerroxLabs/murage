// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCloudIdentity } from "../cloud-request-identity.ts";
import { SealedSecretStore } from "./secrets.ts";
import { createHomeSupervisorSession } from "./supervisor-session.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { routePolicy } from "../route-policy.ts";

const BASE = "/api/email/owner-signin";
const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const caps = { device_authorization_grant: true, bot_keys: true, client_id: "murage-cloud", scope: "email:owner", grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_authorization_endpoint: "/api/device/code", token_endpoint: "/api/device/token" };
afterEach(() => vi.useRealTimers());
function request(method: string, scope: Parameters<typeof setCloudIdentity>[1]["scope"] = "owner-desktop", deviceId = "fixture-owner") {
  const req = { method, headers: {} } as IncomingMessage;
  setCloudIdentity(req.headers, { id: deviceId, account: "fixture-account", scope, revoked: 0, publicKey: "fixture-key", assertionKey: "fixture-assertion", factor: false });
  return req;
}
async function call(api: { handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> }, path: string, req = request("GET")) {
  let status = 0, body: any;
  const res = { writeHead(code: number) { status = code; }, end(value: string) { body = JSON.parse(value); } } as ServerResponse;
  expect(await api.handle(req, res, new URL(path, "https://home.test"))).toBe(true);
  return { status, body };
}

describe("Cloud email HTTP to supervisor fixture", () => {
  it("uses the authenticated email route, sends exactly one start, and returns code then completion without the owner token", async () => {
    expect(source).toContain("cloudEmailSignin.handle(req,res,url)");
    const { createCloudEmailSignin } = await import("./email-signin-api.ts");
    const { createCloudEmailAvailability } = await import("./email-signin-availability.ts");
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "email-signin-api-")), store = new SealedSecretStore(root, "fixture", Buffer.alloc(32, 7));
    const report = createCloudEmailAvailability(), messages: Array<Record<string, unknown>> = [], sent: Array<Record<string, unknown>> = [];
    let api: ReturnType<typeof createCloudEmailSignin> | undefined;
    const child = Object.assign(new EventEmitter(), { connected: true, send: (message: Record<string, unknown>) => { messages.push(message); report.receive(message); api?.receive(message); } });
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("capabilities")) return Response.json(caps);
      if (path.endsWith("code")) return Response.json({ device_code: "private-device", user_code: "CODE-123", verification_uri: "/device", expires_in: 60, interval: 5 });
      if (path.endsWith("token")) return Response.json({ api_key: "owner-fixture-token", key_id: "key_owner_fixture", account_id: "fixture-account", scopes: ["email:owner"] });
      throw new Error(`Unexpected request ${path}`);
    });
    const session = createHomeSupervisorSession({ store, bootstrapSecret: "fixture", emailStore: true, fluxBaseUrl: "https://fluxrouter.ai/v1", fetch: fetcher });
    try {
      const gen = JSON.parse(session.envelope()).emailSecrets.gen;
      api = createCloudEmailSignin({ available: report.available, ttlMs: report.remainingMs, environmentId: "fixture-home", gen: () => gen, activeDevice: () => true, readBody: async () => ({}), send: message => { sent.push(message as Record<string, unknown>); child.emit("message", message); return true; } });
      expect((await call(api, BASE)).body).toEqual({ available: false, ttlMs: 0 });
      session.attachChild(child as unknown as ChildProcess); await vi.advanceTimersByTimeAsync(0);
      expect((await call(api, BASE)).body).toEqual({ available: true, ttlMs: 30_000 });
      const started = await call(api, `${BASE}/start`, request("POST")); expect(started.status).toBe(202);
      await vi.advanceTimersByTimeAsync(0);
      const path = `${BASE}/attempts/${started.body.requestId}`;
      const code = await call(api, path); expect(code.body).toMatchObject({ state: "code", userCode: "CODE-123", verificationUrl: "https://fluxrouter.ai/device" });
      expect((await call(api, path, request("GET", "owner-desktop", "another-owner"))).status).toBe(404);
      expect((await call(api, `${BASE}/start`, request("POST"))).status).toBe(409);
      expect(sent.filter(m => m.type === "murage:email-owner-signin-start")).toHaveLength(1);
      expect(sent[0]).toMatchObject({ actor: { environmentId: "fixture-home", deviceId: "fixture-owner" }, gen });
      await vi.advanceTimersByTimeAsync(5_000);
      const done = await call(api, path); expect(done.body.state).toBe("done");
      expect(JSON.stringify([started.body, code.body, done.body])).not.toContain("owner-fixture-token");
      expect(messages.some(message => message.type === "murage:cloud-email-owner")).toBe(true);
      expect(routePolicy("POST", `${BASE}/start`)).toMatchObject({ cloudWrite: "step-up" });
    } finally { session.close(); report.dispose(); removeTempDirSync(root); }
  });
  it("refuses unavailable starts, chat devices, ended sessions, and expired attempts", async () => {
    expect(source).toContain("cloudEmailSignin?.invalidate(deviceId)");
    const { createCloudEmailSignin } = await import("./email-signin-api.ts");
    let available = false, active = true, clock = 1; const send = vi.fn(() => true);
    const api = createCloudEmailSignin({ available: () => available, ttlMs: () => 30_000, activeDevice: () => active, gen: () => 2, environmentId: "fixture", send, readBody: async () => ({}), now: () => clock });
    expect((await call(api, `${BASE}/start`, request("POST"))).status).toBe(404); expect(send).not.toHaveBeenCalled();
    available = true;
    expect((await call(api, `${BASE}/start`, request("POST", "browser"))).status).toBe(403); expect(send).not.toHaveBeenCalled();
    const started = await call(api, `${BASE}/start`, request("POST")); expect(started.status).toBe(202);
    const path = `${BASE}/attempts/${started.body.requestId}`;
    clock += 600_000; expect((await call(api, path)).status).toBe(404);
    api.invalidate("fixture-owner"); expect(send).toHaveBeenLastCalledWith({ type: "murage:email-owner-session-end", deviceId: "fixture-owner" });
    active = false; expect((await call(api, BASE)).status).toBe(403);
  });
});
