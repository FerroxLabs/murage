// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ImageOff } from "lucide-react";
import { t } from "@/lib/i18n";

/** A picture the bot's model cannot see was left out of the turn (G11). A
 * neutral note like BrowserUnavailableRow: the reply follows it, so it is
 * neither a tool run nor an error. */
export function ImagesLeftOutRow({ botName, count }: { botName: string; count: number }) {
  return (
    <div className="flex justify-start">
      <div
        role="status"
        data-testid="images-left-out-row"
        className="flex min-w-0 max-w-full items-start gap-2 rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary"
      >
        <span className="mt-[3px] shrink-0" aria-hidden="true"><ImageOff size={12} className="opacity-70" /></span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{t(count > 1 ? "imagesLeftOut.other" : "imagesLeftOut.one", { name: botName })}</span>
      </div>
    </div>
  );
}
