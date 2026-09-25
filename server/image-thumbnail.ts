// `?w=` thumbnails for chat images (spec §6).
//
// A phone scrolling an image-heavy chat downloaded every attachment at full
// size (a 4032 px photo is 3–5 MB) to draw it a few hundred pixels wide. The
// image routes now take `?w=` from a fixed set and answer a WebP no wider than
// that; the lightbox and Download still fetch the original.
//
// The resizer is sharp, loaded on first use from beside
// @huggingface/transformers: it is that package's dependency, and the
// packaged memory runtime already ships it there (scripts/
// stage-memory-runtime.mjs), so thumbnails add no dependency and no bytes.
// When it cannot load (a platform whose binary was not staged, a runtime
// without it) every request gets the original, which is what it got before
// this existed. A thumbnail never turns into a 500.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { THUMBNAIL_WIDTHS, type ThumbnailWidth } from "../shared/image-thumbnail.ts";

export { THUMBNAIL_WIDTHS };

/** undefined: no `w`, serve the original. null: a `w` outside the set (400). */
export function thumbnailWidth(raw: string | null): ThumbnailWidth | null | undefined {
  if (raw === null) return undefined;
  // Digits only: Number() would also read "0x140", "3.2e2" and " 320".
  if (!/^\d{1,5}$/.test(raw)) return null;
  const width = Number(raw);
  return (THUMBNAIL_WIDTHS as readonly number[]).includes(width) ? (width as ThumbnailWidth) : null;
}

export interface Thumbnail {
  bytes: Buffer;
  mime: string;
}
/** Null when the image is already no wider than `width`, or is animated. */
export type Resize = (bytes: Buffer, width: number) => Promise<Thumbnail | null>;

// The slice of sharp's API used here; sharp is not a direct dependency, so
// its own types are not on the compiler's path.
interface SharpMetadata { format?: string; width?: number; height?: number; orientation?: number; pages?: number }
interface SharpImage {
  metadata(): Promise<SharpMetadata>;
  rotate(): SharpImage;
  resize(options: { width: number; withoutEnlargement: boolean }): SharpImage;
  webp(options: { quality: number }): SharpImage;
  toBuffer(): Promise<Buffer>;
}
type Sharp = (input: Buffer, options: { limitInputPixels: number }) => SharpImage;

/** A phone panorama is ~60 MP; anything larger is not a photo worth decoding. */
const MAX_INPUT_PIXELS = 64_000_000;
const QUALITY = 78;
/** Formats worth shrinking, by sharp's name and by the stored MIME type. Never
 *  SVG (rasterising it runs a renderer over whatever the file says), and never
 *  GIF (a resize would lose its animation). */
const RASTER_FORMATS = new Set(["jpeg", "png", "webp"]);
const RASTER_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** A Resize over a sharp factory. Exported for its test, which passes a fake. */
export function sharpResize(sharp: Sharp): Resize {
  return async (bytes, width) => {
    const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    // sharp reads the format from the bytes, not the MIME type: a file saved
    // as image/png can still be an SVG.
    if (meta.format !== undefined && !RASTER_FORMATS.has(meta.format)) return null;
    // A resize would keep only the first frame.
    if ((meta.pages ?? 1) > 1) return null;
    // EXIF orientations 5–8 turn the picture a quarter: the width the reader
    // sees is the stored height (every phone photo taken upright).
    const shown = (meta.orientation ?? 1) >= 5 ? meta.height : meta.width;
    if (!shown || shown <= width) return null;
    const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer();
    return { bytes: out, mime: "image/webp" };
  };
}

let loaded: Promise<Resize | null> | undefined;

/** sharp from beside transformers, once per process; null when unavailable. */
export function loadResize(): Promise<Resize | null> {
  loaded ??= (async () => {
    try {
      const beside = createRequire(fileURLToPath(import.meta.resolve("@huggingface/transformers")));
      return sharpResize(beside("sharp") as Sharp);
    } catch (error) {
      console.warn(`[thumbnails] unavailable, serving originals: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  })();
  return loaded;
}

/** Remembered "no thumbnail needed" answers; cleared wholesale when full. */
const MAX_ORIGINAL_MARKS = 10_000;

/** Thumbnails by source key and width, up to `maxBytes`, oldest out first.
 * Sources are immutable (a saved attachment, a settled message's pixels), so
 * an entry never goes stale. */
export function createThumbnails(options: { resize: () => Promise<Resize | null>; maxBytes: number }) {
  const cache = new Map<string, Thumbnail>();
  const original = new Set<string>();
  let held = 0;
  return {
    async variant(key: string, source: Buffer, mime: string, width: ThumbnailWidth): Promise<Thumbnail | null> {
      if (!RASTER_MIMES.has(mime)) return null;
      const id = `${key}@${width}`;
      if (original.has(id)) return null;
      const hit = cache.get(id);
      if (hit) {
        cache.delete(id);
        cache.set(id, hit);
        return hit;
      }
      const resize = await options.resize();
      if (!resize) return null;
      let made: Thumbnail | null;
      try {
        made = await resize(source, width);
      } catch {
        return null;
      }
      if (!made || made.bytes.byteLength >= source.byteLength) {
        if (original.size >= MAX_ORIGINAL_MARKS) original.clear();
        original.add(id);
        return null;
      }
      cache.set(id, made);
      held += made.bytes.byteLength;
      for (const [oldest, entry] of cache) {
        if (held <= options.maxBytes) break;
        cache.delete(oldest);
        held -= entry.bytes.byteLength;
      }
      return made;
    },
  };
}
