// SPDX-License-Identifier: AGPL-3.0-or-later
import { ReleaseBudget } from "../memory/release-budget.ts";
import { withUpstreamOwner } from "../memory/upstream-reader.ts";
import type { LineageVerdict } from "../memory/lineage-types.ts";

/** The relay route supplies this context in production. Transport fixtures
 * retain one budget per generation across opens, retries and later calls. */
export function upstreamOwnerFixture() {
  const budgets = new Map<string, ReleaseBudget>();
  const refuse = (fence: LineageVerdict): never => {
    throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED", fence });
  };
  const budget = (generation: string): ReleaseBudget => {
    let value = budgets.get(generation);
    if (!value) { value = new ReleaseBudget(refuse); budgets.set(generation, value); }
    return value;
  };
  return {
    budget,
    run<T>(generation: string, work: () => T): T {
      return withUpstreamOwner({ budgets: [budget(generation)], refuse }, work);
    },
  };
}
