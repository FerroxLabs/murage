// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How the WhatsApp auth key reaches the bridge (design 3.3). The key lives in the OS-encrypted credential
// document owned by Electron main; the server asks for it over the private utility parent port the first time
// a link is requested and again on every bridge spawn, and hands it to the bridge in `init` over IPC.
// This file defines the interface the service depends on and the parent-port client; W5 wires the real
// store (main.mjs answers, index.ts passes `process.parentPort`). Nothing here creates a key.

export const AUTH_KEY_REQUEST = "murage:whatsapp-auth-key-request";
export const AUTH_KEY_REPLY = "murage:whatsapp-auth-key";

/** Why the key could not be produced. Both are `blocked` link states with their own copy (design 2.1). */
export type AuthKeyFailure = "credential-store" | "key-missing";

export class AuthKeyUnavailable extends Error {
  readonly reason: AuthKeyFailure;
  constructor(reason: AuthKeyFailure) {
    super(reason);
    this.name = "AuthKeyUnavailable";
    this.reason = reason;
  }
}

/** What the service needs from the credential store. Implementations fail closed: they throw rather than invent a key. */
export interface AuthKeyProvider {
  /** The 64 character hex key. Called on every bridge spawn. */
  get(): Promise<string>;
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/** A key is exactly 32 bytes of hex. Anything else is refused, never repaired. */
export function validAuthKey(value: unknown): value is string {
  return typeof value === "string" && HEX_KEY.test(value);
}

/** Wraps a provider so a malformed answer is an `AuthKeyUnavailable`, and so the service can tell why a spawn failed. */
export function checkedProvider(provider: AuthKeyProvider): () => Promise<string> {
  return async () => {
    let key: unknown;
    try { key = await provider.get(); } catch (error) {
      throw error instanceof AuthKeyUnavailable ? error : new AuthKeyUnavailable("credential-store");
    }
    if (!validAuthKey(key)) throw new AuthKeyUnavailable("credential-store");
    return key;
  };
}

/** The slice of Electron's utility parent port this client uses. */
export interface KeyPort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  postMessage(message: object): void;
}

/**
 * Parent-port client. One request is in flight at a time; the reply is matched by type. A missing or late reply
 * fails closed with `credential-store` (main answers `key: null` when the store is unavailable).
 */
export function parentPortKeyProvider(port: KeyPort, options: { timeoutMs?: number } = {}): AuthKeyProvider {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const waiting: Array<(key: unknown) => void> = [];
  port.on("message", (event) => {
    const data = event.data as { type?: unknown; key?: unknown } | undefined;
    if (!data || data.type !== AUTH_KEY_REPLY) return;
    const next = waiting.shift();
    next?.(data.key);
  });
  let inflight: Promise<string> | undefined;
  return {
    get() {
      inflight ??= new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const at = waiting.indexOf(settle);
          if (at >= 0) waiting.splice(at, 1);
          reject(new AuthKeyUnavailable("credential-store"));
        }, timeoutMs);
        timer.unref?.();
        function settle(key: unknown): void {
          clearTimeout(timer);
          if (validAuthKey(key)) resolve(key); else reject(new AuthKeyUnavailable("credential-store"));
        }
        waiting.push(settle);
        port.postMessage({ type: AUTH_KEY_REQUEST });
      }).finally(() => { inflight = undefined; });
      return inflight;
    },
  };
}
