import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_INPUT_PIXELS,
  createThumbnails,
  loadResize,
  loadSharpResize,
  rasterFormat,
  sharpResize,
  thumbnailWidth,
  type Resize,
} from "./image-thumbnail.ts";

describe("thumbnailWidth", () => {
  it("is absent without w, and one of the fixed widths with it", () => {
    expect(thumbnailWidth(null)).toBeUndefined();
    expect(thumbnailWidth("320")).toBe(320);
    expect(thumbnailWidth("1280")).toBe(1280);
  });

  it("refuses any other width, so a crawler of widths cannot fill the cache", () => {
    for (const raw of ["321", "0", "-320", "320.5", "", "abc", "99999", "0320", "0x140", "3.2e2", " 320", "320 ", "+320"]) {
      expect(thumbnailWidth(raw), raw).toBeNull();
    }
  });
});

/** Just enough of each format for the magic-number check. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(996, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(992, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(988, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000"/>'.padEnd(1000, " "));

describe("rasterFormat", () => {
  it("names JPEG, PNG and WebP from their bytes, and nothing else", () => {
    expect(rasterFormat(JPEG)).toBe("jpeg");
    expect(rasterFormat(PNG)).toBe("png");
    expect(rasterFormat(WEBP)).toBe("webp");
    for (const bytes of [SVG, Buffer.from("GIF89a"), Buffer.from("RIFF0000WAVE"), Buffer.alloc(0), Buffer.from([0xff, 0xd8])]) {
      expect(rasterFormat(bytes)).toBeNull();
    }
  });
});

type Meta = { format?: string; width?: number; height?: number; orientation?: number; pages?: number };

/** A fake sharp: `meta` is what metadata() reports; resizing yields `out`.
 * Like sharp, it refuses to decode more pixels than limitInputPixels allows. */
function fakeSharp(meta: Meta, out = Buffer.alloc(10)) {
  const calls: string[] = [];
  const limits: number[] = [];
  const sharp = vi.fn((_input: Buffer, options: { limitInputPixels: number }) => {
    limits.push(options.limitInputPixels);
    const image = {
      metadata: async () => meta,
      rotate() { calls.push("rotate"); return image; },
      resize(resizeOptions: { width: number }) { calls.push(`resize:${resizeOptions.width}`); return image; },
      webp(webpOptions: { quality: number }) { calls.push(`webp:${webpOptions.quality}`); return image; },
      toBuffer: async () => {
        if ((meta.width ?? 0) * (meta.height ?? 0) > options.limitInputPixels) throw new Error("Input image exceeds pixel limit");
        return out;
      },
    };
    return image;
  });
  return { sharp, calls, limits };
}

describe("sharpResize", () => {
  it("shrinks a wide image to the asked width as WebP, upright, within the pixel limit", async () => {
    const { sharp, calls, limits } = fakeSharp({ format: "jpeg", width: 4032, height: 3024 });
    await expect(sharpResize(sharp)(JPEG, 640)).resolves.toEqual({ bytes: Buffer.alloc(10), mime: "image/webp" });
    expect(calls).toEqual(["rotate", "resize:640", "webp:78"]);
    expect(limits).toEqual([MAX_INPUT_PIXELS, MAX_INPUT_PIXELS]);
  });

  it("measures a rotated phone photo by the width the reader sees", async () => {
    // EXIF 6: stored 4032x3024 landscape, shown 3024 wide; still wider than 640
    const shown = fakeSharp({ format: "jpeg", width: 4032, height: 3024, orientation: 6 });
    await expect(sharpResize(shown.sharp)(JPEG, 640)).resolves.not.toBeNull();
    // stored 600x2000 with EXIF 8: shown 2000 wide, so it IS shrunk
    const tall = fakeSharp({ format: "jpeg", width: 600, height: 2000, orientation: 8 });
    await expect(sharpResize(tall.sharp)(JPEG, 640)).resolves.not.toBeNull();
    // stored 2000x600 with EXIF 6: shown 600 wide, already small enough
    const narrow = fakeSharp({ format: "jpeg", width: 2000, height: 600, orientation: 6 });
    await expect(sharpResize(narrow.sharp)(JPEG, 640)).resolves.toBeNull();
  });

  it("leaves an image already no wider than asked, and an animation, as they are", async () => {
    await expect(sharpResize(fakeSharp({ format: "png", width: 640, height: 480 }).sharp)(PNG, 640)).resolves.toBeNull();
    await expect(sharpResize(fakeSharp({ format: "webp", width: 4000, height: 3000, pages: 12 }).sharp)(WEBP, 640)).resolves.toBeNull();
  });

  it("refuses an image over the pixel limit from its header, before decoding it", async () => {
    const bomb = fakeSharp({ format: "png", width: 10_000, height: 10_000 });
    await expect(sharpResize(bomb.sharp)(PNG, 640)).resolves.toBeNull();
    expect(bomb.calls).toEqual([]);
  });

  it("never hands sharp bytes that are not JPEG, PNG or WebP, whatever their MIME type said", async () => {
    const { sharp } = fakeSharp({ format: "svg", width: 4000, height: 4000 });
    await expect(sharpResize(sharp)(SVG, 640)).resolves.toBeNull();
    expect(sharp).not.toHaveBeenCalled();
  });

  it("fails closed when sharp's reading of the bytes disagrees or is missing", async () => {
    for (const format of ["svg", "gif", "tiff", "png", undefined]) {
      const { sharp, calls } = fakeSharp({ format, width: 4000, height: 3000 });
      await expect(sharpResize(sharp)(JPEG, 640), String(format)).resolves.toBeNull();
      expect(calls, String(format)).toEqual([]);
    }
  });
});

describe("loadSharpResize", () => {
  it("serves originals when sharp cannot be loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resize = await loadSharpResize(() => { throw new Error("Cannot find module 'sharp'"); });
    expect(resize).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    expect(await thumbs.variant("a", PNG, "image/png", 320)).toBeNull();
  });

  it("turns off sharp's own cache and holds it to one decode thread", async () => {
    const { sharp } = fakeSharp({ format: "png", width: 2000, height: 1000 });
    const module = Object.assign(sharp, { cache: vi.fn(), concurrency: vi.fn() });
    expect(await loadSharpResize(() => module)).not.toBeNull();
    expect(module.cache).toHaveBeenCalledWith(false);
    expect(module.concurrency).toHaveBeenCalledWith(1);
  });
});

describe("createThumbnails", () => {
  const source = PNG;
  const small = { bytes: Buffer.alloc(100, 2), mime: "image/webp" };

  it("resizes once per key and width, then serves from memory", async () => {
    const resize: Resize = vi.fn(async () => small);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    expect(await thumbs.variant("a", source, "image/png", 320)).toEqual(small);
    expect(await thumbs.variant("a", source, "image/png", 320)).toEqual(small);
    expect(resize).toHaveBeenCalledTimes(1);
    await thumbs.variant("a", source, "image/png", 640);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("shares one resize between concurrent first views, and counts its bytes once", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const resize: Resize = vi.fn(async () => { await gate; return small; });
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 250 });
    const first = Promise.all([1, 2, 3].map(() => thumbs.variant("a", source, "image/png", 320)));
    finish();
    expect(await first).toEqual([small, small, small]);
    expect(thumbs.heldBytes()).toBe(100);
    await thumbs.variant("b", source, "image/png", 320);
    await thumbs.variant("b", source, "image/png", 320);
    await thumbs.variant("a", source, "image/png", 320);
    expect(resize).toHaveBeenCalledTimes(2);
    expect(thumbs.heldBytes()).toBe(200);
  });

  it("serves the original rather than queue a resize past its concurrency, and remembers nothing for it", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const resize: Resize = vi.fn(async () => { await gate; return small; });
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000, maxConcurrent: 2 });
    const busy = [thumbs.variant("a", source, "image/png", 320), thumbs.variant("b", source, "image/png", 320)];
    // a third image while two resize: its original, at once
    expect(await thumbs.variant("c", source, "image/png", 320)).toBeNull();
    // a view of an image already resizing shares that work instead
    const shared = thumbs.variant("a", source, "image/png", 320);
    finish();
    expect(await Promise.all([...busy, shared])).toEqual([small, small, small]);
    expect(resize).toHaveBeenCalledTimes(2);
    // once the burst is over, the refused image gets its thumbnail
    expect(await thumbs.variant("c", source, "image/png", 320)).toEqual(small);
    expect(resize).toHaveBeenCalledTimes(3);
  });

  it("says a busy or resizer-less original is for now, and every other answer is final", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const resize: Resize = vi.fn(async (_bytes, width) => { await gate; return width === 1280 ? null : small; });
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000, maxConcurrent: 1 });
    const busy = thumbs.serve("a", source, "image/png", 320);
    expect(await thumbs.serve("b", source, "image/png", 320)).toEqual({ image: null, final: false });
    finish();
    expect(await busy).toEqual({ image: small, final: true });
    expect(await thumbs.serve("a", source, "image/png", 320)).toEqual({ image: small, final: true });
    // already no wider than asked, and a type never resized: the original for good
    expect(await thumbs.serve("a", source, "image/png", 1280)).toEqual({ image: null, final: true });
    expect(await thumbs.serve("g", source, "image/gif", 320)).toEqual({ image: null, final: true });
    const none = createThumbnails({ resize: async () => null, maxBytes: 10_000 });
    expect(await none.serve("a", source, "image/png", 320)).toEqual({ image: null, final: false });
  });

  it("frees a resize slot when the resize fails, so the next image still gets one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resize: Resize = vi.fn(async (bytes) => { if (bytes === JPEG) throw new Error("corrupt"); return small; });
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000, maxConcurrent: 1 });
    expect(await thumbs.serve("bad", JPEG, "image/jpeg", 320)).toEqual({ image: null, final: true });
    expect(await thumbs.serve("good", source, "image/png", 320)).toEqual({ image: small, final: true });
    expect(resize).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("never resizes a GIF, an SVG or an unknown type", async () => {
    const resize: Resize = vi.fn(async () => small);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    for (const mime of ["image/gif", "image/svg+xml", "application/octet-stream", "image/tiff", "text/html"]) {
      expect(await thumbs.variant("x", source, mime, 320), mime).toBeNull();
    }
    expect(resize).not.toHaveBeenCalled();
    expect(await thumbs.variant("x", JPEG, "image/jpeg", 320)).toEqual(small);
  });

  it("never lets SVG bytes labelled image/png reach the resizer", async () => {
    const resize: Resize = vi.fn(async () => small);
    const load = vi.fn(async () => resize);
    const thumbs = createThumbnails({ resize: load, maxBytes: 10_000 });
    expect(await thumbs.variant("s", SVG, "image/png", 320)).toBeNull();
    expect(await thumbs.variant("s", SVG, "image/png", 320)).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });

  it("serves the original when there is no resizer, when it throws, or when it would not save bytes", async () => {
    expect(await createThumbnails({ resize: async () => null, maxBytes: 10_000 }).variant("a", source, "image/png", 320)).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const throws: Resize = async () => { throw new Error("corrupt"); };
    expect(await createThumbnails({ resize: async () => throws, maxBytes: 10_000 }).variant("a", source, "image/png", 320)).toBeNull();
    warn.mockRestore();
    const bigger: Resize = async () => ({ bytes: Buffer.alloc(2000), mime: "image/webp" });
    expect(await createThumbnails({ resize: async () => bigger, maxBytes: 10_000 }).variant("a", source, "image/png", 320)).toBeNull();
  });

  it("gives up on an image that failed to resize, warning once and without its bytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resize: Resize = vi.fn(async () => { throw new Error("Input image exceeds pixel limit"); });
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    for (let i = 0; i < 3; i++) expect(await thumbs.variant("bomb", source, "image/png", 320)).toBeNull();
    expect(resize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("bomb@320");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(source.toString("latin1", 0, 8));
    warn.mockRestore();
  });

  it("remembers an image that needs no thumbnail, so it is not decoded again", async () => {
    const resize: Resize = vi.fn(async () => null);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    await thumbs.variant("tiny", source, "image/png", 320);
    await thumbs.variant("tiny", source, "image/png", 320);
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("drops the oldest thumbnails once the cache holds more than its bytes", async () => {
    const resize: Resize = vi.fn(async () => small);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 250 });
    await thumbs.variant("a", source, "image/png", 320);
    await thumbs.variant("b", source, "image/png", 320);
    await thumbs.variant("c", source, "image/png", 320); // 300 bytes: "a" goes
    expect(thumbs.heldBytes()).toBe(200);
    await thumbs.variant("b", source, "image/png", 320);
    await thumbs.variant("a", source, "image/png", 320);
    expect(resize).toHaveBeenCalledTimes(4);
  });

  it("serves but does not keep a thumbnail larger than the whole cache", async () => {
    const big = { bytes: Buffer.alloc(300, 2), mime: "image/webp" };
    const resize: Resize = vi.fn(async (_bytes, width) => (width === 1280 ? big : small));
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 250 });
    await thumbs.variant("a", source, "image/png", 320);
    expect(await thumbs.variant("a", source, "image/png", 1280)).toEqual(big);
    expect(thumbs.heldBytes()).toBe(100);
    await thumbs.variant("a", source, "image/png", 320);
    expect(resize).toHaveBeenCalledTimes(2);
  });
});

/** The sharp the server would load, when this checkout has it. */
function realSharp(): ((...args: unknown[]) => { png(): { toBuffer(): Promise<Buffer> }; metadata(): Promise<{ width?: number; format?: string }> }) | null {
  try {
    return createRequire(fileURLToPath(import.meta.resolve("@huggingface/transformers")))("sharp");
  } catch {
    return null;
  }
}
const sharp = realSharp();

describe.skipIf(!sharp)("with the bundled sharp", () => {
  it("round-trips a small PNG to a narrower WebP", async () => {
    const resize = await loadResize();
    expect(resize).not.toBeNull();
    const png = await sharp!({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
    const thumb = await resize!(png, 320);
    expect(thumb?.mime).toBe("image/webp");
    const meta = await sharp!(thumb!.bytes).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 320 });
  });
});
