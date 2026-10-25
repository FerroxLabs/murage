// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The artwork that ships for each bot and team template, one file per catalog slug.
 *  `public/library-art/<slug>-256.webp` is the small card; `-512.webp` is the detail view.
 *  A slug with no file simply has no art: the caller keeps its own placeholder. */
export type LibraryArtSize = 256 | 512;

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The URL for a template's art, or null for a slug that could not name a file. */
export function libraryArtUrl(slug: string, size: LibraryArtSize): string | null {
  return SAFE_SLUG.test(slug) ? `/library-art/${slug}-${size}.webp` : null;
}
