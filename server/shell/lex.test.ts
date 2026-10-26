// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shell lexer: every operator, every part kind, every reason it refuses.
import { describe, expect, it } from "vitest";

import { lex, lexQuotedBody, literalText, renderWord, Unreadable, type Part, type Token } from "./lex.ts";

const words = (text: string) => lex(text).filter((t): t is Extract<Token, { kind: "word" }> => t.kind === "word").map((t) => t.word);
const ops = (text: string) => lex(text).filter((t): t is Extract<Token, { kind: "op" }> => t.kind === "op").map((t) => (t.fd === undefined ? t.op : `${t.fd}${t.op}`));
const parts = (text: string) => words(text)[0]!.parts;
const reason = (text: string) => {
  try { lex(text); } catch (error) { if (error instanceof Unreadable) return error.reason; throw error; }
  return null;
};

describe("operators", () => {
  it.each([
    ["a; b", [";"]], ["a;; b", [";;"]], ["a ;& b", [";&"]], ["a ;;& b", [";;&"]],
    ["a & b", ["&"]], ["a && b", ["&&"]], ["a | b", ["|"]], ["a |& b", ["|&"]], ["a || b", ["||"]],
    ["(a)", ["(", ")"]], ["{ a; }", ["{", ";", "}"]], ["(( a ))", ["(("]], ["( (a) )", ["(", "(", ")", ")"]],
    ["a < f", ["<"]], ["a > f", [">"]], ["a >> f", [">>"]], ["a >| f", [">|"]], ["a <> f", ["<>"]],
    ["a <& 3", ["<&"]], ["a >& 2", [">&"]], ["a &> f", ["&>"]], ["a &>> f", ["&>>"]],
    ["a 2>f", ["2>"]], ["a 2>&1", ["2>&"]], ["exec 3<> f", ["3<>"]],
    ["a <<< w", ["<<<"]], ["a <<EOF\nx\nEOF", ["<<"]], ["a <<-EOF\n\tx\n\tEOF", ["<<-"]],
  ])("%s lexes %j", (text, expected) => {
    expect(ops(text)).toEqual(expected);
  });

  it("keeps `{` and `}` as words unless they stand alone", () => {
    expect(ops("find . -exec rm {} \\;")).toEqual([]);
    expect(literalText(words("echo {}")[1]!)).toBe("{}");
    expect(ops("{ a; }")).toEqual(["{", ";", "}"]);
    expect(ops("f(){ a; }")).toEqual(["(", ")", "{", ";", "}"]);
  });
});

describe("parts", () => {
  it("plain and quoted text are literal with their quoting", () => {
    expect(parts("a'b'\"c\"")).toEqual([
      { kind: "lit", text: "a", quote: "none" }, { kind: "lit", text: "b", quote: "single" }, { kind: "lit", text: "c", quote: "double" },
    ]);
  });
  it("an escaped character is literal: \\~ is not the home folder", () => {
    expect(parts("\\~")).toEqual([{ kind: "lit", text: "~", quote: "none" }]);
    expect(parts("\\$HOME")).toEqual([{ kind: "lit", text: "$HOME", quote: "none" }]);
  });
  it("inside double quotes only \\\" \\\\ \\$ \\` escape", () => {
    expect(parts('"C:\\Windows\\path"')).toEqual([{ kind: "lit", text: "C:\\Windows\\path", quote: "double" }]);
    expect(parts('"a\\"b\\$c"')).toEqual([{ kind: "lit", text: 'a"b$c', quote: "double" }]);
  });
  it("$'…' undoes its escapes, $\"…\" is double-quoted", () => {
    expect(parts("$'a\\tb'")).toEqual([{ kind: "lit", text: "a\tb", quote: "single" }]);
    expect(parts('$"x"')).toEqual([{ kind: "lit", text: "x", quote: "double" }]);
  });
  it("variables, in every spelling", () => {
    expect(parts("$HOME")).toEqual([{ kind: "var", name: "HOME", quote: "none" }]);
    expect(parts('"$HOME"')).toEqual([{ kind: "var", name: "HOME", quote: "double" }]);
    expect(parts("${HOME}/x")).toEqual([{ kind: "var", name: "HOME", quote: "none" }, { kind: "lit", text: "/x", quote: "none" }]);
    expect(parts("$1$?$@")).toEqual([{ kind: "var", name: "1", quote: "none" }, { kind: "var", name: "?", quote: "none" }, { kind: "var", name: "@", quote: "none" }]);
    expect(parts("${#X}")).toEqual([{ kind: "var", name: "X", quote: "none", op: "#" }]);
    expect(parts("${X%%.*}")).toEqual([{ kind: "var", name: "X", quote: "none", op: "%%", word: { parts: [{ kind: "lit", text: ".", quote: "none" }, { kind: "glob", text: "*" }] } }]);
    expect(parts("${X^^}")).toEqual([{ kind: "var", name: "X", quote: "none", op: "^^" }]);
    expect(parts("${10}")).toEqual([{ kind: "var", name: "10", quote: "none" }]);
    // every operand is a word of its own, so a substitution in one is a part
    expect(parts("${X#$(ls)}")[0]).toMatchObject({ kind: "var", op: "#", word: { parts: [{ kind: "subst", text: "ls" }] } });
    expect(parts("${a[0]}${a[@]}${a[i]}").map((part) => part.kind)).toEqual(["var", "var", "var"]);
    expect(parts("${X:-/}")).toEqual([{ kind: "var", name: "X", quote: "none", op: ":-", word: { parts: [{ kind: "lit", text: "/", quote: "none" }] } }]);
    expect(parts("${X:-~}")[0]).toMatchObject({ kind: "var", op: ":-", word: { parts: [{ kind: "tilde", user: "" }] } });
    expect(parts("${X:-$(ls)}")[0]).toMatchObject({ kind: "var", op: ":-", word: { parts: [{ kind: "subst", text: "ls" }] } });
  });
  it("a lone $ is a character", () => {
    expect(parts("$")).toEqual([{ kind: "lit", text: "$", quote: "none" }]);
    expect(parts("a$ b")).toEqual([{ kind: "lit", text: "a$", quote: "none" }]);
  });
  it("substitutions, nested and quoted", () => {
    expect(parts("$(ls)")).toEqual([{ kind: "subst", text: "ls", quote: "none" }]);
    expect(parts('"$(dirname "$(pwd)")"')).toEqual([{ kind: "subst", text: 'dirname "$(pwd)"', quote: "double" }]);
    expect(parts("`ls`")).toEqual([{ kind: "subst", text: "ls", quote: "none" }]);
    expect(parts('"`echo \\`x\\``"')).toEqual([{ kind: "subst", text: "echo `x`", quote: "double" }]);
    expect(parts("$(echo ')')")).toEqual([{ kind: "subst", text: "echo ')'", quote: "none" }]);
    expect(parts("$(echo \")\")")).toEqual([{ kind: "subst", text: 'echo ")"', quote: "none" }]);
    expect(parts("$(ls # )\n)")).toEqual([{ kind: "subst", text: "ls # )\n", quote: "none" }]);
    expect(parts("$(a#b)")).toEqual([{ kind: "subst", text: "a#b", quote: "none" }]);
    // a heredoc inside the substitution: its body is data, apostrophes and all
    expect(parts("\"$(cat <<'EOF'\ndon't )\nEOF\n)\"")).toEqual([{ kind: "subst", text: "cat <<'EOF'\ndon't )\nEOF\n", quote: "double" }]);
    expect(parts("$(cat <<EOF\nx\nEOF\necho ')')")).toEqual([{ kind: "subst", text: "cat <<EOF\nx\nEOF\necho ')'", quote: "none" }]);
  });
  it("arithmetic is a part, and `$( (…) )` is not arithmetic", () => {
    expect(parts("$((1+2))")).toEqual([{ kind: "arith", text: "1+2", quote: "none" }]);
    expect(parts("$(( (1+2)*3 ))")).toEqual([{ kind: "arith", text: " (1+2)*3 ", quote: "none" }]);
    expect(parts("$( (ls) )")).toEqual([{ kind: "subst", text: " (ls) ", quote: "none" }]);
  });
  it("process substitution", () => {
    expect(parts("<(ls)")).toEqual([{ kind: "procsub", text: "ls", dir: "<" }]);
    expect(words("diff <(a) >(b)").map((w) => w.parts[0]!.kind)).toEqual(["lit", "procsub", "procsub"]);
  });
  it("tilde only unquoted at the start of a word or after an assignment", () => {
    expect(parts("~")).toEqual([{ kind: "tilde", user: "" }]);
    expect(parts("~sean/x")).toEqual([{ kind: "tilde", user: "sean" }, { kind: "lit", text: "/x", quote: "none" }]);
    expect(parts("~\"\"")).toEqual([{ kind: "tilde", user: "" }, { kind: "lit", text: "", quote: "double" }]);
    expect(parts("D=~/x")).toEqual([{ kind: "lit", text: "D=", quote: "none" }, { kind: "tilde", user: "" }, { kind: "lit", text: "/x", quote: "none" }]);
    expect(parts("'~'")).toEqual([{ kind: "lit", text: "~", quote: "single" }]);
    expect(parts('"~"')).toEqual([{ kind: "lit", text: "~", quote: "double" }]);
    expect(parts("a~")).toEqual([{ kind: "lit", text: "a~", quote: "none" }]);
  });
  it("globs and braces", () => {
    expect(parts("/*")).toEqual([{ kind: "lit", text: "/", quote: "none" }, { kind: "glob", text: "*" }]);
    // each alternative is a word of its own, lexed like any other (UPSEC 9.1)
    const alt = (text: string) => (text === "" ? { parts: [] } : { parts: [{ kind: "lit", text, quote: "none" }] });
    expect(parts("{a,b}")).toEqual([{ kind: "brace", alts: [alt("a"), alt("b")] }]);
    expect(parts("x{,.bak}")).toEqual([{ kind: "lit", text: "x", quote: "none" }, { kind: "brace", alts: [alt(""), alt(".bak")] }]);
    expect(parts("{1..3}")).toEqual([{ kind: "brace", alts: [alt("1"), alt("2"), alt("3")] }]);
    expect(parts("{}")).toEqual([{ kind: "lit", text: "{}", quote: "none" }]);
    expect(parts("{a}")).toEqual([{ kind: "lit", text: "{a}", quote: "none" }]);
  });
});

describe("comments, continuations and heredocs", () => {
  it("a comment runs to the end of the line; # inside a word is a character", () => {
    expect(words("echo a # b c\necho d").map(literalText)).toEqual(["echo", "a", "echo", "d"]);
    expect(words("echo a#b").map(literalText)).toEqual(["echo", "a#b"]);
    expect(words("echo '#' \"#\"").map(literalText)).toEqual(["echo", "#", "#"]);
  });
  it("backslash-newline continues the line", () => {
    expect(words("echo a \\\n  b").map(literalText)).toEqual(["echo", "a", "b"]);
    expect(lex("echo a \\\n b").some((t) => t.kind === "newline")).toBe(false);
  });
  it("a heredoc body is attached to its operator and ends at the delimiter line", () => {
    const [op] = lex("cat <<EOF\nline 1\nline 2\nEOF\necho after").filter((t) => t.kind === "op") as Array<Extract<Token, { kind: "op" }>>;
    expect(op!.heredoc).toEqual({ delimiter: "EOF", quoted: false, strip: false, body: "line 1\nline 2\n" });
    expect(words("cat <<EOF\nx\nEOF\necho after").map(literalText)).toEqual(["cat", "echo", "after"]);
  });
  it("a quoted delimiter marks the body literal; <<- strips tabs", () => {
    const quoted = (text: string) => (lex(text).find((t) => t.kind === "op") as Extract<Token, { kind: "op" }>).heredoc!;
    expect(quoted("cat <<'EOF'\nx\nEOF")).toMatchObject({ quoted: true, body: "x\n" });
    expect(quoted('cat <<"EOF"\nx\nEOF')).toMatchObject({ quoted: true });
    expect(quoted("cat <<\\EOF\nx\nEOF")).toMatchObject({ quoted: true });
    expect(quoted("cat <<-EOF\n\tx\n\tEOF")).toMatchObject({ strip: true, body: "\tx\n" });
  });
  it("two heredocs on one line are read in order", () => {
    const docs = lex("cat <<A <<B\na\nA\nb\nB\necho z").filter((t) => t.kind === "op").map((t) => (t as Extract<Token, { kind: "op" }>).heredoc?.body);
    expect(docs).toEqual(["a\n", "b\n"]);
  });
  it("the rest of the opening line is read before the body", () => {
    expect(words("cat <<EOF > out; echo x\nbody\nEOF").map(literalText)).toEqual(["cat", "out", "echo", "x"]);
  });
  it("<<< is a here-string, not a heredoc", () => {
    expect(ops("cat <<<EOF\nrm -rf ~")).toEqual(["<<<"]);
    expect(words("cat <<<EOF\nrm -rf ~").map(literalText)).toEqual(["cat", "EOF", "rm", "-rf", undefined]);
  });
  it("a heredoc opened inside a comment is no heredoc", () => {
    expect(words("echo starting # <<EOF\nrm -rf ~\n# EOF").map(literalText)).toEqual(["echo", "starting", "rm", "-rf", undefined]);
  });
});

describe("unreadable", () => {
  it.each([
    ['echo "x', "quote"], ["echo 'x", "quote"], ["echo $'x", "quote"],
    ["cat <<EOF\nx", "heredoc"], ["cat <<EOF", "heredoc"], ["cat <<", "heredoc"],
    ["echo $(ls", "substitution"], ["echo `ls", "substitution"], ["echo $((1", "substitution"],
    ["echo ${!x}", "expansion"], ["echo ${x@Q}", "expansion"], ["echo ${x", "expansion"], ["echo {1..9999}", "expansion"],
    ["x".repeat(256 * 1024 + 1), "length"],
  ])("%s: %s", (text, expected) => {
    expect(reason(text)).toBe(expected);
  });

  it("reads 100 KiB of ordinary lines", () => {
    const text = Array.from({ length: 2_200 }, (_, i) => `echo line ${i} 'with quotes' "and $vars" | grep x`).join("\n");
    expect(text.length).toBeGreaterThan(100_000);
    expect(reason(text)).toBeNull();
  });
});

describe("helpers", () => {
  it("lexQuotedBody reads an unquoted heredoc body as double-quoted text", () => {
    expect(lexQuotedBody("a $(b) \"c\" 'd' $E\n")).toEqual<Part[]>([
      { kind: "lit", text: "a ", quote: "double" }, { kind: "subst", text: "b", quote: "double" },
      { kind: "lit", text: ' "c" \'d\' ', quote: "double" }, { kind: "var", name: "E", quote: "double" }, { kind: "lit", text: "\n", quote: "double" },
    ]);
  });
  it("renderWord writes a word back for an inner shell", () => {
    expect(renderWord(words("'rm -rf ~'")[0]!)).toBe("rm -rf ~");
    expect(renderWord(words('"cd $(pwd) && rm -rf $DIR/"')[0]!)).toBe("cd $(pwd) && rm -rf ${DIR}/");
    expect(renderWord(words("~/x*")[0]!)).toBe("~/x*");
  });
});

describe("UPSEC 9.1 and 9.7: re-entry, logical lines, carriage returns", () => {
  it("a backtick substitution is read by the lexer re-entered, at every site", () => {
    expect(reason("echo `echo 'x`")).toBe("quote");
    expect(reason("echo \"`echo 'x`\"")).toBe("quote");
    expect(reason("echo `cat <<EOF\nx`")).toBe("heredoc");
    expect(reason("echo `echo $(ls`")).toBe("substitution");
    expect(reason("echo $((`echo 'x`))")).toBe("quote");
    expect(reason("echo ${X:-`echo 'x`}")).toBe("quote");
    expect(parts("`cat <<EOF\nx\nEOF\n`")).toEqual([{ kind: "subst", text: "cat <<EOF\nx\nEOF\n", quote: "none" }]);
  });
  it("case and esac are reserved only where a command name stands", () => {
    expect(reason("echo $(echo case)")).toBeNull();
    expect(reason("x=$(printf '%s' case in esac)")).toBeNull();
    expect(reason("echo $(grep -c case f)")).toBeNull();
    expect(reason("echo $(case a in a) echo;; esac)")).toBeNull();
    expect(reason("echo $(if true; then case a in (a) echo;; esac; fi)")).toBeNull();
    expect(parts("$(case a in a) echo;; esac)")).toEqual([{ kind: "subst", text: "case a in a) echo;; esac", quote: "none" }]);
    expect(reason("echo $(case a in a) echo")).toBe("substitution");
  });
  it("an unquoted heredoc is read in logical lines; a quoted one keeps physical lines", () => {
    const heredoc = (text: string) => (lex(text).find((t) => t.kind === "op") as Extract<Token, { kind: "op" }>).heredoc!;
    expect(heredoc("cat <<EOF\na\\\nb\nEOF")).toMatchObject({ body: "ab\n" });
    expect(heredoc("cat <<EOF\nx\nEO\\\nF")).toMatchObject({ body: "x\n" });
    expect(heredoc("cat <<'EOF'\na\\\nb\nEOF")).toMatchObject({ body: "a\\\nb\n" });
    expect(heredoc("cat <<'EOF'\nEO\\\nF\nEOF")).toMatchObject({ body: "EO\\\nF\n" });
  });
  it("a delimiter continued over a line asks", () => {
    expect(reason("cat <<EO\\\nF\nx\nEOF")).toBe("heredoc");
  });
  it("a carriage return is a character: in a word, a delimiter line, never a blank", () => {
    expect(words("echo a\r").map(literalText)).toEqual(["echo", "a\r"]);
    expect(words("a\rb").map(literalText)).toEqual(["a\rb"]);
    expect(reason("cat <<EOF\nx\nEOF\r\necho y")).toBe("heredoc");
    expect(reason("cat <<EOF\r\nx\nEOF\r\n")).toBeNull();
  });
  it("heredocs inside a substitution have their own queue and terminators", () => {
    expect(parts("$(cat <<A <<B\na\nA\nb\nB\n)")).toEqual([{ kind: "subst", text: "cat <<A <<B\na\nA\nb\nB\n", quote: "none" }]);
    expect(reason("echo $(cat <<A\na\n)")).toBe("heredoc");
  });
  it("a brace alternative is a word of its own: `~` in it is the home folder", () => {
    expect(parts("{~,x}")).toEqual([{ kind: "brace", alts: [{ parts: [{ kind: "tilde", user: "" }] }, { parts: [{ kind: "lit", text: "x", quote: "none" }] }] }]);
  });
});

describe("UPSEC 10.1 and 10.7: the backtick mode; continuations and carriage returns at every site", () => {
  it("the backtick closer is the first backtick no backslash escapes, in any quote state", () => {
    expect(parts("`echo hi`")).toEqual([{ kind: "subst", text: "echo hi", quote: "none" }]);
    expect(parts("`echo \\`x\\``")).toEqual([{ kind: "subst", text: "echo `x`", quote: "none" }]);
    // a double-quoted backtick in the body closes it there, as in bash: the body is left with an open quote
    expect(reason("echo `echo \"a`b\"`")).toBe("quote");
    expect(reason("echo \"`echo a`\"")).toBeNull();
  });
  it("a backslash-newline continues the line between tokens, in a word and in double quotes", () => {
    expect(words("echo \\\n x").map(literalText)).toEqual(["echo", "x"]);
    expect(words("ec\\\nho x").map(literalText)).toEqual(["echo", "x"]);
    expect(words("echo \"a\\\nb\"").map(literalText)).toEqual(["echo", "ab"]);
  });
  it("a carriage return is a character in double quotes and after a backslash", () => {
    expect(words("echo \"a\r\"").map(literalText)).toEqual(["echo", "a\r"]);
    expect(words("echo a\\\r\nb").map(literalText)).toEqual(["echo", "a\r", "b"]);
    expect(reason("echo \r")).toBeNull();
  });
  it("in a heredoc body and its delimiter: continuations join an unquoted body, a carriage return stays", () => {
    const heredoc = (text: string) => (lex(text).find((t) => t.kind === "op") as Extract<Token, { kind: "op" }>).heredoc!;
    expect(heredoc("cat <<EOF\na\r\nEOF")).toMatchObject({ body: "a\r\n" });
    expect(heredoc("cat <<EOF\na\\\nb\r\nEOF")).toMatchObject({ body: "ab\r\n" });
    expect(reason("cat <<EOF\nx\nEOF\r")).toBe("heredoc");
    expect(reason("cat <<E\\\nOF\nx\nEOF")).toBe("heredoc");
  });
});

describe("an expansion in option position asks (bash expands it after the reader read it)", () => {
  it.each([
    "git diff --{output=../x,stat}",
    "rg --{pre=./evil.sh,files} x",
    "sort --{compress-program=sh,-o,x} f",
    "rm -r{f,} ./inside",
    "find . {-exec,sh,-c,evil,+}",
    "find . {-exec,bash,-c,evil,\\;}",
    "echo {a,'b'}",
    "echo {$HOME,x}",
    "echo {a,{b,c}}",
    "rm -* ./inside",
    "rm -[r]f ./inside",
    "rm -?f ./inside",
    "git diff --output=$(echo ../x)",
    "git diff --output=`echo ../x`",
    "cmd -$((1))",
    "grep --include=*.ts$(echo ' --output=../x') x",
    "git diff --output={a,b}$(echo ' --stat')",
    "git diff {--output=../x,$(true)}",
    "git diff {--output=../x,<(true)}",
    "rm -[r=f] ./inside",
    "rm -[r=]f ./inside",
    "git diff ''--{output=../x,stat}",
    "git diff \"\"{--output=../x,--stat}",
    "rm -{a..c} ./inside",
    "echo {1..9..2}",
    // Grok round 2: a first `}` inside a quote, escape or substitution; a `[` in an option name however quoted
    "git diff {--output=\"}\",--output=../x}",
    "git diff {--output=$(echo }),--output=../x}",
    "git diff {--output=../x\\},--stat}",
    "git diff --['o']utput=../x",
    "rm -['r']['f'] ./inside",
  ])("%s", (text) => expect(reason(text)).toBe("expansion"));

  it.each([
    "cp file{,.bak}",
    "mkdir -p src/{a,b}",
    "grep -r --include=*.ts foo .",
    "rg --glob={a,b}.ts foo",
    "find . -name '*.ts' -exec grep -l x {} +",
    "find . -exec rm {} \;",
    "git log -n$N",
    "git stash show stash@{0}",
    "ls -la",
    "sort -k2,2 f",
    "{ echo a,b; }",
    "echo -",
    "git commit -m \"$(cat msg)\"",
    "echo $'\\x2d\\x2drf'",
    "echo {a..e}",
    "touch file-{a..c}.txt",
  ])("stays readable: %s", (text) => expect(reason(text)).toBeNull());
});
