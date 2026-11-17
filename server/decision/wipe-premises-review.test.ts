// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { baseCard, d, fixture } from './fixture.ts';

it('review inventories the provenance failure notice with its product trigger', () => {
  const rows = JSON.parse(readFileSync(new URL('../../docs/verification/wipe-premises-english.json', import.meta.url), 'utf8'));
  expect(rows).toEqual([{ source: 'server/index.ts', surface: 'Own-tool HTTP 503 response',
    trigger: 'Recording own-write provenance failed before the route can change data.',
    text: 'Murage could not record this change. Nothing was changed.', owner: 'r1-wipe-premises' }]);
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  expect(source).toContain(`if (!ownWriteCommit(ownKeys, 200)) return json(res, 503, { error: '${rows[0].text}' });`);
});

it('review oversized write presentation preserves the approved bytes and consumes the card once', async () => {
  const f = fixture('ask'), input = { file_path: `${DATA_DIR}/output.txt`, content: 'x'.repeat(400 * 1024) };
  d.installEngineApprovalBuilder(() => ({ options: ['Allow', 'Deny'], summary: input.content }));
  // The provider retains input; the transport receives only the request's
  // identity. Join that identity as a real provider does before executing it.
  const providerInputs = new Map([['oversized-write', input]]);
  let deliveredInput: unknown;
  f.respond.mockImplementation(async target => { deliveredInput = providerInputs.get(target.requestId); return { state: 'accepted' }; });
  try {
    const h = f.open('oversized-write', input, { tool: 'Write', summary: input.content, toolCall: { name: 'Write', input } });
    const outcome = d.decide(h, baseCard); expect(outcome.kind).toBe('card');
    if (outcome.kind !== 'card') throw Error('write card required');
    await d.presentApproval(outcome.ref, { title: 'Write', subtitle: input.content });
    expect(f.respond).not.toHaveBeenCalled();
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    expect(f.respond).toHaveBeenCalledOnce();
    expect(f.respond.mock.calls[0][1]).toMatchObject({ behavior: 'allow' });
    expect(deliveredInput).toEqual(input);
    expect(d.openApprovals('t')).toHaveLength(0);
    await d.answerApproval(outcome.ref, { behavior: 'allow' });
    await expect(d.answerApproval({ ...outcome.ref }, { behavior: 'allow' })).rejects.toThrow('unissued-approval-ref');
    expect(f.respond).toHaveBeenCalledOnce();
  } finally { f.dispose(); }
});
