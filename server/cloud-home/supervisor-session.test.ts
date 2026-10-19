import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHomeSupervisorSession } from "./supervisor-session.ts";
import { createHomeModelSignIn, CLOUD_MODEL_SIGNINS_KEY } from "./model-signin.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { SealedSecretStore } from "./secrets.ts";
import { superviseHome } from "./supervisor.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const actor = { environmentId: "fixture-home", deviceId: "fixture-phone" };
const challenge = { device_code: "private-device", user_code: "CODE-1", verification_uri: "https://auth.x.ai/device", expires_in: 900, interval: 5 };
const tokens = { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id", expires_in: 3600 };
let cleanup: Array<() => void>;
beforeEach(() => { cleanup = []; vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { for (const fn of cleanup.reverse()) fn(); vi.useRealTimers(); });
function child() {
  return Object.assign(new EventEmitter(), { connected: true, send: vi.fn(), kill: vi.fn(), stdio: [null, null, null, new PassThrough()] });
}
function fixture(replies: Array<Response | (() => Promise<Response>)> = [], broker?: Parameters<typeof createSupervisorPort>[0]["remintConnectedApps"]) {
  const directory = mkdtempSync(join(tmpdir(), "home-session-"));
  const store = new SealedSecretStore(directory, "fixture-home", Buffer.alloc(32, 7));
  store.patch({ fluxApiKey: "fixture-flux" });
  const writes = vi.spyOn(store, "patch"), close = vi.spyOn(store, "close");
  const fetcher = vi.fn(async () => { const reply = replies.shift(); if (!reply) throw new Error("unexpected fixture request"); return typeof reply === "function" ? reply() : reply; });
  let manager!: ReturnType<typeof createHomeModelSignIn>;
  let port!: ReturnType<typeof createSupervisorPort>;
  const modelSignInFactory = vi.fn((options: Parameters<typeof createHomeModelSignIn>[0]) => (manager = createHomeModelSignIn({ ...options, env: {}, fetch: fetcher as typeof fetch })));
  const remint = vi.fn<NonNullable<Parameters<typeof createSupervisorPort>[0]["remintConnectedApps"]>>(broker ?? (async () => ({ fluxComposioBrokerToken: "fixture-broker" })));
  const portFactory = vi.fn((options: Parameters<typeof createSupervisorPort>[0]) => (port = createSupervisorPort({ ...options, remintConnectedApps: remint, now: Date.now })));
  const session = createHomeSupervisorSession({ store, bootstrapSecret: "fixture-bootstrap", modelSignInFactory, portFactory });
  cleanup.push(() => { session.close(); removeTempDirSync(directory); });
  return { session, store, writes, close, fetcher, remint, modelSignInFactory, portFactory, manager, port };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
const attach = (h: ReturnType<typeof fixture>, c: ReturnType<typeof child>) => h.session.attachChild(c as unknown as ChildProcess);
const ready = (c: ReturnType<typeof child>) => c.emit("message", { type: "murage:cloud-model-signin-ready" });
const modelMessages = (c: ReturnType<typeof child>) => c.send.mock.calls.map(([message]) => message).filter(message => message.type === "murage:model-signin");

describe("home supervisor lifetime", () => {
  it("retains one manager, port and forced broker backoff across exit-75 restarts", async () => {
    const h = fixture(), children: ReturnType<typeof child>[] = [];
    const stop = superviseHome({ env: {}, serverCommand: "fixture", serverArgs: [], envelope: h.session.envelope, attach: h.session.attachChild,
      spawnChild: (() => { const c = child(); children.push(c); return c; }) as never, onStop: () => h.session.close() });
    await settle();
    children[0].emit("message", { type: "murage:flux-composio-token-rejected" }); await settle();
    children[0].emit("exit", 75); await settle();
    children[1].emit("message", { type: "murage:flux-composio-token-rejected" }); await settle();
    expect(h.modelSignInFactory).toHaveBeenCalledTimes(1); expect(h.portFactory).toHaveBeenCalledTimes(1);
    expect(h.remint.mock.calls.filter(([, options]) => options.force)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600_000);
    children[1].emit("message", { type: "murage:flux-composio-token-rejected" }); await settle();
    expect(h.remint.mock.calls.filter(([, options]) => options.force)).toHaveLength(2);
    stop(); stop(); expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("waits for gateway READY then replays only private access entries after restart", async () => {
    const h = fixture([Response.json(challenge), Response.json(tokens)]), first = child(), second = child();
    attach(h, first); await settle();
    await h.manager.dispatch({ operation: "start", provider: "supergrok", actor }, 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(modelMessages(first)).toEqual([]);
    const envelope = JSON.parse(h.session.envelope());
    expect(envelope.credentials).not.toHaveProperty(CLOUD_MODEL_SIGNINS_KEY);
    for (const token of Object.values(tokens).filter(value => typeof value === "string")) expect(h.session.envelope()).not.toContain(token);
    ready(first); await settle();
    expect(JSON.stringify(modelMessages(first))).toContain(tokens.access_token);
    expect(JSON.stringify(modelMessages(first))).not.toContain(tokens.refresh_token);
    expect(JSON.stringify(modelMessages(first))).not.toContain(tokens.id_token);
    const firstCount = modelMessages(first).length;
    attach(h, second); await settle();
    expect(modelMessages(second)).toEqual([]);
    first.emit("disconnect"); ready(first); ready(second); await settle();
    expect(modelMessages(first)).toHaveLength(firstCount);
    expect(JSON.stringify(modelMessages(second))).toContain(tokens.access_token);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it("disconnects pending old-generation acquisition without cancelling the new child's flow", async () => {
    const h = fixture([Response.json(challenge), Response.json(challenge)]), first = child(), second = child();
    attach(h, first); await settle();
    const old = await h.manager.dispatch({ operation: "start", provider: "supergrok", actor }, 1) as { attemptId: string };
    attach(h, second); await settle();
    const newActor = { ...actor, deviceId: "other-fixture-phone" };
    const current = await h.manager.dispatch({ operation: "start", provider: "supergrok", actor: newActor }, 2) as { attemptId: string };
    first.emit("disconnect"); first.emit("exit", 1);
    expect(await h.manager.dispatch({ operation: "attempt", provider: "supergrok", attemptId: old.attemptId, actor })).toMatchObject({ state: "cancelled" });
    expect(await h.manager.dispatch({ operation: "attempt", provider: "supergrok", attemptId: current.attemptId, actor: newActor })).toMatchObject({ state: "waiting" });
    second.emit("disconnect");
    expect(await h.manager.dispatch({ operation: "attempt", provider: "supergrok", attemptId: current.attemptId, actor: newActor })).toMatchObject({ state: "cancelled" });
  });

  it("shuts down during provider refresh without writing or publishing its late token", async () => {
    let release!: (response: Response) => void;
    const h = fixture([Response.json(challenge), Response.json(tokens), () => new Promise(resolve => { release = resolve; })]), c = child();
    attach(h, c); await settle(); ready(c); await settle();
    await h.manager.dispatch({ operation: "start", provider: "supergrok", actor }, 1);
    await vi.advanceTimersByTimeAsync(5000);
    const refresh = h.manager.internalRefresh("supergrok");
    const writes = h.writes.mock.calls.length, messages = c.send.mock.calls.length;
    h.session.close();
    release(Response.json({ access_token: "late-access", refresh_token: "late-refresh", expires_in: 3600 }));
    await refresh; await settle();
    expect(h.writes).toHaveBeenCalledTimes(writes); expect(c.send).toHaveBeenCalledTimes(messages);
    expect(h.store.getAll()).toEqual({}); expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes owners before closing the sealed store and ignores a delayed broker completion", async () => {
    let release!: (credentials: Record<string, string>) => void;
    const h = fixture([], () => new Promise(resolve => { release = resolve; })), c = child();
    const managerDispose = vi.spyOn(h.manager, "dispose"), portDispose = vi.spyOn(h.port, "dispose");
    attach(h, c); await settle();
    const writes = h.writes.mock.calls.length;
    h.session.close(); h.session.close();
    expect(managerDispose).toHaveBeenCalledTimes(1); expect(portDispose).toHaveBeenCalledTimes(1); expect(h.close).toHaveBeenCalledTimes(1);
    expect(managerDispose.mock.invocationCallOrder[0]).toBeLessThan(portDispose.mock.invocationCallOrder[0]);
    expect(portDispose.mock.invocationCallOrder[0]).toBeLessThan(h.close.mock.invocationCallOrder[0]);
    release({ fluxComposioBrokerToken: "late-broker" }); await settle();
    expect(h.writes).toHaveBeenCalledTimes(writes); expect(h.store.getAll()).toEqual({});
    expect(c.send).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(() => attach(h, child())).toThrow("closed");
  });
});
