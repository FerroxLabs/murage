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
export interface PhoneStatus { supported: boolean; keyPresent: boolean; active: { revision: number; settings: PhoneSettings } | null; olderScheduled: OlderScheduled[] }
export interface PhoneNumberInfo { id: string; number: string; canCallOut: boolean }
export interface PhoneCallCard {
  id: string;
  status: string;
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
    return { supported: body.supported, keyPresent: body.keyPresent === true, active: body.active ?? null, olderScheduled: Array.isArray(body.olderScheduled) ? body.olderScheduled : [] };
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

export async function recentCalls(call: PhoneApi): Promise<PhoneCallCard[]> {
  const body = await call(PHONE_ROUTE) as { calls?: PhoneCallCard[] } | null;
  return Array.isArray(body?.calls) ? body.calls : [];
}

export async function cancelScheduledCall(call: PhoneApi, id: string): Promise<void> {
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
    case "bad_settings": return "phoneCalls.error.badSettings";
    case "not_set_up": return "phoneCalls.error.notSetUp";
    default: return "phoneCalls.error.generic";
  }
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
