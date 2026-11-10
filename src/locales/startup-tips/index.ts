// SPDX-License-Identifier: AGPL-3.0-or-later
// The daily start-up tips in all 8 languages (FIRSTRUN-1019 section 1.3 and 2.2).
//
// Why a folder of its own and not src/locales/<code>.json: these strings are only read by the picture writer, which hands the
// finished sentence to main for the splash; the catalogue partitions (main, Help, step-up) are reviewed string by string in the
// copy ledger, and a new partition would need ledger records the review process owns. src/locales/startup-tips/startup-tips-copy.test.ts
// runs the same lint rules over every string here, and the copy lane can fold the folder into the ledger when it reviews it.
//
// Keys: `<tipId>.head|line|try`, `surfaces.mac|win|other` (what {surfaces} reads as on each OS) and the two fallbacks. English is
// the first paint of every other pack, key by key, so a half-translated pack is still a usable one.
import en from "./en.json";

export type TipStrings = Readonly<Record<string, string>>;

const loaders: Record<string, () => Promise<TipStrings>> = {
  de: () => import("./de.json").then((pack) => pack.default),
  es: () => import("./es.json").then((pack) => pack.default),
  fr: () => import("./fr.json").then((pack) => pack.default),
  hi: () => import("./hi.json").then((pack) => pack.default),
  ja: () => import("./ja.json").then((pack) => pack.default),
  "pt-br": () => import("./pt-br.json").then((pack) => pack.default),
  zh: () => import("./zh.json").then((pack) => pack.default),
};
// plain "pt" answers with the pt-BR pack, as the app's own registry does (src/locales/index.ts)
loaders.pt = loaders["pt-br"];

export const ENGLISH_TIPS: TipStrings = en;

/** The tip strings for a language code ("en", "de", "pt", "pt-br"): the pack over English, or English for an unknown code or a pack that fails to load. */
export async function loadTipStrings(code: string): Promise<TipStrings> {
  const load = Object.hasOwn(loaders, code.toLowerCase()) ? loaders[code.toLowerCase()] : undefined;
  if (!load) return en;
  try {
    return { ...en, ...(await load()) };
  } catch {
    return en;
  }
}
