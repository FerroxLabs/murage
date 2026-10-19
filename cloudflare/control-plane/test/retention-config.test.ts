// SPDX-License-Identifier: AGPL-3.0-or-later
import wrangler from "../wrangler.jsonc?raw";
import e2e from "../e2e/wrangler.e2e.jsonc?raw";
import { expect, it } from "vitest";
// CLOUD_B3_CONFIG.retentionMs is the single source of the suspended -> delete
// period. Every wrangler env that sets it must say 30 days.
it.each([["wrangler.jsonc", wrangler], ["wrangler.e2e.jsonc", e2e]])("%s sets retentionMs to 30 days", (_file, text) => {
  const found = [...text.matchAll(/retentionMs\\":(\d+)/g)].map((m) => Number(m[1]));
  expect(found.length).toBeGreaterThan(0);
  for (const value of found) expect(value).toBe(30 * 86_400_000);
});
