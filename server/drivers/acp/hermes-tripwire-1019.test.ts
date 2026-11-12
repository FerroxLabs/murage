import { mkdtempSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
const canonical = vi.hoisted(() => { vi.resetModules(); return { checks: [] as string[], scanFail: '', failSecond: false }; });
vi.mock('../../hook-canon.ts', async original => ({
  ...await original<typeof import('../../hook-canon.ts')>(),
  ensureCanon: (set: { files: Array<{ path: string; bytes: Buffer }> }, at: string) => {
    canonical.checks.push(at);
    if (canonical.failSecond && canonical.checks.length === 2) return { ok: false, path: set.files[0].path, why: 'changed', error: 'second request obstruction' };
    const changed = set.files.find(file => !readFileSync(file.path).equals(file.bytes));
    return changed ? { ok: false, path: changed.path, why: 'changed', error: 'fixture repair obstruction' } : { ok: true, restored: [] };
  },
  ensureAllLive: () => canonical.scanFail ? [{ ok: false, path: canonical.scanFail, why: 'changed', error: 'scan obstruction' }] : [], dropCanon: () => {},
}));
// NOLIM-B6 rev 8 section 3.3 V-H2: deny and stop even while the
// asynchronous environment inspection has not opened the permission card.
const envInspection = vi.hoisted(() => ({ hold: false, release: undefined as (() => void) | undefined }));
vi.mock('../../engine-env.ts', async original => {
  const actual = await original<typeof import('../../engine-env.ts')>();
  return {...actual, execEnvNow: (...args: Parameters<typeof actual.execEnvNow>) => envInspection.hold
    ? new Promise<undefined>(resolve => { envInspection.release = () => resolve(undefined); })
    : actual.execEnvNow(...args)};
});
import { ownHookCanon, releaseHookCanon, canonFile } from '../../hook-safety.ts';
import { ToolTripwire } from './tool-tripwire.ts';
import { HERMES_ASK_HOOK_SOURCE, hermesAcpSupport } from './hermes.ts';
import { spawnSync } from 'node:child_process';
import { createAcpDriver, type AcpSupport } from './core.ts';
import { ensureDirs } from '../../config.ts';
import { recordEvents, type EventRecorder } from '../../testing/events.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import type { ProviderInstance } from '../../contracts.ts';

const cli = fileURLToPath(new URL('../../testing/fake-acp-cli.ts', import.meta.url));
const incident = 'Hermes ran a tool without Murage’s check, so Murage stopped this turn.';
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let home = '';
afterEach(async () => { recorder?.stop(); await instance?.dispose(); instance = undefined; if (home) removeTempDirSync(home); });
const tool = (status: string, id = 'execution') => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'terminal', kind: 'execute', rawInput: { command: 'echo safe' }, status });
async function run(steps: object[], enabled = true, options: { preFrames?: object[]; resume?: boolean; card?: boolean; corruptBeforeAllow?: boolean; scanFail?: boolean; duplicate?: boolean; foreignFailure?: string; missingCanon?: boolean } = {}) {
  ensureDirs(); chmodSync(cli, 0o755);
  home = mkdtempSync(join(tmpdir(), 'hermes-trip-'));
  const overlay = join(home, 'overlay.yaml');
  writeFileSync(overlay, 'canonical overlay');
  canonical.checks = []; canonical.scanFail = options.foreignFailure ?? (options.scanFail ? overlay : ''); canonical.failSecond = !!options.duplicate;
  const support = { driverKind: 'hermesTripTest', displayName: 'Hermes', models: { default: '', options: [] }, defaultCli: cli,
    nativeSource: 'test.acp', loginNote: 'unused', spawnArgs: (_config, _turn, ctx) => { if (!options.missingCanon && ctx) ctx.hookCanon = { id: 'fixture-hermes', files: [{ path: overlay, bytes: Buffer.from('canonical overlay'), sha256: '', kind: 'config', engine: 'hermes', root: home }] }; return []; }, pickAuthMethod: () => null,
    authFailure: 'continue', isAuthenticated: () => true, toolTripwire: enabled,
    toolTripwireMatcher: () => '(?!(?:read_file)$).+',
    normalizeAsk: hermesAcpSupport.normalizeAsk,
  } as AcpSupport;
  const Driver = createAcpDriver(support);
  instance = await Driver.create({ instanceId: 'trip-test', displayName: 'Hermes', enabled: true, config: Driver.decodeConfig({ cli, fullAuto: !(options.card || options.duplicate) }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_PRE_FRAMES: JSON.stringify(options.preFrames ?? []), FAKE_ACP_MODE: 'fuigo-script', FAKE_ACP_MCP_READY: '1', FAKE_ACP_RPC_LOG: join(home, 'rpc.jsonl'),
      FAKE_ACP_SCRIPT: JSON.stringify([{ at: 1, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } }, ...steps, { at: 150, result: { stopReason: 'end_turn' } }]) } });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: 'trip', text: 'go', cwd: home, ...(options.resume ? { resumeCursor: 'fixture-resume' } : {}) });
  if (options.card) {
    const opened = await recorder.until(e => e.type === 'request.opened');
    if (options.corruptBeforeAllow) writeFileSync(overlay, 'changed after routing');
    if (opened.type === 'request.opened') {
      const response = instance.adapter.respondToRequest('trip', opened.requestId!, { behavior: 'allow' });
      if (options.corruptBeforeAllow) await expect(response).rejects.toThrow('The engine stopped before approval delivery could be confirmed');
      else await response;
    }
  }
  await recorder.until(e => e.type === 'turn.completed', 15000);
  return recorder.events.some((e: any) => e.type === 'runtime.error' && e.message === incident);
}
describe('T17 Hermes execution reports', () => {
  for (const status of ['in_progress', 'completed', 'failed']) it(`initial ${status} without an allow stops`, async () => {
    expect(await run([{ at: 10, update: tool(status) }])).toBe(true);
  });
  it('orphan failed update without an allow stops', async () => {
    expect(await run([{ at: 10, update: { ...tool('failed'), sessionUpdate: 'tool_call_update' } }])).toBe(true);
  });
  it('pending alone does not claim execution', async () => { expect(await run([{ at: 10, update: tool('pending') }])).toBe(false); });
  it('other adapters retain their behavior', async () => { expect(await run([{ at: 10, update: tool('completed') }], false)).toBe(false); });
});

const permission = (id: number, callId: string, options = [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }]) => ({ at: 5, request: { id, method: 'session/request_permission', params: { toolCall: tool('pending', callId), options } } });
// Hermes approval.py wraps our hook's message in a display title and placeholder
// command. Execution reports carry the original tool and arguments instead.
const wrappedPermission = (name: string, input: Record<string, unknown>) => {
  const hook = spawnSync(process.execPath, ['-e', HERMES_ASK_HOOK_SOURCE], {
    input: JSON.stringify({ hook_event_name: 'pre_tool_call', tool_name: name, tool_input: input }), encoding: 'utf8',
  });
  expect(hook.status).toBe(0);
  const { message } = JSON.parse(hook.stdout);
  const placeholder = `<${name}> (plugin approval rule)`;
  const ask = permission(71, 'permission-id');
  return { ...ask, request: { ...ask.request, params: { ...ask.request.params, toolCall: {
    toolCallId: 'permission-id', kind: 'execute', status: 'pending', title: `${message}: ${placeholder}`,
    rawInput: { command: placeholder, description: message },
  } } } };
};

describe('Hermes hook approval wrapper and distinct execution IDs', () => {
  for (const [name, input] of [
    ['terminal', { command: 'echo safe', workdir: '/tmp', cwd: 'ignored-by-Hermes' }],
    ['execute_code', { code: 'print(1)' }],
  ] as const) for (const card of [false, true]) it(`${name}: normalized ${card ? 'card' : 'automatic'} allow covers execution`, async () => {
    expect(await run([wrappedPermission(name, input),
      { at: 5, after: 71, update: { ...tool('in_progress'), title: name, rawInput: input } },
      { at: 10, after: 71, update: { sessionUpdate: 'tool_call_update', toolCallId: 'execution', status: 'completed' } },
    ], true, { card })).toBe(false);
    expect(recorder!.events).toContainEqual(expect.objectContaining({ type: 'turn.completed', ok: true }));
  });

  it('changed arguments still trip after a normalized allow', async () => {
    expect(await run([wrappedPermission('terminal', { command: 'echo approved' }),
      { at: 5, after: 71, update: tool('completed') },
    ])).toBe(true);
  });
  it('a normalized allow cannot cover two executions', async () => {
    expect(await run([wrappedPermission('terminal', { command: 'echo safe' }),
      { at: 5, after: 71, update: tool('completed') },
      { at: 10, after: 71, update: tool('completed', 'second-execution') },
    ])).toBe(true);
    const items = recorder!.events.filter(e => e.type === 'item.started' && e.itemType === 'tool');
    expect(items).toHaveLength(1);
  });
});
describe('T17 sent allows bind actual execution, including terminal-only reports', () => {
  for (const status of ['in_progress', 'completed', 'failed']) it(`a sent allow covers initial ${status}`, async () => {
    expect(await run([permission(71, 'execution'), { at: 5, after: 71, update: tool(status) }])).toBe(false);
  });
  it('different-ID identity/input fallback stays bound through terminal reports', async () => {
    expect(await run([permission(71, 'permission-id'), { at: 5, after: 71, update: tool('in_progress') },
      { at: 10, after: 71, update: { sessionUpdate: 'tool_call_update', toolCallId: 'execution', status: 'completed' } }])).toBe(false);
  });
  it('another execution cannot reuse a bound allow', async () => {
    expect(await run([permission(71, 'permission-id'), { at: 5, after: 71, update: tool('in_progress') },
      { at: 10, after: 71, update: tool('completed', 'second-execution') }])).toBe(true);
  });
  for (const status of ['in_progress', 'failed']) it(`reject then ${status} still trips`, async () => {
    expect(await run([permission(71, 'execution', [{ optionId: 'no', kind: 'reject_once' }]),
      { at: 5, after: 71, update: tool(status) }])).toBe(true);
  });
  it('two equal fallback candidates are ambiguous', async () => {
    expect(await run([permission(71, 'first'), { ...permission(72, 'second'), at: 5, after: 71 },
      { at: 5, after: 72, update: tool('completed') }])).toBe(true);
  });
  it('a status-only orphan update is not exempt', async () => {
    expect(await run([{ at: 10, update: { sessionUpdate: 'tool_call_update', toolCallId: 'missing', status: 'completed' } }])).toBe(true);
  });
  it('explicit free tool is exempt', async () => {
    expect(await run([{ at: 10, update: { ...tool('completed'), title: 'read_file' } }])).toBe(false);
  });
  for (const step of [
    { request: { id: 87, method: 'unknown/tool', params: {} } },
    { rail: '_fuigo/session_notification', update: tool('completed') },
    { notify: { method: 'unknown/tool', params: {} } },
    { meta: { isReplay: true }, update: tool('completed') },
    { update: { sessionUpdate: 'unknown', toolCallId: 'x' } },
    { update: { sessionUpdate: 'config_option_update', toolCallId: 'hidden-tool', configOptions: [] } },
  ]) it(`uncovered frame trips: ${JSON.stringify(step)}`, async () => { expect(await run([{ at: 10, ...step }])).toBe(true); });
});

describe('T17 history qualification and permission sources', () => {
  for (const rail of ['session/update', '_fuigo/session_notification']) for (const replay of [false, true]) {
    it(`pre-prompt ${rail} replay=${replay} without load trips`, async () => {
      expect(await run([], true, { preFrames: [{ rail, update: tool('completed'), meta: { isReplay: replay } }] })).toBe(true);
    });
    it(`pre-prompt ${rail} replay=${replay} with load is history`, async () => {
      expect(await run([], true, { resume: true, preFrames: [{ rail, update: tool('completed'), meta: { isReplay: replay } }] })).toBe(false);
    });
  }
  it('unknown pre-prompt update carrying a toolCallId trips', async () => {
    expect(await run([], true, { preFrames: [{ update: { sessionUpdate: 'unknown', toolCallId: 'hidden-tool' } }] })).toBe(true);
  });
  for (const rail of ['session/update', '_fuigo/session_notification']) it(`post-prompt replay on ${rail} is history only with load`, async () => {
    expect(await run([{ at: 10, rail, update: tool('completed'), meta: { isReplay: true } }], true, { resume: true })).toBe(false);
  });
  it('a resolved-card allow matches its execution', async () => {
    expect(await run([permission(71, 'execution'), { at: 5, after: 71, update: tool('completed') }], true, { card: true })).toBe(false);
  });
  it('pending followed by failed requires an allow', async () => {
    expect(await run([{ at: 5, update: tool('pending') }, { at: 10, update: { sessionUpdate: 'tool_call_update', toolCallId: 'execution', status: 'failed' } }])).toBe(true);
  });
  it('pending followed by allow and failed retains the merged facts', async () => {
    expect(await run([{ at: 2, update: tool('pending') }, permission(71, 'execution'), { at: 5, after: 71, update: { sessionUpdate: 'tool_call_update', toolCallId: 'execution', status: 'failed' } }])).toBe(false);
  });
});

it('T17/V-H2 rechecks F10 after routing and rejects before an allowing send', async () => {
  const records = vi.spyOn(ToolTripwire.prototype, 'record');
  try {
    expect(await run([permission(71, 'execution'), { at: 5, after: 71, update: tool('completed') }], true,
      { card: true, corruptBeforeAllow: true })).toBe(false);
    expect(canonical.checks).toEqual(['V-H2', 'V-H2']);
    expect(records).not.toHaveBeenCalled();
    expect(recorder!.events.some(event => event.type === 'runtime.error' && event.message === 'Murage could not confirm its tool check')).toBe(true);
    expect(recorder!.events.some(event => event.type === 'request.resolved' && event.behavior === 'allow')).toBe(false);
    expect(recorder!.events.some(event => event.type === 'turn.completed' && event.stopReason === 'hook-repair-failed')).toBe(true);
  } finally { records.mockRestore(); }
});

it('T17 the shared send wrapper records a memory-preallow before execution', async () => {
  ensureDirs(); home = mkdtempSync(join(tmpdir(), 'memory-trip-'));
  const original = readFileSync(fileURLToPath(new URL('../../testing/fake-fuigo-memory-acp.mjs', import.meta.url)), 'utf8');
  // Extend the accepted lifecycle peer with a real execution frame after its
  // automatic memory reply. The core still creates and checks the nonce alias.
  const source = original.replace('const toolCall = {', "const toolCall = { toolCallId: 'memory-call',")
    .replace('observed.decisions.push(message.result ?? { error: message.error }); save();', `observed.decisions.push(message.result ?? { error: message.error }); save();
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: { ...permission().params.toolCall, sessionUpdate: 'tool_call', status: 'completed' } } });`);
  const peer = join(home, 'memory-peer.mjs'), dump = join(home, 'wire.json'); writeFileSync(peer, source);
  const Driver = createAcpDriver({ driverKind: 'fuigoAgent', displayName: 'Memory permission fixture', models: { default: '', options: [] },
    defaultCli: process.execPath, nativeSource: 'test.acp', loginNote: 'unused', isAuthenticated: () => true, pickAuthMethod: () => null,
    authFailure: 'continue', toolTripwire: true, toolTripwireMatcher: () => '.+', spawnArgs: (_config, _turn, ctx) => {
      if (ctx) ctx.hookCanon = { id: 'memory-hermes', files: [canonFile(peer, source, 'script', 'hermes', home)] };
      return [peer, 'valid', dump];
    } });
  instance = await Driver.create({ instanceId: 'memory-trip', displayName: 'Memory', enabled: true, config: { cli: process.execPath, fullAuto: false }, environment: { HOME: home } });
  recorder = recordEvents(instance.adapter);
  const records = vi.spyOn(ToolTripwire.prototype, 'record');
  try {
    await instance.adapter.sendTurn({ threadId: 'memory-trip', text: 'Use memory', cwd: home,
      integrations: { memory: { command: process.execPath, args: ['unused-fixture-proxy'], env: { MURAGE_MEMORY_TOKEN: 'fixture' } } } });
    await recorder.until(event => event.type === 'turn.completed');
    expect(JSON.parse(readFileSync(dump, 'utf8'))[0].decisions).toEqual([{ outcome: { outcome: 'selected', optionId: 'once' } }]);
    expect(records).toHaveBeenCalledOnce();
    expect(recorder.events.some(event => event.type === 'request.opened')).toBe(false);
    expect(recorder.events.some(event => event.type === 'runtime.error' && event.message === incident)).toBe(false);
    expect(recorder.events.some(event => event.type === 'item.started' && event.itemType === 'tool')).toBe(true);
  } finally { records.mockRestore(); }
});

it('T17 permission responses have one sending point, including memory preallow', async () => {
  const ts = await import('typescript');
  const { readFileSync } = await import('node:fs');
  const source = ts.createSourceFile('core.ts', readFileSync(fileURLToPath(new URL('./core.ts', import.meta.url)), 'utf8'), ts.ScriptTarget.Latest, true);
  let handler: import('typescript').Node | undefined;
  const find = (node: import('typescript').Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleServerRequest') handler = node.initializer;
    ts.forEachChild(node, find);
  };
  find(source); expect(handler).toBeDefined();
  let sends = 0;
  const visit = (node: import('typescript').Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'send') {
      sends++;
      let parent: import('typescript').Node | undefined = node.parent;
      while (parent && !(ts.isVariableDeclaration(parent) && parent.name.getText(source) === 'sendPermission')) parent = parent.parent;
      expect(parent, 'direct permission send outside sendPermission').toBeDefined();
    }
    ts.forEachChild(node, visit);
  };
  visit(handler!); expect(sends).toBe(1);
});

for (const duplicate of [false, true]) it(duplicate
  ? 'V-H2 duplicate pending permission rejects and stops when hooks are no longer ready'
  : 'V-H2 individual inspection passes but a failing all-live scan denies', async () => {
  const records = vi.spyOn(ToolTripwire.prototype, 'record');
  envInspection.hold = duplicate;
  try {
    const steps = [permission(71, 'execution')];
    if (duplicate) steps.push({ ...permission(71, 'execution'), at: 20 });
    await run(steps, true, { scanFail: !duplicate, duplicate });
    expect(canonical.checks).toEqual(duplicate ? ['V-H2', 'V-H2'] : ['V-H2']);
    expect(records).not.toHaveBeenCalled();
    envInspection.release?.();
    await Promise.resolve();
    expect(recorder!.events.filter(e => e.type === 'request.opened')).toHaveLength(0);
    expect(recorder!.events.some(e => e.type === 'request.resolved' && e.behavior === 'allow')).toBe(false);
    if (duplicate) expect(recorder!.events).toContainEqual(expect.objectContaining({ type: 'request.resolved', behavior: 'deny', source: 'system' }));
    expect(recorder!.events).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'hook-repair-failed' }));
  } finally { envInspection.hold = false; envInspection.release?.(); envInspection.release = undefined; records.mockRestore(); }
});


it('R3 Codex obstruction keeps Hermes authority through two allows and never cancels Hermes', async () => {
  const foreign = { id: 'foreign-codex', files: [canonFile('/native/codex/hook', 'canonical', 'script', 'codex', '/native')] };
  const affected = { engine: 'Codex', revoke: vi.fn(), stop: vi.fn() };
  ownHookCanon(foreign, affected);
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const records = vi.spyOn(ToolTripwire.prototype, 'record');
  try {
    await run([permission(71, 'first'), { at: 5, after: 71, update: tool('completed', 'first') },
      { ...permission(72, 'second'), at: 10, after: 71 }, { at: 5, after: 72, update: tool('completed', 'second') }], true,
      { foreignFailure: foreign.files[0].path });
    expect(records).toHaveBeenCalledTimes(2);
    expect(recorder!.events).toContainEqual(expect.objectContaining({ type: 'turn.completed', ok: true }));
    expect(recorder!.events.some(e => e.type === 'runtime.error')).toBe(false);
    expect(readFileSync(join(home, 'rpc.jsonl'), 'utf8')).not.toContain('session/cancel');
    expect(affected.revoke).toHaveBeenCalled(); expect(affected.stop).toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Codex'));
    expect(log.mock.calls[0][0]).toContain(foreign.files[0].path);
  } finally { log.mockRestore(); records.mockRestore(); releaseHookCanon(foreign); }
});

it('R3 Hermes without a mapped delivery set denies and stops', async () => {
  const records = vi.spyOn(ToolTripwire.prototype, 'record');
  try {
    await run([permission(71, 'execution')], true, { missingCanon: true });
    expect(records).not.toHaveBeenCalled();
    expect(recorder!.events).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'hook-repair-failed' }));
  } finally { records.mockRestore(); }
});
