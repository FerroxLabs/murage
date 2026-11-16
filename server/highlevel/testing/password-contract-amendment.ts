// SPDX-License-Identifier: AGPL-3.0-or-later
import amendments from './password-contract-amendment.json' with { type: 'json' };
import usersCreateRedesign from './userscreate-contract-amendment.json' with { type: 'json' };
/** MAIN's narrowly scoped private generation retirement precedes the historical
 * password completion amendment. Normalize only exact
 * approved declarations/hashes when checking older additive freezes. Any other
 * drift remains visible to their original digest assertions. The current full
 * contract is independently checked by frozen-snapshot.test.ts. */
export function beforePasswordContract(snapshot: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(snapshot);
  for (const amendment of [...usersCreateRedesign, ...amendments]) {
    const value = result[amendment.file];
    result[amendment.file] = Array.isArray(value) ? value.map(item => item === amendment.after ? amendment.before : item)
      : value === amendment.after ? amendment.before : value;
  }
  // 93ffcee3d already amended the shared identifier-array guard and its current
  // freeze before this round. The older F0.1/F0.2 digest tests omitted that
  // amendment. Normalize only that exact known hash; do not edit the guard.
  const common = 'server/highlevel/operations/schemas/common.ts';
  if (result[common] === '5780ef27e73e64797eabf7a73fc72b5076f64a27ca6f2db8f8fd8efd07e787e8')
    result[common] = '7f9062c534a5401ce7c11d20ad2b20b2f67155bd27da422c795103dc6fd7bc1d';
  return result;
}
