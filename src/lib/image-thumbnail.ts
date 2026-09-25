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

/** The `N` of a `?w=N` candidate URL, or undefined for any other URL. */
export function requestedWidth(currentSrc: string): number | undefined {
  const requested = Number(/[?&]w=(\d+)/.exec(currentSrc)?.[1]);
  return Number.isFinite(requested) && requested > 0 ? requested : undefined;
}

/** True when a `?w=N` request came back narrower than N: the server (E12)
 *  never upscales, so an image already at or below N sends the whole
 *  original. Left un-dropped, the browser would treat those bytes as the
 *  "Nw" candidate and draw them shrunken — small on a dense phone screen.
 *
 *  `pixelWidth` must be the file's TRUE pixel width. The srcset `<img>`'s own
 *  `naturalWidth` is not: with `w` descriptors the browser divides it by the
 *  candidate's density, so a real 1280-pixel thumbnail in a 259 px slot
 *  reports 259, and every image looked like an original (phone verification,
 *  08c-srcset-probe). `truePixelWidth` measures it. */
export function servedOriginal(currentSrc: string, pixelWidth: number): boolean {
  const requested = requestedWidth(currentSrc);
  return pixelWidth > 0 && requested !== undefined && pixelWidth < requested;
}

/** The true pixel width of an image URL: a plain `Image` with no srcset, so
 *  no density correction. Same URL as the one just drawn, so the bytes come
 *  from the cache, and an image load is governed by img-src, not the door's
 *  connect-src. Resolves 0 when it cannot tell. */
export function truePixelWidth(url: string, make: () => HTMLImageElement = () => new Image()): Promise<number> {
  return new Promise((resolve) => {
    const probe = make();
    probe.onload = () => resolve(probe.naturalWidth);
    probe.onerror = () => resolve(0);
    probe.src = url;
  });
}

/** Sources already found to have served the original for their widest `?w=`
 *  candidate. Module-level and unbounded by design (chat image counts stay
 *  small): remembered so a row that scrolls out and back in, or a fresh
 *  mount of the same source, does not flash small-then-full-size again. */
const knownOriginal = new Set<string>();

export function rememberServedOriginal(src: string): void {
  knownOriginal.add(src);
}

export function wasServedOriginal(src: string): boolean {
  return knownOriginal.has(src);
}
