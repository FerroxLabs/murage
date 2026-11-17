// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import type { readAnchoredFile as AnchoredReader } from './anchored-read.ts';

// The optional helper must not prevent reads or server startup when it cannot load.
// Its F0 API stays unchanged; C3 supplies the platform implementation at integration.
let anchoredReader: typeof AnchoredReader | undefined;
try { anchoredReader = (await import('./anchored-read.ts')).readAnchoredFile; }
catch { /* An optional helper that cannot load leaves uploads unavailable. */ }
const readAnchoredFile: typeof AnchoredReader = (...args) => {
  if (!anchoredReader) throw Object.assign(new Error('The anchored file helper could not load.'), { code: 'unsupported' });
  return anchoredReader(...args);
};

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export class PreparedUpload {
  readonly #bytes: Uint8Array;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  constructor(name: string, bytes: Uint8Array, contentType: string = "application/octet-stream") {
    this.name = name; this.#bytes = Buffer.from(bytes); this.size = bytes.length; this.contentType = contentType;
    this.sha256 = createHash('sha256').update(this.#bytes).digest('hex'); Object.freeze(this);
  }
  copyBytes(): Uint8Array { return Buffer.from(this.#bytes); }
}

export function prepareWorkspaceUpload(root: string, ref: { workspaceFile: string }, maxBytes: number = UPLOAD_MAX_BYTES, reader: typeof readAnchoredFile = readAnchoredFile): PreparedUpload {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > UPLOAD_MAX_BYTES) throw new Error('Invalid upload size limit.');
  const parts = typeof ref.workspaceFile === 'string' ? ref.workspaceFile.split('/') : [];
  if (parts.length < 1 || parts.length > 32 || parts.some(p => !p || p.length > 255 || p === '.' || p === '..' || /[\\/:\x00\r\n]|[. ]$/.test(p) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) throw new Error('Invalid workspace file reference.');
  try {
    const result = reader(root, parts, maxBytes);
    if (result.size !== result.bytes.length || result.size > maxBytes) throw new Error('The upload must be a regular file of at most 10 MiB.');
    return new PreparedUpload(parts.at(-1)!, result.bytes);
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'unsupported') throw new Error("Murage's file helper is missing. Reinstall Murage.");
    throw error;
  }
}
