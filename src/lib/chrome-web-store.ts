// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage for Chrome's public Chrome Web Store listing, for the What's new
// page. The item ID is the release ID in extensions/murage-browser/release.json
// (the one the native helper allows); chrome-web-store.test.ts fails the build
// if the two ever differ. The setup card and the Browser panel still take
// their link from the release build's own metadata
// (server/browser-extension-listing.ts).
export const MURAGE_FOR_CHROME_ITEM_ID = "gpilijlcanhphjaoogelbghhbhhminol";

export const MURAGE_FOR_CHROME_STORE_URL = `https://chromewebstore.google.com/detail/${MURAGE_FOR_CHROME_ITEM_ID}`;
