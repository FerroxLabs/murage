// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { loadCopy, shippedMap, ledgerProblems, readReviewInputs } from '../../scripts/copy-lint.mjs';
it('all eight packs have independent valid reviews for every F3 title', () => {
  const copy = loadCopy();
  const titles = copy.entries.filter(e => e.key.startsWith('highlevel.titles.conversations.'));
  expect(titles).toHaveLength(160);
  const failures = ledgerProblems({ ...readReviewInputs(), shipped: shippedMap(copy), english: copy.english, required: true });
  expect(failures.filter(p => p.includes('highlevel.titles.conversations.'))).toEqual([]);
});
