// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SECTION_PAGES, isSettingsPage } from "../src/lib/settings-pages";
import { settingsPageLabel } from "../src/lib/settings-sections";
import { buildNavigation } from "../scripts/build-capability-db.mjs";
import { HELP_INDEX } from "./help-index";

const pages = SECTION_PAGES.map(({ id }) => ({ id, label: settingsPageLabel(id) }));

/** Text after an app Settings arrow may continue as prose. Match the whole current page label at its start. */
function pageForPath(tail: string) {
  return pages.find(({ label }) => tail.startsWith(label) && /^(?:$|\s|[→>.,;:!?*)\]])/.test(tail.slice(label.length)));
}

function checkSettingsPaths(text: string, context: string): number {
  let count = 0;
  for (const match of text.matchAll(/Settings\s*(?:→|>)\s*/g)) {
    const tail = text.slice(match.index + match[0].length);
    const page = pageForPath(tail);
    expect(page, `${context}: Settings → ${tail.split("\n")[0]}`).toBeDefined();
    expect(isSettingsPage(page!.id), context).toBe(true);
    count++;
  }
  return count;
}

describe("shipped help copy stays consistent with the app", () => {
  it("names the Windows installer publisher without the old unsigned-install instructions", () => {
    const download = HELP_INDEX.find((entry) => entry.id === "getting-started/installation#download-a-released-build");
    expect(download).toBeDefined();
    expect(download!.text).toContain("signed by Ferrox Labs, LLC");
    expect(download!.text).not.toMatch(/not code-signed|signing is not yet available|Unknown publisher|Run anyway/i);
  });

  it("resolves every Settings path in every help field to a current page id", () => {
    let count = 0;
    for (const entry of HELP_INDEX) {
      for (const [field, text] of Object.entries(entry)) count += checkSettingsPaths(text, `${entry.id}.${field}`);
    }
    expect(count).toBeGreaterThan(100);
  });

  it("also checks the source docs beyond the help snippet length", () => {
    const root = fileURLToPath(new URL("../apps/docs/content/docs/", import.meta.url));
    let count = 0;
    for (const file of readdirSync(root, { recursive: true })) {
      if (file.endsWith(".mdx")) count += checkSettingsPaths(readFileSync(join(root, file), "utf8"), file);
    }
    expect(count).toBeGreaterThan(100);
  });

  it("refuses old page labels and unknown labels instead of falling back to General", () => {
    for (const name of ["Devices", "Models", "Tools & Connections", "About me", "House rules", "Engines", "Voice", "Storage", "About & updates", "Generalized", ""]) {
      expect(pageForPath(name), name).toBeUndefined();
    }
    for (const { id, label } of pages) {
      expect(pageForPath(label)?.id).toBe(id);
      expect(pageForPath(`${label} → A control`)?.id).toBe(id);
    }
  });

  it("keeps the site navigation reader aligned with the actual Settings pages", () => {
    const navigation = buildNavigation();
    expect([...navigation.pages.values()].map(({ id, label }) => ({ id, label }))).toEqual(pages);
    expect(navigation.controlErrors).toEqual([]);
  });

});
