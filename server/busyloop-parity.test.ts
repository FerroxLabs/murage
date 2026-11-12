import { describe, expect, it } from 'vitest';
import { classify, type Endpoint } from '../shared/flux-busyloop.ts';
import { rows, input, leaves, frozenNow, tsvSha } from './testing/busyloop-rows.ts';
it('M0: immutable TSV, all 126 rows and all 93 fixture leaves', () => {
  expect(tsvSha).toBe('47e98f3691bf87058942f09aa092b558bf6116139fb2708da2407d779aca8792');
  expect(rows).toHaveLength(126);
  expect([...leaves.keys()].sort()).toEqual(rows.filter(r => r.status === 'fixture').map(r => r.id).sort());
  expect(leaves.size).toBe(93);
});
describe('A2.1 direct TSV parity', () => {
  for (const r of rows) it(r.id, () => {
    const v = input(r);
    const got = classify(r.endpoint as Endpoint, v.status, v.headers, v.body, frozenNow);
    expect([got.reason, got.action, String(got.wait)]).toEqual([r.reason, r.action, r.wait]);
  });
});

import { LimitTurns, limitOutcome, gatewayBusyLine, type LimitTurn } from './limit-continuation.ts';
import { GatewayBusyStreaks } from './gateway-busy-repeat.ts';
import { keyRejectedMark, isTerminal } from '../shared/flux-busyloop.ts';
const prompt = (): LimitTurn => ({ botId: 'b', threadId: 't', selection: { instanceId: 'flux', model: 'auto' }, engineName: 'Flux', driverKind: 'fuigoAgent', viaGateway: true, sendIds: [], sourceMessageId: 'm', refusalKey: 'prompt', sourceText: 'hi', ownerDirect: true, routine: false, onFailover: false, activity: false });
describe('M12 STOP/PAUSE at the shared resend chokepoint', () => {
  for (const row of rows.filter(r => ['STOP', 'PAUSE'].includes(r.action))) it(row.id, () => {
    const v = input(row), decision = classify(row.endpoint as Endpoint, v.status, v.headers, v.body, frozenNow);
    const turns = new LimitTurns(); turns.begin(prompt());
    let dispatches = 0;
    const submit = () => { turns.assertCanSubmit('t'); dispatches++; };
    submit();
    turns.observe({ threadId: 't', type: 'runtime.error', message: 'refused', fluxDecision: decision });
    expect(isTerminal(decision)).toBe(true);
    for (const _kind of ['sampler', 'limit', 'routine', 'channel', 'resume']) expect(submit).toThrow('Flux refused');
    expect(limitOutcome(turns.get('t')!, { resentByFailover: false, backup: { instanceId: 'other', model: 'm' }, backupUsable: true })).toEqual({ kind: 'none' });
    turns.settle('t');
    expect(() => turns.begin(prompt())).toThrow('Flux refused');
    expect(dispatches).toBe(1);
    turns.begin({ ...prompt(), sourceMessageId: 'new', refusalKey: 'manual-new' }); submit();
    expect(dispatches).toBe(2);
    expect(keyRejectedMark(decision)).toBe(row.reason === 'keyRevoked');
  });
});
it('M15 cause-specific copy and STOP does not advance the repeat counter', () => {
  expect(gatewayBusyLine('Flux', 'freeCap')).not.toMatch(/credit/i);
  expect(gatewayBusyLine('Flux', 'keyTokens')).not.toMatch(/\$|spend/i);
  for (const r of ['keyAccess', 'keyNotFound', 'accessUnknown'] as const) expect(gatewayBusyLine('Flux', r)).not.toMatch(/revoked|new key|Settings/);
  for (const r of ['fluxStop', 'keyRefused'] as const) expect(gatewayBusyLine('Flux', r)).not.toMatch(/allowance|limit|cap|credit/i);
  const streaks = new GatewayBusyStreaks();
  for (let i = 0; i < 4; i++) expect(streaks.refused(prompt(), 'freeCap', frozenNow, false)).toEqual({ count: 0, repeated: false });
  expect([1, 2, 3].map(() => streaks.refused(prompt(), 'unknownLimit', frozenNow, false).repeated)).toEqual([false, false, true]);
});

import { refusalResetAt } from './drivers/flux-busyloop-readers.ts';
it('M10 reset dates are copy only; waits keep the executable spec value', () => {
  const row = rows.find(r => r.id === '12.resp')!, v = input(row);
  const d = classify('resp', v.status, v.headers, v.body, frozenNow);
  expect(d.wait).toBe('-');
  expect(refusalResetAt(d, v.body, frozenNow)).toBe(Date.parse('2026-12-01T00:00:00Z'));
  expect(refusalResetAt({ reason: 'hourly', action: 'STOP', wait: 'reset+1800' }, {}, frozenNow)).toBe(frozenNow + 1800000);
});

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PromptSM, extract, decide, signalsFromUpstream, type DispatchKind } from '../shared/flux-busyloop.ts';
import { specRoot } from './testing/busyloop-rows.ts';
const referenceInputs = (file: string) => JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', [fileURLToPath(new URL('./testing/' + file, import.meta.url))], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
const witnesses = referenceInputs('busyloop-witnesses.py');
const contract = referenceInputs('busyloop-contract.py');
it('retains the original 124-row TSV byte-identically alongside the A2.2 delta', () => {
  const bytes = readFileSync(new URL('busyloop_expected.v21.tsv', specRoot));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('969f4aeb421edfc4808f3cbc9e933dec1114040e288074ae50839f0efcaed551');
  const [header, ...lines] = bytes.toString().trimEnd().split('\n');
  expect(lines).toHaveLength(124);
  for (const line of lines) {
    const fields = line.split('\t');
    const row = Object.fromEntries(header.split('\t').map((key, i) => [key, fields[i]]));
    const v = input(row), got = classify(row.endpoint as Endpoint, v.status, v.headers, v.body, frozenNow);
    expect([got.reason, got.action, String(got.wait)], row.id).toEqual([row.reason, row.action, row.wait]);
  }
});
for (const [name, refreshable, events, expected] of witnesses.traces as Array<[string, boolean, string[][], unknown]>) it(name, () => {
  let sm = new PromptSM(refreshable);
  for (const ev of events) {
    if (ev[0] === 'd') sm.dispatch(ev[1] as DispatchKind, ev[2]);
    else if (ev[0] === 't') sm.refreshToken();
    else if (ev[0] === 'new') sm = new PromptSM(refreshable);
    else if (ev[2] === 'ok') sm.respond(ev[1] as DispatchKind, 200, null);
    else { const r = rows.find(r => r.id === ev[2])!, v = input(r); sm.respond(ev[1] as DispatchKind, v.status, classify(r.endpoint as Endpoint, v.status, v.headers, v.body, frozenNow)); }
  }
  expect(sm.verdict()).toEqual(expected);
});
for (const r of rows.filter(r => r.endpoint === 'resp')) it('A2.2 projection codes/reset: ' + r.id, () => {
  const v = input(r), wire = contract[r.id], signals = signalsFromUpstream(wire.upstream, wire.message, frozenNow);
  expect(signals.codes).toEqual(extract('resp', v.status, v.headers, v.body, frozenNow).codes);
  expect(decide(signals)).toEqual(classify('resp', v.status, v.headers, v.body, frozenNow));
  for (const [k, value] of Object.entries(witnesses.projection[r.id] ?? {})) {
    expect(wire.upstream[k]).toBe(value);
    if (k === 'resets_at') {
      expect(refusalResetAt(decide(signals), wire, frozenNow)).toBe(Date.parse(value as string));
      expect(refusalResetAt(decide(signals), { upstream: wire.upstream }, frozenNow)).toBe(Date.parse(value as string));
    }
  }
});

import { cliRefusal } from './drivers/flux-busyloop-readers.ts';
for (const row of rows.filter(r=>r.endpoint==='resp')) it('nested CLI raw-envelope parity: '+row.id,()=>{
  const v=input(row), got=cliRefusal({data:{http_status:v.status,headers:v.headers,body:v.body}}, frozenNow).decision;
  expect([got.reason,got.action,String(got.wait)]).toEqual([row.reason,row.action,row.wait]);
});
