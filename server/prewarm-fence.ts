import { PrewarmRefused } from "./drivers/warm-pool.ts";
import { cursorStartedBelowSeal, threadSealed, type TaskRecord } from "./store.ts";

/** What the fence reads at the launch, in memory, right before the spawn. */
export interface PrewarmFenceState {
  task: TaskRecord | undefined;
  ownsThread: boolean;
  /** The instance the dispatch would use now. */
  instanceNow: string | undefined;
}

/** May this prewarm launch resume `cursor` (null: start a fresh session) on `instanceId`? Throws PrewarmRefused when not. Every line ends
 * in no start, and the next turn is a cold one. The turn's own write fence checks the same cursor again before any prompt. */
export function checkPrewarmFence(state: PrewarmFenceState, instanceId: string, cursor: string | null): void {
  const { task } = state;
  if (!task || !state.ownsThread) throw new PrewarmRefused("thread");
  if (state.instanceNow !== instanceId) throw new PrewarmRefused("instance-moved");
  if (cursor === null) {
    if (threadSealed(task)) throw new PrewarmRefused("sealed-no-cursor");
    return;
  }
  if (task.resumeCursors?.[instanceId] !== cursor) throw new PrewarmRefused("cursor-moved");
  if (cursorStartedBelowSeal(task, instanceId, cursor)) throw new PrewarmRefused("sealed");
}
