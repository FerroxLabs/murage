// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The launch switch (design 2.0, F28): nothing about bot email shows, mounts or polls unless GET /v1/email/capabilities answers
// enabled: true for the saved account. The answer is cached per saved account, re-read on demand (boot, opening Settings) and after any
// 403 email_not_enabled or 503 capability_unavailable. Price and limits are read from the response only; nothing here hard-codes them.
import type { Capabilities, FluxEmailClient } from "./flux-email-client.ts";

/** Codes that make the cached answer stale. */
export const CAPABILITY_REFRESH_CODES: ReadonlySet<string> = new Set(["email_not_enabled", "capability_unavailable"]);

export interface CapabilityProbeOptions {
  client: Pick<FluxEmailClient, "capabilities">;
  /** A stable, non-secret reference to the saved account (for example a fingerprint of its key); null when no account is saved. */
  accountRef: () => string | null;
  now?: () => number;
}

const OUTAGE_REREAD_MS = 30_000;

export class EmailCapabilityProbe {
  private readonly cache = new Map<string, { caps: Capabilities; readAt: number }>();
  private readonly inflight = new Map<string, Promise<Capabilities | null>>();
  private readonly listeners = new Set<(enabled: boolean) => void>();
  private readonly options: CapabilityProbeOptions;
  constructor(options: CapabilityProbeOptions) { this.options = options; }

  /** The cached answer for the saved account, if read. */
  current(): Capabilities | undefined {
    const account = this.options.accountRef();
    return account ? this.cache.get(account)?.caps : undefined;
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
      const outcome = await this.options.client.capabilities();
      if (outcome.kind === "ok") this.cache.set(account, { caps: outcome.body, readAt: (this.options.now ?? Date.now)() });
      // a definite answer that is not a body (401, 403) turns email off; an uncertain one (no answer) keeps the last answer, so a network
      // blip never unmounts tools, and with no last answer nothing is enabled
      else if (outcome.kind !== "uncertain" || !this.cache.has(account)) this.cache.set(account, { caps: { enabled: false }, readAt: (this.options.now ?? Date.now)() });
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
