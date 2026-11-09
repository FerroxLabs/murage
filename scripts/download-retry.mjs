// Build-time download resilience for the pinned third-party archives.
// Retries only transport trouble (network error, timeout, truncated body, 408, 425, 429,
// 5xx) with capped exponential backoff. It never alters what is accepted: every caller
// still verifies its pinned size and sha256 after the bytes arrive, and a non-retryable
// status (404, 403, ...) fails at once.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
// Content-addressed download cache (actions/cache in CI). Files are named by their pinned
// sha256, so a cache entry can only ever hold the bytes the pin names; it is re-verified on read.
// Set MURAGE_PACKAGE_DOWNLOAD_CACHE to the directory. Unset means no cache.
export const DOWNLOAD_CACHE_ENV = "MURAGE_PACKAGE_DOWNLOAD_CACHE";
export const DEFAULT_PINNED_BASE_DELAY_MS = 8_000; // 5 tries: 8+16+32+60 s of waiting, about 2 minutes
const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function cacheFileFor(sha256, env = process.env) {
  const directory = env[DOWNLOAD_CACHE_ENV];
  if (!directory || !/^[0-9a-f]{64}$/.test(String(sha256))) return null;
  return join(resolve(directory), sha256);
}
// Authenticated github.com requests are not in the anonymous pool that GitHub throttles during
// incidents. MURAGE_PACKAGE_GITHUB_TOKEN (the workflow token) is sent to github.com ONLY (fetch
// drops it on a cross-origin redirect). A rejected token (401/403) is retried once without it.
export const GITHUB_TOKEN_ENV = "MURAGE_PACKAGE_GITHUB_TOKEN";
function authorized(source, init, env) {
  const token = env[GITHUB_TOKEN_ENV];
  if (!token) return null;
  let host;
  try { host = new URL(source).hostname; } catch { return null; }
  if (host !== "github.com") return null;
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}
async function fetchSource(source, init, env, options) {
  const withToken = authorized(source, init, env);
  if (!withToken) return fetchWithRetry(source, init, options);
  const response = await fetchWithRetry(source, withToken, options);
  if (response?.ok || ![401, 403].includes(response?.status)) return response;
  (options.log ?? ((message) => console.warn(message)))(`${source} rejected the token (HTTP ${response.status}); retrying anonymously`);
  return fetchWithRetry(source, init, options);
}
function failed(status, reason) {
  return { ok: false, status, body: null, headers: new Headers(), retriesExhausted: reason };
}
/**
 * Pinned download. Without options.sha256 this is upstream then the Ferrox mirror, each with
 * retries (callers verify afterwards). With options.sha256 it is cache, then upstream, then
 * mirror: every source is verified against the pin before it is used, a bad cache entry is
 * discarded, a bad download is never returned or cached, and when no source yields the pinned
 * bytes the result is a failed response (fail closed). Every URL tried is logged.
 */
export async function fetchPinned(url, init = {}, options = {}) {
  const { attempts = 5, env = process.env, sha256, baseDelayMs = DEFAULT_PINNED_BASE_DELAY_MS, ...rest } = options;
  const log = rest.log ?? ((message) => console.warn(message));
  const maxBytes = rest.maxBytes ?? DEFAULT_MAX_BYTES;
  const mirror = mirrorUrlFor(url, env);
  if (sha256 === undefined) {
    log(`downloading ${url}`);
    const primary = await fetchSource(url, init, env, { ...rest, attempts, baseDelayMs });
    if (primary?.ok) return primary;
    if (!mirror) return primary;
    log(`upstream download failed (${primary?.status ?? "unknown"}); trying the Ferrox mirror ${mirror}`);
    const second = await fetchSource(mirror, init, env, { ...rest, attempts, baseDelayMs });
    return second?.ok ? second : primary;
  }
  const pin = String(sha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pin)) throw new Error("DOWNLOAD_PIN_INVALID");
  const cached = cacheFileFor(pin, env);
  if (cached && existsSync(cached)) {
    try {
      const stat = lstatSync(cached);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes) {
        const bytes = readFileSync(cached);
        if (sha256Of(bytes) === pin) {
          log(`using cached ${url} (sha256 ${pin})`);
          return new Response(bytes, { status: 200 });
        }
      }
      log(`cached copy for ${url} failed sha256 verification; discarding it`);
      rmSync(cached, { force: true });
    } catch (error) {
      log(`cached copy for ${url} unusable (${error?.message ?? error}); fetching`);
    }
  } else if (cached) {
    log(`no cached copy of ${url}; fetching`);
  }
  let firstFailure;
  for (const source of [url, mirror]) {
    if (!source) continue;
    log(`downloading ${source}${source === url ? " (upstream)" : " (Ferrox mirror)"}`);
    const response = await fetchSource(source, init, env, { ...rest, attempts, baseDelayMs });
    if (!response?.ok) {
      firstFailure ??= response;
      log(`download from ${source} failed (${response?.retriesExhausted ?? response?.status ?? "unknown"})`);
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256Of(bytes);
    if (actual !== pin) {
      firstFailure ??= failed(0, "sha256 mismatch");
      log(`${source} failed sha256 verification (expected ${pin}, received ${actual}); not using it`);
      continue;
    }
    if (cached) {
      try {
        mkdirSync(dirname(cached), { recursive: true });
        const scratch = `${cached}.${process.pid}.tmp`;
        writeFileSync(scratch, bytes, { mode: 0o600 });
        renameSync(scratch, cached);
      } catch (error) {
        log(`could not cache ${source}: ${error?.message ?? error}`);
      }
    }
    return new Response(bytes, { status: 200 });
  }
  return firstFailure ?? failed(0, "no source");
}
