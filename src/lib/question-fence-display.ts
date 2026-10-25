// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QW Q2 (1.0.4): what a bot message shows of its ```murage-question fences. A closed fence is hidden ONLY when the thread holds
// the question card made from it (a card row whose `fenceOf` names this message and this fence); every other closed fence
// (invalid, over the limits, refused, a room, an older transcript) stays today's code block. While the reply streams, an
// unclosed question fence is never shown as raw JSON: it becomes the quiet line "preparing a question".
// QW Q4: a closed ```murage-widget fence is hidden the same way, only when the widget row made from it exists (`widget.fenceOf`).
import { QUESTION_FENCE, WIDGET_FENCE } from "../../shared/ask-wording";
import { scanMurageFences } from "../../shared/murage-fences";

interface FenceCardRow { card?: { fenceOf?: { messageId: string; index: number } }; widget?: { fenceOf?: { messageId: string; index: number } } }

/** The fences with a card or widget, per bot message: messageId -> "0,2,w0" (question indexes, widget indexes prefixed "w"; a
 * string, so a memoised row compares it by value). */
export function questionFenceCards(messages: readonly FenceCardRow[]): Map<string, string> {
  const byMessage = new Map<string, string[]>();
  for (const message of messages) {
    for (const [fenceOf, prefix] of [[message.card?.fenceOf, ""], [message.widget?.fenceOf, "w"]] as const) {
      if (!fenceOf || typeof fenceOf.messageId !== "string" || !Number.isInteger(fenceOf.index)) continue;
      byMessage.set(fenceOf.messageId, [...(byMessage.get(fenceOf.messageId) ?? []), `${prefix}${fenceOf.index}`]);
    }
  }
  return new Map([...byMessage].map(([id, keys]) => [id, [...new Set(keys)].sort().join(",")]));
}

/** The text to render, and whether the quiet "preparing a question" line follows it. */
export function questionFenceDisplay(text: string, streaming: boolean, carded?: string): { text: string; preparing: boolean } {
  if (!text.includes(QUESTION_FENCE) && !text.includes(WIDGET_FENCE)) return { text, preparing: false };
  const hidden = new Set((carded ?? "").split(",").filter(Boolean));
  const scan = scanMurageFences(text);
  const cut = scan.closed.filter((fence) => hidden.has(`${fence.kind === WIDGET_FENCE ? "w" : ""}${fence.index}`) && (fence.kind === QUESTION_FENCE || fence.kind === WIDGET_FENCE));
  const preparing = streaming && scan.open?.kind === QUESTION_FENCE;
  if (!cut.length && !preparing) return { text, preparing: false };
  let out = "";
  let from = 0;
  for (const fence of cut) {
    out += text.slice(from, fence.start);
    from = fence.end;
  }
  out += text.slice(from, preparing ? scan.open!.start : text.length);
  return { text: out.trimEnd(), preparing };
}
