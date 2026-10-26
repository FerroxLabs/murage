// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Murage news signup the Chief asks for on the first run (1.0.7).
//
// Design: docs/superpowers/specs/2026-10-26-firstrun-news-107-design.md.
//
// One small record says whether the ask happened and how it ended (asked,
// subscribed or skipped, with a time), so the Chief never asks twice. The
// address is held in that record ONLY while a delivery is still owed, and is
// deleted the moment it is sent, refused or given up on. Nothing else leaves
// the machine: the request carries the email, the name when there is one,
// `source: "app"` and `consentText`, the words the card showed when the
// address was given (src/lib/news-consent.ts). No device id, no install id,
// no analytics.
//
// The post is made here, in the server process, never by the renderer, and
// the app ships no key: the endpoint is public and does its own checks.
//
// Single opt-in (Sean, 10-26): the site adds the contact at once and sends
// the getting set up guide. Any 2xx is success, whatever its body says.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { NEWS_CONSENT_MAX, newsConsentText, newsSignupFrom } from "../src/lib/news-consent.ts";

export const NEWS_FILE = "news-signup.json";
export const DEFAULT_NEWS_BASE_URL = "https://murage.ai";
export const NEWS_SUBSCRIBE_PATH = "/api/news/subscribe";

export type NewsStatus = "asked" | "subscribed" | "skipped";
export type NewsDeliveryState = "pending" | "sent" | "refused" | "expired";

export interface NewsDelivery {
  state: NewsDeliveryState;
  attempts: number;
  nextAt?: number;
  lastStatus?: number;
  /** Present only while `state` is "pending". */
  email?: string;
  name?: string;
  /** The wording the card showed, kept with the address it goes with. */
  consentText?: string;
}

export interface NewsRecord {
  version: 1;
  status: NewsStatus;
  at: number;
  delivery?: NewsDelivery;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The waits after each failed try; the last one repeats. */
export const NEWS_BACKOFF_MS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 12 * HOUR] as const;
/** A delivery still failing this long after the address was given is dropped. */
export const NEWS_GIVE_UP_MS = 14 * 24 * HOUR;
const RETRY_AFTER_MIN_MS = MINUTE;
const RETRY_AFTER_MAX_MS = 24 * HOUR;
const REQUEST_TIMEOUT_MS = 15_000;

/** Is this process the harness Electron embeds? `process.parentPort` exists
 *  only in an Electron utilityProcess child (electron/main.mjs forks the
 *  packaged harness that way). */
function embeddedInDesktopApp(env: NodeJS.ProcessEnv): boolean {
  return (process as NodeJS.Process & { parentPort?: unknown }).parentPort !== undefined
    || env.MURAGE_DESKTOP_PARENT === "1";
}

/** An exact origin: https, or http on loopback for a local copy of the site. */
function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    return "";
  }
  return url.origin;
}

/**
 * Where the signup is posted, or null when this build posts nowhere.
 *
 * A packaged desktop app (every download, GitHub included) uses murage.ai and
 * nothing else: an environment variable inherited by the packaged harness can
 * never send an owner's address to another host. A dev run and a test post
 * nowhere unless MURAGE_NEWS_URL names an exact origin (a local copy of the
 * site), so a fixture address never lands on the real list. An override that
 * is set but unusable disables the post rather than falling back to the list.
 */
export function newsBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (embeddedInDesktopApp(env)) return DEFAULT_NEWS_BASE_URL;
  const override = (env.MURAGE_NEWS_URL ?? "").trim();
  return override ? normalizeBaseUrl(override) || null : null;
}

/** A trimmed, lower-cased address, or "" when it is not one. */
export function normalizeNewsEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= EMAIL_MAX && EMAIL.test(email) ? email : "";
}

function normalizeName(value: unknown): string | undefined {
  // control characters become spaces (a name is one line of text)
  const name = typeof value === "string" ? [...value].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").trim().slice(0, NAME_MAX) : "";
  return name || undefined;
}

function parseRecord(raw: unknown): NewsRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !["asked", "subscribed", "skipped"].includes(String(r.status)) || typeof r.at !== "number") return null;
  const record: NewsRecord = { version: 1, status: r.status as NewsStatus, at: r.at };
  const d = r.delivery as Record<string, unknown> | undefined;
  if (d && typeof d === "object" && ["pending", "sent", "refused", "expired"].includes(String(d.state))) {
    const delivery: NewsDelivery = { state: d.state as NewsDeliveryState, attempts: typeof d.attempts === "number" ? d.attempts : 0 };
    if (typeof d.nextAt === "number") delivery.nextAt = d.nextAt;
    if (typeof d.lastStatus === "number") delivery.lastStatus = d.lastStatus;
    if (delivery.state === "pending") {
      const email = normalizeNewsEmail(d.email);
      if (!email) return { ...record, delivery: { state: "refused", attempts: delivery.attempts } };
      delivery.email = email;
      const name = normalizeName(d.name);
      if (name) delivery.name = name;
      // A record from before the wording was kept came from the hello card.
      delivery.consentText = typeof d.consentText === "string" && d.consentText.trim()
        ? d.consentText.slice(0, NEWS_CONSENT_MAX)
        : newsConsentText("hello");
    }
    record.delivery = delivery;
  }
  return record;
}

/** Retry-After as a delay: delta-seconds or an HTTP date, clamped. */
function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}

export interface NewsSignupOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Timers, swappable so a test drives the queue without waiting. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class NewsSignup {
  private readonly path: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: NewsSignupOptions = {}) {
    this.path = join(options.dir ?? DATA_DIR, NEWS_FILE);
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The record, or null when nothing was ever asked. An unreadable file reads as none. */
  read(): NewsRecord | null {
    try {
      return parseRecord(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return null;
    }
  }

  /**
   * What the renderer may see: the outcome, its time and whether the address
   * is on the list, never the address itself. `onList` is true only once the
   * site took it, or while it is still on its way; a refused or abandoned
   * delivery is NOT on the list, so Settings offers the form again.
   */
  view(): { status: NewsStatus | null; at: number | null; onList: boolean } {
    const record = this.read();
    const state = record?.delivery?.state;
    return { status: record?.status ?? null, at: record?.at ?? null, onList: record?.status === "subscribed" && (state === "sent" || state === "pending") };
  }

  private write(record: NewsRecord): void {
    writeFileAtomic(this.path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  }

  /** The hello card was put in front of the owner. Written once; never over an outcome. */
  markAsked(): void {
    if (this.read()) return;
    try { this.write({ version: 1, status: "asked", at: this.now() }); } catch { /* the record is the nice half */ }
  }

  /** They passed. Never undoes a subscription. */
  markSkipped(): void {
    const record = this.read();
    if (record?.status === "subscribed" || record?.status === "skipped") return;
    try { this.write({ version: 1, status: "skipped", at: this.now() }); } catch { /* as above */ }
  }

  /**
   * They gave an address: record it as subscribed and owe one delivery.
   * Returns at once; the post happens in the background and retries quietly.
   */
  subscribe(emailInput: unknown, nameInput?: unknown, fromInput?: unknown): { ok: boolean; reason?: "invalid-email" } {
    const email = normalizeNewsEmail(emailInput);
    if (!email) return { ok: false, reason: "invalid-email" };
    const name = normalizeName(nameInput);
    const now = this.now();
    // The renderer says only which card it was; the words come from the
    // shared copy, so a renderer can never put other words in the person's mouth.
    const consentText = newsConsentText(newsSignupFrom(fromInput));
    const delivery: NewsDelivery = { state: "pending", attempts: 0, nextAt: now, email, consentText };
    if (name) delivery.name = name;
    this.write({ version: 1, status: "subscribed", at: now, delivery });
    this.schedule(0);
    return { ok: true };
  }

  /** At server start: pick up a delivery an earlier run still owed. */
  start(): void {
    const delivery = this.read()?.delivery;
    if (delivery?.state !== "pending") return;
    this.schedule(Math.max(0, (delivery.nextAt ?? 0) - this.now()));
  }

  stop(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.stop();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.deliver();
    }, ms);
  }

  /** One try at the owed delivery. Never throws. Exposed for tests. */
  deliver(): Promise<void> {
    this.inFlight ??= this.tryOnce().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async tryOnce(): Promise<void> {
    const record = this.read();
    const delivery = record?.delivery;
    if (!record || delivery?.state !== "pending" || !delivery.email) return;
    const base = newsBaseUrl(this.env);
    // A build that posts nowhere (a dev run, a test, a Cloud home) never holds
    // an address it cannot send: the delivery is closed and the address dropped.
    if (!base) {
      this.finish(record, "expired", delivery.attempts, delivery.lastStatus);
      return;
    }
    const now = this.now();
    if (now - record.at > NEWS_GIVE_UP_MS) {
      this.finish(record, "expired", delivery.attempts, delivery.lastStatus);
      return;
    }
    const consentText = delivery.consentText ?? newsConsentText("hello");
    const body = JSON.stringify(delivery.name
      ? { email: delivery.email, name: delivery.name, source: "app", consentText }
      : { email: delivery.email, source: "app", consentText });
    let status: number | undefined;
    let retryAfter: number | null = null;
    try {
      const res = await this.fetchImpl(`${base}${NEWS_SUBSCRIBE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // never replay the address to wherever a redirect points
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      retryAfter = retryAfterMs(res.headers?.get?.("retry-after") ?? null, now);
    } catch {
      // offline, refused, timed out: try again later
    }
    const attempts = delivery.attempts + 1;
    // The record may have moved on while the post was out (a second address
    // typed in Settings). Only the delivery that was tried is settled.
    const current = this.read();
    if (!current?.delivery || current.delivery.state !== "pending" || current.delivery.email !== delivery.email || current.at !== record.at) {
      if (current?.delivery?.state === "pending") this.start();
      return;
    }
    if (status !== undefined && status >= 200 && status < 300) {
      this.finish(current, "sent", attempts, status);
      return;
    }
    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      this.finish(current, "refused", attempts, status);
      return;
    }
    const wait = retryAfter ?? NEWS_BACKOFF_MS[Math.min(attempts - 1, NEWS_BACKOFF_MS.length - 1)];
    const next: NewsDelivery = { ...current.delivery, attempts, nextAt: now + wait };
    if (status !== undefined) next.lastStatus = status;
    try {
      this.write({ ...current, delivery: next });
    } catch {
      // could not save the retry; try again on the next start
      return;
    }
    this.schedule(wait);
  }

  /** Settle the delivery and drop the address from disk. */
  private finish(record: NewsRecord, state: Exclude<NewsDeliveryState, "pending">, attempts: number, lastStatus?: number): void {
    const delivery: NewsDelivery = { state, attempts };
    if (lastStatus !== undefined) delivery.lastStatus = lastStatus;
    try { this.write({ ...record, delivery }); } catch { /* retried at next start, which re-reads the record */ }
  }
}
