// Copyright 2026 Ferrox Labs
// Adapted from OpenClaw extensions/whatsapp (reconnect.ts, connection-controller.ts, auto-reply/monitor.ts)
// and Hermes Agent scripts/whatsapp-bridge/bridge_helpers.js (reconnect scheduler, version resolver)
// (both MIT).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What to do when the WhatsApp socket closes (design 2.4) and how fast to
// come back (design 4). Pure; timers and clocks are injected.

export const DISCONNECT = {
  loggedOut: 401,
  forbidden: 403,
  connectionClosed: 428,
  timedOut: 408,
  connectionReplaced: 440,
  multideviceMismatch: 411,
  badSession: 500,
  unavailableService: 503,
  restartRequired: 515,
} as const;

export type LinkState = "idle" | "linking" | "restarting" | "connected" | "retry" | "logged-out" | "conflict" | "blocked";
export type BlockedReason = "forbidden" | "multidevice-mismatch" | "retry-limit" | "auth-dir" | "key-missing" | "credential-store" | "auth-unreadable";
export type CloseAction = "restart-once" | "retry" | "stop-logged-out" | "stop-conflict" | "stop-blocked";

export interface CloseDecision {
  code: number | undefined;
  action: CloseAction;
  state: LinkState;
  /** True when the host should start a new socket (now, or after backoff). */
  reconnect: boolean;
  /** Wipe the auth directory (401 and 500). */
  wipeAuth: boolean;
  /** For `restart-once`, wait for the creds write to settle before reporting connected. */
  awaitCredsPersisted: boolean;
  blockedReason?: BlockedReason;
}

export interface CloseContext {
  /** True once the single post-scan restart has been used for this link. */
  postPairingRestarted: boolean;
  /** When that restart happened. */
  restartedAtMs?: number;
  nowMs: number;
}

export const SECOND_515_WINDOW_MS = 2 * 60_000;

const base = (code: number | undefined): Omit<CloseDecision, "action" | "state" | "reconnect"> => ({ code, wipeAuth: false, awaitCredsPersisted: false });

export function decideClose(code: number | undefined, context: CloseContext): CloseDecision {
  switch (code) {
    case DISCONNECT.restartRequired: {
      const usedRecently = context.postPairingRestarted && context.restartedAtMs !== undefined && context.nowMs - context.restartedAtMs < SECOND_515_WINDOW_MS;
      if (context.postPairingRestarted && (usedRecently || context.restartedAtMs === undefined)) return { ...base(code), action: "retry", state: "retry", reconnect: true };
      return { ...base(code), action: "restart-once", state: "restarting", reconnect: true, awaitCredsPersisted: true };
    }
    case DISCONNECT.loggedOut:
    case DISCONNECT.badSession:
      return { ...base(code), action: "stop-logged-out", state: "logged-out", reconnect: false, wipeAuth: true };
    case DISCONNECT.connectionReplaced:
      return { ...base(code), action: "stop-conflict", state: "conflict", reconnect: false };
    case DISCONNECT.forbidden:
      return { ...base(code), action: "stop-blocked", state: "blocked", reconnect: false, blockedReason: "forbidden" };
    case DISCONNECT.multideviceMismatch:
      return { ...base(code), action: "stop-blocked", state: "blocked", reconnect: false, blockedReason: "multidevice-mismatch" };
    default:
      // 428, 408, 503 and anything unknown: transient, back off and come back.
      return { ...base(code), action: "retry", state: "retry", reconnect: true };
  }
}

export interface ReconnectPolicy {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
  maxAttempts: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = { initialMs: 2_000, maxMs: 30_000, factor: 1.8, jitter: 0.25, maxAttempts: 12 };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** OpenClaw resolveReconnectPolicy clamps. */
export function resolveReconnectPolicy(overrides: Partial<ReconnectPolicy> = {}): ReconnectPolicy {
  const merged = { ...DEFAULT_RECONNECT_POLICY, ...overrides };
  const initialMs = Math.max(250, merged.initialMs);
  return {
    initialMs,
    maxMs: Math.max(initialMs, merged.maxMs),
    factor: clamp(merged.factor, 1.1, 10),
    jitter: clamp(merged.jitter, 0, 1),
    maxAttempts: Math.max(0, Math.floor(merged.maxAttempts)),
  };
}

/** Delay before attempt `attempt` (1-based): exponential, jittered upward, capped at `maxMs`. */
export function computeBackoff(policy: ReconnectPolicy, attempt: number, random: () => number = Math.random): number {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

export type NextReconnect = { kind: "wait"; attempt: number; delayMs: number } | { kind: "blocked"; reason: "retry-limit" };

/** After 12 failed attempts the bridge reports `blocked:"retry-limit"`. `failures` counts closes since the last good connection. */
export function nextReconnect(failures: number, policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY, random: () => number = Math.random): NextReconnect {
  const attempt = failures;
  if (attempt > policy.maxAttempts) return { kind: "blocked", reason: "retry-limit" };
  return { kind: "wait", attempt, delayMs: computeBackoff(policy, attempt, random) };
}

/** A restart after a scan is one second; Hermes used 1 s for 515 and 3 s for everything else. */
export const RESTART_DELAY_MS = 1_000;

export const WATCHDOG_FRAME_TIMEOUT_MS = 3 * 60_000;

/** Frame-only watchdog: silence on the raw socket restarts it; silence in conversation never does. */
export function watchdogShouldRestart(state: LinkState, lastFrameAtMs: number, nowMs: number): boolean {
  return state === "connected" && nowMs - lastFrameAtMs >= WATCHDOG_FRAME_TIMEOUT_MS;
}

/**
 * Hermes createReconnectScheduler: every (re)connect goes through here so a
 * throwing or rejecting start is rescheduled instead of lost.
 */
export function createReconnectScheduler(
  startFn: () => unknown,
  options: { retryDelayMs?: number; log?: (line: string) => void; setTimeoutFn?: (fn: () => void, ms: number) => unknown } = {},
): (delayMs: number) => void {
  const retryDelayMs = options.retryDelayMs ?? 5000;
  const log = options.log ?? (() => undefined);
  const setTimeoutFn = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const schedule = (delayMs: number): void => {
    setTimeoutFn(() => {
      Promise.resolve()
        .then(startFn)
        .catch((error: unknown) => {
          log(`Reconnect failed (${error instanceof Error ? error.message : String(error)}). Retrying in ${Math.round(retryDelayMs / 1000)}s...`);
          schedule(retryDelayMs);
        });
    }, delayMs);
  };
  return schedule;
}

/**
 * Hermes createVersionResolver: bound the web-version fetch and fall back to
 * the last good version (or null for the library default).
 */
export function createVersionResolver<V>(
  fetchVersion: () => Promise<{ version: V }>,
  options: { timeoutMs?: number; log?: (line: string) => void; initial?: V | null } = {},
): () => Promise<V | null> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const log = options.log ?? (() => undefined);
  let cached: V | null = options.initial ?? null;
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { version } = await Promise.race([
        fetchVersion(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("version fetch timed out")), timeoutMs); }),
      ]);
      cached = version;
    } catch (error) {
      log(`WhatsApp version fetch failed (${error instanceof Error ? error.message : String(error)}); using ${cached ? "cached version" : "library default"}.`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return cached;
  };
}
