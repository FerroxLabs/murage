import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resetAppCatalogState } from "./app-catalog.ts";
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
    if (heldMcp) { const pending = heldMcp; heldMcp = null; mcpArrived?.(); await pending; }
    res.setHeader("mcp-session-id", "transport-" + ++count);
    res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  base = "http://127.0.0.1:" + address.port;
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
afterAll(async () => { vi.unstubAllGlobals(); setManagedBrokerAccess(null); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { setManagedBrokerAccess(null); resetAppCatalogState({ disk: true }); requests.length = 0; catalogueCalls = 0; heldCatalog = null; heldMcp = null; });
const payload = { jsonrpc: "2.0", id: 1, method: "tools/list" };

it("transport ownership preserves known sessions but refuses unknown IDs", async () => {
  setManagedBrokerAccess({ url: base, token: "f".repeat(64) });
  await relayMcp({}, payload, "caller-forged");
  expect(requests.at(-1)?.session).toBeUndefined();
  const first = await relayMcp({}, payload);
  await relayMcp({}, payload, first.transportSessionId);
  expect(requests.at(-1)?.session).toBe(first.transportSessionId);
});
it("managed token and URL changes invalidate transport and catalog ownership", async () => {
  setManagedBrokerAccess({ url: base, token: "a".repeat(64) });
  const first = await relayMcp({}, payload);
  await listToolkits({});
  setManagedBrokerAccess({ url: base, token: "b".repeat(64) });
  await relayMcp({}, payload, first.transportSessionId);
  expect(requests.at(-1)?.session).toBeUndefined();
  // 0.1.61: the same broker's catalog, fetched under the old token, paints
  // at once as a stale copy and is checked again under the new one; it is
  // never served as current (app-catalog.ts isFresh).
  const stale = await listToolkits({});
  expect(stale).toMatchObject({ source: "cache", revalidating: true });
  await expect.poll(async () => (await listToolkits({})).cards[0].slug).toBe("catalog-b");
  setManagedBrokerAccess({ url: base + "/new", token: "b".repeat(64) });
  await relayMcp({}, payload, first.transportSessionId);
  expect(requests.at(-1)?.session).toBeUndefined();
});
it("late catalogue completion cannot replace newer backend inventory", async () => {
  heldCatalog = new Promise<void>(resolve => { holdCatalog = resolve; });
  const arrived = new Promise<void>(resolve => { catalogArrived = resolve; });
  setManagedBrokerAccess({ url: base, token: "a".repeat(64) });
  const pending = listToolkits({});
  await arrived;
  setManagedBrokerAccess({ url: base, token: "b".repeat(64) });
  expect((await listToolkits({})).cards[0].slug).toBe("catalog-b");
  holdCatalog!(); await pending;
  const before = catalogueCalls;
  expect((await listToolkits({})).cards[0].slug).toBe("catalog-b");
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
