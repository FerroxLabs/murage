// SPDX-License-Identifier: AGPL-3.0-or-later
// The identity reader's one question: what is this Supabase user's CURRENT email and updated_at? (support design 4.5 "The identity reader").
// Failure contract: a fixed endpoint from config, no redirects followed, a 5-second timeout, the returned user id must equal the requested one
// (the control plane passes the mapped Supabase `sub`) before email and updated_at are projected. EVERY other outcome throws
// IdentityUnavailable: the control plane turns that into 503 identity_unavailable, leaves authorization uncommitted and consumes no link.
// Nothing here is cached, logged or returned beyond {id, email, updatedAt}; the secret key never leaves this Worker.

export interface ReaderEnv { SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string }
export interface IdentityRead { id: string; email: string; updatedAt: string }
export class IdentityUnavailable extends Error { constructor() { super("identity_unavailable"); } }

export const READ_TIMEOUT_MS = 5_000;
export const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fixed endpoint: https, a bare origin (no credentials, path, query or fragment), from config only. */
export function endpointFor(env: ReaderEnv, userId: string): string {
  if (!UUID_RE.test(userId)) throw new IdentityUnavailable();
  let base: URL;
  try { base = new URL(env.SUPABASE_URL ?? ""); } catch { throw new IdentityUnavailable(); }
  if (base.protocol !== "https:" || base.username || base.password || (base.pathname !== "/" && base.pathname !== "") || base.search || base.hash) throw new IdentityUnavailable();
  return `${base.origin}/auth/v1/admin/users/${userId.toLowerCase()}`;
}

/** The response body, counted in BYTES as it streams: cancelled the moment it passes 64 KiB, and raced against the same abort signal as the
 *  fetch, so the timeout covers the body read too (a server that sends headers and then trickles never holds the reader). */
async function readCapped(res: Response, signal: AbortSignal): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) throw new IdentityUnavailable();
  if (!res.body) throw new IdentityUnavailable();
  const reader = res.body.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new IdentityUnavailable());
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new IdentityUnavailable();
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function readIdentity(env: ReaderEnv, userId: string, fetchImpl: typeof fetch = fetch, timeoutMs = READ_TIMEOUT_MS): Promise<IdentityRead> {
  const url = endpointFor(env, userId);
  const key = env.SUPABASE_SECRET_KEY;
  if (!key) throw new IdentityUnavailable();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: abort.signal, headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" } });
    if (res.status !== 200) throw new IdentityUnavailable();         // includes every 3xx (redirect: "manual") and the opaque redirect (status 0)
    const body: unknown = JSON.parse(await readCapped(res, abort.signal));
    if (typeof body !== "object" || body === null) throw new IdentityUnavailable();
    const { id, email, updated_at: updatedAt } = body as Record<string, unknown>;
    if (typeof id !== "string" || id.toLowerCase() !== userId.toLowerCase()) throw new IdentityUnavailable();
    if (typeof email !== "string" || !email.trim() || typeof updatedAt !== "string" || !updatedAt) throw new IdentityUnavailable();
    return { id: id.toLowerCase(), email: email.trim().toLowerCase(), updatedAt };
  } catch (e) {
    throw e instanceof IdentityUnavailable ? e : new IdentityUnavailable();
  } finally {
    clearTimeout(timer);
  }
}
