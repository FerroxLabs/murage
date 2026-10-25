import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createSupervisorPort, CLOUD_PRIVATE_MESSAGE_TYPES } from "./supervisor-port.ts";
import { cloudHomeCopy } from "./copy.ts";
import { LEGACY_PENDING_REVOKE_KEY, pendingRevokes } from "./credential-projection.ts";
import { ensureFluxComposioBrokerToken, fluxKeyFingerprint } from "../../electron/flux-composio-token.mjs";

function fixture() {
  let records: Record<string, string> = { fluxApiKey: "fixture-key" };
  const store = { getAll: () => ({ ...records }), patch: (patch: Record<string, string>) => (records = { ...records, ...patch }) };
  const send = vi.fn();
  const remintConnectedApps = vi.fn(async (_credentials: Record<string, string>, _options: { force: boolean }) => ({ fluxApiKey: "fixture-key", fluxComposioBrokerToken: "a".repeat(64), fluxComposioAccountKind: "personal" }));
  return { store, send, remintConnectedApps, port: createSupervisorPort({ store, send, remintConnectedApps }) };
}

describe("cloud supervisor private port", () => {
  it("acknowledges recovery only after sealed signouts and launcher cleanup finish",async()=>{
    const f=fixture(),order:string[]=[];
    let done!:()=>void;const wait=new Promise<void>(resolve=>{done=resolve;});
    const modelSignIn={invalidateOwner:()=>{order.push("invalidate");},dispatch:async(request:{provider:string})=>{order.push(request.provider);}} as unknown as NonNullable<Parameters<typeof createSupervisorPort>[0]["modelSignIn"]>;
    const port=createSupervisorPort({store:f.store,send:f.send,modelSignIn,wipeEngineSignIns:async()=>{order.push("launcher");await wait;}});
    const requestId="11111111-1111-4111-8111-111111111111",pending=port.handle({type:"murage:cloud-recovery-wipe",requestId});
    for(let i=0;i<5;i++)await Promise.resolve();expect(order).toEqual(["invalidate","chatgpt","supergrok","launcher"]);expect(f.send).not.toHaveBeenCalled();
    done();await pending;expect(f.send).toHaveBeenCalledWith({type:"murage:cloud-recovery-result",requestId,ok:true});
    await port.handle({type:"murage:cloud-recovery-wipe",requestId,path:"/arbitrary"});expect(f.send).toHaveBeenLastCalledWith(expect.objectContaining({type:"murage:cloud-refused"}));
  });

  function brokerFixture(stored: boolean) {
    const fluxApiKey = "sk-flux-FAKE_BROKER_FIXTURE_KEY", expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    let credentials: Record<string, string> = { fluxApiKey, ...(stored ? {
      fluxComposioBrokerToken: "a".repeat(64), fluxComposioBrokerTokenExpiresAt: expiresAt,
      fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(fluxApiKey), fluxComposioAccountKind: "personal",
    } : {}) };
    const store = { getAll: () => ({ ...credentials }), patch: (patch: Record<string, string>) => (credentials = { ...credentials, ...patch }) };
    const mint = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(JSON.stringify({ token: "b".repeat(64), expiresAt, accountKind: "personal" }), { status: 200 }));
    const revoke = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(null, { status: 200 }));
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input) === "https://broker.example/v1/tokens" && init?.method === "POST") return mint(input, init);
      if (String(input) === "https://broker.example/v1/tokens/current" && init?.method === "DELETE") return revoke(input, init);
      throw new Error("Unexpected broker fixture operation");
    };
    const send = vi.fn();
    const attach = () => createSupervisorPort({ store, send, remintConnectedApps: (current, { force }) => ensureFluxComposioBrokerToken({
      credentials: current, fluxKey: current.fluxApiKey, fluxBrokerUrl: "https://broker.example", fetchImpl, force,
    }) });
    return { mint, revoke, send, attach };
  }
  it("reuses a stored valid token across ten attaches and delivers managed apps every time", async () => {
    const f = brokerFixture(true);
    for (let i = 0; i < 10; i++) await f.attach().configure();
    expect(f.mint).not.toHaveBeenCalled();
    expect(f.send.mock.calls.filter(call => call[0].type === "murage:managed-composio")).toHaveLength(10);
    expect(f.send.mock.calls.filter(call => call[0].type === "murage:cloud-credentials")).toHaveLength(10);
  });
  it("mints exactly once without a stored token and configures managed apps", async () => {
    const f = brokerFixture(false);
    await f.attach().configure();
    expect(f.mint).toHaveBeenCalledOnce();
    expect(f.send.mock.calls.filter(call => call[0].type === "murage:managed-composio")).toHaveLength(1);
  });
  it("forces exactly one mint only after the server rejects its token", async () => {
    const f = brokerFixture(true), port = f.attach();
    await port.configure();
    expect(f.mint).not.toHaveBeenCalled();
    await port.handle({ type: "murage:flux-composio-token-rejected" });
    expect(f.mint).toHaveBeenCalledOnce();
    expect(f.revoke).toHaveBeenCalledOnce();
    expect(f.revoke).toHaveBeenCalledWith("https://broker.example/v1/tokens/current", expect.objectContaining({ method: "DELETE", headers: { authorization: `Bearer ${"a".repeat(64)}` } }));
    expect(f.mint.mock.invocationCallOrder[0]).toBeLessThan(f.revoke.mock.invocationCallOrder[0]);
  });
  it("bounds concurrent rejection-triggered remints to one attempt per ten minutes", async () => {
    const f = fixture();
    let now = 1_000;
    const port = createSupervisorPort({ ...f, now: () => now });
    await Promise.all(Array.from({ length: 20 }, () => port.handle({ type: "murage:flux-composio-token-rejected" })));
    expect(f.remintConnectedApps).toHaveBeenCalledOnce();
    now += 600_000 - 1;
    await port.remintConnectedApps();
    expect(f.remintConnectedApps).toHaveBeenCalledOnce();
    now += 1;
    await Promise.all([port.remintConnectedApps(), port.remintConnectedApps()]);
    expect(f.remintConnectedApps).toHaveBeenCalledTimes(2);
  });
  it("keeps the rejection backoff after a failed mint without suppressing normal configure", async () => {
    const f = fixture();
    let now = 1_000;
    f.remintConnectedApps.mockRejectedValueOnce(new Error("synthetic broker failure"));
    const port = createSupervisorPort({ ...f, now: () => now });
    await port.handle({ type: "murage:flux-composio-token-rejected" });
    await port.handle({ type: "murage:flux-composio-token-rejected" });
    expect(f.remintConnectedApps).toHaveBeenCalledOnce();
    await port.configure();
    expect(f.remintConnectedApps.mock.calls[1]?.[1]).toEqual({ force: false });
    now += 600_000;
    await port.handle({ type: "murage:flux-composio-token-rejected" });
    expect(f.remintConnectedApps).toHaveBeenCalledTimes(3);
  });
  it("covers every outgoing DesktopPrivateMessage variant, including imported cleanup messages", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const union = index.slice(index.indexOf("type DesktopPrivateMessage ="), index.indexOf("function postDesktopPrivateMessage"));
    const cleanup = readFileSync(new URL("../browser-lifecycle-cleanup.ts", import.meta.url), "utf8");
    const wire = cleanup.slice(cleanup.indexOf("export type BrowserCleanupWireRequest ="), cleanup.indexOf("export interface BrowserCleanupIncomingMessage"));
    const modelWire = readFileSync(new URL("./model-signin-wire.ts", import.meta.url), "utf8").split("const text =")[0];
    const actual = [...new Set([...`${union}\n${wire}\n${modelWire}`.matchAll(/"(murage:[a-z-]+)"/g)].map(match => match[1]))].sort();
    expect([...CLOUD_PRIVATE_MESSAGE_TYPES].sort()).toEqual(actual);
  });
  it.each(["murage:mcp-token-rejected", "murage:mcp-secrets-stale", "murage:mcp-secrets-renamed"])("refuses Desktop MCP %s without accepting or returning credentials", async type => {
    const f = fixture(), before = f.store.getAll();
    const read = vi.spyOn(f.store, "getAll"), patch = vi.spyOn(f.store, "patch");
    const cleanupBrowser = vi.fn(async () => {});
    const port = createSupervisorPort({ store: f.store, send: f.send, remintConnectedApps: f.remintConnectedApps, cleanupBrowser });
    // A legitimate Desktop wire message must stay refused, not just a
    // malformed message whose extra credential fields happen to be rejected.
    const message = type === "murage:mcp-secrets-renamed" ? { type, from: "fixture-mcp", to: "fixture-mcp-2", at: 1 } : { type, name: "fixture-mcp", ...(type === "murage:mcp-secrets-stale" ? { at: 1 } : {}) };
    await port.handle(message);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0][0]).toEqual({ type: "murage:cloud-refused", requestId: undefined, operation: type, error: cloudHomeCopy.thisDesktopOperationIsUnavailableOnThisCloudHome });
    const accessToken = "fixture-MCP-access-canary", refreshToken = "fixture-MCP-refresh-canary", credential = "fixture-MCP-credential-canary";
    await port.handle({ ...message, requestId: "fixture-mcp-refusal", accessToken, refreshToken, credentials: { fluxApiKey: credential } });
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1][0]).toEqual({ type: "murage:cloud-refused", requestId: "fixture-mcp-refusal", operation: type, error: cloudHomeCopy.thisDesktopOperationIsUnavailableOnThisCloudHome });
    expect(read).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(f.remintConnectedApps).not.toHaveBeenCalled();
    expect(cleanupBrowser).not.toHaveBeenCalled();
    for (const value of [accessToken, refreshToken, credential, before.fluxApiKey]) expect(JSON.stringify(f.send.mock.calls)).not.toContain(value);
    expect(f.store.getAll()).toEqual(before);
  });
  it("re-seals writes before acknowledging, with a provider dispatch fence", async () => {
    const f = fixture(); await f.port.handle({ type: "murage:cloud-credential-write", requestId: "1", credentials: { fluxApiKey: "new-fixture" } });
    expect(f.store.getAll().fluxApiKey).toBe("new-fixture");
    expect(f.send.mock.calls.map(call => call[0].type)).toEqual(["murage:provider-bank-fence", "murage:managed-composio", "murage:cloud-credential-result", "murage:provider-bank-fence", "murage:cloud-credentials", "murage:managed-composio"]);
    expect(f.send.mock.calls[0][0].held).toBe(true); expect(f.send.mock.calls[3][0].held).toBe(false);
  });
  it("a new Flux key clears the old broker token in the same write and re-mints before the next connected-app call (1.0.4 audit 11-5)", async () => {
    const oldToken = "c".repeat(64), newToken = "d".repeat(64);
    let records: Record<string, string> = { fluxApiKey: "fixture-key", fluxComposioBrokerToken: oldToken, fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint("fixture-key"), fluxComposioBrokerTokenExpiresAt: "2099-01-01T00:00:00.000Z", fluxComposioAccountKind: "personal" };
    const store = { getAll: () => ({ ...records }), patch: (patch: Record<string, string>) => (records = { ...records, ...patch }) };
    const send = vi.fn();
    const seenAtRemint: Array<Record<string, string>> = [];
    const remintConnectedApps = vi.fn(async (credentials: Record<string, string>, _options: { force: boolean }) => {
      seenAtRemint.push({ ...credentials });
      return { ...credentials, fluxComposioBrokerToken: newToken, fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(credentials.fluxApiKey ?? ""), fluxComposioAccountKind: "shared" };
    });
    const revokeBrokerToken = vi.fn(async () => true);
    const port = createSupervisorPort({ store, send, remintConnectedApps, revokeBrokerToken });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "swap", credentials: { fluxApiKey: "next-account-key" } });
    expect(remintConnectedApps).toHaveBeenCalledOnce();
    expect(remintConnectedApps.mock.calls[0][1]).toEqual({ force: false });
    // The re-mint never sees (so can never keep) the old key's token.
    expect(seenAtRemint[0]?.fluxComposioBrokerToken ?? "").toBe("");
    expect(seenAtRemint[0]?.fluxApiKey).toBe("next-account-key");
    expect(store.getAll().fluxComposioBrokerToken).toBe(newToken);
    // Nothing sent to the server after the write carries the old token; the
    // server is told "no broker" before the write is acknowledged.
    expect(JSON.stringify(send.mock.calls)).not.toContain(oldToken);
    const types = send.mock.calls.map(call => call[0].type);
    const cleared = types.indexOf("murage:managed-composio");
    expect(cleared).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(types.indexOf("murage:cloud-credential-result"));
    expect(send.mock.calls[cleared][0].fluxAccess).toBeNull();
    const last = send.mock.calls.filter(call => call[0].type === "murage:managed-composio").at(-1)?.[0];
    expect(last?.fluxAccess?.token ?? newToken).toBe(newToken);
    expect(send.mock.calls.find(call => call[0].type === "murage:cloud-credentials")?.[0].credentials.fluxComposioBrokerToken).toBe(newToken);
    // The replaced token is revoked at Flux, best effort.
    expect(revokeBrokerToken).toHaveBeenCalledWith(expect.any(String), oldToken);
  });
  it("a failed re-mint after a Flux key swap leaves no token, so connected apps fail closed", async () => {
    const oldToken = "e".repeat(64);
    let records: Record<string, string> = { fluxApiKey: "fixture-key", fluxComposioBrokerToken: oldToken, fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint("fixture-key") };
    const store = { getAll: () => ({ ...records }), patch: (patch: Record<string, string>) => (records = { ...records, ...patch }) };
    const send = vi.fn();
    const remintConnectedApps = vi.fn(async () => { throw new Error("synthetic broker outage"); });
    const port = createSupervisorPort({ store, send, remintConnectedApps, revokeBrokerToken: async () => true });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "swap", credentials: { fluxApiKey: "next-account-key" } });
    expect(remintConnectedApps).toHaveBeenCalledOnce();
    expect(store.getAll().fluxComposioBrokerToken).toBe("");
    expect(JSON.stringify(send.mock.calls)).not.toContain(oldToken);
  });
  it("a credential write that keeps the same Flux key does not re-mint or drop the token", async () => {
    const token = "f".repeat(64);
    let records: Record<string, string> = { fluxApiKey: "fixture-key", fluxComposioBrokerToken: token, anthropicApiKey: "a-fixture" };
    const store = { getAll: () => ({ ...records }), patch: (patch: Record<string, string>) => (records = { ...records, ...patch }) };
    const send = vi.fn();
    const remintConnectedApps = vi.fn(async (credentials: Record<string, string>) => credentials);
    const revokeBrokerToken = vi.fn(async () => true);
    const port = createSupervisorPort({ store, send, remintConnectedApps, revokeBrokerToken });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "same", credentials: { fluxApiKey: " fixture-key ", anthropicApiKey: "b-fixture" } });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "other", credentials: { anthropicApiKey: "c-fixture" } });
    expect(remintConnectedApps).not.toHaveBeenCalled();
    expect(revokeBrokerToken).not.toHaveBeenCalled();
    expect(store.getAll().fluxComposioBrokerToken).toBe(token);
    expect(send.mock.calls.map(call => call[0].type)).not.toContain("murage:managed-composio");
  });
  function mem(initial: Record<string, string>) {
    let records = { ...initial };
    return { getAll: () => ({ ...records }), patch: (patch: Record<string, string>) => (records = { ...records, ...patch }) };
  }
  it("re-saving the same Flux key re-mints when the earlier mint failed; with a token present it does not (audit M1)", async () => {
    const store = mem({ fluxApiKey: "fixture-key", fluxComposioBrokerToken: "1".repeat(64), fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint("fixture-key") });
    const send = vi.fn();
    let fail = true;
    const remintConnectedApps = vi.fn(async (c: Record<string, string>) => { if (fail) throw new Error("synthetic outage"); return { ...c, fluxComposioBrokerToken: "2".repeat(64) }; });
    const port = createSupervisorPort({ store, send, remintConnectedApps, revokeBrokerToken: async () => true });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "a", credentials: { fluxApiKey: "next-key" } });
    expect(store.getAll().fluxComposioBrokerToken).toBe("");
    fail = false;
    await port.handle({ type: "murage:cloud-credential-write", requestId: "b", credentials: { fluxApiKey: "next-key" } });
    expect(remintConnectedApps).toHaveBeenCalledTimes(2);
    expect(store.getAll().fluxComposioBrokerToken).toBe("2".repeat(64));
    await port.handle({ type: "murage:cloud-credential-write", requestId: "c", credentials: { fluxApiKey: "next-key" } });
    expect(remintConnectedApps).toHaveBeenCalledTimes(2);
  });
  it("a mint that fails after a Flux key write is retried on a backoff until a token is stored", async () => {
    vi.useFakeTimers();
    try {
      const store = mem({ fluxApiKey: "fixture-key" });
      let calls = 0;
      const remintConnectedApps = vi.fn(async (c: Record<string, string>) => { if (++calls === 1) throw new Error("synthetic outage"); return { ...c, fluxComposioBrokerToken: "7".repeat(64) }; });
      const port = createSupervisorPort({ store, send: vi.fn(), remintConnectedApps, revokeBrokerToken: async () => true, mintRetryDelaysMs: [1_000] });
      await port.handle({ type: "murage:cloud-credential-write", requestId: "a", credentials: { fluxApiKey: "next-key" } });
      expect(store.getAll().fluxComposioBrokerToken ?? "").toBe("");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(store.getAll().fluxComposioBrokerToken).toBe("7".repeat(64));
      port.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("a write queued behind a swap does not wait for a hanging revoke (audit M2)", async () => {
    const store = mem({ fluxApiKey: "fixture-key", fluxComposioBrokerToken: "3".repeat(64) });
    const send = vi.fn();
    const port = createSupervisorPort({
      store, send, remintConnectedApps: async c => ({ ...c, fluxComposioBrokerToken: "4".repeat(64) }),
      revokeBrokerToken: () => new Promise(() => {}),
    });
    const swap = port.handle({ type: "murage:cloud-credential-write", requestId: "swap", credentials: { fluxApiKey: "next-key" } });
    const queued = port.handle({ type: "murage:cloud-credential-write", requestId: "queued", credentials: { anthropicApiKey: "x" } });
    const outcome = await Promise.race([Promise.all([swap, queued]).then(() => "done"), new Promise(r => setTimeout(() => r("hung"), 500))]);
    expect(outcome).toBe("done");
  });
  it("the replaced token is sealed as a pending revoke, drained on start, and cleared once revoked", async () => {
    const old = "5".repeat(64);
    const store = mem({ fluxApiKey: "fixture-key", fluxComposioBrokerToken: old });
    const send = vi.fn();
    const revokes: string[] = [];
    let revokeOk = false;
    const revokeBrokerToken = vi.fn(async (_u: string, t: string) => { revokes.push(t); return revokeOk; });
    const port = createSupervisorPort({ store, send, remintConnectedApps: async c => ({ ...c, fluxComposioBrokerToken: "6".repeat(64) }), revokeBrokerToken });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "swap", credentials: { fluxApiKey: "next-key" } });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Revoke failed: the marker stays sealed, and is never sent to the server.
    expect(pendingRevokes(store.getAll())).toEqual([old]);
    expect(JSON.stringify(send.mock.calls)).not.toContain(old);
    // Next start with Flux reachable: drained and cleared.
    revokeOk = true;
    const restarted = createSupervisorPort({ store, send, remintConnectedApps: async c => c, revokeBrokerToken });
    await restarted.configure();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(revokes.at(-1)).toBe(old);
    expect(pendingRevokes(store.getAll())).toEqual([]);
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  it("two swaps during a Flux outage are both revoked after recovery, and the list empties (bounded list)", async () => {
    const t1 = "1".repeat(64), t2 = "2".repeat(64), t3 = "3".repeat(64);
    const store = mem({ fluxApiKey: "k0", fluxComposioBrokerToken: t1 });
    let up = false; const revoked: string[] = [];
    let next = t2;
    const revokeBrokerToken = vi.fn(async (_u: string, t: string) => { if (up) revoked.push(t); return up; });
    const remintConnectedApps = async (c: Record<string, string>) => ({ ...c, fluxComposioBrokerToken: next });
    const port = createSupervisorPort({ store, send: vi.fn(), remintConnectedApps, revokeBrokerToken });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "a", credentials: { fluxApiKey: "k1" } });
    next = t3;
    await port.handle({ type: "murage:cloud-credential-write", requestId: "b", credentials: { fluxApiKey: "k2" } });
    await settle();
    expect(pendingRevokes(store.getAll())).toEqual([t1, t2]);
    up = true;
    await port.configure(); await settle();
    expect(revoked.sort()).toEqual([t1, t2]);
    expect(pendingRevokes(store.getAll())).toEqual([]);
  });
  it("when one of two revokes fails only that entry remains", async () => {
    const a = "a".repeat(64), b = "b".repeat(64);
    const store = mem({ fluxApiKey: "k", fluxComposioBrokerToken: "c".repeat(64), fluxComposioPendingRevokeTokens: JSON.stringify([a, b]) });
    const revokeBrokerToken = vi.fn(async (_u: string, t: string) => { if (t === a) throw new Error("boom"); return true; });
    const port = createSupervisorPort({ store, send: vi.fn(), remintConnectedApps: async c => c, revokeBrokerToken });
    await port.configure(); await settle();
    // The failed entry is retried by the post-mint drain; the confirmed one is revoked exactly once.
    expect(revokeBrokerToken.mock.calls.filter(call => call[1] === b)).toHaveLength(1);
    expect(revokeBrokerToken.mock.calls.some(call => call[1] === a)).toBe(true);
    expect(pendingRevokes(store.getAll())).toEqual([a]);
  });
  it("five swaps keep four entries; the oldest is dropped after one revoke attempt", async () => {
    const tokens = [1, 2, 3, 4, 5].map(n => String(n).repeat(64));
    const store = mem({ fluxApiKey: "k0", fluxComposioBrokerToken: tokens[0] });
    const attempts: string[] = [];
    let i = 1;
    const port = createSupervisorPort({ store, send: vi.fn(),
      remintConnectedApps: async c => ({ ...c, fluxComposioBrokerToken: tokens[Math.min(i++, 4)] }),
      revokeBrokerToken: async (_u, t) => { attempts.push(t); return false; } });
    for (let n = 1; n <= 5; n++) await port.handle({ type: "murage:cloud-credential-write", requestId: `s${n}`, credentials: { fluxApiKey: `k${n}` } });
    await settle();
    const list = pendingRevokes(store.getAll());
    expect(list).toHaveLength(4);
    expect(list).not.toContain(tokens[0]);
    expect(attempts).toContain(tokens[0]);
  });
  it("migrates a legacy single pending field into the list", async () => {
    const old = "9".repeat(64);
    const store = mem({ fluxApiKey: "k", fluxComposioBrokerToken: "8".repeat(64), [LEGACY_PENDING_REVOKE_KEY]: old });
    const revoked: string[] = [];
    const port = createSupervisorPort({ store, send: vi.fn(), remintConnectedApps: async c => c, revokeBrokerToken: async (_u, t) => { revoked.push(t); return true; } });
    expect(pendingRevokes(store.getAll())).toEqual([old]);
    await port.configure(); await settle();
    expect(revoked).toEqual([old]);
    expect(pendingRevokes(store.getAll())).toEqual([]);
    expect(store.getAll()[LEGACY_PENDING_REVOKE_KEY]).toBe("");
  });
  it("keeps the model sign-in document out of generic credential responses and writes", async () => {
    const f = fixture();
    f.store.patch({ cloudModelSignInsV1: "fixture-owned-sign-in-document" });
    await f.port.handle({ type: "murage:cloud-credential-write", requestId: "normal", credentials: { fluxApiKey: "next-fixture" } });
    expect(JSON.stringify(f.send.mock.calls)).not.toContain("fixture-owned-sign-in-document");
    await f.port.handle({ type: "murage:cloud-credential-write", requestId: "reserved", credentials: { cloudModelSignInsV1: "forged-document" } });
    expect(f.store.getAll().cloudModelSignInsV1).toBe("fixture-owned-sign-in-document");
    expect(f.send.mock.calls.some(call => call[0].type === "murage:cloud-refused" && call[0].requestId === "reserved")).toBe(true);
  });
  it("a deferred broker result cannot restore a changed sign-in document or unrelated credentials", async () => {
    const f = fixture();
    f.store.patch({ cloudModelSignInsV1: "before-sign-out", anthropicApiKey: "unrelated-fixture" });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const remint = vi.fn(async (credentials: Record<string, string>) => {
      entered(); await held;
      return { ...credentials, fluxComposioBrokerToken: "b".repeat(64), cloudModelSignInsV1: "hostile-broker-document", anthropicApiKey: "stale-unrelated" };
    });
    const port = createSupervisorPort({ store: f.store, send: f.send, remintConnectedApps: remint });
    const pending = port.configure(); await started;
    f.store.patch({ cloudModelSignInsV1: "after-sign-out", anthropicApiKey: "current-unrelated" });
    release(); await pending;
    expect(remint.mock.calls[0][0]).not.toHaveProperty("cloudModelSignInsV1");
    expect(remint.mock.calls[0][0]).not.toHaveProperty("anthropicApiKey");
    expect(f.store.getAll().cloudModelSignInsV1).toBe("after-sign-out");
    expect(f.store.getAll().anthropicApiKey).toBe("current-unrelated");
    expect(JSON.stringify(f.send.mock.calls)).not.toContain("hostile-broker-document");
  });
  it("discards a deferred broker result when the Flux account changed", async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const port = createSupervisorPort({ store: f.store, send: f.send, remintConnectedApps: async () => {
      entered(); await held; return { fluxComposioBrokerToken: "old-account-token" };
    } });
    const pending = port.configure(); await started;
    f.store.patch({ fluxApiKey: "new-account", fluxComposioBrokerToken: "new-account-token" });
    release(); await pending;
    expect(f.store.getAll().fluxComposioBrokerToken).toBe("new-account-token");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("re-mints connected-app credentials through the sealed parent and sends private updates", async () => {
    const f = fixture(); await f.port.handle({ type: "murage:flux-composio-token-rejected" });
    expect(f.remintConnectedApps).toHaveBeenCalledOnce();
    expect(f.store.getAll().fluxComposioBrokerToken).toBe("a".repeat(64));
    expect(f.send.mock.calls.map(call => call[0].type)).toEqual(["murage:cloud-credentials", "murage:managed-composio"]);
  });
  it("explicitly refuses desktop-only profile cleanup, control and desktop-secret messages", async () => {
    const f = fixture();
    for (const type of ["murage:browser-profile-deleted", "murage:browser-control", "murage:desktop-secret"]) await f.port.handle({ type, requestId: "fixture", secret: "never-log-me" });
    const results = f.send.mock.calls.map(call => call[0]);
    expect(results.filter(message => message.type === "murage:cloud-refused")).toHaveLength(3);
    expect(JSON.stringify(results)).not.toContain("never-log-me");
    expect(results.filter(message => message.type === "murage:browser-lifecycle-result").every(message => message.ok === false)).toBe(true);
  });
  it("deleting a home bot calls browser cleanup and acknowledges only its completion", async () => {
    const f = fixture(), cleanupBrowser = vi.fn(async (_bot: string) => {});
    const port = createSupervisorPort({ store: f.store, send: f.send, remintConnectedApps: f.remintConnectedApps, cleanupBrowser });
    await port.handle({ type: "murage:browser-bot-deleted", botId: "bot-1", requestId: "cleanup" });
    expect(cleanupBrowser).toHaveBeenCalledWith("bot-1");
    expect(f.send).toHaveBeenCalledWith({ type: "murage:browser-lifecycle-result", requestId: "cleanup", ok: true });
    await port.handle({ type: "murage:browser-bot-deleted", botId: "../x", requestId: "traversal" });
    expect(cleanupBrowser).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith({ type: "murage:browser-lifecycle-result", requestId: "traversal", ok: false });
    cleanupBrowser.mockRejectedValueOnce(new Error("fixture failure"));
    await port.handle({ type: "murage:browser-bot-deleted", botId: "bot-1", requestId: "failed" });
    expect(f.send).toHaveBeenCalledWith({ type: "murage:browser-lifecycle-result", requestId: "failed", ok: false });
  });
  it("uses the existing graceful close handshake", () => { const f = fixture(); f.port.requestClose(); expect(f.send).toHaveBeenCalledWith({ type: "murage:close" }); });
});
