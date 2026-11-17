export const LIFECYCLE_INTERVAL_MS: number;
export const LIFECYCLE_RATE_LIMIT_BACKOFF_MS: number;
export const TRANSIENT_BACKOFF_MS: readonly number[];
export function lifecycleDelay(options?: { transientFailures?: number; rateLimited?: boolean; rateLimitFailures?: number; retryAfterMs?: number }): number;
export function lifecycleRetryAfterMs(value?: string, now?: number): number;
export const ONLINE_RETURN_MIN_GAP_MS: number;
export function shouldRunLifecycleNow(options: { now: number; nextAt: number; online: boolean; wasOnline: boolean; holdUntil?: number }): boolean;
export const EVICTION_CODES: ReadonlySet<string>;
export const TOKEN_TAKEN_OVER: string;
export const AUTO_REMINT_LOOP_WINDOW_MS: number;
export function createTokenRejectionHandler(options: {
  getCredentials: () => { fluxComposioBrokerToken?: string; fluxComposioTokenError?: string } | null | undefined;
  markTakenOver: () => Promise<void>;
  remint: (rejectedTokenFingerprint: string | undefined) => Promise<unknown>;
  now?: () => number;
}): {
  noteReplacement(tokenFingerprint: string, at?: number): void;
  onRejected(rejection?: { tokenFingerprint?: string; code?: string }): Promise<"ignored" | "reminted" | "taken-over" | "failed" | "backoff" | "held">;
  reconnect(): Promise<{ reconnected: boolean; outcome?: string; retryAt?: number }>;
};
export function createLifecycleQueue<O extends { claim?: boolean; force?: boolean }, R>(runPass: (options: O) => Promise<R>): (options?: O) => Promise<R>;
export function createLifecycleScheduler(options: {
  net: { isOnline(): boolean };
  powerMonitor: { on(event: "resume", listener: () => void): unknown; removeListener(event: "resume", listener: () => void): unknown };
  run: (options?: { force?: boolean; rejectedTokenFingerprint?: string }) => unknown;
  isShuttingDown?: () => boolean;
  now?: () => number;
  dispatchers?: Record<string, (options: { force?: boolean; rejectedTokenFingerprint?: string }) => unknown>;
  tickMs?: number;
  wakeDelayMs?: number;
}): { start(): void; stop(): void; afterPass(result?: { rateLimited?: boolean; transient?: boolean; retryAfter?: string; retryForce?: string }): void };
