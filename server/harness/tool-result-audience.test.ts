// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { RuntimeAudienceCollector } from './audience-collector.ts';
import { maskFinancialIdentifiers } from '../../shared/financial-ids.ts';
import type { RuntimeEvent } from '../contracts.ts';

const uuid = 'ee89b347-ede8-442c-8ee2-35b598b2467a';
const directory = `/tmp/session/${uuid}/tool-results`; // displayed path text, not the fixed host form
const resultDirectory = `/tmp/cfg/projects/k/${uuid}/tool-results`;

function fixture(threadId: string) {
  const collector = new RuntimeAudienceCollector();
  const attachment = collector.attach('fixture');
  const source = collector.source(collector.admitNewTurn({ attachment, instanceId: 'fixture', threadId }));
  const event = (fields: Record<string, unknown>) => ({ eventId: 'fixture-event', provider: 'fake',
    providerInstanceId: 'fixture', threadId, createdAt: '2026-11-16T00:00:00.000Z', ...fields }) as RuntimeEvent;
  return { collector, source, event };
}

it('internal tool-result directories cannot latch the owner routine completion', () => {
  const { collector, source, event } = fixture('owner-routine');
  // A valid session UUID also passes the IBAN checksum by coincidence.
  expect(maskFinancialIdentifiers(resultDirectory)).not.toBe(resultDirectory);
  const request = event({ type: 'request.opened', requestType: 'permission', tool: 'Bash',
    summary: 'fixture command', toolResultDirs: [resultDirectory] });
  const opened = collector.intake(request, source);
  expect(opened.execution).toBe(request);
  expect(request).toMatchObject({ toolResultDirs: [resultDirectory] });
  expect(JSON.stringify(opened.audience)).not.toContain(uuid);
  const completion = collector.intake(event({ type: 'item.completed', itemType: 'assistant_text',
    text: 's4 batch complete: cloned folder: 17' }), source);
  expect(completion.audience.some(row => 'text' in row.event && row.event.text === 's4 batch complete: cloned folder: 17')).toBe(true);
});

it('non-owner visible secrets still latch subsequent completion and missing admissions stay closed', () => {
  const { collector, source, event } = fixture('non-owner');
  const secret = '**password**: fixture private value';
  const opened = collector.intake(event({ type: 'request.opened', requestType: 'permission',
    tool: 'Bash', summary: secret, toolResultDirs: ['/tmp/internal-result'] }), source);
  const completion = event({ type: 'item.completed', itemType: 'assistant_text', text: 'private completion' });
  const bytes = JSON.stringify([opened.audience, collector.intake(completion, source).audience,
    collector.intake(completion, undefined).audience]);
  expect(bytes).not.toContain('fixture private value');
  expect(bytes).not.toContain('private completion');
  expect(bytes).not.toContain('/tmp/internal-result');
  expect(bytes).toContain('«redacted»');
});

it('non-owner displayed file paths retain the financial redaction latch', () => {
  const { collector, source, event } = fixture('non-owner');
  const opened = collector.intake(event({ type: 'request.opened', requestType: 'permission',
    tool: 'Read', summary: 'fixture read', filePaths: [directory] }), source);
  const completion = collector.intake(event({ type: 'item.completed', itemType: 'assistant_text',
    text: 'private completion' }), source);
  const bytes = JSON.stringify([opened.audience, completion.audience]);
  expect(bytes).not.toContain(directory);
  expect(bytes).not.toContain('private completion');
  expect(bytes).toContain('«redacted»');
});

const secret = '**password**: fixture private value';
const completionText = 's4 batch complete: cloned folder: 17';
function run(requestType: 'permission' | 'question', toolResultDirs: string[], threadId = 'non-owner') {
  const { collector, source, event } = fixture(threadId);
  const request = event({ type: 'request.opened', requestType, summary: 'fixture request', toolResultDirs });
  const original = structuredClone(request);
  const opened = collector.intake(request, source);
  const completion = collector.intake(event({ type: 'item.completed', itemType: 'assistant_text', text: completionText }), source);
  const delivered = completion.audience.some(row => 'text' in row.event && row.event.text === completionText);
  return { request, original, opened, completion, delivered, bytes: JSON.stringify([opened.audience, completion.audience]) };
}

// W1/W1b: the raw session segment of a fixed-form entry never reaches the latch or the audience.
it.each([
  `/tmp/cfg/projects/k/${uuid}/tool-results`,
  `/tmp/h/sessions/k/${uuid}/mcp`,
  `C:\\cfg\\projects\\k\\${uuid}\\tool-results`,
])('fixed-form result folder %s delivers the completion without the raw session id', dir => {
  expect(maskFinancialIdentifiers(dir)).not.toBe(dir);
  for (const requestType of ['permission', 'question'] as const) {
    const out = run(requestType, [dir]);
    expect(out.delivered).toBe(true);
    expect(out.bytes).not.toContain(uuid);
    expect(out.bytes).toContain('{session}');
  }
});

// W2: a secret that appears only in toolResultDirs still latches the turn (M23/M24 stay T).
it.each(['permission', 'question'] as const)('M23/M24 %s: a secret only in toolResultDirs latches the completion', requestType => {
  const out = run(requestType, [secret]);
  expect(out.bytes).not.toContain('fixture private value');
  expect(out.delivered).toBe(false);
  expect(out.bytes).toContain('«redacted»');
});

// W3: a secret in the scanned part of a fixed-form path latches.
it.each(['permission', 'question'] as const)('M23/M24 %s: a secret in the prefix of a fixed-form folder latches', requestType => {
  const out = run(requestType, [`/tmp/${secret}/projects/k/${uuid}/tool-results`]);
  expect(out.bytes).not.toContain('fixture private value');
  expect(out.delivered).toBe(false);
  expect(out.bytes).toContain('«redacted»');
});

// W4: the exemption is by position only; any other shape is scanned whole.
it.each([
  `/tmp/session/${uuid}/tool-results`,
  `/tmp/cfg/projects/k/${uuid}/notes`,
  `/tmp/cfg/sessions/k/${uuid}/tool-results`,
  `/projects/k/${uuid}/tool-results`,
  `/tmp/cfg/projects//${uuid}/tool-results`,
])('non-fixed folder %s is scanned whole', dir => {
  const out = run('permission', [dir]);
  expect(out.delivered).toBe(false);
  expect(out.bytes).not.toContain(uuid);
});

// W5/C3: execution keeps the original paths.
it('the display copy never mutates the execution event', () => {
  const out = run('permission', [resultDirectory]);
  expect(out.opened.execution).toBe(out.request);
  expect(out.request).toEqual(out.original);
  expect(out.request).toMatchObject({ toolResultDirs: [resultDirectory] });
});
