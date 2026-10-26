// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The refusal table follows OpenMausBot server/key-rejections.ts (Apache-2.0), see NOTICE.
//
// What the engines last said about their sign-in or key, kept in memory only
// (a restart starts clean on purpose: nothing about a key is written down).
//
// Two kinds of mark, one change signal:
//  - A KEY mark, for engines that call a model server with an API key: the
//    base address plus a short fingerprint of the key (never the key). A
//    request refused as a bad key sets it; a later success, or saving or
//    clearing the key (a different fingerprint), ends it.
//  - An INSTANCE mark, for engines with their own login or their own key
//    handling (OpenCode, the ACP engines, Claude, Codex): set when a turn on
//    that engine fails with an authentication-class error, ended by the next
//    successful turn on it or after a short while, so a sign-in done in a
//    terminal heals without a restart.
import { createHash } from "node:crypto";

import { providerErrorFields } from "./drivers/provider-error-body.ts";
import type { ProviderSnapshot } from "./contracts.ts";

/** The line the engine shows while it is marked. */
export const KEY_REJECTED_REASON = "The provider did not accept this key. Change it in Settings or sign in again.";
/** The same line for an engine that signs in with a subscription login (Claude, Codex): there is no key to change. */
export const SIGN_IN_REJECTED_REASON = "This engine is not signed in. Sign in again in Settings.";
/** How long an instance mark lasts without a turn to clear it. */
export const INSTANCE_MARK_TTL_MS = 15 * 60_000;

// Codes a provider uses for a key that will never work again, and codes that
// mean "your key is fine, something else is wrong".
const KEY_CODES = /^(?:invalid_api_key|api_key_invalid|invalid_key|incorrect_api_key|expired_api_key|api_key_expired|api_key_revoked|revoked_api_key|invalid_token|token_expired|token_revoked|authentication_error|invalid_authentication|unauthorized|key_expired|key_revoked|account_deactivated)$/i;
const NOT_THE_KEY_CODES = /^(?:insufficient_quota|rate_limit_exceeded|rate_limited|billing_[a-z_]+|quota_exceeded|credit_[a-z_]+|insufficient_[a-z_]+|model_not_found|model_access_denied|permission_denied_model|context_length_exceeded)$/i;
const KEY_WORDS = /(?:invalid|incorrect|revoked|expired|deactivated|disabled|unrecognized|unauthori[sz]ed)\W+(?:\w+\W+){0,2}(?:api\W*)?(?:key|token|credential)|(?:api\W*)?(?:key|token)\W+(?:\w+\W+){0,2}(?:is\W+)?(?:invalid|incorrect|revoked|expired|not\W+valid)|authentication\W+(?:failed|error|required)|no\W+auth(?:entication)?\W+(?:credentials|provided)/i;
const NOT_THE_KEY_WORDS = /quota|billing|credits?\b|rate\W?limit|too many requests|insufficient\W+(?:funds|balance)|payment|model\W+(?:access|not found|does not exist)|(?:no|not)\W+(?:have\W+)?access\W+to\W+(?:the\W+)?model|context\W+length/i;

/** Does this refused request mean the KEY was rejected? A 401 does. A 400 or
 *  403 does only when its body says the key is invalid, revoked or expired;
 *  quota, billing, rate-limit and model-access refusals are not the key. The
 *  provider's own error code is read first; the words are the fallback. */
export function rejectsKey(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  const { code, type, message } = providerErrorFields(body);
  for (const c of [code, type]) {
    if (c && NOT_THE_KEY_CODES.test(c)) return false;
    if (c && KEY_CODES.test(c)) return true;
  }
  const text = message ?? body.slice(0, 500);
  if (NOT_THE_KEY_WORDS.test(text)) return false;
  return KEY_WORDS.test(text);
}

/** A turn's failure text from an engine with its own login. Text-level on
 *  purpose (never tool recognition), and as careful as rejectsKey about quota. */
export function looksLikeAuthFailure(message: string, options: { engineLevel?: boolean } = {}): boolean {
  const text = message.slice(0, 600);
  if (NOT_THE_KEY_WORDS.test(text)) return false;
  // An engine with its own login fails at the engine, not inside a tool: a tool's (MCP) error that mentions 401 is that tool's account, not this sign-in.
  if (options.engineLevel && /\bmcp\b|\btool\b/i.test(text)) return false;
  return KEY_WORDS.test(text)
    || /\b401\b|not\W+logged\W+in|please\W+(?:log|sign)\W*in|login\W+required|sign\W*in\W+(?:again|required|expired)|session\W+(?:expired|invalid)|token\W+(?:has\W+)?expired/i.test(text);
}

/** A mark that holds for the key wherever it is used: what the Settings "Test" button learns, which has no engine address. */
export const ANY_ADDRESS = "*";

const fingerprint = (key: string): string => createHash("sha256").update(key.trim()).digest("hex").slice(0, 32);
const keyMark = (scope: string, key: string): string => `${scope.replace(/\/+$/, "")} ${fingerprint(key)}`;

const rejectedKeys = new Set<string>();
const instanceMarks = new Map<string, number>();
const signInMarks = new Set<string>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a listener must not break the request that caused it */ }
  }
}

export function noteKeyRejected(scope: string, key: string): void {
  if (!key.trim()) return;
  const mark = keyMark(scope, key);
  if (rejectedKeys.has(mark)) return;
  rejectedKeys.add(mark);
  changed();
}

/** A request with this key went through: any earlier refusal of it is over. */
export function noteKeyAccepted(scope: string, key: string): void {
  if (!key.trim()) return;
  const cleared = rejectedKeys.delete(keyMark(scope, key));
  // A good answer for this key ends a refusal noted against it anywhere.
  const clearedAnywhere = rejectedKeys.delete(keyMark(ANY_ADDRESS, key));
  // A catalog refresh knows no engine address: it also ends a mark a refused turn set against this same key at any address.
  let clearedTurn = false;
  if (scope === ANY_ADDRESS) {
    const tail = ` ${fingerprint(key)}`;
    for (const mark of [...rejectedKeys]) if (mark.endsWith(tail) && rejectedKeys.delete(mark)) clearedTurn = true;
  }
  if (cleared || clearedAnywhere || clearedTurn) changed();
}

/** What a catalog refresh learned about this key. Only a 401 ("unauthorized") says the key is bad: a 403 is a provider that refuses /models but may still answer chat, so it neither marks nor clears the key. */
export function noteCatalogOutcome(key: string, outcome: "ok" | "refused", code?: "unauthorized" | "forbidden"): void {
  if (outcome === "ok") noteKeyAccepted(ANY_ADDRESS, key);
  else if (code !== "forbidden") noteKeyRejected(ANY_ADDRESS, key);
}

export function keyRejected(scope: string, key: string | null | undefined): boolean {
  return Boolean(key && key.trim() && (rejectedKeys.has(keyMark(scope, key)) || rejectedKeys.has(keyMark(ANY_ADDRESS, key))));
}

/** An engine with its own login failed a turn as an authentication error. */
export function noteInstanceAuthFailure(instanceId: string, now = Date.now(), options: { signIn?: boolean } = {}): void {
  if (options.signIn) signInMarks.add(instanceId);
  const fresh = !instanceMarks.has(instanceId);
  instanceMarks.set(instanceId, now);
  if (fresh) changed();
}

/** Saving a new key (or any change to an engine) ends its signed-out mark at once; a key that is still bad marks it again on its next refusal. */
export function forgetInstanceMark(instanceId: string): void {
  signInMarks.delete(instanceId);
  if (instanceMarks.delete(instanceId)) changed();
}

/** The whole fleet was rebuilt from the saved settings: no engine carries an old mark. */
export function forgetAllInstanceMarks(): void {
  if (instanceMarks.size === 0) return;
  instanceMarks.clear();
  signInMarks.clear();
  changed();
}

/** A turn on this engine finished well: it is signed in after all. */
export function noteInstanceTurnOk(instanceId: string): void {
  signInMarks.delete(instanceId);
  if (instanceMarks.delete(instanceId)) changed();
}

export function instanceAuthFailed(instanceId: string, now = Date.now()): boolean {
  const at = instanceMarks.get(instanceId);
  if (at === undefined) return false;
  if (now - at > INSTANCE_MARK_TTL_MS) { instanceMarks.delete(instanceId); signInMarks.delete(instanceId); return false; }
  return true;
}

/** A snapshot that says Ready is turned into signed-out while the engine is
 *  marked. An engine that is not available, or already signed out, is left as is. */
export function withInstanceMark(instanceId: string, snapshot: ProviderSnapshot, now = Date.now()): ProviderSnapshot {
  if (snapshot.state !== "available" || snapshot.authenticated === false || !instanceAuthFailed(instanceId, now)) return snapshot;
  return { ...snapshot, authenticated: false, reason: signInMarks.has(instanceId) ? SIGN_IN_REJECTED_REASON : KEY_REJECTED_REASON };
}

/** Notified when any mark starts or ends, so the app refreshes Settings and the picker. */
export function onKeyRejectionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests only. */
export function resetKeyRejectionsForTests(): void {
  rejectedKeys.clear();
  instanceMarks.clear();
  signInMarks.clear();
}
