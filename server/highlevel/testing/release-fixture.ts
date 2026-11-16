// A local provider-host fixture still exercises the real retained response sink.
// Its output ends at the test caller; no app, provider or model receives bytes.
import { randomUUID } from "node:crypto";
import type { InternalCapability } from "../../internal-capabilities.ts";
import { WritetimeFixture } from "../../memory/testing/writetime-fixture.ts";
import { closeTurnLineage, openTurnLineage } from "../../memory/lineage-write.ts";
import { prepareRetainedFence } from "../../memory/send-fence.ts";
import { bindConsumingTurn } from "../../consuming-turn-response.ts";
import { registerTestHandle } from "../../test-handle-registry.ts";
const bindings = new WeakMap<InternalCapability, ReturnType<typeof bindConsumingTurn>>();
const cleanups = new Set<() => void>();
registerTestHandle("close", dir => {
  if (dir !== undefined) return;
  for (const close of cleanups) close();
  cleanups.clear();
});
export function highlevelFixtureBinding(claim: InternalCapability) {
  let binding = bindings.get(claim);
  if (binding) return binding;
  const f = new WritetimeFixture();
  const turn = openTurnLineage(f.db, { threadId: claim.threadId, turnId: randomUUID() });
  prepareRetainedFence(turn, { audience: null }, () => {}, f.db);
  binding = bindConsumingTurn({ identity: { botId: claim.botId, threadId: claim.threadId,
    dispatchGeneration: claim.generation, lineageTurnIds: [turn.turnId], adapterLeaseId: claim.generation },
    turn, db: f.db, isCurrent: () => true, onLedgerRefused: () => {} });
  bindings.set(claim, binding);
  cleanups.add(() => { bindings.delete(claim); closeTurnLineage(turn); f.close(); });
  return binding;
}
