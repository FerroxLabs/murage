import { createChatsReaderAuthority } from "../../shared/chats-reader-proof.ts";
// COMPANION-CHATS-1019 sections 11–12: the browser's read capability is never owner authority.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as routes from "../src/routes.ts";
import { createBrowserHandler, forwardedHeaders } from "../src/browser.ts";
import { createProxyHandler } from "../src/proxy.ts";
import { DeviceRegistry, DEMO_HOST_MARKER, SESSION_IDLE_MS, SESSION_RENEWAL_DUE_MS } from "../src/devices.ts";
import { DATA_DIR } from "../src/state.ts";

const token = "c".repeat(64), forged = "a".repeat(64);
const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const server of servers.splice(0).reverse()) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
const denied = (path: string, search = "", extra = {}) => routes.denyReason({ surface: "browser", authenticated: true, chatsReader: true, method: "GET", path, search, ...extra });
describe("chats reader route boundary", () => {
  it("T1/T2 admits only eligible authenticated browser reads", () => {
    expect(denied("/api/chats")).toBeNull();
    expect(denied("/api/search", "?view=chats&q=abc&limit=40")).toBeNull();
    for (const path of ["/api/chats", "/api/search"]) {
      expect(denied(path, "?view=chats&q=abc", { chatsReader: false })?.status).toBe(404);
      expect(denied(path, "?view=chats&q=abc", { authenticated: false })).toMatchObject({ status: 401, signIn: "/enter" });
    }
  });
  it.each(["q=ab", "q=%61%62", "q=ab&q=abcd", `q=${"a".repeat(501)}`, "q=abc&limit=0", "q=abc&limit=41", "q=abc&limit=1.5", "q=abc&view=all", "q=abc", "q=abc&VIEW=chats"])("T3 rejects search %s", search => {
    const query = /view=|VIEW=/.test(search) || search === "q=abc" ? search : `view=chats&${search}`;
    expect(denied("/api/search", `?${query}`)?.status).toBe(404);
  });
  it.each(["1e1", "0x10", "+40", " 40", "40.0", "40&limit=41"])("T3 shares Number/first-value semantics: %s", limit => {
    expect(denied("/api/search", `?view=chats&view=all&q=abc&limit=${limit}`)).toBeNull();
  });
  it.each(["0", "51", "1.5", "nope"])("T3 list cap rejects %s", limit => expect(denied("/api/chats", `?limit=${limit}`)?.status).toBe(404));
  it("T5 proof has exactly the permitted scope", () => {
    const proof = (routes as any).chatsReaderHeaders;
    expect(proof).toBeTypeOf("function");
    // MAIN RULING 1115-SOURCE-PINS-GROK A3: every permitted read carries a separately minted proof.
    for (const path of ["/api/chats", "/api/search", "/api/events"]) {
      const headers = proof("GET", path, token);
      expect(Object.keys(headers)).toEqual(["x-murage-chats-reader"]);
      expect(headers["x-murage-chats-reader"]).not.toBe(token);
      expect(createChatsReaderAuthority(token).verify(headers["x-murage-chats-reader"])).toBe(true);
    }
    for (const [method, path, secret] of [["GET", "/api/bots", token], ["POST", "/api/search", token], ["GET", "/api/threads/x/messages", token], ["GET", "/api/chats", "bad"]]) expect(proof(method, path, secret)).toEqual({});
    for (const path of ["/api/chats", "/api/events"]) expect(routes.browserProofHeaders("GET", path, token)).toEqual({});
  });
  it("T12 device proof and bounds remain unchanged", () => {
    for (const path of ["/api/bots", "/api/events", "/api/chats", "/api/search"]) expect(routes.deviceProofHeaders("GET", path, token)).toEqual({ "x-murage-companion-token": token });
    expect(denied("/api/chats", "?limit=200", { surface: "device" })).toBeNull();
    for (const [search, allowed] of [["?view=chats&q=abc&limit=40", true], ["?view=chats&q=ab", false], ["?view=chats&q=abc&limit=41", false], ["?q=abc", false]] as const) expect(denied("/api/search", search, { surface: "device" }) === null).toBe(allowed);
  });
  it("T7a allowlists headers including duplicates and mixed case", () => {
    const headers: Record<string, any> = { accept: "application/json" };
    for (const key of ["chats-reader", "companion-token", "door-token", "surface", "stream-principal", "approval-device", "approval-signature"]) {
      headers[`x-murage-${key}`] = [forged, forged]; headers[`X-Murage-${key}`] = forged;
    }
    expect(forwardedHeaders({ headers } as IncomingMessage)).toEqual({ accept: "application/json", "x-murage-companion": "1" });
  });
});

async function fixture(secret: string | undefined = token, registry = new DeviceRegistry()) {
  const seen: { url: string; headers: IncomingMessage["headers"] }[] = [];
  const held: ServerResponse[] = [];
  let holding = false;
  const harnessPort = await listen(createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    if (holding) { held.push(res); return; }
    res.writeHead(req.headers["x-murage-chats-reader"] || !req.url?.startsWith("/api/chats") ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify({ chats: [], hits: [], next: "opaque_cursor" }));
  }));
  const port = await listen(createServer(createBrowserHandler({ harnessPort, companionToken: secret, devices: registry, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }) })));
  const base = `http://127.0.0.1:${port}`;
  const paired = registry.redeem(registry.openPairing().code, "Reader");
  if ("error" in paired) throw new Error(paired.error);
  const opened = registry.openSession(paired.device.id, "Fixture")!;
  const request = (path: string, value: string | null = opened.value, headers = {}) => fetch(base + path, { headers: { ...(value ? { cookie: `murage_session=${value}` } : {}), ...headers } });
  return { base, seen, held, registry, opened, paired, request, harnessPort, hold: () => { holding = true; }, release: () => { for (const res of held.splice(0)) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"secret":"held-body"}'); } } };
}
const search = "/api/search?view=chats&q=abc&limit=40";
it("T6/T7b forwards proof only on allowed reads; keeps cursor and no-store", async () => {
  const f = await fixture();
  for (const path of ["/api/chats?limit=50", search + "&before=opaque_cursor", "/api/events"]) {
    const response = await f.request(path, f.opened.value, { "x-murage-chats-reader": forged });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json() as {next:string}).next).toBe("opaque_cursor");
    expect(f.seen.at(-1)?.url).toBe(path);
    // MAIN RULING 1115-SOURCE-PINS-GROK A3: the sidecar replaces a supplied forgery with a fresh chats-only proof.
    expect(f.seen.at(-1)?.headers).toMatchObject({ "x-murage-companion": "1" });
    const forwarded = f.seen.at(-1)?.headers["x-murage-chats-reader"];
    expect(forwarded).not.toBe(token);
    expect(forwarded).not.toBe(forged);
    expect(createChatsReaderAuthority(token).verify(forwarded)).toBe(true);
    expect(f.seen.at(-1)?.headers["x-murage-companion-token"]).toBeUndefined();
  }
  await f.request("/api/bots", f.opened.value, { "x-murage-chats-reader": forged });
  expect(f.seen.at(-1)?.headers["x-murage-chats-reader"]).toBeUndefined();
});
it("T7c no launch secret does not forward a forged proof", async () => {
  const f = await fixture(""); const response = await f.request("/api/chats", f.opened.value, { "x-murage-chats-reader": forged });
  expect(response.status).toBe(404); expect(f.seen).toHaveLength(1); expect(f.seen[0].headers["x-murage-chats-reader"]).toBeUndefined();
});
it("T7d device door strips client reader headers", async () => {
  const f = await fixture();
  const port = await listen(createServer(createProxyHandler({ harnessPort: f.harnessPort, companionToken: token, authenticate: () => ({cloudDesktopAccess:false}), redeem: () => ({ error: "unused" }), serverName: () => "Fixture" })));
  await fetch(`http://127.0.0.1:${port}/api/bots`, { headers: { authorization: "Bearer fake", "x-murage-chats-reader": forged } });
  expect(f.seen).toHaveLength(1); expect(f.seen[0].headers["x-murage-chats-reader"]).toBeUndefined();
});
it("T4/T9 refuses cookies and origins before forwarding, always no-store", async () => {
  const f = await fixture();
  for (const path of ["/api/chats", search]) {
    for (const cookie of [null, "bad"]) { const r = await f.request(path, cookie, { "x-murage-chats-reader": forged }); expect(r.status).toBe(401); expect(r.headers.get("cache-control")).toBe("private, no-store"); }
    for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { host: "foreign.invalid" }]) {
      const status = await new Promise<number>(resolve => { const req = httpRequest(f.base + path, { headers: { cookie: `murage_session=${f.opened.value}`, ...headers } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
      expect(status).toBe(403);
    }
  }
  const r = await f.request("/api/search?q=abc"); expect(r.status).toBe(404); expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(f.seen).toHaveLength(0);
});
it("T11 diagnostic refusal logs contain no query, Referer path or malformed Origin", async () => {
  const f = await fixture(); vi.stubEnv("MURAGE_DOOR_DIAGNOSE", "1");
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const sentinel = "SENTINEL-7f3";
  expect((await f.request(`/api/search?q=${sentinel}`, f.opened.value, { "sec-fetch-site": "cross-site", referer: `https://foreign.invalid/path?q=${sentinel}`, origin: `https://foreign.invalid/${sentinel}` })).status).toBe(403);
  expect(spy).toHaveBeenCalled(); expect(JSON.stringify(spy.mock.calls)).not.toContain(sentinel);
});
it("D1 real demo session has no chats reads or stream proof", async () => {
  mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(join(DATA_DIR, DEMO_HOST_MARKER), "demo\n", { mode: 0o600 });
  vi.stubEnv("MURAGE_DEMO_HOST", "1"); vi.stubEnv("MURAGE_DEMO_PAIRING_CODE", "483920");
  const f = await fixture(); const demo = f.registry.redeem("483920", "Demo");
  expect("error" in demo).toBe(false); if ("error" in demo) return;
  expect(demo.device.demo).toBe(true); const session = f.registry.openSession(demo.device.id, "Demo")!;
  for (const path of ["/api/chats", search]) expect((await f.request(path, session.value)).status).toBe(404);
  await f.request("/api/events", session.value); expect(f.seen.at(-1)?.headers["x-murage-chats-reader"]).toBeUndefined();
});
it("T10/L1/L2/L3 budgets refill, isolate sessions and survive cookie renewal", async () => {
  const f = await fixture(); let now = Date.now() + SESSION_RENEWAL_DUE_MS + 1; vi.spyOn(Date, "now").mockImplementation(() => now);
  for (let n = 0; n < 30; n++) expect((await f.request(search)).status).toBe(200);
  const limited = await f.request(search); expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("1"); expect(limited.headers.get("cache-control")).toBe("private, no-store"); expect(f.seen).toHaveLength(30);
  const second = f.registry.openSession(f.paired.device.id, "Second")!; expect((await f.request(search, second.value)).status).toBe(200);
  const renewed = f.registry.renewSession(f.opened.value)!; f.registry.resolveSession(renewed.value);
  expect((await f.request(search, renewed.value)).status).toBe(429);
  expect((await f.request(search)).status).toBe(401);
  now += 1000; expect((await f.request(search, renewed.value)).status).toBe(200);
  for (let n = 0; n < 60; n++) expect((await f.request("/api/chats", renewed.value)).status).toBe(200);
  expect((await f.request("/api/chats", renewed.value)).status).toBe(429);
  now += 60_000; expect((await f.request("/api/chats", renewed.value)).status).toBe(200);
});
it("L5 fifth in-flight read never reaches the harness and capacity releases", async () => {
  const f = await fixture(); f.hold();
  const pending = Array.from({ length: 4 }, (_, n) => f.request(n % 2 ? search : "/api/chats"));
  try { await expect.poll(() => f.held.length).toBe(4); const r = await f.request(search); expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBe("1"); expect(f.seen).toHaveLength(4); }
  finally { f.release(); await Promise.all(pending); }
  const next = f.request("/api/chats");
  try { await expect.poll(() => f.held.length).toBe(1); expect(f.seen).toHaveLength(5); }
  finally { f.release(); }
  expect((await next).status).toBe(200);
});
it.each(["revoke", "signout", "expire", "renew"])("T8 %s during a held reply", async action => {
  const f = await fixture(); let now = Date.now() + SESSION_RENEWAL_DUE_MS + 1; vi.spyOn(Date, "now").mockImplementation(() => now); f.hold();
  const pending = f.request("/api/chats"); await expect.poll(() => f.held.length).toBe(1);
  if (action === "revoke") f.registry.revoke(f.paired.device.id);
  if (action === "signout") f.registry.closeSession(f.opened.value);
  if (action === "expire") now += SESSION_IDLE_MS + 1;
  if (action === "renew") { const renewed = f.registry.renewSession(f.opened.value)!; f.registry.resolveSession(renewed.value); }
  f.release(); const r = await pending; expect(r.status).toBe(action === "renew" ? 200 : 401);
  if (action !== "renew") expect(await r.text()).not.toContain("held-body");
});
it("L4 session end deletes its budget; reused record id starts fresh", async () => {
  const { createChatsReadLimiter } = await import("../src/browser.ts");
  expect(createChatsReadLimiter).toBeTypeOf("function");
  const limiter = createChatsReadLimiter();
  for (let n = 0; n < 30; n++) { const permit = limiter.take("session", true, 0); expect("release" in permit).toBe(true); if ("release" in permit) permit.release(); }
  expect(limiter.take("session", true, 0)).toEqual({retryAfter:1});
  limiter.forget("session"); const fresh = limiter.take("session", true, 0); expect("release" in fresh).toBe(true); if ("release" in fresh) fresh.release();
});
it("L4 the handler forgets a bucket on the session-ended notification", async () => {
  const f=await fixture(); const live=f.registry.resolveSession(f.opened.value)!;
  let ended: ((event:{deviceId:string;sessionId:string})=>void) | undefined;
  const port=await listen(createServer(createBrowserHandler({harnessPort:f.harnessPort,companionToken:token,identity:()=>({scheme:"http",hosts:new Set(["127.0.0.1"])}),devices:{
    resolveSession:()=>live, sessionDeadline:()=>Date.now()+60_000,
    onSessionEnded:listener=>{ended=listener;return ()=>{};},
    redeem:()=>({error:"unused"}),openSession:()=>null,closeSession:()=>false,renewSession:()=>null,signOutDevice:()=>null,
    issuePushTokens:()=>null,pushBinding:()=>null,approvalIdentity:()=>null,authenticatePush:()=>null,
  }})));
  vi.spyOn(Date,"now").mockReturnValue(Date.now());
  const read=()=>fetch(`http://127.0.0.1:${port}${search}`);
  for(let n=0;n<30;n++) expect((await read()).status).toBe(200);
  expect((await read()).status).toBe(429);
  expect(ended).toBeTypeOf("function"); ended!({deviceId:live.device.id,sessionId:live.sessionId});
  expect((await read()).status).toBe(200);
});
