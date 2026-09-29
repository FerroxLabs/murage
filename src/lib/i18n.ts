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
let version = 0;
let latest = 0;
const listeners = new Set<() => void>();

/** Switch the active language (the settings picker calls this too). A pack
 * other than English is fetched first (src/locales/index.ts), so this
 * resolves once the strings are in place, to the locale that actually took
 * effect after fallback. The registry is read live, so a pack registered
 * after boot is immediately reachable. When calls overlap, the last one
 * wins; a pack that cannot be fetched leaves English. */
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
  if (ticket !== latest) return took;
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

/** The system language's pack, fetched as the app starts. main.tsx holds the
 * first render for it, briefly, so a German phone does not paint English
 * and then change under the reader's eyes. */
export const systemLocaleReady: Promise<string> = setLocale(globalThis.navigator?.language);

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
