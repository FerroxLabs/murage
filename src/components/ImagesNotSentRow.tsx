// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ImageOff } from "lucide-react";
import { t } from "@/lib/i18n";
import { imagesNotSentKind, imagesNotSentParams, type ImagesNotSent } from "../../shared/turn-image-note";

const SENTENCE_KEY = {
  overCount: "imagesNotSent.overCount",
  overCountOne: "imagesNotSent.overCountOne",
  tooLarge: "imagesNotSent.tooLarge",
  tooLargeOne: "imagesNotSent.tooLargeOne",
  both: "imagesNotSent.both",
} as const;

/** A turn that went ahead with only some of its images, said in one plain
 * line (shared/turn-image-note.ts). Neutral, like BrowserUnavailableRow: not
 * a tool run (so it stays visible with Settings → Tool calls off) and not an
 * error, so there is no Retry: sending the same images again would leave the
 * same ones out. */
export function ImagesNotSentRow({ counts }: { counts: ImagesNotSent }) {
  return (
    <div className="flex justify-start">
      <div
        role="status"
        data-testid="images-not-sent-row"
        className="flex min-w-0 max-w-full items-start gap-2 rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary"
      >
        <span className="mt-[3px] shrink-0" aria-hidden="true"><ImageOff size={12} className="opacity-70" /></span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{t(SENTENCE_KEY[imagesNotSentKind(counts)], imagesNotSentParams(counts))}</span>
      </div>
    </div>
  );
}
