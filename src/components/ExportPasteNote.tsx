// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The line under a message memory left out as notes exported from another
// assistant (PASTE-CAPTURE-FIX 3.3, server/memory/capture.ts). On the desktop,
// for a message typed there, "Review and keep" opens Settings > Memory > Learn
// about me with the paste filled in. A room, a phone or a channel shows the
// line alone (Learn about me is the owner's, on the desktop).
import { t } from "@/lib/i18n";
import { handLamText } from "@/lib/lam-handoff";
import { useDesktopSurface } from "@/lib/use-surface";
import { useStoreActions, type Message } from "@/state/store";

export const LAM_ANCHOR = "learn-about-me-heading";
type Noted = Pick<Message, "memoryNote" | "origin" | "text">;

/** Whether the line offers Review and keep: the desktop app, a 1:1 chat, a message typed on the desktop. */
export function offersReview(message: Noted, desktop: boolean | undefined, room: boolean): boolean {
  return desktop === true && !room && message.origin === "desktop";
}

export function ExportPasteNoteView({ message, offered, onReview }: { message: Noted; offered: boolean; onReview: () => void }) {
  if (message.memoryNote !== "export-paste") return null;
  return (
    <div role="note" data-testid="export-paste-note" className="mt-1 flex max-w-[34rem] flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
      <span>{t("memory.exportPaste.line")}</span>
      {offered && (
        <button type="button" onClick={onReview} data-testid="export-paste-review" className="rounded-md px-2 py-0.5 text-[12px] font-medium text-ink hover:bg-raised">
          {t("memory.exportPaste.button")}
        </button>
      )}
    </div>
  );
}

export function ExportPasteNote({ message, room = false }: { message: Noted; room?: boolean }) {
  const { dispatch } = useStoreActions();
  const desktop = useDesktopSurface();
  if (message.memoryNote !== "export-paste") return null;
  const onReview = () => {
    handLamText(message.text ?? "");
    dispatch({ type: "toggleAppSettings", open: true, section: "memory", anchor: LAM_ANCHOR });
  };
  return <ExportPasteNoteView message={message} offered={offersReview(message, desktop, room)} onReview={onReview} />;
}
