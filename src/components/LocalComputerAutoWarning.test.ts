// Switching a bot that drives THIS computer to Full access showed the Auto
// warning: a dialog titled "Allow Auto mode on this computer?" for a choice
// the person did not make, promising a safety rail Full access removes
// ("Destructive and sensitive actions still stop").
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale, t } from "@/lib/i18n";
import { en } from "@/locales";
import { describe, expect, it } from "vitest";

import {
  LOCAL_COMPUTER_AUTO_WARNING,
  LOCAL_COMPUTER_FULL_ACCESS_WARNING,
  LOCAL_COMPUTER_NO_LIMITS_WARNING,
  LocalComputerAutoWarning,
} from "./LocalComputerAutoWarning";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const render = (mode?: "auto" | "full" | "unlimited") =>
  renderToStaticMarkup(createElement(LocalComputerAutoWarning, { open: true, mode, onCancel: () => {}, onConfirm: () => {} }));

describe("the this-computer warning names the mode being switched on", () => {
  it("still asks about Auto by default", () => {
    const markup = render();
    expect(markup).toContain("Allow Auto mode on this computer?");
    expect(markup).toContain(LOCAL_COMPUTER_AUTO_WARNING);
    expect(markup).toContain("Destructive and sensitive actions still stop");
  });

  it("asks about Full access when that is what was chosen", () => {
    const markup = render("full");
    expect(markup).toContain("Allow Full access on this computer?");
    expect(markup).not.toContain("Allow Auto mode on this computer?");
    expect(markup).toContain(LOCAL_COMPUTER_FULL_ACCESS_WARNING);
  });

  it("never promises Full access keeps the stops Auto keeps", () => {
    expect(LOCAL_COMPUTER_FULL_ACCESS_WARNING).not.toContain("still stop");
    expect(render("full")).not.toContain("Destructive and sensitive actions still stop");
  });

  it("pins the wipe-only No limits warning and honoured owner choices", () => {
    const markup = render("unlimited");
    expect(markup).toContain("Allow No limits on this computer?");
    expect(markup.replace(/&#x27;/g, "'")).toContain(LOCAL_COMPUTER_NO_LIMITS_WARNING);
    expect(LOCAL_COMPUTER_NO_LIMITS_WARNING).toBe(en["ux.lcopyb.level.unlimitedHere"]);
    expect(LOCAL_COMPUTER_NO_LIMITS_WARNING).not.toMatch(/\bsafe\b|\u2014/i);
  });

  it.each(["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"])("renders the translated No limits warning in %s", async (code) => {
    try {
      await setLocale(code);
      const markup = render("unlimited");
      const expected = renderToStaticMarkup(createElement("p", null, t("ux.lcopyb.level.unlimitedHere")));
      expect(markup).toContain(expected.slice(3, -4));
      if (code !== "en") expect(t("ux.lcopyb.level.unlimitedHere")).not.toBe(LOCAL_COMPUTER_NO_LIMITS_WARNING);
    } finally {
      await setLocale("en");
    }
  });

  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(createElement(LocalComputerAutoWarning, { open: false, mode: "full", onCancel: () => {}, onConfirm: () => {} }))).toBe("");
  });

  it("is Auto's alone in both callers: a higher pick to Full access or No limits is the confirm card, which says this itself", () => {
    expect(read("./Composer.tsx")).toContain('<LocalComputerAutoWarning\n        open={autoWarn}\n        mode="auto"');
    expect(read("./SettingsPanel.tsx")).toMatch(/<LocalComputerAutoWarning\s+open=\{localAutoWarning !== null\}\s+mode="auto"/);
  });
});
