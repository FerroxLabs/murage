// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shell parser: one test per grammar rule, the three heredoc shapes from
// the second Astra review, and every unmatched closer.
import { describe, expect, it } from "vitest";

import { literalText, Unreadable } from "./lex.ts";
import { parse, type Command } from "./parse.ts";

/** The parsed shape, flattened to something readable. */
function shape(command: Command): unknown {
  switch (command.kind) {
    case "simple": return [...command.assigns.map((a) => `${a.name}=${literalText(a.value) ?? "?"}`), ...command.words.map((w) => literalText(w) ?? "?"), ...command.redirects.map((r) => r.heredoc ? `${r.op}${r.heredoc.quoted ? "'" : ""}${r.heredoc.delimiter}` : `${r.fd ?? ""}${r.op}${r.target ? literalText(r.target) ?? "?" : ""}`)];
    case "if": return { if: command.clauses.map((c) => ({ cond: list(c.cond), body: list(c.body) })), ...(command.otherwise ? { else: list(command.otherwise) } : {}) };
    case "loop": return { [command.until ? "until" : "while"]: list(command.cond), do: list(command.body) };
    case "for": return { for: command.name, ...(command.words ? { in: command.words.map((w) => literalText(w) ?? "?") } : {}), do: list(command.body) };
    case "case": return { case: literalText(command.word) ?? "?", clauses: command.clauses.map((c) => ({ patterns: c.patterns.map((p) => literalText(p) ?? "?"), body: list(c.body) })) };
    case "subshell": return { subshell: list(command.body) };
    case "group": return { group: list(command.body) };
    case "function": return { function: command.name, body: shape(command.body) };
    case "arith": return { arith: command.words.map((w) => literalText(w) ?? "?") };
    case "cond": return { cond: command.words.map((w) => literalText(w) ?? "?") };
  }
}
const list = (script: { items: Array<{ andOr: { pipelines: Array<{ commands: Command[]; negated: boolean }> }; background: boolean }> }): unknown =>
  script.items.map((item) => {
    const pipelines = item.andOr.pipelines.map((p) => {
      const commands = p.commands.map(shape);
      const one = commands.length === 1 ? commands[0] : { pipe: commands };
      return p.negated ? { not: one } : one;
    });
    const andOr = pipelines.length === 1 ? pipelines[0] : { andOr: pipelines };
    return item.background ? { bg: andOr } : andOr;
  });
const tree = (text: string) => list(parse(text));
const reason = (text: string) => {
  try { parse(text); } catch (error) { if (error instanceof Unreadable) return error.reason; throw error; }
  return null;
};

describe("lists, pipelines and simple commands", () => {
  it("items, separators and background", () => {
    expect(tree("a; b & c\nd")).toEqual([["a"], { bg: ["b"] }, ["c"], ["d"]]);
  });
  it("and-or chains and pipelines", () => {
    expect(tree("a && b || c | d")).toEqual([{ andOr: [["a"], ["b"], { pipe: [["c"], ["d"]] }] }]);
    expect(tree("a |& b")).toEqual([{ pipe: [["a"], ["b"]] }]);
    expect(tree("! a")).toEqual([{ not: ["a"] }]);
    expect(tree("time -p a")).toEqual([["a"]]);
  });
  it("assignments before the first word, redirects anywhere", () => {
    expect(tree("A=1 B=x cmd arg 2>/dev/null >out")).toEqual([["A=1", "B=x", "cmd", "arg", "2>/dev/null", ">out"]]);
    expect(tree("A=1")).toEqual([["A=1"]]);
    expect(tree(">out cmd")).toEqual([["cmd", ">out"]]);
    expect(tree("cmd A=1")).toEqual([["cmd", "A=1"]]);
  });
  it("reserved words only where a command starts", () => {
    expect(tree("echo if then fi")).toEqual([["echo", "if", "then", "fi"]]);
    expect(tree('"if" x')).toEqual([["if", "x"]]);
  });
});

describe("compound commands", () => {
  it("if, elif, else", () => {
    expect(tree("if a; then b; elif c; then d; else e; fi")).toEqual([{ if: [{ cond: [["a"]], body: [["b"]] }, { cond: [["c"]], body: [["d"]] }], else: [["e"]] }]);
    expect(tree("if true\nthen\n  rm -rf ~\nfi")).toEqual([{ if: [{ cond: [["true"]], body: [["rm", "-rf", "?"]] }] }]);
  });
  it("while and until", () => {
    expect(tree("while a; do b; done")).toEqual([{ while: [["a"]], do: [["b"]] }]);
    expect(tree("until a; do b; done > f")).toEqual([{ until: [["a"]], do: [["b"]] }]);
  });
  it("for and select, with and without a word list", () => {
    expect(tree("for f in a b; do c; done")).toEqual([{ for: "f", in: ["a", "b"], do: [["c"]] }]);
    expect(tree("for f\ndo c; done")).toEqual([{ for: "f", do: [["c"]] }]);
    expect(tree("for f in a b\ndo c\ndone")).toEqual([{ for: "f", in: ["a", "b"], do: [["c"]] }]);
    expect(tree("select x in a b; do break; done")).toEqual([{ for: "x", in: ["a", "b"], do: [["break"]] }]);
    expect(tree("for ((i=0; i<3; i++)); do echo; done")).toEqual([{ for: "", do: [["echo"]] }]);
  });
  it("case, with every clause ending", () => {
    expect(tree("case x in a) b ;; (c|d) e ;& *) f ;;& esac")).toEqual([{ case: "x", clauses: [
      { patterns: ["a"], body: [["b"]] }, { patterns: ["c", "d"], body: [["e"]] }, { patterns: ["?"], body: [["f"]] },
    ] }]);
    expect(tree("case $x in\n  a|b) echo ab ;;\n  *) echo other ;;\nesac")).toMatchObject([{ case: "?" }]);
    expect(tree("case x in x) rm -rf ~ ;; esac")).toEqual([{ case: "x", clauses: [{ patterns: ["x"], body: [["rm", "-rf", "?"]] }] }]);
    expect(tree("case x in a) b; esac")).toEqual([{ case: "x", clauses: [{ patterns: ["a"], body: [["b"]] }] }]);
  });
  it("subshells and groups, nested", () => {
    expect(tree("(a; b)")).toEqual([{ subshell: [["a"], ["b"]] }]);
    expect(tree("{ a; b; }")).toEqual([{ group: [["a"], ["b"]] }]);
    expect(tree("(cd /tmp && (ls))")).toEqual([{ subshell: [{ andOr: [["cd", "/tmp"], { subshell: [["ls"]] }] }] }]);
    expect(tree("( (a) )")).toEqual([{ subshell: [{ subshell: [["a"]] }] }]);
    expect(tree("{ a; } > f")).toEqual([{ group: [["a"]] }]);
  });
  it("functions in both spellings", () => {
    expect(tree("f(){ a; }; f")).toEqual([{ function: "f", body: { group: [["a"]] } }, ["f"]]);
    expect(tree("f () ( a )")).toEqual([{ function: "f", body: { subshell: [["a"]] } }]);
    expect(tree("function f { a; }")).toEqual([{ function: "f", body: { group: [["a"]] } }]);
    expect(tree("function f() {\n a\n}\nf")).toEqual([{ function: "f", body: { group: [["a"]] } }, ["f"]]);
    expect(tree(":(){ :|:& };:")).toEqual([{ function: ":", body: { group: [{ bg: { pipe: [[":"], [":"]] } }] } }, [":"]]);
    expect(tree("b(){ b | b & }; echo \"}\"; b")).toEqual([{ function: "b", body: { group: [{ bg: { pipe: [["b"], ["b"]] } }] } }, ["echo", "}"], ["b"]]);
  });
  it("arithmetic and conditional commands", () => {
    expect(tree("(( i++ ))")).toEqual([{ arith: [" i++ "] }]);
    expect(tree("(( (a+b) * 2 ))")).toEqual([{ arith: [" (a+b) * 2 "] }]);
    // `<` and `<<` inside arithmetic are operators of the arithmetic, not redirects
    expect(tree("(( a < b )) && (( x << 2 ))")).toEqual([{ andOr: [{ arith: [" a < b "] }, { arith: [" x << 2 "] }] }]);
    expect(tree("for ((i=0; i<3; i++)); do echo $i; done")).toEqual([{ for: "", do: [["echo", "?"]] }]);
    expect(tree("[[ -d \"$d\" && -n x ]] && echo y")).toEqual([{ andOr: [{ cond: ["-d", "?", "-n", "x"] }, ["echo", "y"]] }]);
  });
  it("coproc", () => {
    expect(tree("coproc cat")).toEqual([["cat"]]);
    expect(tree("coproc name { cat; }")).toEqual([{ group: [["cat"]] }]);
  });
});

describe("the heredoc shapes from the second review", () => {
  it("L7: a heredoc on a shell is a redirect on that command", () => {
    expect(tree("bash <<'EOF'\nrm -rf ~\nEOF")).toEqual([["bash", "<<'EOF"]]);
  });
  it("L8: a heredoc inside a comment does not swallow the next command", () => {
    expect(tree("echo starting # <<EOF\nrm -rf ~\n# EOF")).toEqual([["echo", "starting"], ["rm", "-rf", "?"]]);
  });
  it("L9: a here-string is not a heredoc", () => {
    expect(tree("cat <<<EOF\nrm -rf ~")).toEqual([["cat", "<<<EOF"], ["rm", "-rf", "?"]]);
  });
});

describe("unreadable", () => {
  it.each([
    ["fi", "syntax"], ["done", "syntax"], ["esac", "syntax"], [")", "syntax"], ["}", "syntax"], ["then", "syntax"],
    ["if a; then b", "syntax"], ["while a; do b", "syntax"], ["for f in a; do b", "syntax"], ["case x in a) b", "syntax"],
    ["(a", "syntax"], ["{ a", "syntax"], ["f() {", "syntax"], ["[[ a", "syntax"], ["(( a", "syntax"],
    ["a )", "syntax"], ["a }", "syntax"], ["a ;; b", "syntax"], ["a | ", "syntax"], ["a &&", "syntax"], ["; a", "syntax"],
    ["a > ", "syntax"], ["cat <<EOF >\nx\nEOF", "syntax"], ["case in a) b;; esac", "syntax"],
    ["a |||", "syntax"], ["echo 'x", "quote"], ["cat <<EOF\nx", "heredoc"],
    [`${"( ".repeat(70)}a${" )".repeat(70)}`, "nesting"],
  ])("%s: %s", (text, expected) => {
    expect(reason(text)).toBe(expected);
  });

  it("ordinary text parses", () => {
    for (const text of [
      "a | b | c", "a 2>&1 | tee log", "a &> log", "a >| f", "exec 3<> f", "x=$((1+2))", "echo ${X:-d} ${#X}",
      "cd \"$(git rev-parse --show-toplevel)\" && make", "while read -r l; do echo \"$l\"; done < f",
      "f(){ echo hi; }; f", "echo a \\\n  b", "a;", "a\n\n\nb", "a &", "a & b &", "{ a; } && (b)",
    ]) expect(reason(text), text).toBeNull();
  });
});
