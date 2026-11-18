// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { SealedSecretStore } from "./secrets.ts";
import { applyOwnerDelta, emailBootFields, readRecord, writeOwner } from "./email-keystore.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { createFluxDeviceCodeClient } from "./flux-device-code-client.ts";
import { FLUX_DEVICE_BASE } from "../flux-routing.ts";
import { isGenericCredentialPatch, serverCredentialProjection } from "./credential-projection.ts";
// Field and bound are asserted independently from the implementation.
const SLOT = "botEmailPendingOwnerRevokes", BOUND = 4;
const A = { token: "owner-A-fixture", keyId: "key_A" }, B = { token: "owner-B-fixture", keyId: "key_B" };
const pending = (store: SealedSecretStore): string[] => JSON.parse(store.readBack()[SLOT] || "[]");
function home() {
  const root = mkdtempSync(join(tmpdir(), "owner-revoke-durable-"));
  let store = new SealedSecretStore(root, "fixture", Buffer.alloc(32, 7));
  emailBootFields(store, true); writeOwner(store, A, 0);
  return { root, get store() { return store; }, restart(syncDir?: () => "synced") { store.close(); store = new SealedSecretStore(root, "fixture", Buffer.alloc(32, 7), { syncDir }); }, done() { store.close(); removeTempDirSync(root); } };
}
describe("M2 owner revoke survives a supervisor restart", () => {
  it("replacement and pending revoke share one sealed write, 503 retains it, restart retries and 204 drains it", async () => {
    const h = home(); let port: ReturnType<typeof createSupervisorPort> | undefined;
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    const device = createFluxDeviceCodeClient({ baseUrl: FLUX_DEVICE_BASE, fetch: fetcher });
    const writes: Array<Record<string, string>> = [];
    const store = { getAll: () => h.store.getAll(), readBack: () => h.store.readBack(), patch: (p: Record<string, string>) => h.store.patch(p), patchDurable: (p: Record<string, string>) => { writes.push(p); return h.store.patchDurable(p); } };
    const send = vi.fn();
    try {
      port = createSupervisorPort({ store, emailStore: true, send, emailDeviceCode: { ...device, start: async () => ({ deviceCode: "dc", userCode: "U", verificationUrl: `${FLUX_DEVICE_BASE}/device`, intervalMs: 1, expiresInMs: 60_000 }), poll: async () => ({ state: "ok", scoped: true, owner: B }) }, emailSleep: async () => {}, emailBackoffSleep: () => new Promise(() => {}) });
      await port.handle({ type: "murage:email-owner-signin-start", requestId: "replace", actor: { environmentId: "e", deviceId: "d" }, gen: 0 });
      await vi.waitFor(() => expect(send.mock.calls.some(([m]) => (m as any).state === "done")).toBe(true));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      expect(readRecord(h.store.readBack())?.owner).toEqual(B);
      expect(pending(h.store)).toEqual([A.token]);
      const replacement = writes.find(p => p.botEmailSecrets && JSON.parse(p.botEmailSecrets).owner?.keyId === B.keyId)!;
      expect(JSON.parse(replacement[SLOT]!)).toEqual([A.token]);
      expect(readFileSync(join(h.root, "credentials.enc"), "utf8")).not.toContain(A.token);
      port.dispose(); h.restart();
      const retry = vi.fn(async () => new Response(null, { status: 204 }));
      port = createSupervisorPort({ store: h.store, emailStore: true, send, emailDeviceCode: createFluxDeviceCodeClient({ baseUrl: FLUX_DEVICE_BASE, fetch: retry }) });
      await port.configure();
      await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(pending(h.store)).toEqual([]));
      expect((retry.mock.calls[0] as unknown[])[1]).toMatchObject({ headers: { authorization: `Bearer ${A.token}` } });
    } finally { port?.dispose(); h.done(); }
  });
  it("defers the sealed revoke drain while an owner write is unconfirmed", async () => {
    const h = home();
    const original = h.store.patchDurable.bind(h.store);
    vi.spyOn(h.store, "patchDurable").mockImplementation(patch => {
      const result = original(patch);
      if (patch.botEmailSecrets && JSON.parse(patch.botEmailSecrets).owner?.keyId === B.keyId) throw new Error("write not confirmed");
      return result;
    });
    const revoke = vi.fn(async () => "revoked" as const), send = vi.fn();
    const port = createSupervisorPort({ store: h.store, emailStore: true, send, emailDeviceCode: {
      start: async () => ({ deviceCode: "dc", userCode: "U", verificationUrl: `${FLUX_DEVICE_BASE}/device`, intervalMs: 1, expiresInMs: 60_000 }),
      poll: async () => ({ state: "ok", scoped: true, owner: B }), revoke,
    }, emailSleep: async () => {}, emailBackoffSleep: () => new Promise(() => {}) });
    try {
      await port.handle({ type: "murage:email-owner-signin-start", requestId: "uncertain", actor: { environmentId: "e", deviceId: "d" }, gen: 0 });
      await vi.waitFor(() => expect(send.mock.calls.some(([m]) => (m as any).state === "saving")).toBe(true));
      await port.configure();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(revoke).not.toHaveBeenCalled();
      expect(pending(h.store)).toEqual([A.token]);
    } finally { port.dispose(); h.done(); }
  });
  it("a restarted port confirms the sealed queue before sending a revoke", async () => {
    const h = home(); let failSync = true;
    applyOwnerDelta(h.store, { gen: 0, ownerRev: 2, owner: B });
    h.restart(() => { if (failSync) throw new Error("directory sync unavailable"); return "synced"; });
    const revoke = vi.fn(async () => new Response(null, { status: 204 }));
    const port = createSupervisorPort({ store: h.store, emailStore: true, send: () => {}, emailDeviceCode: createFluxDeviceCodeClient({ baseUrl: FLUX_DEVICE_BASE, fetch: revoke }) });
    try {
      await port.configure();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(revoke).not.toHaveBeenCalled();
      expect(pending(h.store)).toEqual([A.token]);
      failSync = false; await port.configure();
      await vi.waitFor(() => expect(pending(h.store)).toEqual([]));
      expect(revoke).toHaveBeenCalledTimes(1);
    } finally { port.dispose(); h.done(); }
  });
  it("a document save carrying an already revoked unlink does not queue that key again", async () => {
    const h = home(); let failClear = true;
    const patch = h.store.patchDurable.bind(h.store);
    vi.spyOn(h.store, "patchDurable").mockImplementation(value => {
      if (failClear && value.botEmailSecrets && !JSON.parse(value.botEmailSecrets).owner) throw new Error("clear not confirmed");
      return patch(value);
    });
    const send = vi.fn(), revoke = vi.fn(async () => "revoked" as const);
    const port = createSupervisorPort({ store: h.store, emailStore: true, send, emailDeviceCode: { start: async () => ({ state: "unavailable" }), poll: async () => ({ state: "unavailable" }), revoke }, emailBackoffSleep: () => new Promise(() => {}) });
    try {
      await port.handle({ type: "murage:email-owner-unlink", requestId: "unlink-carry" });
      await vi.waitFor(() => expect(send.mock.calls.some(([m]) => (m as any).type === "murage:email-owner-unlink-result" && (m as any).state === "saving")).toBe(true));
      expect(revoke).toHaveBeenCalledTimes(1);
      failClear = false;
      await port.handle({ type: "murage:email-secrets-save", rev: 1, epoch: 1, gen: 0, doc: readRecord(h.store.getAll())!.doc });
      await vi.waitFor(() => expect(send.mock.calls.some(([m]) => (m as any).type === "murage:email-owner-unlink-result" && (m as any).state === "unlinked")).toBe(true));
      expect(pending(h.store)).toEqual([]);
      await port.configure();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(revoke).toHaveBeenCalledTimes(1);
    } finally { port.dispose(); h.done(); }
  });
  it("keeps the oldest four and refuses a replacement before exceeding the bound", () => {
    const h = home();
    try {
      for (let i = 0; i < BOUND; i++) applyOwnerDelta(h.store, { gen: 0, ownerRev: i + 2, owner: { token: `owner-${i}`, keyId: `key_${i}` } });
      const before = readRecord(h.store.readBack());
      expect(pending(h.store)).toHaveLength(BOUND);
      expect(() => applyOwnerDelta(h.store, { gen: 0, ownerRev: 7, owner: B })).toThrow();
      expect(readRecord(h.store.readBack())).toEqual(before);
      expect(pending(h.store)).toEqual([A.token, "owner-0", "owner-1", "owner-2"]);
      expect(serverCredentialProjection(h.store.getAll())).not.toHaveProperty(SLOT);
      expect(isGenericCredentialPatch({ [SLOT]: "[]" })).toBe(false);
    } finally { h.done(); }
  });
});
