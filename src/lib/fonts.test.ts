// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B86: the interface font is chosen apart from the skin, stamped on <html>,
// remembered on this machine, and every choice but the default has its CSS.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FONT, FONT_IDS, FONT_LABELS, applyFont, readFont } from "./fonts";

const here = dirname(fileURLToPath(import.meta.url));
let saved: Map<string, string>;
let dataset: Record<string, string>;

beforeEach(() => {
  saved = new Map();
  dataset = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
  });
  vi.stubGlobal("document", { documentElement: { dataset } });
});
afterEach(() => vi.unstubAllGlobals());

describe("interface font", () => {
  it("starts on the skin's own font", () => {
    expect(readFont()).toBe(DEFAULT_FONT);
  });

  it("stamps a choice on <html>, remembers it, and the default takes the stamp off", () => {
    applyFont("serif");
    expect(dataset.font).toBe("serif");
    expect(readFont()).toBe("serif");
    applyFont("default");
    expect(dataset.font).toBeUndefined();
    expect(readFont()).toBe("default");
  });

  it("ignores a stored value it does not know", () => {
    saved.set("murage-font", "comic-sans");
    expect(readFont()).toBe(DEFAULT_FONT);
  });

  it("still applies when storage refuses", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readFont()).toBe(DEFAULT_FONT);
    applyFont("system");
    expect(dataset.font).toBe("system");
  });

  it("every choice has a label, and every choice but the default has a CSS block that also reaches a nested skin", () => {
    const css = readFileSync(join(here, "..", "styles.css"), "utf8");
    for (const id of FONT_IDS) {
      expect(FONT_LABELS[id]).toBeTruthy();
      if (id === DEFAULT_FONT) continue;
      expect(css).toContain(`:root[data-font="${id}"],\n:root[data-font="${id}"] [data-skin] {\n  --font-sans:`);
    }
  });

  it("is stamped before the first paint and offered in Settings", () => {
    expect(readFileSync(join(here, "..", "main.tsx"), "utf8")).toContain("applyFont(readFont());");
    const settings = readFileSync(join(here, "..", "components", "SettingsModal.tsx"), "utf8");
    expect(settings).toContain("<SkinPicker />\n                    <FontRow />");
  });
});
