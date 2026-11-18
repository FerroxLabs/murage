// The Appearance caption must name the theme the page is actually painted with, not what the OS query says.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkinPicker } from "./SkinPicker";

afterEach(() => vi.unstubAllGlobals());

describe("SkinPicker status line", () => {
  it("Automatic chosen, page painted dark, OS query says light: shows System (Dark), never a light reading", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { skin: "dark" } } });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
    vi.stubGlobal("localStorage", { getItem: () => "auto", setItem() {} });
    const html = renderToStaticMarkup(createElement(SkinPicker));
    expect(html).toContain("System (Dark)");
    expect(html).not.toContain("now Light");
  });

  it("Automatic chosen, page painted light, OS query says dark: shows System (Light)", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { skin: "light" } } });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
    vi.stubGlobal("localStorage", { getItem: () => "auto", setItem() {} });
    expect(renderToStaticMarkup(createElement(SkinPicker))).toContain("System (Light)");
  });
});
