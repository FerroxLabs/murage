// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G9 (g9-gap-astra "Devices" dead end, g9-ux-fable COPY-REVIEW.md): with the built-in browser off, a bot's Browser row
// tells the owner where the app-wide switch is. Every word of that path must be a label the owner can see in their
// language: the gear (nav.appSettings), the page (settings.page.computer) and the card (settings.l1.card.companion.browser).
// The old line said "Devices", a page that does not exist; "Phone and other devices" opens pairing instead.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { settingsPanelSource } from "../components/bot-pages/panel-source";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const pack = (code: string) => JSON.parse(read(`./${code}.json`)) as Record<string, string>;
const KEY = "settings.bot.browser.featureOff";
const hashes = JSON.parse(read("./source-hashes.json")) as { locales: Record<string, Record<string, string>> };
const en = pack("en");

describe("the browser-off line names the real Settings path in all 8 languages", () => {
  for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    it(`${code}: gear, page and card are the labels on screen`, () => {
      const words = pack(code);
      const line = words[KEY]!;
      for (const label of ["nav.appSettings", "settings.page.computer", "settings.l1.card.companion.browser"]) {
        expect(words[label], `${code} ${label}`).toBeTruthy();
        expect(line, `${code} ${label}`).toContain(words[label]!);
      }
      expect(line).not.toMatch(/Devices|Geräte|Dispositivos|Appareils|डिवाइस|デバイス|设备/);
      expect(line).not.toMatch(/—|\s–\s/);
    });
  }

  it("the seven packs are hashed against the current English line", () => {
    const want = createHash("sha256").update(en[KEY]!).digest("hex");
    for (const code of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) expect(hashes.locales[code]![KEY], code).toBe(want);
  });

  it("the bot's Browser row shows this key when the app-wide switch is off", () => {
    expect(settingsPanelSource()).toContain(`t("${KEY}")`);
  });
});
