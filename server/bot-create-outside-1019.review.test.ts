import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { ownToolGate, ownToolOfRoute } from './outside-own.ts';
import { turnOutsideRead } from './email/external-marks.ts';
import { useOutsideStoreFixture } from './testing/outside-store-fixture.ts';
import { writerSites } from './testing/botcreate-writers.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
useOutsideStoreFixture();
const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
it('review HIGH: idle routine conversation T admits Ask and captures Ask for staged B', () => {
  const start = index.indexOf('function routinePeerSource(');
  const js = ts.transpileModule(index.slice(start, index.indexOf('function peerRoutineTurnOptions(', start)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const routinePeerSource = new Function('isUnattended', 'routinePeerSources', 'conversationCeilings', 'routineRunLevel', 'routines', 'admittedRoutineCeilings', 'routineWakeCeiling', js + '; return routinePeerSource;')(
    () => false, new Map(), new Map([['T', { permissionMode: 'ask', triggerSource: 'manual' }]]), () => null, { activeRunOrigin: () => null }, new Map(), () => undefined);
  expect(routinePeerSource('T', 'A')).toEqual({ permissionMode: 'ask', triggerSource: 'manual' });
});
it('review MEDIUM: GET queued q123 wait_ms=0 never marks at call time', () => {
  const url = new URL('http://fixture/api/internal/delegations/q123?fromBotId=A&fromThreadId=T&wait_ms=0');
  const tool = ownToolOfRoute('GET', url.pathname);
  expect(tool).toBe('check_delegation');
  expect(ownToolGate({ threadId: 'T', botId: 'A', tool, lane: true })).toBeNull();
  expect(turnOutsideRead('T')).toBeNull();
});
it('review MEDIUM: an unclassified commitBotReview writer is discovered structurally', () => {
  const root = mkdtempSync(join(tmpdir(), 'botcreate-writer-review-'));
  try {
    mkdirSync(join(root, 'server'));
    writeFileSync(join(root, 'server/store.ts'), readFileSync(new URL('./store.ts', import.meta.url)));
    writeFileSync(join(root, 'server/index.ts'), 'function unclassified() { store.commitBotReview(new Map([[bot.id,{...bot,autoApprove:true}]])); }\n');
    expect(writerSites(root).some(site => site.file === 'server/index.ts' && site.code.includes('commitBotReview'))).toBe(true);
  } finally { removeTempDirSync(root); }
});

// Run the actual HTTP polling handler and configured delivery callback, with only
// resolution/storage/provider ports replaced. A status and a peer reply share the sink.
it.each(['queued', 'running', 'done', 'withheld'] as const)('GET q123 wait_ms=0: %s marks only delivered peer content', async phase => {
  const boundary = readFileSync(new URL('./handoff-boundary.ts', import.meta.url), 'utf8');
  const handlerStart = boundary.indexOf('export async function checkDelegationRoute(');
  const handler = boundary.slice(handlerStart, boundary.indexOf('\nexport type DelegateBotRouteContext', handlerStart)).replace('export async', 'async');
  const { botBody, sendBot, configureBotEgress } = await import('./bot-egress.ts');
  const { ownPeerContentDelivered } = await import('./outside-own.ts');
  const { released } = await import('./testing/released.ts');
  const { receiptResultShown } = await import('./handoff-boundary.ts');
  const { status, botName } = await import('./murage-status.ts');
  const sinkStart = index.indexOf('configureBotEgress((res, statusCode, body, shown) => {');
  const sinkEnd = index.indexOf('\n});', sinkStart) + 4;
  const res = {};
  const received: any[] = [];
  const ports: Record<string, unknown> = { configureBotEgress, internalCallers: new Map([[res, { threadId: 'T', botId: 'A' }]]),
    producingTurnOf: () => ({}), addShownToRunningTurn: () => {}, ownPeerContentDelivered,
    json: (_res: unknown, code: number, body: unknown) => { expect(turnOutsideRead('T'), 'no mark before successful delivery').toBeNull(); received.push({ code, body }); } };
  new Function(...Object.keys(ports), ts.transpileModule(index.slice(sinkStart, sinkEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(ports));
  const receipt = { id: 'q123', status: 'done', toBotId: 'B', sourceThreadId: 'T', lineage: true, result: 'answer', copyOf: { threadId: 'B-thread', messageIds: ['answer'] } };
  const resolution = phase === 'queued' ? { kind: 'queued', pending: { toBotId: 'B' } }
    : phase === 'running' ? { kind: 'running', threadId: 'B-thread', watch: { toBotId: 'B', startedAtMs: Date.now() } }
    : { kind: 'receipt', receipt };
  const deps: Record<string, unknown> = { botBody, sendBot, status, receiptResultShown, resolveTaskSealed: () => resolution, taskStatusCode: () => 200,
    resolveReceiptBinding: () => ({ kind: 'bound', requestId: 'request' }), releaseStoredResult: () => phase === 'withheld' ? { kind: 'withheld', line: status('withheld') } : { kind: 'text', text: released('Peer answer') },
    summarizeDelegatedActivity: () => [], formatDelegationElapsed: () => '0s', RECENT_ACTIVITY_SHOWN: 5 };
  const check = new Function(...Object.keys(deps), ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '; return checkDelegationRoute;')(...Object.values(deps));
  const url = new URL('http://fixture/api/internal/delegations/q123?fromBotId=A&fromThreadId=T&wait_ms=0');
  try {
    ownToolGate({ threadId: 'T', botId: 'A', tool: ownToolOfRoute('GET', url.pathname), lane: true });
    await check({ url, res, delegationMatch: ['', 'q123'], internalClaim: { threadId: 'T', botId: 'A' }, requireActiveInternal: () => {}, connectorThread: () => true,
      store: { bot: () => ({ id: 'A' }), nameOf: () => botName({ name: 'B' } as any), rowsSince: () => [] } });
    expect(received).toHaveLength(1); expect(received[0].code).toBe(200);
    expect(received[0].body.status).toBe(phase === 'withheld' ? 'done' : phase);
    expect(turnOutsideRead('T')).toBe(phase === 'done' ? 'another bot' : null);
  } finally { configureBotEgress(undefined); }
});

it('T17s discovers newly named field writers and typed whole-record sinks without a method-name list', async () => {
  const { storePermissionSinks } = await import('./testing/botcreate-writers.ts');
  expect([...storePermissionSinks(`class Store {
    novel(bot) { bot['autoApprove'] = true; this.persist(bot); }
    renamed(records: BotPermissionWrite<ReadonlyMap<string, BotRecord>>) { this.persist(records); }
    read(bot) { return bot.autoApprove; }
  }`)].sort()).toEqual(['novel', 'renamed']);
});
it('mutant: the reviewer unclassified commitBotReview call makes exact T17s inventory RED', () => {
  const root = mkdtempSync(join(tmpdir(), 'botcreate-unclassified-'));
  try {
    mkdirSync(join(root, 'server'));
    writeFileSync(join(root, 'server/store.ts'), readFileSync(new URL('./store.ts', import.meta.url)));
    writeFileSync(join(root, 'server/index.ts'), '');
    const classified = writerSites(root);
    writeFileSync(join(root, 'server/index.ts'), 'function unclassified() { store.commitBotReview(new Map([[bot.id,{...bot,autoApprove:true}]])); }\n');
    expect(() => expect(writerSites(root), 'classify this writer').toEqual(classified)).toThrow();
    console.info('KILLED unclassified-commitBotReview');
  } finally { removeTempDirSync(root); }
});
