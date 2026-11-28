// M6 readers (owner: M6 lane). designs/settings-chat-1023/DESIGN.md section 3, "Reading values".
// A value is returned only through a registered reader that returns the EFFECTIVE value. The list starts at the inline
// ids and grows one W9-checked id at a time. Secrets and private values never get a reader.
import type { WriterTarget } from "../../shared/settings-chat.ts";
import { NOT_KNOWN_YET } from "../../shared/settings-chat.ts";

export interface ReaderBot { id: string; modelSelection?: unknown; tasks?: Array<{ id: string; threadId?: string; modelSelection?: unknown }> }
export interface ReaderContext { bot: ReaderBot; target: WriterTarget }
export type Reader = (context: ReaderContext) => unknown;

const sameModel = (value: unknown): unknown => value ?? NOT_KNOWN_YET;

export const READERS: Readonly<Record<string, Reader>> = {
  // The model the bot's turns use in this thread: the task's own model in a task thread, else the bot's.
  "bot.model": ({ bot, target }) => target.kind === "task"
    ? sameModel(bot.tasks?.find(task => task.id === target.taskId)?.modelSelection)
    : sameModel(bot.modelSelection),
};

/** The effective value, or undefined when the id has no reader (the caller says "Open it to see"). */
export function readSetting(id: string, context: ReaderContext, readers: Readonly<Record<string, Reader>> = READERS): unknown {
  const reader = Object.hasOwn(readers, id) ? readers[id] : undefined;
  return reader ? reader(context) : undefined;
}
