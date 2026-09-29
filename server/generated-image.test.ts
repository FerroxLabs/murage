import { describe, expect, it } from "vitest";
import { GENERATED_IMAGE_MAX_BYTES, decodeGeneratedImage } from "./generated-image.ts";
import { IMAGE_MAX_BYTES } from "./attachments.ts";

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("decodeGeneratedImage", () => {
  it("accepts Codex raw base64 and sniffs the actual raster type", () => {
    const image = decodeGeneratedImage(ONE_PIXEL_PNG);
    expect(image.mime).toBe("image/png");
    expect(image.bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("accepts a raster data URL without trusting its claimed type", () => {
    expect(decodeGeneratedImage(`data:image/jpeg;base64,${ONE_PIXEL_PNG}`).mime).toBe("image/png");
  });

  it("rejects non-image and malformed provider output", () => {
    expect(() => decodeGeneratedImage(Buffer.from("not an image").toString("base64"))).toThrow(/supported raster/);
    expect(() => decodeGeneratedImage("%%%" )).toThrow(/invalid/);
  });

  it("keeps uploads at the image cap and lets a provider render use the larger generated-image cap", () => {
    const big = Buffer.concat([Buffer.from(ONE_PIXEL_PNG, "base64"), Buffer.alloc(IMAGE_MAX_BYTES)]).toString("base64");
    expect(() => decodeGeneratedImage(big)).toThrow();
    expect(decodeGeneratedImage(big, GENERATED_IMAGE_MAX_BYTES).bytes.length).toBeGreaterThan(IMAGE_MAX_BYTES);
    expect(GENERATED_IMAGE_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});
