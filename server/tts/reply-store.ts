/** Store hooks run in the conversation writer's transaction. */
import type { SendStore } from "../send-store.ts";
import type { Store } from "../store.ts";
import type { ReplyState } from "./reply-state.ts";
export function bindReplyStore(store: Store, state: ReplyState, sends?: SendStore): void {
  sends?.setSpeechAccepted(input => {
    if ((input.origin === "desktop" || input.origin === "companion") && input.status !== "refused" && input.status !== "cancelled")
      state.acceptPrompt(input.threadId, input.sendId);
  });
  store.setSpeechHooks({
    attribute: (threadId, message) => message.role === "bot" && message.turnId && message.actorKind !== "murage"
      ? state.generation(threadId, message.turnId, message.from?.botId)?.generation_id : undefined,
    prompt: (threadId, message) => { state.prompt(threadId, message.sendId ? `send:${message.sendId}` : `message:${message.id}`); },
    settle: (threadId, turnId, message, outcome) => {
      const generation = state.generation(threadId, turnId, message?.from?.botId);
      if (generation && message?.speechGenerationId === generation.generation_id)
        state.settle(threadId, turnId, message.id, outcome === "completed", message.from?.botId);
      else if (outcome !== "completed") state.settle(threadId, turnId, undefined, false);
    },
    deleted: threadId => { state.invalidate(threadId); },
  });
}
