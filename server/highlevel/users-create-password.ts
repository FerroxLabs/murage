// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomInt } from 'node:crypto';
import { validHighLevelPassword } from '../../shared/highlevel-password.ts';

/** Private transport only. No credential exists at review, rate wait or lease time.
 * randomInt uses rejection sampling; Fisher-Yates removes fixed class positions.
 * The caller owns this buffer and must clear it in finally. V8/TLS copies cannot
 * be guaranteed erased: never displayed or intentionally persisted is the promise.
 */
export function generatePrivateUserPassword(): Buffer {
  const classes = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!@#$'];
  const alphabet = classes.join('');
  const bytes = Buffer.alloc(32);
  try {
    for (let i = 0; i < bytes.length; i++) {
      const chars = i < classes.length ? classes[i]! : alphabet;
      bytes[i] = chars.charCodeAt(randomInt(chars.length));
    }
    for (let i = bytes.length - 1; i > 0; i--) {
      const j = randomInt(i + 1), value = bytes[i]!; bytes[i] = bytes[j]!; bytes[j] = value;
    }
    if (!validHighLevelPassword(bytes.toString('ascii'))) throw new Error();
    return bytes;
  } catch { bytes.fill(0); throw new Error('The user could not be confirmed.'); }
}

function echoVariants(secret: string): string[] {
  const utf8 = Buffer.from(secret), wide = Buffer.from(secret, 'utf16le');
  const unicode = [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  try {
    return [secret, encodeURIComponent(secret), encodeURIComponent(secret).replace(/%[A-F0-9]{2}/gu, value => value.toLowerCase()),
      utf8.toString('base64'), utf8.toString('base64url'), utf8.toString('hex'), wide.toString('base64'),
      unicode, JSON.stringify(unicode).slice(1, -1)];
  } finally { utf8.fill(0); wide.fill(0); }
}
function decodeBytes(text: string, encoding: 'base64url' | 'hex'): string {
  const bytes = Buffer.from(text, encoding);
  try { return bytes.toString('utf8'); } finally { bytes.fill(0); }
}
/** Memory-only response checker. Its derived values must be disposed together
 * with transport bytes; neither it nor its exceptions may reach diagnostics. */
export function passwordEchoGuard(secret: string): { safe(value: unknown): boolean; dispose(): void } {
  const variants = echoVariants(secret);
  return {
    safe(value) {
      try {
        const encoded = JSON.stringify(value);
        if (typeof encoded !== 'string' || encoded.length > 4 * 1024 * 1024) return false;
        const queue: { text: string; depth: number }[] = [{ text: encoded, depth: 0 }];
        const values: unknown[] = [value];
        // Inspect individual strings too: an identity can contain a nested
        // encoding that is syntactically valid but must never enter a receipt.
        while (values.length) {
          const item = values.pop();
          if (typeof item === 'string') queue.push({ text: item, depth: 0 });
          else if (item && typeof item === 'object') {
            for (const [key, child] of Object.entries(item)) { queue.push({ text: key, depth: 0 }); values.push(child); }
          }
          if (queue.length > 100000) return false;
        }
        const seen = new Set<string>();
        let budget = 32 * 1024 * 1024;
        while (queue.length) {
          const { text, depth } = queue.pop()!;
          if (seen.has(text)) continue;
          seen.add(text); budget -= text.length;
          if (budget < 0) return false;
          if (variants.some(part => text.includes(part))) return false;
          if (depth >= 4) return false;
          const add = (decoded: string) => { if (decoded !== text) queue.push({ text: decoded, depth: depth + 1 }); };
          if (/%[0-9a-f]{2}/iu.test(text)) { try { add(decodeURIComponent(text)); } catch { /* not an encoded value */ } }
          if (/\\u[0-9a-f]{4}/iu.test(text)) add(text.replace(/\\u([0-9a-f]{4})/giu, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16))));
          if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/u.test(text)) add(decodeBytes(text, 'base64url'));
          if (/^(?:[0-9a-f]{2}){8,}$/iu.test(text)) add(decodeBytes(text, 'hex'));
        }
        return true;
      } catch { return false; }
    },
    dispose() { variants.fill(''); },
  };
}
