// Language registry — adding a language is one file plus one line here,
// exactly like registering a provider driver. Packs are PARTIAL: any key a
// pack omits falls back to English, so a half-translated language is a
// usable language, not a broken one.
import { en } from "./en";
import { de } from "./de";
import { es } from "./es";
import { fr } from "./fr";
import { hi } from "./hi";
import { ja } from "./ja";
import { ptBr } from "./pt-br";
import { zh } from "./zh";

export type LocaleKey = keyof typeof en;
export type LocalePack = Partial<Record<LocaleKey, string>>;

export const locales: Record<string, LocalePack> = {
  en,
  de,
  es,
  fr,
  hi,
  ja,
  // both keys, one pack: pt-BR is the registered dialect, and a plain
  // "pt" system language should land on it rather than English
  pt: ptBr,
  "pt-br": ptBr,
  zh,
};
