import type { Message } from "@/state/store";

export function replySnippet(text: string, limit = 160): string {
  const clean = text
    .replace(/<attached-image\s+path="[^"]*"\s*\/>/g, "[image]")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
export function replyAuthor(message: Message, fallback = "Assistant"): string {
  return message.role === "user" ? "You" : (message.from?.name ?? fallback);
}

/** Escape cancels a pending reply, but not while an input method is composing
 * and not while dictation is on (there Escape stops the recording first). */
export function escapeCancelsReply(
  event: { key: string; isComposing?: boolean },
  state: { replying: boolean; recording: boolean },
): boolean {
  return event.key === "Escape" && !event.isComposing && state.replying && !state.recording;
}

/** The excerpt for the reply strip: the words, without markdown marks. */
export function replyExcerpt(text: string, limit = 120): string {
  const plain = text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
  return replySnippet(plain, limit);
}
