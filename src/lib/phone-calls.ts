// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Phone calls (BOT-CALLS-1020 sections 1, 2, 3c, 4): the owner routes the screen calls, its words, and the
// "Share transcript with bot" hand-off to the composer. Imported only by components/PhoneCallsSettings.tsx, which loads behind
// `import()` from the Settings page, so none of this (the words included) rides the first paint (src/first-paint.test.ts).
//
// The words live in src/locales/lazy/phone-calls/ (8 languages, source-hashes.json), checked by `pnpm i18n:check` the same way
// as the main catalogue. The Vapi key never passes through here: the key box hands it straight to the desktop shell
// (window.muragebox.phoneKey), and every route below answers only whether a key is held.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import en from "@/locales/lazy/phone-calls/en.json";
import { languageCode, localeVersion, subscribeLocale } from "@/lib/i18n";
import { pasteAttachment } from "@/lib/composer-attachments";
import { appendComposerDraftAttachments } from "@/lib/drafts";
import { composerReferenceTarget, type ComposerReferenceTarget } from "@/lib/image-reference";
import type { Attachment } from "@/lib/composer-attachments";

export type PhoneCopyKey = keyof typeof en;
type PhonePack = Partial<Record<PhoneCopyKey, string>>;
export type PhoneCopy = (key: PhoneCopyKey, params?: Record<string, string | number>) => string;

const ptBr = () => import("@/locales/lazy/phone-calls/pt-br.json").then((pack) => pack.default as PhonePack);
/** Every language but English, each its own chunk, fetched when this screen opens in that language. */
export const PHONE_PACK_LOADERS: Record<string, () => Promise<PhonePack>> = {
  de: () => import("@/locales/lazy/phone-calls/de.json").then((pack) => pack.default as PhonePack),
  es: () => import("@/locales/lazy/phone-calls/es.json").then((pack) => pack.default as PhonePack),
  fr: () => import("@/locales/lazy/phone-calls/fr.json").then((pack) => pack.default as PhonePack),
  hi: () => import("@/locales/lazy/phone-calls/hi.json").then((pack) => pack.default as PhonePack),
  ja: () => import("@/locales/lazy/phone-calls/ja.json").then((pack) => pack.default as PhonePack),
  pt: ptBr,
  "pt-br": ptBr,
  zh: () => import("@/locales/lazy/phone-calls/zh.json").then((pack) => pack.default as PhonePack),
};

/** One string: the pack's, else English. A placeholder without a param stays as written, as `t()` does. */
export function phoneText(pack: PhonePack, key: PhoneCopyKey, params?: Record<string, string | number>): string {
  const template = pack[key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** The screen's words in the app language, following a language change. English shows while a pack loads or if it fails. */
export function usePhoneCopy(): PhoneCopy {
  const version = useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const code = languageCode();
  const [loaded, setLoaded] = useState<{ code: string; pack: PhonePack }>({ code: "en", pack: {} });
  useEffect(() => {
    let live = true;
    const load = Object.hasOwn(PHONE_PACK_LOADERS, code) ? PHONE_PACK_LOADERS[code] : undefined;
    if (!load) { setLoaded({ code, pack: {} }); return; }
    load().then((pack) => { if (live) setLoaded({ code, pack }); }, () => { if (live) setLoaded({ code, pack: {} }); });
    return () => { live = false; };
  }, [code, version]);
  const pack = loaded.code === code ? loaded.pack : {};
  return useCallback((key, params) => phoneText(pack, key, params), [pack]);
}

// ---- Owner routes (server/phone-calls/owner-routes.ts) ----

export const PHONE_ROUTE = "/api/phone-calls";
/** The 16 languages a call can be spoken in; the same list as server/phone-calls/tables.ts (a test pins them equal). */
export const CALL_LANGUAGES = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh", "it", "nl", "ko", "ru", "pl", "tr", "vi", "id"] as const;
export const APP_LANGUAGES = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"] as const;

export interface PhoneLine { on: boolean; edits: Record<string, string> }
export interface PhoneSettings {
  aiLine: PhoneLine;
  notice: PhoneLine;
  language: string;
  maxSeconds: number;
  voices: Record<string, string>;
  recordAudio: boolean;
  phoneNumberId: string;
  ownerName: string;
}
export interface OlderScheduled { id: string; revision: number; to: string; when?: string }
export interface PhoneStatus {
  supported: boolean;
  keyPresent: boolean;
  active: { revision: number; settings: PhoneSettings } | null;
  olderScheduled: OlderScheduled[];
  /** Whole-store count past the page; "500+" when it stops counting (F5 status, with or without a key). */
  olderScheduledCount?: number | "500+";
  /** The call settings upgrade at the vendor is pending: calls are paused (`phoneCalls.error.upgrade`). */
  paused?: boolean;
  /** The call history could not be opened (`phoneCalls.error.store`). */
  storeUnavailable?: boolean;
  /** The store holds calls (F5 status, store-derived; read keyless only when the db file exists). Absent = false: without a key
   *  and without it the page stays the compact connection entry (FABLE-DESIGN 2060 H1). */
  hasCalls?: boolean;
}
export interface PhoneNumberInfo { id: string; number: string; canCallOut: boolean }
/** The owner-visible state of one call, derived on the server and sent on every card (section 2 of the design). */
export type PhoneCallState = "checking" | "live" | "held" | "cancelling" | "settled";
export interface PhoneCallCard {
  id: string;
  status: string;
  /** Only the server decides it; the screen draws its controls from this and never from `status` or `held`. */
  state?: PhoneCallState;
  held?: "held" | "kept" | "cancelled";
  /** A held call may be Kept (no Keep is in flight and none was recorded). */
  canKeep?: boolean;
  bookingState?: "booked" | "cancelling" | "cancelled" | "unclear";
  /** Set only when the owner's wish was a language the voice account cannot speak (the call is in `language`). */
  languageFallback?: { wanted: string; language: string };
  outcome?: string;
  reason?: string;
  time?: string;
  length_seconds?: number;
  cost?: { amount: number; currency: string };
  language?: string;
  settings_revision?: number;
  to: string;
  goal?: string;
  when?: string;
  transcript?: string;
  reference?: string;
  dashboard: string;
}

export type PhoneApi = (path: string, init?: RequestInit) => Promise<unknown>;
const statusOf = (error: unknown) => (error as { status?: number } | null)?.status;
const codeOf = (error: unknown) => (error as { body?: { error?: unknown } } | null)?.body?.error;

/** The status route, or null where it is not answered (a browser, a phone, a build without the routes: 404). */
export async function readPhoneStatus(call: PhoneApi): Promise<PhoneStatus | null> {
  try {
    const body = await call(`${PHONE_ROUTE}/status`) as Partial<PhoneStatus> | null;
    if (!body || typeof body.supported !== "boolean") return null;
    const status: PhoneStatus = { supported: body.supported, keyPresent: body.keyPresent === true, active: body.active ?? null, olderScheduled: Array.isArray(body.olderScheduled) ? body.olderScheduled : [] };
    if (typeof body.olderScheduledCount === "number" || body.olderScheduledCount === "500+") status.olderScheduledCount = body.olderScheduledCount;
    if (body.paused === true) status.paused = true;
    if (body.storeUnavailable === true) status.storeUnavailable = true;
    if (body.hasCalls === true) status.hasCalls = true;
    return status;
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
}

/** Setup reads the owner's numbers. It never dials. */
export async function findNumbers(call: PhoneApi): Promise<PhoneNumberInfo[]> {
  const body = await call(`${PHONE_ROUTE}/setup`, { method: "POST", body: "{}" }) as { numbers?: PhoneNumberInfo[] } | null;
  return Array.isArray(body?.numbers) ? body.numbers : [];
}

export async function savePhoneSettings(call: PhoneApi, settings: PhoneSettings): Promise<number> {
  const body = await call(`${PHONE_ROUTE}/settings`, { method: "PUT", body: JSON.stringify(settings) }) as { revision?: number } | null;
  return typeof body?.revision === "number" ? body.revision : 0;
}

export async function recentCalls(call: PhoneApi, signal?: AbortSignal): Promise<PhoneCallCard[]> {
  const body = await call(PHONE_ROUTE, signal ? { signal } : undefined) as { calls?: PhoneCallCard[] } | null;
  return Array.isArray(body?.calls) ? body.calls : [];
}

/** The stop function of a watcher, which also carries `refreshNow`: one fresh list read, fenced like the periodic ones. */
export type RecentCallsWatch = (() => void) & { refreshNow(): void };

/** Refresh while Settings is mounted. One request at a time, at most once every five seconds.
 *  Every list read takes `++listEpoch` before it sends and delivers only while that is still the newest read, so an older
 *  answer can never bring back a row that a newer answer (or a Delete) removed. The fence covers list reads only: an action's
 *  own answer sets its row's line and then calls `refreshNow()`; the fresh list decides whether the row exists. */
export function watchRecentCalls(call: PhoneApi, onCalls: (calls: PhoneCallCard[]) => void, onError?: (error: unknown) => void): RecentCallsWatch {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loaded = false;
  let listEpoch = 0;
  let inFlight = 0;
  const schedule = () => { clearTimeout(timer); if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 5000); };
  const refresh = async () => {
    const mine = ++listEpoch;
    inFlight += 1;
    try {
      const calls = await recentCalls(call, controller.signal);
      if (!controller.signal.aborted && mine === listEpoch) { loaded = true; onCalls(calls); }
    } catch (error) {
      if (!controller.signal.aborted && mine === listEpoch) { if (!loaded) onCalls([]); onError?.(error); }
    } finally {
      inFlight -= 1;
      if (inFlight === 0) schedule();
    }
  };
  void refresh();
  const stop = (() => { controller.abort(); clearTimeout(timer); }) as RecentCallsWatch;
  stop.refreshNow = () => { if (!controller.signal.aborted) void refresh(); };
  return stop;
}

export async function cancelScheduledCall(call: PhoneApi, id: string): Promise<void> {
  await call(`${PHONE_ROUTE}/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
}

export interface PhoneBotRow { id: string; name: string; allowed: boolean }
export type PhoneRetention = 30 | 90 | null;
const PAGE = 200;

/** One page of the per-bot switch list. A bot deleted between pages answers 400 `bad_cursor`; the caller restarts from page 1. */
export async function listBots(call: PhoneApi, after?: string): Promise<{ bots: PhoneBotRow[]; next?: string }> {
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (after) query.set("after", after);
  const body = await call(`${PHONE_ROUTE}/bots?${query}`) as { bots?: PhoneBotRow[]; next?: unknown } | null;
  return { bots: Array.isArray(body?.bots) ? body.bots : [], ...(typeof body?.next === "string" ? { next: body.next } : {}) };
}

/** The switch shows the server's answer, never its own value. */
export async function setBotAllowed(call: PhoneApi, botId: string, on: boolean): Promise<boolean> {
  const body = await call(`${PHONE_ROUTE}/bots/${encodeURIComponent(botId)}`, { method: "PUT", body: JSON.stringify({ on }) }) as { allowed?: unknown } | null;
  return body?.allowed === true;
}

export async function deleteCall(call: PhoneApi, id: string): Promise<void> {
  await call(`${PHONE_ROUTE}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getRetention(call: PhoneApi): Promise<PhoneRetention> {
  const body = await call(`${PHONE_ROUTE}/retention`) as { days?: unknown } | null;
  return body?.days === 30 || body?.days === 90 ? body.days : null;
}

export async function setRetention(call: PhoneApi, days: PhoneRetention): Promise<PhoneRetention> {
  const body = await call(`${PHONE_ROUTE}/retention`, { method: "PUT", body: JSON.stringify({ days }) }) as { days?: unknown } | null;
  return body?.days === 30 || body?.days === 90 ? body.days : null;
}

export async function keepHeldCall(call: PhoneApi, id: string): Promise<void> {
  await call(`${PHONE_ROUTE}/${encodeURIComponent(id)}/keep`, { method: "POST", body: "{}" });
}

export async function cancelHeldCall(call: PhoneApi, id: string): Promise<void> {
  await call(`${PHONE_ROUTE}/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
}

/** Section 2 defaults: both lines on, Auto language, 5 minutes, audio recording off. */
export function defaultPhoneSettings(phoneNumberId: string, ownerName: string): PhoneSettings {
  return { aiLine: { on: true, edits: {} }, notice: { on: true, edits: {} }, language: "auto", maxSeconds: 300, voices: {}, recordAudio: false, phoneNumberId, ownerName };
}

/** The language an owner edit is stored against (section 3d): the app language, with both Portuguese codes on pt-br. */
export function editLanguage(code: string): string {
  const lower = code.toLowerCase();
  if (lower === "pt" || lower === "pt-br") return "pt-br";
  return (APP_LANGUAGES as readonly string[]).includes(lower) ? lower : "en";
}

/** The owner's own words for one line in one language; an empty box drops the edit, so the standard words are used. */
export function withLineWords(line: PhoneLine, language: string, words: string): PhoneLine {
  const edits = { ...line.edits };
  const trimmed = words.trim();
  if (trimmed) edits[language] = trimmed.slice(0, 300); else delete edits[language];
  return { ...line, edits };
}

/** Minutes in the form, seconds on the wire; the server takes 30 s to 60 min. */
export function minutesToSeconds(minutes: number): number {
  if (!Number.isFinite(minutes)) return 300;
  return Math.min(60, Math.max(1, Math.round(minutes))) * 60;
}

/** A failed owner route as one line of the screen's words. Vendor text never reaches the screen. */
export function phoneErrorKey(error: unknown): PhoneCopyKey {
  switch (codeOf(error)) {
    case "vendor_refused": return "phoneCalls.error.vendor";
    case "abandoned": return "phoneCalls.status.abandoned";
    case "not_confirmed": return "phoneCalls.error.notConfirmed";
    case "vendor_unreachable": case "vendor_unavailable": return "phoneCalls.error.unreachable";
    case "settings_pending": return "phoneCalls.error.pending";
    case "store_unavailable": return "phoneCalls.error.store";
    case "bad_settings": return "phoneCalls.error.badSettings";
    case "not_set_up": return "phoneCalls.error.notSetUp";
    default: return "phoneCalls.error.generic";
  }
}

/** The plain line for a result `reason` code of pack 5.9, or null for any other (free) reason. */
export function resultReasonKey(reason: string | undefined): PhoneCopyKey | null {
  switch (reason) {
    case "already_started": return "phoneCalls.result.alreadyStarted";
    case "phone_menu": return "phoneCalls.result.phoneMenu";
    case "unclear": return "phoneCalls.result.unclear";
    case "unpageable": return "phoneCalls.result.unpageable";
    default: return null;
  }
}

export type PhoneAction = "delete" | "cancel" | "keep" | "other";
/** What one refused owner action shows and does (design 3.1): an owner line or none, and whether the list is read again. */
export interface PhoneActionEffect { line: PhoneCopyKey | null; refresh: boolean; restartBots?: boolean }

/** Every answer to an owner action as its line and effect. Never vendor text; a 404 only re-reads, so no client code drops a row. */
export function phoneActionEffect(action: PhoneAction, error: unknown): PhoneActionEffect {
  const code = codeOf(error);
  const needKey = (error as { body?: { needKey?: unknown } } | null)?.body?.needKey === true;
  if (code === "bad_cursor") return { line: null, refresh: false, restartBots: true };
  if (statusOf(error) === 404 || code === "not_found") {
    return action === "keep" ? { line: "phoneCalls.error.notConfirmed", refresh: true } : { line: null, refresh: true };
  }
  if (code === "live" || code === "checking" || code === "cancel_pending") {
    if (needKey) return { line: "phoneCalls.delete.needKey", refresh: true };
    return { line: code === "live" ? "phoneCalls.delete.live" : code === "checking" ? "phoneCalls.delete.checking" : "phoneCalls.delete.cancelPending", refresh: true };
  }
  if (code === "not_confirmed") return { line: needKey ? "phoneCalls.delete.needKey" : "phoneCalls.error.notConfirmed", refresh: true };
  if (code === "cancelled") return { line: null, refresh: true };
  return { line: phoneErrorKey(error), refresh: false };
}

// ---- The key box (electron/main.mjs phone-key:save / phone-key:remove) ----

export interface PhoneKeyBridge {
  save(key: string): Promise<{ ok: true } | { ok: false; code?: string; message?: string }>;
  remove(): Promise<{ ok: true } | { ok: false; code?: string; message?: string }>;
}

export function phoneKeyBridge(): PhoneKeyBridge | undefined {
  return typeof window !== "undefined" ? window.muragebox?.phoneKey : undefined;
}

/** The shell's refusal as the screen's words; main.mjs sends English, the screen shows the owner's language. */
export function keyErrorKey(action: "save" | "remove", code: string | undefined): PhoneCopyKey {
  if (code === "bad_key") return "phoneCalls.key.bad";
  return action === "save" ? "phoneCalls.key.storeUnavailable" : "phoneCalls.key.removeFailed";
}

/** Phone calls run only in the desktop app: the shell holds the key, and the server says it runs under that shell. */
export function phoneCallsAvailable(status: PhoneStatus | null, bridge: PhoneKeyBridge | undefined): boolean {
  return Boolean(status?.supported && bridge);
}

// ---- "Share transcript with bot" (section 4) ----

export type ShareOutcome = { status: "added"; target: ComposerReferenceTarget } | { status: "no-chat" } | { status: "not-saved" } | { status: "none" };

/** The owner's choice: the server fences the transcript as said by the business, data only, and it joins the open chat's draft
 *  as a pasted attachment. Nothing is sent: the owner reads it there and presses Send. */
export async function shareTranscript(
  call: PhoneApi,
  id: string,
  target: ComposerReferenceTarget | undefined = composerReferenceTarget(),
  append: (draftId: string, attachments: Attachment[]) => Promise<boolean> = appendComposerDraftAttachments,
): Promise<ShareOutcome> {
  if (!target) return { status: "no-chat" };
  let body: { attachment?: { label?: string; text?: unknown } } | null;
  try {
    body = await call(`${PHONE_ROUTE}/${encodeURIComponent(id)}/share`, { method: "POST", body: "{}" }) as typeof body;
  } catch (error) {
    if (statusOf(error) === 404) return { status: "none" };
    throw error;
  }
  const text = body?.attachment?.text;
  if (typeof text !== "string" || !text) return { status: "none" };
  return (await append(target.draftId, [pasteAttachment(text)])) ? { status: "added", target } : { status: "not-saved" };
}

/** Only a Vapi dashboard link opens from a card. */
export function dashboardLink(card: Pick<PhoneCallCard, "dashboard">): string | null {
  return typeof card.dashboard === "string" && card.dashboard.startsWith("https://dashboard.vapi.ai/") ? card.dashboard : null;
}

export function lengthText(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function costText(cost: PhoneCallCard["cost"], locale: string): string | null {
  if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount)) return null;
  try { return new Intl.NumberFormat(locale, { style: "currency", currency: cost.currency || "USD", maximumFractionDigits: 2 }).format(cost.amount); }
  catch { return `${cost.amount.toFixed(2)} ${cost.currency}`; }
}

export function timeText(iso: string | undefined, locale: string): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  try { return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at); } catch { return iso; }
}
