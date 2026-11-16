// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { FrozenRequest, FrozenSendCopy } from './held-request.ts';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Parse only digest-verified held bytes. The file range is never text. */
export function heldRequestBody(frozen: FrozenRequest, copy: FrozenSendCopy): unknown {
  const refuse = (): never => { throw new Error("HighLevel identity request binding refused"); };
  const bytes = copy.body ?? new Uint8Array();
  if (hash(bytes) !== frozen.bodySha256) return refuse();
  let body: unknown = {};
  if (frozen.bodyKind === "json") {
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); }
  } else if (frozen.bodyKind === "multipart") {
    // Extract only declared textual parts from verified wire bytes. Never decode
    // the file range as fields, and verify the upload independently.
    const boundary = frozen.contentType?.match(/^multipart\/form-data; boundary=([A-Za-z0-9_-]+)$/u)?.[1];
    const offset = copy.fileOffset, length = copy.fileLength;
    if (!boundary || !frozen.upload || offset === null || length === null || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0 || offset + length > bytes.length || length !== frozen.upload.size || hash(bytes.subarray(offset, offset + length)) !== frozen.upload.sha256) return refuse();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    const fields: Record<string, string> = Object.create(null);
    for (const part of text.split(`--${boundary}\r\n`).slice(1)) {
      const match = part.match(/^Content-Disposition: form-data; name="([A-Za-z][A-Za-z0-9_]*)"\r\n\r\n([^]*?)\r\n$/u);
      if (match) { if (Object.hasOwn(fields, match[1])) return refuse(); fields[match[1]] = match[2]; }
    }
    body = fields;
  } else if (bytes.length !== 0) return refuse();
  return body;
}
