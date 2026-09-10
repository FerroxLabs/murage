import { afterEach, expect, it, vi } from "vitest";
import { FluxConnectionTransaction } from "./flux-connection-transaction.ts";
import { fluxCredentialStatus, type FluxCredentialState } from "../electron/flux-credential-policy.mjs";
afterEach(() => vi.useRealTimers());
function fixture() {
  let state: FluxCredentialState = { bank: "[]", workspaceKey: "sk-flux-FAKE_OLD" }, held = false;
  const transaction = new FluxConnectionTransaction({ read: () => state, assertIdle: () => { if (held) throw Error("busy"); }, fence: value => { held = value; }, apply: async next => { state = structuredClone(next); } });
  const input = () => ({ action: "replace", revision: fluxCredentialStatus(state).revision, key: "sk-flux-FAKE_NEXT" });
  return { transaction, input, state: () => state, held: () => held, alter: () => { state = { ...state, workspaceKey: "sk-flux-FAKE_OTHER" }; } };
}
it("reserves, commits and conditionally restores exactly the owned runtime", async () => {
  const f = fixture(), original = f.state(), { lease } = f.transaction.begin(f.input());
  expect(f.held()).toBe(true); await f.transaction.commit(lease, true); expect(f.state().workspaceKey).toContain("NEXT");
  await f.transaction.rollback(lease, true); expect(f.state()).toEqual(original); f.transaction.finish(lease); expect(f.held()).toBe(false);
});
it("uncommitted reservations expire safely and stale owners cannot commit", async () => {
  vi.useFakeTimers(); const f = fixture(), { lease } = f.transaction.begin(f.input());
  vi.advanceTimersByTime(30_001); expect(f.held()).toBe(false);
  await expect(f.transaction.commit(lease, true)).rejects.toThrow("expired");
});
it("committed reservation never expires and foreign runtime changes cannot be overwritten", async () => {
  vi.useFakeTimers(); const f = fixture(), { lease } = f.transaction.begin(f.input());
  await f.transaction.commit(lease, true); vi.advanceTimersByTime(60_000); expect(f.held()).toBe(true);
  f.alter(); await expect(f.transaction.rollback(lease, true)).rejects.toThrow("changed after save"); expect(f.held()).toBe(true);
  f.transaction.finish(lease);
});
it("wrong lease cannot release another credential transaction", () => {
  const f = fixture(), { lease } = f.transaction.begin(f.input());
  expect(() => f.transaction.finish("other")).toThrow("expired"); expect(f.held()).toBe(true); f.transaction.finish(lease);
});
