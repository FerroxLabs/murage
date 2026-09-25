import { describe, expect, it, vi } from "vitest";

import { createThumbnails, sharpResize, thumbnailWidth, type Resize } from "./image-thumbnail.ts";

describe("thumbnailWidth", () => {
  it("is absent without w, and one of the fixed widths with it", () => {
    expect(thumbnailWidth(null)).toBeUndefined();
    expect(thumbnailWidth("320")).toBe(320);
    expect(thumbnailWidth("1280")).toBe(1280);
  });

  it("refuses any other width, so a crawler of widths cannot fill the cache", () => {
    for (const raw of ["321", "0", "-320", "320.5", "", "abc", "99999", "0x140", "3.2e2", " 320", "320 ", "+320"]) expect(thumbnailWidth(raw), raw).toBeNull();
  });
});

/** A fake sharp: `meta` is what metadata() reports; resizing yields `out`. */
function fakeSharp(meta: { format?: string; width?: number; height?: number; orientation?: number; pages?: number }, out = Buffer.alloc(10)) {
  const calls: string[] = [];
  const image = {
    metadata: async () => meta,
    rotate() { calls.push("rotate"); return image; },
    resize(options: { width: number }) { calls.push(`resize:${options.width}`); return image; },
    webp(options: { quality: number }) { calls.push(`webp:${options.quality}`); return image; },
    toBuffer: async () => out,
  };
  return { sharp: vi.fn(() => image), calls };
}

describe("sharpResize", () => {
  it("shrinks a wide image to the asked width as WebP, upright", async () => {
    const { sharp, calls } = fakeSharp({ width: 4032, height: 3024 });
    await expect(sharpResize(sharp)(Buffer.alloc(1), 640)).resolves.toEqual({ bytes: Buffer.alloc(10), mime: "image/webp" });
    expect(calls).toEqual(["rotate", "resize:640", "webp:78"]);
  });

  it("measures a rotated phone photo by the width the reader sees", async () => {
    // EXIF 6: stored 4032x3024 landscape, shown 3024 wide; still wider than 640
    const shown = fakeSharp({ width: 4032, height: 3024, orientation: 6 });
    await expect(sharpResize(shown.sharp)(Buffer.alloc(1), 640)).resolves.not.toBeNull();
    // stored 600x2000 with EXIF 8: shown 2000 wide, so it IS shrunk
    const tall = fakeSharp({ width: 600, height: 2000, orientation: 8 });
    await expect(sharpResize(tall.sharp)(Buffer.alloc(1), 640)).resolves.not.toBeNull();
    // stored 2000x600 with EXIF 6: shown 600 wide, already small enough
    const narrow = fakeSharp({ width: 2000, height: 600, orientation: 6 });
    await expect(sharpResize(narrow.sharp)(Buffer.alloc(1), 640)).resolves.toBeNull();
  });

  it("never rasterises an SVG or other non-photo format, whatever its MIME type said", async () => {
    for (const format of ["svg", "gif", "tiff", "heif", "pdf"]) {
      const { sharp, calls } = fakeSharp({ format, width: 4000, height: 3000 });
      await expect(sharpResize(sharp)(Buffer.alloc(1), 640), format).resolves.toBeNull();
      expect(calls, format).toEqual([]);
    }
  });

  it("leaves an image already no wider than asked, and an animation, as they are", async () => {
    await expect(sharpResize(fakeSharp({ width: 640 }).sharp)(Buffer.alloc(1), 640)).resolves.toBeNull();
    await expect(sharpResize(fakeSharp({ width: 4000, pages: 12 }).sharp)(Buffer.alloc(1), 640)).resolves.toBeNull();
  });
});

describe("createThumbnails", () => {
  const source = Buffer.alloc(1000, 1);
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

  it("never resizes a GIF: it would lose its animation", async () => {
    const resize: Resize = vi.fn(async () => small);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    expect(await thumbs.variant("g", source, "image/gif", 320)).toBeNull();
    expect(resize).not.toHaveBeenCalled();
  });

  it("only resizes JPEG, PNG and WebP: never SVG or an unknown type", async () => {
    const resize: Resize = vi.fn(async () => small);
    const thumbs = createThumbnails({ resize: async () => resize, maxBytes: 10_000 });
    for (const mime of ["image/svg+xml", "application/octet-stream", "image/tiff", "text/html"]) {
      expect(await thumbs.variant("x", source, mime, 320), mime).toBeNull();
    }
    expect(resize).not.toHaveBeenCalled();
    expect(await thumbs.variant("x", source, "image/jpeg", 320)).toEqual(small);
  });

  it("serves the original when there is no resizer, when it throws, or when it would not save bytes", async () => {
    expect(await createThumbnails({ resize: async () => null, maxBytes: 10_000 }).variant("a", source, "image/png", 320)).toBeNull();
    const throws: Resize = async () => { throw new Error("corrupt"); };
    expect(await createThumbnails({ resize: async () => throws, maxBytes: 10_000 }).variant("a", source, "image/png", 320)).toBeNull();
    const bigger: Resize = async () => ({ bytes: Buffer.alloc(2000), mime: "image/webp" });
    expect(await createThumbnails({ resize: async () => bigger, maxBytes: 10_000 }).variant("a", source, "image/png", 320)).toBeNull();
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
    await thumbs.variant("b", source, "image/png", 320);
    await thumbs.variant("a", source, "image/png", 320);
    expect(resize).toHaveBeenCalledTimes(4);
  });
});
