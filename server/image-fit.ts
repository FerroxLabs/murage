// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
/**
 * fit: "exact" for generated images. The model renders the nearest size it
 * can; this crops it (centre, cover) and resizes it to the exact pixels asked
 * for, here, in the image's own format. Enlarging is allowed; the card and
 * the result say so.
 *
 * sharp is loaded the way server/image-thumbnail.ts loads it: from beside
 * @huggingface/transformers, once per process. When it cannot load, fit
 * "exact" is refused before the approval card with a plain reason.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MAX_INPUT_PIXELS, rasterFormat } from "./image-thumbnail.ts";

/** Crops and resizes to exactly `width` x `height`, keeping the format. */
export type CropImage = (bytes: Buffer, width: number, height: number) => Promise<Buffer>;

interface SharpImage {
  metadata(): Promise<{ format?: string; width?: number; height?: number; pages?: number }>;
  resize(options: { width: number; height: number; fit: "cover"; position: "centre" }): SharpImage;
  png(): SharpImage; jpeg(options: { quality: number }): SharpImage; webp(options: { quality: number }): SharpImage;
  toBuffer(): Promise<Buffer>;
}
type Sharp = (input: Buffer, options: { limitInputPixels: number }) => SharpImage;
type SharpModule = Sharp & { cache(enabled: boolean): unknown; concurrency(threads: number): unknown };

/** A CropImage over a sharp factory. Exported for its test, which passes a fake. */
export function sharpCrop(sharp: Sharp): CropImage {
  return async (bytes, width, height) => {
    const format = rasterFormat(bytes);
    if (!format) throw new Error("not a PNG, JPEG or WebP image");
    const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    // Fail closed: sharp must agree with the magic number, and one frame only.
    if (meta.format !== format || (meta.pages ?? 1) > 1) throw new Error("the image could not be read for cropping");
    const resized = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).resize({ width, height, fit: "cover", position: "centre" });
    const encoded = format === "png" ? resized.png() : format === "jpeg" ? resized.jpeg({ quality: 92 }) : resized.webp({ quality: 92 });
    return encoded.toBuffer();
  };
}

export async function loadSharpCrop(load: () => unknown): Promise<CropImage | null> {
  try {
    const sharp = load() as SharpModule;
    sharp.cache(false);
    return sharpCrop(sharp);
  } catch (error) {
    console.warn(`[images] exact-size cropping unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

let loaded: Promise<CropImage | null> | undefined;
/** sharp from beside transformers, once per process; null when unavailable. */
export function loadCrop(): Promise<CropImage | null> {
  loaded ??= loadSharpCrop(() => createRequire(fileURLToPath(import.meta.resolve("@huggingface/transformers")))("sharp"));
  return loaded;
}
