import { describe, expect, it } from "vitest";
import en from "./en.json";

const packs = import.meta.glob("./{de,es,fr,hi,ja,pt-br,zh}.json", { eager: true, import: "default" }) as Record<string, Record<string, string>>;
const catalogues: Record<string, Record<string, string>> = { en, ...Object.fromEntries(Object.entries(packs).map(([path, pack]) => [path.slice(2, -5), pack])) };

describe("copy review regressions: user-facing browser instructions", () => {
  it.each(Object.keys(catalogues))("%s explains connection errors without HTTP method names", (locale) => {
    for (const key of ["browser.server.browser-owner-session.7", "browser.server.route.10"]) {
      expect(catalogues[locale][key], key).not.toMatch(/\b(?:GET|POST)\b/);
    }
  });

  const generationWords: Record<string, RegExp> = {
    en: /\bgeneration\b/i, de: /Browsergeneration/i, es: /generación/i, fr: /génération/i,
    hi: /जनरेशन/, ja: /世代/, "pt-br": /geração/i, zh: /代次/,
  };
  it.each(Object.keys(catalogues))("%s does not ask the user for an internal browser generation", (locale) => {
    expect(catalogues[locale]["browser.server.browser-owner-session.11"]).not.toMatch(generationWords[locale]);
  });

  it.each(["es", "hi", "pt-br"])("%s preserves the extension's displayed name", (locale) => {
    for (const key of ["browser.profileWaiting", "browser.server.browser-extension-setup.21"]) {
      expect(catalogues[locale][key], key).toContain("Murage for Chrome");
    }
  });

  const restartTask: Record<string, { askBot: RegExp; continue: RegExp }> = {
    es: { askBot: /Pide al bot que inicie una nueva tarea de navegador/, continue: /Continuar/ },
    hi: { askBot: /बॉट से नया ब्राउज़र कार्य शुरू करने को कहें/, continue: /जारी रखें/ },
    "pt-br": { askBot: /Peça ao bot para iniciar uma nova tarefa de navegador/, continue: /Continuar/ },
  };
  it.each(Object.keys(restartTask))("%s asks the bot to restart a stopped browser task before Continue", (locale) => {
    for (const key of ["browser.server.browser-extension-setup.23", "browser.server.browser-extension-setup.24"]) {
      expect(catalogues[locale][key], key).toMatch(restartTask[locale].askBot);
      expect(catalogues[locale][key], key).toMatch(restartTask[locale].continue);
      expect(catalogues[locale][key], key).not.toContain("Murage for Chrome");
    }
  });

  it("Chinese profile instructions keep the informal address", () => {
    for (const key of ["browser.profileWaiting", "browser.waitingProfile"]) expect(catalogues.zh[key], key).not.toContain("您");
  });

  it("Hindi setup explains the Allow button in Hindi", () => {
    for (const key of ["browser.BrowserPreflight.1", "browser.BrowserSetupCard.10", "browser.cause.allow_not_given.action"]) {
      expect(catalogues.hi[key], key).toMatch(/अनुमति/);
    }
    for (const key of ["browser.server.route.2", "browser.server.route.3"]) expect(catalogues.hi[key], key).not.toMatch(/\bBrowser\b/);
  });

  it.each(["en", "de", "es", "fr"])("%s describes a tool count without budget jargon", (locale) => {
    expect(catalogues[locale]["engine.toolLimit.catalogUnknown"]).not.toMatch(/budget|presupuesto/i);
  });

  const routeWords: Record<string, RegExp> = { en: /\broute\b/i, es: /\bruta\b/i, hi: /रूट/, ja: /ルート/, "pt-br": /\brota\b/i, zh: /路由/ };
  it.each(Object.keys(routeWords))("%s labels browser connection choices without route jargon", (locale) => {
    for (const key of ["browser.BrowserChoice.13", "browser.versionUnknown", "browser.server.route.11", "browser.server.route.15"]) {
      expect(catalogues[locale][key], key).not.toMatch(routeWords[locale]);
    }
  });
});
