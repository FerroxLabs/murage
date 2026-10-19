// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Is Murage Cloud live?" The Cloud entry appears by itself once the pinned PROD control plane says so,
// and never before. Nothing here blocks startup or the first paint: every process starts NOT live, and the
// network probe runs later, unref'd and fire-and-forget. Nothing on disk can turn Cloud on: a local file is
// unauthenticated, so the only thing that activates the gate is a verified live:true answer to a probe made
// by THIS process. The scheme and IPC are always registered (inert); this gate's runtime state flips them on
// when a verified live:true arrives and back off on a verified live:false, with no restart. A failed probe
// (network error, timeout, non-200, malformed body) is not an answer and changes nothing.
//
// Interface: cloudLiveStatus() -> Promise<{ live: boolean, origin: string }>, rejecting when no verified answer exists.
import fs from "node:fs";
import path from "node:path";

/** A file older builds wrote. It is never read; a verified answer removes it. */
export const CLOUD_LIVE_CACHE_FILE = "cloud-live.json";
export const CLOUD_LIVE_INTERVAL_MS = 4 * 60 * 60_000;

/** No verified answer: the probe failed. Not the same as live:false. */
export class CloudLiveProbeError extends Error {}

/**
 * The real adapter. MurageCloud: GET /v1/status -> {live:boolean}, unauthenticated, no-store, served only from the
 * control-plane origin; live is true only while sales are open. Pinned origin only, redirect:"error", <=5 s,
 * no credentials. Resolves only for a 200 whose body is exactly {"live": <boolean>}; any error, timeout, non-JSON body,
 * non-200, redirect, other origin or other shape REJECTS (CloudLiveProbeError): an outage is not a verified "not live".
 * The returned origin is always the pinned one we asked, so the policy can compare it.
 */
export function createCloudLiveStatus({ resolve, fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  const fail = (why) => { throw new CloudLiveProbeError(why); };
  return async function cloudLiveStatus() {
    const cp = resolve();
    if (!cp?.baseUrl || typeof fetchImpl !== "function") fail("no pinned control plane");
    let response;
    try {
      response = await fetchImpl(`${cp.baseUrl}/v1/status`, {
        method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
        headers: { accept: "application/json", "cache-control": "no-cache" },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)),
      });
    } catch (error) { fail(`request failed: ${error?.message ?? error}`); }
    if (response?.status !== 200) fail(`status ${response?.status}`);
    let origin;
    try { origin = response.url ? new URL(response.url).origin : cp.baseUrl; } catch { fail("bad response url"); }
    if (origin !== cp.baseUrl) fail("other origin");
    let body;
    try { body = await response.json(); } catch { fail("not JSON"); }
    // Unsigned by design: exactly {"live": <boolean>}. Extra keys, a non-boolean or a non-object is no answer.
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.live !== "boolean") fail("malformed body");
    return { live: body.live, origin: cp.baseUrl };
  };
}

/** Test/inert default: never live. */
export function createStubCloudLiveStatus() {
  return async function cloudLiveStatus() { return { live: false }; };
}

/**
 * Pure policy: true only for live:true from the pinned PROD https origin that has a JWK pinned.
 * Anything else (staging, wrong origin, missing JWK, malformed answer) is false.
 */
export function evaluateCloudLive(cp, answer, now = Date.now()) {
  if (!cp || cp.environment !== "prod" || !cp.jwk || !cp.baseUrl || !cp.baseUrl.startsWith("https://")) return false;
  return Boolean(answer) && typeof answer === "object" && answer.live === true && answer.origin === cp.baseUrl;
}

/**
 * @param {object} deps
 * @param {() => object | null} deps.resolve  the shared resolver, already bound to env (null = refused)
 * @param {() => Promise<object>} deps.cloudLiveStatus
 * @param {() => string} [deps.cacheDir]  user-data directory (only to remove the file older builds wrote)
 * @param {() => boolean} [deps.hardOff]  MURAGE_DESKTOP_CLOUD=0: nothing probes and nothing turns Cloud on
 */
export function createCloudLiveGate({
  resolve, cloudLiveStatus = createCloudLiveStatus({ resolve }), cacheDir, now = Date.now,
  startDelayMs = 15_000, intervalMs = CLOUD_LIVE_INTERVAL_MS, focusMinGapMs = 10 * 60_000,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimer = clearTimeout, warn = () => {},
  hardOff = () => false, probeNowTimeoutMs = 5000,
}) {
  const file = () => path.join(typeof cacheDir === "function" ? cacheDir() : cacheDir, CLOUD_LIVE_CACHE_FILE);
  let timer = null; let started = false; let inFlight = false; let lastProbeAt = -Infinity;
  const listeners = new Set();
  // Always false at construction: nothing read from disk can activate Cloud. Only refresh() below sets it true.
  let state = false;
  function setState(next) {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) { try { listener(next); } catch (error) { warn(`cloud live listener: ${error?.message ?? error}`); } }
  }
  /** Removes the file older builds wrote (it is never read). Best effort, only once a verified answer arrives. */
  let legacyCleared = false;
  function clearLegacyCache() {
    if (legacyCleared || !cacheDir) return;
    legacyCleared = true;
    try { fs.rmSync(file(), { force: true }); } catch (error) { warn(`cloud live cache: ${error?.message ?? error}`); }
  }

  /** One probe. Never throws, never rejects. A failed probe changes nothing (an outage is not "not live"). */
  let current = null;
  function refresh() {
    if (inFlight) return current ?? Promise.resolve(state);
    current = probeOnce().finally(() => { current = null; });
    return current;
  }
  async function probeOnce() {
    if (hardOff()) { setState(false); return false; }
    inFlight = true; lastProbeAt = now();
    try {
      const cp = resolve();
      if (!cp) { clearLegacyCache(); setState(false); return false; }
      let answer;
      try { answer = await cloudLiveStatus(); } catch (error) { warn(`cloud live probe failed: ${error?.message ?? error}`); return state; }
      const live = evaluateCloudLive(cp, answer, now());
      clearLegacyCache();
      setState(live);
      return live;
    } catch { return state; } finally { inFlight = false; }
  }

  /** Schedules the first probe after startDelayMs and then every intervalMs. Returns at once. */
  function start() {
    if (started) return;
    started = true;
    const tick = () => { void refresh().finally(() => { if (started) timer = setTimer(tick, intervalMs); }); };
    timer = setTimer(tick, startDelayMs);
  }
  /** Window gained focus: probe, at most once per focusMinGapMs. Fire-and-forget. */
  function probeOnFocus() {
    if (inFlight || now() - lastProbeAt < focusMinGapMs) return;
    void refresh();
  }
  /**
   * A Cloud link arrived while not live: ONE probe now, bounded to probeNowTimeoutMs (5 s), through the same policy, so the
   * hard off and a missing prod JWK still win. Shares a probe already in flight. Resolves the gate's answer; never rejects.
   */
  function probeNow() {
    if (hardOff()) return Promise.resolve(false);
    let timer = null;
    const bounded = new Promise((resolve) => { timer = setTimer(() => resolve(state), probeNowTimeoutMs); });
    return Promise.race([refresh().then(() => state, () => state), bounded]).finally(() => { if (timer !== null) clearTimer(timer); });
  }
  /** The runtime answer: what the scheme handler and IPC stubs check on every call. */
  const isLive = () => state;
  function onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  function stop() { started = false; if (timer !== null) clearTimer(timer); timer = null; }

  return { isLive, onChange, refresh, probeNow, probeOnFocus, start, stop };
}
