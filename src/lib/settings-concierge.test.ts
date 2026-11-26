// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S9: the generated "every setting" Help page lists every index entry with its address, and the
// committed page is never stale. `MURAGE_TEST_WRITE_CONCIERGE=1` (scripts/help/settings-concierge-page.mjs) writes it.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { settingsAddressFor } from "./settings-address";
import { CONCIERGE_PAGE_FILE, settingsConciergeMdx } from "./settings-concierge";
import { SETTINGS_INDEX } from "./settings-index";

const file = fileURLToPath(new URL(`../../${CONCIERGE_PAGE_FILE}`, import.meta.url));

describe("every setting Help page", () => {
  const page = settingsConciergeMdx();
  if (process.env.MURAGE_TEST_WRITE_CONCIERGE === "1") writeFileSync(file, page);

  it("lists every registry entry, once, with its address", () => {
    // The own transcription key renders only while a key saved earlier is in use (Sean 11-06), so Help leaves it out.
    const listed = SETTINGS_INDEX.filter((entry) => !(entry.scope === "app" && entry.anchor === "voice-key-heading"));
    expect(listed).toHaveLength(SETTINGS_INDEX.length - 1);
    for (const entry of listed) {
      const address = settingsAddressFor(entry);
      expect(page.split(`Address: ${address}\n`).length - 1, entry.id).toBe(1);
    }
    expect(page).not.toContain("webSearch/voice-key");
    expect(page.match(/^## /gm)?.length).toBe(listed.length);
  });

  it("names a reason for every entry that can be off, and no heading twice", () => {
    for (const entry of SETTINGS_INDEX) if (entry.gate) expect(page, entry.id).toContain(`When it is off: `);
    const headings = page.match(/^## .+$/gm) ?? [];
    expect(new Set(headings).size).toBe(headings.length);
  });

  it("follows the copy rules", () => {
    expect(page).not.toMatch(/—|–/);
    expect(page).not.toMatch(/\b(safe|safely|free)\b/i);
  });

  it("is committed as generated", () => {
    expect(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe(page);
  });

  it("is in the docs menu", () => {
    const meta = JSON.parse(readFileSync(fileURLToPath(new URL("../../apps/docs/content/docs/features/meta.json", import.meta.url)), "utf8")) as { pages: string[] };
    expect(meta.pages).toContain("every-setting");
  });
});
