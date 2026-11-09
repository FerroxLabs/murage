// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L5B: a new routine from one sentence (Desktop.dc.html ~765-781). The
// sheet shows Who and the Level line. "Ask <Chief> to set it up" (the primary)
// puts the sentence in the Chief's chat draft for the owner to send; the bot
// answers with a routine card to approve. Nothing here sends a chat message.
// "Pick a time" opens the full editor with the words as the instructions.
// Reading the When straight from the sentence (schedule-words.ts) is not wired
// in here: Astra r2 blocked it twice, so it is a FIX-LEDGER row of its own.

import { useCalendarLayer, type CalendarLayerProps } from "@/components/CalendarLayer";
import { LayerSurface } from "@/components/LayerSurface";
import { useRef, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { BotAvatar } from "@/components/Avatar";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "@/components/ui/BoxShell";
import { useDirtyBaseline } from "@/hooks/use-dirty-baseline";
import { botRole } from "@/lib/bot-role";
import { cn } from "@/lib/cn";
import { composeIo, type ComposeIo } from "@/lib/compose-link";
import { t } from "@/lib/i18n";
import { levelName } from "@/lib/fold-words";
import { permissionModeOf } from "@/lib/permission-mode";
import { routineInstructionsLimit } from "@/lib/routine-instructions-limit";
import type { RoutineSchedule } from "@/lib/routines";
import { useStore, type Bot } from "@/state/store";

/** Longest routine name the sheet makes from the task (the server takes 255). */
export const SENTENCE_NAME_MAX = 60;

/** Who gets a sentence routine: the chat the owner came from, else the Chief, else the first visible bot. */
export function sentenceRoutineBot(bots: readonly Bot[], preferredId?: string | null): Bot | undefined {
  const visible = bots.filter((bot) => !bot.hidden);
  return (preferredId ? visible.find((bot) => bot.id === preferredId) : undefined)
    ?? visible.find((bot) => botRole(bot) === "chief")
    ?? visible[0];
}

/** A routine name from the task: its first line, cut at a word near 60 characters. */
export function sentenceRoutineName(task: string): string {
  const line = task.split("\n")[0]!.trim();
  if (line.length <= SENTENCE_NAME_MAX) return line;
  const cut = line.slice(0, SENTENCE_NAME_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "");
}

/** The sentence goes into that bot's main chat draft: an empty draft takes it, typed words stay with it after a blank line. Never sends. */
export function routeSentenceToChat(bot: Pick<Bot, "id" | "threadId">, sentence: string, io: ComposeIo = composeIo): void {
  const text = sentence.trim();
  if (!text) return;
  const draftId = `bot:${bot.id}:${bot.threadId}`;
  const existing = io.readDraft(draftId);
  if (!existing.trim()) io.setDraft(draftId, text);
  else if (!existing.includes(text)) io.setDraft(draftId, `${existing.replace(/\s+$/, "")}\n\n${text}`);
  io.focus(bot.id);
}

export interface SentenceChange {
  botId: string;
  name: string;
  prompt: string;
  /** null: the sentence had no When the parser could read. */
  schedule: RoutineSchedule | null;
  at: number;
}

// The sheet holds a text field, so the backdrop is the visual viewport
// (--vvh, styles.css overlay convention), never `inset-0`: on a phone the
// software keyboard would otherwise cover the bottom-aligned sheet. Exported
// for phone-cards.human.spec.ts, which measures them with a keyboard up.
export const NEW_ROUTINE_BACKDROP = "overlay-inset fixed inset-x-0 top-0 flex h-[var(--vvh,100dvh)] items-end justify-center bg-black/50 p-0 md:items-center md:p-3";
export const NEW_ROUTINE_BOX = "max-h-[min(85dvh,calc(var(--vvh,100dvh)-0.5rem))] w-full max-w-[520px] rounded-t-2xl md:max-h-[calc(var(--vvh,100dvh)-1.5rem)] md:rounded-2xl border border-hairline/60 bg-panel shadow-2xl";

export function NewRoutineSheet({ lifecycle,
  preferredBotId,
  chatOnly = false,
  onClose,
  onChange,
  onAskInChat,
}: {
  preferredBotId?: string | null;
  /** A phone (UX L7): schedules are set on the computer, so the words go to the bot's chat only. */
  chatOnly?: boolean;
  onClose: () => void;
  /** "Pick a time": the full editor, with the words as the instructions. */
  onChange: (seed: SentenceChange) => void;
  /** Opens that bot's chat (the sentence is already in its draft). */
  onAskInChat: (botId: string) => void;
} & CalendarLayerProps) {
  const { state } = useStore();
  const [sentence, setSentence] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const dirty = useDirtyBaseline({ sentence });
  const layer = useCalendarLayer(dialogRef, "new-routine-sheet", () => dirty.closeWithAsk(onClose), lifecycle, "textarea");
  const bot = sentenceRoutineBot(state.bots, preferredBotId);
  const level = bot ? levelName(permissionModeOf(bot)) : "";
  const task = sentence.trim();
  const limit = routineInstructionsLimit(task);
  const hasWords = task.length > 0;

  const pickTime = () => {
    if (!bot || !hasWords) return;
    onChange({ botId: bot.id, name: sentenceRoutineName(task), prompt: task, schedule: null, at: Date.now() });
  };

  const askInChat = () => {
    if (!bot || !hasWords) return;
    routeSentenceToChat(bot, sentence);
    onAskInChat(bot.id);
  };

  return <LayerSurface handle={layer}><div className={NEW_ROUTINE_BACKDROP} data-phone-bottom-sheet onMouseDown={(event) => event.target === event.currentTarget && dirty.closeWithAsk(onClose)}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("ux.l5b.new.title")} data-new-routine-sheet className={cn(BOX_FRAME, NEW_ROUTINE_BOX)}>
        <BoxHead className="border-b border-hairline/40 px-5 py-4">
          <div className="text-[16px] font-semibold text-ink">{t("ux.l5b.new.title")}</div>
          <button type="button" onClick={() => dirty.closeWithAsk(onClose)} aria-label={t("ux.l5b.close")} className="flex size-11 items-center justify-center rounded-full text-ink-secondary hover:bg-raised"><X size={17} /></button>
        </BoxHead>
        <BoxBody className="space-y-4 px-5 py-4">
          {!bot ? <p className="text-[12.5px] text-ink-secondary">{t("ux.l5b.new.noBot")}</p> : (
            <>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">{t("ux.l5b.new.prompt")}</span>
                <textarea
                  value={sentence}
                  onChange={(event) => setSentence(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && hasWords) { event.preventDefault(); askInChat(); } }}
                  placeholder={t("ux.l5b.new.placeholder")}
                  rows={3}
                  className="mt-1.5 w-full resize-none rounded-xl border border-hairline/60 bg-inset px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
                />
              </label>
              <div className="space-y-2 text-[12.5px]">
                <div className="grid grid-cols-[96px_1fr] items-center gap-3">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">{t("ux.l5b.who.label")}</span>
                  <span className="flex items-center gap-2 text-ink"><BotAvatar bot={bot} state="idle" size={22} animated={false} />{bot.name}</span>
                </div>
                <div className="grid grid-cols-[96px_1fr] items-center gap-3">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-ink-secondary">{t("ux.l5b.level.label")}</span>
                  <span className="text-ink">{t("ux.l5b.level.follows", { bot: bot.name, level })}</span>
                </div>
              </div>
              {limit && <p className={cn("text-[12px]", limit.over ? "text-danger" : "text-ink-secondary")}>{limit.line}</p>}
            </>
          )}
        </BoxBody>
        {bot && (
          <BoxFoot className="flex-wrap items-center justify-end gap-2 border-t border-hairline/40 px-4 py-3">
            {!chatOnly && <button type="button" disabled={!hasWords} onClick={pickTime} className="flex min-h-11 items-center rounded-lg px-3 text-[12px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">{t("ux.l5b.new.pickTime")}</button>}
            <button type="button" disabled={!hasWords || Boolean(limit?.over)} onClick={askInChat} title={t("ux.l5b.new.askHint", { bot: bot.name })} className="flex min-h-11 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"><MessageSquare size={13} aria-hidden />{t("ux.l5b.new.ask", { bot: bot.name })}</button>
          </BoxFoot>
        )}
      </div>
    </div></LayerSurface>;
}

