// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls: the owner's first name in the opener (design 8).
import { describe, expect, it } from "vitest";
import { ownerFirstName } from "./bot-calls-card.ts";

describe("ownerFirstName", () => {
  it("takes the first word of the profile name", () => {
    expect(ownerFirstName("Sean Donahoe")).toBe("Sean");
    expect(ownerFirstName("  Zoë  ")).toBe("Zoë");
    expect(ownerFirstName("Mary-Jane O'Neil")).toBe("Mary-Jane");
  });
  it("is null when there is no usable name", () => {
    for (const v of [undefined, null, "", "   ", "123", "<>", 42]) expect(ownerFirstName(v)).toBeNull();
  });
  it("drops anything but letters, marks, apostrophes and hyphens, and caps the length", () => {
    expect(ownerFirstName("Sean<script>")).toBe("Seanscript");
    expect(ownerFirstName("A".repeat(80))).toHaveLength(40);
  });
});
