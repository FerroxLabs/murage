// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "@/lib/i18n";
import { imagesOverTurnLimit, type Attachment } from "@/lib/composer-attachments";
import { TURN_IMAGE_LIMITS } from "../../shared/media-assets";

/** Said before sending, never a block: more images are attached than one
 * turn carries, so the first ones go and the rest are left out. The chat says
 * the same after the turn (ImagesLeftOutRow). */
export function ComposerImagesOverLimit({ attachments }: { attachments: readonly Attachment[] }) {
  const over = imagesOverTurnLimit(attachments, TURN_IMAGE_LIMITS.maxCount);
  if (!over) return null;
  return (
    <div
      role="status"
      data-testid="composer-images-over-limit"
      className="mb-2 w-full rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary"
    >
      {over === 1
        ? t("composer.imagesOverLimitOne", { limit: TURN_IMAGE_LIMITS.maxCount })
        : t("composer.imagesOverLimit", { limit: TURN_IMAGE_LIMITS.maxCount, over })}
    </div>
  );
}
