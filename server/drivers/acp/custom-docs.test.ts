import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('documents per-bot native choices and an isolated verification recipe', () => {
  const guide = readFileSync('docs/custom-engines.md', 'utf8');
  expect(guide).toContain('Choose models per bot');
  expect(guide).toContain('without sending a prompt');
  const recipe = readFileSync('docs/verification/custom-acp-models.md', 'utf8');
  for (const expected of ['custom-selection.test.ts', 'fake-custom-acp-models.ts', 'control-murage.ts launch', 'never', 'restart']) expect(recipe).toContain(expected);
  expect(readFileSync('docs/verification/README.md', 'utf8')).toContain('(custom-acp-models.md)');
});
