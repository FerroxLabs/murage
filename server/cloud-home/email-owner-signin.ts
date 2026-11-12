// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cloud owner sign-in for bot email (CLOUD-EMAIL-KEYSTORE-1019, S). The supervisor runs a Flux device-code flow to obtain the `email:owner`
// token, seals it in the keystore, and pushes `murage:cloud-email-owner` to the server.
// The wire is behind FluxDeviceCodeClient. The default is a labelled STUB that makes no network call and answers unavailable. The real client
// (flux-device-code-client.ts, the one module that names the endpoints) allows sign-in only when Flux's capabilities answer `bot_keys: true`, and
// the production supervisor session constructs it from the home's existing Flux routing base.
import type { FluxCredential } from "../email/flux-email-client.ts";

/** RFC 8628 3.5: slow_down adds 5 seconds to the polling interval; Flux caps the interval at 60 s. */
export const SLOW_DOWN_STEP_MS = 5_000;
export const MAX_POLL_INTERVAL_MS = 60_000;
/** A code is never waited on for longer than this, whatever `expires_in` says. */
export const MAX_CODE_LIFETIME_MS = 600_000;
/** Revoke retry and owner reconcile backoff: 5 s doubling to a 5 min ceiling (r4 B). */
export const OWNER_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000];

export interface DeviceCodeStart { deviceCode: string; userCode: string; verificationUrl: string; intervalMs: number; expiresInMs: number }
export type DeviceCodePoll = { state: "pending" | "slow_down" | "retry" /** transient: network, 5xx, other 4xx. Polling goes on at the same interval until expiry. */ } | { state: "ok"; owner: FluxCredential; /** The 200 carried the `email:owner` scope. */ scoped: boolean } | { state: "denied" | "expired" | "unavailable" };
/** revoked (204) and gone (401 invalid_token) both mean the key is unlinked; retry (503, 404 flag off, network) means it is NOT revoked. */
export type RevokeResult = "revoked" | "gone" | "retry";
export interface FluxDeviceCodeClient {
  /** Only the real client implements the capability gate. The delay includes its cache and failure backoff. */
  availability?(): Promise<{ available: boolean; retryAfterMs: number }>;
  start(): Promise<DeviceCodeStart | { state: "unavailable" }>;
  poll(deviceCode: string): Promise<DeviceCodePoll>;
  /** POST /api/device/revoke with the key as the bearer. */
  revoke(token: string): Promise<RevokeResult>;
}

/** STUB: no network, no token. Holds no key, so there is nothing to revoke. */
export const stubFluxDeviceCodeClient: FluxDeviceCodeClient = {
  async start() { return { state: "unavailable" }; },
  async poll() { return { state: "unavailable" }; },
  async revoke() { return "gone"; },
};

export type OwnerSignInOutcome = "done" | "saving" | "denied" | "expired" | "unavailable";
export interface OwnerSignInEvents {
  /** The code the owner types at the verification page. Never a token. */
  code(info: { userCode: string; verificationUrl: string }): void;
  /** Called once with the token; the caller seals it and pushes it. `false`: not kept (the caller revokes it). "saving": the write is not confirmed yet and is being retried. */
  token(owner: FluxCredential): Promise<boolean | "saving">;
  /** A token that must not be kept (wrong scope): the caller revokes it. */
  discard?(owner: FluxCredential): void;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** Runs one device-code sign-in to its end. Bounded by the code's own expiry (at most 10 minutes) and `maxPolls`. */
export async function runOwnerSignIn(client: FluxDeviceCodeClient, events: OwnerSignInEvents, options: { sleep?: (ms: number) => Promise<void>; maxPolls?: number; isCancelled?: () => boolean; /** Monotonic clock in ms; expiry is measured on it, not on requested sleeps. */ now?: () => number } = {}): Promise<OwnerSignInOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const started = await client.start();
  if ("state" in started) return "unavailable";
  events.code({ userCode: started.userCode, verificationUrl: started.verificationUrl });
  const deadline = Math.min(started.expiresInMs, MAX_CODE_LIFETIME_MS);
  const now = options.now ?? (() => performance.now());
  const t0 = now();
  // whole seconds, never below 1 s (a response asking for 1 ms is not obeyed)
  let intervalMs = Math.min(Math.max(1_000, Math.ceil(started.intervalMs / 1_000) * 1_000), MAX_POLL_INTERVAL_MS);
  for (let polls = 0; polls < (options.maxPolls ?? 600); polls++) {
    if (options.isCancelled?.()) return "expired";
    await sleep(intervalMs);
    if (options.isCancelled?.()) return "expired";
    if (now() - t0 > deadline) return "expired";
    const answer = await client.poll(started.deviceCode);
    // cancelled while the poll was in flight: a key that arrives now is never kept, and never left alive either (the caller revokes it)
    if (options.isCancelled?.()) { if (answer.state === "ok") events.discard?.(answer.owner); return "expired"; }
    if (now() - t0 > deadline && answer.state !== "ok") return "expired";
    if (answer.state === "pending" || answer.state === "retry") continue;
    if (answer.state === "slow_down") { intervalMs = Math.min(intervalMs + SLOW_DOWN_STEP_MS, MAX_POLL_INTERVAL_MS); continue; }
    if (answer.state === "ok") {
      if (!answer.scoped) { events.discard?.(answer.owner); return "unavailable"; }
      const kept = await events.token(answer.owner);
      return kept === "saving" ? "saving" : kept ? "done" : "unavailable";
    }
    return answer.state;
  }
  return "expired";
}

/** Revokes one owner key at Flux: 204 or 401 end it, 503 or a network error retry with backoff (a retry never touches the sealed store).
 * Stops when `stop()` says so (supervisor exit): the key then stays at Flux as an unheld "Murage Cloud" key the owner can delete. */
export async function revokeWithBackoff(client: FluxDeviceCodeClient, token: string, options: { sleep?: (ms: number) => Promise<void>; delaysMs?: readonly number[]; stop?: () => boolean } = {}): Promise<"revoked" | "gone" | "stopped"> {
  const sleep = options.sleep ?? defaultSleep, delays = options.delaysMs?.length ? options.delaysMs : OWNER_BACKOFF_MS;
  for (let attempt = 0; !options.stop?.(); attempt++) {
    let result: RevokeResult = "retry";
    try { result = await client.revoke(token); } catch { /* network: retry */ }
    if (result !== "retry") return result;
    await sleep(delays[Math.min(attempt, delays.length - 1)]!);
  }
  return "stopped";
}
