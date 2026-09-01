import { describe, expect, it } from "vitest";

import { plainText, plainTextClamped } from "./plain-text";

describe("plainText", () => {
  it("unwraps the emphasis a bot package actually shipped", () => {
    // The real one, from bot-library/builtins/smart-trader.json.
    expect(plainText("You are **Smart Trader**. You help someone read their own charts")).toBe(
      "You are Smart Trader. You help someone read their own charts",
    );
  });

  it("unwraps every paired emphasis marker without eating the words", () => {
    expect(plainText("***all*** __of__ _these_ *and* ~~those~~ and `code`")).toBe(
      "all of these and those and code",
    );
  });

  it("keeps link and image text and drops the target", () => {
    expect(plainText("see [the docs](https://example.com) and ![a chart](chart.png)")).toBe(
      "see the docs and a chart",
    );
  });

  it("strips line-leading furniture and folds to one line", () => {
    expect(plainText("# Title\n\n> quoted\n\n- first\n- second\n\n1. third")).toBe(
      "Title quoted first second third",
    );
  });

  it("leaves prose that merely looks like Markdown alone", () => {
    // A lone marker in ordinary text is far more common than broken emphasis,
    // so these must survive byte-for-byte.
    expect(plainText("P&L * 2 and snake_case and a_b_c")).toBe("P&L * 2 and snake_case and a_b_c");
    expect(plainText("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("drops fenced code and horizontal rules", () => {
    expect(plainText("before\n\n```\nconst x = 1;\n```\n\n---\n\nafter")).toBe("before after");
  });

  it("is a no-op on text that was never Markdown", () => {
    const plain = "Reads your own charts and runs a pre-open watchlist brief — never trades";
    expect(plainText(plain)).toBe(plain);
  });
});

describe("plainTextClamped", () => {
  it("returns short text untouched", () => {
    expect(plainTextClamped("**short**", 40)).toBe("short");
  });

  it("clamps on a word boundary and marks the cut", () => {
    const out = plainTextClamped("one two three four five six seven eight", 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toMatch(/\s…$/);
    // A boundary cut must not slice a word in half.
    expect(out.slice(0, -1).trim().split(" ").at(-1)).toBe("four");
  });

  it("still clamps when there is no usable word boundary", () => {
    const out = plainTextClamped("Supercalifragilisticexpialidocious", 12);
    expect(out).toBe("Supercalifr…");
    expect(out.length).toBe(12);
  });

  it("clamps the flattened length, not the raw length", () => {
    // 16 markup chars around 9 of text: clamping before stripping would cut it.
    expect(plainTextClamped("**bold text** and `x`", 40)).toBe("bold text and x");
  });
});
