// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The cache-control an image response carries. A final image (the original,
 * or a finished thumbnail) takes the caller's rule, else the desktop's year:
 * an attachment and a settled message's image never change under their name.
 * An original sent for now in place of a thumbnail (every resize busy, or no
 * resizer) must never be kept under the thumbnail's URL, whatever the caller
 * asked, and a caller that said no-store (a screen capture) keeps no-store.
 */
export function imageCacheControl(final: boolean, caller: string | undefined): string {
  if (final) return caller ?? "private, max-age=31536000, immutable";
  return /\bno-store\b/i.test(caller ?? "") ? "private, no-store" : "private, no-cache";
}
