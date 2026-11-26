// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { RuntimeAudienceCollector } from './harness/audience-collector.ts';
import { CHARGE_BUDGET_UNITS } from './harness/event-charge.ts';
import type { ExecutionEvent } from './contracts.ts';

// MAIN-RULING 2026-11-22T17:47:36Z cause22-E-remainder (b): "The audience display budgets (redact-turn.ts:27 TURN_TEXT_LIMITS,
// audience-collector.ts:129-130, redact-stream-release.ts:26-27) are size cuts on shown text: remove them". Before 1.0.21 these two
// events exhausted a display budget and the card text was withheld behind audience.omitted; now no budget exists, so the same
// over-budget event is shown whole and its control stays, while identity stays host-minted and an unadmitted source still gets no control.
it.each(['streams', 'frame'] as const)('an admitted permission keeps its bounded control when the %s display budget is exhausted', budget => {
  const collector = new RuntimeAudienceCollector(), attachment = collector.attach('fixture');
  const source = collector.source(collector.admitNewTurn({ attachment, instanceId: 'fixture', threadId: 'host-thread' }));
  const event = { eventId: 'private-event-id', provider: 'fixture', threadId: 'provider-thread', createdAt: 'now',
    type: 'request.opened', requestType: 'permission', requestId: 'private-request-id', tool: 'FIXTURE_TOOL', summary: 'FIXTURE_SUMMARY',
    ...(budget === 'streams' ? { envInfo: { names: Array.from({ length: 80 }, (_, i) => `FIXTURE_ENV_${i}`) } }
      : { toolCall: { name: 'FIXTURE_TOOL', input: { text: 'x'.repeat(CHARGE_BUDGET_UNITS + 1) } } }) } as ExecutionEvent;
  const result = collector.intake(event, source);
  expect(result.execution).toBe(event);
  expect(result.audience.some(row => row.event.type === 'audience.omitted')).toBe(false);
  const pending = result.audience.filter(row => row.event.type === 'request.opened');
  expect(pending).toHaveLength(1);
  expect(pending[0]!.event).toMatchObject({ type: 'request.opened', requestType: 'permission', threadId: 'host-thread', tool: 'FIXTURE_TOOL', summary: 'FIXTURE_SUMMARY' });
  expect(JSON.stringify(result.audience)).not.toMatch(/private-request-id|private-event-id|provider-thread/);
  expect(collector.intake(event, undefined).audience.some(row => row.event.type === 'request.opened')).toBe(false);
});
