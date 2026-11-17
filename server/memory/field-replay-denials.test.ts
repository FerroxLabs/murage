// SPDX-License-Identifier: AGPL-3.0-or-later
// Consumer and regression owner: r2-memory-semantics. Decision producer: r2-memory-semantics (1115-ORPHAN-OWNERSHIP).
import { expect, it } from 'vitest';
import { baseCard, d, fixture } from '../decision/fixture.ts';
import { guardEngineRelease } from '../decision/provider-release.ts';
import { permissionCard } from './field-replay/surface.ts';

const declined = { kind: 'deny' as const, class: 'host-computer', ruleId: 'host-declined', span: 'local-computer' };
const hostTool = { tool: 'mcp__murage_host_computer__click', toolCall: { name: 'mcp__murage_host_computer__click', input: { x: 1, y: 1 } } };

it('R8: an explicit persisted host denial refuses at No limits with no card and cannot release an Allow', async () => {
  const f = fixture();
  try {
    f.deny([declined]);
    const handle = f.open('host-denied', { x: 1, y: 1 }, hostTool);
    // Sean ruling 2026-11-15: a saved Never is a refusal at No limits; the bot is told no and no card opens.
    expect(d.decide(handle, baseCard)).toMatchObject({ kind: 'refuse' });
    await d.deliverRequest(handle);
    expect(d.openApprovals('t')).toHaveLength(0);
    expect(f.respond).toHaveBeenCalledTimes(1);
    expect(f.respond.mock.calls[0][1].behavior).toBe('deny');
    expect(guardEngineRelease({ threadId: 't', turnId: 'turn', providerInstanceId: 'p', requestId: 'host-denied' })).toBe(false);
  } finally { f.dispose(); }
});

it('R8: a host denial saved after registration fences the native release', () => {
  const f = fixture();
  try {
    const handle = f.open('late-host-denied', { x: 1, y: 1 }, hostTool);
    expect(d.decide(handle, baseCard).kind).toBe('run');
    f.deny([declined]);
    expect(guardEngineRelease({ threadId: 't', turnId: 'turn', providerInstanceId: 'p', requestId: 'late-host-denied' })).toBe(false);
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

it('R8: a saved host denial also fences cached native replay without a registered entry', () => {
  const f = fixture();
  try {
    const identity = { threadId: 't', turnId: 'turn', providerInstanceId: 'p', requestId: 'cached-host' };
    const replay = { tool: hostTool.tool, input: { x: 1, y: 1 } };
    expect(guardEngineRelease(identity, undefined, replay)).toBe(true);
    f.deny([declined]);
    expect(guardEngineRelease(identity, undefined, replay)).toBe(false);
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});


it('R8: public display handles and internal request IDs both count as permission cards; intake does not', () => {
  expect(permissionCard({ kind: 'options', card: { requestHandle: 'p.fixture-card', options: ['Allow', 'Deny'] } })).toBe(true);
  expect(permissionCard({ kind: 'options', card: { requestId: 'fixture-request', options: ['Allow', 'Deny'] } })).toBe(true);
  expect(permissionCard({ kind: 'options', card: { routineRequest: { id: 'fixture-routine' } } })).toBe(true);
  expect(permissionCard({ kind: 'options', card: { intake: { asked: 1 }, options: [] } })).toBe(false);
});
