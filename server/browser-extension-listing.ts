// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where the owner gets Murage for Chrome. The link comes only from trusted
// build metadata (the release build.json written by
// scripts/prepare-browser-extension.mjs from the owner's release config) AND
// the signed announcements feed's "murage-for-chrome-listed" flag, which is
// turned on the day the listing is public. Either missing: no link, and the
// setup text says the listing is not available yet. Never a guessed URL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnnouncementFlag } from "../shared/announcements.ts";

export type BrowserExtensionBuild = { mode: "release"; chromeWebStoreId: string | null } | { mode: "development" } | { mode: "none" };
export type BrowserExtensionListing = { build: "release" | "development" | "none"; storeUrl: string | null };

const ID = /^[a-p]{32}$/;

/** The staged helper resources' parent (it holds browser-extension/). */
export function browserExtensionResourcesPath(): string {
  return process.env.MURAGE_BROWSER_EXTENSION_RESOURCES_PATH ?? process.env.MURAGE_RESOURCES_PATH ?? process.env.OMB_RESOURCES_PATH ?? fileURLToPath(new URL("../dist-native", import.meta.url));
}

/** The staged helper resources' build.json, or "none" when absent or damaged. */
export function readBrowserExtensionBuild(resourcesPath: string): BrowserExtensionBuild {
  try {
    const value = JSON.parse(readFileSync(join(resourcesPath, "browser-extension", "build.json"), "utf8")) as Record<string, unknown>;
    if (value.mode === "development") return { mode: "development" };
    if (value.mode !== "release") return { mode: "none" };
    const ids = Array.isArray(value.productionIds) ? value.productionIds : [];
    const store = value.chromeWebStoreId;
    // The listing's item must be one of the IDs the native helper allows.
    return { mode: "release", chromeWebStoreId: typeof store === "string" && ID.test(store) && ids.includes(store) ? store : null };
  } catch { return { mode: "none" }; }
}

export function browserExtensionListing(build: BrowserExtensionBuild, flags: readonly AnnouncementFlag[] | undefined): BrowserExtensionListing {
  if (build.mode !== "release") return { build: build.mode, storeUrl: null };
  const listed = build.chromeWebStoreId && flags?.includes("murage-for-chrome-listed");
  return { build: "release", storeUrl: listed ? `https://chromewebstore.google.com/detail/${build.chromeWebStoreId}` : null };
}

/** What the setup card and Browser panel receive. */
export function browserExtensionListingStatus(listing: BrowserExtensionListing) {
  return { storeUrl: listing.storeUrl, extensionBuild: listing.build };
}

/** The truthful next step while no browser profile is connected. */
export function browserExtensionSetupReason(listing: BrowserExtensionListing): string {
  if (listing.storeUrl) return "Add Murage for Chrome from the Chrome Web Store, then open its side panel and connect.";
  if (listing.build === "release") return "Murage for Chrome is not in the Chrome Web Store yet. You can keep using the bot's own browser.";
  if (listing.build === "development") return "Install the development extension and register its helper to connect. The store listing is not published.";
  // Resources-only builds (qualification before the store item exists) ship
  // the helper but no extension identity, so nothing can connect yet.
  return "This copy of Murage is not set up for Murage for Chrome yet. You can keep using the bot's own browser.";
}
