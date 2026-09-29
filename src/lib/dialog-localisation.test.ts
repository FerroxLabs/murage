import { afterEach, expect, it } from "vitest";
import { en, type LocaleKey } from "@/locales";
import { allLocalePacks } from "@/locales/testing";
import { setLocale, t } from "./i18n";

const keys = ["source.openError", "inbox.conversationUnavailable", "inbox.openResultError", "inbox.title", "files.sourceUnavailableRetained", "files.title", "files.workingFolderError", "files.nativeActionError"] as const satisfies readonly LocaleKey[];
afterEach(() => setLocale("en"));
const locales = await allLocalePacks();
it("ships all eight dialog messages in every selected language with matching placeholders", async () => {
  for (const code of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    await setLocale(code);
    for (const key of keys) {
      const value = locales[code][key];
      expect(value, `${code}:${key}`).toBeTypeOf("string");
      expect(value?.trim(), `${code}:${key}`).toBeTruthy();
      expect(value?.match(/\{\w+\}/g) ?? []).toEqual(en[key].match(/\{\w+\}/g) ?? []);
      expect(t(key)).toBe(value);
    }
  }
});
