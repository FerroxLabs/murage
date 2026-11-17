// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('inventories each new limit-choice refusal in English', () => {
  const inventory = readFileSync(new URL('../docs/verification/limit-choice-english.md', import.meta.url), 'utf8');
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  for (const line of ['That choice is already being answered.', 'This choice is no longer available.', 'The choice could not be delivered. Nothing was confirmed.']) {
    expect(source).toContain(line);
    expect(inventory).toContain(`| ${line} |`);
  }
});
