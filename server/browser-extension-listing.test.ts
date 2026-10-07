// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { browserExtensionListing, readBrowserExtensionBuild } from "./browser-extension-listing.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function resources(build: unknown) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "bx-listing-"))); roots.push(root);
  mkdirSync(join(root, "browser-extension"));
  if (build !== undefined) writeFileSync(join(root, "browser-extension", "build.json"), typeof build === "string" ? build : JSON.stringify(build));
  return root;
}

it("a release build with its store item and the feed flag on links the Chrome Web Store listing", () => {
  const build = readBrowserExtensionBuild(resources({ version: 1, mode: "release", productionIds: [ID], chromeWebStoreId: ID }));
  expect(build).toEqual({ mode: "release", chromeWebStoreId: ID });
  expect(browserExtensionListing(build, ["murage-for-chrome-listed"] as const)).toEqual({ build: "release", storeUrl: `https://chromewebstore.google.com/detail/${ID}` });
});

it("no link until the feed says the listing is public", () => {
  const build = readBrowserExtensionBuild(resources({ version: 1, mode: "release", productionIds: [ID], chromeWebStoreId: ID }));
  expect(browserExtensionListing(build, undefined)).toEqual({ build: "release", storeUrl: null });
  expect(browserExtensionListing(build, [])).toEqual({ build: "release", storeUrl: null });
});

it("a development, resources-only, missing or damaged build never links a listing", () => {
  const flags = ["murage-for-chrome-listed"] as const;
  expect(browserExtensionListing(readBrowserExtensionBuild(resources({ version: 1, mode: "development", developmentId: ID })), flags)).toEqual({ build: "development", storeUrl: null });
  expect(browserExtensionListing(readBrowserExtensionBuild(resources({ version: 1, mode: "resources", productionIds: [] })), flags)).toEqual({ build: "none", storeUrl: null });
  expect(browserExtensionListing(readBrowserExtensionBuild(resources(undefined)), flags)).toEqual({ build: "none", storeUrl: null });
  expect(browserExtensionListing(readBrowserExtensionBuild(resources("{broken")), flags)).toEqual({ build: "none", storeUrl: null });
  // A release build whose store item is not one of its allowed IDs is not trusted.
  expect(browserExtensionListing(readBrowserExtensionBuild(resources({ version: 1, mode: "release", productionIds: ["b".repeat(32)], chromeWebStoreId: ID })), flags)).toEqual({ build: "release", storeUrl: null });
  expect(browserExtensionListing(readBrowserExtensionBuild(resources({ version: 1, mode: "release", productionIds: [ID], chromeWebStoreId: "not-an-id" })), flags)).toEqual({ build: "release", storeUrl: null });
});
