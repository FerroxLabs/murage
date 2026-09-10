import { afterEach, expect, it } from "vitest";
import { en, locales } from "@/locales";
import { setLocale, t } from "./i18n";
afterEach(() => { setLocale("en"); });
const keys = Object.keys(en).filter(key => key.startsWith("claudeAccounts.")) as Array<keyof typeof en>;
it("provides all 21 account action messages and preserves placeholders in seven packs", () => {
  expect(keys).toHaveLength(21);
  for (const code of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    setLocale(code);
    for (const key of keys) {
      const value = locales[code][key];
      expect(value?.trim(), `${code}:${key}`).toBeTruthy();
      expect(value?.match(/\{\w+\}/g) ?? []).toEqual(en[key].match(/\{\w+\}/g) ?? []);
      expect(t(key, { name: "Work", shell: "PowerShell" })).not.toMatch(/\{(?:name|shell)\}/);
    }
  }
});
it("falls back to English without losing the selected account name", () => {
  setLocale("zz");
  expect(t("claudeAccounts.copySignIn", { name: "Work" })).toBe("Copy sign-in command for Work");
  expect(t("claudeAccounts.removeConfirm", { name: "Work" })).toContain("Remove Work from Murage?");
});
