// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ImageOff } from "lucide-react";
import { t } from "@/lib/i18n";
import { imagesLeftOutKind, imagesLeftOutParams, type ImagesLeftOut } from "../../shared/turn-image-note";

const SENTENCE_KEY = {
  overCount: "imagesLeftOut.overCount",
  overCountOne: "imagesLeftOut.overCountOne",
  tooLarge: "imagesLeftOut.tooLarge",
  tooLargeOne: "imagesLeftOut.tooLargeOne",
  both: "imagesLeftOut.both",
} as const;

/** A turn that went ahead with only some of its images, said in one plain
 * line (shared/turn-image-note.ts). Neutral, like BrowserUnavailableRow: not
 * a tool run (so it stays visible with Settings → Tool calls off) and not an
 * error, so there is no Retry: sending the same images again would leave the
 * same ones out. */
export function ImagesLeftOutRow({ counts }: { counts: ImagesLeftOut }) {
  return (
    <div className="flex justify-start">
      <div
        role="status"
        data-testid="images-left-out-row"
        className="flex min-w-0 max-w-full items-start gap-2 rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary"
      >
        <span className="mt-[3px] shrink-0" aria-hidden="true"><ImageOff size={12} className="opacity-70" /></span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{t(SENTENCE_KEY[imagesLeftOutKind(counts)], imagesLeftOutParams(counts))}</span>
      </div>
    </div>
  );
}
