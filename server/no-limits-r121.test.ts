// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { judge } from "./no-limits-code.ts";
import { JsReader } from "./no-limits-javascript.ts";
import * as shell from "./no-limits-shell.ts";
import { lexicalStrings, PyReader } from "./no-limits-python.ts";

const verdict = (code: string) => { const r = judge("python", code); return r.verdict + (r.cls ? ":" + r.cls : ""); };
describe("r1.2.1 review regressions", () => {
  it.each(["1e2", ".5", "0xff", "1_000", "1j"])("reads number %s without losing aliases", number => {
    expect(verdict(`import shutil as s\ns.rmtree('/')\nx = ${number}`)).toBe("card:root");
    expect(verdict(`import math as s\ns.sqrt(4)\nx = ${number}`)).toBe("run");
  });
  it("decodes named Unicode escapes", () => {
    expect(verdict(String.raw`os.system("\N{LATIN SMALL LETTER R}\N{LATIN SMALL LETTER M} -rf /")`)).toBe("card:root");
    expect(verdict(String.raw`print("\N{LATIN SMALL LETTER R}\N{LATIN SMALL LETTER M}")`)).toBe("run");
  });
  it("decodes named escapes inside f-strings without treating their braces as interpolation", () => {
    expect(verdict(String.raw`os.system(f"\N{LATIN SMALL LETTER R}\N{LATIN SMALL LETTER M} -rf /")`)).toBe("card:root");
    expect(verdict(String.raw`print(f"\N{GREEK SMALL LETTER ALPHA}")`)).toBe("run");
  });
  it("decodes Unicode control-name aliases", () => {
    expect(verdict(String.raw`os.system("rm\N{HT}-rf /")`)).toBe("card:root");
    expect(verdict(String.raw`os.system("ls\N{HT}./cache")`)).toBe("run");
  });
  it("keeps effects before a wide expression", () => {
    const tail = "[" + Array(200_000).fill("0").join(",") + "]";
    expect(verdict("import shutil as s\ns.rmtree('/')\n" + tail)).toBe("card:root");
  });
  it("follows breadth-first binding order", () => {
    expect(verdict("if True:\n    import shutil as s\nimport math as s\ns.rmtree('/')")).toBe("card:root");
    expect(verdict("if True:\n    import math as s\nimport shutil as s\ns.rmtree('/')")).toBe("run");
  });
  it("keeps elif suites at their ast.walk depth", () => {
    expect(verdict("if True:\n    import math as s\nelif False:\n    import shutil as s\nif True:\n    import math as s\ns.rmtree('/')")).toBe("card:root");
  });
  it("preserves Unicode escapes in bytes", () => {
    expect(verdict(String.raw`os.remove(b'\u002f')`)).toBe("card:word");
    expect(verdict(String.raw`print(b'\u002f')`)).toBe("run");
  });
  it("selects commands using Python strip whitespace", () => {
    expect(judge("mcp__s__run", { command: "\u001c", cmd: "rm ./cache" }).cls).toBe("word");
    expect(judge("mcp__s__run", { command: "\u001c", cmd: "printf ok" }).verdict).toBe("run");
  });
  it("retains effects when the walk throws", () => {
    const run = PyReader.prototype.run;
    const spy = vi.spyOn(PyReader.prototype, "run").mockImplementation(function(this: PyReader) {
      run.call(this); throw new RangeError("injected after collected effect");
    });
    try { expect(verdict("import shutil as s\ns.rmtree('/')")).toBe("card:root"); }
    finally { spy.mockRestore(); }
  });
  it("fails closed on an unexpected reader exception", () => {
    const spy = vi.spyOn(PyReader.prototype, "run").mockImplementation(() => { throw new Error("injected reader failure"); });
    try { expect(verdict("print(1)")).toBe("card:cut"); }
    finally { spy.mockRestore(); }
  });
  it("visits each fallback character at most once", () => {
    for (const count of [80, 10_000]) {
      const input = "'" + "\\".repeat(count);
      let visits = 0;
      expect(() => [...lexicalStrings(input, () => { visits++; })]).toThrow("unterminated");
      expect(visits).toBe(input.length);
      visits = 0;
      expect([...lexicalStrings(input + "'", () => { visits++; })]).toHaveLength(1);
      expect(visits).toBe(input.length + 1);
    }
  });
  it.each([80, 10_000])("bounds the unterminated fallback with %i backslashes", count => {
    const module = new URL("./no-limits-code.ts", import.meta.url).href;
    const code = `import { judge } from ${JSON.stringify(module)}; console.log(judge('python', ${JSON.stringify("'" + "\\".repeat(count))}).cls);`;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 3000 });
    expect(result.error?.message).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("cut");
  });
});


describe("r1.2.1 failure retention across reader boundaries", () => {
  it.each([Error, RangeError, SyntaxError])("cuts on a runtime %s after Python parsing", ErrorType => {
    const spy = vi.spyOn(PyReader.prototype, "run").mockImplementation(() => { throw new ErrorType("injected walk failure"); });
    try { expect(verdict("print('ok')")).toBe("card:cut"); }
    finally { spy.mockRestore(); }
  });
  it.each(["/", "./cache"])("retains the JavaScript twin for %s on an exception", target => {
    const run = JsReader.prototype.run;
    const spy = vi.spyOn(JsReader.prototype, "run").mockImplementation(function(this: JsReader) {
      run.call(this); throw new Error("injected after JS effects");
    });
    try { expect(judge("node", `require('fs').unlinkSync('${target}')`).cls).toBe(target === "/" ? "root" : "word"); }
    finally { spy.mockRestore(); }
  });
  it("cuts on JavaScript failure without effects", () => {
    const spy = vi.spyOn(JsReader.prototype, "run").mockImplementation(() => { throw new Error("injected JS failure"); });
    try { expect(judge("node", "console.log(1)").cls).toBe("cut"); }
    finally { spy.mockRestore(); }
  });
  it("retains a shell effect when its reader subsequently throws", () => {
    const read = shell.readShell;
    const spy = vi.spyOn(shell, "readShell").mockImplementation((...args) => {
      read(...args); throw new Error("injected shell failure");
    });
    try { expect(judge("terminal", "rm -rf /").cls).toBe("root"); }
    finally { spy.mockRestore(); }
  });
  it("queues twins before a failing literal scan", () => {
    const read = shell.readShell;
    const spy = vi.spyOn(shell, "readShell").mockImplementation((...args) => {
      if (args[3]) throw new Error("injected literal failure");
      return read(...args);
    });
    try { expect(verdict("import shutil as s; s.rmtree('/')")).toBe("card:root"); }
    finally { spy.mockRestore(); }
  });
  it.each(["terminal", "node", "mcp__s__run"])("bounds %s text", identity => {
    expect(judge(identity, " ".repeat(1_000_000)).cls).toBe("cut");
  });
  it("counts size in Python Unicode code points", () => {
    expect(verdict("#" + "😀".repeat(600_000))).toBe("run");
    expect(verdict("#" + "😀".repeat(999_999))).toBe("card:cut");
  });
  it("cuts cyclic input while preserving independent leaves", () => {
    const input: Record<string, unknown> = {}; input.self = input;
    expect(judge("mcp__s__note", input).cls).toBe("cut");
    input.text = "rm -rf /";
    expect(judge("mcp__s__note", input).cls).toBe("root");
    const shared = { text: "hello" };
    expect(judge("mcp__s__note", [shared, shared]).verdict).toBe("run");
  });
  it("bounds JavaScript scan work", () => {
    expect(judge("node", ";".repeat(400_000)).cls).toBe("cut");
  });
  it("cuts incomplete shell tokenization but permits unmatched quotes in prose", () => {
    expect(judge("terminal", "printf '").cls).toBe("cut");
    expect(judge("mcp__s__note", { text: "it's okay" }).verdict).toBe("run");
  });
});
