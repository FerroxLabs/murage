// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { setCloudIdentity } from "../cloud-request-identity.ts";
import { routePolicy } from "../route-policy.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { SealedSecretStore } from "./secrets.ts";
import { emailBootFields, readRecord, writeOwner } from "./email-keystore.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { createCloudEmailSignin } from "./email-signin-api.ts";
import { createFluxDeviceCodeClient } from "./flux-device-code-client.ts";
import { FLUX_DEVICE_BASE } from "../flux-routing.ts";
const BASE = "/api/email/owner-signin";
const owner = { token: "fixture-owner", keyId: "key_owner" };
function fixture(connected = true) {
  const root = mkdtempSync(join(tmpdir(), "email-signout-"));
  const store = new SealedSecretStore(root, "fixture", Buffer.alloc(32, 7));
  emailBootFields(store, true); if (connected) writeOwner(store, owner, 0);
  let release: (() => void) | undefined;
  const revoked = vi.fn(async () => {
    expect(readRecord(store.readBack())?.owner).toEqual(owner);
    await new Promise<void>(resolve => { release = resolve; });
    return new Response(null, { status: 204 });
  });
  let api: ReturnType<typeof createCloudEmailSignin>;
  const port = createSupervisorPort({ store, emailStore: true, send: message => api.receive(message), emailDeviceCode: createFluxDeviceCodeClient({ baseUrl: FLUX_DEVICE_BASE, fetch: revoked }) });
  const send = vi.fn((message: object) => { void port.handle(message); return true; });
  api = createCloudEmailSignin({ available: () => false, ttlMs: () => 0, connected: () => !!readRecord(store.getAll())?.owner, gen: () => 0, environmentId: "fixture", activeDevice: () => true, send, readBody: async () => ({}) });
  const call = async (path: string, method = "POST", scope: "owner-desktop" | "browser" = "owner-desktop") => {
    const req = { method, headers: {} } as IncomingMessage;
    setCloudIdentity(req.headers, { id: "owner", account: "account", scope, revoked: 0, publicKey: "fixture", assertionKey: "fixture", factor: false });
    let status = 0, body: any;
    const res = { writeHead(code: number) { status = code; }, end(value: string) { body = JSON.parse(value); } } as ServerResponse;
    expect(await api.handle(req, res, new URL(BASE + path, "https://home.test"))).toBe(true);
    return { status, body };
  };
  return { call, send, revoked, release: () => release!(), store, done: () => { port.dispose(); store.close(); removeTempDirSync(root); } };
}
describe("M1 owner email sign-out", () => {
  it("revoke precedes clear, duplicate posts send one unlink, and the attempt reaches unlinked", async () => {
    const f = fixture();
    try {
      const first = await f.call("/sign-out"); expect(first.status).toBe(202);
      const second = await f.call("/sign-out"); expect(second.status).toBe(409);
      expect(f.send.mock.calls.filter(([m]) => (m as { type: string }).type === "murage:email-owner-unlink")).toHaveLength(1);
      await vi.waitFor(() => expect(f.revoked).toHaveBeenCalledTimes(1));
      expect(readRecord(f.store.readBack())?.owner).toEqual(owner);
      f.release();
      await vi.waitFor(async () => expect((await f.call(`/attempts/${first.body.requestId}`, "GET")).body.state).toBe("unlinked"));
      expect(readRecord(f.store.readBack())?.owner).toBeUndefined();
      expect(f.revoked).toHaveBeenCalledTimes(1);
      expect(routePolicy("POST", `${BASE}/sign-out`)).toMatchObject({ cloudWrite: "step-up" });
    } finally { f.done(); }
  });
  it("a disconnected home and a non-owner send no unlink", async () => {
    const f = fixture(false);
    try {
      expect(await f.call("/sign-out")).toEqual({ status: 409, body: { error: "Email is not connected." } });
      expect((await f.call("/sign-out", "POST", "browser")).status).toBe(403);
      expect(f.send).not.toHaveBeenCalled(); expect(f.revoked).not.toHaveBeenCalled();
    } finally { f.done(); }
  });
});
