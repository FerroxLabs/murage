import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createSupervisorPort, CLOUD_PRIVATE_MESSAGE_TYPES } from "./supervisor-port.ts";
import { cloudHomeCopy } from "./copy.ts";
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
    expect(f.send.mock.calls.map(call => call[0].type)).toEqual(["murage:provider-bank-fence", "murage:cloud-credential-result", "murage:provider-bank-fence"]);
    expect(f.send.mock.calls[0][0].held).toBe(true); expect(f.send.mock.calls[2][0].held).toBe(false);
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
