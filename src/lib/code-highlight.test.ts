import { describe, expect, it } from "vitest";
import { highlightCode, resolveHighlightLanguage } from "./code-highlight";

describe("code highlighting loads Shiki core", () => {
  it("maps fence names and aliases to the shipped grammars", () => {
    expect(resolveHighlightLanguage("ts")).toBe("typescript");
    expect(resolveHighlightLanguage("JS")).toBe("javascript");
    expect(resolveHighlightLanguage("py")).toBe("python");
    expect(resolveHighlightLanguage("zsh")).toBe("bash");
    expect(resolveHighlightLanguage("brainfuck")).toBeNull();
    expect(resolveHighlightLanguage("")).toBeNull();
    expect(resolveHighlightLanguage("constructor")).toBeNull();
  });
  it("colours typescript, javascript and python", async () => {
    for (const [lang, code] of [["ts", "const a: number = 1;"], ["js", "function f() { return 1 }"], ["python", "def f():\n    return 1"]] as const) {
      const html = await highlightCode(code, lang);
      expect(html).toContain("<span");
      expect(html).toContain("shiki");
    }
  }, 30_000);
  it("renders an unknown language as plain text, not an error", async () => {
    const html = await highlightCode("hello <b>", "brainfuck");
    expect(html).toContain("hello");
    expect(html).toContain("&#x3C;b>");
  }, 30_000);
});
