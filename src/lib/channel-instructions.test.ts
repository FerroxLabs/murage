// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { instructionsPreview } from "./channel-instructions";

it("shows the first line of channel instructions as words, not markdown", () => {
  expect(instructionsPreview("# Weekly plan\n\nShip it")).toBe("Weekly plan");
  expect(instructionsPreview("\n\n**Research** the opportunity")).toBe("Research the opportunity");
  expect(instructionsPreview("- keep replies short")).toBe("keep replies short");
  expect(instructionsPreview("Plain line")).toBe("Plain line");
  expect(instructionsPreview("  \n ")).toBe("");
});
