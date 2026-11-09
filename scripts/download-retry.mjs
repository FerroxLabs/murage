// Build-time download resilience for the pinned third-party archives.
// Retries only transport trouble (network error, timeout, truncated body, 408, 425, 429,
// 5xx) with capped exponential backoff. It never alters what is accepted: every caller
// still verifies its pinned size and sha256 after the bytes arrive, and a non-retryable
// status (404, 403, ...) fails at once.
const RETRYABLE = new Set([408, 425, 429]);
export const DEFAULT_ATTEMPTS = 8;
export const DEFAULT_BASE_DELAY_MS = 5_000;
export const DEFAULT_MAX_DELAY_MS = 60_000;
export const DEFAULT_MAX_BYTES = 96 * 1024 ** 2;
export function isRetryableStatus(status) {
  return RETRYABLE.has(status) || (status >= 500 && status <= 599);
}
function retryAfterMs(response) {
  const value = response?.headers?.get?.("retry-after");
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
}
class TooLarge extends Error {}
async function readBounded(response, maxBytes) {
  const chunks = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new TooLarge("DOWNLOAD_LIMIT");
      chunks.push(Buffer.from(chunk));
    }
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new TooLarge("DOWNLOAD_LIMIT");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
/**
 * fetch() with retries. The whole body is read inside each attempt (bounded), so a dropped
 * connection mid-body is retried too and no partial bytes ever reach a caller. Returns a
 * Response holding the complete body (ok), or the final failed response / a synthetic one.
 */
export async function fetchWithRetry(url, init = {}, {
  fetchImpl = globalThis.fetch,
  attempts = DEFAULT_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  timeoutMs = 60_000,
  maxBytes = DEFAULT_MAX_BYTES,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = message => console.warn(message),
} = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
      response = await fetchImpl(url, { ...init, signal });
      if (response?.ok) {
        const bytes = await readBounded(response, maxBytes);
        return new Response(bytes, { status: 200 });
      }
      try { await response?.body?.cancel?.(); } catch {}
      if (!isRetryableStatus(response?.status)) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      if (error instanceof TooLarge) return { ok: false, status: 0, body: null, headers: new Headers(), retriesExhausted: "too large" };
      last = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : String(error?.cause?.code ?? error?.message ?? error);
      response = undefined;
    }
    if (attempt === attempts) break;
    const delay = Math.min(maxDelayMs, Math.max(baseDelayMs * 2 ** (attempt - 1), retryAfterMs(response)));
    log(`download attempt ${attempt}/${attempts} failed (${last}); retrying in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
  // Exhausted: hand back a synthetic failed response so each caller keeps its own error code.
  return { ok: false, status: Number(/HTTP (\d+)/.exec(last ?? "")?.[1] ?? 0), body: null, headers: new Headers(), retriesExhausted: last };
}

// A Ferrox-controlled copy of every pinned archive (a prerelease on FerroxLabs/murage,
// files named exactly like the upstream ones). It is only a second place to fetch the
// same bytes: callers still verify the pinned size and sha256, so a bad mirror fails closed.
// Set MURAGE_PACKAGE_MIRROR_BASE to another https base URL, or to "off" to disable the mirror.
export const DEFAULT_MIRROR_BASE = "https://github.com/FerroxLabs/murage/releases/download/build-mirror-1/";
export function mirrorUrlFor(url, env = process.env) {
  const configured = env.MURAGE_PACKAGE_MIRROR_BASE;
  if (configured === "off" || configured === "") return null;
  let base;
  try { base = new URL(configured ?? DEFAULT_MIRROR_BASE); } catch { return null; }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !base.pathname.endsWith("/")) return null;
  const name = new URL(url).pathname.split("/").pop();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  base.pathname += name;
  return base.href;
}
/** Upstream first (with retries), then the Ferrox mirror (with retries). Returns the first ok response, else the upstream failure. */
export async function fetchPinned(url, init = {}, options = {}) {
  const { attempts = 5, env = process.env, ...rest } = options;
  const primary = await fetchWithRetry(url, init, { ...rest, attempts });
  if (primary?.ok) return primary;
  const mirror = mirrorUrlFor(url, env);
  if (!mirror) return primary;
  (rest.log ?? ((message) => console.warn(message)))(`upstream download failed (${primary?.status ?? "unknown"}); trying the Ferrox mirror ${mirror}`);
  const second = await fetchWithRetry(mirror, init, { ...rest, attempts });
  return second?.ok ? second : primary;
}
