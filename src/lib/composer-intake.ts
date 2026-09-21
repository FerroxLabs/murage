// THE THREE WAYS A FILE GETS INTO A DRAFT, WRAPPED ONCE.
//
// Attach, drop and paste each used to wrap their own intake in
// `trackComposerUpload` inside a React component. The property that matters is
// that ALL of them do, because the counter is what `send()` consults: an
// intake that is not counted lets Enter compose the message without the image
// and then appends the picture to the NEXT draft.
//
// THE GUARD THAT LET THAT GO. Because the wrapping lived in components this
// node-environment suite cannot render, the only check available was a count
// of how many times the string `trackComposerUpload(` appeared in
// Composer.tsx. A reviewer unwrapped the paste path and added a decoy call on
// the attach path; the count stayed at two and 18 tests stayed green. A
// counted occurrence is not a wrapped intake.
//
// The wrapping lives here instead, in two functions the tests RUN with a real
// intake in flight. `composerFileIntake` is the attach button and the drop
// target, which were already the same intake and are now the same call. The
// paste path is separate because it genuinely is: a clipboard image is
// uploaded one file at a time with a per-file error, rather than passed
// through `intakeFiles`. What it is not is exempt from the counter.

import { intakeFiles, type Attachment, type DroppedFile } from "./composer-attachments";
import { trackComposerUpload } from "./composer-uploads";

export interface ComposerFileIntake<T extends DroppedFile & { type: string }> {
  /** The conversation the draft belongs to. One bucket per thread, so an
   *  upload in one never blocks a send in another. */
  threadId: string | undefined;
  files: readonly T[];
  allowImages: boolean;
  getPath: (file: T) => string;
  uploadImage: (file: T) => Promise<Attachment | null>;
  queueAudio?: (file: T) => void;
  onAdd: (attachments: Attachment[]) => void;
  onNotice: (message: string) => void;
  /** The drop target listens on the window and can outlive its component.
   *  A notice is not written to a composer that has gone. */
  stillListening?: () => boolean;
}

/**
 * The attach button and the drop target: one intake, counted for its whole
 * length, append included.
 *
 * Counting only the fetch reopens the same gap a few lines later, where
 * `intakeFiles` has resolved and the chips have not been appended yet. The
 * callback returns after the append, so the count is still up then.
 */
export function composerFileIntake<T extends DroppedFile & { type: string }>(
  intake: ComposerFileIntake<T>,
): Promise<void> {
  return trackComposerUpload(intake.threadId, async () => {
    if (!intake.files.length) return;
    const { attachments, notice } = await intakeFiles(intake.files, {
      allowImages: intake.allowImages,
      getPath: intake.getPath,
      uploadImage: intake.uploadImage,
      queueAudio: intake.queueAudio,
    });
    if (attachments.length) intake.onAdd(attachments);
    if (intake.stillListening && !intake.stillListening()) return;
    // Only a failure changes the notice. This keeps a concurrent successful
    // intake from clearing an error before the person can read it.
    if (notice) intake.onNotice(notice);
  });
}

export interface ComposerPasteIntake<T> {
  threadId: string | undefined;
  files: readonly T[];
  uploadImage: (file: T) => Promise<Attachment | null>;
  onAdd: (attachments: Attachment[]) => void;
  onError: (message: string) => void;
}

/**
 * A clipboard image, or several.
 *
 * Each file is uploaded in turn and a failure is reported per file rather
 * than abandoning the rest, which is the paste path's own behaviour and the
 * reason it is not folded into the one above. The counter is held across all
 * of them: this is the path the reviewer unwrapped.
 */
export function composerPasteIntake<T>(intake: ComposerPasteIntake<T>): Promise<void> {
  return trackComposerUpload(intake.threadId, async () => {
    for (const file of intake.files) {
      try {
        const attachment = await intake.uploadImage(file);
        if (attachment) intake.onAdd([attachment]);
      } catch (err) {
        intake.onError(err instanceof Error ? err.message : "image upload failed");
      }
    }
  });
}
