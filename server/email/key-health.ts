// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Credential health per email credential (BOT-EMAIL-MURAGE-109 section 8, Astra 12). flux-key-health.ts tracks only the catalog key; email
// keeps its own record for each bot's email:bot key and for the email:owner token, and tells apart:
//   rejected      401, key_expired, key_revoked, invalid_api_key, unauthorized, and email_scope_required on a bot key:
//                 "Email is not reachable: Flux did not accept the saved key." A rejected bot key unmounts that bot's tools (G15) until
//                 the key changes (Reconnect rotates it, 2.3);
//   scope         403 email_scope_required on the owner token: a valid key without email scope (1.0.11); signing in mints email:owner;
//   email_off     403 email_not_enabled;
//   not_eligible  402 premium_locked;
//   paused        403 bot_paused, account_email_paused: a pause, never a key problem (the key stays good);
//   outage        503 capability_unavailable or a 5xx with no body: calls on that credential wait, 2 s doubling to a 5 minute ceiling. The
//                 owner sees no state change for it (1.0.11: transient answers have no line).
// 1.0.11 (verified against the Flux proxy): only a 401 is a dead key. A 403 is never one: it is a scope, account or bot state.
// A record belongs to the key id it was made with: once the stored key changes (rotation, a new owner sign-in) the old record no longer
// applies. Memory only; a restart starts clean and the first answer sets it again.
import type { CredentialRef, FluxOutcome } from "./flux-email-client.ts";
import { EMAIL_KEY_HEALTH_COPY, fluxEmailAnswer } from "../../shared/email-copy.ts";

export type KeyHealthState = "ok" | "rejected" | "scope" | "email_off" | "not_eligible" | "paused" | "outage";
export interface KeyHealthRecord { state: KeyHealthState; keyId: string | null; code: string | null; since: number; failures: number; retryAt: number | null }

/** Section 8 owner lines (shared/email-copy.ts EMAIL_KEY_HEALTH_COPY). */
export const KEY_HEALTH_LINES: Record<Exclude<KeyHealthState, "ok">, string> = EMAIL_KEY_HEALTH_COPY;

const REJECTED_CODES: ReadonlySet<string> = new Set(["key_expired", "key_revoked", "invalid_api_key", "unauthorized", "invalid_key", "http_401"]);
/** Flux did not accept the key itself: any 401 (or a non-403 refusal carrying a key-rejection code). A 403 is never a dead key: Flux
 *  answers 403 for a key without email scope, email turned off, or an account or bot state (1.0.11, verified against the Flux proxy). */
export function isKeyRejection(status: number, code: string): boolean { return status === 401 || (status !== 403 && REJECTED_CODES.has(code)); }
const PAUSE_CODES: ReadonlySet<string> = new Set(["bot_paused", "account_email_paused"]);
export const KEY_BACKOFF_BASE_MS = 2_000;
export const KEY_BACKOFF_CEILING_MS = 300_000;

/** "owner" or "bot:<id>"; null for the account key (the capability probe's) and a rotation candidate. */
export function healthKey(ref: CredentialRef): string | null {
  return ref.kind === "owner" ? "owner" : ref.kind === "bot" ? `bot:${ref.botId}` : null;
}

/** What one answer says about the credential that made it; null = nothing (a recipient refusal, a lost answer). */
export function classifyKeyHealth(ref: CredentialRef, outcome: FluxOutcome<unknown>): Exclude<KeyHealthState, "ok"> | "ok" | null {
  if (outcome.kind === "ok" || outcome.kind === "held") return "ok";
  if (outcome.kind === "uncertain") return outcome.reason === "server" && (outcome.status ?? 0) >= 500 ? "outage" : null;
  const { code, status } = outcome;
  if (isKeyRejection(status, code)) return "rejected";
  // a bot key without email scope cannot send: its tools stay off until Reconnect gives it a new key (G15); the owner token signs in
  if (code === "email_scope_required") return ref.kind === "bot" ? "rejected" : "scope";
  if (fluxEmailAnswer(status, code).kind === "transient") return code === "capability_unavailable" || status >= 500 ? "outage" : null;
  if (code === "email_not_enabled") return "email_off";
  if (code === "premium_locked") return "not_eligible";
  if (PAUSE_CODES.has(code)) return "paused";
  return null;
}

export class EmailKeyHealth {
  private readonly records = new Map<string, KeyHealthRecord>();
  /** Outages seen while a definite state stays on screen (1.0.11), for the backoff only. */
  private readonly outages = new Map<string, number>();
  private readonly now: () => number;
  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  /** Every answer on an owner or bot credential passes here (FluxEmailClient `observe`). */
  observe(ref: CredentialRef, outcome: FluxOutcome<unknown>): void {
    const key = healthKey(ref);
    if (!key) return;
    const verdict = classifyKeyHealth(ref, outcome);
    if (!verdict) return;
    const keyId = "keyId" in outcome && typeof outcome.keyId === "string" ? outcome.keyId : null;
    if (verdict === "ok") { this.records.delete(key); this.outages.delete(key); return; }
    const before = this.records.get(key);
    // 1.0.11: a transient answer never changes what the owner sees: a definite state on the same key (rejected, scope, off, plan,
    // paused) stays, and G15 keeps the tools off until the key changes or Flux answers ok
    // (the backoff still runs beside it: retryAt doubles from the outage count, so gate() answers locally while it waits)
    if (verdict === "outage" && before && before.state !== "outage" && before.keyId === keyId) {
      const outages = (this.outages.get(key) ?? 0) + 1;
      this.outages.set(key, outages);
      this.records.set(key, { ...before, retryAt: this.now() + Math.min(KEY_BACKOFF_BASE_MS * 2 ** (outages - 1), KEY_BACKOFF_CEILING_MS) });
      return;
    }
    this.outages.delete(key);
    const failures = before && before.state === verdict && before.keyId === keyId ? before.failures + 1 : 1;
    const at = this.now();
    this.records.set(key, {
      state: verdict, keyId, code: outcome.kind === "refused" ? outcome.code : null, since: before?.state === verdict ? before.since : at, failures,
      retryAt: verdict === "outage" ? at + Math.min(KEY_BACKOFF_BASE_MS * 2 ** (failures - 1), KEY_BACKOFF_CEILING_MS) : null,
    });
  }

  /** The record for a credential, if it applies to the key id stored now (a changed key starts clean). */
  record(key: string, currentKeyId: string | null | undefined): KeyHealthRecord | null {
    const record = this.records.get(key);
    if (!record) return null;
    if (record.keyId && currentKeyId && record.keyId !== currentKeyId) { this.records.delete(key); return null; }
    return { ...record };
  }

  /** G15: the bot's own email key was refused by Flux (its tools do not mount until the key changes). */
  rejected(botId: string, currentKeyId: string | null | undefined): boolean { return this.record(`bot:${botId}`, currentKeyId)?.state === "rejected"; }

  /** The owner-facing line for a credential, or null when nothing is wrong. */
  line(key: string, currentKeyId: string | null | undefined): string | null {
    const record = this.record(key, currentKeyId);
    // a transient outage changes nothing on screen (the backoff still runs underneath)
    return record && record.state !== "outage" ? KEY_HEALTH_LINES[record.state as Exclude<KeyHealthState, "ok">] ?? null : null;
  }

  /** While an outage backoff runs, the answer to give instead of calling Flux (a definite "not now": nothing was sent). */
  gate(ref: CredentialRef): FluxOutcome<never> | null {
    const key = healthKey(ref);
    const record = key ? this.records.get(key) : undefined;
    if (!record || record.retryAt === null || this.now() >= record.retryAt) return null;
    return { kind: "refused", status: 503, code: "capability_unavailable", message: "", error: { error: "capability_unavailable", message: "", fields: { backoff: true } }, keyId: record.keyId ?? "" };
  }
}
