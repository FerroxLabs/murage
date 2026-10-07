import { describe, expect, it, vi } from "vitest";
import { AUTH_KEY_REPLY, AUTH_KEY_REQUEST, AuthKeyUnavailable, checkedProvider, parentPortKeyProvider, validAuthKey, type KeyPort } from "./auth-key.ts";

const KEY = "ab".repeat(32);
function port() {
  let listener: ((event: { data?: unknown }) => void) | undefined;
  const posted: object[] = [];
  const p: KeyPort = { on: (_e, l) => { listener = l; }, postMessage: m => { posted.push(m); } };
  return { port: p, posted, reply: (data: unknown) => listener!({ data }) };
}

it("accepts exactly 64 lowercase hex characters", () => {
  expect(validAuthKey(KEY)).toBe(true);
  for (const bad of ["", "ab", KEY.toUpperCase(), KEY + "0", 12, null, undefined]) expect(validAuthKey(bad)).toBe(false);
});
describe("checkedProvider", () => {
  it("passes a good key and turns a throw or a malformed key into credential-store", async () => {
    expect(await checkedProvider({ get: async () => KEY })()).toBe(KEY);
    await expect(checkedProvider({ get: async () => "short" })()).rejects.toMatchObject({ reason: "credential-store" });
    await expect(checkedProvider({ get: async () => { throw new Error("boom"); } })()).rejects.toBeInstanceOf(AuthKeyUnavailable);
  });
  it("keeps the reason of an AuthKeyUnavailable", async () => {
    await expect(checkedProvider({ get: async () => { throw new AuthKeyUnavailable("key-missing"); } })()).rejects.toMatchObject({ reason: "key-missing" });
  });
});
describe("parentPortKeyProvider", () => {
  it("posts one request and resolves with the reply", async () => {
    const h = port(); const p = parentPortKeyProvider(h.port);
    const a = p.get(), b = p.get();
    expect(h.posted).toEqual([{ type: AUTH_KEY_REQUEST }]);
    h.reply({ type: "murage:other", key: "x" });
    h.reply({ type: AUTH_KEY_REPLY, key: KEY });
    expect(await a).toBe(KEY); expect(await b).toBe(KEY);
  });
  it("fails closed on a null, malformed or late reply and asks again afterwards", async () => {
    const h = port(); const p = parentPortKeyProvider(h.port, { timeoutMs: 20 });
    const first = p.get(); h.reply({ type: AUTH_KEY_REPLY, key: null });
    await expect(first).rejects.toMatchObject({ reason: "credential-store" });
    const second = p.get(); h.reply({ type: AUTH_KEY_REPLY, key: "nope" });
    await expect(second).rejects.toBeInstanceOf(AuthKeyUnavailable);
    await expect(p.get()).rejects.toMatchObject({ reason: "credential-store" });
    expect(h.posted).toHaveLength(3);
  });
  it("never invents a key when nothing answers", async () => {
    vi.useFakeTimers();
    try {
      const h = port(); const p = parentPortKeyProvider(h.port, { timeoutMs: 1000 });
      const pending = p.get().catch(e => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toMatchObject({ reason: "credential-store" });
    } finally { vi.useRealTimers(); }
  });
});
