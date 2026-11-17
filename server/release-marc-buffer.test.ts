// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Buffer-specific fake-broker fixture; no external HTTP is possible in the runner.
import { afterEach, expect, it, vi } from 'vitest';
import { applyManagedBrokerMessage, primeBrokerReadiness, connectedServices, relayMcp,
  appsNeedingReconnect, reconnectSystemPrompt, resetManagedBrokerState } from './composio.ts';
afterEach(() => { vi.unstubAllGlobals(); resetManagedBrokerState(); });
it('Buffer sign-in lapse becomes a visible reconnect alert and survives subsequent turns', async () => {
  resetManagedBrokerState();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/health')) return json({ ready: true });
    if (url.pathname.endsWith('/v1/connectors/connected')) return json({ services: { buffer: { connected: true, status: 'ACTIVE', accounts: [{ id: 'fixture-buffer', alias: 'work', status: 'ACTIVE' }] } } });
    if (url.pathname.endsWith('/v1/mcp')) {
      const body = JSON.parse(String(init?.body));
      return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ successful: false, data: { results: [{ tool_slug: 'BUFFER_CREATE_UPDATE', // DESIGN-CONN-r3 section 3: auth is a structured upstream status.
response: { successful: false, status: 401, error: 'HTTP 401 token expired' } }] } }) }] } });
    }
    throw Error('Unexpected fake broker route: ' + url.pathname);
  }));
  const url = 'https://broker.example.test/composio';
  applyManagedBrokerMessage({ type: 'murage:managed-composio', access: null, fluxBrokerUrl: url,
    fluxAccess: { url, token: 'c'.repeat(64) }, legacyUntil: '', legacyClaim: { state: 'none' }, accountKind: null, tokenError: null });
  await primeBrokerReadiness();
  await connectedServices({}, { fresh: true });
  await relayMcp({}, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: [{ tool_slug: 'BUFFER_CREATE_UPDATE', arguments: {} }] } } });
  for (let turn = 0; turn < 3; turn++) {
    expect((await connectedServices({})).buffer).toMatchObject({ needsReconnect: true, status: 'NEEDS_RECONNECT' });
    expect(appsNeedingReconnect({}).map(a => a.slug)).toContain('buffer');
    expect(reconnectSystemPrompt({})).toMatch(/buffer/i);
  }
});
