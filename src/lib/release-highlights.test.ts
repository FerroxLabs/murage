// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { HIGHLIGHT_LENGTH, releaseHighlights } from "./release-highlights";

describe("release highlights", () => {
  it("takes bullets, strips markdown and links, drops dashes", () => {
    const text = "## What's Changed\n- **Faster** search — now instant (#123)\n* See [the guide](https://x.example/a) for more\n\nFull Changelog: https://x.example";
    expect(releaseHighlights(text)).toEqual(["Faster search, now instant", "See the guide for more"]);
  });
  it("falls back to plain lines when there are no bullets, skipping headings", () => {
    expect(releaseHighlights("# 1.2\nChats open faster.\nBots remember more.")).toEqual(["Chats open faster.", "Bots remember more."]);
  });
  it("caps the count and the length, and drops repeats", () => {
    const many = Array.from({ length: 9 }, (_, i) => `- Item number ${i}`).join("\n");
    expect(releaseHighlights(many)).toHaveLength(5);
    expect(releaseHighlights(`- ${"word ".repeat(80)}`)[0]!.length).toBeLessThanOrEqual(HIGHLIGHT_LENGTH);
    expect(releaseHighlights("- Same thing\n- same thing")).toEqual(["Same thing"]);
  });
  it("is empty without notes", () => {
    expect(releaseHighlights(undefined)).toEqual([]);
    expect(releaseHighlights("")).toEqual([]);
  });
});
