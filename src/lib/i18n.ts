// Minimal string catalog — deliberately not a library. The renderer follows
// the system language; unknown tags and untranslated keys fall back to
// English, so a partial pack can ship the day it has one string.
import { en, loadLocalePack, localeCodes, type LocaleKey, type LocalePack } from "@/locales";

/** "de-AT" → "de-at" if registered, else "de", else "en". Pure, for tests. */
export function resolveLocale(tag: string | undefined, available: ReadonlySet<string>): string {
  if (!tag) return "en";
  const lower = tag.toLowerCase();
  if (available.has(lower)) return lower;
  const base = lower.split("-")[0] ?? "";
  return available.has(base) ? base : "en";
}

let activePack: LocalePack = en;
let activeCode = "en";
let version = 0;
let latest = 0;
const listeners = new Set<() => void>();

/** Switch the active language (the settings picker calls this too). A pack
 * other than English is fetched first (src/locales/index.ts), so this
 * resolves once the strings are in place, to the locale in effect after
 * fallback. The registry is read live, so a pack registered after boot is
 * immediately reachable. When calls overlap, the last one wins, and an
 * overtaken call resolves to whatever is in effect; a pack that cannot be
 * fetched leaves English. */
export async function setLocale(tag: string | undefined): Promise<string> {
  const ticket = ++latest;
  const resolved = resolveLocale(tag, localeCodes());
  let pack: LocalePack = en;
  let took = resolved;
  try {
    pack = await loadLocalePack(resolved);
  } catch {
    took = "en";
  }
  if (ticket !== latest) return activeCode;
  activeCode = took;
  if (pack !== activePack) {
    activePack = pack;
    version += 1;
    for (const listener of listeners) listener();
  }
  return took;
}

/** For useSyncExternalStore: t() reads a module variable, so a component
 * re-renders its strings when this version moves. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function localeVersion(): number {
  return version;
}
/** The language in effect now ("en", "de", "pt-br"), for date and number
 * formatting that should follow the app language. */
export function localeCode(): string {
  return activeCode;
}

/** Where this device remembers the language the owner chose in Settings
 * ("" follows the system), so the next start paints in it before config
 * arrives. A convenience only: config.language stays the truth. */
export const UI_LANGUAGE_KEY = "murage-ui-language";
type StorageRead<T> = () => T | undefined;
/** Reading `localStorage` itself throws where site data is blocked, so the
 * storage is always reached inside the try. */
const deviceStorage = (): Storage | undefined => globalThis.localStorage;
export function rememberLanguage(language: string, storage: StorageRead<Pick<Storage, "setItem">> = deviceStorage): void {
  try {
    storage()?.setItem(UI_LANGUAGE_KEY, language);
  } catch {
    /* private mode or blocked storage: the next start follows the system */
  }
}
/** The tag the first paint starts in: the remembered choice, else the system's. */
export function bootLanguage(storage: StorageRead<Pick<Storage, "getItem">>, system: string | undefined): string | undefined {
  try {
    return storage()?.getItem(UI_LANGUAGE_KEY) || system;
  } catch {
    return system;
  }
}

/** That language's pack, fetched as the app starts. main.tsx holds the first
 * render for it, briefly, so a German phone does not paint English and then
 * change under the reader's eyes. */
export const bootLocaleReady: Promise<string> = setLocale(bootLanguage(deviceStorage, globalThis.navigator?.language));

/** Look up a catalog string. `{name}` placeholders interpolate from params;
 * a placeholder without a matching param stays verbatim so a bad pack shows
 * its seams instead of dropping words. */
export function t(key: LocaleKey, params?: Record<string, string | number>): string {
  const template = activePack[key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
