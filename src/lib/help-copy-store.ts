// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The help panel's words, per language (L-COPY r3, design section 5).
//
// Help copy is its own partition: English in src/locales/en-help/*.json
// (help-screen-copy.ts), every other language in src/locales/help/<code>.json,
// each its own chunk behind import(). Only the help chunk imports this module
// (src/first-paint.test.ts fails if the boot graph reaches it), so a closed
// help panel never fetches a Help pack, and a language change with help
// closed fetches nothing.
//
// The contract: Help never shows a language other than the rest of the app.
// It follows the active main locale (languageCode(), canonicalised: "pt" reads
// pt-br). In English it reads enHelp. In any other language it reads only that
// language's Help pack once it is ready; until then hx() answers the main
// pack's "Opening help." line, never English Help. Each language has its own
// state and attempt id, so a slow load for one language can never write into
// another, and a failed load can be tried again. Nothing is ever merged into
// the English pack or the active main pack.
import { useSyncExternalStore } from "react";
import { languageCode, subscribeLocale, t } from "@/lib/i18n";
import { en, type LocaleKey } from "@/locales";
import { enHelp } from "./help-screen-copy";

export { enHelp };
export type { HelpKey } from "./help-screen-copy";

export type HelpPack = Readonly<Record<string, string>>;
export const HELP_CODES = ["de", "es", "fr", "hi", "ja", "pt-br", "zh"] as const;
export type HelpCode = (typeof HELP_CODES)[number];
export type HelpStatus = "loading" | "ready" | "failed";

/** "pt" reads the pt-BR packs; every other code is itself. */
export function canonicalCode(code: string): string {
  const lower = code.trim().toLowerCase();
  return lower === "pt" ? "pt-br" : lower;
}

const isHelpCode = (code: string): code is HelpCode => (HELP_CODES as readonly string[]).includes(code);

/** Is this key one of the Help partition's (en-help/*.json)? */
export function isHelpKey(key: string): boolean {
  return Object.hasOwn(enHelp, key);
}

/** Each language's Help pack, fetched on first use. Mutable only so tests can spy on or stub a loader. */
export const helpLoaders: Record<HelpCode, () => Promise<HelpPack>> = {
  de: () => import("../locales/help/de.json").then((pack) => pack.default as HelpPack),
  es: () => import("../locales/help/es.json").then((pack) => pack.default as HelpPack),
  fr: () => import("../locales/help/fr.json").then((pack) => pack.default as HelpPack),
  hi: () => import("../locales/help/hi.json").then((pack) => pack.default as HelpPack),
  ja: () => import("../locales/help/ja.json").then((pack) => pack.default as HelpPack),
  "pt-br": () => import("../locales/help/pt-br.json").then((pack) => pack.default as HelpPack),
  zh: () => import("../locales/help/zh.json").then((pack) => pack.default as HelpPack),
};

interface HelpEntryState { status: HelpStatus; pack?: HelpPack; attempt: number }
const states = new Map<HelpCode, HelpEntryState>();
let attempts = 0;
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** The readiness of a language's Help copy. English is always ready. A
 *  language never asked for reads as loading (the gate asks for it in the same
 *  render). A language with no Help pack registered reads as failed, so the
 *  panel says so instead of showing English. */
export function helpStatus(code: string): HelpStatus {
  const canonical = canonicalCode(code);
  if (canonical === "en") return "ready";
  if (!isHelpCode(canonical)) return "failed";
  return states.get(canonical)?.status ?? "loading";
}

/** Starts loading a language's Help pack unless it is ready or already
 *  loading. A failed language starts a new attempt (Try again), unless
 *  `retryFailed` is false: the gate's own call while rendering leaves a
 *  failure on screen with its Try again, so a pack that keeps failing is never
 *  fetched in a loop. Completion writes only that language's entry, and only
 *  while its attempt is current. */
export function ensureHelp(code: string, { retryFailed = true }: { retryFailed?: boolean } = {}): void {
  const canonical = canonicalCode(code);
  if (canonical === "en" || !isHelpCode(canonical)) return;
  const current = states.get(canonical);
  if (current && (current.status !== "failed" || !retryFailed)) return;
  const attempt = ++attempts;
  states.set(canonical, { status: "loading", attempt });
  // From never-asked to loading reads the same, so nobody needs telling; from
  // failed to loading (Try again) the panel must show the loading line. The
  // gate may call this while rendering, so listeners hear it after the render.
  if (current) { version += 1; queueMicrotask(() => { for (const listener of [...listeners]) listener(); }); }
  let load: Promise<HelpPack>;
  try {
    load = helpLoaders[canonical]();
  } catch (error) {
    load = Promise.reject(error);
  }
  load.then(
    (pack) => {
      if (states.get(canonical)?.attempt !== attempt) return;
      states.set(canonical, { status: "ready", pack, attempt });
      changed();
    },
    () => {
      if (states.get(canonical)?.attempt !== attempt) return;
      states.set(canonical, { status: "failed", attempt });
      changed();
    },
  );
}

function fill(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** A help panel string. A Help key reads enHelp in English, else the active
 *  language's ready Help pack, else the main pack's loading line: never
 *  English Help in another language. A main key goes through t(). A key in
 *  neither shows as itself, so a bad index entry never crashes the panel. */
export function hx(key: string, params?: Record<string, string | number>): string {
  if (isHelpKey(key)) {
    const code = canonicalCode(languageCode());
    if (code === "en") return fill(enHelp[key]!, params);
    const state = isHelpCode(code) ? states.get(code) : undefined;
    const template = state?.status === "ready" ? state.pack?.[key] : undefined;
    return template === undefined ? t("ux.l4a.panel.loading") : fill(template, params);
  }
  return Object.hasOwn(en, key) ? t(key as LocaleKey, params) : key;
}

/** The ready Help pack of a language (enHelp for English), or undefined. */
export function readyHelpPack(code: string): HelpPack | undefined {
  const canonical = canonicalCode(code);
  if (canonical === "en") return enHelp;
  return isHelpCode(canonical) && states.get(canonical)?.status === "ready" ? states.get(canonical)!.pack : undefined;
}

export function subscribeHelpCopy(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function helpCopyVersion(): number {
  return version;
}

const subscribeBoth = (listener: () => void) => {
  const offLocale = subscribeLocale(listener);
  const offHelp = subscribeHelpCopy(listener);
  return () => { offLocale(); offHelp(); };
};
const snapshot = () => `${languageCode()}|${version}`;

/** The active language's Help readiness, read in the same render as the
 *  language itself, so the first frame after a switch is already the gate. */
export function useHelpCopy(): { code: string; status: HelpStatus } {
  useSyncExternalStore(subscribeBoth, snapshot, snapshot);
  const code = canonicalCode(languageCode());
  return { code, status: helpStatus(code) };
}

/** Tests only: forget every language's state. A load still pending from
 *  before is left to finish, and its result is dropped (its attempt is gone). */
export function resetHelpCopyForTests(): void {
  states.clear();
  changed();
}
