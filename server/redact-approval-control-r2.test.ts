// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { RuntimeAudienceCollector } from './harness/audience-collector.ts';
import { CHARGE_BUDGET_UNITS } from './harness/event-charge.ts';
import type { ExecutionEvent } from './contracts.ts';

it.each(['streams', 'frame'] as const)('an admitted permission keeps its bounded control when the %s display budget is exhausted', budget => {
  const collector = new RuntimeAudienceCollector(), attachment = collector.attach('fixture');
  const source = collector.source(collector.admitNewTurn({ attachment, instanceId: 'fixture', threadId: 'host-thread' }));
  const event = { eventId: 'private-event-id', provider: 'fixture', threadId: 'provider-thread', createdAt: 'now',
    type: 'request.opened', requestType: 'permission', requestId: 'private-request-id', tool: 'PRIVATE_TOOL', summary: 'PRIVATE_SUMMARY',
    ...(budget === 'streams' ? { envInfo: { names: Array.from({ length: 80 }, (_, i) => `PRIVATE_ENV_${i}`) } }
      : { toolCall: { name: 'PRIVATE_TOOL', input: { text: 'x'.repeat(CHARGE_BUDGET_UNITS + 1) } } }) } as ExecutionEvent;
  const result = collector.intake(event, source);
  expect(result.execution).toBe(event);
  expect(result.audience.some(row => row.event.type === 'audience.omitted')).toBe(true);
  const pending = result.audience.find(row => row.event.type === 'request.opened');
  expect(pending?.event).toMatchObject({ type: 'request.opened', requestType: 'permission', threadId: 'host-thread', summary: '«redacted»' });
  expect(JSON.stringify(result.audience)).not.toMatch(/PRIVATE_|private-request-id|private-event-id|provider-thread/);
  expect(collector.intake(event, undefined).audience.some(row => row.event.type === 'request.opened')).toBe(false);
});
