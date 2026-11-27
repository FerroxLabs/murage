import { fixture as decisionFixture, d } from './decision/fixture.ts';
import type { Initiator } from './decision/types.ts';
import { useOutsideStoreFixture } from './testing/outside-store-fixture.ts';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDirs, NATIVE_DIR } from './config.ts';
import type { FolderTrustTurnInput, ProviderInstance, SendTurnInput } from './contracts.ts';
import * as delivery from './drivers/acp/approval-delivery.ts';
import { FuigoAgentDriver } from './drivers/acp/fuigo.ts';
import { FolderTrustStore } from './folder-trust.ts';
import * as seeds from './folder-trust-seed.ts';
import { writeFuigoSeed } from './folder-trust-seed.ts';
import * as activity from './folder-trust-activity.ts';
import * as procs from './procs.ts';
import * as wipeGuard from './drivers/murage-exec-wipe.ts';
import { resetIsolationCache } from './drivers/isolation-cache.ts';
import { recordEvents, type EventRecorder } from './testing/events.ts';
import { removeTempDir } from './testing/cleanup.ts';
import { trustOriginNow } from './decision/trust-origin.ts';

useOutsideStoreFixture();
let lastRun: { timeline: string[]; activity: Array<{ kind: unknown; observation: unknown; reason: unknown }> } = { timeline: [], activity: [] };
type AuthorityCut = 'before-seed' | 'after-seed' | 'before-spawn' | 'during-hold' | 'before-prompt';
const cli = join(dirname(fileURLToPath(import.meta.url)), 'testing/fake-acp-cli.ts');
let root: string, cwd: string, home: string, log: string, dump: string;
let instance: ProviderInstance | undefined, recorder: EventRecorder;
let authority: ReturnType<typeof decisionFixture> | undefined;
beforeEach(() => {
  ensureDirs(); resetIsolationCache(); chmodSync(cli, 0o755);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'trust-primary-')));
  cwd = join(root, 'workspace'); home = join(root, 'home'); log = join(root, 'wire.jsonl'); dump = join(root, 'dump.json');
  mkdirSync(cwd); mkdirSync(join(home, '.fuigo'), { recursive: true });
  writeFileSync(join(home, '.fuigo/auth.json'), '{}');
  writeFileSync(join(cwd, 'AGENTS.md'), 'AUTHORIZED_CONFIGURATION_MARKER');
});
afterEach(async () => { authority?.dispose(); authority = undefined; vi.restoreAllMocks(); delete process.env.MURAGE_ACP_POOL; recorder?.stop(); await instance?.dispose(); instance = undefined; await removeTempDir(root); });

async function run(options: { model?: string; cause?: string; version?: string; scoped?: boolean; ownGrant?: boolean; routed?: boolean; transport?: 'delay' | 'error' | 'stop' | 'authority-change'; drop?: AuthorityCut; command?: string; slowStart?: boolean; localModel?: boolean; askedScope?: string; sourced?: boolean } = {}) {
  authority = decisionFixture();
  const timeline: string[] = [];
  let revision = 'fixture-revision';
  let selectedConfig: string | null = null;
  const originalWrite = delivery.writeAcpResponse;
  // W-T07: the owner's authority changes at exactly one cut; every later read sees the replacement revision
  const activityRows: Array<{ kind: unknown; observation: unknown; reason: unknown }> = [];
  const drop = (at: AuthorityCut) => { if (options.drop === at) { timeline.push(`drop:${at}`); revision = 'replacement-revision'; } };
  lastRun = { timeline, activity: activityRows };
  const record = activity.recordActivity;
  vi.spyOn(activity, 'recordActivity').mockImplementation((...args) => {
    const recorded = record(...args);
    activityRows.push({ kind: args[1], observation: args[4], reason: args[5] });
    if (args[1] === 'process-choice-sent') drop('before-prompt');
    return recorded;
  });
  if (options.drop) {
    const isolate = seeds.isolatedFuigoConfigurationHome, spawnCli = procs.spawnCli;
    vi.spyOn(seeds, 'isolatedFuigoConfigurationHome').mockImplementation((...args) => { drop('before-seed'); const made = isolate(...args); drop('after-seed'); return made; });
    vi.spyOn(procs, 'spawnCli').mockImplementation((...args) => {
      drop('before-spawn'); timeline.push('spawn');
      const made = spawnCli(...args), stream = made.stdin!, write = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation((...bytes: Parameters<typeof write>) => {
        if (JSON.parse(String(bytes[0])).id === 9006) timeline.push('reply-written');
        return write(...bytes);
      });
      return made;
    });
  }
  if (options.transport || options.localModel || options.drop) vi.spyOn(delivery, 'writeAcpResponse').mockImplementation((stream, value, done, ...rest) => {
    const frame = value as { id?: number; method?: string; result?: unknown };
    if (frame.method === 'session/prompt') {
      timeline.push('prompt');
      if (options.localModel) {
        const privateHome = JSON.parse(readFileSync(dump, 'utf8')).env.FUIGO_HOME;
        const file = join(privateHome, 'config.toml');
        selectedConfig = existsSync(file) ? readFileSync(file, 'utf8') : null;
      }
    }
    if (frame.id === 9006 && frame.result) drop('during-hold');
    if (!options.transport) return originalWrite(stream, value, done, ...rest);
    if (frame.id !== 9006 || !frame.result) return originalWrite(stream, value, done, ...rest);
    timeline.push('reply-enqueued');
    if (options.transport === 'error') { timeline.push('reply-error'); done(Object.assign(new Error('fixture write failure'), { code: 'EPIPE' }), false); return; }
    return originalWrite(stream, value, (error, accepted) => {
      if (options.transport === 'stop') void instance?.adapter.interruptTurn('trust-fixture-thread');
      if (options.transport === 'authority-change') revision = 'replacement-revision';
      setTimeout(() => { timeline.push('reply-callback'); done(error, accepted); }, 300);
    }, ...rest);
  });
  const { cause = 'picked', version = '1.0.62', scoped = true, ownGrant = false, routed = false } = options;
  const initiator: Initiator = options.cause === 'routine-webhook'
    ? { k: 'routine-webhook', form: 'webhook', sourceRunId: 'run', sourceBotId: 'source', recipientGeneration: 'fixture-generation', trigger: 'webhook' } as unknown as Initiator
    : ['guest', 'other-human', 'webhook', 'delegation'].includes(options.cause ?? '') ? { k: options.cause } as Initiator : { k: 'owner-typed' };
  d.installProvenanceReader({ turnGenerationFor: () => 'fixture-generation',
    provenance: () => ['missing-proof', 'unproven'].includes(options.cause ?? '') ? undefined : ({ generation: 'fixture-generation', threadId: 'trust-fixture-thread', botId: 'b', principal: 'owner', roomOwnerOnly: true, at: 1, initiator }),
    live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'trust-fixture', principal: 'owner', owner: true, level: 'unlimited', routine: { sourceRunId: 'run', sourceBotId: 'source', recipientGeneration: 'fixture-generation', owner: true } }) });
  const storeFile = join(root, 'saved-folders.json');
  const saved = new FolderTrustStore(storeFile);
  saved.remember(cwd, cause === 'decline' ? 'reject' : 'trust', cause === 'decline' ? 'card' : 'picker');
  const savedBefore = readFileSync(storeFile, 'utf8');
  expect(writeFuigoSeed(join(home, '.fuigo'), ownGrant ? `[folders.${JSON.stringify(cwd)}]\ntrusted = true\nconsent = 2\n` : '')).toBe(true);
  const before = existsSync(join(home, '.fuigo/trusted_folders.toml')) ? readFileSync(join(home, '.fuigo/trusted_folders.toml'), 'utf8') : null;
  instance = await FuigoAgentDriver.create({ instanceId: 'trust-fixture', displayName: 'Fuigo', enabled: true,
    environment: { HOME: home, FUIGO_HOME: join(home, '.fuigo'), FAKE_ACP_MODE: 'folder-trust', FAKE_ACP_TRUST_V: scoped ? '2' : '', FAKE_ACP_VERSION: `fuigo ${version}`,
      FAKE_ACP_RPC_LOG: join(root, 'rpc.jsonl'), FAKE_ACP_MCP_READY: '1', ...(options.askedScope ? { FAKE_ACP_TRUST_SCOPE: options.askedScope } : {}), ...(options.slowStart ? { FAKE_ACP_INIT_DELAY_MS: '2500', FAKE_ACP_TRUST_DELAY_MS: '300' } : {}), FAKE_ACP_TRUST_LOG: log, FAKE_ACP_DUMP: dump,
      ...(cause === 'unpicked-request' ? { FAKE_ACP_TRUST_WORKSPACE: join(root, 'another-folder') } : {}),
      ...(options.command ? { FAKE_ACP_TRUST_THEN_COMMAND: options.command } : {}) },
    config: { cli, fullAuto: false } });
  recorder = recordEvents(instance.adapter);
  // W-T18: a command card the owner is asked is answered Don't allow, so the turn can end
  const commandCards: string[] = [];
  const stopAnswering = options.command ? instance.adapter.onEvent(event => {
    if (event.type !== 'request.opened') return;
    const { execEnv: _env, ...card } = event as { execEnv?: unknown };
    commandCards.push(JSON.stringify(card));
    void instance!.adapter.respondToRequest('trust-fixture-thread', event.requestId!, { behavior: 'deny' });
  }) : undefined;
  const gate = { key: cwd, folder: cwd, sources: ['AGENTS.md'], trustKeys: [], rejects: [], noCardPickKeys: [cwd],
    upstreamReadable: true, seedComplete: true,
    ...(cause === 'decline' ? { decision: 'reject', fromRecord: true, rejects: [{ key: cwd, folder: cwd }] } : {}),
    ...(['actor-filtered-level', 'unavailable-provenance'].includes(cause) ? { noCardPickKeys: [], decision: 'trust', fromRecord: true, trustKeys: [cwd] } : {}),
    ...(cause === 'descendant-decline' ? { rejects: [{ key: join(cwd, 'declined-child'), folder: join(cwd, 'declined-child') }] } : {}),
    ...(cause === 'unreadable' ? { upstreamReadable: false } : {}),
    ...(cause === 'incomplete' ? { seedComplete: false } : {}),
    ...(cause === 'unpicked' ? { noCardPickKeys: [] } : {}),
    ...(ownGrant ? { upstreamTrusted: true } : {}),
    ...(cause === 'saved-trust' ? { decision: 'trust', fromRecord: true, trustKeys: [cwd] } : {}),
    ...(options.sourced ? { sourceNow: () => ({ picked: true, readable: true, declined: false, seedComplete: true, revision: 'fixture-source-revision' }) } : {}),
  } as FolderTrustTurnInput;
  const snapshot = JSON.stringify(gate);
  const input = { warmIdentity: { botId: 'b', audience: 'owner' }, threadId: 'trust-fixture-thread', text: 'go', cwd, stopLine: true, noLimits: ['actor-filtered-level', 'unavailable-provenance'].includes(cause) ? undefined : true,
    folderTrust: gate, ...(options.model ? { model: options.model } : {}), ...(options.localModel ? { model: 'omlx::fixture-model' } : {}),
    folderTrustAuthorityNow: () => ['missing-proof', 'unavailable-provenance'].includes(cause) ? null : ({ generation: 'fixture-generation', level: 'unlimited', owner: !['actor-filtered-level'].includes(cause) && (o => o.kind !== 'ineligible' && o.noLimits)(trustOriginNow({ threadId: 'trust-fixture-thread', generation: 'fixture-generation', botId: 'b' })), revision }),
    ...(routed ? { model: 'fixture-model', providerRoute: { connectionId: 'fixture-route', preset: 'openai', protocol: 'openai', baseUrl: 'http://127.0.0.1:49999/v1', apiKey: 'fixture-provider-key', model: 'fixture-model', revision: 'fixture-revision' } } : {}),
  } as SendTurnInput;
  const { turnId } = await instance.adapter.sendTurn(input);
  if (options.transport === 'error') {
    await expect.poll(() => timeline.includes('reply-error'), { timeout: 5000 }).toBe(true);
    await expect.poll(() => timeline.includes('prompt') || recorder.events.some(e => e.type === 'turn.completed' && e.turnId === turnId), { timeout: 5000, message: 'a failed configuration reply must end the transport attempt' }).toBe(true);
    expect(timeline, 'a failed configuration reply cannot release the first prompt').not.toContain('prompt');
    expect(recorder.events.filter(e => e.type === 'turn.completed' && e.turnId === turnId)).toHaveLength(1);
  }
  expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === turnId)).toMatchObject({ ok: !['error', 'authority-change'].includes(options.transport ?? '') && !options.drop });
  stopAnswering?.();
  const wire = JSON.parse(readFileSync(dump, 'utf8'));
  const events = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  expect(readFileSync(storeFile, 'utf8'), 'automatic configuration never rewrites the real saved store').toBe(savedBefore);
  expect(JSON.stringify(gate), 'automatic replies preserve their saved seed input').toBe(snapshot);
  expect(existsSync(join(home, '.fuigo/trusted_folders.toml')) ? readFileSync(join(home, '.fuigo/trusted_folders.toml'), 'utf8') : null).toBe(before);
  // W-T18 counts its command cards itself; every other run must open none
  if (!options.command) expect(recorder.events.filter(e => e.type === 'request.opened'), 'configuration rejection adds no owner question').toEqual([]);
  const native = join(NATIVE_DIR, 'trust-fixture-thread.ndjson');
  const seedGateRecord = existsSync(native) ? readFileSync(native, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.msg?.acpPool === 'folder-config-seed').at(-1)?.msg : undefined;
  const unfitRows = existsSync(native) ? readFileSync(native, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.msg?.acpPool === 'unfit').map(row => row.msg.reason) : [];
  const seedGateTrace = seedGateRecord ? { seed: seedGateRecord.reason === 'seed-suppressed' ? 'suppressed' : 'present', preset: seedGateRecord.outcome === 'trust' ? 'allowed' : 'withheld' } : undefined;
  return { input, wire, timeline, activity: activityRows, commandCards, commandReplies: events.filter(e => e.event === 'command-reply').map(e => JSON.parse(e.raw).result?.outcome), selectedConfig, seedGateTrace, unfitRows, events: recorder.events, replies: (scoped ? events.filter(e => e.event === 'reply').map(e => JSON.parse(e.raw).result) : [wire.decision]), text: recorder.events.filter(e => e.type === 'content.delta').map(e => (e as { delta?: string }).delta ?? '').join('') };
}

describe('F02/F03 real ACP spawn, seed, wire and prompt', () => {
  it('T-TRUST-F02-selected-model: native isolation retains the selected local model without copying folder configuration', async () => {
    const result = await run({ localModel: true });
    expect(result.selectedConfig).toContain('model = "fixture-model"');
    expect(result.wire.env.FUIGO_HOME).not.toBe(join(home, '.fuigo'));
    expect(result.replies).toEqual([{ outcome: 'trust', scope: 'configAndCommands', duration: 'process' }]);
    expect(result.text).toContain('AUTHORIZED_CONFIGURATION_MARKER');
  });
  it('T-TRUST-F04-callback: first prompt follows successful reply callback, including a slow startup', async () => {
    const result = await run({ transport: 'delay', slowStart: true });
    expect(result.timeline).toEqual(['reply-enqueued', 'reply-callback', 'prompt']);
    expect(result.text).toContain('AUTHORIZED_CONFIGURATION_MARKER');
  });
  it.each(['error', 'stop', 'authority-change'] as const)('T-TRUST-F04-%s: no prompt or success notice after the response capability is lost', async transport => {
    const result = await run({ transport });
    expect(result.timeline).not.toContain('prompt');
    expect(result.events.filter(e => e.type === 'item.started').map(e => (e as { title?: string }).title)).not.toContain('folder process choice sent:');
  });
  it.each(['decline', 'descendant-decline', 'guest', 'actor-filtered-level', 'unavailable-provenance', 'missing-proof', 'unreadable', 'incomplete', 'unpicked', 'unpicked-request'])('T-TRUST-C1-%s: no startup or wire grant, no instruction marker', async cause => {
    const result = await run({ cause });
    expect(result.wire.argv, 'no automatic durable launch grant').not.toContain('--trust');
    expect(result.wire.folderTrust.trustedAtBuild).toBe(false);
    expect(result.replies).toEqual([{ outcome: 'reject' }]);
    expect(result.text).not.toContain('AUTHORIZED_CONFIGURATION_MARKER');
    expect(result.text).toContain('agents: withheld');
  });
  it('T-TRUST-H2-picked: process duration and first-prompt configuration without persistence', async () => {
    const result = await run();
    expect(result.wire.argv).not.toContain('--trust');
    expect(result.replies).toEqual([{ outcome: 'trust', scope: 'configAndCommands', duration: 'process' }]);
    expect(result.text).toContain('AUTHORIZED_CONFIGURATION_MARKER');
  });
  it('T-TRUST-C1-own-home: a saved grant cannot preload rejected configuration', async () => {
    const result = await run({ cause: 'decline', ownGrant: true });
    expect(result.wire.folderTrust.trustedAtBuild).toBe(false);
    expect(result.text).toContain('agents: withheld');
    expect(result.replies).toEqual([{ outcome: 'reject' }]);
  });
  it('T-TRUST-C1-seed: the routed launch does not materialize a No limits grant', async () => {
    const result = await run({ cause: 'decline', routed: true });
    expect(result.seedGateTrace, 'the live seed path must not mint even an unused grant snapshot').toEqual({ seed: 'suppressed', preset: 'withheld' });
    expect(result.wire.folderTrust.trustedAtBuild).toBe(false);
    expect(result.replies).toEqual([{ outcome: 'reject' }]);
    expect(result.text).toContain('agents: withheld');
  });
  it.each(['1.0.34', '1.0.37', 'nightly'])('T-TRUST-C1-old-%s: configuration stays withheld without a durable compatibility grant', async version => {
    const result = await run({ version, scoped: version !== '1.0.34' });
    expect(result.wire.argv).not.toContain('--trust');
    expect(result.replies).toEqual([{ outcome: 'reject' }]);
    expect(result.text).toContain('agents: withheld');
  });
});

// These witnesses use the production ACP driver, a real saved store and a real seed write.
// W-T07: an automatic launch has no seed file (its private home is the seed), so cuts 1 and 2 bracket that home's build.
it.each(['before-seed', 'after-seed', 'before-spawn', 'during-hold', 'before-prompt'] as const)('authority-drop-retires-grant (W-T07 cut %s)', async cut => {
  if (cut === 'before-seed' || cut === 'after-seed') {
    // the launch fence refuses the turn before any engine exists
    await expect(run({ drop: cut })).rejects.toThrow('Folder settings changed. Send your message again.');
    expect(lastRun.timeline, 'no spawn, no reply, no session/prompt after authority drop').toEqual([`drop:${cut}`]);
    expect(lastRun.activity, 'nothing is recorded as sent').toEqual([]);
    return;
  }
  const result = await run({ drop: cut });
  expect(result.timeline, 'the cut was reached').toContain(`drop:${cut}`);
  expect(result.timeline, 'no session/prompt after authority drop').not.toContain('prompt');
  expect(result.text).not.toContain('AUTHORIZED_CONFIGURATION_MARKER');
  expect(result.wire.argv).not.toContain('--trust');
  if (cut === 'before-spawn' || cut === 'during-hold') expect(result.timeline, 'no physical trust reply after authority drop').not.toContain('reply-written');
  // decided after the drop, the reply is refused at its own write fence: the engine hears no grant and nothing is recorded as sent
  if (cut === 'before-spawn') { expect(result.replies).toEqual([]); expect(result.activity).toEqual([]); }
});
it('authority-unavailable-reason (W-T07, M-T30): a failed authority lookup is withheld with that reason, never as a saved no', async () => {
  const result = await run({ cause: 'missing-proof' });
  expect(result.replies).toEqual([{ outcome: 'reject' }]);
  expect(result.activity.filter(row => row.kind === 'configuration-withheld').map(({ observation, reason }) => ({ observation, reason })))
    .toEqual([{ observation: 'configuration-withheld', reason: 'authority-unavailable' }]);
});
it('automatic-unpicked-trust-never-persists (W-T01)', async () => {
  const result = await run({ cause: 'unpicked-request' });
  expect(result.replies).toEqual([{ outcome: 'reject' }]);
  expect(result.text).not.toContain('AUTHORIZED_CONFIGURATION_MARKER');
});
it('saved-decline-withholds-configuration (W-T02)', async () => {
  const result = await run({ cause: 'decline', routed: true });
  expect(result.seedGateTrace).toEqual({ seed: 'suppressed', preset: 'withheld' });
  expect(result.replies).toEqual([{ outcome: 'reject' }]);
  expect(result.text).not.toContain('AUTHORIZED_CONFIGURATION_MARKER');
});
it.each(['guest', 'other-human', 'webhook', 'routine-webhook', 'delegation', 'unproven'])(
  'ineligible-origin-gets-no-configuration (W-T04 %s, noLimits=true)', async cause => {
    const result = await run({ cause });
    expect(result.replies).toEqual([{ outcome: 'reject' }]);
    expect(result.wire.argv).not.toContain('--trust');
    expect(result.text).not.toContain('AUTHORIZED_CONFIGURATION_MARKER');
  });
it.each(['configOnly', 'none'])('scope-other-than-config-and-commands-never-process-trusts (W-T04 scope %s, picked owner at No limits)', async askedScope => {
  const result = await run({ askedScope });
  expect(result.replies).toEqual([{ outcome: 'reject' }]);
  expect(result.activity.filter(row => row.kind === 'configuration-withheld').map(row => row.reason)).toEqual(['unsupported-scope']);
  expect(result.wire.argv).not.toContain('--trust');
  expect(result.text).not.toContain('AUTHORIZED_CONFIGURATION_MARKER');
});
it('picked-source-never-answers-a-different-request-key (W-T01 source says picked)', async () => {
  const result = await run({ cause: 'unpicked-request', sourced: true });
  expect(result.replies).toEqual([{ outcome: 'reject' }]);
  expect(result.text).not.toContain('AUTHORIZED_CONFIGURATION_MARKER');
});
it('generation1-saved-trust-at-no-limits-passes-no-trust-flag (W-T05)', async () => {
  const result = await run({ cause: 'saved-trust', version: '1.0.34', scoped: false });
  expect(result.wire.argv).not.toContain('--trust');
  expect(result.replies).toEqual([{ outcome: 'reject' }]);
});
it('generation1-no-automatic-trust-flag (W-T05)', async () => {
  const result = await run({ version: '1.0.34', scoped: false });
  expect(result.wire.argv).not.toContain('--trust');
  expect(result.replies).toEqual([{ outcome: 'reject' }]);
});
it('picked-owner-process-trust-before-first-prompt (W-T06 control, real provenance)', async () => {
  process.env.MURAGE_ACP_POOL = '1';
  // Keep unrelated home and guard-file churn from hiding a broken trust retirement guard.
  const guardEnvironment = wipeGuard.wipeGuardTurnEnvironment;
  vi.spyOn(wipeGuard, 'wipeGuardTurnEnvironment').mockImplementation(o => guardEnvironment({ ...o,
    start: async () => ({ file: join(root, 'fixture-wipe-guard'), end: async () => {} }) }));
  const isolated = seeds.isolatedFuigoConfigurationHome({ sourceHome: join(home, '.fuigo') });
  vi.spyOn(seeds, 'isolatedFuigoConfigurationHome').mockReturnValue({ home: isolated.home, release() {} });
  try {
    const result = await run({ model: 'fake-acp-model' });
    const next = await instance!.adapter.sendTurn({ ...result.input, resumeCursor: 'fake-acp-session' });
    expect(await recorder.until(e => e.type === 'turn.completed' && e.turnId === next.turnId)).toMatchObject({ ok: true });
    const prompts = readFileSync(join(root, 'rpc.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.method === 'session/prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1].pid, 'the next turn processIdentity must differ after an automatic choice').not.toBe(prompts[0].pid);
    expect(result.unfitRows, 'a process that took an automatic reply is marked and never handed to another turn').toEqual(['folder-trust-undecided']);
    expect(result.replies).toEqual([{ outcome: 'trust', scope: 'configAndCommands', duration: 'process' }]);
    expect(result.text).toContain('AUTHORIZED_CONFIGURATION_MARKER');
  } finally { await instance?.dispose(); instance = undefined; isolated.release(); }
});
// W-T18, driver half: a configuration reject leaves the command path untouched. The driver hands every
// engine ask to the owner decision layer (which alone decides wipe-only at No limits), and the answer reaches the engine.
it.each(['rm -rf ~', 'echo fixture-command'])('wipe-still-cards-under-owner-no-limits-after-reject (W-T18 driver half: %s)', async command => {
  const result = await run({ cause: 'decline', command });
  expect(result.replies, 'the folder configuration stays withheld').toEqual([{ outcome: 'reject' }]);
  expect(result.text).not.toContain('AUTHORIZED_CONFIGURATION_MARKER');
  expect(result.commandCards, 'the ask reaches the decision layer once, unchanged').toEqual([expect.stringContaining(`"title":${JSON.stringify(command)}`)]);
  expect(result.commandReplies, 'the decision reaches the engine').toEqual([expect.objectContaining({ optionId: 'reject-once' })]);
});
it.each(['decline', 'actor-filtered-level'])('rejected-route-never-reuses-granted-home (W-T19 %s)', async cause => {
  const result = await run({ cause, ownGrant: true });
  expect(result.wire.env.FUIGO_HOME, 'the rejected route runs in a private home, not an unset one that falls back to the granted home').toEqual(expect.any(String));
  expect(result.wire.env.FUIGO_HOME).not.toBe(join(home, '.fuigo'));
  expect(result.replies).toEqual([{ outcome: 'reject' }]);
  expect(result.text).not.toContain('AUTHORIZED_CONFIGURATION_MARKER');
});
