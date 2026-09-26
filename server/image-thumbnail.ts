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

/** undefined: no `w`, serve the original. null: a `w` outside the set (400).
 * Canonical spelling only: "0320", "3.2e2", "0x140" and " 320" are refused. */
export function thumbnailWidth(raw: string | null): ThumbnailWidth | null | undefined {
  if (raw === null) return undefined;
  const width = THUMBNAIL_WIDTHS.find(candidate => String(candidate) === raw);
  return width ?? null;
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
type SharpModule = Sharp & { cache(enabled: boolean): unknown; concurrency(threads: number): unknown };

/** A phone panorama is ~60 MP; anything larger is not a photo worth decoding. */
export const MAX_INPUT_PIXELS = 64_000_000;
const QUALITY = 78;
/** The stored MIME types worth shrinking. Never SVG (rasterising it runs a
 *  renderer over whatever the file says), and never GIF (a resize would lose
 *  its animation). */
const RASTER_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

type RasterFormat = "jpeg" | "png" | "webp";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The format the bytes themselves claim, from their magic number, or null.
 * Checked before sharp sees anything: sharp picks its decoder from the bytes,
 * not the MIME type, so a file saved as image/png could otherwise reach the
 * SVG renderer or any other loader libvips carries. */
export function rasterFormat(bytes: Buffer): RasterFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** A Resize over a sharp factory. Exported for its test, which passes a fake. */
export function sharpResize(sharp: Sharp): Resize {
  return async (bytes, width) => {
    const sniffed = rasterFormat(bytes);
    if (!sniffed) return null;
    const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    // Fail closed: sharp must agree with the magic number.
    if (meta.format !== sniffed) return null;
    // A resize would keep only the first frame.
    if ((meta.pages ?? 1) > 1) return null;
    // The header's size, refused before a decode rather than during one.
    if (!meta.width || !meta.height || meta.width * meta.height > MAX_INPUT_PIXELS) return null;
    // EXIF orientations 5–8 turn the picture a quarter: the width the reader
    // sees is the stored height (every phone photo taken upright).
    const shown = (meta.orientation ?? 1) >= 5 ? meta.height : meta.width;
    if (shown <= width) return null;
    const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer();
    return { bytes: out, mime: "image/webp" };
  };
}

/** A Resize over the sharp that `load` returns, or null (with one warning)
 * when it cannot be loaded. sharp's own file cache is off (sources are
 * already in memory, and thumbnails are cached below) and it decodes on one
 * thread, so a burst of first views cannot take every core. */
export async function loadSharpResize(load: () => unknown): Promise<Resize | null> {
  try {
    const sharp = load() as SharpModule;
    sharp.cache(false);
    sharp.concurrency(1);
    return sharpResize(sharp);
  } catch (error) {
    console.warn(`[thumbnails] unavailable, serving originals: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

let loaded: Promise<Resize | null> | undefined;

/** sharp from beside transformers, once per process; null when unavailable. */
export function loadResize(): Promise<Resize | null> {
  // import.meta.resolve returns the real path of Transformers (pnpm's
  // node_modules/.pnpm store in development, the staged copy when packaged),
  // and sharp is only resolvable from there, not from this file's directory.
  // A resolver that kept the symlinked path would miss it and fall back to
  // originals.
  loaded ??= loadSharpResize(() => createRequire(fileURLToPath(import.meta.resolve("@huggingface/transformers")))("sharp"));
  return loaded;
}

/** An answer to a `?w=` view. `image` null means "send the original".
 * `final` says whether that answer holds for good (a thumbnail, or an image
 * that will never get one) or only for now (every resize slot busy, or no
 * resizer loaded): a caller must not let a client cache a for-now original
 * under the thumbnail's URL as if it were final. */
export interface Served {
  image: Thumbnail | null;
  final: boolean;
}
const FOR_GOOD: Served = { image: null, final: true };
const FOR_NOW: Served = { image: null, final: false };

/** Remembered "no thumbnail needed" answers; cleared wholesale when full. */
const MAX_ORIGINAL_MARKS = 10_000;

/** Thumbnails by source key and width, up to `maxBytes`, oldest out first.
 * Sources are immutable (a saved attachment, a settled message's pixels), so
 * an entry never goes stale. At most `maxConcurrent` resizes run at once; a
 * first view past that gets its original now rather than a place in a queue
 * that a scroll through a gallery could make as long as it liked, and gets
 * its thumbnail on a later view. */
export function createThumbnails(options: { resize: () => Promise<Resize | null>; maxBytes: number; maxConcurrent?: number }) {
  const maxConcurrent = options.maxConcurrent ?? Infinity;
  const cache = new Map<string, Thumbnail>();
  const original = new Set<string>();
  // Concurrent first views of one image share one decode.
  const inFlight = new Map<string, Promise<Served>>();
  let held = 0;

  const markOriginal = (id: string) => {
    if (original.size >= MAX_ORIGINAL_MARKS) original.clear();
    original.add(id);
  };

  const make = async (id: string, source: Buffer, width: ThumbnailWidth): Promise<Served> => {
    if (!rasterFormat(source)) {
      markOriginal(id);
      return FOR_GOOD;
    }
    const resize = await options.resize();
    if (!resize) return FOR_NOW;
    let made: Thumbnail | null;
    try {
      made = await resize(source, width);
    } catch (error) {
      // Corrupt, truncated or over the pixel limit: this image gets its
      // original from now on, so the warning is once per image.
      markOriginal(id);
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[thumbnails] ${id} could not be resized, serving the original: ${reason.slice(0, 200)}`);
      return FOR_GOOD;
    }
    if (!made || made.bytes.byteLength >= source.byteLength) {
      markOriginal(id);
      return FOR_GOOD;
    }
    // Larger than the whole cache: serve it, but do not flush everything else for it.
    if (made.bytes.byteLength > options.maxBytes) return { image: made, final: true };
    const previous = cache.get(id);
    if (previous) {
      cache.delete(id);
      held -= previous.bytes.byteLength;
    }
    cache.set(id, made);
    held += made.bytes.byteLength;
    for (const [oldest, entry] of cache) {
      if (held <= options.maxBytes) break;
      cache.delete(oldest);
      held -= entry.bytes.byteLength;
    }
    return { image: made, final: true };
  };

  const serve = async (key: string, source: Buffer, mime: string, width: ThumbnailWidth): Promise<Served> => {
    if (!RASTER_MIMES.has(mime)) return FOR_GOOD;
    const id = `${key}@${width}`;
    if (original.has(id)) return FOR_GOOD;
    const hit = cache.get(id);
    if (hit) {
      cache.delete(id);
      cache.set(id, hit);
      return { image: hit, final: true };
    }
    const pending = inFlight.get(id);
    if (pending) return pending;
    // Not remembered: this image is refused for now, not for good.
    if (inFlight.size >= maxConcurrent) return FOR_NOW;
    const work = make(id, source, width).finally(() => inFlight.delete(id));
    inFlight.set(id, work);
    return work;
  };

  return {
    serve,
    /** The thumbnail, or null for the original; `serve` also says for how long. */
    async variant(key: string, source: Buffer, mime: string, width: ThumbnailWidth): Promise<Thumbnail | null> {
      return (await serve(key, source, mime, width)).image;
    },
    /** Bytes of thumbnails held; for tests and diagnostics. */
    heldBytes(): number {
      return held;
    },
  };
}
