// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The channel header shows one line of the channel's instructions. Written in
// markdown, that line read "# Trend Desk Launcher" with the hash showing, so
// the preview is the first line with words in it, without the markup.
export function instructionsPreview(bulletin: string): string {
  const line = bulletin.split("\n").map(text => text.trim()).find(Boolean) ?? "";
  return line
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S.*?\S|\S)[*_](?=\W|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
