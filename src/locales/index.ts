// Language registry — adding a language is one file plus one line here,
// exactly like registering a provider driver. Packs are PARTIAL: any key a
// pack omits falls back to English, so a half-translated language is a
// usable language, not a broken one.
import { en } from "./en";

export type LocaleKey = keyof typeof en;
export type LocalePack = Partial<Record<LocaleKey, string>>;

export const locales: Record<string, LocalePack> = {
  en,
};
