// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The launch switch (design 2.0, F28): nothing about bot email shows, mounts or polls unless GET /v1/email/capabilities answers
// enabled: true for the saved account. The answer is cached per saved account, re-read on demand (boot, opening Settings) and after any
// 403 email_not_enabled or 503 capability_unavailable. Price and limits are read from the response only; nothing here hard-codes them.
//
// EMAIL-CAPS-CACHE-1011 (1.0.11 scope): only a DEFINITIVE answer changes the state, and the last one is kept on disk (caps-file.ts) for
// the saved key, so a launch or a network failure never hides email or turns it off. Definitive: a 200 whose body is a plain object with a
// boolean `enabled` (isEnabled decides), a 401 (dead key), a 402 (plan has no email), or a 403 whose code Flux documents (fluxEmailAnswer:
// scope, switch, account or bot state, with its owner line), all off. Everything else (an unknown 403, 404, other 4xx, 429, 5xx, timeout,
// no network, a bad body) changes nothing and is re-read on a backoff until a definitive answer lands. Only a 401 is a dead key. The owner
// line of a refusal lives in memory; the file holds the caps alone, so a restart shows the plain off state until the boot read lands.
// Account isolation is boot-time: the file is read at boot only when its fingerprint matches the saved key; any other file is dropped.
import type { Capabilities, FluxEmailClient } from "./flux-email-client.ts";
import { dropCapsFile, readCapsFile, writeCapsFile } from "./caps-file.ts";
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
  /** DATA_DIR/email-capabilities.json; without it the probe keeps memory only (as 1.0.10). */
  capsFile?: string;
  /** Called after every read of the current account lands (definitive or not), so the app can read the status again. */
  onRead?: () => void;
  log?: (line: string) => void;
}

const OUTAGE_REREAD_MS = 30_000;
/** After a read with no definitive answer the next waits 30 s, 60 s, 2 min, 4 min, then 5 min until one lands. */
export const PROBE_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000, 300_000];
const RETRY_AFTER_MAX_MS = 3_600_000;

type Entry = { caps: Capabilities; readAt: number };

/** A 200 body the state may be set from: a plain object carrying a boolean `enabled` (an array or `{}` is not one). */
export function isCapabilitiesBody(body: unknown): body is Capabilities {
  return Boolean(body) && typeof body === "object" && !Array.isArray(body) && typeof (body as { enabled?: unknown }).enabled === "boolean";
}

/** A refusal that says what the account is: a 401 or 402, or a 403 with a code Flux documents. An unknown 403 and every other status are
 *  no answer at all (EMAIL-CAPS-CACHE-1011 rule: only a definitive answer changes the state). */
export function isDefinitiveRefusal(status: number, code: string): boolean {
  const kind = fluxEmailAnswer(status, code).kind;
  if (kind === "transient") return false;
  return status === 401 || status === 402 || (status === 403 && kind !== "other");
}

export class EmailCapabilityProbe {
  private readonly cache = new Map<string, Entry>();
  /** Accounts whose last definite answer was a 401: Flux no longer accepts the saved account key (revoked or unknown). */
  private readonly keyRefused = new Set<string>();
  /** 1.0.11: the last definite refusal per account (a 403 scope, account or bot state); cleared by a readable answer. */
  private readonly refusals = new Map<string, { status: number; code: string }>();
  /** Accounts whose own key answered 403 email_scope_required (a valid key without email scope, e.g. a dashboard key). Sticky per key:
   *  the capability read then uses the email:owner token once the owner signs in (`useOwnerKey`). */
  private readonly scopeless = new Set<string>();
  private readonly inflight = new Map<string, { generation: number; read: Promise<Capabilities | null> }>();
  private readonly listeners = new Set<(enabled: boolean) => void>();
  /** Per account: when the last read that gave no definitive answer landed (the stale note and the outage throttle). */
  private readonly failedAt = new Map<string, number>();
  private readonly attemptAt = new Map<string, number>();
  /** Accounts with a definitive answer read in this process (not only from the file). */
  private readonly readThisSession = new Set<string>();
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by stop(): an answer that started before it writes nothing, tells no one and schedules nothing. */
  private generation = 0;
  private readonly options: CapabilityProbeOptions;
  constructor(options: CapabilityProbeOptions) { this.options = options; }

  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Boot: take the file's answer when it belongs to the saved key; a file for another key is dropped, never shown. Local only. */
  hydrate(): void {
    const path = this.options.capsFile;
    const account = this.options.accountRef();
    if (!path || !account) return;
    const entry = readCapsFile(path);
    if (!entry) return;
    if (entry.accountRef !== account) {
      dropCapsFile(path);
      this.options.log?.("[email] capability cache belonged to another Flux key; dropped, reading again");
      return;
    }
    if (!this.cache.has(account)) this.cache.set(account, { caps: entry.caps, readAt: entry.readAt });
  }

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

  /** A key is saved and no definitive answer is known for it yet: "Checking", never off. */
  checking(): boolean {
    const account = this.options.accountRef();
    return Boolean(account) && !this.cache.has(account!);
  }

  accountRef(): string | null { return this.options.accountRef(); }

  /** When the current account's last definitive answer was read. */
  readAt(): number | undefined {
    const account = this.options.accountRef();
    return account ? this.cache.get(account)?.readAt : undefined;
  }

  /** A read after the last definitive answer gave none (rule 5: show the last status with the note). */
  stale(): boolean {
    const account = this.options.accountRef();
    if (!account) return false;
    const failed = this.failedAt.get(account);
    const readAt = this.cache.get(account)?.readAt;
    return failed !== undefined && (readAt === undefined || failed >= readAt);
  }

  /** A definitive answer for the current account was read in this process (consent never rests on the file alone). */
  readInSession(): boolean {
    const account = this.options.accountRef();
    return Boolean(account) && this.readThisSession.has(account!);
  }

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

  /** Ends the re-read backoff; an answer already on its way is dropped when it lands. */
  stop(): void {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
  }

  /** Re-reads the answer. Only a definitive answer changes it (see the header); an unreadable answer is never enabled: true. */
  async refresh(): Promise<Capabilities | null> {
    const account = this.options.accountRef();
    if (!account) return null;
    const generation = this.generation;
    const running = this.inflight.get(account);
    if (running && running.generation === generation) return running.read;
    const read = (async () => {
      this.attemptAt.set(account, this.now());
      const dropped = () => {
        this.options.log?.("[email] stale capability answer dropped");
        return this.cache.get(account)?.caps ?? null;
      };
      // the read goes on the email:owner token when the account key has no email scope and the owner has signed in (runtime account())
      const viaOwner = this.scopeless.has(account) && this.options.ownerKeySaved?.() === true;
      const outcome = await this.options.client.capabilities();
      if (generation !== this.generation) return dropped();
      // first scope 403 on this key (also after a restart) with an owner token saved: this says nothing about the account yet. It keeps the
      // last answer and the next read, on the backoff, goes on that token: one request per read, so an answer always belongs to its key
      const ownerReadNext = !viaOwner && outcome.kind === "refused" && outcome.code === "email_scope_required" && this.options.ownerKeySaved?.() === true;
      if (ownerReadNext) this.scopeless.add(account);
      const before = this.emailEnabled();
      let definitive: Capabilities | null = null;
      if (outcome.kind === "ok" && outcome.status === 200 && isCapabilitiesBody(outcome.body)) {
        definitive = outcome.body;
        this.keyRefused.delete(account);
        this.refusals.delete(account);
      } else if (outcome.kind === "refused" && !ownerReadNext && isDefinitiveRefusal(outcome.status, outcome.code)) {
        definitive = { enabled: false };
        // a 401 on the email:owner token is that token's sign-in (Sign in with Flux to connect email), never the router key's
        if (viaOwner && outcome.status === 401) { this.keyRefused.delete(account); this.refusals.set(account, { status: 403, code: "email_scope_required" }); }
        // only a 401 means the key stopped working; a 403 is a scope, account or bot state, never a dead key
        else if (isKeyRejection(outcome.status, outcome.code)) { this.keyRefused.add(account); this.refusals.delete(account); }
        else { this.keyRefused.delete(account); this.refusals.set(account, { status: outcome.status, code: outcome.code }); }
        if (outcome.code === "email_scope_required") this.scopeless.add(account);
      }
      if (definitive) {
        const readAt = this.now();
        this.cache.set(account, { caps: definitive, readAt });
        this.failedAt.delete(account);
        this.readThisSession.add(account);
        if (this.options.accountRef() === account) {
          this.failures = 0;
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = null;
          if (this.options.capsFile) {
            try { writeCapsFile(this.options.capsFile, { accountRef: account, caps: definitive, readAt }); }
            catch (error) { this.options.log?.(`[email] capability cache not saved: ${(error as NodeJS.ErrnoException)?.code ?? "write failed"}`); }
          }
        }
      } else {
        this.failedAt.set(account, this.now());
        const status = "status" in outcome && outcome.status !== undefined ? String(outcome.status) : outcome.kind === "uncertain" ? outcome.reason : "none";
        this.options.log?.(`[email] capability read gave no definitive answer (${status}); keeping the last status`);
        if (this.options.accountRef() === account) this.scheduleRetry(outcome);
      }
      const after = this.emailEnabled();
      if (before !== after) for (const listener of this.listeners) { try { listener(after); } catch { /* a listener never decides the probe */ } }
      if (this.options.accountRef() === account) { try { this.options.onRead?.(); } catch { /* the app reads on its next open */ } }
      return this.cache.get(account)?.caps ?? null;
    })();
    this.inflight.set(account, { generation, read });
    try { return await read; } finally { if (this.inflight.get(account)?.read === read) this.inflight.delete(account); }
  }

  /** Starts a read unless one is running or a backoff re-read is already due, so a status read can never turn into a read loop. */
  ensureRead(): void {
    const account = this.options.accountRef();
    if (!account || this.retryTimer || this.inflight.has(account)) return;
    void this.refresh().catch(() => undefined);
  }

  private scheduleRetry(outcome: Awaited<ReturnType<FluxEmailClient["capabilities"]>>): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    let wait = PROBE_RETRY_MS[Math.min(this.failures, PROBE_RETRY_MS.length - 1)]!;
    this.failures++;
    // 503 capability_unavailable may name its own wait (retry_after_s); it is honoured, bounded to an hour
    if (outcome.kind === "refused" && outcome.status === 503) {
      const after = Number(outcome.error?.fields?.retry_after_s);
      if (Number.isFinite(after) && after > 0) wait = Math.min(after * 1000, RETRY_AFTER_MAX_MS);
    }
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.refresh().catch(() => undefined); }, wait);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  /** Called with every refusal code a Flux email call returns; a launch-switch code re-reads the answer. */
  async noteRefusal(code: string): Promise<void> {
    if (!CAPABILITY_REFRESH_CODES.has(code)) return;
    // section 8: an outage answer re-reads at most every 30 s (a backoff's local answers never storm #31)
    const account = this.options.accountRef();
    const last = account ? Math.max(this.cache.get(account)?.readAt ?? -Infinity, this.attemptAt.get(account) ?? -Infinity) : -Infinity;
    if (code === "capability_unavailable" && Number.isFinite(last) && this.now() - last < OUTAGE_REREAD_MS) return;
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
