import { Writable } from 'node:stream';
import type { SendTurnInput } from './contracts.ts';
import { writeAcpResponse, type ApprovalWriteCallback } from './drivers/acp/approval-delivery.ts';
import { releaseNativeAnswer } from './drivers/engine-input.ts';
import { emitEngineWire, type EngineWireRelease } from './drivers/engine-wire.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { FolderTrustStore } from './folder-trust.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const functionOf = (name: string, end: string, context: object, invocation: string) => {
  const text = source.slice(source.indexOf(`function ${name}(`), source.indexOf(end, source.indexOf(`function ${name}(`)));
  return runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + `; ${invocation}`, context);
};
it('T-TRUST-F07-route: desktop Cloud execution never reads the own-home decoy', () => {
  const decoy = vi.fn(() => 'fixture-own-home');
  const result = functionOf('fuigoHomeForTrust', '/** The thread desk Murage', {
    process: { env: {} }, cfg: {}, instanceConfigs: () => ({}), fuigoHomeFromEnv: decoy,
  }, 'fuigoHomeForTrust({instanceId:"fixture",driverKind:"fuigoAgent"},false,true)');
  expect(result).toBeNull(); expect(decoy).not.toHaveBeenCalled();
});

it.each([10, 10_000, 100_000])('T-TRUST-F09-%i: turn assembly does not enumerate saved records', count => {
  const root = mkdtempSync(join(tmpdir(), 'trust-bounds-'));
  try {
    const cwd = join(root, 'workspace'); mkdirSync(cwd);
    const file = join(root, 'folder-trust.json');
    const folders = Object.fromEntries(Array.from({ length: count }, (_, i) => [join(root, `unrelated-${i}`), { folder: join(root, `unrelated-${i}`), decision: 'reject', source: 'card', decidedAt: i }]));
    writeFileSync(file, JSON.stringify({ version: 1, folders }));
    const store = new FolderTrustStore(file);
    const scan = { key: cwd, folder: cwd, sources: [] };
    const enumerations = [vi.spyOn(store, 'turnRecords'), vi.spyOn(store, 'plainPickKeys'), vi.spyOn(store, 'list')];
    const result = functionOf('folderTrustForTurn', '/** Full access with', {
      folderTrust: store, fuigoHomeForTrust: () => null, scanFolderTrustSources: () => scan,
      folderTrustKeyForTurn: () => cwd, upstreamTrustForTurn: () => ({ readable: true }),
      isUnrecordableTrustRoot: () => false, noCardPickFields: () => ({}), readUpstreamTrustFile: () => ({ unreadable: false }),
    }, `folderTrustForTurn({adapter:{capabilities:{folderTrust:true,folderTrustGeneration:2}}},${JSON.stringify(cwd)},false)`);
    expect(enumerations.map(spy => spy.mock.calls.length), 'dispatch must use the indexed capability').toEqual([0, 0, 0]);
    expect(JSON.stringify(result).length, 'serialized pool input has a fixed envelope').toBeLessThan(300_000);
  } finally { removeTempDirSync(root); }
});


it.each(['ineligible', 'owner-direct', 'owner-routine-manual', 'owner-routine-scheduled'] as const)('T-TRUST-F02-producer-%s: the adapter consumes only the authenticated origin and revokes on account changes', kind => {
  let account = 'fixture-account';
  const context = { createHash, cfg: {}, instanceConfigs: () => ({ fixture: { account } }),
    trustOriginNow: () => ({ kind, noLimits: kind !== 'ineligible', authorityGeneration: 'fixture-generation', level: 'unlimited' }),
    store: { bot: () => ({ cwd: '/fixture/workspace', modelSelection: { instanceId: 'fixture' } }), taskByThread: () => undefined },
    folderTrust: { snapshot: () => ({ revision: 'fixture-revision' }) } };
  const invoke = () => functionOf('folderConfigurationAuthorityNow', 'async function changeDecisionLevel(', context,
    'folderConfigurationAuthorityNow("fixture-thread","fixture-generation","fixture-bot")');
  const first = invoke();
  expect(first.owner, 'ineligible origins cannot acquire configuration authority').toBe(kind !== 'ineligible');
  expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
  account = 'replacement-account';
  expect(invoke().revision, 'selected account changes revoke old reply authority').not.toBe(first.revision);
});

it.each(['scoped', 'legacy'])('T-TRUST-F04-replacement-%s: an old reply callback cannot release or report for its successor', async mode => {
  const core = readFileSync(new URL('./drivers/acp/core.ts', import.meta.url), 'utf8');
  const method = core.indexOf(mode === 'scoped' ? 'const handleFolderTrustV2 =' : 'const handleFolderTrustRequest =');
  const start = core.indexOf('const requestProcess = ', method);
  const end = core.indexOf(mode === 'scoped' ? '          const key: unknown = params.workspace;' : '          const kinds = ', start);
  const release = vi.fn(), notice = vi.fn(), settle = vi.fn();
  const context: Record<string, any> = {
    proc: {}, child: {}, automaticConfiguration: true, id: 9006, msg: { id: 9006 }, params: { workspace: '/fixture/workspace', scope: 'configAndCommands' }, sources: [],
    automaticChoice: () => ({ outcome: 'reject' }), explicitFolderConsent: () => ({ outcome: 'trust' }), rejectFolderConfiguration: () => ({ outcome: 'reject' }),
    markFolderTrustUnfit: () => {}, turnHalted: () => false, trustEpochLive: () => true, checkTrustEpoch: () => {},
    releaseTrustHold: release, noteAutomaticFolderChoice: notice, settle, turn: { noLimits: true }, support: {}, lastCliVersion: null,
  };
  context.send = (_frame: unknown, done: (error?: unknown) => void, before?: () => void) => { before?.(); context.queued = done; };
  const promise = runInNewContext(ts.transpileModule(core.slice(start, end) + '; reply("reject")', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.proc = {}; context.child = {}; context.queued();
  expect(await promise, 'the response belongs to the retired process').toBe(false);
  expect(release).not.toHaveBeenCalled(); expect(notice).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
});


it('T-TRUST-F04-replacement-timeout: the old hold timer cannot release a successor hold', () => {
  const core = readFileSync(new URL('./drivers/acp/core.ts', import.meta.url), 'utf8');
  const start = core.indexOf('if (releaseTrustHold) trustHoldBound = setTimeout(');
  const changedStart = core.indexOf('if (releaseTrustHold) { const release = releaseTrustHold;');
  const offset = changedStart >= 0 ? changedStart : start;
  const statement = core.slice(offset, core.indexOf('await trustHold;', offset));
  const armStart = core.indexOf('          const arm = () => {', core.indexOf('const armTrustHold ='));
  const arm = core.slice(armStart, core.indexOf('          if (automaticConfiguration)', armStart));
  const timers: (() => void)[] = [], clear = vi.fn();
  const context = { trustHold: null, releaseTrustHold: null, trustHoldBound: null, FOLDER_TRUST_HOLD_MS: 2000,
    setTimeout: (callback: () => void) => timers.push(callback), clearTimeout: clear, timers };
  const result = runInNewContext(ts.transpileModule(arm + `;
    arm(); ${statement} arm(); ${statement}
    const successor = releaseTrustHold; timers[0]();
    ({ current: releaseTrustHold, successor });`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  expect(result.current, 'a timer belongs only to its original hold').toBe(result.successor);
  expect(clear).not.toHaveBeenCalled();
});

it.each(['trust', 'forget', 'forgetKey'])('T-TRUST-F08-stale-%s: a completed mutation cannot publish into a different Settings subject', async action => {
  const note = readFileSync(new URL('../src/components/FolderTrustNote.tsx', import.meta.url), 'utf8');
  const start = note.indexOf(`  const ${action} = async`);
  const end = note.indexOf('\n  };', start) + '\n  };'.length;
  for (const failed of [false, true]) {
    let accept!: (value: unknown) => void, reject!: (error: Error) => void;
    const pending = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
    const results = vi.fn(), error = vi.fn(), busy = vi.fn(), read = vi.fn(async () => {});
    const sequence = { current: 0 };
    const context = { results: [{ status: { record: { key: '/fixture/old-subject' } } }], readSeq: sequence, folder: '/fixture/old-subject', threadId: 'fixture-thread', botId: 'fixture-bot', subjects: [null],
      api: () => pending, setResults: results, setError: error, setBusy: busy, read, target: () => '',
      folderTrustForgetKeyPath: () => '/api/folder-trust', t: (key: string) => key };
    const completion = runInNewContext(ts.transpileModule(note.slice(start, end) + `; ${action}("/fixture/old-subject")`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    results.mockClear(); error.mockClear(); busy.mockClear();
    sequence.current++; // The picker moved while this exact request was in flight.
    if (failed) reject(new Error('fixture failed request')); else accept({ record: { key: '/fixture/old-subject' } });
    await completion;
    expect(results, 'old success cannot overwrite the current subject').not.toHaveBeenCalled();
    expect(error, 'old error cannot attach to the current subject').not.toHaveBeenCalled();
    expect(busy, 'old completion cannot change current mutation state').not.toHaveBeenCalled();
    expect(read, 'old mutation cannot launch a stale-subject refresh').not.toHaveBeenCalled();
  }
});

it('an unbound reply authority check runs at the physical writer', () => {
  const core = readFileSync(new URL('./drivers/acp/core.ts', import.meta.url), 'utf8');
  const start = core.indexOf('        const send = (obj: unknown, done?: ApprovalWriteCallback');
  const end = core.indexOf('\n        };', start) + '\n        };'.length;
  expect(start).toBeGreaterThan(0);
  const frames: string[] = [], done = vi.fn();
  const before = vi.fn(() => { throw new Error('fixture authority changed'); });
  const stream = new Writable({ write(chunk, _encoding, accepted) { frames.push(String(chunk)); accepted(); } });
  const context = { turnHalted: () => false, rpcPending: new Map(), engineRequestsOpen: new Set(), fuigoWatch: null,
    fence: {}, state: {}, settleHalted: () => {}, fenceBeforeWrite: () => {}, fenceAfterWrite: () => {},
    proc: {}, threadId: 'fixture-thread', requestUrl: undefined, turn: {}, emitEngineWire, releaseNativeAnswer, done, before,
    writeTo: (_thread: string, _proc: object, frame: unknown, callback: ApprovalWriteCallback, url?: string,
      binding?: SendTurnInput['releaseBinding'] | null, check?: () => void, release?: EngineWireRelease) =>
      writeAcpResponse(stream, frame, callback, url, binding, check, release) };
  try {
    runInNewContext(ts.transpileModule(core.slice(start, end) + '; send({jsonrpc:"2.0",id:9006,result:{outcome:"reject"}},done,before)',
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    expect(frames, 'a revoked reply capability releases no bytes').toEqual([]);
    expect(before).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(expect.any(Error), false);
  } finally { stream.destroy(); }
});
