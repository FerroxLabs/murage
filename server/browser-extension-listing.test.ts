// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { browserExtensionListing, browserExtensionSetupReason, readBrowserExtensionBuild } from "./browser-extension-listing.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function resources(build: unknown) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "bx-listing-"))); roots.push(root);
  mkdirSync(join(root, "browser-extension"));
  if (build !== undefined) writeFileSync(join(root, "browser-extension", "build.json"), typeof build === "string" ? build : JSON.stringify(build));
  return root;
}

it("a release build with its store item links the Chrome Web Store listing, with no feed flag", () => {
  const build = readBrowserExtensionBuild(resources({ version: 1, mode: "release", productionIds: [ID], chromeWebStoreId: ID }));
  expect(build).toEqual({ mode: "release", chromeWebStoreId: ID });
  const listing = browserExtensionListing(build);
  expect(listing).toEqual({ build: "release", storeUrl: `https://chromewebstore.google.com/detail/${ID}` });
  expect(browserExtensionSetupReason(listing)).toBe("Add Murage for Chrome from the Chrome Web Store, then open its side panel and connect.");
});

it("the shipped release ID links its live listing", () => {
  const live = "gpilijlcanhphjaoogelbghhbhhminol";
  expect(browserExtensionListing(readBrowserExtensionBuild(resources({ version: 1, mode: "release", productionIds: [live], chromeWebStoreId: live })))).toEqual({ build: "release", storeUrl: `https://chromewebstore.google.com/detail/${live}` });
});

it("a development, resources-only, missing or damaged build never links a listing", () => {
  expect(browserExtensionListing(readBrowserExtensionBuild(resources({ version: 1, mode: "development", developmentId: ID })))).toEqual({ build: "development", storeUrl: null });
  expect(browserExtensionListing(readBrowserExtensionBuild(resources({ version: 1, mode: "development", developmentId: ID, productionIds: [ID], chromeWebStoreId: ID })))).toEqual({ build: "development", storeUrl: null });
  expect(browserExtensionListing(readBrowserExtensionBuild(resources({ version: 1, mode: "resources", productionIds: [] })))).toEqual({ build: "none", storeUrl: null });
  expect(browserExtensionListing(readBrowserExtensionBuild(resources({ version: 1, mode: "resources", productionIds: [ID], chromeWebStoreId: ID })))).toEqual({ build: "none", storeUrl: null });
  expect(browserExtensionListing(readBrowserExtensionBuild(resources(undefined)))).toEqual({ build: "none", storeUrl: null });
  expect(browserExtensionListing(readBrowserExtensionBuild(resources("{broken")))).toEqual({ build: "none", storeUrl: null });
});

it("a release build whose store item is missing or not one of its allowed IDs never links, and never says the listing is missing", () => {
  for (const build of [
    { version: 1, mode: "release", productionIds: ["b".repeat(32)], chromeWebStoreId: ID },
    { version: 1, mode: "release", productionIds: [ID], chromeWebStoreId: "not-an-id" },
    { version: 1, mode: "release", productionIds: [ID] },
    { version: 1, mode: "release", chromeWebStoreId: ID },
  ]) {
    const listing = browserExtensionListing(readBrowserExtensionBuild(resources(build)));
    expect(listing).toEqual({ build: "release", storeUrl: null });
    expect(browserExtensionSetupReason(listing)).not.toMatch(/not (in the Chrome Web Store|available)|yet/);
  }
});
