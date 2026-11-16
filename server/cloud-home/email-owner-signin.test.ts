// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { SealedSecretStore } from "./secrets.ts";
import { emailBootFields, readRecord } from "./email-keystore.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { runOwnerSignIn, stubFluxDeviceCodeClient, type FluxDeviceCodeClient } from "./email-owner-signin.ts";

const START = { deviceCode: "dc-1", userCode: "ABCD-1234", verificationUrl: "https://flux.example/device", intervalMs: 5, expiresInMs: 1000 };
const owner = { token: "owner-token-CANARY", keyId: "key_owner" };

describe("Cloud owner sign-in (device code) behind an interface", () => {
  it("the stub makes no network call and answers unavailable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await runOwnerSignIn(stubFluxDeviceCodeClient, { code: () => { throw new Error("no code"); }, token: async () => true })).toBe("unavailable");
    expect(await stubFluxDeviceCodeClient.poll("x")).toEqual({ state: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("shows the code, polls until ok, hands the token over once", async () => {
    const poll = vi.fn<FluxDeviceCodeClient["poll"]>().mockResolvedValueOnce({ state: "pending" }).mockResolvedValueOnce({ state: "ok", owner, scoped: true });
    const code = vi.fn(), token = vi.fn(async () => true);
    expect(await runOwnerSignIn({ start: async () => START, poll, revoke: async () => "revoked" }, { code, token }, { sleep: async () => {} })).toBe("done");
    expect(code).toHaveBeenCalledWith({ userCode: "ABCD-1234", verificationUrl: "https://flux.example/device" });
    expect(token).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledTimes(2);
  });
  it.each(["denied", "expired"] as const)("ends on %s", async state => {
    expect(await runOwnerSignIn({ start: async () => START, poll: async () => ({ state }), revoke: async () => "revoked" }, { code: () => {}, token: async () => true }, { sleep: async () => {} })).toBe(state);
  });
  it("stops at the code's own expiry", async () => {
    const poll = vi.fn(async () => ({ state: "pending" as const }));
    let clock = 0; // expiry is measured on elapsed time, so the fake clock moves with each requested sleep
    expect(await runOwnerSignIn({ start: async () => START, poll, revoke: async () => "revoked" }, { code: () => {}, token: async () => true }, { sleep: async ms => { clock += ms; }, now: () => clock })).toBe("expired");
    expect(poll.mock.calls.length).toBeLessThanOrEqual(START.expiresInMs / START.intervalMs + 1);
  });
  it("the port seals the token in the keystore doc, pushes murage:cloud-email-owner, and the result carries the code but never the token", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "owner-signin-")), "secrets"), send = vi.fn();
    const store = new SealedSecretStore(dir, "fixture-machine", Buffer.alloc(32, 9));
    try {
      emailBootFields(store, true);
      const done = new Promise<void>(resolve => send.mockImplementation((m: { type: string; state?: string }) => { if (m.type === "murage:email-owner-signin-result" && m.state === "done") resolve(); }));
      const port = createSupervisorPort({ store, send, emailStore: true, emailSleep: async () => {}, emailDeviceCode: { start: async () => START, poll: async () => ({ state: "ok", owner, scoped: true }), revoke: async () => "revoked" } });
      await port.handle({ type: "murage:email-owner-signin-start", requestId: "r1", actor: { environmentId: "e1", deviceId: "d1" }, gen: 0 });
      await done;
      const messages = send.mock.calls.map(c => c[0] as Record<string, unknown>);
      expect(messages).toContainEqual({ type: "murage:email-owner-signin-result", requestId: "r1", state: "code", userCode: "ABCD-1234", verificationUrl: "https://flux.example/device" });
      expect(messages).toContainEqual({ type: "murage:cloud-email-owner", gen: 0, ownerRev: 1, owner });
      expect(JSON.stringify(messages.filter(m => m.type === "murage:email-owner-signin-result"))).not.toContain("CANARY");
      expect(readRecord(store.readBack())).toMatchObject({ gen: 0, ownerRev: 1, owner });
    } finally { store.close(); removeTempDirSync(join(dir, "..")); }
  });
  it("with the stub client the port answers unavailable and seals nothing", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "owner-signin-")), "secrets"), send = vi.fn();
    const store = new SealedSecretStore(dir, "fixture-machine", Buffer.alloc(32, 9));
    try {
      emailBootFields(store, true);
      const done = new Promise<void>(resolve => send.mockImplementation((m: { type: string; state?: string }) => { if (m.state === "unavailable") resolve(); }));
      await createSupervisorPort({ store, send, emailStore: true }).handle({ type: "murage:email-owner-signin-start", requestId: "r2", actor: { environmentId: "e1", deviceId: "d1" }, gen: 0 });
      await done;
      expect(readRecord(store.getAll())!.owner).toBeUndefined();
    } finally { store.close(); removeTempDirSync(join(dir, "..")); }
  });
});
