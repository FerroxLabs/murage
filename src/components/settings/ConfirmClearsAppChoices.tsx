// Settings v10 B2 (roster): the one confirmation before something resets a bot's saved app choices. Single form
// (Profile, sidebar Archive) and list form (bulk Archive, team delete). Contract C5: shared/settings-v10/archive-review.ts.
import { useRef } from "react";
import { AlertTriangle } from "lucide-react";

import { LayerSurface } from "@/components/LayerSurface";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "@/components/ui/BoxShell";
import { useFocusTrap } from "@/lib/focus-trap";
import type { ConfirmClearsAppChoicesProps } from "../../../shared/settings-v10/archive-review";

type Action = ConfirmClearsAppChoicesProps["action"];

/** What each bot loses, one line per bot: its saved apps, or that it had none chosen. */
export function clearedChoicesLine(bot: ConfirmClearsAppChoicesProps["bots"][number]): string {
  return bot.savedChoices.length ? `${bot.name}: ${bot.savedChoices.join(", ")}` : `${bot.name}: saved choices with no apps chosen`;
}

export function confirmClearsCopy(bots: ConfirmClearsAppChoicesProps["bots"], action: Action): { title: string; lead: string; confirm: string } {
  const one = bots.length === 1;
  const who = one ? bots[0].name : `${bots.length} bots`;
  const resets = `${one ? "Its" : "Their"} saved app choices are not kept. After a restore ${one ? "it starts" : "they start"} at Only chosen apps, with none chosen.`;
  if (action === "archive") return { title: `Archive ${who}?`, lead: `${resets} Chats, memory and skills are kept.`, confirm: one ? "Archive" : `Archive ${bots.length} bots` };
  if (action === "deleteTeamArchive") return { title: "Delete team and archive bots?", lead: `Both choices clear these saved app choices. ${resets}`, confirm: "Delete team and archive bots" };
  return { title: "Delete team and keep bots?", lead: "Both choices clear these saved app choices. A lead stops leading, and each bot with saved choices goes back to Only chosen apps, with none chosen.", confirm: "Delete team and keep bots" };
}

export function ConfirmClearsAppChoices({ bots, action, onConfirm, onCancel }: ConfirmClearsAppChoicesProps) {
  const copy = confirmClearsCopy(bots, action);
  const dialogRef = useRef<HTMLDivElement>(null);
  const layer = useFocusTrap(dialogRef, true, { name: "confirm-clears-app-choices", kind: "dialog", initialFocus: undefined, onEscape: onCancel });
  return (
    <LayerSurface handle={layer}>
      <div className="overlay-inset fixed inset-x-0 top-0 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/60 p-6" onClick={onCancel} role="presentation">
        <div
          className={`${BOX_FRAME} max-h-[calc(var(--vvh,100dvh)-3rem)] w-full max-w-[460px] rounded-2xl border border-hairline/40 bg-panel`}
          onClick={(event) => event.stopPropagation()}
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-clears-title"
        >
          <BoxHead className="items-start justify-start px-6 pt-6">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-danger" />
            <h2 id="confirm-clears-title" className="min-w-0 text-[15px] font-semibold text-ink">{copy.title}</h2>
          </BoxHead>
          <BoxBody className="pl-14 pr-6">
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{copy.lead}</p>
            <ul aria-label="Saved app choices that are cleared" className="mt-2 rounded-lg border border-hairline/40 bg-app px-3 py-2 text-[12.5px] leading-relaxed text-ink">
              {bots.map((bot) => (
                <li key={bot.id}>{clearedChoicesLine(bot)}</li>
              ))}
            </ul>
          </BoxBody>
          <BoxFoot className="block px-6 pb-6 pt-4">
            <div className="flex justify-end gap-2">
              <button type="button" data-confirm-clears="cancel" onClick={onCancel} className="rounded-lg px-3.5 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">
                Cancel
              </button>
              <button type="button" data-confirm-clears="confirm" onClick={onConfirm} className="rounded-lg bg-danger px-3.5 py-2 text-[13px] font-medium text-white">
                {copy.confirm}
              </button>
            </div>
          </BoxFoot>
        </div>
      </div>
    </LayerSurface>
  );
}
