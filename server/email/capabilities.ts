// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The launch switch (design 2.0, F28): nothing about bot email shows, mounts or polls unless GET /v1/email/capabilities answers
// enabled: true for the saved account. The answer is cached per saved account, re-read on demand (boot, opening Settings) and after any
// 403 email_not_enabled or 503 capability_unavailable. 1.0.11: a 429 or 5xx keeps the last answer; only a 401 is a dead key. Price and limits are read from the response only; nothing here hard-codes them.
import type { Capabilities, FluxEmailClient } from "./flux-email-client.ts";
import { isKeyRejection } from "./key-health.ts";
import { eligibilityLine, fluxEmailAnswer, type FluxEmailAnswerKind } from "../../shared/email-copy.ts";

/** Why email is not on for the saved account, as the owner reads it on the Bot email card (1.0.11). */
export interface AccountEmailGate { kind: FluxEmailAnswerKind | "not_eligible"; line: string }

/** Codes that make the cached answer stale. */
export const CAPABILITY_REFRESH_CODES: ReadonlySet<string> = new Set(["email_not_enabled", "capability_unavailable"]);

export interface CapabilityProbeOptions {
  client: Pick<FluxEmailClient, "capabilities">;
  /** A stable, non-secret reference to the saved account (for example a fingerprint of its key); null when no account is saved. */
  accountRef: () => string | null;
  /** 1.0.11: an email:owner token is saved (the capability read can go on it when the account key has no email scope). */
  ownerKeySaved?: () => boolean;
  now?: () => number;
}

const OUTAGE_REREAD_MS = 30_000;

export class EmailCapabilityProbe {
  private readonly cache = new Map<string, { caps: Capabilities; readAt: number }>();
  /** Accounts whose last definite answer was a 401: Flux no longer accepts the saved account key (revoked or unknown). */
  private readonly keyRefused = new Set<string>();
  /** 1.0.11: the last definite refusal per account (a 403 scope, account or bot state); cleared by a readable answer. */
  private readonly refusals = new Map<string, { status: number; code: string }>();
  /** Accounts whose own key answered 403 email_scope_required (a valid key without email scope, e.g. a dashboard key). Sticky per key:
   *  the capability read then uses the email:owner token once the owner signs in (`useOwnerKey`). */
  private readonly scopeless = new Set<string>();
  private readonly inflight = new Map<string, Promise<Capabilities | null>>();
  private readonly listeners = new Set<(enabled: boolean) => void>();
  private readonly options: CapabilityProbeOptions;
  constructor(options: CapabilityProbeOptions) { this.options = options; }

  /** The cached answer for the saved account, if read. */
  current(): Capabilities | undefined {
    const account = this.options.accountRef();
    return account ? this.cache.get(account)?.caps : undefined;
  }

  /** True when Flux answered the saved account's last capability read with 401 (or 403 key_revoked/invalid_api_key): the key stopped working, so the owner signs in again.
   *  A later readable answer (or a different saved key, which is a different account ref) clears it. */
  accountKeyRefused(): boolean {
    const account = this.options.accountRef();
    return account ? this.keyRefused.has(account) : false;
  }

  /** True when the saved account key has no email scope: the capability read goes on the email:owner token, if one is saved. */
  useOwnerKey(): boolean {
    const account = this.options.accountRef();
    return account ? this.scopeless.has(account) : false;
  }

  /** Why email is not on, with the owner line; null when it is on, or nothing definite is known. Only a 401 is a dead key. */
  accountGate(): AccountEmailGate | null {
    const account = this.options.accountRef();
    if (!account || this.emailEnabled()) return null;
    if (this.keyRefused.has(account)) return { kind: "dead_key", line: fluxEmailAnswer(401, "unauthorized").line! };
    const refusal = this.refusals.get(account);
    if (refusal) { const answer = fluxEmailAnswer(refusal.status, refusal.code); return answer.line ? { kind: answer.kind, line: answer.line } : null; }
    const line = this.eligibilityReasonLine();
    return line ? { kind: "not_eligible", line } : null;
  }

  /** A 200 with eligible: false: the owner line for the reason Flux gave (also while an account already on keeps email in view). */
  eligibilityReasonLine(): string | null {
    const caps = this.current();
    return caps && caps.eligible === false ? eligibilityLine(typeof caps.reason === "string" ? caps.reason : null) : null;
  }

  /** True only when the saved account's last answer said enabled: true (r2.5: the platform flag) and passed the #33 checks (isEnabled). */
  emailEnabled(): boolean { return isEnabled(this.current()); }

  /** The price line and its surfaces, exactly as Flux gave them; undefined when absent. Desktop only (the caller checks the shell). */
  priceNote(): { note: string; surfaces: string[] } | undefined {
    const price = this.current()?.price;
    return typeof price?.display_note === "string" ? { note: price.display_note, surfaces: Array.isArray(price.display_surfaces) ? price.display_surfaces.filter((s): s is string => typeof s === "string") : [] } : undefined;
  }

  /** A limit from the response, or undefined (the caller then uses its fallback wording only, never a number of its own). */
  limit(name: string): number | undefined {
    const value = this.current()?.limits?.[name];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  onChange(listener: (enabled: boolean) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** Re-reads the answer. An unreadable answer is never enabled: true. */
  async refresh(): Promise<Capabilities | null> {
    const account = this.options.accountRef();
    if (!account) return null;
    const running = this.inflight.get(account);
    if (running) return running;
    const read = (async () => {
      const before = this.emailEnabled();
      // the read goes on the email:owner token when the account key has no email scope and the owner has signed in (runtime account())
      let viaOwner = this.scopeless.has(account) && this.options.ownerKeySaved?.() === true;
      let answer = await this.options.client.capabilities();
      // first scope 403 on this key (also after a restart) with an owner token saved: read again at once on that token
      if (!viaOwner && answer.kind === "refused" && answer.code === "email_scope_required" && this.options.ownerKeySaved?.() === true) {
        this.scopeless.add(account);
        viaOwner = true;
        answer = await this.options.client.capabilities();
      }
      // 1.0.11: a 429 or 5xx (503 capability_unavailable included) is transient: it changes nothing, like no answer at all
      const outcome = answer.kind === "refused" && fluxEmailAnswer(answer.status, answer.code).kind === "transient"
        ? { kind: "uncertain" as const, status: answer.status, reason: "server" as const } : answer;
      if (outcome.kind === "ok") { this.keyRefused.delete(account); this.refusals.delete(account); }
      // only a 401 means the key stopped working; a 403 is a scope, account or bot state, never a dead key
      else if (outcome.kind === "refused") {
        // a 401 on the email:owner token is that token's sign-in (Sign in with Flux to connect email), never the router key's
        if (viaOwner && outcome.status === 401) { this.keyRefused.delete(account); this.refusals.set(account, { status: 403, code: "email_scope_required" }); }
        else if (isKeyRejection(outcome.status, outcome.code)) { this.keyRefused.add(account); this.refusals.delete(account); }
        else { this.keyRefused.delete(account); this.refusals.set(account, { status: outcome.status, code: outcome.code }); }
        if (outcome.code === "email_scope_required") this.scopeless.add(account);
      }
      if (outcome.kind === "ok") this.cache.set(account, { caps: outcome.body, readAt: (this.options.now ?? Date.now)() });
      // a definite answer that is not a body (401, 403) turns email off; an uncertain one (no answer) keeps the last answer, so a network
      // blip never unmounts tools, and with no last answer nothing is enabled
      else if (outcome.kind !== "uncertain" || !this.cache.has(account)) this.cache.set(account, { caps: { enabled: false }, readAt: (this.options.now ?? Date.now)() });
      // a transient answer keeps the last answer but counts as the latest attempt, so the 30 s outage re-read gate holds
      else { const kept = this.cache.get(account)!; this.cache.set(account, { caps: kept.caps, readAt: (this.options.now ?? Date.now)() }); }
      const after = this.emailEnabled();
      if (before !== after) for (const listener of this.listeners) { try { listener(after); } catch { /* a listener never decides the probe */ } }
      return this.cache.get(account)?.caps ?? null;
    })();
    this.inflight.set(account, read);
    try { return await read; } finally { this.inflight.delete(account); }
  }

  /** Called with every refusal code a Flux email call returns; a launch-switch code re-reads the answer. */
  async noteRefusal(code: string): Promise<void> {
    if (!CAPABILITY_REFRESH_CODES.has(code)) return;
    // section 8: an outage answer re-reads at most every 30 s (a backoff's local answers never storm #31)
    const account = this.options.accountRef();
    const readAt = account ? this.cache.get(account)?.readAt : undefined;
    if (code === "capability_unavailable" && readAt !== undefined && (this.options.now ?? Date.now)() - readAt < OUTAGE_REREAD_MS) return;
    await this.refresh();
  }
}

/** Email lights up only with `enabled: true` (contract r2.5: #31/#33 carry the platform flag beside `available`/`eligible`), and only
 *  while #33 says `available: true` (a missing `available` is dark, Flux rule: show only when enabled && available). `eligible: false` keeps it dark for an account that has not turned email on (account_state "off" or
 *  absent); an account already on keeps its bots' addresses visible, so the owner still sees and manages them. */
export function isEnabled(caps: Capabilities | undefined | null): boolean {
  if (!caps || caps.enabled !== true || caps.available !== true) return false;
  if (caps.eligible === false && (caps.account_state === undefined || caps.account_state === "off")) return false;
  return true;
}
