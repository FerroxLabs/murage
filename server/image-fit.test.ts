// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it, vi } from "vitest";
import { loadCrop, loadSharpCrop, sharpCrop } from "./image-fit.ts";
import { sniffMedia } from "./media-assets.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("image fit exact", () => {
  it("crops centre-cover to the exact pixels and keeps the format", async () => {
    const calls: unknown[] = [];
    const image = { metadata: async () => ({ format: "png", width: 1, height: 1 }), resize: (options: unknown) => { calls.push(options); return image; },
      png: () => { calls.push("png"); return image; }, jpeg: () => image, webp: () => image, toBuffer: async () => Buffer.from("out") };
    const crop = sharpCrop(() => image);
    await expect(crop(PNG, 1080, 1350)).resolves.toEqual(Buffer.from("out"));
    expect(calls).toEqual([{ width: 1080, height: 1350, fit: "cover", position: "centre" }, "png"]);
  });
  it("refuses bytes that are not a raster image or that sharp reads differently", async () => {
    const image = { metadata: async () => ({ format: "svg" }), resize: () => image, png: () => image, jpeg: () => image, webp: () => image, toBuffer: async () => Buffer.alloc(0) };
    await expect(sharpCrop(() => image)(Buffer.from("<svg/>"), 10, 10)).rejects.toThrow();
    await expect(sharpCrop(() => image)(PNG, 10, 10)).rejects.toThrow();
  });
  it("is null, with one warning, when sharp cannot load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(loadSharpCrop(() => { throw new Error("no sharp"); })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce(); warn.mockRestore();
  });
  it("renders exactly 1080x1350 with the real sharp when it is installed", async () => {
    const crop = await loadCrop();
    if (!crop) return;
    const out = await crop(PNG, 1080, 1350);
    expect(sniffMedia(out.subarray(0, 64), out.length)).toMatchObject({ kind: "image", mime: "image/png", width: 1080, height: 1350 });
  });
});
