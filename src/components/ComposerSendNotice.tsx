import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import { messageSizeLabels } from "../../shared/message-limits";

/** Why the composer kept a message instead of sending it, or changed it.
 *
 * `too-large` is the composer's own check, made before anything leaves the
 * renderer. `refused` is the harness answering 413 anyway: a harness with a
 * different bound, or a body the JSON escaping pushed past it.
 *
 * The two `flux-key` cases are not failures at all, which is why the notice
 * below takes a tone. The composer pulled a pasted key out of the message
 * before it could be sent, because a key that reaches send is a key in the
 * transcript, on disk, and in the next prompt a model reads. Saying nothing
 * would be worse than the paste: the person would think their key went
 * somewhere and have no idea where.
 *
 * `upload-pending` is Enter arriving before an attached image has finished
 * uploading. Sending anyway used to hand the image to the NEXT draft, so the
 * send is held and the reason is said out loud; it clears itself the moment
 * the intake lands and the chip appears. */
export type ComposerSendNoticeState =
  | { kind: "too-large"; sizeBytes: number }
  | { kind: "refused"; sizeBytes: number }
  | { kind: "upload-pending" }
  | { kind: "flux-key-saved" }
  | { kind: "flux-key-failed" };

export function composerSendNoticeText(notice: ComposerSendNoticeState): string {
  if (notice.kind === "flux-key-saved") return FIRST_RUN_COPY.pastedKey.saved;
  if (notice.kind === "flux-key-failed") return FIRST_RUN_COPY.pastedKey.failed;
  if (notice.kind === "upload-pending") return t("composer.uploadPending");
  const { size, limit } = messageSizeLabels(notice.sizeBytes);
  return notice.kind === "too-large"
    ? t("composer.tooLarge", { size, limit })
    : t("composer.refusedTooLarge", { size });
}

/** A caught key is good news and a refused message is bad news, and they must
 *  not look the same. Waiting on an upload is neither: nothing went wrong and
 *  nothing was lost, so it reads as a status rather than an alarm. */
function noticeIsFailure(notice: ComposerSendNoticeState): boolean {
  return notice.kind !== "flux-key-saved" && notice.kind !== "upload-pending";
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
  const failure = noticeIsFailure(notice);
  return (
    <div
      id={id}
      role={failure ? "alert" : "status"}
      className={
        "mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] "
        + (failure ? "border-danger/30 bg-danger/10 text-danger" : "border-hairline/40 bg-card text-ink-secondary")
      }
    >
      <span className="min-w-0 flex-1">{composerSendNoticeText(notice)}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismiss}
        title={dismiss}
        className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-control"
      >
        <X size={13} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </div>
  );
}
