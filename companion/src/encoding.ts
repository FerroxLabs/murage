// Compression at the browser door.
//
// The 5.5 MB main script went to phones uncompressed, through this door and
// `tailscale serve` both — ten to twenty seconds of a cold launch on cellular
// (spec §6). Everything here is node's own zlib: brotli has been in it since
// v11, and a dependency for this would be a dependency for nothing.
//
// Negotiated from what the BROWSER sent. The harness is never asked for an
// encoding — `forwardedHeaders` builds its header set from nothing and does
// not copy `accept-encoding` — so every compressed body this door sends is one
// it made itself, after it finished rewriting: scrubbed JSON, the shell with
// its nonce and renewal script in. Never the other way round.
import type { Transform } from "node:stream";
import { brotliCompress, constants, createBrotliCompress, createGzip, gzip, type BrotliOptions } from "node:zlib";

export type Encoding = "br" | "gzip";

/** Below this a compressed body can be larger than the plain one, and is
 * never meaningfully smaller. The build's pre-compressed copies use the same
 * floor (`scripts/compress-dist.mjs`). */
export const MIN_COMPRESS_BYTES = 1024;

/** The encoding to answer this `Accept-Encoding` with, or null for plain.
 *
 * Only the two this door can produce are read, with their q-values: brotli
 * when it is accepted and ranked at least as high as gzip, else gzip, else
 * nothing. `*` is not read as permission — every browser that runs this app
 * names both explicitly, and a client that says only `*` gets plain bytes,
 * which it can certainly decode. */
export function negotiateEncoding(header: string | string[] | undefined): Encoding | null {
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  const weights = new Map<string, number>();
  for (const part of raw.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    let weight = 1;
    for (const param of params) {
      const q = /^\s*q\s*=\s*(.*)$/.exec(param);
      if (q) weight = Number(q[1]);
    }
    weights.set(name.trim(), Number.isFinite(weight) ? weight : 0);
  }
  const br = weights.get("br") ?? 0;
  const gz = weights.get("gzip") ?? 0;
  if (br > 0 && br >= gz) return "br";
  if (gz > 0) return "gzip";
  return null;
}

/** Whether a response of this type is worth compressing.
 *
 * Never the event stream: a compressor holds output until a block fills, so a
 * frame the phone should see now would arrive whenever the next one pushed it
 * out — the stale watchdog's 40 s would start firing on a healthy stream.
 * Never PNG, woff2, audio or opaque bytes: already compressed, or not ours to
 * judge. */
export function isCompressible(contentType: string): boolean {
  const media = contentType.split(";")[0].trim().toLowerCase();
  if (media === "text/event-stream") return false;
  return (
    media.startsWith("text/") ||
    media === "application/json" ||
    media.endsWith("+json") ||
    media === "application/javascript" ||
    media === "image/svg+xml" ||
    media === "application/wasm" ||
    media === "image/x-icon"
  );
}

/** Brotli for a response being made now, not for a build: quality 5 is most
 * of the saving at a small fraction of 11's time. The maximum is for
 * `scripts/compress-dist.mjs`, which runs once. */
const brotliOptions = (sizeHint?: number): BrotliOptions => ({
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 5,
    ...(sizeHint ? { [constants.BROTLI_PARAM_SIZE_HINT]: sizeHint } : {}),
  },
});

/** One whole body, compressed off the event loop (zlib's own threadpool). */
export function compressBuffer(body: Buffer, encoding: Encoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, packed: Buffer) => (error ? reject(error) : resolve(packed));
    if (encoding === "br") brotliCompress(body, brotliOptions(body.byteLength), done);
    else gzip(body, { level: 6 }, done);
  });
}

/** A body that is still arriving, compressed as it passes through. */
export function compressStream(encoding: Encoding): Transform {
  return encoding === "br" ? createBrotliCompress(brotliOptions()) : createGzip({ level: 6 });
}
