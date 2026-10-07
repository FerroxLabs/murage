// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { imagesLeftOutActivityName, imagesLeftOutCount, imagesLeftOutDisplayName, imagesLeftOutSentence } from "./images-left-out.ts";

describe("images left out note (G11)", () => {
  it("round-trips the count through the activity name", () => {
    expect(imagesLeftOutCount(imagesLeftOutActivityName(1))).toBe(1);
    expect(imagesLeftOutCount(imagesLeftOutActivityName(3))).toBe(3);
    expect(imagesLeftOutCount("error: HTTP 400")).toBeUndefined();
    expect(imagesLeftOutCount(undefined)).toBeUndefined();
  });

  it("says it in one plain sentence naming the bot", () => {
    expect(imagesLeftOutSentence("Dax", 1)).toBe("Dax can't see images, so I left the picture out.");
    expect(imagesLeftOutSentence("Dax", 2)).toBe("Dax can't see images, so I left the pictures out.");
    expect(imagesLeftOutDisplayName(imagesLeftOutActivityName(1), "Dax")).toBe("Dax can't see images, so I left the picture out.");
    expect(imagesLeftOutDisplayName("stopped: x", "Dax")).toBeUndefined();
  });
});
