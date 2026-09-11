import { afterEach, expect, it } from "vitest";
import { en, locales } from "@/locales";
import { setLocale, t } from "./i18n";
afterEach(() => { setLocale("en"); });
const keys = Object.keys(en).filter(key => key.startsWith("claudeAccounts.")) as Array<keyof typeof en>;
// The complete claudeAccounts.* set, grouped by the commit that added each key.
// A new account string must be translated in all seven packs and listed here.
const expectedKeys = [
  // 655c1d42 fix(i18n): translate account safety actions
  "added", "removed", "saved", "refreshError", "changeError", "copied", "copyError", "refresh", "add", "safety",
  "instructionsTitle", "instructions", "terminal", "copySignIn", "removeConfirm", "confirmRemoval", "cancelRemoval",
  "saving", "create", "save", "cancel",
  // b5e28ce8 fix(engines): keep Engines settings mounted on an unreadable Claude account list (RED2F)
  "listUnreadable",
  // FOLLOW4 fix(engines): refreshInstances reports its failure; the section names the engine list
  "fleetRefreshError",
].map(name => `claudeAccounts.${name}`);
it("provides all 23 account action messages and preserves placeholders in seven packs", () => {
  expect([...keys].sort()).toEqual([...expectedKeys].sort());
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
