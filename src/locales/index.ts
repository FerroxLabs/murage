// Language registry — a language is one JSON file plus one line here.
// Catalogs are plain JSON so the optional Claude helper and human translators can
// read/write the same reviewable files without a runtime service.
// Packs are PARTIAL: any key a pack omits falls back to English, so a
// half-translated language is a usable language, not a broken one.
//
// English is the only pack in the first paint. Every other pack is its own
// chunk behind `import()`, fetched when that language is chosen: seven packs
// in the entry chunk cost every phone over cellular ~20 KiB brotli for text
// it will never show (src/first-paint.test.ts).
import en from "./en.json";

export { en };
export type LocaleKey = keyof typeof en;
export type LocalePack = Partial<Record<LocaleKey, string>>;

type PackLoader = () => Promise<LocalePack>;
const ptBr: PackLoader = () => import("./pt-br.json").then((pack) => pack.default);

/** Every registered language but English, by code, each loading its pack.
 * Mutable only so a test can register a pack after boot. */
export const localeLoaders: Record<string, PackLoader> = {
  de: () => import("./de.json").then((pack) => pack.default),
  es: () => import("./es.json").then((pack) => pack.default),
  fr: () => import("./fr.json").then((pack) => pack.default),
  hi: () => import("./hi.json").then((pack) => pack.default),
  ja: () => import("./ja.json").then((pack) => pack.default),
  // both keys, one pack: pt-BR is the registered dialect, and a plain
  // "pt" system language should land on it rather than English
  pt: ptBr,
  "pt-br": ptBr,
  zh: () => import("./zh.json").then((pack) => pack.default),
};

/** Every code the registry answers to, English and alias keys included. */
export function localeCodes(): Set<string> {
  return new Set(["en", ...Object.keys(localeLoaders)]);
}

const loaded = new Map<string, Promise<LocalePack>>();

/** A registered pack, fetched once. A failed fetch is forgotten so the next
 * choice of that language tries again. Unknown codes reject. */
export function loadLocalePack(code: string): Promise<LocalePack> {
  if (code === "en") return Promise.resolve(en);
  const load = localeLoaders[code];
  if (!load) return Promise.reject(new Error(`no language pack is registered as "${code}"`));
  let pack = loaded.get(code);
  if (!pack) {
    pack = load();
    loaded.set(code, pack);
    pack.catch(() => loaded.delete(code));
  }
  return pack;
}

/** Pickable languages for the settings dropdown. Alias keys ("pt") are
 * routing, not choices, so they are not listed here. */
export const localeChoices: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "hi", label: "हिन्दी" },
  { code: "ja", label: "日本語" },
  { code: "pt-br", label: "Português (Brasil)" },
  { code: "zh", label: "中文" },
];
