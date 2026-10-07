export const LIFECYCLE_INTERVAL_MS: number;
export const LIFECYCLE_RATE_LIMIT_BACKOFF_MS: number;
export const TRANSIENT_BACKOFF_MS: readonly number[];
export function lifecycleDelay(options?: { transientFailures?: number; rateLimited?: boolean }): number;
export function shouldRunLifecycleNow(options: { now: number; nextAt: number; online: boolean; wasOnline: boolean }): boolean;
export const EVICTION_CODES: ReadonlySet<string>;
export const TOKEN_TAKEN_OVER: string;
export const AUTO_REMINT_LOOP_WINDOW_MS: number;
export function createTokenRejectionHandler(options: {
  getCredentials: () => { fluxComposioBrokerToken?: string; fluxComposioTokenError?: string } | null | undefined;
  markTakenOver: () => Promise<void>;
  remint: (rejectedTokenFingerprint: string | undefined) => Promise<unknown>;
  now?: () => number;
}): {
  onRejected(rejection?: { tokenFingerprint?: string; code?: string }): Promise<"ignored" | "reminted" | "taken-over" | "failed" | "backoff">;
  reconnect(): Promise<void>;
};
export function createLifecycleQueue<O extends { claim?: boolean; force?: boolean }, R>(runPass: (options: O) => Promise<R>): (options?: O) => Promise<R>;
export function createLifecycleScheduler(options: {
  net: { isOnline(): boolean };
  powerMonitor: { on(event: "resume", listener: () => void): unknown; removeListener(event: "resume", listener: () => void): unknown };
  run: (options?: { force?: boolean; rejectedTokenFingerprint?: string }) => unknown;
  isShuttingDown?: () => boolean;
  now?: () => number;
  tickMs?: number;
  wakeDelayMs?: number;
}): { start(): void; stop(): void; afterPass(result?: { rateLimited?: boolean; transient?: boolean; retryForce?: string }): void };
