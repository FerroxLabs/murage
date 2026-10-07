// Stable lowercase error codes only; never provider prose, never a token.
export class HTTPError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** Reads a JSON body without ever holding more than `max` bytes: a declared
 *  Content-Length over the cap is refused before the body is touched, and
 *  otherwise (or when the header lies) the stream is counted as it arrives and
 *  cancelled the moment it passes the cap. */
export async function readJson(request: Request, max = 16_384): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) {
    void request.body?.cancel().catch(() => {});
    throw new HTTPError(413, "request_too_large");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => {});
        throw new HTTPError(413, "request_too_large");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HTTPError(400, "invalid_request"); }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export function randomToken(prefix: string): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function bearer(request: Request, pattern: RegExp): string | null {
  const value = request.headers.get("authorization")?.match(/^Bearer[ \t]+(\S+)$/i)?.[1];
  return value && pattern.test(value) ? value : null;
}
