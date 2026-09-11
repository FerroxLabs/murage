import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import { messageSizeLabels } from "../../shared/message-limits";

/** Why the composer kept a message instead of sending it.
 *
 * `too-large` is the composer's own check, made before anything leaves the
 * renderer. `refused` is the harness answering 413 anyway: a harness with a
 * different bound, or a body the JSON escaping pushed past it. */
export type ComposerSendNoticeState = { kind: "too-large" | "refused"; sizeBytes: number };

export function composerSendNoticeText(notice: ComposerSendNoticeState): string {
  const { size, limit } = messageSizeLabels(notice.sizeBytes);
  return notice.kind === "too-large"
    ? t("composer.tooLarge", { size, limit })
    : t("composer.refusedTooLarge", { size });
}

/** The inline explanation beside the composer. It is an alert, so a screen
 * reader announces it the moment Enter does nothing else; the textarea
 * points at it through aria-describedby for as long as it stands. */
export function ComposerSendNotice({
  id,
  notice,
  onDismiss,
}: {
  id: string;
  notice: ComposerSendNoticeState | null;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  const dismiss = t("composer.dismissNotice");
  return (
    <div
      id={id}
      role="alert"
      className="mb-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger"
    >
      <span className="min-w-0 flex-1">{composerSendNoticeText(notice)}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismiss}
        title={dismiss}
        className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
      >
        <X size={13} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </div>
  );
}
