// Switching a bot that drives THIS computer to Full access showed the Auto
// warning: a dialog titled "Allow Auto mode on this computer?" for a choice
// the person did not make, promising a safety rail Full access removes
// ("Destructive and sensitive actions still stop").
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LOCAL_COMPUTER_AUTO_WARNING,
  LOCAL_COMPUTER_FULL_ACCESS_WARNING,
  LocalComputerAutoWarning,
} from "./LocalComputerAutoWarning";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const render = (mode?: "auto" | "full") =>
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

  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(createElement(LocalComputerAutoWarning, { open: false, mode: "full", onCancel: () => {}, onConfirm: () => {} }))).toBe("");
  });

  it("is told which mode by every caller that can switch on Full access", () => {
    expect(read("./Composer.tsx")).toMatch(/mode=\{autoWarn === false \? "auto" : autoWarn\}/);
    expect(read("./SettingsPanel.tsx")).toMatch(/mode=\{localAutoWarning === "full" \|\| localAutoWarning === "unlimited" \? localAutoWarning : "auto"\}/);
  });
});
