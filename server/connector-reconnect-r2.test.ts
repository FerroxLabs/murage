import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { applyManagedBrokerMessage, appsNeedingReconnect, connectedInventory, connectedServices, primeBrokerReadiness, relayConnectedAppCall, resetManagedBrokerState } from "./composio.ts";
import { readAppAnswer } from "./connected-app-health.ts";
import type { AppConfig } from "./config.ts";

let server: Server, base: string;
let accounts: Record<string, Array<{ id: string; alias?: string; status: string }>>;
let calls: any[], failure: unknown;
let mcpStatus = 200, inventoryReads = 0;
const cfg = {} as AppConfig;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
beforeAll(async () => {
  server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/health")) return void res.end(JSON.stringify({ ready: true }));
    if (req.url?.endsWith("/connected")) { inventoryReads++; return void res.end(JSON.stringify({ services: Object.fromEntries(Object.entries(accounts).map(([slug, list]) => [slug, { connected: true, status: "ACTIVE", accounts: list }])) })); }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    res.statusCode = mcpStatus;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(failure ?? { result: { content: [{ type: "text", text: "ok" }] } }) as object }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/composio`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
  resetManagedBrokerState(); calls = []; failure = undefined; mcpStatus = 200; inventoryReads = 0;
  accounts = { gmail: [{ id: "a", alias: "work", status: "ACTIVE" }, { id: "b", alias: "home", status: "ACTIVE" }] };
  applyManagedBrokerMessage({ type: "murage:managed-composio", access: null, fluxBrokerUrl: base, fluxAccess: { url: base, token: "c".repeat(64) }, legacyUntil: "", legacyClaim: { state: "none" }, accountKind: null, tokenError: null });
  await primeBrokerReadiness(); await connectedInventory(cfg, { force: true, fresh: true });
});
afterEach(() => { vi.restoreAllMocks(); resetManagedBrokerState(); });
let id = 0;
function call(tool = "GMAIL_FETCH_EMAILS", account = "work", options = {}) {
  return relayConnectedAppCall(cfg, { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: tool, account, arguments: {} }] } } }, undefined, undefined, { botId: "fixture", ...options });
}
it.each(["INITIATED", "INITIALIZING", "FAILED", "INACTIVE", "EXPIRED", "UNKNOWN"])("R2 status %s marks only the non-ACTIVE account", async status => {
  accounts.gmail![0]!.status = status;
  await connectedInventory(cfg, { force: true, fresh: true });
  expect(appsNeedingReconnect(cfg).map(app => app.accounts)).toEqual([[{ id: "a", alias: "work" }]]);
  expect((await connectedServices(cfg)).gmail?.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ id: "a", needsReconnect: true }), expect.objectContaining({ id: "b", needsReconnect: false })]));
});
it.each(["invalid_credentials", "Token has expired", "authentication failed", "invalid_auth", "token_revoked", "account is not active"])("R2 broker JSON-RPC error message %s becomes an attributed visible failure with no retry", async message => {
  accounts.gmail![0]!.status = "EXPIRED";
  failure = { error: { code: -32000, message } };
  const onReconnect = vi.fn();
  const reply = await call(undefined, undefined, { onReconnect });
  expect(appsNeedingReconnect(cfg)[0]?.accounts).toEqual([{ id: "a", alias: "work" }]);
  expect(new TextDecoder().decode(reply.bytes)).toMatch(/Gmail.*Reconnect/s);
  expect(onReconnect).toHaveBeenCalledOnce();
  await call();
  expect(calls).toHaveLength(1);
});
it("R2 successful content and permission refusals never impersonate an auth failure", () => {
  for (const frame of [{ result: { content: [{ type: "text", text: 'invalid_auth token expired' }] } }, { error: { code: -32000, message: "403 insufficient_scope" } }]) {
    expect(readAppAnswer(["GMAIL_FETCH_EMAILS"], 1, bytes({ id: 1, ...frame })).failed.size).toBe(0);
  }
});
it("R2 scheduled preflight uses one safe read per account, hourly, before work; never probes unknown toolkits", async () => {
  accounts.slack = [{ id: "s", status: "ACTIVE" }];
  accounts.googlecalendar = [{ id: "c", status: "ACTIVE" }];
  accounts.buffer = [{ id: "q", status: "ACTIVE" }];
  accounts.github = [{ id: "g", status: "ACTIVE" }];
  await connectedInventory(cfg, { force: true, fresh: true });
  await Promise.all([call(undefined, undefined, { scheduled: true }), call(undefined, "home", { scheduled: true })]);
  const probes = () => calls.filter(c => String(c.id).startsWith("health-"));
  expect(probes().map(c => c.params.arguments.tools[0])).toEqual(expect.arrayContaining([
    { tool_slug: "GMAIL_GET_PROFILE", account: "a", arguments: { user_id: "me" } },
    { tool_slug: "GMAIL_GET_PROFILE", account: "b", arguments: { user_id: "me" } },
  ]));
  expect(probes()).toHaveLength(2);
  expect(calls.slice(0, 2).every(c => String(c.id).startsWith("health-"))).toBe(true);
  await call(undefined, undefined, { scheduled: true }); expect(probes()).toHaveLength(2);
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 3_600_001);
  await call(undefined, undefined, { scheduled: true }); expect(probes()).toHaveLength(4);
  for (const [tool, account] of [["SLACK_FETCH_TEAM_INFO", "s"], ["GOOGLECALENDAR_LIST_EVENTS", "c"], ["BUFFER_LIST_POSTS", "q"], ["GITHUB_GET_AN_ISSUE", "g"]]) await call(tool, account, { scheduled: true });
  expect(probes().map(c => c.params.arguments.tools[0].tool_slug)).toEqual(["GMAIL_GET_PROFILE", "GMAIL_GET_PROFILE", "GMAIL_GET_PROFILE", "GMAIL_GET_PROFILE", "SLACK_TEST_AUTH", "GOOGLECALENDAR_LIST_CALENDARS", "BUFFER_GET_ACCOUNT_CONTEXT"]);
  expect(probes().every(c => c.params.arguments.sync_response_to_workbench === false)).toBe(true);
});
it("R2 preflight catches an ACTIVE idle lapse and stops scheduled work", async () => {
  failure = { result: { isError: true, content: [{ type: "text", text: JSON.stringify({status:401}) }] } };
  const reply = await call(undefined, undefined, { scheduled: true });
  expect(calls.every(c => String(c.id).startsWith("health-"))).toBe(true);
  expect(calls).toHaveLength(2);
  expect(new TextDecoder().decode(reply.bytes)).toMatch(/Gmail.*Reconnect/s);
  expect(appsNeedingReconnect(cfg)[0]?.accounts).toHaveLength(2);
});

it("R2 hourly probe budget survives reopening the ledger and renewal of the owner token", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ConnectorHealthStore } = await import("./connector-health-store.ts");
  const file = join(mkdtempSync(join(tmpdir(), "probe-budget-")), "health.json");
  const first = new ConnectorHealthStore(file);
  expect(first.claimProbe("owner", "gmail", "a", 1000)).toBe(true);
  const reopened = new ConnectorHealthStore(file);
  expect(reopened.claimProbe("owner", "gmail", "a", 1001)).toBe(false);
  expect(reopened.claimProbe("owner", "gmail", "b", 1001)).toBe(true);
  reopened.rekey("owner", "renewed");
  expect(new ConnectorHealthStore(file).claimProbe("renewed", "gmail", "a", 1002)).toBe(false);
  expect(reopened.claimProbe("renewed", "gmail", "a", 3_601_000)).toBe(true);
});

it("Flux contract: tool error refreshes inventory and EXPIRED identifies only its account", async () => {
  accounts.gmail![0]!.status = "EXPIRED";
  failure = { result: { isError: true, content: [{ type: "text", text: "Composio tool failed" }] } };
  const before = inventoryReads;
  const reply = await call();
  expect(inventoryReads).toBeGreaterThan(before);
  expect(appsNeedingReconnect(cfg)[0]?.accounts).toEqual([{ id: "a", alias: "work" }]);
  expect(new TextDecoder().decode(reply.bytes)).toMatch(/Gmail.*Reconnect/s);
});
it("Flux contract: generic error with ACTIVE status is not a reconnect incident", async () => {
  failure = { result: { isError: true, content: [{ type: "text", text: "No matching item" }] } };
  const before = inventoryReads;
  await call();
  expect(inventoryReads).toBeGreaterThan(before);
  expect(appsNeedingReconnect(cfg)).toEqual([]);
});
it.each([401, 403])("Flux contract: project-key HTTP %s is an outage, never a user reconnect", async status => {
  mcpStatus = status;
  failure = { error: { kind: "auth", message: "Connected-apps provider rejected FluxRouter's credentials" } };
  await call();
  expect(appsNeedingReconnect(cfg)).toEqual([]);
});
it("Flux contract: an in-band project-key error is not mistaken for upstream account auth", async () => {
  failure = { result: { isError: true, content: [{ type: "text", text: "Connected-apps provider rejected FluxRouter's credentials (HTTP 401)" }] } };
  await call();
  expect(appsNeedingReconnect(cfg)).toEqual([]);
});
it.each([401, 403])("Flux contract: preflight upstream %s with ACTIVE status raises reconnect", async status => {
  failure = { result: { isError: true, content: [{ type: "text", text: JSON.stringify({status}) }] } };
  const before = inventoryReads;
  await call(undefined, undefined, { scheduled: true });
  expect(inventoryReads).toBeGreaterThan(before);
  expect(calls.every(c => String(c.id).startsWith("health-"))).toBe(true);
  expect(appsNeedingReconnect(cfg)[0]?.accounts).toHaveLength(2);
});
it("Flux contract: a JSON error inside MCP content is still an upstream preflight failure", async () => {
  failure = { result: { isError: true, content: [{ type: "text", text: JSON.stringify({ status: 401, message: "Unauthorized" }) }] } };
  await call(undefined, undefined, { scheduled: true });
  expect(calls.every(c => String(c.id).startsWith("health-"))).toBe(true);
  expect(appsNeedingReconnect(cfg)[0]?.accounts).toHaveLength(2);
});
it("Flux contract: an unattributed multi-app tool error still refreshes account statuses", async () => {
  accounts.github = [{ id: "g", status: "ACTIVE" }];
  accounts.gmail![0]!.status = "EXPIRED";
  failure = { result: { isError: true, content: [{ type: "text", text: "One tool failed" }] } };
  const before = inventoryReads;
  await relayConnectedAppCall(cfg, { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [
    { tool_slug: "GMAIL_FETCH_EMAILS", account: "work", arguments: {} }, { tool_slug: "GITHUB_GET_AN_ISSUE", account: "g", arguments: {} },
  ] } } }, undefined, undefined, { botId: "fixture" });
  expect(inventoryReads).toBeGreaterThan(before);
  expect(appsNeedingReconnect(cfg).map(a => a.accounts)).toEqual([[{ id: "a", alias: "work" }]]);
});
it("R2 reconnect guard blocks A but lets healthy B work without clearing A", async () => {
  failure = { result: { isError: true, content: [{ type: "text", text: JSON.stringify({status:401}) }] } };
  await call();
  failure = undefined;
  await call();
  expect(calls).toHaveLength(1);
  const healthy = await call(undefined, "home");
  expect(calls).toHaveLength(2);
  expect(new TextDecoder().decode(healthy.bytes)).not.toContain('"isError":true');
  expect(appsNeedingReconnect(cfg)[0]?.accounts).toEqual([{ id: "a", alias: "work" }]);
});

it("Flux contract: prose-only upstream failure with ACTIVE never establishes authentication", async () => {
  failure = { result: { isError: true, content: [{ type: "text", text: "Upstream HTTP 401" }] } };
  await call(undefined, undefined, { scheduled: true });
  expect(appsNeedingReconnect(cfg)).toEqual([]);
  expect(calls.some(c => !String(c.id).startsWith("health-"))).toBe(true);
});
