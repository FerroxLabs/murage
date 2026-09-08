import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { listToolkits, relayMcp, setManagedBrokerAccess } from "./composio.ts";

let server: Server, base: string;
let count = 0, catalogueCalls = 0;
const requests: Array<{ path: string; session?: string; key?: string; authorization?: string }> = [];
let holdCatalog: (() => void) | null = null;
let heldCatalog: Promise<void> | null = null;
let holdMcp: (() => void) | null = null;
let heldMcp: Promise<void> | null = null;
let catalogArrived: (() => void) | null = null;
let mcpArrived: (() => void) | null = null;
let onProjectSession: (() => void) | null = null;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    requests.push({ path: url.pathname, session: req.headers["mcp-session-id"] as string | undefined, key: req.headers["x-api-key"] as string | undefined, authorization: req.headers.authorization });
    for await (const _chunk of req) { /* drain request */ }
    res.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/toolkits") || url.pathname.endsWith("/v1/catalog")) {
      catalogueCalls++;
      const label = String(req.headers["x-api-key"] ?? req.headers.authorization);
      if (heldCatalog) { const pending = heldCatalog; heldCatalog = null; catalogArrived?.(); await pending; }
      res.end(JSON.stringify({ items: [{ slug: label.includes("fixture-b") || label.includes("bbbb") ? "catalog-b" : "catalog-a", name: "Fixture catalogue" }] }));
      return;
    }
    if (url.pathname.includes("/tool_router/session/")) {
      onProjectSession?.();
      const id = url.pathname.split("/").at(-1);
      res.end(JSON.stringify({ session_id: id, mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/" + id + "/mcp" }, config: { user_id: "fixture-user", multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } } }));
      return;
    }
    if (heldMcp) { const pending = heldMcp; heldMcp = null; mcpArrived?.(); await pending; }
    res.setHeader("mcp-session-id", "transport-" + ++count);
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  base = "http://127.0.0.1:" + address.port;
  process.env.MURAGE_COMPOSIO_API = base;
  process.env.MURAGE_COMPOSIO_TOOLKITS_API = base;
  const localFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === base) return localFetch(input, init);
    if (url.origin === "https://app.composio.dev" && url.pathname.startsWith("/tool_router/v3/")) {
      return localFetch(base + "/mcp/" + url.pathname.split("/")[3], init);
    }
    throw new Error("Unexpected external request in Composio identity fixture");
  });
});
afterAll(async () => { vi.unstubAllGlobals(); setManagedBrokerAccess(null); delete process.env.MURAGE_COMPOSIO_API; delete process.env.MURAGE_COMPOSIO_TOOLKITS_API; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { setManagedBrokerAccess(null); requests.length = 0; catalogueCalls = 0; heldCatalog = null; heldMcp = null; onProjectSession = null; });
const project = (key: string, id = "session-a") => ({ composio: { apiKey: key, userId: "fixture-user", sessionId: id } });
const payload = { jsonrpc: "2.0", id: 1, method: "tools/list" };

it("rechecks permission after asynchronous session setup and before tool transmission", async () => {
  let allowed = true;
  onProjectSession = () => { allowed = false; };
  const authorize = vi.fn(() => { if (!allowed) throw new Error("owner revoked access"); });
  await expect(relayMcp(project("fixture-c03-revoked", "session-c03-revoked"), payload, undefined, authorize)).rejects.toThrow("owner revoked access");
  expect(authorize).toHaveBeenCalledOnce();
  expect(requests.some(request => request.path.startsWith("/mcp/"))).toBe(false);
  onProjectSession = null; allowed = true;
  const result = await relayMcp(project("fixture-c03-allowed", "session-c03-allowed"), payload, undefined, authorize);
  expect(result.status).toBe(200);
  expect(requests.filter(request => request.path.startsWith("/mcp/"))).toHaveLength(1);
});

it("catalogue cache follows project key and endpoint, then disappears on disconnect", async () => {
  const cfg = project("fixture-a-cache");
  expect((await listToolkits(cfg)).cards[0].slug).toBe("catalog-a");
  cfg.composio.apiKey = "fixture-b-cache";
  expect((await listToolkits(cfg)).cards[0].slug).toBe("catalog-b");
  process.env.MURAGE_COMPOSIO_TOOLKITS_API = base + "/changed";
  await listToolkits(cfg);
  expect(catalogueCalls).toBe(3);
  process.env.MURAGE_COMPOSIO_TOOLKITS_API = base;
  expect((await listToolkits({})).source).toBe("curated");
});
it("transport ownership preserves known sessions but refuses unknown IDs and key/endpoint rotation", async () => {
  const cfg = project("fixture-a-transport");
  await relayMcp(cfg, payload, "caller-forged");
  expect(requests.at(-1)?.session).toBeUndefined();
  const first = await relayMcp(cfg, payload);
  await relayMcp(cfg, payload, first.transportSessionId);
  expect(requests.at(-1)?.session).toBe(first.transportSessionId);
  cfg.composio.apiKey = "fixture-b-transport";
  await relayMcp(cfg, payload, first.transportSessionId);
  expect(requests.at(-1)?.session).toBeUndefined();
  cfg.composio.apiKey = "fixture-a-transport";
  cfg.composio.sessionId = "session-other";
  await relayMcp(cfg, payload, first.transportSessionId);
  expect(requests.at(-1)?.session).toBeUndefined();
});
it("managed token and URL changes invalidate transport and catalog ownership", async () => {
  setManagedBrokerAccess({ url: base, token: "a".repeat(64) });
  const first = await relayMcp({}, payload);
  await listToolkits({});
  setManagedBrokerAccess({ url: base, token: "b".repeat(64) });
  await relayMcp({}, payload, first.transportSessionId);
  expect(requests.at(-1)?.session).toBeUndefined();
  expect((await listToolkits({})).cards[0].slug).toBe("catalog-b");
  setManagedBrokerAccess({ url: base + "/new", token: "b".repeat(64) });
  await relayMcp({}, payload, first.transportSessionId);
  expect(requests.at(-1)?.session).toBeUndefined();
});
it("late catalogue completion cannot replace newer backend inventory", async () => {
  heldCatalog = new Promise<void>(resolve => { holdCatalog = resolve; });
  const arrived = new Promise<void>(resolve => { catalogArrived = resolve; });
  const a = project("fixture-a-late"), b = project("fixture-b-late");
  const pending = listToolkits(a);
  await arrived;
  expect((await listToolkits(b)).cards[0].slug).toBe("catalog-b");
  holdCatalog!(); await pending;
  const before = catalogueCalls;
  expect((await listToolkits(b)).cards[0].slug).toBe("catalog-b");
  expect(catalogueCalls).toBe(before);
});
it("a late MCP response is refused after the active managed identity changes", async () => {
  setManagedBrokerAccess({ url: base, token: "c".repeat(64) });
  heldMcp = new Promise<void>(resolve => { holdMcp = resolve; });
  const arrived = new Promise<void>(resolve => { mcpArrived = resolve; });
  const pending = relayMcp({}, payload);
  const checked = expect(pending).rejects.toThrow("configuration changed");
  await arrived;
  setManagedBrokerAccess({ url: base, token: "d".repeat(64) });
  holdMcp!(); await checked;
});
it("bounded transport retention evicts the oldest session", async () => {
  setManagedBrokerAccess({ url: base, token: "e".repeat(64) });
  const oldest = await relayMcp({}, payload);
  for (let i = 0; i < 512; i++) await relayMcp({}, payload);
  await relayMcp({}, payload, oldest.transportSessionId);
  expect(requests.at(-1)?.session).toBeUndefined();
});
