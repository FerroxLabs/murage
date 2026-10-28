// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The strict reader for a phone's share body (S35, design 5.4). Not a general multipart parser: it accepts exactly one shape,
// `multipart/form-data; boundary=<1 to 70 chars>`, a `manifest` part (application/json, at most 64 KB) and then `item-1` .. `item-n`
// in order, each with a filename and a plain media type. Everything else fails closed with a typed error: no preamble, no nested
// multipart, no unknown or repeated header, no bare CR or LF in a header, no path characters in a filename, no bytes after the
// final boundary, no body that ends without one. Item data streams (never held whole) and must be consumed before the next part.
// No TypeScript-only runtime syntax: the server runs under node --experimental-strip-types.

export type ShareBodyCode = "invalid" | "too_large";

export class ShareBodyError extends Error {
  readonly code: ShareBodyCode;
  constructor(code: ShareBodyCode, message: string) { super(message); this.name = "ShareBodyError"; this.code = code; }
}

export const MANIFEST_MAX_BYTES = 64 * 1024;
export const HEADER_LINE_MAX_BYTES = 1024;
const HEADER_LINES_MAX = 8;
const BOUNDARY_CHARS = /^[0-9A-Za-z'()+_,\-./:=?]{1,70}$/;
const CRLF = Buffer.from("\r\n");

const invalid = (why: string) => new ShareBodyError("invalid", why);

export type SharePart =
  | { name: "manifest"; json: unknown }
  | { name: `item-${number}`; filename: string; mime: string; data: AsyncIterable<Buffer> };

/** The boundary of an exact `multipart/form-data; boundary=...` header value, or an `invalid` error. */
function boundaryOf(contentType: string): string {
  if (typeof contentType !== "string" || contentType.length > 200) throw invalid("content type");
  const m = /^multipart\/form-data; boundary=(?:"([^"\\]*)"|([^";\\ ]*))$/i.exec(contentType);
  const boundary = m ? (m[1] ?? m[2] ?? "") : "";
  if (!BOUNDARY_CHARS.test(boundary)) throw invalid("boundary");
  return boundary;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
/** A header line as text: UTF-8, no control characters. */
function headerText(line: Buffer): string {
  let text: string;
  try { text = decoder.decode(line); } catch { throw invalid("header encoding"); }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw invalid("header characters");
  return text;
}

function checkFilename(name: string): string {
  if (name.length < 1 || name.length > 255) throw invalid("filename length");
  if (/[/\\\u0000-\u001f\u007f-\u009f]/.test(name) || name === "." || name === "..") throw invalid("filename characters");
  return name;
}

/** A `text/*` media type may carry one `charset` parameter (any case, optional quotes); every other parameter is refused. */
const TEXT_CHARSET = /^(text\/[^;\s]+);\s?charset=(?:"[A-Za-z0-9._:-]{1,40}"|[A-Za-z0-9._:-]{1,40})$/i;

function parseMime(value: string): string {
  const withCharset = TEXT_CHARSET.exec(value);
  const mime = (withCharset ? withCharset[1]! : value).toLowerCase();
  if (mime.startsWith("multipart/")) throw invalid("nested multipart");
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mime)) throw invalid("media type");
  return mime;
}

interface PartHead { name: string; filename: string | undefined; mime: string }

class Reader {
  private readonly source: AsyncIterator<Buffer>;
  private readonly maxBytes: number;
  private buf: Buffer = Buffer.alloc(0);
  private total = 0;
  private ended = false;
  constructor(source: AsyncIterator<Buffer>, maxBytes: number) { this.source = source; this.maxBytes = maxBytes; }

  /** Pulls one more chunk into the buffer. False at the end of the body. The byte cap is checked before the chunk is kept. */
  async fill(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.source.next();
    if (next.done) { this.ended = true; return false; }
    const value: unknown = next.value;
    if (!(value instanceof Uint8Array)) throw invalid("body chunk");
    this.total += value.length;
    if (this.total > this.maxBytes) throw new ShareBodyError("too_large", "body over the cap");
    this.buf = this.buf.length === 0 ? Buffer.from(value) : Buffer.concat([this.buf, value]);
    return true;
  }

  async need(n: number, why: string): Promise<void> {
    while (this.buf.length < n) if (!(await this.fill())) throw invalid(why);
  }

  take(n: number): Buffer { const out = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return out; }

  async line(): Promise<Buffer> {
    for (let from = 0; ; ) {
      const at = this.buf.indexOf(CRLF, from);
      if (at >= 0) {
        if (at > HEADER_LINE_MAX_BYTES) throw invalid("header line too long");
        const out = Buffer.from(this.buf.subarray(0, at));
        this.buf = this.buf.subarray(at + 2);
        return out;
      }
      if (this.buf.length > HEADER_LINE_MAX_BYTES + 1) throw invalid("header line too long");
      from = Math.max(0, this.buf.length - 1);
      if (!(await this.fill())) throw invalid("body ended inside a part header");
    }
  }

  /** Everything after the final boundary: nothing, or one CRLF. */
  async epilogue(): Promise<void> {
    while (await this.fill()) { /* counted against the cap */ }
    if (this.buf.length !== 0 && !this.buf.equals(CRLF)) throw invalid("bytes after the final boundary");
  }

  /** The part's body up to its closing delimiter. Returns after consuming the delimiter and its two following bytes. */
  async *body(delim: Buffer): AsyncGenerator<Buffer, "more" | "final"> {
    const hold = delim.length - 1;
    for (;;) {
      const at = this.buf.indexOf(delim);
      if (at >= 0) {
        if (at > 0) yield Buffer.from(this.take(at));
        this.take(delim.length);
        await this.need(2, "body ended after a boundary");
        const tail = this.take(2).toString("latin1");
        if (tail === "\r\n") return "more";
        if (tail === "--") return "final";
        throw invalid("bytes after a boundary");
      }
      if (this.buf.length > hold) yield Buffer.from(this.take(this.buf.length - hold));
      if (!(await this.fill())) throw invalid("body ended without a final boundary");
    }
  }

  async head(): Promise<PartHead> {
    let disposition: string | undefined;
    let type: string | undefined;
    for (let lines = 0; ; lines++) {
      if (lines > HEADER_LINES_MAX) throw invalid("too many header lines");
      const raw = await this.line();
      if (raw.length === 0) break;
      const text = headerText(raw);
      const m = /^([A-Za-z][A-Za-z-]*): ?(.*)$/.exec(text);
      if (!m) throw invalid("header line");
      const key = m[1]!.toLowerCase();
      if (key === "content-disposition") { if (disposition !== undefined) throw invalid("repeated header"); disposition = m[2]!; }
      else if (key === "content-type") { if (type !== undefined) throw invalid("repeated header"); type = m[2]!; }
      else throw invalid("header not allowed");
    }
    if (disposition === undefined) throw invalid("missing disposition");
    const d = /^form-data; name="([^"\\]*)"(?:; filename="([^"\\]*)")?$/i.exec(disposition);
    if (!d) throw invalid("disposition");
    if (type === undefined) throw invalid("missing media type");
    return { name: d[1]!, filename: d[2] === undefined ? undefined : checkFilename(d[2]), mime: parseMime(type) };
  }
}

/**
 * Reads a share body. Yields the manifest first, then each item in order; an item's `data` must be consumed to its end before the
 * next part is requested (otherwise the next request throws `invalid`). Throws ShareBodyError and releases the source on any fault.
 */
export async function* readShareParts(
  body: AsyncIterable<Buffer>,
  contentType: string,
  o: { maxBytes: number; maxParts: number },
): AsyncGenerator<SharePart> {
  const boundary = boundaryOf(contentType);
  const source = body[Symbol.asyncIterator]();
  const reader = new Reader(source, o.maxBytes);
  const delim = Buffer.from(`\r\n--${boundary}`, "latin1");
  try {
    const opening = Buffer.from(`--${boundary}\r\n`, "latin1");
    await reader.need(opening.length, "body does not open with the boundary");
    if (!reader.take(opening.length).equals(opening)) throw invalid("body does not open with the boundary");

    let parts = 0;
    let expected = 0; // 0 is the manifest; n is item-n
    for (;;) {
      if (++parts > o.maxParts) throw invalid("too many parts");
      const head = await reader.head();
      if (expected === 0) {
        if (head.name !== "manifest" || head.filename !== undefined || head.mime !== "application/json") throw invalid("the first part must be the manifest");
        const chunks: Buffer[] = [];
        let size = 0;
        const gen = reader.body(delim);
        let step = await gen.next();
        while (!step.done) {
          size += step.value.length;
          if (size > MANIFEST_MAX_BYTES) throw new ShareBodyError("too_large", "manifest over 64 KB");
          chunks.push(step.value);
          step = await gen.next();
        }
        let json: unknown;
        try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw invalid("manifest is not JSON"); }
        yield { name: "manifest", json };
        expected = 1;
        if (step.value === "final") break;
        continue;
      }
      if (head.name !== `item-${expected}` || head.filename === undefined) throw invalid("part out of order, repeated or without a filename");
      const gen = reader.body(delim);
      let outcome: "more" | "final" | undefined;
      let started = false;
      let failure: unknown;
      const data: AsyncIterable<Buffer> = {
        [Symbol.asyncIterator]() {
          if (started) throw invalid("item data read twice");
          started = true;
          return {
            async next(): Promise<IteratorResult<Buffer>> {
              try {
                const step = await gen.next();
                if (step.done) { outcome = step.value; return { done: true, value: undefined }; }
                return { done: false, value: step.value };
              } catch (e) { failure = e; throw e; }
            },
          };
        },
      };
      yield { name: `item-${expected}` as `item-${number}`, filename: head.filename, mime: head.mime, data };
      if (failure !== undefined) throw failure;
      if (outcome === undefined) throw invalid("an item was not consumed");
      expected++;
      if (outcome === "final") break;
    }
    await reader.epilogue();
  } finally {
    try { await source.return?.(); } catch { /* the source is already done */ }
  }
}
