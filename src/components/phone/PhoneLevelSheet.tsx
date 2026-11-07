// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone's level sheet (UX L7 part 2; plan L7): the composer's level chip
// opens this over the chat below `md`. Ask and Auto can be picked here; Full
// access and No limits are listed greyed, because they are set on the
// computer, where the owner can see what they change (server/full-access.ts
// refuses them from a phone anyway). Loaded on first open, so it stays off the
// first paint.
import { Check } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { PermissionMode } from "@/lib/permission-mode";
import { PERMISSION_MODES, PermissionModeIcon, cannotAskNote, ownApprovalsNote } from "@/components/PermissionModeMenu";
import { PhoneSheet } from "./PhoneSheet";

/** The only levels a phone sets. */
export const PHONE_LEVELS: ReadonlySet<PermissionMode> = new Set(["ask", "auto"]);

/** The pick a phone may make: Ask or Auto, never Full access or No limits. */
export function phoneLevelPick(mode: PermissionMode): "ask" | "auto" | null {
  return mode === "ask" || mode === "auto" ? mode : null;
}

export interface PhoneLevelSheetProps {
  botName: string;
  current: PermissionMode;
  /** a routine's own conversation: the level is the routine's */
  routine?: string;
  /** the engine's name when it cannot ask before acting (PermissionModeMenu's engineCannotAsk) */
  engineCannotAsk?: string;
  /** the engine's name when it runs on its own tools and approvals */
  engineOwnApprovals?: string;
  onPick: (mode: "ask" | "auto") => void;
  onClose: () => void;
}

export function PhoneLevelSheet({ botName, current, routine, engineCannotAsk, engineOwnApprovals, onPick, onClose }: PhoneLevelSheetProps) {
  return (
    <PhoneSheet title={routine ? t("ux.l7.level.routineTitle", { routine }) : t("ux.l7.level.title", { bot: botName })} onClose={onClose} bodyData={{ "data-phone-level-sheet": "" }}>
      {engineOwnApprovals && <p data-phone-level-engine className="mb-2 px-3 text-[13px] text-warning">{ownApprovalsNote(engineOwnApprovals)}</p>}
      <div role="radiogroup" aria-label={t("ux.l7.level.title", { bot: botName })} className="flex flex-col gap-1">
        {PERMISSION_MODES.map((entry) => {
          const pickable = PHONE_LEVELS.has(entry.mode);
          const on = current === entry.mode;
          return (
            <button
              key={entry.mode}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={pickable ? undefined : true}
              data-phone-level={entry.mode}
              onClick={() => { const pick = phoneLevelPick(entry.mode); if (pick) onPick(pick); }}
              className={cn(
                "flex min-h-14 items-start gap-3 rounded-lg px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                pickable ? "hover:bg-raised-hover" : "cursor-not-allowed opacity-60",
              )}
            >
              <PermissionModeIcon mode={entry.mode} size={18} className="mt-0.5 shrink-0 opacity-70" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center justify-between text-[15px] text-ink">
                  {entry.label}
                  {on && <Check size={16} aria-hidden="true" />}
                </span>
                {pickable && <span className="text-[13px] text-ink-secondary">{entry.detail}</span>}
                {pickable && engineCannotAsk && <span className="text-[13px] text-warning">{cannotAskNote(engineCannotAsk)}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <p data-phone-level-lock className="mt-2 px-3 text-[13px] text-ink-secondary">{t("ux.l7.level.onComputer")}</p>
      <p data-phone-level-scope className="mt-1 px-3 text-[13px] text-ink-secondary">{t(routine ? "ux.l7.level.routineScope" : "ux.l7.level.chatScope")}</p>
    </PhoneSheet>
  );
}
