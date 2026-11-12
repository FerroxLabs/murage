import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedBrowserController } from './browser-control.ts';
import { createNativeBrowser, type NativeBrowser } from './browser-native-relay.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const source = 'café 😀 ' + 'x'.repeat(39988) + ' END';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
function fixture(cdp = false, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'webread-route-')); dirs.push(dir);
  const request = vi.fn(async (method: string, params?: Record<string, any>) => {
    if (method === 'tools/list') return { tools: [{ name: 'agent_browser_read' }] };
    const data = params?.name === 'agent_browser_get_url' ? { url: 'https://fixture.test/' }
      : params?.name === 'agent_browser_eval' ? { result: `<p>${source}</p>` }
      : { content: source.slice(0, 12000) + '[Content truncated' };
    return { structuredContent: { response: { success: true, data } } };
  });
  const native: NativeBrowser = { request, protected: async () => false, resetStream() {}, input() {}, command: async () => ({}), connect: async () => 'fixture', close: async () => {} };
  const controller = new UnifiedBrowserController({ stateFile: join(dir, 'state.json'), createNative: () => native, judgeDaemon: async () => 'gone' });
  controller.register('profile', { command: 'fixture', args: [], env: { ...extraEnv, ...(cdp ? { AGENT_BROWSER_CDP: 'http://127.0.0.1:9222' } : {}) } });
  const read = async (args: object, scope = 'bot:threadA') => (await (controller.dispatch as any)('profile', 'tools/call', { name: 'agent_browser_read', arguments: args }, () => true, { readScope: scope }))?.structuredContent;
  return { controller, request, read };
}
const unfence = (value: string) => value.slice(value.indexOf('\n') + 1, value.lastIndexOf('\n'));
it.each([false, true])('T1-routes unified cdp=%s saves the entire source', async cdp => {
  const f = fixture(cdp), before = browserReadRouteHits();
  try {
    let page = await f.read({ length: 4000 });
    expect(page).toMatchObject({ total_length: 40000, eof: false, handle: expect.stringMatching(/^w-/) });
    const handle = page.handle; let rebuilt = '';
    for (let i = 0; i < 20; i++) {
      rebuilt += unfence(page.content); if (page.eof) break;
      page = await f.read({ handle, offset: page.next_offset, length: 4000 });
    }
    expect(rebuilt).toBe(source);
    expect(f.request.mock.calls.filter(([, p]) => p?.name === 'agent_browser_eval')).toHaveLength(1);
    expect(f.request.mock.calls.filter(([, p]) => p?.name === 'agent_browser_read')).toHaveLength(0);
    expect(browserReadRouteHits().unified - before.unified).toBe(10);
  } finally { await f.controller.close(); }
});
it('T1-scope refuses another thread and handles retired by hold and close', async () => {
  const f = fixture();
  try {
    const first = await f.read({ length: 4000 }); expect(first?.handle).toMatch(/^w-/);
    await expect(f.read({ handle: first.handle }, 'bot:threadB')).rejects.toThrow();
    await expect(f.read({ handle: first.handle }, 'other:threadA')).rejects.toThrow();
    const held = await f.controller.take('profile', 'owner');
    await expect(f.read({ handle: first.handle })).rejects.toThrow();
    await f.controller.release('profile', 'owner', held.generation);
    await expect(f.read({ handle: first.handle })).rejects.toThrow();
    const second = await f.read({}); await f.controller.close();
    await expect(f.read({ handle: second.handle })).rejects.toThrow();
  } finally { await f.controller.close(); }
});

it.each(['cloud-home', 'pop-out'] as const)('T1-carrier %s retains the unified read contract', async carrier => {
  const f = fixture(false, carrier === 'cloud-home' ? { MURAGE_CLOUD_ROLE: 'home' } : {});
  try {
    const first = await f.read({ length: 4000 });
    expect(first).toMatchObject({ total_length: 40000, handle: expect.stringMatching(/^w-/), eof: false });
    expect(f.request.mock.calls.some(([, params]) => params?.name === 'agent_browser_read')).toBe(false);
  } finally { await f.controller.close(); }
});
it('T1-sink refuses native reads before starting an engine', async () => {
  const native = createNativeBrowser({ command: '/nonexistent-fixture', args: [], env: { AGENT_BROWSER_SOCKET_DIR: tmpdir(), AGENT_BROWSER_SESSION: 'fixture-no-start' } });
  await expect(native.request('tools/call', { name: 'agent_browser_read', arguments: {} })).rejects.toThrow('Network read must use the mediated reader.');
});

import { readdirSync, readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createHeadlessBrowserProxy } from './drivers/headless-browser-proxy.ts';
import { callTool } from './drivers/browser-proxy.ts';
import { BrowserExtensionExecutor } from './browser-extension-executor.ts';
import { BROWSER_READ_ROUTES, browserReadRouteHits } from './browser-read-route.ts';
import { WEB_READ_ROUTING, engineLimitText } from '../shared/web-read-routing.ts';

it.each(['headless', 'builtin', 'extension'] as const)('T1-routes %s saves the entire source', async route => {
  const f = fixture(), before = browserReadRouteHits();
  let captures = 0, nativeReads = 0;
  const host = vi.fn(async (operation: string) => { if (operation === 'read') captures++; return { text: source, url: 'https://fixture.test/', truncated: false }; });
  const proxy = createHeadlessBrowserProxy({ authorize: async () => ({ spec: { command: 'fixture', args: [], env: {} }, held: false }), start: () => ({ request: f.request, close: async () => {} }), closeSession: async () => {} });
  const doc = { profileId: 'fixture', tabId: 1, frameId: 'frame', navigationEpoch: 1, origin: 'https://fixture.test', url: 'https://fixture.test/' };
  const world = createContext({ document: { documentElement: { outerHTML: `<p>${source}</p>` } } });
  const executor = new BrowserExtensionExecutor({ authorize: () => true, access: async () => true, admit: async () => true,
    createEngine: () => ({ resolveTarget: async () => ({ backendNodeId: 1, document: doc }), resolveTab: async () => doc, event() {}, close: async () => {}, call: async (name: string) => { if (name === 'agent_browser_read') nativeReads++; return { content: [{ type: 'text', text: source.slice(0, 12000) + '[Content truncated' }] }; } }),
    transport: { document: async () => doc, send: async (method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: doc.url } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [] } };
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        if (expression.includes('__murageGuard()')) return { result: { value: false } };
        if (expression.includes('document.documentElement.outerHTML')) captures++;
        return { result: { value: runInContext(expression, world) } };
      }
      return {};
    } },
  });
  const read = async (args: object) => {
    if (route === 'builtin') {
      const text = ((await callTool('browser_read', args, host)).content[0] as { text: string }).text;
      expect(text).toMatch(/^\{/); return JSON.parse(text);
    }
    const response: any = route === 'headless' ? (await proxy.handle({ id: 1, method: 'tools/call', params: { name: 'agent_browser_read', arguments: args } }) as any).result : await executor.call('agent_browser_read', args);
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ handle: expect.stringMatching(/^w-/), total_length: 40000 });
    return { ...response.structuredContent, text: unfence(response.structuredContent.content) };
  };
  try {
    let page = await read({ length: 4000 }), rebuilt = ''; const handle = page.handle;
    expect(page).toMatchObject({ handle: expect.stringMatching(/^w-/), total_length: 40000, eof: false });
    for (let n = 0; n < 20; n++) { rebuilt += page.text; if (page.eof) break; page = await read({ handle, offset: page.next_offset, length: 4000 }); }
    expect(rebuilt).toBe(source);
    expect(nativeReads + f.request.mock.calls.filter(([, p]) => p?.name === 'agent_browser_read').length).toBe(0);
    expect(route === 'headless' ? f.request.mock.calls.filter(([, p]) => p?.name === 'agent_browser_eval').length : captures).toBe(1);
    const after = browserReadRouteHits();
    for (const id of BROWSER_READ_ROUTES) expect(after[id] - before[id]).toBe(id === route ? 10 : 0);
  } finally { await executor.close(); await proxy.close(); await f.controller.close(); }
});

import { createHash } from "node:crypto";
import ts from "typescript";

it('T1-static inventories every browser reader reference and document save', () => {
  const referenceHashes: Record<string, string> = {
  "server/browser-control.ts": "8e85c58e1f95aef4486311d7f014d832539261743c5edf8a10797104415dbb68",
  "server/browser-engine-policy.ts": "7776e4d80a4735fc5708281a6f5016e64e3aa2389651da6241230bac5efdc6c1",
  "server/browser-extension-engine.ts": "23bcad396a8a049a02fba68bda0346b4c03ee785ba3aa2ef59fcc4f0353a8ef6",
  "server/browser-extension-service.ts": "83466a2e04bc9bc62b6d416b4c8e27e059f760d0dd803ca61c5a5abdfe04ba73",
  "server/browser-native-relay.ts": "7ed1c4dd20ac980f41564eff2ab10a171ceeef2f958f8fea700eee621df48923",
  "server/drivers/browser-proxy.ts": "90fcab78fb142caf513a6a326a1806fd73a3b13b7c4ff944189afae0bc11b6e5",
  "server/drivers/headless-browser-proxy.ts": "e82635003ca76e224b9b6f486946c75a25e593c294e89338e715b946db522182",
  "server/drivers/openai-chat.ts": "67d2e76a3d17eabce434621d66e36c27ff287f268d4169f8813d3931d0051fe4",
  "server/mcp-tool-images.ts": "9fded879a67b382dcfede101000a28db4d1af86b29fc2e43cf749f3b7c3cb77b"
};
  const allowed = new Set(['server/browser-native-relay.ts', 'server/browser-engine-policy.ts', 'server/drivers/headless-browser-proxy.ts', 'server/drivers/browser-proxy.ts', 'server/drivers/openai-chat.ts', 'server/mcp-tool-images.ts', 'server/browser-extension-engine.ts', 'server/browser-control.ts', 'server/browser-extension-service.ts', 'server/browser-read-route.ts']);
  const readerCalls = new Set(['server/browser-read-route.ts', 'server/web-read.ts', 'server/browser-extension-engine-read.ts']);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith('.ts') && !/\.test\./.test(entry.name) ? [`${dir}/${entry.name}`] : []);
  const violations: string[] = [];
  for (const path of [...walk('server'), ...walk('shared')]) {
    const code = readFileSync(path, 'utf8');
    const referenceLines = code.split(/\r?\n/).filter(line => /agent_browser_read|["']browser_read["']/.test(line)).map(line => line.trim());
    if (referenceLines.length && (!allowed.has(path) || createHash('sha256').update(referenceLines.join('\n')).digest('hex') !== referenceHashes[path])) violations.push(`${path}: tool route`);
    if (/\breadWithBrowserAuthority\s*\(/.test(code) && !readerCalls.has(path)) violations.push(`${path}: unmediated reader`);
    // Resolve local constructor/import aliases as well, so a differently named
    // WebDocuments variable cannot evade the save inventory.
    const ast = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
    const classes = new Set(['WebDocuments']), readers = new Set(['readWithBrowserAuthority']), stores = new Set(['documents', 'readDocuments']);
    const walkNode = (node: ts.Node, visit: (node: ts.Node) => void) => { visit(node); ts.forEachChild(node, child => walkNode(child, visit)); };
    walkNode(ast, node => {
      if (ts.isImportSpecifier(node)) {
        if ((node.propertyName ?? node.name).text === 'WebDocuments') classes.add(node.name.text);
        if ((node.propertyName ?? node.name).text === 'readWithBrowserAuthority') readers.add(node.name.text);
      }
    });
    walkNode(ast, node => {
      if (ts.isNewExpression(node) && classes.has(node.expression.getText(ast))) {
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent)) stores.add(parent.name.getText(ast));
        else if (ts.isBinaryExpression(parent)) stores.add(parent.left.getText(ast));
      }
    });
    walkNode(ast, node => {
      if (!ts.isCallExpression(node)) return;
      if (readers.has(node.expression.getText(ast)) && !readerCalls.has(path)) violations.push(`${path}: aliased reader`);
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'save'
        && stores.has(node.expression.expression.getText(ast)) && !readerCalls.has(path)) violations.push(`${path}: unmediated save`);
    });
  }
  expect(violations).toEqual([]);
  expect(BROWSER_READ_ROUTES).toEqual(['headless', 'unified', 'extension', 'builtin']);
});
it('T2-copy every limited engine has plain language copy', () => {
  for (const driver of [...Object.keys(WEB_READ_ROUTING).filter(driver => WEB_READ_ROUTING[driver].limitation), 'futureEngine']) {
    for (const surface of ['chat', 'settings'] as const) {
      const text = engineLimitText(driver, surface);
      expect(text).toBeTruthy(); expect(text).not.toMatch(/—|–|;|ACP|MCP|YAML|native|web_read|exclusion|driver/);
      expect(text).toContain('Fuigo, Claude, Codex or Gemini');
    }
  }
});

import { beforeAll, afterAll, describe } from 'vitest';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
// @ts-expect-error The isolated replay harness is JavaScript test support.
import { browserFixtureSource, ProductClient } from '../scripts/web-read-replay/run.mjs';
// @ts-expect-error The isolated replay harness is JavaScript test support.
import { fakeEngineSetup } from '../scripts/web-read-replay/fake-engines.mjs';
// @ts-expect-error The isolated replay harness is JavaScript test support.
import { writeEvidence } from '../scripts/web-read-replay/evidence-fs.mjs';
import { withTurnSecrets } from './testing/fixture-dump.ts';
import { confirmedBrowserFields } from './testing/browser-choice.ts';

describe('isolated mounted HTTP browser and notice workflow', () => {
  let server: VerificationServer, site: Server, client: ProductClient, url: string;
  const evidence: Record<string, unknown> = {};
  beforeAll(async () => {
    site = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<div>${source}</div>`); });
    await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(site.address() as { port: number }).port}/sales`;
    const setup = fakeEngineSetup(resolve('.')) + browserFixtureSource() + `
      for (const [id, driver] of [['limited-kimi', 'kimiAgent'], ['limited-cursor', 'cursorAgent']]) {
        config.instances[id] = { driver, config: { cli: join(root, 'server/testing/fake-acp-cli.ts') }, environment: { ...base, FAKE_ACP_VERSION: id + ' 1.0.62' } };
      }
      writeFileSync(configPath, JSON.stringify(config));
    `;
    server = await launchVerificationServer(process.env, undefined, { instrumentationSource: setup });
    const { secret } = await (await fetch(server.info.url + '/api/desktop-secret')).json() as { secret: string };
    client = new ProductClient(server.info.url, { 'content-type': 'application/json', 'x-murage-surface': 'desktop', 'x-murage-surface-secret': secret }, server.info.dataDir);
    await client.connect(); evidence.fixture = server.info;
  }, 150000);
  afterAll(async () => {
    await client?.disconnect(); await server?.close();
    if (server) writeEvidence('.webread-evidence/r2/http-server.log', readFileSync(server.info.logPath));
    writeEvidence('.webread-evidence/r2/http-workflows.json', JSON.stringify(evidence, null, 2));
    if (site) { site.closeAllConnections(); await new Promise<void>(done => site.close(() => done())); }
  }, 60000);
  it.each(['managed', 'cdp', 'guest'] as const)('T1-HTTP %s mounted route reconstructs 40000 units', async carrier => {
    const bot = (await client.api('POST', '/api/bots', { name: `Reader ${carrier}` })).bot;
    if (carrier !== 'managed') {
      const fields = carrier === 'cdp' ? { useMyChrome: true } : { browserProfile: 'guest' };
      const patch = await confirmedBrowserFields(server.info.url, client.headers, `/api/bots/${bot.id}`, fields);
      await client.api('PATCH', `/api/bots/${bot.id}`, patch);
    }
    try {
      await client.api('POST', `/api/bots/${bot.id}/messages`, { text: '__fixture_hold_authority__', threadId: bot.threadId });
      let token = '';
      await vi.waitFor(() => {
        const dump: any = withTurnSecrets(JSON.parse(readFileSync(server.fixtureDumpPath, 'utf8')));
        const env = dump.mcpConfig?.mcpServers?.browser?.env;
        expect(env?.MURAGE_BOT_ID).toBe(bot.id); token = env.MURAGE_CONTROL_TOKEN; expect(token).toBeTruthy();
      }, { timeout: 45000 });
      const rpc = async (name: string, args: object) => {
        const res = await fetch(server.info.url + '/api/internal/unified-browser', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'tools/call', params: { name, arguments: args } }) });
        const body = await res.json() as any; expect(res.status, JSON.stringify(body)).toBe(200); return body;
      };
      await rpc('agent_browser_open', { url });
      let page = (await rpc('agent_browser_read', { length: 4000 })).structuredContent;
      expect(page).toMatchObject({ total_length: 40000, eof: false, handle: expect.stringMatching(/^w-/) });
      const handle = page.handle, ranges = []; let text = '';
      for (let i = 0; i < 20; i++) {
        text += unfence(page.content); ranges.push({ handle: page.handle, offset: page.offset, next_offset: page.next_offset, total_length: page.total_length, eof: page.eof });
        if (page.eof) break; page = (await rpc('agent_browser_read', { handle, offset: page.next_offset, length: 4000 })).structuredContent;
      }
      expect(text).toBe(source);
      const trace = readFileSync(join(server.info.dataDir, 'browser-route-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(trace.filter(row => row.kind === 'native-read')).toHaveLength(0);
      const routes = trace.filter(row => row.kind === 'route' && row.handle === handle);
      expect(routes).toHaveLength(10); expect(routes.every(row => row.route === 'unified')).toBe(true);
      evidence[carrier] = { ranges, trace, messages: await client.messages(bot.threadId) };
    } finally { evidence[carrier + "Messages"] = await client.messages(bot.threadId); await client.stop(bot); if (carrier === 'cdp') await client.api('PATCH', `/api/bots/${bot.id}`, await confirmedBrowserFields(server.info.url, client.headers, `/api/bots/${bot.id}`, { useMyChrome: false })); }
  }, 90000);
  it('T2-once writes one notice per thread and limited engine, never on prewarm', async () => {
    const instances = (await client.api('GET', '/api/instances')).instances;
    const engine = (id: string) => { const i = instances.find((i: any) => i.instanceId === id); return { instanceId: id, model: i.models.default }; };
    const bot = (await client.api('POST', '/api/bots', { name: 'Limited reader', modelSelection: engine('limited-kimi') })).bot;
    await client.api('POST', `/api/bots/${bot.id}/warm`, { threadId: bot.threadId });
    expect((await client.messages(bot.threadId)).filter((m: any) => m.tool?.name.startsWith('engine limit:'))).toHaveLength(0);
    for (let n = 0; n < 2; n++) await client.turn(bot, 'Fixture hello');
    let messages = await client.messages(bot.threadId);
    expect(messages.filter((m: any) => m.tool?.name === 'engine limit: web-read:kimiAgent')).toHaveLength(1);
    await client.api('PATCH', `/api/bots/${bot.id}`, { modelSelection: engine('limited-cursor') });
    await client.turn(bot, 'Fixture hello'); messages = await client.messages(bot.threadId);
    expect(messages.filter((m: any) => m.tool?.name === 'engine limit: web-read:cursorAgent')).toHaveLength(1);
    expect(messages.filter((m: any) => m.tool?.name === 'engine limit: web-read:kimiAgent')).toHaveLength(1);
    evidence.notices = messages;
  }, 120000);
});

import { createBrowserExtensionService } from './browser-extension-service.ts';
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from '../shared/browser-extension-protocol.ts';
async function extensionReadFixture(noLimits = false, never = false, origin: 'owner' | 'owner-channel' | 'routine' | 'other' = 'owner', mode: 'step' | 'task' = 'task', extra: Partial<Parameters<typeof createBrowserExtensionService>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'webread-extension-')); dirs.push(dir);
  const world = createContext({ document: { documentElement: { outerHTML: `<p>${source}</p>` } } });
  let captures = 0, nativeReads = 0;
  const authority = { noLimits, origin, mode };
  const approvedSets: string[][] = [];
  const state = { generation: 1, state: 'active', tabs: [{ tabId: 1, navigationEpoch: 1, origin: 'https://fixture.test', url: 'https://fixture.test/' }] };
  const broker = {
    drop: () => false,
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: 'hello', profileId: 'profile', browser: 'chromium', extensionVersion: 'fixture', capabilities: ['scoped_cdp', 'durable_stop', 'explicit_share', 'manual_pause', 'engine_cdp_v1', 'unexpected_input_pause', 'ordered_requests_v1'] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      let result: any = state;
      if (command.operation === 'bind') approvedSets.push([...(command.params as any).approvedOrigins]);
      if (command.operation === 'cdp') {
        const { method, params } = command.params as any; let value: any = {};
        if (method === 'Murage.getAllFrames') value = { frames: [{ frameId: 0, parentFrameId: -1, url: state.tabs[0].url }] };
        if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: 'frame', loaderId: 'fixture' } } };
        if (method === 'Page.createIsolatedWorld') value = { executionContextId: 1 };
        if (method === 'DOM.getDocument') value = { root: { nodeType: 9, children: [] } };
        if (method === 'Runtime.evaluate') {
          const expression = String(params.expression);
          if (expression.includes('document.documentElement.outerHTML')) captures++;
          value = { result: { value: expression.includes('__murageGuard()') ? false : runInContext(expression, world) } };
        }
        result = { result: value, ...state.tabs[0] };
      }
      return { version: 1, type: 'response', id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) };
    },
  };
  const siteCards: string[] = [], actionCards: string[] = [];
  const service = await createBrowserExtensionService({ broker, workspaceId: 'fixture', stateFile: join(dir, 'extension.json'), readTurn: () => authority, approvalMode: () => authority.mode, askSite: async (context, site, binding) => { siteCards.push(site); return extra.askSite ? extra.askSite(context, site, binding) : 'waiting' as const; }, askAction: async () => { actionCards.push('action'); return 'waiting' as const; },
    consumeApproval: extra.consumeApproval, siteSetting: extra.siteSetting,
    createEngine: engine => ({ resolveTarget: async () => ({ backendNodeId: 1, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, close: async () => {}, call: async name => { if (name === 'agent_browser_read') nativeReads++; return { content: [{ type: 'text', text: source.slice(0, 12000) + '[Content truncated' }] }; } }),
  } as Parameters<typeof createBrowserExtensionService>[0]);
  const binding = await service.ensureBinding({ botId: 'bot', threadId: 'thread', profileId: 'profile' });
  if (never) await service.setSiteAccess(binding.bindingId, 'https://fixture.test', 'never');
  return { service, binding, authority, approvedSets, stateFile: join(dir, 'extension.json'), captures: () => captures, nativeReads: () => nativeReads, siteCards, actionCards,
    read: (args: object) => service.dispatch(binding.bindingId, 'agent_browser_read', args, () => true) as Promise<any> };
}
it('T1-routes extension runtime dispatch preserves full saved documents', async () => {
  const f = await extensionReadFixture();
  try {
    await f.service.setSiteAccess(f.binding.bindingId, 'https://fixture.test', 'allow');
    const read = async (args: object) => {
      const response = await f.read(args);
      const item = response.content.find((item: any) => item.type === 'text' && item.text.startsWith('{'));
      expect(item, JSON.stringify(response)).toBeDefined();
      const newline = item.text.indexOf('\n');
      return { ...JSON.parse(item.text.slice(0, newline)), content: item.text.slice(newline + 1) };
    };
    let page = await read({ length: 4000 }), text = ''; const handle = page?.handle;
    expect(page).toMatchObject({ handle: expect.stringMatching(/^w-/), total_length: 40000, eof: false });
    for (let n = 0; n < 20; n++) { text += unfence(page.content); if (page.eof) break; page = await read({ handle, offset: page.next_offset, length: 4000 }); }
    expect(text).toBe(source); expect(f.captures()).toBe(1); expect(f.nativeReads()).toBe(0);
  } finally { await f.service.close(); }
});

it.each([['active page', 'owner'], ['URL', 'owner'], ['active page', 'owner-channel'], ['URL', 'owner-channel']] as const)('G-WEB first read at No limits has no card: %s, %s, never granted', async (route, origin) => {
  const f = await extensionReadFixture(true, false, origin);
  const fetchPage = vi.fn(async () => new Response(source, { headers: { 'content-type': 'text/markdown' } }));
  vi.stubGlobal('fetch', fetchPage);
  try {
    expect(f.service.status().bindings[0].sites).toEqual({});
    const readPage = async (args: object) => {
      const response = await f.read(args);
      const text = response.content.find((item: any) => item.type === 'text' && item.text.startsWith('{'))?.text;
      expect(text, JSON.stringify(response)).toBeDefined();
      const newline = text.indexOf('\n');
      return { ...JSON.parse(text.slice(0, newline)), content: text.slice(newline + 1) };
    };
    const page = await readPage({ length: 4000, ...(route === 'URL' ? { url: 'https://first-read.test/page' } : {}) });
    expect(page).toMatchObject({ total_length: 40000, eof: false, handle: expect.stringMatching(/^w-/) });
    let rebuilt = unfence(page.content), next = page;
    while (!next.eof) {
      next = await readPage({ handle: page.handle, offset: next.next_offset, length: 4000 });
      rebuilt += unfence(next.content);
    }
    expect(rebuilt).toBe(source);
    expect(f.siteCards).toEqual([]); expect(f.actionCards).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(route === 'URL' ? 1 : 0);
  } finally { vi.unstubAllGlobals(); await f.service.close(); }
});
it('G-WEB explicit Never still cards at No limits and never reads the page', async () => {
  const f = await extensionReadFixture(true, true);
  try {
    await expect(f.read({ length: 4000 })).rejects.toThrow();
    expect(f.siteCards).toEqual(['https://fixture.test']);
    expect(f.captures()).toBe(0); expect(f.nativeReads()).toBe(0);
    expect(f.service.status().bindings[0].sites['https://fixture.test']).toBe('never');
  } finally { await f.service.close(); }
});
it.each([['Ask', false, 'owner', 'step'], ['Auto', false, 'owner', 'task'], ['non-owner No limits', true, 'other', 'task']] as const)('G-WEB %s still asks on a never-granted site', async (_label, noLimits, origin, mode) => {
  const f = await extensionReadFixture(noLimits, false, origin, mode);
  try {
    await expect(f.read({ length: 4000 })).rejects.toThrow();
    expect(f.siteCards).toEqual(['https://fixture.test']); expect(f.captures()).toBe(0);
  } finally { await f.service.close(); }
});


const extensionPage = (response: any) => {
  const text = response.content.find((item: any) => item.type === 'text' && item.text.startsWith('{'))?.text;
  expect(text, JSON.stringify(response)).toBeDefined();
  return JSON.parse(text.slice(0, text.indexOf('\n')));
};
const readRoutes = ['active page', 'URL'] as const;
const routeArgs = (route: typeof readRoutes[number]) => ({ length: 4000, ...(route === 'URL' ? { url: 'https://first-read.test/page' } : {}) });
it.each(readRoutes.flatMap(route => (['Ask', 'Auto', 'non-owner'] as const).map(next => [route, next] as const)))('G-WEB same-binding authority loss: %s to %s cards again', async (route, next) => {
  const f = await extensionReadFixture(true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(source, { headers: { 'content-type': 'text/markdown' } })));
  try {
    extensionPage(await f.read(routeArgs(route)));
    expect(f.siteCards).toEqual([]);
    const captures = f.captures();
    if (next === 'non-owner') f.authority.origin = 'other';
    else {
      f.authority.noLimits = false; f.authority.mode = next === 'Ask' ? 'step' : 'task';
      await f.service.settingsChanged('bot');
    }
    await expect(f.read(routeArgs(route))).rejects.toThrow('WAITING FOR THE OWNER');
    expect(f.siteCards).toEqual(['https://fixture.test']);
    expect(f.captures()).toBe(captures);
  } finally { vi.unstubAllGlobals(); await f.service.close(); }
});
it('G-WEB No limits read grant is call scoped and never saved as consent', async () => {
  const f = await extensionReadFixture(true);
  try {
    extensionPage(await f.read({ length: 4000 }));
    expect(f.approvedSets.at(-1)).toEqual([]);
    expect(f.service.taskInfo(f.binding.bindingId)?.sites).toEqual([]);
    const saved = JSON.parse(readFileSync(f.stateFile, 'utf8'));
    expect(JSON.stringify(saved)).not.toContain('https://fixture.test');
    await expect(f.service.dispatch(f.binding.bindingId, 'agent_browser_snapshot', {}, () => true)).rejects.toThrow('WAITING FOR THE OWNER');
    expect(f.siteCards).toEqual(['https://fixture.test']);
  } finally { await f.service.close(); }
});
it.each(readRoutes.flatMap(route => (['immediate', 'delayed'] as const).flatMap(answer => (['binding', 'settings'] as const).map(setting => [route, answer, setting] as const))))('G-WEB Never Allow works once: %s, %s, %s', async (route, answer, setting) => {
  const site = route === 'URL' ? 'https://first-read.test' : 'https://fixture.test';
  let approved = false, offered: unknown, consumed = 0, answers = 0;
  const f = await extensionReadFixture(true, false, 'owner', 'task', {
    siteSetting: (_context, origin) => setting === 'settings' && origin === site ? { rule: 'never' } : undefined,
    askSite: async (_context, _origin, binding) => { offered = binding; return answer === 'immediate' && ++answers === 1 ? 'allow' : 'waiting'; },
    consumeApproval: (_context, query) => {
      if (!approved || query.kind !== 'site' || JSON.stringify(query.binding) !== JSON.stringify(offered)) return false;
      approved = false; consumed++; return true;
    },
  });
  const fetchPage = vi.fn(async () => new Response(source, { headers: { 'content-type': 'text/markdown' } }));
  vi.stubGlobal('fetch', fetchPage);
  try {
    if (setting === 'binding') await f.service.setSiteAccess(f.binding.bindingId, site, 'never');
    if (answer === 'delayed') {
      await expect(f.read(routeArgs(route))).rejects.toThrow('WAITING FOR THE OWNER');
      expect(f.captures()).toBe(0); expect(fetchPage).not.toHaveBeenCalled();
      approved = true;
    }
    const page = extensionPage(await f.read(routeArgs(route)));
    expect(page).toMatchObject({ total_length: 40000, eof: false, handle: expect.stringMatching(/^w-/) });
    expect(f.siteCards).toEqual([site]); expect(f.actionCards).toEqual([]);
    expect(consumed).toBe(answer === 'delayed' ? 1 : 0);
    expect(f.approvedSets.at(-1)).toEqual([]);
    if (setting === 'binding') expect(f.service.status().bindings[0].sites[site]).toBe('never');
    expect(JSON.parse(readFileSync(f.stateFile, 'utf8')).bindings[0].taskL1).toEqual([]);
    // The answer was used by one call. Continuation is a fresh call and must card again.
    await expect(f.read({ handle: page.handle, offset: page.next_offset, length: 4000 })).rejects.toThrow(route === 'URL' ? 'Browser read destination was not approved.' : 'WAITING FOR THE OWNER');
    expect(f.siteCards).toEqual([site, site]); expect(consumed).toBe(answer === 'delayed' ? 1 : 0);
  } finally { vi.unstubAllGlobals(); await f.service.close(); }
});
