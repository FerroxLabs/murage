// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Bound retained JSON, not the wire prefix. Keep scanning after a long string
 * so state/code fields on either side of a diagnostic remain structural.
 * Escapes are indivisible; truncating a string never makes valid JSON invalid.
 * The wire/depth/retained limits fail closed at the response boundary. */
export async function readFluxJson(response: Response, signal?: AbortSignal, diagnosticsOnly = true): Promise<{ rawBody: string; bytes: number }> {
  if (!response.body) return {rawBody:'', bytes:0};
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const retainedLimit = diagnosticsOnly ? 1_048_576 : 16_777_216;
  const stringLimit = diagnosticsOnly ? 64_000 : retainedLimit;
  let output = '', token = '', escape = '', inString = false, wire = 0, depth = 0;
  const append = (s: string) => {
    output += s;
    if (output.length > retainedLimit) throw new Error('Flux JSON retained limit');
  };
  const scan = (text: string) => {
    for (const c of text) {
      if (inString) {
        if (escape) {
          escape += c;
          if (escape.length === 2 && c === 'u') continue;
          if (escape[1] === 'u' && escape.length < 6) continue;
          if (token.length < stringLimit) token += escape;
          escape = '';
        } else if (c === '\\') escape = c;
        else if (c === '"') { append('"' + token + '"'); token = ''; inString = false; }
        else if (token.length < stringLimit) token += c;
      } else if (c === '"') inString = true;
      else {
        if (c === '{' || c === '[') { if (++depth > 64) throw new Error('Flux JSON depth limit'); }
        if (c === '}' || c === ']') depth--;
        append(c);
      }
    }
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      wire += part.value.byteLength;
      if (wire > 16_777_216) throw new Error('Flux JSON wire limit');
      scan(decoder.decode(part.value, {stream:true}));
    }
    scan(decoder.decode());
    if (inString || depth !== 0) throw new Error('Incomplete Flux JSON');
    return {rawBody: output, bytes: wire};
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
