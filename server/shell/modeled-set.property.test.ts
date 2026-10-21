// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The always-ask reader is an allowlist: a command is ordinary only when every
// construct in it is one the walker models. This test generates texts from
// the grammar and checks the property from both sides. A catastrophe wrapped
// in any nest of modeled constructs still asks, with its own rule (the
// construct is looked through) or as unreadable (never as ordinary). A
// construct outside the modeled set asks wherever it sits. An ordinary
// command inside modeled constructs stays ordinary. Seeded, so a failure is
// reproducible: the failing text is in the assertion message.
import { describe, expect, it, vi } from "vitest";

import type { AlwaysAskRule } from "../always-ask.ts";

// The test setup gives each file a home folder under the temp folder, which
// makes the temp folder the folder that holds the home folders, and the
// reader fixes the home folder when it loads. These payloads mean an
// ordinary machine, so the reader is loaded with a home outside it.
process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("../always-ask.ts");

/** mulberry32: a small seeded generator, enough to pick from lists. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: () => number, list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

interface Context {
  name: string;
  wrap: (text: string) => string;
  /** the inner text is put between single quotes: it may hold none */
  singleQuotes?: boolean;
  /** the inner text is put between backticks: it may hold none */
  backticks?: boolean;
  /** the inner text goes through `echo` into a shell: a backslash in it is
   * a spelling the reader asks about, so the generator keeps those apart */
  noBackslash?: boolean;
  /** a wrapper program: only around one simple command */
  simpleOnly?: boolean;
  /** an assignment prefix: what follows is no longer a program a wrapper
   * could run (`nohup X=1 rm` runs a program called `X=1`) */
  assigns?: boolean;
  /** uses a heredoc with this delimiter: the inner text must not */
  delimiter?: string;
  /** the inner text is enclosed (quotes, `$( )`, a heredoc body), so a
   * heredoc inside it no longer has to end the line */
  encloses?: boolean;
  /** puts nothing after the inner text on its last line, so a text that
   * ends with a heredoc terminator stays valid */
  heredocSafe?: boolean;
  /** puts the inner text inside `$( )` or `<( )`, whose closer the lexer
   * finds by matching parens: a `case` pattern's `)` inside is a known
   * follow-up (it asks), so the generator keeps them apart */
  parens?: boolean;
  /** the context itself is a `case`, with pattern parens */
  casePatterns?: boolean;
  /** a reserved word that must be followed by a command on the same line */
  noLeadingNewline?: boolean;
  /** every word after the wrapper has to be fixed by the text (env): a
   * payload with a value, glob or brace in it asks there */
  literalOnly?: boolean;
  /** puts the inner text after `&&` or `||`: a function defined there and
   * called after the chain asks (strict rule 2), so a text that defines
   * one does not go here */
  chainTail?: boolean;
  /** the context itself defines a function and calls it */
  defines?: boolean;
  /** the inner text runs later, from a trap or an eval body: a risky
   * command there asks at registration (round 5), so an ordinary payload
   * that deletes or writes a disk does not go here */
  indirect?: boolean;
  /** the context itself asks for every payload (an output redirect whose
   * target is a value), so the ordinary test keeps away from it */
  asks?: boolean;
}

/** Every construct the walker models, as a context around a text. */
const CONTEXTS: Context[] = [
  { name: "plain", wrap: (t) => t, heredocSafe: true },
  { name: "if", wrap: (t) => `if true; then ${t}; fi` },
  { name: "else", wrap: (t) => `if false; then :; else ${t}; fi` },
  { name: "elif", wrap: (t) => `if false; then :; elif true; then ${t}; fi` },
  { name: "for", wrap: (t) => `for _i in a b; do ${t}; done` },
  { name: "while", wrap: (t) => `while false; do ${t}; done` },
  { name: "until", wrap: (t) => `until true; do ${t}; done` },
  { name: "case", wrap: (t) => `case a in a) ${t} ;; *) : ;; esac`, casePatterns: true },
  { name: "subshell", wrap: (t) => `( ${t} )` },
  { name: "group", wrap: (t) => `{ ${t}; }` },
  { name: "and", wrap: (t) => `true && ${t}`, heredocSafe: true, chainTail: true },
  { name: "and-chain", wrap: (t) => `true && ${t} && true`, chainTail: true },
  { name: "function-twice", wrap: (t) => `ff() { ${t}; }; ff; ff`, defines: true },
  { name: "or", wrap: (t) => `${t} || true` },
  { name: "or-then", wrap: (t) => `false || ${t}`, heredocSafe: true, chainTail: true },
  { name: "pipe", wrap: (t) => `${t} | cat` },
  { name: "background", wrap: (t) => `${t} &\n:` },
  { name: "not", wrap: (t) => `! ${t}`, heredocSafe: true, noLeadingNewline: true },
  { name: "time", wrap: (t) => `time ${t}`, heredocSafe: true, noLeadingNewline: true },
  { name: "redirect", wrap: (t) => `${t} 2>/dev/null` },
  { name: "comment", wrap: (t) => `${t} # note\n:` },
  { name: "newlines", wrap: (t) => `\n${t}\n:`, heredocSafe: true },
  { name: "function", wrap: (t) => `f() { ${t}; }; f`, defines: true },
  { name: "function-keyword", wrap: (t) => `function g {\n${t}\n}\ng`, heredocSafe: true, encloses: true, defines: true },
  { name: "subst-quoted", wrap: (t) => `echo "$( ${t} )"`, heredocSafe: true, encloses: true, parens: true },
  { name: "subst-assign", wrap: (t) => `x=$( ${t} )`, heredocSafe: true, encloses: true, parens: true },
  { name: "subst-arg", wrap: (t) => `: $( ${t} )`, heredocSafe: true, encloses: true, parens: true },
  { name: "subst-redirect", wrap: (t) => `cat > "$( ${t} )"`, heredocSafe: true, encloses: true, parens: true, asks: true },
  { name: "backtick", wrap: (t) => `echo \`${t}\``, backticks: true, heredocSafe: true, encloses: true },
  { name: "procsub", wrap: (t) => `diff <( ${t} ) /dev/null`, heredocSafe: true, encloses: true, parens: true },
  { name: "arith-part", wrap: (t) => `echo $(( 1 + $( ${t} ) ))`, heredocSafe: true, encloses: true, parens: true },
  { name: "arith-command", wrap: (t) => `(( $( ${t} ) ))`, heredocSafe: true, encloses: true, parens: true },
  { name: "for-arith", wrap: (t) => `for ((i=$( ${t} ); i<1; i++)); do :; done`, heredocSafe: true, encloses: true, parens: true },
  { name: "cond", wrap: (t) => `[[ -n "$( ${t} )" ]]`, heredocSafe: true, encloses: true, parens: true },
  { name: "var-default", wrap: (t) => `echo "\${X:-$( ${t} )}"`, heredocSafe: true, encloses: true, parens: true },
  { name: "var-operand", wrap: (t) => `echo "\${X#$( ${t} )}"`, heredocSafe: true, encloses: true, parens: true },
  { name: "heredoc-unquoted", wrap: (t) => `cat <<HD\n$( ${t} )\nHD\n`, delimiter: "HD", heredocSafe: true, encloses: true, parens: true },
  { name: "sh-heredoc", wrap: (t) => `sh <<'END'\n${t}\nEND\n`, delimiter: "END", heredocSafe: true, encloses: true },
  { name: "compound-heredoc", wrap: (t) => `{ bash; } <<'EOS'\n${t}\nEOS\n`, delimiter: "EOS", heredocSafe: true, encloses: true },
  { name: "bash-c", wrap: (t) => `bash -c '${t}'`, singleQuotes: true, heredocSafe: true, encloses: true },
  { name: "bash-lc", wrap: (t) => `bash -lc '${t}'`, singleQuotes: true, heredocSafe: true, encloses: true },
  { name: "sh-herestring", wrap: (t) => `sh <<<'${t}'`, singleQuotes: true, heredocSafe: true, encloses: true },
  { name: "echo-sh", wrap: (t) => `echo '${t}' | sh`, singleQuotes: true, noBackslash: true, heredocSafe: true, encloses: true },
  { name: "echo-group", wrap: (t) => `echo '${t}' | { bash; }`, singleQuotes: true, noBackslash: true, heredocSafe: true, encloses: true },
  { name: "eval", wrap: (t) => `eval '${t}'`, singleQuotes: true, heredocSafe: true, encloses: true, indirect: true },
  { name: "trap", wrap: (t) => `trap '${t}' EXIT`, singleQuotes: true, heredocSafe: true, encloses: true, indirect: true },
  { name: "find-exec", wrap: (t) => `find . -exec sh -c '${t}' \\;`, singleQuotes: true, heredocSafe: true, encloses: true },
  // env -S splits its string into one program and its arguments; no shell
  // reads it, and every word has to be fixed by the text, as for env
  { name: "env-S", wrap: (t) => `env -S '${t}'`, simpleOnly: true, literalOnly: true, singleQuotes: true, heredocSafe: true, encloses: true },
  { name: "su-c", wrap: (t) => `su -c '${t}' root`, singleQuotes: true, heredocSafe: true, encloses: true },
  { name: "sudo", wrap: (t) => `sudo -n ${t}`, simpleOnly: true, heredocSafe: true },
  { name: "sudo-user", wrap: (t) => `sudo --user=root -H -- ${t}`, simpleOnly: true, heredocSafe: true },
  { name: "timeout", wrap: (t) => `timeout -k 5 10 ${t}`, simpleOnly: true, heredocSafe: true },
  { name: "nohup", wrap: (t) => `nohup ${t} &\n:`, simpleOnly: true },
  { name: "env", wrap: (t) => `env -i PATH=/bin ${t}`, simpleOnly: true, literalOnly: true, heredocSafe: true },
  { name: "nice", wrap: (t) => `nice -n 5 ${t}`, simpleOnly: true, heredocSafe: true },
  { name: "command", wrap: (t) => `command ${t}`, simpleOnly: true, heredocSafe: true },
  { name: "assignment-prefix", wrap: (t) => `X=1 ${t}`, simpleOnly: true, assigns: true, heredocSafe: true },
];

interface Payload {
  text: string;
  /** one simple command: a wrapper program may go in front */
  simple: boolean;
  /** defines a function and calls it: not for a chain tail */
  defines?: boolean;
  /** deletes or writes a disk with literal operands: ordinary on its own,
   * an ask from a trap or eval body */
  risky?: boolean;
  /** an operand is a positional parameter (`$1`, `$@`) */
  positional?: boolean;
}

/** Contexts that start a shell or call a function with no arguments: the
 * positional parameters inside are bound, and empty, so a delete of them
 * removes nothing (UPSEC 9.4, `bindPositionals`). */
const BINDS_POSITIONALS = new Set(["function-twice", "function", "function-keyword", "sh-heredoc", "compound-heredoc", "bash-c", "bash-lc", "sh-herestring", "echo-sh", "echo-group", "find-exec", "su-c"]);

/** Catastrophes, each with the rule the reader gives it on its own. */
const CATASTROPHES: Array<Payload & { rule: AlwaysAskRule }> = [
  { text: "rm -rf ~", rule: "delete-home", simple: true },
  { text: "rm -rf /", rule: "delete-root", simple: true },
  { text: "rm -rf /usr", rule: "delete-system-folder", simple: true },
  { text: 'rm -rf "$HOME"', rule: "delete-home", simple: true },
  { text: "rm -rf ~/..", rule: "delete-system-folder", simple: true },
  { text: "dd if=/dev/zero of=/dev/sda", rule: "disk-erase", simple: true },
  { text: "mkfs.ext4 /dev/sda1", rule: "disk-erase", simple: true },
  { text: "find / -delete", rule: "delete-root", simple: true },
  { text: "rm -rf $DIR/", rule: "unknown-target", simple: true },
  { text: ":(){ :|:& };:", rule: "fork-bomb", simple: false, defines: true },
  { text: "cd / && rm -rf *", rule: "delete-root", simple: false },
  { text: "w(){ \"$@\"; }; w rm -rf /usr", rule: "delete-system-folder", simple: false, defines: true },
  { text: 'powershell -c "rmdir -Recurse -Force ~"', rule: "delete-home", simple: true },
  { text: "printf 'rm -rf ~' | sh", rule: "delete-home", simple: false },
  // the closed-class reader reads these values through (UPSEC 9): they used
  // to be outside the modeled set and now name what they delete
  { text: "D=/; rm -rf $D", rule: "delete-root", simple: false },
  { text: "f(){ rm -rf \"$1\"; }; f ~", rule: "delete-home", simple: false, defines: true },
  { text: "F=-rf; rm $F /", rule: "delete-root", simple: false },
  { text: "HOME=/; rm -rf $HOME/bin", rule: "delete-system-folder", simple: false },
  { text: "D=/tmp; eval 'D=/usr'; rm -rf \"$D\"", rule: "delete-system-folder", simple: false },
  { text: "bash -c 'rm -rf \"$1\"' _ /usr", rule: "delete-system-folder", simple: true },
];

/** Constructs outside the modeled set: each asks on its own and anywhere. */
const UNMODELED: Payload[] = [
  { text: "echo ${!name}", simple: true },
  { text: "echo ${a[$(echo 1)]}", simple: true },
  { text: "echo ${x@Q}", simple: true },
  { text: "sudo --bogus ls", simple: true },
  { text: "$cmd", simple: true },
  { text: "trap \"$t\" EXIT", simple: true },
  { text: "bash -c \"$s\"", simple: true },
  { text: "eval \"$x\"", simple: true },
  { text: "alias ll=ls", simple: true },
  { text: "dd if=x of=$o", simple: true },
  { text: "powershell -EncodedCommand AAAA", simple: true },
  { text: "powershell -c \"iex x\"", simple: true },
  { text: "powershell -c \"[IO.File]::Delete(x)\"", simple: true },
  { text: "echo \"unterminated", simple: true },
  { text: "echo ${x", simple: true },
  { text: "echo $(ls", simple: true },
  { text: "echo $((1+", simple: true },
  { text: "find . -exec ls {}", simple: true },
  { text: "x=\"a b\"; $x", simple: false },
  { text: "T=$(which x); $T", simple: false },
  { text: "printf \"%q\" ls | sh", simple: false },
  { text: "printf \"%s\\n\" hi | sh", simple: false },
  { text: "echo -e hi | sh", simple: false },
  { text: "A=-exec; find . \"$A\" ls {} \\;", simple: false },
  { text: "find . -name *.log -delete", simple: true },
  { text: "echo \"$x\" | xargs rm", simple: false },
  { text: "env X=$y ls", simple: true },
  { text: "eval \"ls $x\"", simple: true },
  { text: "bash -c \"ls $x\"", simple: true },
  { text: "echo \"ls $x\" | sh", simple: false },
  { text: "D=/tmp; f(){ D=/usr; }; f; rm -rf \"$D\"", simple: false },
  { text: "f(){ cd /usr; }; f; rm -rf x", simple: false },
  { text: "D=/usr; false && D=/tmp; rm -rf \"$D\"", simple: false },
  { text: "if true; then f(){ ls; }; else f(){ pwd; }; fi; f", simple: false },
  { text: 'powershell -c "\\$x=iex y"', simple: true }, // 1.0.4 F1: an assignment's right side is read; a read-only one is ordinary
  { text: 'powershell -c "Remove-Item -f ~"', simple: true },
  { text: "rm $FLAGS /", simple: true },
  { text: "echo $'\\q'", simple: true },
  { text: "echo $'\\0'", simple: true },
  { text: "echo -e \"a\\0101\" | sh", simple: false },
  { text: "echo \"a\\b\" | sh", simple: false },
  { text: "h(){ h \"$@\"; }; h", simple: false },
  { text: "f(){ shift; echo \"$1\"; }; f a b", simple: false },
  { text: "if true; then D=a; else D=b; fi; rm -r \"$D\"", simple: false },
  { text: "true || D=a; rm -r $D", simple: false },
  { text: "if true; then cd /a; fi; rm -r x", simple: false },
  { text: "[ -d x ] && cd x || cd /; rm -rf *", simple: false },
  { text: "fi", simple: false },
  { text: "cat <<EOF\nno end", simple: false },
  { text: "ls |||", simple: false },
  { text: "(( x", simple: false },
  // round 5: a value in a risky command's operand, however it got there
  { text: "g(){ D=/usr; }; f(){ g; }; D=/tmp; f; rm -rf \"$D\"", simple: false, defines: true },
  { text: "D=/usr; D=/tmp true; rm -rf \"$D\"", simple: false },
  { text: "D=/usr; D=/tmp | cat; rm -rf \"$D\"", simple: false },
  { text: "D=/usr; D=/tmp & wait; rm -rf \"$D\"", simple: false },
  { text: "D=/tmp; trap 'rm -rf \"$D\"' EXIT; D=/usr", simple: false },
  { text: "rm -rf \"$f\"", simple: true },
  { text: "rm -rf $d/x", simple: true },
  { text: "cat x > \"$o\"", simple: true },
  { text: "tee \"$o\"", simple: true },
  { text: "w(){ \"$@\"; }; w rm -rf build", simple: false, defines: true },
  { text: "R=rm; $R -rf build", simple: false },
  { text: "R=ls; R=rm | cat; $R -rf ~", simple: false },
  { text: "R=r; R+=m; $R -rf ~", simple: false },
  { text: "trap 'rm -rf build' EXIT", simple: true },
  { text: "cd \"$d\" && rm -rf x", simple: false },
];

/** Ordinary commands: nothing here asks, in any modeled context. */
const ORDINARY: Payload[] = [
  { text: "ls -la", simple: true },
  { text: "echo hi", simple: true },
  { text: "git status", simple: true },
  { text: "rm -rf build", simple: true, risky: true },
  { text: "rm -rf ./node_modules dist", simple: true, risky: true },
  { text: "rm -rf /tmp/murage-test", simple: true, risky: true },
  { text: 'echo "rm -rf /"', simple: true },
  { text: "echo ${X:-d}", simple: true },
  { text: "echo $((1+2))", simple: true },
  { text: "echo ${#X}", simple: true },
  { text: "echo ${X#pre}", simple: true },
  { text: "echo ${a[0]}", simple: true },
  { text: "echo $'\\x41' $'\\101'", simple: true },
  { text: "f(){ echo \"$1\"; }; f a", simple: false, defines: true },
  { text: "g(){ ls \"$@\"; }; g -la", simple: false, defines: true },
  { text: "if true; then D=a; else D=b; fi; echo \"$D\"", simple: false },
  { text: "n=0; true || n=1; echo $n", simple: false },
  { text: "find . -name x -exec rm {} +", simple: true, risky: true },
  { text: "cat <<EOF\ndata rm -rf /\nEOF\n", simple: true },
  { text: "cd /tmp/a", simple: true },
  { text: "X=1", simple: false },
  { text: 'echo "$X"', simple: true },
  { text: "(( i++ ))", simple: false },
  { text: "[[ -f x ]]", simple: false },
  { text: "f(){ echo hi; }; f", simple: false, defines: true },
  { text: "for i in 1 2; do echo $i; done", simple: false },
  { text: "trap \"echo bye\" EXIT", simple: true },
  { text: "true || X=1", simple: false },
  { text: "if true; then X=1; fi", simple: false },
  { text: "echo hi | sh", simple: false },
  { text: "powershell -c '$x = \"a\"'", simple: true },
  // a move is a write (UPSEC 2, WRITE): ordinary on its own, an ask from a trap body
  { text: "mv a b", simple: true, risky: true },
  { text: "cd \"$d\" && ls", simple: false },
  { text: "R=rm; R=ls; $R -rf ~", simple: false },
  { text: "D=/tmp; D=/usr true; echo \"$D\"", simple: false },
  // the closed-class reader reads these through (UPSEC 9) and finds a benign
  // target: they used to be outside the modeled set
  { text: "eval 'rm -rf build'", simple: true, risky: true },
  { text: "bash -c 'echo \"$1\"' -- x", simple: true },
  { text: "D=/usr; true && D=/tmp/x && rm -rf \"$D\"", simple: false, risky: true },
];

/** Round 5: a risky command with a value, substitution, arithmetic or
 * function argument in an operand asks on its own and in every context. */
const VALUE_OPERANDS: Payload[] = [
  { text: "rm -rf \"$D\"", simple: true },
  { text: "rm -rf $D/x", simple: true },
  { text: "rm \"$f\"", simple: true },
  { text: "rm -rf ${D:-/tmp/x}", simple: true },
  { text: "rm -rf $(pwd)/x", simple: true },
  { text: "rm -rf x$((1))", simple: true },
  { text: "rm -rf \"$1\"", simple: true, positional: true },
  { text: "rm -rf \"$@\"", simple: true, positional: true },
  { text: "rm $F x", simple: true },
  { text: "tee \"$LOG\"", simple: true },
  { text: "cat x > \"$OUT\"", simple: true },
  { text: "dd if=x of=y bs=$B", simple: true },
  { text: "find \"$D\" -delete", simple: true },
  { text: "Remove-Item -Recurse $d", simple: true },
  { text: "shred \"$f\"", simple: true },
  { text: "mv \"$a\" \"$b\"", simple: true },
  { text: "cp x \"$D/\"", simple: true },
  { text: "chmod -R 755 \"$D\"", simple: true },
  { text: "chown me $f", simple: true },
  { text: "sed -i s/a/b/ \"$f\"", simple: true },
];

/** A payload inside one to three modeled contexts, innermost first. */
function nest(random: () => number, payload: Payload, ordinary = false): { text: string; names: string[] } {
  let text = payload.text;
  let simple = payload.simple;
  // a text that ends with a heredoc terminator line can only take a
  // context that puts nothing after it, or encloses it
  let heredoc = /<<[^<]/.test(text);
  let casePattern = /\bcase\b/.test(text);
  let defines = payload.defines === true;
  const names: string[] = [];
  const layers = 1 + Math.floor(random() * 3);
  for (let i = 0; i < layers; i++) {
    const context = pick(random, CONTEXTS);
    if (context.simpleOnly && !simple) continue;
    if (context.singleQuotes && text.includes("'")) continue;
    if (context.backticks && text.includes("`")) continue;
    if (context.noBackslash && text.includes("\\")) continue;
    if (context.noLeadingNewline && /^\s*\n/.test(text)) continue;
    if (context.literalOnly && /[$*?]|\{[^}]*[,.]/.test(text)) continue;
    if (context.chainTail && defines) continue;
    if (context.indirect && payload.risky) continue;
    if (context.asks && ordinary) continue;
    if (context.delimiter && text.includes(context.delimiter)) continue;
    if (heredoc && !context.heredocSafe) continue;
    if (casePattern && context.parens) continue;
    text = context.wrap(text);
    names.push(context.name);
    simple = context.simpleOnly === true && !context.assigns && simple;
    heredoc = (heredoc && !context.encloses) || context.delimiter !== undefined;
    casePattern = (casePattern && !context.encloses) || context.casePatterns === true;
    defines = (defines && !context.encloses) || context.defines === true;
  }
  return { text, names };
}

const ROUNDS = 600;
const describeCase = (text: string, names: string[]) => `${JSON.stringify(text)} via ${names.join(" > ") || "plain"}`;

describe("the modeled set, by generation", () => {
  it("a catastrophe inside any nest of modeled constructs asks", () => {
    const random = rng(1);
    let exact = 0;
    const asked: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const payload = pick(random, CATASTROPHES);
      const { text, names } = nest(random, payload);
      const rule = alwaysAskCommand(text)?.rule;
      expect([payload.rule, "unreadable"], describeCase(text, names)).toContain(rule);
      if (rule === payload.rule) exact++;
      else asked.push(describeCase(text, names));
    }
    // the contexts are modeled, so nearly every one is read through to its own rule
    expect(exact / ROUNDS, asked.slice(0, 12).join("\n")).toBeGreaterThan(0.95);
  });

  it("a construct outside the modeled set asks wherever it sits", () => {
    const random = rng(2);
    for (let round = 0; round < ROUNDS; round++) {
      const payload = pick(random, UNMODELED);
      const { text, names } = nest(random, payload);
      expect(alwaysAskCommand(text)?.rule, describeCase(text, names)).toBe("unreadable");
    }
  });

  it("an ordinary command inside modeled constructs stays ordinary", () => {
    const random = rng(3);
    for (let round = 0; round < ROUNDS; round++) {
      const payload = pick(random, ORDINARY);
      const { text, names } = nest(random, payload, true);
      expect(alwaysAskCommand(text), describeCase(text, names)).toBeNull();
    }
  });

  it("a risky command with a value in an operand asks in every context", () => {
    const random = rng(5);
    for (let round = 0; round < ROUNDS; round++) {
      const payload = pick(random, VALUE_OPERANDS);
      const { text, names } = nest(random, payload);
      const bound = payload.positional === true && names.some((name) => BINDS_POSITIONALS.has(name));
      expect(bound ? ["unreadable", "unknown-target", undefined] : ["unreadable", "unknown-target"], describeCase(text, names)).toContain(alwaysAskCommand(text)?.rule);
    }
  });

  it("every context and every payload is reached by the generator", () => {
    const random = rng(4);
    const contexts = new Set<string>();
    for (let round = 0; round < ROUNDS * 4; round++) {
      for (const name of nest(random, pick(random, [...CATASTROPHES, ...UNMODELED, ...ORDINARY])).names) contexts.add(name);
    }
    expect([...contexts].sort()).toEqual(CONTEXTS.map((context) => context.name).sort());
  });
});
