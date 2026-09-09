import { expect, it } from "vitest";
import { codeLanguageLabel, codeLineCount, codeLineLabel } from "./code-block";
it("uses readable language names without confusing shell dialects", () => {
  expect(codeLanguageLabel(" TSX ")).toBe("TypeScript (TSX)"); expect(codeLanguageLabel("c++")).toBe("C++");
  expect(codeLanguageLabel("sh")).toBe("Shell"); expect(codeLanguageLabel("zsh")).toBe("Zsh");
  expect(codeLanguageLabel("")).toBe("Code"); expect(codeLanguageLabel("custom-lang")).toBe("custom-lang"); expect(codeLanguageLabel("constructor")).toBe("constructor");
});
it("counts rendered LF/CRLF and intentional trailing blank lines without changing text", () => {
  for (const [value, count] of [["", 0], ["one", 1], ["one\ntwo", 2], ["one\r\ntwo", 2], ["one\ntwo\n", 3], ["\n", 2]] as const) expect(codeLineCount(value)).toBe(count);
  expect(codeLineLabel("one")).toBe("1 line"); expect(codeLineLabel("one\ntwo")).toBe("2 lines");
});
