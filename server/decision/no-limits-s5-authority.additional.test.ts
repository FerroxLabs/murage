// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Inert protected-write inputs; only the isolated decision fixture is driven.
import { expect, it, vi } from 'vitest';
import { fixture, d, baseCard, baseRun, card } from './fixture.ts';
import { featureOffLine } from '../feature-off.ts';
import type { Registration, TurnProvenance } from './types.ts';

const samples = [
  { id: 'A1-extract-root', tool: 'Bash', input: { command: 'tar -xf /tmp/a.tar -C /etc', cwd: '/w' } },
  { id: 'A2-member-climb', tool: 'Bash', input: { command: 'tar -xPf /tmp/a.tar ../etc/hosts', cwd: '/w' } },
  { id: 'A3-unknown-cwd', tool: 'Bash', input: { command: 'cd /nope; tar -xf a.tar -C etc', cwd: '/w' } },
  { id: 'A4-link-name', tool: 'Bash', input: { command: 'ln -sf /tmp/blob /etc/s5-link', cwd: '/w' } },
  { id: 'native-write', tool: 'write_file', input: { path: '/etc/s5-file', content: 'fixture-only' } },
] as const;
const exclusions = ['guest', 'other-human', 'shared-room', 'missing-provenance', 'stale-generation', 'other-thread', 'other-bot', 'unknown-initiator', 'unbound-routine'] as const;
type Exclusion = typeof exclusions[number];
function authority(f: ReturnType<typeof fixture>, exclusion?: Exclusion, routineLevel?: Registration['level']) {
  const bot = f.store.createBot({ name: 'S5 authority fixture' }, { seedMessages: false });
  f.store.patchBot(bot.id, { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true });
  const routine = routineLevel !== undefined || exclusion === 'unbound-routine';
  const binding = { sourceRunId: 'run', sourceBotId: bot.id, recipientGeneration: 'g', owner: true };
  const initiator: TurnProvenance['initiator'] = routine
    ? { k: 'routine-run', form: 'run', ...binding, trigger: 'manual' }
    : exclusion === 'guest' || exclusion === 'other-human' ? { k: exclusion } : { k: 'owner-typed' };
  const provenance: TurnProvenance = {
    generation: exclusion === 'stale-generation' ? 'old' : 'g',
    threadId: exclusion === 'other-thread' ? 'other-thread' : 't',
    botId: exclusion === 'other-bot' ? 'other-bot' : bot.id,
    principal: 'owner', roomOwnerOnly: exclusion !== 'shared-room', at: 1, initiator,
  };
  // A newer/unrecognized initiator must fail closed at the runtime boundary.
  if (exclusion === 'unknown-initiator') Object.assign(provenance, { initiator: { k: 'future-initiator' } });
  d.installProvenanceReader({
    turnGenerationFor: () => 'g',
    provenance: () => exclusion === 'missing-provenance' ? undefined : provenance,
    live: () => ({ botId: bot.id, turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner: true,
      level: routineLevel ?? 'unlimited', ...(routine ? { routine: { ...binding, ...(exclusion === 'unbound-routine' ? { sourceRunId: 'wrong-run' } : {}) } } : {}) }),
    ownerThread: () => ({ botId: bot.id, principal: 'owner', level: 'unlimited', origin: 'owner' }),
  });
  return bot;
}
function open(f: ReturnType<typeof fixture>, sample: typeof samples[number]) {
  return f.open(sample.id, sample.input, { tool: sample.tool, toolCall: { name: sample.tool, input: sample.input } });
}
for (const exclusion of exclusions) for (const sample of samples) it(`S5 ${exclusion} cards ${sample.id}`, async () => {
  const f = fixture(); authority(f, exclusion);
  const base = vi.fn(baseCard);
  try {
    expect(d.readTurnPolicy({ threadId: 't', generation: 'g' })).toMatchObject({ level: 'ask' });
    const outcome = d.decide(open(f, sample), base);
    expect(outcome.kind).toBe('card');
    // An intrinsic protected-path decision can card before the legacy callback.
    expect(base.mock.calls.length).toBeLessThanOrEqual(1);
    await d.presentApproval(card(outcome), { title: 'Protected write', subtitle: sample.id });
    expect(d.openApprovals('t')).toHaveLength(1); expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});
for (const level of ['ask', 'full'] as const) for (const sample of samples) it(`S5 explicit routine ${level} cards ${sample.id} on No limits bot`, async () => {
  const f = fixture(); const bot = authority(f, undefined, level); const base = vi.fn(baseCard);
  try {
    expect(f.store.bot(bot.id)).toMatchObject({ noLimits: true });
    expect(d.readTurnPolicy({ threadId: 't', generation: 'g' })).toMatchObject({ actor: 'owner-routine', level });
    const outcome = d.decide(open(f, sample), base);
    expect(outcome.kind).toBe('card');
    // An intrinsic protected-path decision can card before the legacy callback.
    expect(base.mock.calls.length).toBeLessThanOrEqual(1);
    await d.presentApproval(card(outcome), { title: 'Routine protected write', subtitle: sample.id });
    expect(d.openApprovals('t')).toHaveLength(1); expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});
for (const sample of samples) it(`S5 authenticated owner runs ${sample.id} without a card`, async () => {
  const f = fixture(); authority(f); const base = vi.fn(baseCard);
  try {
    expect(d.decide(open(f, sample), base)).toEqual({ kind: 'run' });
    expect(base).not.toHaveBeenCalled(); expect(d.openApprovals('t')).toEqual([]);
  } finally { f.dispose(); }
});
for (const [tool, command] of [['Bash', 'rm -rf ~'], ['PowerShell', 'Remove-Item -Recurse C:\\'], ['Bash', 'rm -rf /']] as const) it(`S5 owner wipe still cards: ${command}`, async () => {
  const f = fixture(); authority(f); const base = vi.fn(baseRun);
  try {
    const input = { command };
    const outcome = d.decide(f.open('wipe', input, { tool, toolCall: { name: tool, input } }), base);
    expect(outcome.kind).toBe('card'); expect(base).not.toHaveBeenCalled();
    await d.presentApproval(card(outcome), { title: 'Wipe check', subtitle: 'Inert fixture input' });
    expect(d.openApprovals('t')).toEqual([expect.objectContaining({ why: 'wipe' })]);
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});
for (const sample of samples) it(`S5 feature off refuses ${sample.id} once without an approval`, async () => {
  const f = fixture(); authority(f); const base = vi.fn(baseRun);
  const line = featureOffLine(sample.tool, { fullAccessChannelMessages: false }, true, 'owner-channel')!;
  d.installDecisionHost({ store: f.store, view: () => ({ title: 'Fixture', subtitle: 'S5' }), featureOff: () => line });
  try {
    const handle = open(f, sample);
    expect(d.decide(handle, base)).toEqual({ kind: 'refuse', message: line });
    expect(d.decide(handle, base)).toEqual({ kind: 'refuse', message: line });
    await d.deliverRequest(handle); await d.deliverRequest(handle);
    expect(base).not.toHaveBeenCalled(); expect(d.openApprovals('t')).toEqual([]);
    const messages = f.db.prepare("SELECT text FROM messages WHERE thread_id='t' AND kind='text'").all();
    expect(messages).toHaveLength(1); expect(messages[0]!.text).toBe(line);
    expect(f.respond).toHaveBeenCalledOnce(); expect(f.respond.mock.calls[0]![1]).toMatchObject({ behavior: 'deny' });
  } finally { f.dispose(); }
});
