import type { AppState, Message } from "./store";
import { showToolCallsEnabled } from "@/lib/feature-flags";

/** One instance per reader. Equal inputs retain the selected object's identity. */
function stable<T extends object | undefined>(read: (state: AppState) => T): (state: AppState) => T {
  let previous: T | undefined;
  return state => {
    const next = read(state);
    if (previous && next && (Object.keys(next) as (keyof T)[]).every(key => Object.is(previous![key], (next as T)![key]))) return previous;
    return (previous = next);
  };
}

export const bubbleSelector = () => stable(state => ({ tts: state.config?.tts }));

export function activitySelector(comm?: Pick<NonNullable<Message["comm"]>, "withBotId" | "groupId">) {
  const avatar = stable(state => {
    const bot = comm ? state.bots.find(bot => bot.id === comm.withBotId) : undefined;
    if (!bot) return undefined;
    const { id, name, color, mascotBody, avatarUrl, avatarCrop, avatarZoom, avatarFocusX, avatarFocusY } = bot;
    return { id, name, color, mascotBody, avatarUrl, avatarCrop, avatarZoom, avatarFocusX, avatarFocusY };
  });
  return stable(state => ({
    peer: avatar(state),
    groupVisible: comm ? state.groups.some(group => group.id === comm.groupId) : false,
  }));
}

export function messagesSelector(threadId: string) {
  let bots: Array<{ id: string; name: string }> = [];
  return stable(state => {
    if (bots.length !== state.bots.length || bots.some((bot, i) => bot.id !== state.bots[i].id || bot.name !== state.bots[i].name)) {
      bots = state.bots.map(({ id, name }) => ({ id, name }));
    }
    return {
      bots,
      instances: state.instances,
      showToolCalls: showToolCallsEnabled(state.config),
      focusMessage: state.focusMessage?.threadId === threadId ? state.focusMessage : null,
    };
  });
}
