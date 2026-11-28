import type { Store } from "./store.ts";
import type { EffortTouchStore } from "./drivers/acp/session-effort.ts";

/** ACP-EFFORT L4/W7: the live, store-backed touch record of one task's engine sessions for one provider slot.
 *  Built in `startTurnAdmitting` only, so every caller that resumes a durable task cursor shares it. */
export function effortTouchHandle(store: Store, botId: string, instanceId: string, threadId: string): EffortTouchStore {
  return {
    get: sessionId => store.effortTouchOf(botId, instanceId, threadId, sessionId),
    set: (sessionId, state) => store.setEffortTouch(botId, instanceId, threadId, sessionId, state),
  };
}
