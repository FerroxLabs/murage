import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows, input, frozenNow } from '../testing/busyloop-rows.ts';
import { useOutsideStoreFixture } from '../testing/outside-store-fixture.ts';
import { fixtureBotFolder } from '../testing/bot-folder-fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { recordEvents } from '../testing/events.ts';
import { createOpenAIChatRuntime } from './openai-chat.ts';
import { FuigoAgentDriver } from './acp/fuigo.ts';
import { ClaudeDriver } from './claude.ts';
import { LimitTurns, gatewayBusy } from '../limit-continuation.ts';
import { resetKeyRejectionsForTests } from '../key-rejections.ts';
import type { ProviderInstance } from '../contracts.ts';
useOutsideStoreFixture();
const contracts = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', [fileURLToPath(new URL('../testing/busyloop-contract.py', import.meta.url))], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
const captured = readFileSync(new URL('./acp/__fixtures__/fuigo-1.0.41-free-cap-S1-1.jsonl', import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const initial = captured.find(r => r.direction === 'stdout' && JSON.parse(r.line).id === 1);
const cli = fileURLToPath(new URL('../testing/fuigo-captured-cli.mjs', import.meta.url));
let instance: ProviderInstance | undefined;
const paths: string[] = [];
const byteClasses = new Map<string, unknown>();
function sameBytes(row: Record<string, string>, value: unknown, decision: unknown) {
  const key = JSON.stringify([row.endpoint, value]);
  if (byteClasses.has(key)) expect(decision, 'M1b same bytes: ' + row.id).toEqual(byteClasses.get(key));
  else byteClasses.set(key, decision);
}
beforeEach(() => { resetKeyRejectionsForTests(); vi.spyOn(Date, 'now').mockReturnValue(frozenNow); vi.stubEnv('FLUX_API_KEY', 'sk-flux-test-refusal-fixture'); });
afterEach(async () => { await instance?.dispose(); instance = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const p of paths.splice(0)) await removeTempDir(p); });
describe('M1 real transport readers: pinned TSV (contract frames, not capture evidence)', () => {
  for (const r of rows) it(`${r.id} ${r.endpoint} → ${r.reason}/${r.action}/${r.wait}`, async () => {
    const v = input(r);
    let fetches = 0;
    if (r.endpoint === 'chat') {
      vi.stubGlobal('fetch', async () => { fetches++; return new Response(JSON.stringify(v.body), { status: v.status, headers: v.headers }); });
      instance = createOpenAIChatRuntime({ input: { instanceId: 'parity', displayName: 'Flux', enabled: true, environment: {}, config: {} }, driverKind: 'openai-chat-test', apiKey: 'fixture-static-key', apiUrl: 'https://api.fluxrouter.ai/v1', models: () => ({ default: 'flux-auto', options: [{ id: 'flux-auto', label: 'Auto' }] }), requestBody: (model, messages, stream) => ({ model, messages, stream }), httpErrorLabel: 'Flux', missingKeyError: '', unavailableReason: '', retryScale: 0, nativeLog: { source: 'parity', outgoing: () => ({}), incoming: () => ({}) } });
    } else if (r.endpoint === 'msg') {
      const fake = fileURLToPath(new URL('../testing/fake-claude-cli.ts', import.meta.url));
      chmodSync(fake, 0o755);
      instance = await ClaudeDriver.create({ instanceId: 'parity', displayName: 'Claude', enabled: true, environment: { FAKE_CLAUDE_MODE: 'api-error', FAKE_CLAUDE_API_ERROR: `API Error: ${v.status} ${v.body == null ? '' : JSON.stringify(v.body)}` }, config: { cli: fake, permissionMode: 'acceptEdits' } });
    } else {
      const home = mkdtempSync(join(tmpdir(), 'busyloop-parity-')); paths.push(home);
      const file = join(home, 'contract.jsonl');
      const frames = [initial, { direction: 'stdin', line: JSON.stringify({ id: 3, method: 'session/prompt', params: { sessionId: 'parity' } }) }, { direction: 'stdout', line: JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: v.status === 429 ? -32003 : -32000, message: 'Refused', data: contracts[r.id] } }) }];
      writeFileSync(file, frames.map(f => JSON.stringify(f)).join('\n'));
      instance = await FuigoAgentDriver.create({ instanceId: 'parity', displayName: 'Fuigo', enabled: true, environment: { HOME: home }, config: { fullAuto: false, cli: `"${process.execPath}" "${cli}" "${file}"` } });
    }
    const rec = recordEvents(instance.adapter), turns = new LimitTurns();
    turns.begin({ botId: 'b', threadId: 'parity', selection: { instanceId: 'parity', model: 'flux-auto' }, engineName: 'Flux', driverKind: r.endpoint === 'resp' ? 'fuigoAgent' : 'openai-chat-test', viaGateway: true, sendIds: [], sourceMessageId: 'm', sourceText: 'hi', ownerDirect: true, routine: false, onFailover: false, activity: false });
    try {
      await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: 'parity', model: 'flux-auto', text: 'hi', ...(r.endpoint === 'msg' ? { providerRoute: { connectionId: 'fixture', revision: '1', preset: 'flux', protocol: 'anthropic' as const, baseUrl: 'https://api.fluxrouter.ai/v1', apiKey: 'fixture-static-key', model: 'flux-auto' } } : {}) });
      await rec.until(e => e.type === 'turn.completed');
      for (const e of rec.events) turns.observe(e);
      const error = rec.events.find(e => e.type === 'runtime.error') as any;
      const d = error?.fluxDecision;
      sameBytes(r, r.endpoint === 'resp' ? contracts[r.id] : r.endpoint === 'msg' ? [v.status, v.body] : [v.status, v.headers?.['retry-after'], v.headers?.['x-flux-hold-reason'], v.body], d);
      expect(d && [d.reason, d.action, String(d.wait)], JSON.stringify(rec.events)).toEqual([r.reason, r.action, r.wait]);
      if (r.id.startsWith('12.')) {
        expect(error.gatewayResetsAt, 'reset date survives the transport').toBe(Date.parse('2026-12-01T00:00:00Z'));
        expect(turns.get('parity')?.gatewayResetsAt, 'reset date survives turn projection').toBe(error.gatewayResetsAt);
      }
      if (r.reason !== 'other') expect(gatewayBusy(turns.get('parity')!, { resetsAt: null })).toBe(r.reason);
      if (r.endpoint === 'chat' && ['STOP', 'PAUSE'].includes(r.action)) expect(fetches).toBe(1);
    } finally { rec.stop(); }
  }, 15000);
});
