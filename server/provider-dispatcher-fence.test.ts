import { afterEach, afterAll, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import type { Dispatcher } from "undici";
import { providerDispatcher } from "./provider-dispatcher.ts";
import { releaseNativeWire, preflightNativeRequest } from "./drivers/engine-input.ts";
import { consumingFixture } from "./testing/consuming-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
const transports = new Set<Dispatcher>();
afterAll(async () => { for (const transport of transports) await transport.close(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
type Fence = <T>(bytes: string | Uint8Array, write: () => T) => T;
const dispatcher = providerDispatcher as (target: string, fence: Fence) => Dispatcher;
async function fixture() {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(body); res.end("accepted");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  return { url, requests };
}

it("checks the retained ledger after connection setup, before actual HTTP request bytes", async () => {
  const peer = await fixture(), f = consumingFixture(); cleanup.push(() => f.close());
  const transport = dispatcher(peer.url, (wire, write) => releaseNativeWire(f.binding, "openai:fetch", wire, write));
  transports.add(transport);
  const sending = fetch(peer.url, { method: "POST", body: "private prompt", dispatcher: transport } as RequestInit);
  // fetch queued connection setup and returned. The old fetch-entry gate has
  // already committed, but no connected socket has accepted these bytes.
  f.flip();
  await expect(sending).rejects.toThrow();
  expect(peer.requests).toEqual([]);
  expect(f.refusals).toBeGreaterThan(0);
});

it("holds the SQLite writer across connected socket acceptance", async () => {
  const peer = await fixture(), f = consumingFixture(); cleanup.push(() => f.close());
  let releases = 0;
  const transport = dispatcher(peer.url, (wire, write) => releaseNativeWire(f.binding, "openai:fetch", wire, () => {
    releases++;
    expect(f.f.db.isTransaction).toBe(true);
    return write();
  }));
  transports.add(transport);
  const result = await fetch(peer.url, { method: "POST", body: "live prompt", dispatcher: transport } as RequestInit).catch(error => { console.error("HTTP control transport", error, error?.cause); throw error; });
  expect(await result.text()).toBe("accepted");
  expect(peer.requests).toEqual(["live prompt"]);
  expect(releases).toBeGreaterThan(0);
  expect(f.refusals).toBe(0);
});


it("checks the origin write after an HTTP proxy has finished its held tunnel setup", async () => {
  const peer = await fixture(), f = consumingFixture(); cleanup.push(() => f.close());
  const sockets = new Set<Duplex>();
  let resume!: () => void, connected!: () => void;
  const barrier = new Promise<void>(resolve => { connected = resolve; });
  const proxy = createServer();
  proxy.on("connect", (_request, client, head) => {
    sockets.add(client); client.on("error", () => {});
    expect(head.byteLength).toBe(0);
    resume = () => {
      const upstream = createConnection({ host: "127.0.0.1", port: Number(new URL(peer.url).port) });
      sockets.add(upstream); upstream.on("error", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
      });
    };
    connected();
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); proxy.close(() => resolve()); }));
  const address = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  vi.stubEnv("NODE_USE_ENV_PROXY", "1");
  vi.stubEnv("HTTP_PROXY", address); vi.stubEnv("http_proxy", address);
  vi.stubEnv("NO_PROXY", ""); vi.stubEnv("no_proxy", "");
  const target = "http://fence.fixture.invalid/";
  const transport = dispatcher(target, (wire, write) => releaseNativeWire(f.binding, "openai:fetch", wire, write));
  transports.add(transport);
  const pending = fetch(target, { method: "POST", body: "private proxy prompt", dispatcher: transport } as RequestInit);
  await barrier;
  f.flip(); resume();
  await expect(pending).rejects.toThrow();
  expect(peer.requests).toEqual([]);
  expect(f.refusals).toBeGreaterThan(0);
});


it("request preparation checks context without charging released bytes or attempts", () => {
  const f = consumingFixture(); cleanup.push(() => f.close());
  preflightNativeRequest(f.binding, "openai:fetch", "prepared prompt");
  expect(f.budget.counts.attempts).toBe(0);
  expect(f.budget.counts.bytes).toBe(0);
  f.flip();
  expect(() => preflightNativeRequest(f.binding, "openai:fetch", "prepared prompt")).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.budget.counts.attempts).toBe(0);
  expect(f.budget.counts.bytes).toBe(0);
});
