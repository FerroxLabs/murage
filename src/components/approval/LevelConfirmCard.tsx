// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 3.3: the confirm card for a higher pick to Full access
// or No limits, on the desktop. It is the warning and the open-conversations
// preview in one place: in Settings › Level it stands where the example table
// was; from the chat chip it is the same card, without counts, in a dialog.
import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { t } from "@/lib/i18n";
import { levelName } from "@/lib/fold-words";
import { confirmEffectLine, type LevelRoutine } from "@/lib/level-change";
import type { PermissionMode } from "@/lib/permission-mode";
import { cn } from "@/lib/cn";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "../ui/BoxShell";

export type LevelConfirmEffect =
  | { kind: "default"; conversations: number; routines: readonly LevelRoutine[] }
  | { kind: "conversation" }
  | { kind: "routine"; routine: string };

const SECONDARY = "min-h-11 rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-70";
const PRIMARY = "min-h-11 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-70";

export function LevelConfirmCard({ bot, target, keep, effect, onThisComputer, notice, error, busy, onKeep, onUse, onOnlyNew, boxed }: {
  bot: string;
  target: "full" | "unlimited";
  /** the level the owner stays on: the preview's, never a remembered one */
  keep: PermissionMode;
  effect: LevelConfirmEffect;
  /** the bot drives this computer */
  onThisComputer: boolean;
  /** the stale line, on a card that came back from a fresh preview */
  notice?: string;
  /** a refused save: the card stays open with it */
  error?: string;
  busy?: boolean;
  onKeep: () => void;
  onUse: () => void;
  onOnlyNew?: () => void;
  /** in a dialog: the heading and the buttons stay in view while the words scroll */
  boxed?: boolean;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  // Keep is the default: this is the switch that removes the stops.
  useEffect(() => { keepRef.current?.focus(); }, []);
  const level = levelName(target);
  const heading = t("ux.l1.confirm.title", { level, bot });
  const stale = notice && <p role="status" data-level-stale className="text-warning">{notice}</p>;
  const title = (
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
        <h3 className="text-[14px] font-semibold text-ink">{heading}</h3>
      </div>
  );
  const words = <>
      {target === "unlimited"
        ? <p className="text-ink">{t("ux.l1.confirm.unlimitedBody", { level, bot })}</p>
        : <>
            <p className="text-ink">{t("ux.l1.confirm.fullBody", { level, bot })}</p>
            <p>{t("ux.l1.confirm.fullStill")}</p>
          </>}
      {onThisComputer && <p>{t("ux.l1.confirm.onComputer")}</p>}
      <p data-level-effect>
        {effect.kind === "default" ? confirmEffectLine(effect.conversations, effect.routines)
          : effect.kind === "routine" ? t("ux.l1.confirm.everyRun", { routine: effect.routine })
          : t("ux.l1.confirm.thisConversation")}
      </p>
      {error && <p role="alert" className="text-warning">{error}</p>}
  </>;
  const actions = <>
      <div className="mt-1 flex flex-wrap justify-between gap-2">
        <button ref={keepRef} type="button" disabled={busy} onClick={onKeep} className={SECONDARY}>{t("ux.l1.confirm.keep", { level: levelName(keep) })}</button>
        <button type="button" disabled={busy} onClick={onUse} className={PRIMARY}>{t("ux.l1.confirm.use", { level })}</button>
      </div>
      {effect.kind === "default" && onOnlyNew && (
        <div>
          <button type="button" disabled={busy} onClick={onOnlyNew} className="inline-flex min-h-11 items-center rounded-md px-2 text-[12.5px] text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-70">
            {t("ux.l1.confirm.onlyNew")}
          </button>
          {effect.routines.length > 0 && <p className="px-2 text-[12px]">{t("ux.l1.confirm.routinesFollow")}</p>}
        </div>
      )}
  </>;
  const shape = "text-[13px] leading-relaxed text-ink-secondary";
  if (boxed) return (
    <div data-level-confirm={target} role="group" aria-label={heading} className={cn("flex min-h-0 flex-col", shape)}>
      <BoxHead className="block px-5 pt-5 pb-1.5">{title}</BoxHead>
      <BoxBody className="flex flex-col gap-1.5 px-5">{stale}{words}</BoxBody>
      <BoxFoot className="block px-5 pb-5 pt-1.5">{actions}</BoxFoot>
    </div>
  );
  return (
    <div data-level-confirm={target} role="group" aria-label={heading} className={cn("flex flex-col gap-1.5", shape)}>
      {stale}
      {title}
      {words}
      {actions}
    </div>
  );
}

/** The chat chip's door to the card. */
export function LevelConfirmDialog({ onKeep, ...card }: Parameters<typeof LevelConfirmCard>[0]) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onKeep();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKeep]);
  return (
    <div className="overlay-inset fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onMouseDown={(event) => event.target === event.currentTarget && onKeep()}>
      <div role="dialog" aria-modal="true" aria-label={t("ux.l1.confirm.title", { level: levelName(card.target), bot: card.bot })} className={cn(BOX_FRAME, "max-h-[calc(var(--vvh,100dvh)-3rem)] w-full max-w-[440px] rounded-2xl border border-hairline/50 bg-panel shadow-2xl")}>
        <LevelConfirmCard {...card} onKeep={onKeep} boxed />
      </div>
    </div>
  );
}
