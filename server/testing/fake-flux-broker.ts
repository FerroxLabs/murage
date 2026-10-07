// SPDX-License-Identifier: AGPL-3.0-or-later
// A fake Flux Router connected-apps broker for the HTTP harness. It answers
// the broker's own routes (`/v1/...`) and nothing else, so a test can prove a
// flow works end to end through Flux without a network and without the old
// own-key path. Connected accounts come from the same fixture the harness
// already uses for aliases.
import type { IncomingMessage, ServerResponse } from "node:http";

export const FAKE_FLUX_BROKER_TOKEN = "b".repeat(64);
export const FAKE_FLUX_BROKER_PREFIX = "/composio";

export interface FakeBrokerAccount { id: string; alias: string; status: string; toolkit: { slug: string } }
export interface FakeBrokerFixture { accounts: FakeBrokerAccount[]; links: unknown[]; calls: number }

function servicesFrom(accounts: FakeBrokerAccount[], only?: string[]) {
  const services: Record<string, unknown> = {};
  for (const account of accounts) {
    const slug = account.toolkit.slug.toLowerCase();
    if (only && !only.includes(slug)) continue;
    const entry = (services[slug] ??= { connected: false, pending: false, status: "not_connected", accounts: [] }) as {
      connected: boolean; pending: boolean; status: string; accounts: unknown[];
    };
    entry.accounts.push({ id: account.id, alias: account.alias, status: account.status });
    if (/^active$/i.test(account.status)) { entry.connected = true; entry.status = "ACTIVE"; }
    else if (/^(initiated|initializing|pending)$/i.test(account.status)) { entry.pending = true; if (!entry.connected) entry.status = account.status; }
    else if (!entry.connected && !entry.pending) entry.status = account.status;
  }
  for (const slug of only ?? []) services[slug] ??= { connected: false, pending: false, status: "not_connected", accounts: [] };
  return services;
}

/** Returns true when the request was a broker request and has been answered. */
export async function handleFakeFluxBroker(req: IncomingMessage, res: ServerResponse, fixture: FakeBrokerFixture | undefined): Promise<boolean> {
  if (!req.url?.startsWith(`${FAKE_FLUX_BROKER_PREFIX}/`)) return false;
  const url = new URL(req.url, "http://fixture");
  const path = url.pathname.slice(FAKE_FLUX_BROKER_PREFIX.length);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return true;
  };
  if (path === "/health") return send(200, { service: "flux-composio", ready: true, claims: true });
  if (req.headers.authorization !== `Bearer ${FAKE_FLUX_BROKER_TOKEN}`) return send(401, { error: "unauthorized" });
  if (path === "/v1/me") return send(200, {});
  if (path === "/v1/catalog") return send(200, { items: [] });
  if (path === "/v1/mcp") {
    if (body.method === "tools/list") return send(200, { jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    return send(200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{}" }] } });
  }
  if (fixture) fixture.calls += 1;
  const accounts = fixture?.accounts ?? [];
  if (path === "/v1/connectors/connected") return send(200, { services: servicesFrom(accounts) });
  if (path === "/v1/connectors") {
    const only = (url.searchParams.get("services") ?? "").split(",").filter(Boolean).map((slug) => slug.toLowerCase());
    return send(200, { services: servicesFrom(accounts, only) });
  }
  const authorize = path.match(/^\/v1\/connectors\/([^/]+)\/authorize$/);
  if (authorize && req.method === "POST") {
    const slug = decodeURIComponent(authorize[1]);
    fixture?.links.push({ toolkit: slug, ...(body.alias ? { alias: body.alias } : {}) });
    return send(200, { url: `https://connect.composio.dev/link/${encodeURIComponent(body.alias ?? slug)}` });
  }
  if (req.method === "DELETE") return send(200, { removed: 1 });
  return send(404, { error: "not found" });
}

/** Source for a verification fixture's `instrumentationSource`: starts the
 * fake broker inside the server process and points the build at it. */
export const FAKE_FLUX_BROKER_INSTRUMENTATION = `
  const { createServer: createFakeFluxBroker } = await import('node:http');
  const fakeFluxBroker = createFakeFluxBroker((req, res) => {
    const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.url?.endsWith('/health')) return send(200, { service: 'flux-composio', ready: true, claims: true });
    let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url?.endsWith('/v1/mcp')) return send(200, body.method === 'tools/list' ? { jsonrpc: '2.0', id: body.id, result: { tools: [] } } : { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }] } });
      if (req.url?.includes('/v1/connectors/connected')) return send(200, { services: {} });
      if (req.url?.includes('/v1/connectors')) return send(200, { services: {} });
      return send(200, {});
    });
  });
  await new Promise((resolve) => fakeFluxBroker.listen(0, '127.0.0.1', resolve));
  fakeFluxBroker.unref();
  process.env.MURAGE_FLUX_COMPOSIO_BROKER_URL = 'http://127.0.0.1:' + fakeFluxBroker.address().port + '/composio';
  process.env.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN = '${FAKE_FLUX_BROKER_TOKEN}';
`;
