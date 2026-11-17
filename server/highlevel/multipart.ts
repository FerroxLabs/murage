// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import { ActionRefused } from './actions.ts';
import { UPLOAD_MAX_BYTES, PreparedUpload } from './uploads.ts';

export function assembleMultipart(fields: Readonly<Record<string, string>>, file: { field: string; upload: PreparedUpload }): { bytes: Uint8Array; contentType: string; fileOffset: number; fileLength: number } {
  const refuse = (): never => { throw new ActionRefused('request_shape', 'Invalid multipart request.'); };
  let upload: PreparedUpload;
  try { upload = copyPreparedUpload(file.upload); } catch { return refuse(); }
  const safe = (v: unknown, max: number): v is string => typeof v === 'string' && Buffer.byteLength(v) <= max && !/["\r\n\x00]/.test(v);
  if (!safe(file.field, 180) || !file.field || !safe(upload.name, 1024) || !upload.name || !/^[\w.+-]+\/[\w.+-]+$/.test(upload.contentType)) return refuse();
  const entries = Object.entries(fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length > 8 || entries.some(([k, v]) => !k || !safe(k, 180) || !safe(v, 4096))) return refuse();
  const bytes = Buffer.from(upload.copyBytes());
  for (let attempt = 0; attempt < 4; attempt++) {
    const boundary = `MurageHL${randomBytes(16).toString('hex')}`;
    if (bytes.includes(boundary) || entries.some(([, v]) => v.includes(boundary))) continue;
    const chunks = entries.map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${upload.name}"\r\nContent-Type: ${upload.contentType}\r\n\r\n`));
    const fileOffset = chunks.reduce((n, b) => n + b.length, 0);
    chunks.push(bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    if (body.length > UPLOAD_MAX_BYTES + 64 * 1024) return refuse();
    return { bytes: body, contentType: `multipart/form-data; boundary=${boundary}`, fileOffset, fileLength: bytes.length };
  }
  return refuse();
}

function copyPreparedUpload(prepared: PreparedUpload): PreparedUpload {
  const copy = new PreparedUpload(prepared.name, prepared.copyBytes(), prepared.contentType);
  if (copy.size > UPLOAD_MAX_BYTES || copy.size !== prepared.size || copy.sha256 !== prepared.sha256) throw new Error('The prepared upload changed.');
  return copy;
}
