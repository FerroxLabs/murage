// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MURAGE_FOR_CHROME_ITEM_ID, MURAGE_FOR_CHROME_STORE_URL } from "./chrome-web-store";

describe("Murage for Chrome's store listing", () => {
  it("is the release ID the native helper allows", () => {
    const release = JSON.parse(readFileSync(new URL("../../extensions/murage-browser/release.json", import.meta.url), "utf8")) as { productionIds: string[] };
    expect(MURAGE_FOR_CHROME_ITEM_ID).toMatch(/^[a-p]{32}$/);
    expect(release.productionIds).toContain(MURAGE_FOR_CHROME_ITEM_ID);
    expect(MURAGE_FOR_CHROME_STORE_URL).toBe(`https://chromewebstore.google.com/detail/${MURAGE_FOR_CHROME_ITEM_ID}`);
  });
});
