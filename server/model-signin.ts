// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The server's view of plan sign-ins (ChatGPT, Grok).
//
// Tokens arrive from the desktop main process over the private
// utility-process port (electron/model-signin.mjs) and live here in memory
// only: never written to disk, never logged, never put in an engine's
// environment. Engines get a per-launch gateway key instead, which only the
// loopback model gateway (./model-gateway.ts) accepts. There is no refresh
// token here; the one refresher is in the main process.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SIGNIN_CONNECTION_IDS, SIGNIN_PRESETS, SIGNIN_PROVIDERS, signInProviderEnabled } from "../electron/model-signin-presets.mjs";
import type { ProviderConnectionRecord, SignInPreset } from "../shared/provider-connections.ts";
import type { SignInConnectionInfo } from "../shared/model-signin.ts";

const entrySchema = z.object({
  provider: z.enum(["chatgpt", "supergrok"]),
  connectionId: z.string().min(1).max(100),
  revision: z.string().min(1).max(100),
  state: z.enum(["connected", "needs-sign-in"]),
  accessToken: z.string().min(1).max(16384).regex(/^[^\s\x00-\x1f]+$/).optional(),
  accountId: z.string().max(200).regex(/^[^\r\n\x00]*$/).optional(),
  expiresAt: z.number().finite().nonnegative().optional(),
  email: z.string().max(320).optional(),
  plan: z.string().max(40).optional(),
}).strict();
const messageSchema = z.object({ type: z.literal("murage:model-signin"), entries: z.array(entrySchema).max(SIGNIN_PROVIDERS.length) }).strict();
type Entry = z.infer<typeof entrySchema>;

export interface ModelSignInsOptions {
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Ask the main process to refresh this provider's token. False when there
   * is no main process to ask (a development server). */
  requestRefresh?: (provider: SignInPreset) => boolean;
  /** Connection ids whose revision, state or presence changed. */
  onChange?: (ids: string[]) => void;
}

/** Backstop for a key whose turn never released it. */
const GATEWAY_KEY_IDLE_MS = 6 * 60 * 60 * 1000;

export function planLimitLine(provider: string, until: number | undefined): string {
  const plan = provider === "chatgpt" ? "ChatGPT" : "Grok";
  const when = until ? ` until ${new Date(until).toLocaleString()}` : "";
  return `Your ${plan} plan limit is reached. Work that uses it is paused${when}. Murage did not switch to another provider.`;
}

export function needsSignInLine(provider: string): string {
  return `Your ${provider === "chatgpt" ? "ChatGPT" : "Grok"} sign-in ended. Sign in again in Settings, Models.`;
}

export class ModelSignIns {
  private entries = new Map<SignInPreset, Entry>();
  /** gateway key -> the connection and sign-in revision it was issued for */
  private readonly keys = new Map<string, { id: string; revision: string; lastUsed: number }>();
  private readonly paused = new Map<string, number>();
  private readonly waiters = new Map<SignInPreset, Set<(ok: boolean) => void>>();
  private readonly options: ModelSignInsOptions;
  constructor(options: ModelSignInsOptions = {}) { this.options = options; }
  private now() { return this.options.now?.() ?? Date.now(); }
  private env() { return this.options.env ?? process.env; }

  /** Apply a main-process push. True when the message was ours (even if
   * rejected as malformed, it is then dropped and nothing changes). */
  apply(message: unknown): boolean {
    if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "murage:model-signin") return false;
    const parsed = messageSchema.safeParse(message);
    if (!parsed.success) { console.error("[model-signin] rejected a malformed sign-in update"); return true; }
    const next = new Map<SignInPreset, Entry>();
    for (const entry of parsed.data.entries) {
      if (entry.connectionId !== SIGNIN_CONNECTION_IDS[entry.provider] || next.has(entry.provider)) { console.error("[model-signin] rejected a malformed sign-in update"); return true; }
      next.set(entry.provider, entry);
    }
    const changed: string[] = [], refreshed: SignInPreset[] = [], ended: SignInPreset[] = [];
    for (const provider of SIGNIN_PROVIDERS) {
      const before = this.entries.get(provider), after = next.get(provider);
      if (before?.revision !== after?.revision || before?.state !== after?.state) changed.push(SIGNIN_CONNECTION_IDS[provider]);
      if (after?.accessToken && after.accessToken !== before?.accessToken) refreshed.push(provider);
      else if (!after?.accessToken || after.state !== "connected") ended.push(provider);
      // A new account or a sign-out ends any pause the old one hit.
      if (before?.revision !== after?.revision) this.paused.delete(SIGNIN_CONNECTION_IDS[provider]);
    }
    this.entries = next;
    for (const provider of refreshed) { for (const wake of this.waiters.get(provider) ?? []) wake(true); this.waiters.delete(provider); }
    for (const provider of ended) { for (const wake of this.waiters.get(provider) ?? []) wake(false); this.waiters.delete(provider); }
    if (changed.length) this.options.onChange?.(changed);
    return true;
  }

  private entryFor(id: string): Entry | undefined {
    const provider = SIGNIN_PROVIDERS.find(candidate => SIGNIN_CONNECTION_IDS[candidate] === id);
    if (!provider || !signInProviderEnabled(provider, this.env())) return undefined;
    return this.entries.get(provider);
  }

  /** Rows for the connection list. A connection whose flag is off vanishes. */
  records(): ProviderConnectionRecord[] {
    return SIGNIN_PROVIDERS.flatMap(provider => {
      const entry = this.entries.get(provider);
      if (!entry || !signInProviderEnabled(provider, this.env())) return [];
      return [{ id: entry.connectionId, preset: provider, label: SIGNIN_PRESETS[provider].label, enabled: entry.state === "connected" && Boolean(entry.accessToken), key: "", revision: entry.revision }];
    });
  }

  has(id: string): boolean { return Boolean(this.entryFor(id)); }

  info(id: string): SignInConnectionInfo | undefined {
    const entry = this.entryFor(id);
    if (!entry) return undefined;
    const pausedUntil = this.pausedUntil(id);
    return { provider: entry.provider, state: entry.state, unofficial: entry.provider === "supergrok",
      ...(entry.email ? { email: entry.email } : {}), ...(entry.plan ? { plan: entry.plan } : {}), ...(pausedUntil ? { pausedUntil } : {}) };
  }

  /** The live plan token for the gateway's upstream call. Never for engines. */
  bearer(id: string): { provider: SignInPreset; accessToken: string; accountId?: string; expiresAt?: number } | null {
    const entry = this.entryFor(id);
    if (!entry || entry.state !== "connected" || !entry.accessToken) return null;
    return { provider: entry.provider, accessToken: entry.accessToken, ...(entry.accountId ? { accountId: entry.accountId } : {}), ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}) };
  }

  /** A fresh key for one turn's engine: random, bound to this connection and
   * sign-in revision, revoked when the turn's route is released
   * (revokeGatewayKey), and dropped after a long idle spell as a backstop.
   * Useless off this machine and after a restart. */
  issueGatewayKey(id: string): string {
    const entry = this.entryFor(id);
    if (!entry) throw new Error("Plan sign-in is not available");
    this.sweep();
    const key = `murage-gw-${randomBytes(32).toString("hex")}`;
    this.keys.set(key, { id, revision: entry.revision, lastUsed: this.now() });
    return key;
  }

  revokeGatewayKey(key: string | undefined): void { if (key) this.keys.delete(key); }

  private sweep(): void {
    const cutoff = this.now() - GATEWAY_KEY_IDLE_MS;
    for (const [key, issued] of this.keys) if (issued.lastUsed < cutoff) this.keys.delete(key);
  }

  verifyGatewayKey(id: string, authorization: unknown): boolean {
    const entry = this.entryFor(id);
    const presented = /^Bearer (murage-gw-[a-f0-9]{64})$/.exec(String(authorization ?? ""))?.[1] ?? "";
    if (!entry || !presented) return false;
    // Constant-time over the key bytes; the map lookup itself is by an
    // unguessable 256-bit value.
    const issued = [...this.keys.entries()].find(([key]) => key.length === presented.length && timingSafeEqual(Buffer.from(key), Buffer.from(presented)))?.[1];
    if (!issued || issued.id !== id || issued.revision !== entry.revision) return false;
    if (issued.lastUsed < this.now() - GATEWAY_KEY_IDLE_MS) { this.keys.delete(presented); return false; }
    issued.lastUsed = this.now();
    return true;
  }

  pause(id: string, until: number): void { this.paused.set(id, until); }
  pausedUntil(id: string): number | undefined {
    const until = this.paused.get(id);
    if (until === undefined) return undefined;
    if (until <= this.now()) { this.paused.delete(id); return undefined; }
    return until;
  }

  /** Ask main for a new token and wait for one different from `stale`.
   * Resolves false on timeout or when no main process can refresh. */
  freshToken(provider: SignInPreset, stale: string, timeoutMs = 20_000): Promise<boolean> {
    const current = this.entries.get(provider);
    if (current?.accessToken && current.accessToken !== stale) return Promise.resolve(true);
    if (!this.options.requestRefresh?.(provider)) return Promise.resolve(false);
    return new Promise(resolve => {
      const set = this.waiters.get(provider) ?? new Set<(ok: boolean) => void>();
      const done = (value: boolean) => { clearTimeout(timer); set.delete(done); resolve(value); };
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      set.add(done); this.waiters.set(provider, set);
    });
  }
}
