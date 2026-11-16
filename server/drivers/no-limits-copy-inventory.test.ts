// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('R2 inventories every new No limits owner notice with its trigger and source', () => {
  const inventory = JSON.parse(readFileSync(new URL('../../evidence/nolim-eng-r2/user-visible-english.json', import.meta.url), 'utf8')) as Array<{ text: string; trigger: string; source: string }>;
  expect(inventory.map(row => row.text).sort()).toEqual([
    'Antigravity could not start its safety relay. Try again or switch engine.',
    "This engine is running without Murage's shutdown and restart protection because macOS refused it.",
    '${ENGINE} could not stop its refused startup. Try again or switch engine.',
  ].sort());
  for (const row of inventory) {
    expect(row.trigger.length).toBeGreaterThan(20);
    expect(row.source).toMatch(/^server\//);
  }
});
