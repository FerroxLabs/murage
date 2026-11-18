import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CLOUD_PRIVATE_MESSAGE_TYPES } from "./supervisor-port.ts";
import { createSupervisorPort as productionSupervisorPort } from "../testing/composio-supervisor-fixture.ts";
import { cloudHomeCopy } from "./copy.ts";
import { LEGACY_PENDING_REVOKE_KEY, pendingRevokes } from "./credential-projection.ts";
import { fluxKeyFingerprint } from "../../electron/flux-composio-token.mjs";
const ports: ReturnType<typeof productionSupervisorPort>[] = [];
const createSupervisorPort = (options: Parameters<typeof productionSupervisorPort>[0]) => {
  const port = productionSupervisorPort(options); ports.push(port); return port;
};
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.spyOn(Math, "random").mockReturnValue(1); });
afterEach(() => { for (const port of ports.splice(0)) port.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
const reachDeadline = (port: ReturnType<typeof createSupervisorPort>) => {
  const deadline = Math.max(...port.admissionRecords().map(row => row.notBefore));
  expect(deadline).toBeGreaterThan(Date.now());
  vi.setSystemTime(deadline);
};
const hk = (tag: string) => "sk-flux-home-" + tag.padEnd(24, "x"); // a key shaped like the ones Flux issues for a home

function fixture() {
  let records: Record<string, string> = { fluxApiKey: hk("fixturekey") };
  const store = { getAll: () => ({ ...records }), patch: (patch: Record<string, string>) => (records = { ...records, ...patch }) };
  const send = vi.fn();
  const remintConnectedApps = vi.fn(async (_credentials: Record<string, string>, _options: { force: boolean }) => ({ fluxApiKey: hk("fixturekey"), fluxComposioBrokerToken: "a".repeat(64), fluxComposioAccountKind: "personal" }));
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
    const attach = () => createSupervisorPort({ store, send, connectedAppsBrokerUrl: "https://broker.example", composioTransport: fetchImpl });
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
  it("stamps the background Flux memory headers on every lifecycle call to a Flux broker, and none to another host", async () => {
    const fluxApiKey = "sk-flux-FAKE_BROKER_FIXTURE_KEY", expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    for (const [brokerUrl, onFlux] of [["https://api.fluxrouter.ai/composio", true], ["https://broker.example", false]] as const) {
      let credentials: Record<string, string> = { fluxApiKey, fluxComposioBrokerToken: "a".repeat(64), fluxComposioBrokerTokenExpiresAt: expiresAt,
        fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(fluxApiKey), fluxComposioAccountKind: "personal" };
      const store = { getAll: () => ({ ...credentials }), patch: (patch: Record<string, string>) => (credentials = { ...credentials, ...patch }) };
      const seen: Array<{ url: string; method?: string; headers: Headers }> = [];
      const composioTransport: typeof fetch = async (input, init) => {
        seen.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers) });
        return String(input).endsWith("/v1/tokens")
          ? new Response(JSON.stringify({ token: "b".repeat(64), expiresAt, accountKind: "personal" }), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(null, { status: 200 });
      };
      const port = createSupervisorPort({ store, send: vi.fn(), connectedAppsBrokerUrl: brokerUrl, composioTransport });
      await port.configure();
      await port.handle({ type: "murage:flux-composio-token-rejected" });
      const revoke = seen.find(call => call.method === "DELETE");
      expect(revoke, brokerUrl).toBeDefined();
      expect(seen.length, brokerUrl).toBeGreaterThanOrEqual(2);
      for (const call of seen) {
        expect(call.headers.get("x-flux-memory-app"), `${brokerUrl} ${call.method}`).toBe(onFlux ? "murage" : null);
        expect(call.headers.get("x-flux-memory-capture"), `${brokerUrl} ${call.method}`).toBe(onFlux ? "off" : null);
        expect(call.headers.get("x-flux-memory-inject"), `${brokerUrl} ${call.method}`).toBe(onFlux ? "off" : null);
        expect(call.headers.get("x-flux-feature"), `${brokerUrl} ${call.method}`).toBe(onFlux ? "other" : null);
        expect(call.headers.get("authorization"), `${brokerUrl} ${call.method}`).toMatch(/^Bearer \S+$/);
      }
    }
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
    expect(f.remintConnectedApps).toHaveBeenCalledTimes(1); // MAIN RULING 1115-COMPOSIO-A3: no configure dispatch below the deadline.
    now += 14_999; await port.configure();
    expect(f.remintConnectedApps).toHaveBeenCalledTimes(1); // MAIN RULING 1115-COMPOSIO-A3
    now += 1; await port.configure();
    expect(f.remintConnectedApps.mock.calls[1]?.[1]).toEqual({ force: false }); // MAIN RULING 1115-COMPOSIO-A3
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
    const homeKey = "sk-flux-home-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    const f = fixture(); await f.port.handle({ type: "murage:cloud-credential-write", requestId: "1", credentials: { fluxApiKey: homeKey } });
    expect(f.store.getAll().fluxApiKey).toBe(homeKey);
    expect(f.send.mock.calls.map(call => call[0].type)).toEqual(["murage:provider-bank-fence", "murage:managed-composio", "murage:cloud-credential-result", "murage:provider-bank-fence", "murage:cloud-credentials", "murage:managed-composio"]);
    expect(f.send.mock.calls[0][0].held).toBe(true); expect(f.send.mock.calls[3][0].held).toBe(false);
  });
  it("a new Flux key clears the old broker token in the same write and re-mints before the next connected-app call (1.0.4 audit 11-5)", async () => {
    const oldToken = "c".repeat(64), newToken = "d".repeat(64);
    let records: Record<string, string> = { fluxApiKey: hk("fixturekey"), fluxComposioBrokerToken: oldToken, fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(hk("fixturekey")), fluxComposioBrokerTokenExpiresAt: "2099-01-01T00:00:00.000Z", fluxComposioAccountKind: "personal" };
    const store = { getAll: () => ({ ...records }), patch: (patch: Record<string, string>) => (records = { ...records, ...patch }) };
    const send = vi.fn();
    const seenAtRemint: Array<Record<string, string>> = [];
    const remintConnectedApps = vi.fn(async (credentials: Record<string, string>, _options: { force: boolean }) => {
      seenAtRemint.push({ ...credentials });
      return { ...credentials, fluxComposioBrokerToken: newToken, fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(credentials.fluxApiKey ?? ""), fluxComposioAccountKind: "shared" };
    });
    const revokeBrokerToken = vi.fn(async () => true);
    const port = createSupervisorPort({ store, send, remintConnectedApps, revokeBrokerToken });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "swap", credentials: { fluxApiKey: hk("nextaccountkey") } });
    expect(remintConnectedApps).toHaveBeenCalledOnce();
    expect(remintConnectedApps.mock.calls[0][1]).toEqual({ force: false });
    // The re-mint never sees (so can never keep) the old key's token.
    expect(seenAtRemint[0]?.fluxComposioBrokerToken ?? "").toBe("");
    expect(seenAtRemint[0]?.fluxApiKey).toBe(hk("nextaccountkey"));
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
    let records: Record<string, string> = { fluxApiKey: hk("fixturekey"), fluxComposioBrokerToken: oldToken, fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(hk("fixturekey")) };
    const store = { getAll: () => ({ ...records }), patch: (patch: Record<string, string>) => (records = { ...records, ...patch }) };
    const send = vi.fn();
    const remintConnectedApps = vi.fn(async () => { throw new Error("synthetic broker outage"); });
    const port = createSupervisorPort({ store, send, remintConnectedApps, revokeBrokerToken: async () => true });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "swap", credentials: { fluxApiKey: hk("nextaccountkey") } });
    expect(remintConnectedApps).toHaveBeenCalledOnce();
    expect(store.getAll().fluxComposioBrokerToken).toBe("");
    expect(JSON.stringify(send.mock.calls)).not.toContain(oldToken);
  });
  it("a credential write that keeps the same Flux key does not re-mint or drop the token", async () => {
    const token = "f".repeat(64);
    let records: Record<string, string> = { fluxApiKey: hk("fixturekey"), fluxComposioBrokerToken: token, anthropicApiKey: "a-fixture" };
    const store = { getAll: () => ({ ...records }), patch: (patch: Record<string, string>) => (records = { ...records, ...patch }) };
    const send = vi.fn();
    const remintConnectedApps = vi.fn(async (credentials: Record<string, string>) => credentials);
    const revokeBrokerToken = vi.fn(async () => true);
    const port = createSupervisorPort({ store, send, remintConnectedApps, revokeBrokerToken });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "same", credentials: { fluxApiKey: ` ${hk("fixturekey")} `, anthropicApiKey: "b-fixture" } });
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
    const store = mem({ fluxApiKey: hk("fixturekey"), fluxComposioBrokerToken: "1".repeat(64), fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(hk("fixturekey")) });
    const send = vi.fn();
    let fail = true;
    const remintConnectedApps = vi.fn(async (c: Record<string, string>) => { if (fail) throw new Error("synthetic outage"); return { ...c, fluxComposioBrokerToken: "2".repeat(64) }; });
    const port = createSupervisorPort({ store, send, remintConnectedApps, revokeBrokerToken: async () => true });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "a", credentials: { fluxApiKey: hk("nextkey") } });
    expect(store.getAll().fluxComposioBrokerToken).toBe("");
    fail = false;
    await port.handle({ type: "murage:cloud-credential-write", requestId: "early", credentials: { fluxApiKey: hk("nextkey") } });
    expect(remintConnectedApps).toHaveBeenCalledTimes(1); // MAIN RULING 1115-COMPOSIO-A3
    reachDeadline(port);
    await port.handle({ type: "murage:cloud-credential-write", requestId: "b", credentials: { fluxApiKey: hk("nextkey") } });
    expect(remintConnectedApps).toHaveBeenCalledTimes(2);
    expect(store.getAll().fluxComposioBrokerToken).toBe("2".repeat(64));
    await port.handle({ type: "murage:cloud-credential-write", requestId: "c", credentials: { fluxApiKey: hk("nextkey") } });
    expect(remintConnectedApps).toHaveBeenCalledTimes(2);
  });
  it("a mint that fails after a Flux key write is retried on a backoff until a token is stored", async () => {
    vi.useFakeTimers();
    try {
      const store = mem({ fluxApiKey: hk("fixturekey") });
      let calls = 0;
      const remintConnectedApps = vi.fn(async (c: Record<string, string>) => { if (++calls === 1) throw new Error("synthetic outage"); return { ...c, fluxComposioBrokerToken: "7".repeat(64) }; });
      const port = createSupervisorPort({ store, send: vi.fn(), remintConnectedApps, revokeBrokerToken: async () => true, mintRetryDelaysMs: [1_000] });
      await port.handle({ type: "murage:cloud-credential-write", requestId: "a", credentials: { fluxApiKey: hk("nextkey") } });
      expect(store.getAll().fluxComposioBrokerToken ?? "").toBe("");
      const deadline = Math.max(...port.admissionRecords().map(row => row.notBefore));
      await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
      expect(remintConnectedApps).toHaveBeenCalledTimes(1); // MAIN RULING 1115-COMPOSIO-A3
      expect(store.getAll().fluxComposioBrokerToken).toBe(""); // MAIN RULING 1115-COMPOSIO-A3
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getAll().fluxComposioBrokerToken).toBe("7".repeat(64)); // MAIN RULING 1115-COMPOSIO-A3
      port.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("a write queued behind a swap does not wait for a hanging revoke (audit M2)", async () => {
    const store = mem({ fluxApiKey: hk("fixturekey"), fluxComposioBrokerToken: "3".repeat(64) });
    const send = vi.fn();
    const port = createSupervisorPort({
      store, send, remintConnectedApps: async c => ({ ...c, fluxComposioBrokerToken: "4".repeat(64) }),
      revokeBrokerToken: () => new Promise(() => {}),
    });
    const swap = port.handle({ type: "murage:cloud-credential-write", requestId: "swap", credentials: { fluxApiKey: hk("nextkey") } });
    const queued = port.handle({ type: "murage:cloud-credential-write", requestId: "queued", credentials: { anthropicApiKey: "x" } });
    const outcome = await Promise.race([Promise.all([swap, queued]).then(() => "done"), new Promise(r => setTimeout(() => r("hung"), 500))]);
    expect(outcome).toBe("done");
  });
  it("the replaced token is sealed as a pending revoke, drained on start, and cleared once revoked", async () => {
    const old = "5".repeat(64);
    const store = mem({ fluxApiKey: hk("fixturekey"), fluxComposioBrokerToken: old });
    const send = vi.fn();
    const revokes: string[] = [];
    let revokeOk = false;
    const revokeBrokerToken = vi.fn(async (_u: string, t: string) => { revokes.push(t); return revokeOk; });
    const port = createSupervisorPort({ store, send, remintConnectedApps: async c => ({ ...c, fluxComposioBrokerToken: "6".repeat(64) }), revokeBrokerToken });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "swap", credentials: { fluxApiKey: hk("nextkey") } });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Revoke failed: the marker stays sealed, and is never sent to the server.
    expect(pendingRevokes(store.getAll())).toEqual([old]);
    expect(JSON.stringify(send.mock.calls)).not.toContain(old);
    // Next start with Flux reachable: drained and cleared.
    revokeOk = true;
    const restarted = createSupervisorPort({ store, send, remintConnectedApps: async c => c, revokeBrokerToken });
    reachDeadline(restarted);
    await restarted.configure();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(revokes.at(-1)).toBe(old);
    expect(pendingRevokes(store.getAll())).toEqual([]);
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  it("two swaps during a Flux outage are both revoked after recovery, and the list empties (bounded list)", async () => {
    const t1 = "1".repeat(64), t2 = "2".repeat(64), t3 = "3".repeat(64);
    const store = mem({ fluxApiKey: hk("k0"), fluxComposioBrokerToken: t1 });
    let up = false; const revoked: string[] = [];
    let next = t2;
    const revokeBrokerToken = vi.fn(async (_u: string, t: string) => { if (up) revoked.push(t); return up; });
    const remintConnectedApps = async (c: Record<string, string>) => ({ ...c, fluxComposioBrokerToken: next });
    const port = createSupervisorPort({ store, send: vi.fn(), remintConnectedApps, revokeBrokerToken });
    await port.handle({ type: "murage:cloud-credential-write", requestId: "a", credentials: { fluxApiKey: hk("k1") } });
    next = t3;
    reachDeadline(port);
    await port.handle({ type: "murage:cloud-credential-write", requestId: "b", credentials: { fluxApiKey: hk("k2") } });
    await settle();
    expect(pendingRevokes(store.getAll())).toEqual([t1, t2]);
    up = true;
    expect(revoked).toEqual([]); // MAIN RULING 1115-COMPOSIO-A3: no dispatch during the outstanding hold.
    reachDeadline(port);
    await port.configure(); await settle();
    expect(revoked.sort()).toEqual([t1, t2]);
    expect(pendingRevokes(store.getAll())).toEqual([]);
  });
  it("when one of two revokes fails only that entry remains", async () => {
    const a = "a".repeat(64), b = "b".repeat(64);
    const store = mem({ fluxApiKey: hk("k"), fluxComposioBrokerToken: "c".repeat(64), fluxComposioPendingRevokeTokens: JSON.stringify([a, b]) });
    const revokeBrokerToken = vi.fn(async (_u: string, t: string) => { if (t === a) throw new Error("boom"); return true; });
    const port = createSupervisorPort({ store, send: vi.fn(), remintConnectedApps: async c => c, revokeBrokerToken });
    await port.configure(); await settle();
    expect(revokeBrokerToken.mock.calls.map(call => call[1])).toEqual([a]); // MAIN RULING 1115-COMPOSIO-A3: startup refusal blocks the next leg.
    reachDeadline(port);
    await port.configure(); await settle();
    // The failed entry remains pending; the next eligible drain gets a fair turn.
    expect(revokeBrokerToken.mock.calls.filter(call => call[1] === b)).toHaveLength(1);
    expect(revokeBrokerToken.mock.calls.some(call => call[1] === a)).toBe(true);
    expect(pendingRevokes(store.getAll())).toEqual([a]);
  });
  it("five swaps keep four entries; the oldest is dropped after one revoke attempt", async () => {
    const tokens = [1, 2, 3, 4, 5].map(n => String(n).repeat(64));
    const store = mem({ fluxApiKey: hk("k0"), fluxComposioBrokerToken: tokens[0] });
    const attempts: string[] = [];
    let i = 1;
    const port = createSupervisorPort({ store, send: vi.fn(),
      remintConnectedApps: async c => ({ ...c, fluxComposioBrokerToken: tokens[Math.min(i++, 4)] }),
      revokeBrokerToken: async (_u, t) => { attempts.push(t); return false; } });
    for (let n = 1; n <= 5; n++) {
      if (n > 1) reachDeadline(port);
      await port.handle({ type: "murage:cloud-credential-write", requestId: `s${n}`, credentials: { fluxApiKey: hk(`k${n}`) } });
      await settle();
    }
    await settle();
    const list = pendingRevokes(store.getAll());
    expect(list).toHaveLength(4);
    expect(list).not.toContain(tokens[0]);
    expect(attempts).toContain(tokens[0]);
  });
  it("migrates a legacy single pending field into the list", async () => {
    const old = "9".repeat(64);
    const store = mem({ fluxApiKey: hk("k"), fluxComposioBrokerToken: "8".repeat(64), [LEGACY_PENDING_REVOKE_KEY]: old });
    const revoked: string[] = [];
    const port = createSupervisorPort({ store, send: vi.fn(), remintConnectedApps: async c => c, revokeBrokerToken: async (_u, t) => { revoked.push(t); return true; } });
    expect(pendingRevokes(store.getAll())).toEqual([old]);
    await port.configure(); await settle();
    expect(revoked).toEqual([old]);
    expect(pendingRevokes(store.getAll())).toEqual([]);
    expect(store.getAll()[LEGACY_PENDING_REVOKE_KEY]).toBe("");
  });
  it("never stores the owner's primary Flux key; the home holds only its own key (C-01)", async () => {
    const f = fixture(); const before = f.store.getAll();
    await f.port.handle({ type: "murage:cloud-credential-write", requestId: "owner-key", credentials: { fluxApiKey: "sk-flux-" + "FAKE0000000000000000000000000000000TESTKEY" } });
    expect(f.store.getAll()).toEqual(before);
    expect(f.send.mock.calls.map(call => call[0].type)).toEqual(["murage:cloud-refused"]);
    expect(JSON.stringify(f.send.mock.calls)).not.toContain("FAKE0000");
  });
  it("keeps the model sign-in document out of generic credential responses and writes", async () => {
    const f = fixture();
    f.store.patch({ cloudModelSignInsV1: "fixture-owned-sign-in-document" });
    await f.port.handle({ type: "murage:cloud-credential-write", requestId: "normal", credentials: { fluxApiKey: hk("nextfixture") } });
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
    f.store.patch({ fluxApiKey: hk("newaccount"), fluxComposioBrokerToken: "new-account-token" });
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

// Owners: composio-429-h owns recovery authority/adapters; independent reviewer owns acceptance.
// These cases use the production supervisor and reopen the actual encrypted document.
import { createSupervisorPort as recoverySupervisor } from "./supervisor-port.ts";
import { SealedSecretStore } from "./secrets.ts";
import { createComposioAdmissionStore } from "../../electron/composio-admission-store.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const recoveryDirs: string[] = [], recoveryPorts: ReturnType<typeof recoverySupervisor>[] = [], recoveryStores: SealedSecretStore[] = [];
afterEach(() => {
  for (const port of recoveryPorts.splice(0)) port.dispose();
  for (const store of recoveryStores.splice(0)) store.close();
  for (const dir of recoveryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const recUrl = "https://broker.example.test", recM = "c".repeat(64), recP = "a".repeat(64), recN = "d".repeat(64);
const recKey = hk("custodyowner");
const recDocument = (token = recP) => ({ fluxApiKey: recKey, fluxComposioBrokerToken: token,
  fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint(recKey), fluxComposioBrokerTokenExpiresAt: "2099-01-01T00:00:00.000Z" });
const recSettle = async () => { for (let n = 0; n < 160; n++) await Promise.resolve(); };
function recoveryHome() {
  const dir = mkdtempSync(join(tmpdir(), "custody-home-")); recoveryDirs.push(dir);
  let store: SealedSecretStore;
  const open = () => { store = new SealedSecretStore(dir, "fixture-home", Buffer.alloc(32, 9)); recoveryStores.push(store); return store; };
  open().patch(recDocument());
  const deletes: string[] = [], mints: number[] = [], send = vi.fn();
  let brokenDelete = false;
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === "DELETE") { deletes.push(new Headers(init.headers).get("authorization")!.slice(7)); return Response.json({}, { status: brokenDelete ? 503 : 200 }); }
    mints.push(Date.now()); return Response.json({ token: recM, expiresAt: "2099-01-01T00:00:00.000Z", accountKind: "personal" });
  };
  const attach = (hooks: Partial<Pick<SealedSecretStore, "patchDurable" | "readBack">> = {}) => {
    const current = store;
    const port = recoverySupervisor({ store: { getAll: () => current.getAll(), patch: p => current.patch(p),
      patchDurable: p => hooks.patchDurable ? hooks.patchDurable(p) : current.patchDurable(p), readBack: () => hooks.readBack ? hooks.readBack() : current.readBack() },
      send, connectedAppsBrokerUrl: recUrl, composioTransport: transport,
      admissionStore: createComposioAdmissionStore(dir), admissionNow: Date.now, admissionMonotonic: Date.now });
    recoveryPorts.push(port); return port;
  };
  return { dir, open, store: () => store, attach, deletes, mints, send, breakDelete: (v: boolean) => { brokenDelete = v; },
    queue: () => JSON.parse(store.readBack().composioPendingRevocations || "[]") as Array<{ token: string; previous?: string; after?: string; replacement?: boolean; attempts?: number; retryAt?: number; exhausted?: boolean }> };
}

describe("durable custody recovery through production supervisor", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  it.each(["minted", "previous", "newer", "absent"])("T1 cloud_restart_replacement_converges %s", async active => {
    const h = recoveryHome();
    // A real mint and W1 receipt precede each restart, never a separate lifecycle fixture.
    let port!: ReturnType<typeof recoverySupervisor>, cut = false;
    port = h.attach({ patchDurable: patch => {
      const out = h.store().patchDurable(patch);
      if (!cut && patch.composioPendingRevocations?.includes('"replacement":true')) { cut = true; port.dispose(); throw new Error("fixture crash after W1"); }
      return out;
    } });
    await port.remintConnectedApps(); await recSettle();
    expect(cut, "W1 was durably reached").toBe(true);
    expect(h.mints).toHaveLength(1); expect(h.queue()).toHaveLength(1);
    h.open().patch({ fluxComposioBrokerToken: active === "minted" ? recM : active === "previous" ? recP : active === "newer" ? recN : "" });
    const restarted = h.attach(); await restarted.configure(); await recSettle();
    expect(h.deletes).toEqual(active === "minted" ? [recP] : [recM]);
    await vi.advanceTimersByTimeAsync(15_000); await recSettle();
    expect(h.deletes).toEqual(active === "minted" ? [recP] : active === "previous" ? [recM] : [recM, recP]);
    expect(h.mints, "restart never remints to settle custody").toHaveLength(1);
    expect(h.queue()).toEqual([]);
    expect(h.store().readBack().fluxComposioBrokerToken).toBe(active === "minted" ? recM : active === "previous" ? recP : active === "newer" ? recN : "");
    await restarted.remintConnectedApps(); await recSettle(); expect(h.mints).toHaveLength(2);
  });
  it("T2 credential_commit_preserves_current_custody across W2 restart", async () => {
    const h = recoveryHome(), extra = "e".repeat(64), settled = "f".repeat(64);
    h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: settled }]) });
    let port!: ReturnType<typeof recoverySupervisor>, reached = false;
    port = h.attach({ patchDurable: patch => {
      if (patch.fluxComposioBrokerToken === recM) {
        const current = h.queue().filter(e => e.token !== settled);
        h.store().patchDurable({ composioPendingRevocations: JSON.stringify([...current, { fluxBrokerUrl: recUrl, token: extra }]) });
      }
      const out = h.store().patchDurable(patch);
      if (patch.fluxComposioBrokerToken === recM) { reached = true; port.dispose(); throw new Error("fixture crash after W2"); }
      return out;
    } });
    await port.remintConnectedApps(); await recSettle(); expect(reached).toBe(true);
    h.open();
    expect(h.queue().map(e => e.token)).toEqual([recM, extra]);
    const restarted = h.attach(); await restarted.configure(); await vi.advanceTimersByTimeAsync(15_000); await recSettle();
    expect(h.queue()).toEqual([]); expect(h.deletes).toEqual([recP, extra]); expect(h.deletes).not.toContain(recM);
  });
  it("T3 compound_cleanup_restart_keeps_both_legs and rechecks active identity", async () => {
    const h = recoveryHome();
    // The same protected format left after W3; an unrelated newer writer may activate its first leg.
    h.store().patch({ ...recDocument(recM), composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, after: recP }]) });
    let port = h.attach(); await port.configure(); await recSettle(); port.dispose();
    h.open(); port = h.attach(); await port.configure(); await vi.advanceTimersByTimeAsync(30_000); await recSettle();
    expect(h.deletes).toEqual([recP]); expect(h.queue()).toEqual([]);
    expect(h.store().readBack().fluxComposioBrokerToken).toBe(recM); expect(h.mints).toEqual([]);
  });
  it("T4 recovery_budget_survives_restart and parks after three reserved attempts", async () => {
    const h = recoveryHome(); h.breakDelete(true);
    h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, previous: recP, replacement: true }]) });
    let port = h.attach();
    for (let n = 1; n <= 3; n++) {
      await port.configure(); await recSettle();
      expect(h.queue()[0].attempts, "attempt is durable before transport").toBe(n);
      port.dispose(); h.open(); port = h.attach();
      const count = h.deletes.length, deadline = h.queue()[0].retryAt!;
      if (n < 3) { expect(deadline).toBeGreaterThan(Date.now()); await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1); await port.configure(); expect(h.deletes).toHaveLength(count); await vi.advanceTimersByTimeAsync(1); }
    }
    await port.configure(); await recSettle();
    expect(h.queue()[0].exhausted).toBe(true);
    const count = h.deletes.length; await vi.advanceTimersByTimeAsync(86400_000); await port.configure();
    expect(h.deletes).toHaveLength(count); expect(h.mints).toEqual([]);
    expect(h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:managed-composio").at(-1).admission).toEqual({ outcome: "failed", reason: "credential_recovery_failed", attempted: false });
  });
  it.each(["corrupt", "oversized"])("T5 recovery_hold_capacity_and_offline rejects %s custody visibly", async mode => {
    const h = recoveryHome(); h.store().patch({ fluxComposioBrokerToken: "", composioPendingRevocations: mode === "corrupt" ? "{" : JSON.stringify(Array.from({ length: 257 }, (_, n) => ({ fluxBrokerUrl: recUrl, token: n.toString(16).padStart(64, "0") }))) });
    const bytes = h.store().readBack().composioPendingRevocations, port = h.attach(); await port.configure(); await recSettle();
    expect(h.mints).toEqual([]); expect(h.deletes).toEqual([]); expect(h.store().readBack().composioPendingRevocations).toBe(bytes);
    expect(h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:managed-composio").at(-1).admission).toEqual({ outcome: "failed", reason: "credential_recovery_failed", attempted: false });
  });
  it("T6 recovery_error_reaches_owner from background settlement without credential publication", async () => {
    const h = recoveryHome(); h.breakDelete(true);
    h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, replacement: true, previous: recP, attempts: 1 }]) });
    const port = h.attach(); await port.configure(); await recSettle(); h.send.mockClear();
    await vi.advanceTimersByTimeAsync(120_000); await recSettle();
    const states = h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:managed-composio");
    expect(states.some(m => m.admission.outcome === "failed" && m.admission.reason === "credential_recovery_failed")).toBe(true);
    for (const m of states) expect(JSON.stringify(m.admission)).not.toMatch(new RegExp(`${recM}|${recP}|${recKey}`));
  });
});

describe("custody pass deadline and explicit owner Retry", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  it("T4 hung recovery pass terminates at 30 seconds and ignores settlement after disposal", async () => {
    const h = recoveryHome();
    let settle!: () => void, entered = false;
    // The OS write may be uncancellable; its late settlement must not publish success.
    let port!: ReturnType<typeof recoverySupervisor>;
    port = h.attach({ patchDurable: patch => { const result = h.store().patchDurable(patch); if (patch.composioPendingRevocations?.includes('"replacement":true')) { port.dispose(); throw new Error("fixture W1 cut"); } return result; } });
    await port.remintConnectedApps(); await recSettle(); h.open();
    const waiting = new Promise<Response>(resolve => { settle = () => resolve(Response.json({})); });
    const hung = recoverySupervisor({ store: h.store(), send: h.send, connectedAppsBrokerUrl: recUrl,
      admissionStore: createComposioAdmissionStore(h.dir), admissionNow: Date.now, admissionMonotonic: Date.now,
      composioTransport: async (_url, init) => {
        if (init?.method === "DELETE") { entered = true; return waiting; }
        h.mints.push(Date.now()); return Response.json({ token: recM, expiresAt: "2099-01-01T00:00:00.000Z" });
      } });
    recoveryPorts.push(hung);
    port.dispose();
    let returned = false;
    const result = hung.configure().then(() => { returned = true; });
    await recSettle(); expect(entered).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999); expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await recSettle(); expect(returned).toBe(true);
    expect(h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:managed-composio").at(-1).admission).toEqual({ outcome: "failed", reason: "credential_recovery_failed", attempted: false });
    const publications = h.send.mock.calls.length; hung.dispose(); settle(); await result; await recSettle();
    expect(h.send).toHaveBeenCalledTimes(publications); expect(h.deletes).toEqual([]); expect(h.mints).toHaveLength(1);
  });
  it("T4 explicit Retry durably resets one exhausted episode but ordinary configure does not", async () => {
    const h = recoveryHome();
    h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, previous: recP, replacement: true, attempts: 3, exhausted: true }]) });
    const port = h.attach(); await port.configure(); await recSettle();
    expect(h.queue()[0].attempts).toBe(3); expect(h.deletes).toEqual([]); expect(h.mints).toEqual([]);
    await port.remintConnectedApps(); await recSettle(); await vi.advanceTimersByTimeAsync(15_000);
    expect(h.queue()).toEqual([]); expect(h.deletes).toEqual([recM]);
    await port.remintConnectedApps(); await recSettle(); expect(h.mints).toHaveLength(1);
  });
});

describe("broker lifecycle usage tags", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  it.each([["https://api.fluxrouter.ai/composio", "other"], [recUrl, null]])("tags the lifecycle request sent to %s with feature %s", async (url, feature) => {
    const h = recoveryHome(); const seen: Array<string | null> = [];
    const port = recoverySupervisor({ store: h.store(), send: h.send, connectedAppsBrokerUrl: url,
      admissionStore: createComposioAdmissionStore(h.dir), admissionNow: Date.now, admissionMonotonic: Date.now,
      composioTransport: async (_url, init) => { seen.push(new Headers(init?.headers).get("x-flux-feature")); return Response.json({ token: recM, expiresAt: "2099-01-01T00:00:00.000Z" }); } });
    recoveryPorts.push(port);
    await port.remintConnectedApps(); await recSettle(); await vi.advanceTimersByTimeAsync(15_000);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(value => value === feature)).toBe(true);
  });
});

describe("real supervisor W1-W4 crash cuts", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  it.each([ ["W1", "after"], ["W2", "before"], ["W2", "after"], ["W3", "before"], ["W3", "after"], ["W4", "before"], ["W4", "after"] ])("T1 durable cut %s %s converges after reopened store", async (stage, side) => {
    const h = recoveryHome();
    let port!: ReturnType<typeof recoverySupervisor>, cut = false;
    port = h.attach({ patchDurable: patch => {
      const queue = patch.composioPendingRevocations ? JSON.parse(patch.composioPendingRevocations) : null;
      const reached = !cut && (stage === "W1" ? queue?.some((e: { replacement?: boolean }) => e.replacement)
        : stage === "W2" ? patch.fluxComposioBrokerToken === recM
        : stage === "W3" ? queue?.some((e: { token: string; replacement?: boolean }) => e.token === recP && !e.replacement)
        : queue?.length === 0 && h.deletes.length > 0);
      if (reached && side === "before") { cut = true; port.dispose(); throw new Error("fixture cut before durable write"); }
      const result = h.store().patchDurable(patch);
      if (reached) { cut = true; port.dispose(); throw new Error("fixture cut after durable write"); }
      return result;
    } });
    await port.remintConnectedApps(); await recSettle(); expect(cut).toBe(true); expect(h.mints).toHaveLength(1);
    h.open(); const active = h.store().readBack().fluxComposioBrokerToken, count = h.deletes.length;
    const next = h.attach(); await next.configure(); await vi.advanceTimersByTimeAsync(30_000); await recSettle();
    expect(h.queue()).toEqual([]); expect(h.mints).toHaveLength(1);
    expect(h.deletes).not.toContain(active);
    const owed = active === recM ? recP : recM;
    expect(h.deletes).toEqual(stage === "W4" && side === "before" ? [owed, owed] : [owed]);
    expect(h.deletes.length).toBeGreaterThanOrEqual(count);
  });
  it.each(["before", "after"])("T3 compound first W4 %s crash preserves the second leg", async side => {
    const h = recoveryHome(); let first!: ReturnType<typeof recoverySupervisor>;
    first = h.attach({ patchDurable: p => { const result = h.store().patchDurable(p); if (p.composioPendingRevocations?.includes('"replacement":true')) { first.dispose(); throw new Error("fixture W1 cut"); } return result; } });
    await first.remintConnectedApps(); await recSettle();
    h.open().patch({ fluxComposioBrokerToken: recN });
    let second!: ReturnType<typeof recoverySupervisor>, cut = false;
    second = h.attach({ patchDurable: patch => {
      const rows = patch.composioPendingRevocations ? JSON.parse(patch.composioPendingRevocations) : [];
      const reached = !cut && h.deletes.includes(recM) && rows.length === 1 && rows[0].token === recP;
      if (reached && side === "before") { cut = true; second.dispose(); throw new Error("fixture first W4 cut"); }
      const result = h.store().patchDurable(patch);
      if (reached) { cut = true; second.dispose(); throw new Error("fixture first W4 cut"); }
      return result;
    } });
    await second.configure(); await recSettle(); expect(cut).toBe(true);
    h.open(); const last = h.attach(); await last.configure(); await vi.advanceTimersByTimeAsync(30_000); await recSettle();
    expect(h.queue()).toEqual([]); expect(h.mints).toHaveLength(1); expect(h.deletes).not.toContain(recN);
    expect(h.deletes).toEqual(side === "before" ? [recM, recM, recP] : [recM, recP]);
  });
});

describe("recovery admission and fair capacity", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  it.each([429, 503])("T5 cleanup HTTP %s preserves a six-hour floor across restart", async status => {
    const h = recoveryHome(); h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, previous: recP, replacement: true }]) });
    let calls = 0, up = false;
    const attach = () => {
      const port = recoverySupervisor({ store: h.store(), send: h.send, connectedAppsBrokerUrl: recUrl, admissionNow: Date.now, admissionMonotonic: Date.now,
        admissionStore: createComposioAdmissionStore(h.dir), composioTransport: async () => { calls++; return Response.json({}, up ? {} : { status, headers: { "retry-after": "21600" } }); } });
      recoveryPorts.push(port); return port;
    };
    let port = attach(); await port.configure(); await recSettle(); expect(calls).toBe(1); expect(h.queue()[0].attempts).toBe(1);
    const start = Date.now(); port.dispose(); h.open(); port = attach();
    for (const elapsed of [15_001, 60_000, 3600_000, 21_599_999]) {
      await vi.advanceTimersByTimeAsync(start + elapsed - Date.now()); await port.configure();
      expect(calls).toBe(1); expect(h.queue()[0].attempts).toBe(1);
      expect(h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:managed-composio").at(-1).admission).toMatchObject({ outcome: "held", retryAt: start + 21_600_000 });
    }
    up = true; await vi.advanceTimersByTimeAsync(1); await recSettle();
    expect(calls).toBe(2); expect(h.queue()).toEqual([]);
  });
  it("T5 full custody reserves before mint and drains sixteen per fair pass without loss", async () => {
    const h = recoveryHome(), tokens = Array.from({ length: 256 }, (_, n) => (n + 1).toString(16).padStart(64, "0"));
    h.store().patch({ composioPendingRevocations: JSON.stringify(tokens.map(token => ({ fluxBrokerUrl: recUrl, token }))) });
    h.store().patch({ fluxComposioBrokerToken: "" });
    const port = h.attach(); await port.configure(); await recSettle();
    expect(h.mints).toEqual([]); expect(h.deletes).toEqual(tokens.slice(0, 16)); expect(h.queue().map(e => e.token)).toEqual(tokens.slice(16));
    for (let n = 0; n < 15; n++) { await vi.advanceTimersByTimeAsync(15_000); await recSettle(); }
    expect(h.deletes).toEqual(tokens); expect(h.queue()).toEqual([]); expect(h.mints).toEqual([]);
  });
  it("T5 offline wake never reserves attempts or polls", async () => {
    const h = recoveryHome(); h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, previous: recP, replacement: true }]) });
    let online = false;
    const port = recoverySupervisor({ store: h.store(), send: h.send, connectedAppsBrokerUrl: recUrl, composioIsOnline: () => online,
      admissionNow: Date.now, admissionMonotonic: Date.now, admissionStore: createComposioAdmissionStore(h.dir), composioTransport: async (_url, init) => { h.deletes.push(new Headers(init?.headers).get("authorization")!.slice(7)); return Response.json({}); } });
    recoveryPorts.push(port); await port.configure(); await vi.advanceTimersByTimeAsync(86_400_000);
    expect(h.deletes).toEqual([]); expect(h.queue()[0].attempts ?? 0).toBe(0);
    expect(h.queue()[0].replacement).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    online = true; await port.configure(); await recSettle(); expect(h.deletes).toEqual([recM]); expect(h.queue()).toEqual([]);
  });
});

describe("authoritative custody observation", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  it("T1 generation-discard preserves a newer token and settles both inactive capabilities", async () => {
    const h = recoveryHome();
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const port = recoverySupervisor({ store: h.store(), send: h.send, connectedAppsBrokerUrl: recUrl,
      admissionStore: createComposioAdmissionStore(h.dir), admissionNow: Date.now, admissionMonotonic: Date.now,
      composioTransport: async (_url, init) => { if (init?.method === "DELETE") { h.deletes.push(new Headers(init.headers).get("authorization")!.slice(7)); return Response.json({}); } h.mints.push(Date.now()); return pending; } });
    recoveryPorts.push(port); const force = port.remintConnectedApps(); await recSettle(); expect(h.mints).toHaveLength(1);
    h.store().patchDurable({ ...recDocument(recN), fluxApiKey: hk("newerowner") });
    release(Response.json({ token: recM, expiresAt: "2099-01-01T00:00:00.000Z" }));
    await force; await recSettle(); await vi.advanceTimersByTimeAsync(15_000);
    expect(h.store().readBack().fluxComposioBrokerToken).toBe(recN);
    expect(h.deletes).toEqual([recM, recP]); expect(h.queue()).toEqual([]); expect(h.mints).toHaveLength(1);
  });
  it("T1 ambiguous save uses durable readback even when the credential cache still reports P", async () => {
    const h = recoveryHome(); const previous = h.store().getAll(); let ambiguous = false, thrown = false;
    const port = recoverySupervisor({ store: { getAll: () => ambiguous ? { ...h.store().getAll(), ...previous } : h.store().getAll(),
      patch: patch => h.store().patch(patch), readBack: () => h.store().readBack(), patchDurable: patch => {
        const result = h.store().patchDurable(patch);
        if (!thrown && patch.fluxComposioBrokerToken === recM) { ambiguous = true; thrown = true; throw new Error("fixture commit then throw"); }
        return result;
      } }, send: h.send, connectedAppsBrokerUrl: recUrl, admissionStore: createComposioAdmissionStore(h.dir), admissionNow: Date.now, admissionMonotonic: Date.now,
      composioTransport: async (_url, init) => { if (init?.method === "DELETE") { h.deletes.push(new Headers(init.headers).get("authorization")!.slice(7)); return Response.json({}); } h.mints.push(Date.now()); return Response.json({ token: recM, expiresAt: "2099-01-01T00:00:00.000Z" }); } });
    recoveryPorts.push(port); await port.remintConnectedApps(); await recSettle(); expect(thrown).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000); await recSettle();
    expect(h.store().readBack().fluxComposioBrokerToken).toBe(recM); expect(h.deletes).toEqual([recP]); expect(h.queue()).toEqual([]); expect(h.mints).toHaveLength(1);
  });
});

describe("recovery faults consume durable reservations", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  it.each(["read", "W3", "W4"])("T4 %s fault consumes three attempts across reopened stores and parks", async stage => {
    const h = recoveryHome();
    h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, previous: recP, replacement: true }]) });
    let observedAttempt = 0, reads = 0, failedRead = false;
    const attach = () => h.attach({
      readBack: () => {
        const document = h.store().readBack(), entry = JSON.parse(document.composioPendingRevocations || "[]")[0];
        if (entry?.attempts !== observedAttempt) { observedAttempt = entry?.attempts ?? 0; reads = 0; failedRead = false; }
        if (stage === "read" && observedAttempt && ++reads === 3 && !failedRead) { failedRead = true; throw new Error("fixture unavailable durable observation"); }
        return document;
      },
      patchDurable: patch => {
        const entries = patch.composioPendingRevocations ? JSON.parse(patch.composioPendingRevocations) : null;
        if (stage === "W3" && entries?.length && !entries[0].replacement) throw new Error("fixture unavailable W3 write");
        if (stage === "W4" && entries?.length === 0) throw new Error("fixture unavailable W4 write");
        return h.store().patchDurable(patch);
      },
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const port = attach(); await port.configure(); await recSettle();
      expect(h.queue()[0].attempts).toBe(attempt); port.dispose(); h.open();
      if (attempt < 3) {
        const at = h.queue()[0].retryAt!; expect(at).toBeGreaterThan(Date.now());
        const before = h.deletes.length, held = attach(); await vi.advanceTimersByTimeAsync(at - Date.now() - 1); await held.configure();
        expect(h.deletes).toHaveLength(before); expect(h.queue()[0].attempts).toBe(attempt); held.dispose();
        await vi.advanceTimersByTimeAsync(1);
      }
    }
    expect(h.queue()[0].exhausted).toBe(true);
    const parked = attach(); const count = h.deletes.length; await parked.configure(); await vi.advanceTimersByTimeAsync(86_400_000);
    expect(h.deletes).toHaveLength(count); expect(h.mints).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    expect(h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:managed-composio").at(-1).admission).toEqual({ outcome: "failed", reason: "credential_recovery_failed", attempted: false });
  });
});

it("T6 explicit owner Retry crosses the generation-bound supervisor port without credentials", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const h = recoveryHome(); h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, previous: recP, replacement: true, attempts: 3, exhausted: true }]) });
  const port = h.attach(); await port.configure(); await recSettle();
  await port.handle({ type: "murage:connected-apps-admission-hello" });
  const generation = h.send.mock.calls.map(([m]) => m).find(m => m.type === "murage:connected-apps-admission-generation").generation;
  h.send.mockClear();
  const requestId = "11111111-1111-4111-8111-111111111111";
  await port.handle({ type: "murage:connected-apps-admission-request", generation, requestId, operation: "recovery-retry" });
  await recSettle();
  const results = h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:connected-apps-admission-result");
  expect(results).toHaveLength(1);
  expect(results[0]).toEqual({ type: "murage:connected-apps-admission-result", generation, requestId, outcome: "completed", reason: "ready", attempted: true, reconnected: false });
  expect(h.queue()).toEqual([]); expect(h.deletes).toEqual([recM]); expect(h.mints).toEqual([]);
});

it("T6 real child facade receives terminal state and sends one explicit Retry through the supervisor", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const child = await import("../composio-lifecycle.ts"), apps = await import("../composio.ts");
  const h = recoveryHome(); h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, previous: recP, replacement: true, attempts: 3, exhausted: true }]) });
  const port = recoverySupervisor({ store: h.store(), connectedAppsBrokerUrl: recUrl,
    send: message => { h.send(message); child.receiveComposioAdmission(message); if ((message as { type?: string }).type === "murage:managed-composio") apps.applyManagedBrokerMessage(message); },
    admissionStore: createComposioAdmissionStore(h.dir), admissionNow: Date.now, admissionMonotonic: Date.now,
    composioTransport: async (_url, init) => { expect(init?.method).toBe("DELETE"); h.deletes.push(new Headers(init?.headers).get("authorization")!.slice(7)); return Response.json({}); } });
  recoveryPorts.push(port);
  child.connectComposioAuthority({ postMessage: message => { void port.handle(message); } });
  try {
    await port.configure(); await recSettle();
    const failed = { outcome: "failed", reason: "credential_recovery_failed", attempted: false };
    expect(child.composioAdmissionStatus()).toEqual(failed);
    expect(apps.connectorPanelFields({} as never, true).admission).toEqual(failed);
    expect(await apps.retryConnectedAppsRecovery()).toEqual({ outcome: "completed", reason: "ready", attempted: true, reconnected: false });
    expect(h.queue()).toEqual([]); expect(h.deletes).toEqual([recM]); expect(h.mints).toEqual([]);
    const results = h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:connected-apps-admission-result");
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]).sort()).toEqual(["attempted", "generation", "outcome", "reason", "reconnected", "requestId", "type"]);
  } finally { child.disconnectComposioAuthority(); child.resetComposioLifecycleForTests(); apps.resetManagedBrokerState(); }
});

it("T4 permanent W1 failure retains live custody, terminates, and explicit Retry never remints", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const h = recoveryHome(); let broken = true;
  const port = h.attach({ patchDurable: patch => {
    if (broken && patch.composioPendingRevocations?.includes('"replacement":true')) throw new Error("fixture W1 storage unavailable");
    return h.store().patchDurable(patch);
  } });
  await port.remintConnectedApps(); await recSettle(); expect(h.mints).toHaveLength(1); expect(h.deletes).toEqual([]);
  for (const delay of [15_000, 30_000, 60_000]) {
    const count = h.mints.length;
    await vi.advanceTimersByTimeAsync(delay - 1); expect(h.mints).toHaveLength(count); expect(h.deletes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await recSettle();
  }
  const failed = () => h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:managed-composio").at(-1).admission;
  expect(failed()).toEqual({ outcome: "failed", reason: "credential_recovery_failed", attempted: false });
  expect(vi.getTimerCount()).toBe(0); await port.configure(); expect(h.mints).toHaveLength(1);
  broken = false; await port.remintConnectedApps(); await recSettle();
  expect(h.mints).toHaveLength(1); expect(h.deletes).toEqual([recP]); expect(h.queue()).toEqual([]);
  expect(h.store().readBack().fluxComposioBrokerToken).toBe(recM);
});

it("T4 a crash after the final reserved W3 preserves exhaustion and both inactive legs", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const h = recoveryHome(); h.store().patch({ fluxComposioBrokerToken: recN,
    composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, previous: recP, replacement: true, attempts: 2 }]) });
  let port!: ReturnType<typeof recoverySupervisor>, cut = false;
  port = h.attach({ patchDurable: patch => {
    const result = h.store().patchDurable(patch);
    if (patch.composioPendingRevocations?.includes('"after"') && !cut) { cut = true; port.dispose(); throw new Error("fixture last reservation W3 crash"); }
    return result;
  } });
  await port.configure(); await recSettle(); expect(cut).toBe(true); expect(h.deletes).toEqual([]);
  h.open(); expect(h.queue()).toEqual([{ fluxBrokerUrl: recUrl, token: recM, attempts: 3, exhausted: true, after: recP }]);
  const reopened = h.attach(); await reopened.configure(); await vi.advanceTimersByTimeAsync(86_400_000);
  expect(h.deletes).toEqual([]); expect(h.mints).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  expect(h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:managed-composio").at(-1).admission).toEqual({ outcome: "failed", reason: "credential_recovery_failed", attempted: false });
});

it("T4 live W3 failure keeps the exclusive save owner and cannot mint another capability", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const h = recoveryHome(); let broken = true;
  const port = h.attach({ patchDurable: patch => {
    const rows = patch.composioPendingRevocations ? JSON.parse(patch.composioPendingRevocations) : [];
    if (broken && rows.some((entry: { token: string; replacement?: boolean }) => entry.token === recP && !entry.replacement)) throw new Error("fixture live W3 unavailable");
    return h.store().patchDurable(patch);
  } });
  await port.remintConnectedApps(); await recSettle();
  expect(h.mints).toHaveLength(1); expect(h.deletes).toEqual([]); expect(h.queue()[0].replacement).toBe(true);
  for (const delay of [15_000, 30_000, 60_000]) { await vi.advanceTimersByTimeAsync(delay - 1); expect(h.mints).toHaveLength(1); await vi.advanceTimersByTimeAsync(1); await recSettle(); }
  expect(vi.getTimerCount()).toBe(0); expect(h.queue()[0]).toMatchObject({ token: recM, attempts: 3, exhausted: true, previous: recP, replacement: true });
  expect(h.send.mock.calls.map(([m]) => m).filter(m => m.type === "murage:managed-composio").at(-1).admission).toEqual({ outcome: "failed", reason: "credential_recovery_failed", attempted: false });
  broken = false; await port.remintConnectedApps(); await recSettle();
  expect(h.queue()).toEqual([]); expect(h.mints).toHaveLength(1); expect(h.deletes).toEqual([recP]);
  expect(h.store().readBack().fluxComposioBrokerToken).toBe(recM);
});

it.each(["W1-after", "W2-before", "W2-after"])("T1 first mint %s restarts without inventing a previous capability", async cutAt => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const h = recoveryHome(); h.store().patch({ fluxComposioBrokerToken: "" });
  let port!: ReturnType<typeof recoverySupervisor>, cut = false;
  port = h.attach({ patchDurable: patch => {
    const reached = !cut && (cutAt === "W1-after" ? patch.composioPendingRevocations?.includes('"replacement":true') : patch.fluxComposioBrokerToken === recM);
    if (reached && cutAt === "W2-before") { cut = true; port.dispose(); throw new Error("fixture first mint before W2"); }
    const result = h.store().patchDurable(patch);
    if (reached) { cut = true; port.dispose(); throw new Error("fixture first mint after write"); }
    return result;
  } });
  await port.configure(); await recSettle(); expect(cut).toBe(true); expect(h.mints).toHaveLength(1);
  h.open(); const active = h.store().readBack().fluxComposioBrokerToken;
  const reopened = h.attach(); await reopened.configure(); await vi.advanceTimersByTimeAsync(30_000);
  expect(h.deletes).toEqual(active === recM ? [] : [recM]);
  expect(h.queue()).toEqual([]); expect(h.mints).toHaveLength(1); expect(h.deletes).not.toContain(recP);
  expect(h.store().readBack().fluxComposioBrokerToken).toBe(active);
});


// Owners: composio-429-j owns the queue and supervisor regression consumer.
describe("J lifecycle queue through the real supervisor", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  it("J three overlapping intents keep cleanup, refresh and reconnect strictly serialized", async () => {
    const h = recoveryHome();
    h.store().patch({ composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: recUrl, token: recM, retryAt: Date.now() + 15_000 }]) });
    let finishDelete!: () => void;
    const replies: Array<() => void> = [];
    let active = 0, maximum = 0;
    const port = recoverySupervisor({ store: h.store(), send: h.send, connectedAppsBrokerUrl: recUrl,
      admissionStore: createComposioAdmissionStore(h.dir), admissionNow: Date.now, admissionMonotonic: Date.now,
      composioTransport: async (_url, init) => {
        maximum = Math.max(maximum, ++active);
        try {
          if (init?.method === "DELETE") {
            const token = new Headers(init.headers).get("authorization")!.slice(7); h.deletes.push(token);
            if (token === recM) await new Promise<void>(resolve => { finishDelete = resolve; });
            return Response.json({});
          }
          const token = (h.mints.length ? "f" : "e").repeat(64); h.mints.push(Date.now());
          await new Promise<void>(resolve => { replies.push(resolve); });
          return Response.json({ token, expiresAt: "2099-01-01T00:00:00.000Z" });
        } finally { active--; }
      } });
    recoveryPorts.push(port);
    await port.configure(); await vi.advanceTimersByTimeAsync(15_000); await recSettle();
    expect(h.deletes).toEqual([recM]); expect(active).toBe(1);
    h.store().patch({ fluxComposioBrokerTokenExpiresAt: "2000-01-01T00:00:00.000Z" });
    const refresh = port.configure(); await recSettle();
    const reconnect = port.remintConnectedApps(); await recSettle();
    expect(h.mints).toEqual([]);
    finishDelete(); await recSettle();
    expect(h.mints, "only the queue head may mint after cleanup settles").toHaveLength(1);
    expect(maximum).toBe(1);
    replies[0](); await refresh; await recSettle();
    expect(h.mints).toHaveLength(2); expect(maximum).toBe(1);
    replies[1](); await reconnect; await recSettle();
    expect(h.deletes).toEqual([recM, recP, "e".repeat(64)]);
    expect(h.queue()).toEqual([]); expect(h.store().readBack().fluxComposioBrokerToken).toBe("f".repeat(64));
  });
  it("J queued timeout returns while A hangs and retains the writer fence after timeout", async () => {
    const h = recoveryHome(); let release!: (response: Response) => void;
    const port = recoverySupervisor({ store: h.store(), send: h.send, connectedAppsBrokerUrl: recUrl,
      admissionStore: createComposioAdmissionStore(h.dir), admissionNow: Date.now, admissionMonotonic: Date.now,
      composioTransport: async (_url, init) => {
        if (init?.method === "DELETE") { h.deletes.push(new Headers(init.headers).get("authorization")!.slice(7)); return Response.json({}); }
        h.mints.push(Date.now()); return new Promise<Response>(resolve => { release = resolve; });
      } });
    recoveryPorts.push(port);
    const running = port.remintConnectedApps(); await recSettle(); expect(h.mints).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    let returned = false;
    const queued = port.configure().then(() => { returned = true; }); await recSettle();
    await vi.advanceTimersByTimeAsync(29_999); expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await recSettle();
    expect(returned, "queued callers have a deadline even while the preceding pass never settles").toBe(true);
    await queued; await running;
    await port.remintConnectedApps(); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.mints).toHaveLength(1); expect(h.deletes).toEqual([]);
    release(Response.json({ token: recM, expiresAt: "2099-01-01T00:00:00.000Z" })); await recSettle();
    expect(h.mints).toHaveLength(1); expect(h.store().readBack().fluxComposioBrokerToken).toBe(recP);
    expect(h.queue()[0]).toMatchObject({ token: recM, previous: recP, replacement: true });
    await port.remintConnectedApps(); await recSettle();
    expect(h.mints).toHaveLength(1); expect(h.queue()).toEqual([]); expect(h.deletes).toEqual([recP]);
    expect(h.store().readBack().fluxComposioBrokerToken).toBe(recM);
  });
});
