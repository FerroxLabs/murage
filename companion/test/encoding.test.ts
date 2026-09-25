// What the browser door compresses, and how.
//
// Pure functions, tested as such. Which responses go through them — and the
// rule that a body is only ever compressed after the door has finished
// rewriting it — is `browser-mobile.test.ts`'s half.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { compressBuffer, compressStream, isCompressible, MIN_COMPRESS_BYTES, negotiateEncoding } from "../src/encoding.ts";

describe("what a browser can decode", () => {
  it("prefers brotli, which every browser this app runs in sends", () => {
    expect(negotiateEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(negotiateEncoding("BR")).toBe("br");
    expect(negotiateEncoding(["gzip", "br"])).toBe("br");
  });

  it("falls to gzip when brotli is absent, refused or ranked lower", () => {
    expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0.5, br;q=0.4")).toBe("gzip");
  });

  it("sends plain bytes to anything that asked for neither", () => {
    for (const header of [undefined, "", "identity", "deflate", "*", "gzip;q=0", "br;q=0, gzip;q=0", "br;q=nonsense"]) {
      expect(negotiateEncoding(header), String(header)).toBeNull();
    }
  });
});

describe("what is worth compressing", () => {
  it("compresses text, code, JSON, SVG and WebAssembly", () => {
    for (const type of [
      "text/html; charset=utf-8",
      "text/javascript; charset=utf-8",
      "text/css; charset=utf-8",
      "application/json",
      "application/manifest+json",
      "image/svg+xml",
      "application/wasm",
      "image/x-icon",
    ]) {
      expect(isCompressible(type), type).toBe(true);
    }
  });

  it("never compresses the event stream, or formats that already are", () => {
    // A compressed SSE stream is buffered by the compressor until a block
    // fills: a frame the phone should see now arrives whenever.
    for (const type of ["text/event-stream", "image/png", "font/woff2", "application/octet-stream", "audio/mpeg", ""]) {
      expect(isCompressible(type), type).toBe(false);
    }
  });

  it("names the floor below which compressing is not worth it", () => {
    expect(MIN_COMPRESS_BYTES).toBe(1024);
  });
});

describe("compressing", () => {
  const body = Buffer.from(JSON.stringify({ bots: Array.from({ length: 200 }, (_, i) => ({ id: `bot_${i}`, name: `Bot ${i}` })) }));

  it("round-trips a whole body in either encoding, and makes it smaller", async () => {
    const br = await compressBuffer(body, "br");
    expect(brotliDecompressSync(br).equals(body)).toBe(true);
    expect(br.byteLength).toBeLessThan(body.byteLength / 4);
    const gz = await compressBuffer(body, "gzip");
    expect(gunzipSync(gz).equals(body)).toBe(true);
  });

  it("round-trips a stream in either encoding", async () => {
    for (const encoding of ["br", "gzip"] as const) {
      const out: Buffer[] = [];
      await pipeline(Readable.from([body.subarray(0, 100), body.subarray(100)]), compressStream(encoding), async function* (source) {
        for await (const chunk of source) out.push(chunk as Buffer);
      });
      const packed = Buffer.concat(out);
      expect((encoding === "br" ? brotliDecompressSync(packed) : gunzipSync(packed)).equals(body), encoding).toBe(true);
    }
  });
});
