// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { HighLevelCredentialCommit, highLevelBankMatchesMetadata, highLevelCommitAuthorized, highLevelBankDigest, highLevelSecretBankSchema, type HighLevelActiveMetadata, type HighLevelSecretBank, type HighLevelCredentialStage } from "./credential-commit.ts";
const credential = "a".repeat(64), auth = `Bearer ${credential}`;
const connection = { connectionId: "conn-1", credentialVersion: 1, grantId: "grant-1", enrollmentId: "home-1", runtimeCapability: "runtime-".repeat(8), grantCapability: "grant-".repeat(8) };
const bank: HighLevelSecretBank = { schema: 1, revision: 1, locatorKey: "K".repeat(43), connection };
const stage: HighLevelCredentialStage = { flowId: "flow-1", versionId: "version-1", expectedRevision: 0, expectedEpoch: 0, connection, metadata: { connectionId: "conn-1", credentialVersion: 1, grantId: "grant-1", locationId: "loc-1", connectionEpoch: 1, scopes: ["contacts.write"], provenance: "oauth-token-response" } };
function fixture(recovery = false) {
  let metadata: HighLevelActiveMetadata | null = null, activations = 0;
  let now = 100;
  const bridge = new HighLevelCredentialCommit({ bootstrap: { schema: 1, commitCredential: credential, bank: null }, hasRecoveryState: () => recovery, readMetadata: () => metadata, readConnectionEpoch: () => metadata?.connectionEpoch ?? 0, activateMetadata: async (next, epoch) => { expect(epoch).toBe(metadata?.connectionEpoch ?? 0); metadata = next; activations++; }, now: () => now });
  return { bridge, metadata: () => metadata, activations: () => activations, advance: () => { now += 600_001; } };
}
describe("G6 main-only credential commit", () => {
  it("refuses ordinary bearer/empty launch credentials", () => {
    expect(highLevelCommitAuthorized("Bearer desktop", credential)).toBe(false);
    expect(highLevelCommitAuthorized("Bearer ", "")).toBe(false);
    expect(highLevelCommitAuthorized(auth, credential)).toBe(true);
    const f = fixture(); f.bridge.stage(stage);
    expect(() => f.bridge.prepare("Bearer desktop", stage)).toThrow();
    expect(f.activations()).toBe(0);
  });
  it("requires exact prepared bank before activation and restores only matching metadata", async () => {
    const f = fixture(), intent = f.bridge.stage(stage), proposal = f.bridge.prepare(auth, intent);
    expect(f.activations()).toBe(0);
    await expect(f.bridge.commit(auth, { commitId: proposal.commitId, bank: { ...bank, revision: 2 } })).rejects.toThrow();
    await f.bridge.commit(auth, { commitId: proposal.commitId, bank });
    expect(f.activations()).toBe(1);
    expect(highLevelBankMatchesMetadata(bank, f.metadata())).toBe(true);
    expect(highLevelBankMatchesMetadata({ ...bank, locatorKey: "J".repeat(43) }, f.metadata())).toBe(false);
    expect(highLevelBankMatchesMetadata(bank, { ...f.metadata(), credentialVersion: 2 })).toBe(false);
    const restarted = new HighLevelCredentialCommit({ bootstrap: { schema: 1, commitCredential: credential, bank }, hasRecoveryState: () => true, readMetadata: f.metadata, readConnectionEpoch: () => 1, activateMetadata: async () => {} });
    expect(restarted.activeBank()).toEqual(bank);
  });
  it("never creates a replacement key when recovery exists or metadata has lost its bank", () => {
    const f = fixture(true);
    expect(() => { f.bridge.stage(stage); f.bridge.prepare(auth, { flowId: stage.flowId, versionId: stage.versionId }); }).toThrow();
    expect(f.activations()).toBe(0);
  });
  it("expires staged intent and checks version/epoch without activation", () => {
    const f = fixture(), intent = f.bridge.stage(stage);
    expect(() => f.bridge.prepare(auth, { ...intent, versionId: "other" })).toThrow();
    f.advance(); expect(() => f.bridge.prepare(auth, intent)).toThrow();
  });
  it("pins the strict bank and rejects refresh/access credentials", () => {
    for (const name of ["refreshToken", "refresh_token", "accessToken", "clientSecret"]) {
      expect(highLevelSecretBankSchema.safeParse({ ...bank, [name]: "fixture" }).success).toBe(false);
      expect(highLevelSecretBankSchema.safeParse({ ...bank, connection: { ...connection, [name]: "fixture" } }).success).toBe(false);
    }
    expect(highLevelBankDigest(bank)).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("G6 crash and serialization boundaries", () => {
  it("does not activate a persisted-but-uncommitted bank on restart", () => {
    const f = fixture();
    expect(f.bridge.activeBank()).toBeNull();
    const restarted = new HighLevelCredentialCommit({ bootstrap: { schema: 1, commitCredential: credential, bank }, hasRecoveryState: () => true, readMetadata: () => null, readConnectionEpoch: () => 0, activateMetadata: async () => { throw Error("must not activate"); } });
    expect(restarted.activeBank()).toBeNull();
  });
  it("serializes replacement/disconnect against activation and refuses an uncertain activation retry", async () => {
    let finish!: () => void, calls = 0;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const bridge = new HighLevelCredentialCommit({ bootstrap: { schema: 1, commitCredential: credential, bank: null }, hasRecoveryState: () => false, readMetadata: () => null, readConnectionEpoch: () => 0, activateMetadata: async () => { calls++; await held; throw Error("crash after metadata save"); } });
    const intent = bridge.stage(stage), proposal = bridge.prepare(auth, intent);
    const committing = bridge.commit(auth, { commitId: proposal.commitId, bank });
    expect(() => bridge.stage({ ...stage, connection: null, metadata: null })).toThrow();
    finish(); await expect(committing).rejects.toThrow();
    await expect(bridge.commit(auth, { commitId: proposal.commitId, bank })).rejects.toThrow();
    expect(bridge.activeBank()).toBeNull(); expect(calls).toBe(1);
  });
  it("rejects changed locator keys and returns idempotent success only for the same settled bank", async () => {
    const f = fixture(), p = f.bridge.prepare(auth, f.bridge.stage(stage));
    await f.bridge.commit(auth, { commitId: p.commitId, bank });
    await f.bridge.commit(auth, { commitId: p.commitId, bank });
    expect(f.activations()).toBe(1);
    const next = { ...stage, flowId: "flow-2", versionId: "v2", expectedRevision: 1, expectedEpoch: 1, connection: null, metadata: null };
    const q = f.bridge.prepare(auth, f.bridge.stage(next));
    await expect(f.bridge.commit(auth, { commitId: q.commitId, bank: { ...bank, revision: 2, locatorKey: "J".repeat(43), connection: null } })).rejects.toThrow();
    expect(f.activations()).toBe(1);
  });
});

it("G6 private bootstrap registers before requesting and rejects secret-bearing extra fields", async () => {
  const { EventEmitter } = await import("node:events");
  const { requestHighLevelCredentialBootstrap } = await import("./credential-commit.ts");
  for (const extra of [false, true]) {
    const events = new EventEmitter();
    const port = Object.assign(events, { postMessage(message: unknown) {
      expect(events.listenerCount("message")).toBe(1);
      const request = message as { requestId: string };
      events.emit("message", { data: { type: "murage:highlevel-bootstrap", requestId: request.requestId, bootstrap: { schema: 1, commitCredential: credential, bank, ...(extra ? { refreshToken: "fixture-not-a-provider-token" } : {}) } } });
    } });
    const received = requestHighLevelCredentialBootstrap(port);
    if (extra) await expect(received).rejects.toThrow(); else expect((await received).bank).toEqual(bank);
    expect(events.listenerCount("message")).toBe(0);
  }
});
it("G6 a newer connection epoch makes the restored bank unavailable", () => {
  const metadata = { ...stage.metadata!, bankRevision: 1, bankDigest: highLevelBankDigest(bank) };
  const bridge = new HighLevelCredentialCommit({ bootstrap: { schema: 1, commitCredential: credential, bank }, hasRecoveryState: () => true, readMetadata: () => metadata, readConnectionEpoch: () => 2, activateMetadata: async () => {} });
  expect(bridge.activeBank()).toBeNull();
});
