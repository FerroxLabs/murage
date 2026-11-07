// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (S10, Grok r7 on 51bec1dfe and MurageMain's ruling 11-07): the outside scan reads a text in time linear in its
// length. Each fix below has a row that the old reader fails, and the scan carries a work budget, linear in the text's
// length, that fails closed (the text marks `interpreter`, with a logged reason) and never passes.
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  ASSIGN_REFERENCES, assignReadersForTests, braceBodiesForTests, FAIL_CLOSED_MARKS, longShellOptionReference, optionRunTable, outsideScanMarks,
  partsOfForTests, partsOfReference, SCAN_GATE_CHARS, scanFailClosed, SET_EXPORTS_REFERENCE, setExportsForTests, shellOptionReference,
} from "./outside-scan.ts";

const LIMIT_MS = 100;
const fill = (unit: string, chars = SCAN_GATE_CHARS): string => unit.repeat(Math.floor(chars / unit.length));
/** The best of three runs (a garbage collection or a busy test box can stall one; an O(n²) reader is slow on every run). */
function timed(text: string): { ms: number; marks: string[]; failedClosed: number } {
  const before = scanFailClosed.count;
  let ms = Infinity;
  let marks: string[] = [];
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    marks = outsideScanMarks(text);
    ms = Math.min(ms, performance.now() - start);
    if (ms > 20 * LIMIT_MS) break;
  }
  return { ms, marks, failedClosed: Math.min(1, scanFailClosed.count - before) };
}
/** Read in linear time, without the budget's help: under LIMIT_MS and not failed closed. */
function linear(text: string): string[] {
  const run = timed(text);
  expect(run.failedClosed, `failed closed: ${scanFailClosed.reason}`).toBe(0);
  expect(run.ms, `${JSON.stringify(text.slice(0, 24))}… (${text.length} chars)`).toBeLessThan(LIMIT_MS);
  return run.marks;
}
let seed = 11;
const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648);
const pick = <T,>(list: readonly T[]): T => list[next() % list.length]!;
const spell = (alphabet: readonly string[], max: number): string => Array.from({ length: next() % max }, () => pick(alphabet)).join("");

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  // warm the readers so the first timed row does not pay for compiling them
  for (let k = 0; k < 3; k++) outsideScanMarks(fill("echo a ${b} ", 4096));
});

// @fix:1
describe("Grok r7 #1: `${…}` bodies are read once each, outermost first", () => {
  it("returns only the outermost closed bodies, in text order", () => {
    expect(braceBodiesForTests("${a${b}}x${c}")).toEqual(["a${b}", "c"]);
    expect(braceBodiesForTests("${ ${x}")).toEqual(["x"]);
    expect(braceBodiesForTests("{ ${a} } ${b{c}d}")).toEqual(["a", "b{c}d"]);
    expect(braceBodiesForTests("${a")).toEqual([]);
    expect(braceBodiesForTests("}${a}}")).toEqual(["a"]);
  });

  it("reads a body nested six deep as seven texts, not one per ancestor chain", () => {
    const before = scanFailClosed.texts;
    outsideScanMarks("echo ${a${b${c${d${e${f}}}}}}");
    expect(scanFailClosed.texts - before).toBe(7);
  });

  it("still marks inside a nested body", () => {
    expect(outsideScanMarks("echo ${a:-${b:-$(curl x)}}")).toContain("network command");
  });

  it("reads an unclosed `${` run at 128 KiB in linear time", () => {
    linear(fill("${"));
  });
});

// @fix:2
describe("Grok r7 #2: the words after an interpreter are read in place", () => {
  it("reads `node ` 26,214 times in linear time", () => {
    expect(linear("node ".repeat(26214))).toContain("interpreter");
  });

  it("keeps the safe shapes", () => {
    expect(outsideScanMarks("node --version")).toEqual([]);
    expect(outsideScanMarks("node build.js")).toEqual([]);
    expect(outsideScanMarks("node -e x")).toContain("interpreter");
  });
});

// @fix:3
describe("Grok r7 #3: a shell word's options and script come from one backward pass", () => {
  it("reads `sh ` 43,690 times and `-x/sh ` (an option word that is a shell) in linear time", () => {
    linear("sh ".repeat(43690));
    linear(fill("-x/sh "));
  });

  it("the option table gives the walk's answer at every index", () => {
    const WORDS = ["sh", "-s", "-c", "-i", "-l", "-ic", "-xl", "--login", "--", "-", "-S", "-1", "--norc", "x", "-x/sh", "a.sh"];
    let checked = 0;
    for (let n = 0; n < 3000; n++) {
      const segment = Array.from({ length: next() % 12 }, () => pick(WORDS));
      const table = optionRunTable(segment);
      for (let i = 0; i < segment.length; i++) {
        const bits = table[i + 1]!;
        ["s", "c", "i", "l"].forEach((letter, k) => expect(((bits >> k) & 1) === 1, JSON.stringify({ segment, i, letter })).toBe(shellOptionReference(segment, i, letter)));
        expect(((bits >> 4) & 1) === 1).toBe(longShellOptionReference(segment, i, "--login"));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("still marks a shell reading stdin, a login shell and a script the text writes", () => {
    expect(outsideScanMarks("sh -x -s")).toContain("interpreter");
    expect(outsideScanMarks("bash --norc --login")).toContain("interpreter");
    expect(outsideScanMarks("echo x > a.sh; sh -e a.sh")).toContain("interpreter");
  });
});

// @fix:4
describe("Grok r7 #4: each folder change's target comes from one backward pass", () => {
  it("reads `cd ` 43,690 times, and `sudo cd ` (every `cd` in command position) at 128 KiB, in linear time", () => {
    linear("cd ".repeat(43690));
    linear(fill("sudo cd "));
    linear(fill("time pushd "));
  });

  it("still marks a folder change to an unknown place before a run", () => {
    expect(outsideScanMarks("cd -L $HOME; ls")).toContain("interpreter");
    expect(outsideScanMarks("cd -P -; ls")).toContain("interpreter");
  });
});

// @fix:5
describe("Grok r7 #5: `set -a` is read as one word, not by a backtracking regex", () => {
  it("reads `set -` and 100,000 `a` then `!` in linear time", () => {
    linear("set -" + "a".repeat(100000) + "!");
  });

  it("gives the regex's answer on random texts", () => {
    const ALPHABET = ["set", " ", "  ", "-", "a", "b", "o", "allexport", "/a", "x", "=", ";", "|", ")", "(", "!", "\n", "`", "{"];
    for (let n = 0; n < 20000; n++) {
      const view = spell(ALPHABET, 10);
      expect(setExportsForTests(view), JSON.stringify(view)).toBe(SET_EXPORTS_REFERENCE.test(view));
    }
  });
});

// @fix:6
describe("Grok r7 #6: an option word's parts come from one loop", () => {
  it("reads excessive option depth fail-closed in linear time and accepts level sixteen", () => {
    const times = [8192, 32768, 131072].map(k => {
      const run = timed(fill("-a=", k)); expect(run.marks).toEqual(ALL11);
      expect(scanFailClosed.reason).toMatch(/16.*levels/); expect(run.ms).toBeLessThan(100); return run.ms;
    });
    expect(times[2]!).toBeLessThanOrEqual(24 * Math.max(times[0]!, 1));
    expect(timed("-a=".repeat(20000)).marks).toEqual(ALL11);
    linear("-a=".repeat(16) + "x"); linear(fill("-a=".repeat(16) + "x "));
  });

  it("gives the recursive reader's parts on every word up to level 16", () => {
    const ALPHABET = ["-", "--", "a", "=", "/", "\\", "curl", ".exe", "x", "mkfs", "git-"];
    for (let n = 0; n < 20000; n++) {
      const word = spell(ALPHABET, 12);
      if (word.split("=").length > 17) continue;
      expect(partsOfForTests(word), JSON.stringify(word)).toEqual(partsOfReference(word));
    }
  });
});

// @fix:7
describe("MurageMain's fuzz: the assignment regexes are read without backtracking", () => {
  it("gives each regex's answer on random texts", () => {
    const ALPHABET = ["a", "_", "1", "[", "]", "=", "+", " ", "\n", ";", "(", "{", "`", "$(", "then ", "do ", "!", "'", "\"", "printf", "-v", "|", "&", "\t"];
    for (let n = 0; n < 20000; n++) {
      const view = spell(ALPHABET, 12);
      expect(assignReadersForTests.m2(view), `m2 ${JSON.stringify(view)}`).toBe(ASSIGN_REFERENCES.m2.test(view));
      expect(assignReadersForTests.printf(view), `printf ${JSON.stringify(view)}`).toBe(ASSIGN_REFERENCES.printf.test(view));
      expect(assignReadersForTests.assign(view), `assign ${JSON.stringify(view)}`).toBe(ASSIGN_REFERENCES.assign.test(view));
    }
  });

  it("reads `(a[`, newlines, `printf ` and ` a[` runs at 128 KiB in linear time", () => {
    for (const unit of ["(a[", "\n", "printf ", " a[", "\nthen ", "(a[x]"]) linear(fill(unit));
  });
});

// @fix:8
describe("the work budget (MurageMain's ruling 11-07)", () => {
  it("fails closed with a logged reason on a text that would cost more than its length allows", () => {
    const run = timed("${".repeat(120) + "a" + "}".repeat(120));
    expect(run.failedClosed).toBe(1);
    expect(run.marks).toEqual(ALL11);
    expect(scanFailClosed.reason).toMatch(/work budget spent/);
    expect(run.ms).toBeLessThan(LIMIT_MS);
  });

  it("does not fire on a plain text just below the gate, which stays clean", () => {
    expect(linear(fill("echo a\n", SCAN_GATE_CHARS - 2048))).toEqual([]);
    expect(linear(fill("git status && ls -la ${HOME}/src | grep -n x; ", SCAN_GATE_CHARS - 2048))).toEqual([]);
  });

  it("every pathological input from both Grok r7 reports, and each repeated unit at 128 KiB, finishes under 100 ms", () => {
    const grok = [
      "${".repeat(120) + "a" + "}".repeat(120), "${".repeat(65536), "node ".repeat(26214), "sh ".repeat(43690), "cd ".repeat(43690),
      "set -" + "a".repeat(100000) + "!", "-a=".repeat(20000), "[".repeat(SCAN_GATE_CHARS), "cat <<'EOF'\n" + "[".repeat(60000) + "\nEOF",
      fill("FUIGO_HOME "), "[".repeat(200000), "echo " + "-env ".repeat(26213), fill("env "), fill("$env:a "),
    ];
    const UNITS = ["[", "${", "node ", "sh ", "cd ", "set -a", "-a=", "set -a ", "(a[", "\n", "printf ", " a[", "-x/sh ", "$'", "{", "}",
      "${a:-", "$(", "`", "\\", "'", "\"", ";", "then ", "eval ", "py1", "a=", "/", "-", "-s ", "exec -l ", "pushd ", "env -u ", "x=y ", "sudo cd ", "sudo sh ", "then node "];
    const mixes = Array.from({ length: 24 }, () => { let s = ""; while (s.length < SCAN_GATE_CHARS - 16) s += pick(UNITS); return s.slice(0, SCAN_GATE_CHARS); });
    let slowest = 0;
    for (const text of [...grok, ...UNITS.map((unit) => fill(unit)), ...mixes]) {
      const run = timed(text);
      slowest = Math.max(slowest, run.ms);
      expect(run.ms, `${JSON.stringify(text.slice(0, 24))}… (${text.length} chars, failed closed ${run.failedClosed})`).toBeLessThan(LIMIT_MS);
      // a text the budget stops still marks: it never passes
      if (run.failedClosed > 0) expect(run.marks).toContain("interpreter");
    }
    expect(slowest).toBeLessThan(LIMIT_MS);
  });

  it("all-distinct words (no word read twice) cost in proportion to the text: four times the text, at most about four times the time", () => {
    const shapes = [(k: number) => `-v${k.toString(36)}`, (k: number) => `py${k}`, (k: number) => `sh -${k.toString(36)};`];
    for (const shape of shapes) {
      const text = (chars: number) => { let s = ""; for (let k = 0; s.length < chars; k++) s += `${shape(k)} `; return s.slice(0, chars); };
      const small = timed(text(SCAN_GATE_CHARS / 4));
      const large = timed(text(SCAN_GATE_CHARS));
      expect(small.failedClosed + large.failedClosed).toBe(0);
      expect(large.ms, `${shape(1)}: ${small.ms.toFixed(1)} ms at 32 KiB, ${large.ms.toFixed(1)} ms at 128 KiB`).toBeLessThan(6 * small.ms + 20);
      expect(large.ms).toBeLessThan(3 * LIMIT_MS);
    }
  });
});


// Frozen r11/r11.1/r11.2 regression rows. Expected marks are independent of the implementation.
import * as scan11 from "./outside-scan.ts";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
const ALL11 = ["interpreter", "downloaded file", "cloned folder", "network command", "package install", "git", "archive"];
const finalHook11 = { cwd: "/", registry: (_folder: string, implied: boolean) => {
  if (implied) { try { outsideScanMarks("node ".repeat(26214)); } catch {} } return null;
} };
function best11(run: () => unknown): number {
  let best = Infinity;
  for (let n = 0; n < 3; n++) { const start = performance.now(); run(); best = Math.min(best, performance.now() - start); }
  return best;
}
describe("S10 frozen r11", () => {
  it("R1 whole level eight", () => {
    const before = scanFailClosed.count;
    expect(outsideScanMarks("-a=".repeat(8) + "git-status=x")).toContain("git");
    expect(scanFailClosed.count).toBe(before);
  });
  it("R1b whole level sixteen and fail at seventeen", () => {
    const w = "-a=".repeat(16) + "git-status=x";
    expect(partsOfForTests(w)).toEqual(partsOfReference(w));
    const before = scanFailClosed.count;
    expect(outsideScanMarks(w)).toContain("git");
    expect(outsideScanMarks(w)).not.toEqual(ALL11);
    expect(scanFailClosed.count).toBe(before);
    expect(outsideScanMarks("-a=" + w)).toEqual(ALL11);
    expect(scanFailClosed.reason).toMatch(/16.*levels/);
  });
  it("R2 swallowed final implied-cwd budget", () => expect(outsideScanMarks("ls", finalHook11)).toEqual(ALL11));
  it("R2b RangeError crosses nested entry", () => {
    expect(outsideScanMarks("ls", { cwd: "/", registry: () => {
      try { outsideScanMarks("ls", { cwd: "/", registry: () => { throw new RangeError("deep"); } }); } catch {}
      return null;
    } })).toEqual(ALL11);
  });
  it("R3 listB callers cannot mutate the memo", () => {
    const text = "curl http://x";
    expect(outsideScanMarks(text, { registry: () => {
      const a = scan11.listB(text), b = scan11.listB(text);
      expect(a).not.toBe(b); a.forEach(s => s.length = 0); return null;
    } })).toEqual(["network command"]);
  });
  it("R4 recursive cluster timing with registry", () => {
    const times = [8192, 32768, 131072].map(k => best11(() => expect(outsideScanMarks("grep -" + "r".repeat(k - 8) + "!", { registry: () => null })).toEqual([])));
    expect(times[2]).toBeLessThan(100); expect(times[2]!).toBeLessThanOrEqual(24 * Math.max(times[0]!, 1));
  });
  it("H1 recursive cluster equivalence", () => {
    const reference = /^-[a-z]*r[a-z]*$/i;
    for (let n = 0; n < 20000; n++) { const w = spell(["-", "r", "R", "a", "A", "z", "Z", "!", "=", "\n", "é"], 25);
      expect(scan11.recursiveClusterForTests(w), JSON.stringify(w)).toBe(reference.test(w)); }
  });
  it("R6 readOnlyShape gate", () => {
    const hooks = { lookupProgram: () => "/bin/cat" };
    expect(scan11.readOnlyShape("cat " + "a".repeat(131069), hooks)).toBe(false);
    const times = [8192, 32768, 131072].map(k => best11(() => expect(scan11.readOnlyShape("cat " + "a".repeat(k - 4), hooks)).toBe(true)));
    expect(times[2]).toBeLessThan(20); expect(times[2]!).toBeLessThanOrEqual(24 * Math.max(times[0]!, 1));
  });
  it("R7 every fail-closed mark", () => expect(outsideScanMarks("x".repeat(SCAN_GATE_CHARS + 1))).toEqual(ALL11));
  it("R8 NFKC gate", () => expect(outsideScanMarks("\uFDFA".repeat(7282))).toEqual(ALL11));
  it("R8b lowercase expansion gate", () => expect(outsideScanMarks("İ".repeat(70000) + " node x")).toEqual(ALL11));
  it("R8c gate before joining continuations", () => {
    expect(outsideScanMarks("\uFDFA".repeat(7100) + "\\\n".repeat(2000), { cwd: "/", probe: () => null, lookupProgram: () => null })).toEqual(ALL11);
    expect(scanFailClosed.reason).toBe("the normalized text is past the gate");
  });
  it("R9 bodies at depth four", () => expect(outsideScanMarks("echo ${git-status=x}", {}, 4)).toContain("git"));
  it("R10 nested lookup cannot return after swallowing a failure", () => {
    let got = "not called";
    const marks = outsideScanMarks("ls", { cwd: "/", registry: () => {
      try { outsideScanMarks("cat x", { cwd: "/", probe: () => null, lookupProgram: () => {
        try { outsideScanMarks("ls", { cwd: "/", registry: () => { throw new RangeError("deep"); } }); } catch {}
        return null;
      } }, 1); got = "returned"; } catch { got = "threw"; }
      return null;
    } });
    expect(got).toBe("threw"); expect(marks).toEqual(ALL11);
  });
  // Regression: nested final callbacks must preserve a swallowed failure.
  it("M14: nested final callback cannot return after swallowed failure", () => {
    let nestedOutcome: "not called" | "threw" | "returned" = "not called";
    let nestedMarks: unknown;
    const result = outsideScanMarks("ls", { cwd: "/", registry: (_word, implied) => {
      if (!implied) return null;
      try {
        nestedMarks = outsideScanMarks("ls", { cwd: "/", registry: (_w, innerImplied) => {
          if (!innerImplied) return null;
          try { outsideScanMarks("ls", { cwd: "/", registry: () => { throw new RangeError("deep"); } }); } catch { /* swallow C's recorded failure */ }
          return null;
        } });
        nestedOutcome = "returned";
      } catch { nestedOutcome = "threw"; }
      return null;
    } });
    expect(nestedOutcome).toBe("threw"); expect(nestedMarks).toBeUndefined(); expect(result).toEqual(FAIL_CLOSED_MARKS);
  });
  it("R11 exactly one finalization on gate catch and sticky return", () => {
    for (const [text, hooks, reason] of [["x".repeat(SCAN_GATE_CHARS + 1), {}, /past the gate/], ["${".repeat(120) + "a" + "}".repeat(120), {}, /work budget/], ["ls", finalHook11, /work budget/]] as const) {
      const before = scanFailClosed.count; const log = vi.spyOn(console, "error").mockImplementation(() => {}); log.mockClear();
      expect(outsideScanMarks(text, hooks)).toEqual(ALL11); expect(scanFailClosed.count - before).toBe(1);
      expect(scanFailClosed.reason).toMatch(reason); expect(log).toHaveBeenCalledTimes(1);
    }
  });
  it("R13 per-level accounting", () => {
    const w = "-a=".repeat(16) + "x";
    expect(scan11.partsSpendForTests(w)).toBe(Array.from({ length: 17 }, (_, i) => w.slice(i * 3).length + 1).reduce((a,b) => a+b, 0));
  });
  it("M13a entry resets an outside oracle failure", () => {
    try { partsOfForTests("-a=".repeat(17) + "x"); } catch {}
    expect(outsideScanMarks("ls")).toEqual([]);
  });
  it("M18 installPrograms fails closed outside a scan", () => expect(scan11.installPrograms("npm " + "-a=".repeat(17) + "x")).toEqual(["an install Murage could not read"]));
  it("R15 C6 finally resets before another scan", () => {
    expect(scan11.installPrograms("npm " + "-a=".repeat(17) + "x")).toEqual(["an install Murage could not read"]);
    expect(scan11.scanStateForTests().failed).toBeNull();
  });
  it("R14 scoped after-check", () => {
    let got: unknown;
    const marks = outsideScanMarks("ls", { cwd: "/", registry: () => {
      try { got = scan11.readOnlyShape("cat", { lookupProgram: () => {
        try { outsideScanMarks("ls", { cwd: "/", registry: () => { throw new RangeError("deep"); } }); } catch {}
        return "/bin/cat";
      } }); } catch { got = "threw"; } return null;
    } }); expect(got).toBe("threw"); expect(marks).toEqual(ALL11);
  });
  it("R14b scoped before-check for C6 readers", () => {
    for (const reader of [scan11.plainWipe, scan11.installPrograms]) {
      let threw = false;
      const marks = outsideScanMarks("ls", { cwd: "/", registry: () => {
        try { outsideScanMarks("ls", { cwd: "/", registry: () => { throw new RangeError("deep"); } }); } catch {}
        try { reader("cat"); } catch { threw = true; } return null;
      } }); expect(threw).toBe(true); expect(marks).toEqual(ALL11);
    }
  });
  it("R14c scoped catch records a swallowed RangeError", () => {
    let got: unknown;
    const marks = outsideScanMarks("ls", { cwd: "/", registry: () => {
      try { scan11.readOnlyShape("cat", { lookupProgram: () => { throw new RangeError("deep"); } }); } catch {}
      try { got = scan11.readOnlyShape("cat", { lookupProgram: () => "/bin/cat" }); } catch { got = "threw"; } return null;
    } }); expect(got).toBe("threw"); expect(marks).toEqual(ALL11);
  });
  it("R14d C6 records and rethrows inside the body", () => {
    for (const [reader, text] of [[scan11.plainWipe, "cat"], [scan11.installPrograms, "npm install x"]] as const) {
      let threw = false, recorded = false;
      const marks = outsideScanMarks("ls", { cwd: "/", registry: (_folder, implied) => {
        if (implied) { const normalize = String.prototype.normalize;
          try { String.prototype.normalize = () => { throw new RangeError("C6"); };
            try { reader(text); } catch { threw = true; }
            recorded = scan11.scanStateForTests().failed !== null;
          } finally { String.prototype.normalize = normalize; }
        } return null;
      } }); expect(threw).toBe(true); expect(recorded).toBe(true); expect(marks).toEqual(ALL11);
    }
  });
});

it("the inventory holds: no REWRITE regex is left and every cap is in place", () => {
  const source = readFileSync(new URL("./outside-scan.ts", import.meta.url), "utf8");
  for (const forbidden of ["/^-[a-z]*r[a-z]*$/i", "/:.*$/", "/[. ]+$/", "(?:^|[;&|(`\\n]|\\$\\()\\s*(?:(?:sudo"]) expect(source).not.toContain(forbidden);
  expect(source).toMatch(/const PARTS_WHOLE_LEVELS = 16;/); expect(SCAN_GATE_CHARS).toBe(128 * 1024);
  const ast = ts.createSourceFile("outside-scan.ts", source, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Node>();
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) bindings.set(node.name.text, node);
    if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) bindings.set(d.name.text, d.initializer);
  }
  const resolve = (node: ts.Node | undefined, seen = new Set<string>()): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined => {
    if (!node) return;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return resolve(node.expression, seen);
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node;
    if (ts.isIdentifier(node) && !seen.has(node.text)) { seen.add(node.text); return resolve(bindings.get(node.text), seen); }
    return;
  };
  const scoped = new Set(["plainWipe", "listB", "installPrograms", "readOnlyShape", "optionRunTable", "envSplitsTable", "decodeAnsiC", "nodeOptionWords"]);
  const state = new Set(["noteEngineEnv", "engineEnvDenied", "enginePathFromEnv", "noteEnginePath", "enginePathOf", "forgetEngineEnv", "engineEnvLoadsCode"]);
  const oracles = new Set(["partsOfReference", "shellOptionReference", "longShellOptionReference", "envSplitsReference"]);
  const data: Record<string, (n: ts.Node) => boolean> = {
    SCAN_WORK_PER_CHAR: ts.isNumericLiteral, SCAN_WORK_BASE: ts.isBinaryExpression, SCAN_GATE_CHARS: ts.isBinaryExpression,
    HOOK_KEYS: ts.isObjectLiteralExpression,
    scanFailClosed: ts.isObjectLiteralExpression, ASSIGN_REFERENCES: ts.isObjectLiteralExpression,
    assignReadersForTests: ts.isObjectLiteralExpression, SET_EXPORTS_REFERENCE: n => n.kind === ts.SyntaxKind.RegularExpressionLiteral,
    UNREAD_INSTALL: ts.isStringLiteral,
    FAIL_CLOSED_MARKS: n => ts.isCallExpression(n) && n.expression.getText(ast) === "Object.freeze" && n.arguments.length === 1 && ts.isArrayLiteralExpression(n.arguments[0]!),
  };
  const types = new Set(["OutsideMark", "OutsideScanHooks", "DiskProbe", "ReadOnlyHooks"]);
  const seen = new Set<string>();
  function classify(name: string, node: ts.Node | undefined) {
    expect(seen.has(name), name).toBe(false); seen.add(name);
    const callable = resolve(node);
    if (callable) {
      const categories = [name === "outsideScanMarks", scoped.has(name), state.has(name), oracles.has(name) || name.endsWith("ForTests")];
      expect(categories.filter(Boolean).length, name).toBe(1);
      if (scoped.has(name)) {
        expect(callable.body && ts.isBlock(callable.body), name).toBe(true);
        const first = (callable.body as ts.Block).statements[0];
        expect(first?.getText(ast), name).toMatch(/^return scoped\(/);
      }
    } else { expect(node && data[name]?.(node), `unresolved export ${name}`).toBe(true); }
  }
  for (const node of ast.statements) {
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) throw new Error(`unresolved export form: ${node.getText(ast)}`);
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    expect(ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword), "unresolved default export").not.toBe(true);
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) { expect(types.has(node.name.text), node.name.text).toBe(true); seen.add(node.name.text); }
    else if (ts.isFunctionDeclaration(node) && node.name) classify(node.name.text, node);
    else if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) throw new Error("unresolved exported binding pattern"); classify(d.name.text, d.initializer);
    }
    else throw new Error(`unresolved export form: ${node.getText(ast)}`);
  }
  for (const name of [...scoped, ...state, ...oracles, ...types, ...Object.keys(data), "outsideScanMarks"]) expect(seen.has(name), name).toBe(true);
  function visitDir(url: URL) {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), url);
      if (entry.isDirectory()) visitDir(child);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const file = ts.createSourceFile(entry.name, readFileSync(child, "utf8"), ts.ScriptTarget.Latest, true);
        const visit = (n: ts.Node) => { if (ts.isCallExpression(n) && n.expression.getText(file) === "outsideScanMarks") expect(n.arguments.length, child.pathname).toBeLessThan(3); ts.forEachChild(n, visit); }; visit(file);
      }
    }
  }
  visitDir(new URL("./", import.meta.url)); visitDir(new URL("../shared/", import.meta.url));
});

const scanGenerators11: Array<(k: number) => string> = [
  k => "grep -" + "r".repeat(k - 8) + "!", k => "-a=".repeat(Math.floor((k - 12) / 3)) + "git-status=x",
  k => "\uFDFA".repeat(Math.floor(k / 18)), k => "\uFDFA".repeat(Math.floor(k / 20)) + "\\\n".repeat(Math.floor(k / 20)),
  k => "İ".repeat(Math.floor(k / 2)), k => fill("${", k), k => fill("node ", k), k => fill("sh ", k),
  k => fill("cd ", k), k => "set -" + "a".repeat(k - 6) + "!", k => fill("(a[", k), k => fill("printf ", k),
  k => fill(" a[", k), k => fill("env ", k), k => fill("-x/sh ", k),
];
it("S8 adversarial sweeps and three hook passes", () => {
  for (const [g, shape] of scanGenerators11.entries()) {
    const times = [8192, 32768, 131072].map(k => {
      const text = shape(k), reference = outsideScanMarks(text);
      const hooks: scan11.OutsideScanHooks[] = [
        { cwd: "/", registry: () => { try { outsideScanMarks(text); } catch {} return null; } },
        { cwd: "/", registry: () => { scan11.listB(text).forEach(s => s.length = 0); return null; } },
        { cwd: "/", probe: () => null, lookupProgram: () => { try { outsideScanMarks(text); } catch {} return null; } },
      ];
      for (const hook of hooks) {
        const marks = outsideScanMarks(text, hook);
        expect(JSON.stringify(marks) === JSON.stringify(reference) || JSON.stringify(marks) === JSON.stringify(ALL11), `generator ${g}, seed 11, ${JSON.stringify(text.slice(0,80))}`).toBe(true);
      }
      const run = timed(text); if (run.failedClosed) expect(run.marks).toEqual(ALL11); return run.ms;
    });
    expect(times[2], `generator ${g}`).toBeLessThan(100); expect(times[2]!).toBeLessThanOrEqual(24 * Math.max(times[0]!, 1));
  }
});
it("S8 fixed-seed 2000 texts per generator at 128 KiB", { timeout: 7_200_000 }, () => {
  let seed = 11; const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const alphabet = ["=", ":", ".", "\n", "\u2028", "\uFDFA", "İ", "-"];
  for (const [g, shape] of scanGenerators11.entries()) for (let n = 0; n < 2000; n++) {
    const prefix = shape(SCAN_GATE_CHARS - 32); const suffix = Array.from({length: 16}, () => alphabet[next() % alphabet.length]).join("");
    const text = (prefix + " ".repeat(SCAN_GATE_CHARS) + suffix).slice(0, SCAN_GATE_CHARS - suffix.length) + suffix;
    const reference = outsideScanMarks(text);
    for (const hook of [
      { cwd: "/", registry: () => { try { outsideScanMarks(text); } catch {} return null; } },
      { cwd: "/", registry: () => { scan11.listB(text).forEach(s => s.length = 0); return null; } },
      { cwd: "/", probe: () => null, lookupProgram: () => { try { outsideScanMarks(text); } catch {} return null; } },
    ]) {
      const marks = outsideScanMarks(text, hook);
      expect(JSON.stringify(marks) === JSON.stringify(reference) || JSON.stringify(marks) === JSON.stringify(ALL11), `generator ${g}, seed ${seed}, ${JSON.stringify(text.slice(0,80))}`).toBe(true);
    }
  }
});


const guardH = scan11.guardHooksForTests;
const fixturesH: Record<keyof typeof scan11.HOOK_KEYS, { text: string; depth?: number; reason?: string }> = {
  pwsh: { text: "echo", depth: 1 }, cwd: { text: "echo", depth: 1 },
  sessionEdits: { text: "echo", depth: 1 }, registry: { text: "echo" }, repo: { text: "git status" },
  home: { text: "bun a.js", depth: 1 }, probe: { text: "cat x", depth: 1 },
  engineEnv: { text: "echo", depth: 1 }, lookupProgram: { text: "cat x", depth: 1 },
  temp: { text: "", reason: "Declared for wire compatibility; never read by the scanner." },
  xdgConfig: { text: "bun a.js", depth: 1 },
};
function swallowH() { try { outsideScanMarks("x".repeat(SCAN_GATE_CHARS + 1)); } catch {} }
function outerH(run: () => void) {
  return outsideScanMarks("ls", { cwd: "/", registry: (_word, implied) => { if (implied) run(); return null; } });
}
for (const key of Object.keys(scan11.HOOK_KEYS) as Array<keyof scan11.OutsideScanHooks>) {
  it(`H: ${key} nested outcome and guarded property post-check`, () => {
    const fixture = fixturesH[key];
    let nestedOutcome = "not called", calls = 0;
    const raw: scan11.OutsideScanHooks = { cwd: "/", home: "/home/u", xdgConfig: "/config", probe: () => null, lookupProgram: () => "/bin/cat" };
    const trigger = () => { calls++; swallowH(); };
    const value = key === "sessionEdits" ? new Set<string>() : undefined;
    Object.defineProperty(raw, key, { get: () => { trigger(); return value; }, configurable: true });
    if (!fixture.reason) {
      const marks = outerH(() => {
        try { outsideScanMarks(fixture.text, raw, fixture.depth); nestedOutcome = "returned"; }
        catch { nestedOutcome = "threw"; }
      });
      expect(calls).toBeGreaterThan(0); expect(nestedOutcome).toBe("threw"); expect(marks).toEqual(FAIL_CLOSED_MARKS);
    } else expect(fixture.reason).toMatch(/never read/);
    // Check at the boundary itself: C.2 must not mask a missing getter post-check.
    let propertyOutcome = "not called";
    expect(outerH(() => {
      const g = guardH(raw);
      try { void g[key]; propertyOutcome = "returned"; } catch (e) { propertyOutcome = (e as Error).constructor.name; }
    })).toEqual(FAIL_CLOSED_MARKS);
    expect(propertyOutcome).toBe("ScanBudgetSpent");
  });
  it(`H: ${key} guarded property pre-check`, () => {
    let reads = 0, outcome = "not called";
    const raw = Object.defineProperty({}, key, { get() { reads++; return undefined; } });
    expect(outerH(() => {
      const g = guardH(raw); swallowH();
      try { void g[key]; outcome = "returned"; } catch (e) { outcome = (e as Error).constructor.name; }
    })).toEqual(FAIL_CLOSED_MARKS);
    expect(outcome).toBe("ScanBudgetSpent"); expect(reads).toBe(0);
  });
}
it("H: repo nested scan cannot return after swallowed failure", () => {
  let nestedOutcome = "not called";
  const marks = outerH(() => {
    try { outsideScanMarks("git status", { repo: () => { swallowH(); return null; } }); nestedOutcome = "returned"; }
    catch { nestedOutcome = "threw"; }
  });
  expect(nestedOutcome).toBe("threw"); expect(marks).toEqual(FAIL_CLOSED_MARKS);
});
it("H: M14b final registry callback is not entered after earlier failure", () => {
  let impliedCalls = 0;
  const marks = outsideScanMarks("ls", { cwd: "/", registry: (_word, implied) => {
    if (implied) impliedCalls++; else swallowH(); return null;
  } });
  expect(impliedCalls).toBe(0); expect(marks).toEqual(FAIL_CLOSED_MARKS);
});
it("H: M6 M16 direct outer repo failure finalizes once", () => {
  const before = scanFailClosed.count; const log = vi.mocked(console.error); log.mockClear();
  expect(outsideScanMarks("git status", { repo: () => { swallowH(); return null; } })).toEqual(FAIL_CLOSED_MARKS);
  expect(scanFailClosed.count - before).toBe(1); expect(log).toHaveBeenCalledTimes(1);
});

for (const key of ["registry", "repo", "probe", "lookupProgram"] as const) {
  it(`H: ${key} callback post-check and receiver`, () => {
    let nestedOutcome = "not called", calls = 0;
    const raw: scan11.OutsideScanHooks = { cwd: "/", probe: () => null, lookupProgram: () => "/bin/cat" };
    raw[key] = function (this: unknown) {
      expect(this).toBe(key === "probe" ? undefined : raw);
      calls++; swallowH(); return null;
    };
    const fixture = fixturesH[key];
    expect(outerH(() => {
      try { outsideScanMarks(fixture.text, raw, fixture.depth); nestedOutcome = "returned"; }
      catch { nestedOutcome = "threw"; }
    })).toEqual(FAIL_CLOSED_MARKS);
    expect(nestedOutcome).toBe("threw"); expect(calls).toBe(1);
    let callOutcome = "not called";
    expect(outerH(() => {
      const g = guardH(raw);
      try {
        if (key === "registry") g.registry!("echo", false, false);
        else if (key === "probe") g.probe!("/x", false);
        else if (key === "repo") g.repo!(undefined);
        else g.lookupProgram!("cat");
        callOutcome = "returned";
      } catch (e) { callOutcome = (e as Error).constructor.name; }
    })).toEqual(FAIL_CLOSED_MARKS);
    expect(callOutcome).toBe("ScanBudgetSpent");
  });
}
for (const member of ["size", "has"] as const) it(`H: sessionEdits ${member} is scoped`, () => {
  const edits = new Set<string>();
  Object.defineProperty(edits, member, member === "size"
    ? { get() { swallowH(); return 1; } }
    : { value: () => { swallowH(); return false; } });
  let outcome = "not called";
  expect(outerH(() => {
    const g = guardH({ sessionEdits: edits });
    try { if (member === "size") void g.sessionEdits!.size; else g.sessionEdits!.has("/x"); outcome = "returned"; }
    catch (e) { outcome = (e as Error).constructor.name; }
  })).toEqual(FAIL_CLOSED_MARKS);
  expect(outcome).toBe("ScanBudgetSpent");
});
it("H: absent hooks and successful getter/call order are preserved", () => {
  const events: string[] = [];
  const raw = { get registry() { events.push("read"); const fn = function(this: unknown, word: string) {
    expect(this).toBe(raw); events.push(word); return null;
  }; Object.defineProperty(fn, "apply", { value: () => { throw new Error("must call the callback itself"); } }); return fn; } };
  const g = guardH(raw);
  expect(g.repo).toBeUndefined(); expect(g.probe).toBeUndefined(); expect(g.sessionEdits).toBeUndefined();
  expect(g.registry && g.registry("echo", false, false)).toBeNull();
  expect(events).toEqual(["read", "read", "echo"]);
});

it("H: R2b nested entry records a normalization RangeError before the hook resumes", () => {
  let recorded = false;
  expect(outerH(() => {
    const normalize = String.prototype.normalize;
    try {
      String.prototype.normalize = () => { throw new RangeError("nested normalization"); };
      try { outsideScanMarks("echo"); } catch {}
      recorded = scan11.scanStateForTests().failed !== null;
    } finally { String.prototype.normalize = normalize; }
  })).toEqual(FAIL_CLOSED_MARKS);
  expect(recorded).toBe(true);
});

// MARKS item 6 (MurageMain 11-07): a workspace runner split by a backslash-newline is the same command as the bare form
// (the shell joins it), so it marks `interpreter` exactly as the bare form does. packageRunMarks reads the joined copy.
describe("MARKS item 6: a continuation-split workspace runner marks like the bare form", () => {
  it.each([
    ["lerna run build", "ler\\\nna run build"],
    ["turbo run build", "tu\\\nrbo run build"],
    ["nx build", "n\\\nx build"],
  ])("%s", (bare, split) => {
    expect(outsideScanMarks(bare)).toContain("interpreter");
    expect(outsideScanMarks(split)).toContain("interpreter");
    expect(outsideScanMarks(split)).toEqual(outsideScanMarks(bare));
  });
  it("control: lerna run build still marks", () => {
    expect(outsideScanMarks("lerna run build")).toContain("interpreter");
  });
});
