import { afterEach, describe, expect, it, vi } from "vitest";
import { codeFileExtension, codeFileName, codeLanguageLabel, codeLineCount, codeLineLabel, saveCodeSnippet, SNIPPET_URL_LIFETIME_MS } from "./code-block";
it("uses readable language names without confusing shell dialects", () => {
  expect(codeLanguageLabel(" TSX ")).toBe("TypeScript (TSX)"); expect(codeLanguageLabel("c++")).toBe("C++");
  expect(codeLanguageLabel("sh")).toBe("Shell"); expect(codeLanguageLabel("zsh")).toBe("Zsh");
  expect(codeLanguageLabel("")).toBe("Code"); expect(codeLanguageLabel("custom-lang")).toBe("custom-lang"); expect(codeLanguageLabel("constructor")).toBe("constructor");
});
it("counts rendered LF/CRLF and intentional trailing blank lines without changing text", () => {
  for (const [value, count] of [["", 0], ["one", 1], ["one\ntwo", 2], ["one\r\ntwo", 2], ["one\ntwo\n", 3], ["\n", 2]] as const) expect(codeLineCount(value)).toBe(count);
  expect(codeLineLabel("one")).toBe("1 line"); expect(codeLineLabel("one\ntwo")).toBe("2 lines");
});

// #979 (adapted): code-block Save.
describe("snippet file names", () => {
  it("maps known fence languages to their usual extension, ignoring case and spaces", () => {
    for (const [language, extension] of [
      ["ts", "ts"], ["typescript", "ts"], ["tsx", "tsx"], ["js", "js"], ["jsx", "jsx"], ["py", "py"], [" PYTHON ", "py"],
      ["sh", "sh"], ["bash", "sh"], ["zsh", "zsh"], ["ps1", "ps1"], ["json", "json"], ["jsonc", "json"], ["sql", "sql"],
      ["rust", "rs"], ["go", "go"], ["html", "html"], ["css", "css"], ["markdown", "md"], ["yml", "yaml"], ["c++", "cpp"],
      ["c#", "cs"], ["text", "txt"], ["bat", "bat"],
    ] as const) expect(codeFileExtension(language)).toBe(extension);
  });
  it("passes a short plain unknown token through as the extension", () => {
    expect(codeFileExtension("zig")).toBe("zig"); expect(codeFileExtension("nim")).toBe("nim"); expect(codeFileExtension("x86-asm")).toBe("x86-asm");
  });
  it("falls back to txt for empty, long, traversal-like, prototype and launcher-type hints", () => {
    for (const language of [
      "", "   ", null, undefined, "averylongunknownlanguage", "../../etc/passwd", "ts/../x", "..\\..\\x", "a.b", "..", ".",
      "c:\\x", "foo bar", "\u202Eexe", "__proto__", "-rf", "_x", "exe", "EXE", "hta", "lnk", "scr", "msi", "vbs", "command", "desktop",
    ]) expect(codeFileExtension(language)).toBe("txt");
  });
  it("names a snippet file after its language and never lets the hint shape the name", () => {
    expect(codeFileName("python")).toBe("snippet.py"); expect(codeFileName("")).toBe("snippet.txt"); expect(codeFileName(null)).toBe("snippet.txt");
    expect(codeFileName("Dockerfile")).toBe("Dockerfile"); expect(codeFileName("make")).toBe("Makefile");
    for (const language of ["../Dockerfile", "../../etc/passwd", "/tmp/x", "C:\\Windows\\x", "con", "%2e%2e", "snippet.py"]) {
      const name = codeFileName(language);
      expect(name).toMatch(/^snippet\.[a-z0-9][a-z0-9_-]{0,7}$/);
      expect(name).not.toMatch(/[\\/:]/);
    }
  });
});

describe("saveCodeSnippet", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  function fakeDocument(click: () => void = () => {}) {
    const link = { href: "", download: "", rel: "", click: vi.fn(click), remove: vi.fn() };
    const appendChild = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild } });
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:snippet");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    return { link, appendChild, create, revoke, fetch };
  }

  it.each([
    ["CRLF, blank lines and tabs", "line1\r\n\r\n\tline3\r\n"],
    ["Unicode and emoji", "print(\"naïve café ✓ 日本語 👩‍💻\")\n\n\n"],
    ["a leading BOM already in the text", "\uFEFFkey = value"],
    ["no trailing newline", "SELECT 1"],
  ])("hands over the exact UTF-8 bytes for %s, adding nothing", async (_label, code) => {
    vi.useFakeTimers();
    const { link, create } = fakeDocument();
    expect(saveCodeSnippet("snippet.py", code)).toBe(true);
    expect(link.download).toBe("snippet.py"); expect(link.href).toBe("blob:snippet"); expect(link.click).toHaveBeenCalledOnce();
    const blob = create.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/plain;charset=utf-8");
    expect(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(code, "utf8"))).toBe(true);
  });

  it.each([false, true])("removes the link and revokes the URL after the click task, even when clicking throws (%s)", (fails) => {
    vi.useFakeTimers();
    const { link, appendChild, revoke, fetch } = fakeDocument(() => { if (fails) throw new Error("Download blocked"); });
    if (fails) expect(() => saveCodeSnippet("snippet.ts", "x")).toThrow("Download blocked");
    else expect(saveCodeSnippet("snippet.ts", "x")).toBe(true);
    expect(appendChild).toHaveBeenCalledWith(link); expect(link.remove).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SNIPPET_URL_LIFETIME_MS - 1); expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:snippet");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("types an extensionless name as octet-stream so the browser keeps the name as given", async () => {
    vi.useFakeTimers();
    const { create } = fakeDocument();
    expect(saveCodeSnippet("Dockerfile", "FROM node:24")).toBe(true);
    const blob = create.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("application/octet-stream");
    expect(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from("FROM node:24", "utf8"))).toBe(true);
  });

  it("reports that nothing was requested when there is no document", () => {
    const create = vi.spyOn(URL, "createObjectURL");
    expect(saveCodeSnippet("snippet.txt", "x")).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
