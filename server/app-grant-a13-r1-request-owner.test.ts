// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 build review (Astra a13 r1) item 6, Rule 83b: an answer goes to
// the member whose card it is, never the member busy now.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { requestOwnerId } from "./request-owner.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("item 6, Rule 83b: an answer reaches the member whose card it is", () => {
  it("routes by the card's own member, never the member busy now", () => {
    expect(requestOwnerId({ busyBotId: "a", cardBotId: "b" })).toBe("b");
    expect(requestOwnerId({ cardBotId: "b" })).toBe("b");
  });

  it("falls back to the busy member only for a card that names none", () => {
    expect(requestOwnerId({ busyBotId: "a" })).toBe("a");
    expect(requestOwnerId({})).toBeUndefined();
  });

  it("is what the answer path reads", () => {
    const source = read("./index.ts");
    const owner = source.slice(source.indexOf("function threadRequestOwner("), source.indexOf("function projectStoppedDesk("));
    expect(owner).toContain("requestOwnerId(");
    expect(owner).not.toMatch(/group\.busyBotId \? store\.bot\(group\.busyBotId\)/);
  });
});
