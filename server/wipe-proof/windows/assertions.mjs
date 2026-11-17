// Owner: wg-proof. Compare the entire fake tree, including benign operations.
import { equal } from '../safety.mjs';
export function expectedTree(before, test) {
  const expected = { ...before };
  for (const root of test.remove ?? []) {
    for (const key of Object.keys(expected)) if (key === root || key.startsWith(root + '/')) delete expected[key];
  }
  return expected;
}
export const treeMatches = (before, after, test) => equal(expectedTree(before, test), after);
