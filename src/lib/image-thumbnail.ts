// Which image bytes a chat thumbnail asks for (spec §6). The server shrinks
// attachments and screen frames on `?w=` (server/image-thumbnail.ts); the
// browser picks a width from the srcset for the space and the screen's
// density. The lightbox and Download always use the original `src`.
import { THUMBNAIL_WIDTHS } from "../../shared/image-thumbnail";

/** Inline chat images are at most about the transcript column, and the whole
 *  width of a phone. */
export const THUMBNAIL_SIZES = "(max-width: 767.98px) 90vw, 480px";

/** Same shape the harness names attachments (attachmentImageUrl). */
const ATTACHMENT = /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|webp)$/;

export function thumbnailSrcSet(src: string): string | undefined {
  if (!ATTACHMENT.test(src)) return undefined;
  return THUMBNAIL_WIDTHS.map((width) => `${src}?w=${width} ${width}w`).join(", ");
}

/** A phone never needs a screen frame wider than its own screen's pixels
 *  (a large iPhone is 1290 across), and a desktop capture is often 3000. */
export const PHONE_SCREEN_FRAME_WIDTH = 1280;

export function screenFramePath(threadId: string, messageId: string, phone: boolean): string {
  const path = `/api/threads/${threadId}/messages/${messageId}/image`;
  return phone ? `${path}?w=${PHONE_SCREEN_FRAME_WIDTH}` : path;
}
