// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-UNREADABLE (designs/NOLIMITS-UNREADABLE-1104.md R2, 1.0.16): on an owner-started No limits turn a command
// the reader could not follow runs, unless it is written in a way that hides what it runs. This is that test. It reads
// plain text with no shell model, so it errs toward a card: any construct below, at any position, keeps the card.
// It reads, it never runs anything. The only caller is wipeWordHold in auto-approve.ts.

import { homedir } from "node:os";
import { CMDS, POWERSHELLS } from "./pwsh.ts";

/** A fixed, value-free name for what was found; it goes to the log as `hide=`. */
export type Hiding =
  | "ansi-c" | "escape" | "eval" | "pipe-shell" | "procsub-shell" | "heredoc-shell" | "shell-c-expansion"
  | "interpreter-code" | "dynamic-command" | "function-call" | "runs-written-file" | "decoder-run" | "decode"
  | "unplain-command" | "unplain-path" | "pwsh-call" | "data-runner" | "process-sub" | "built-name";

const SHELLS = new Set<string>(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh", "busybox", ...POWERSHELLS, ...CMDS]);
/** Script runners (walk.ts INTERPRETERS): their code is a language the reader does not model. */
const INTERPRETERS = /^(?:python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|perl[\d.]*|ruby[\d.]*|php[\d.]*|lua|luajit|osascript|tclsh|wish|rscript|jshell|irb)$/;
/** The flag that hands a script runner its code on the command line (`python -c`, `node -e`, `perl -ne`, `php -r`). */
const INLINE_FLAG = /^(?:-[a-z]*[ce]|-r|--eval(?:=.*)?|--print|-p|--command(?:=.*)?|eval)$/i;
const SOURCE = new Set(["source", "."]);
const WRAP = new Set(["sudo", "doas", "run0", "pkexec", "env", "command", "builtin", "exec", "nohup", "nice", "time", "timeout", "stdbuf", "xargs", "parallel", "caffeinate", "arch", "unbuffer", "chronic"]);
const WRAP_VALUE = new Set(["-u", "-g", "-U", "-h", "-p", "-C", "-D", "-r", "-t", "-n", "-s", "-k", "-a", "-I", "-L", "-P", "-d", "-E"]);
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "(", ")"]);
const EVAL_WORDS = new Set(["eval", "iex", "invoke-expression", "invoke-command", "icm"]);
/** Octal, hex and unicode escapes outside `$'…'` (`\162`, `\0`, `\x72`, `r`): sed's `\1` is one digit and passes. */
const ESCAPE = /\\(?:0[0-7]{0,3}|[1-7][0-7]{2}|x[0-9a-f]{2}|u[0-9a-f]{4}|u\{[0-9a-f]+\}|U[0-9a-f]{8})/i;
/** A command substitution or a backtick where a command word goes: its output is what runs. */
const DYNAMIC_AT_START = /(?:^|[;&|\n(]|\b(?:then|do|else|elif|if|while|until|exec|sudo|doas|env|command|nohup|xargs)\s)\s*["']?(?:\$\(|`)/m;
/** A function head: `name()`, `name ()`, `function name`, with a body opener. */
const FUNCTION_HEAD = /(?:^|[\s;&|(){}])(?:function\s+([^\s;|&(){}<>"'`$=]+)\s*(?:\(\s*\))?\s*\{|([^\s;|&(){}<>"'`$=]+)\s*\(\s*\)\s*[{(])/g;
/** Programs that turn stored text back into code: their output must not reach a runner (`base64 -d > x; sh x`). */
const DECODER = /(?:^|[\s|;&(])(?:openssl\s+(?:enc|base64)|uudecode|gunzip|zcat|gzip\s+-d|bzcat|xzcat|unxz|rev(?:\s|$)|tr\s+["']?[a-z]-[a-z])/i;
/** `base64 … -d` and `xxd … -r` in one `|`, `;`, `&` or newline part, read once per part from the first such word
 * (1.0.17: as part of DECODER, `base64\s+(?:[^|;&\n]*\s)?-d` rescanned the rest of the part from every `base64`,
 * quadratic on a long one). */
function decoderIn(form: string): boolean {
  if (DECODER.test(form)) return true;
  for (const part of form.split(/[|;&\n]/)) {
    for (const [word, flag] of [[/(?:^|[\s(])base64\s+/i, /^(?:-d|--decode)|\s(?:-d|--decode)/i], [/(?:^|[\s(])xxd\s+/i, /^-r|\s-r/i]] as const) {
      const at = word.exec(part);
      if (at && flag.test(part.slice(at.index + at[0].length))) return true;
    }
  }
  return false;
}
/** A file this text writes: `> x`, `>> x`, `tee x`, `-o x`, `-O x`, `--output x`. */
const WRITTEN = /(?:>>?|\btee(?:\s+-a)?|\s-[oO]|--output(?:=|\s))\s*["']?([^\s;&|"'<>()]+)/g;
/** A quoted heredoc (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) is written as it stands: no expansion inside it. */
const QUOTED_HEREDOC = /<<-?\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\(\w+))[^\n]*\n/g;

const baseName = (word: string): string => word.replace(/^["']+|["']+$/g, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");

/** The text with `\`+newline and backtick+newline joined, as the shell joins them. */
export function joined(text: string): string {
  return text.replace(/\\\r?\n/g, "").replace(/`(?:\r\n|\r|\n)/g, "");
}

interface Segment { words: string[]; text: string; piped: boolean }
/** Every place a command starts: after `; & | && || ( { $( ` newline and the shell's keywords. Quotes are not modelled:
 * a separator inside quotes makes an extra segment, which can only find more. */
function segments(text: string): Segment[] {
  // `<(` and `>(` stay with their command, and so does xargs' and find's `{}`
  const marked = text.replace(/[<>]\(/g, "\u0001").replace(/\{\}/g, "\u0002");
  const out: Segment[] = [];
  const re = /(\|\||&&|\|&|\$\(|[;&|(){}`\n])/g;
  let last = 0, piped = false;
  const push = (part: string, nextPiped: boolean) => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    for (;;) {
      const word = words[i];
      if (word === undefined) break;
      if (KEYWORDS.has(word) || /^[A-Za-z_]\w*=/.test(word)) { i++; continue; }
      if (WRAP.has(baseName(word))) {
        i++;
        while (words[i] !== undefined && (words[i]!.startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(words[i]!) || /^[A-Za-z_]\w*=/.test(words[i]!))) {
          if (WRAP_VALUE.has(words[i]!)) i++;
          i++;
        }
        continue;
      }
      break;
    }
    const rest = words.slice(i);
    if (rest.length) out.push({ words: rest, text: part.replace(/\u0001/g, "<(").replace(/\u0002/g, "{}"), piped });
    piped = nextPiped;
  };
  for (const m of marked.matchAll(re)) {
    push(marked.slice(last, m.index), m[0] === "|" || m[0] === "|&");
    last = m.index + m[0].length;
  }
  push(marked.slice(last), false);
  return out;
}

/** Does a script runner read its code from stdin here: no script operand, or `-`? `-m module` names code on disk. */
function readsCodeFromStdin(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "-") return true;
    if (arg === "-m" || arg.startsWith("-m")) return false;
    if (arg.startsWith("-")) continue;
    return false;
  }
  return true;
}

/** A quoted heredoc fed to a command that is not a shell or a script runner is inert data (`cat > x.py <<'EOF'`):
 * its body is dropped from the scan, unless this text also runs a shell, a script runner or a path, which could run
 * what it wrote. */
function withoutInertBodies(text: string): string {
  const runsAFile = segments(text).some((s) => {
    const cmd = baseName(s.words[0]!);
    return SHELLS.has(cmd) || SOURCE.has(cmd) || INTERPRETERS.test(cmd) || /^[.~]?\//.test(s.words[0]!);
  });
  if (runsAFile) return text;
  let out = "", from = 0;
  for (const m of text.matchAll(QUOTED_HEREDOC)) {
    if (m.index < from) continue;
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const head = segments(text.slice(lineStart, m.index))[0];
    if (head && (SHELLS.has(baseName(head.words[0]!)) || INTERPRETERS.test(baseName(head.words[0]!)) || SOURCE.has(baseName(head.words[0]!)))) continue;
    const tag = (m[1] ?? m[2] ?? m[3])!;
    const bodyStart = m.index + m[0].length;
    const end = new RegExp(`^[\\t ]*${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\t ]*$`, "m").exec(text.slice(bodyStart));
    // an unterminated heredoc runs to the end of the text: keep it all in the scan
    if (!end) break;
    out += text.slice(from, bodyStart);
    from = bodyStart + end.index + end[0].length;
  }
  return out + text.slice(from);
}

/** The code a shell's `-c` takes: the next word, a quoted one to its closing quote (to the end of the text when the
 * quote never closes). */
function commandValue(rest: string): string {
  const text = rest.trimStart();
  const quote = text[0];
  if (quote === "'" || quote === '"') {
    for (let i = 1; i < text.length; i++) {
      if (quote === '"' && text[i] === "\\") { i++; continue; }
      if (text[i] === quote) return text.slice(1, i);
    }
    return text;
  }
  return /^[^\s;&|]*/.exec(text)![0];
}

/** The body of a function whose head ends at `open`: to its matching `}`, skipping quoted text, escapes and comments
 * (`: '}'`, `# }`). A `(` body, a body with a heredoc, or one that never closes runs to the end of the text, so a brace
 * the scan cannot place only makes the body longer (Astra r2 H2). */
function bodyAt(text: string, open: number): string {
  if (text[open - 1] !== "{") return text.slice(open);
  let depth = 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return text.slice(open);
      i = close;
      continue;
    }
    if (c === "#" && (i === 0 || /[\s;&|(){}]/.test(text[i - 1]!))) {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return text.slice(open);
      i = nl;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      const body = text.slice(open, i);
      return body.includes("<<") ? text.slice(open) : body;
    }
  }
  return text.slice(open);
}

/** A function that calls a function defined in this same text (itself or another): self and mutual recursion, every
 * fork-bomb shape (forkBombShape in walk.ts needs a call to its own name), with no length cap. */
export function functionCallsFunction(text: string): boolean {
  const heads = [...text.matchAll(FUNCTION_HEAD)].map((m) => ({ name: (m[1] ?? m[2])!, end: m.index + m[0].length }));
  if (!heads.length) return false;
  const names = new Set(heads.map((h) => h.name));
  for (const head of heads) {
    const words = bodyAt(text, head.end).split(/[\s;|&(){}<>`"'$]+/);
    if (words.some((w) => names.has(w))) return true;
  }
  return false;
}

/** The first construct in this text that can hide what it runs, or null. Every form of the text is scanned (as written,
 * and with quotes and backslashes taken out, so `e""val` and `ev\al` read as `eval`), whole: no early stop. */
export function hidingIn(text: string, dialect?: "pwsh"): Hiding | null {
  const j = joined(text);
  if (/\$['"]/.test(j)) return "ansi-c";
  // PowerShell: a backslash separates path parts (`C:\Temp\100`), it escapes nothing
  if (dialect !== "pwsh" && ESCAPE.test(j)) return "escape";
  const scanned = withoutInertBodies(j);
  // PowerShell: a `$name` word is a variable, not a command it runs
  if (dialect !== "pwsh" && DYNAMIC_AT_START.test(scanned)) return "dynamic-command";
  const unquoted = dialect === "pwsh" ? scanned.replace(/["'`]/g, "") : scanned.replace(/(?<!\\)["']/g, "").replace(/\\(.)/g, "$1");
  for (const form of [scanned, unquoted]) {
    const lower = form.toLowerCase();
    if (/\[scriptblock\]::create|frombase64string|invoke-expression/.test(lower)) return "eval";
    const windows = /(?:^|[\s\\/|;&(])(?:pwsh|powershell)(?:\.exe)?(?=[\s;|&)]|$)/.test(lower);
    if (windows && /(?:^|\s)[-/]e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?|c)?(?:\s|$)/.test(lower)) return "eval";
    if (/:\|:/.test(lower.replace(/\s+/g, "")) || /\$0\s*[|&]/.test(lower)) return "function-call";
    if (functionCallsFunction(form)) return "function-call";
    const written = new Set([...form.matchAll(WRITTEN)].map((m) => baseName(m[1]!)).filter((n) => n && n !== "null" && !/^&?\d$/.test(n)));
    const decoder = decoderIn(form);
    for (const seg of segments(form)) {
      const first = seg.words[0]!;
      const cmd = baseName(first);
      const args = seg.words.slice(1);
      if (dialect !== "pwsh" && /^(?:\$|"\$|'\$|\u0001)/.test(first)) return "dynamic-command";
      // a glob in a command word picks the program from the disk (`/bin/r[m]`, `/usr/bin/?m`) (design R2 H9)
      if (dialect !== "pwsh" && first !== "[" && first !== "[[" && /[[?*]/.test(first)) return "dynamic-command";
      if (EVAL_WORDS.has(cmd)) return "eval";
      const shell = SHELLS.has(cmd) || SOURCE.has(cmd);
      const interpreter = INTERPRETERS.test(cmd);
      if (cmd === "find") {
        const exec = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a));
        const run = exec >= 0 ? args[exec + 1] : undefined;
        if (run !== undefined && (/^["']?[$`]/.test(run) || /[[?*]/.test(run) || SHELLS.has(baseName(run)) || INTERPRETERS.test(baseName(run)))) return "pipe-shell";
      }
      if (/^[.~]?\//.test(first) && written.has(baseName(first))) return "runs-written-file";
      if (!shell && !interpreter) continue;
      const operand = args.find((a) => !a.startsWith("-"));
      if (operand !== undefined && written.has(baseName(operand))) return "runs-written-file";
      if (seg.piped && (shell || readsCodeFromStdin(args))) return "pipe-shell";
      if (seg.text.includes("<(") || seg.text.includes(">(")) return "procsub-shell";
      if (/<<</.test(seg.text) && (shell || readsCodeFromStdin(args))) return "heredoc-shell";
      if (/<<(?!<)/.test(seg.text) && (shell || readsCodeFromStdin(args))) return "heredoc-shell";
      if (interpreter && args.some((a) => INLINE_FLAG.test(a))) return "interpreter-code";
      if (decoder) return "decoder-run";
      if (shell && !SOURCE.has(cmd)) {
        const flag = args.findIndex((a) => /^-[a-z]*c$|^\/[ck]$|^-command$|^-c$/i.test(a));
        if (flag >= 0) {
          const at = seg.text.indexOf(args[flag]!, seg.text.indexOf(first)) + args[flag]!.length;
          if (/[$`]/.test(commandValue(form.slice(form.indexOf(seg.text) + at)))) return "shell-c-expansion";
        }
      }
    }
  }
  return null;
}

const ONE: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };
/** The text as bash reads it, every `$'…'` span decoded (octal and hex as bytes, a word ends at a NUL) and every octal,
 * hex and unicode escape outside one decoded too. Throws on a span with no end or a code point past Unicode: the
 * caller keeps the card. */
export function decodedForm(text: string): string {
  const escape = (_e: string, esc: string): string => {
    const lead = esc[0]!;
    if ((lead === "x" || lead === "u" || lead === "U") && esc.length > 1) {
      const point = parseInt(esc.slice(1).replace(/[{}]/g, ""), 16);
      if (!(point <= 0x10ffff)) throw new Error("decode");
      return lead === "x" ? String.fromCharCode(point & 0xff) : String.fromCodePoint(point);
    }
    if (/[0-7]/.test(lead)) return String.fromCharCode(parseInt(esc, 8) & 0xff);
    if (lead === "c" && esc.length === 2) return String.fromCharCode(esc.charCodeAt(1) & 0x1f);
    return ONE[lead] ?? lead;
  };
  const j = joined(text);
  const spans = /\$'((?:[^'\\]|\\[\s\S])*)'/g;
  if (/\$'/.test(j.replace(spans, ""))) throw new Error("decode");
  const ansi = j.replace(spans, (_w, body: string) => body.replace(/\\(x[0-9a-fA-F]{1,2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g, escape).split("\0")[0]!);
  return ansi.replace(/\\(x[0-9a-fA-F]{1,2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|0[0-7]{0,3}|[1-7][0-7]{2})/g, escape).replace(/\0[^\s]*/g, "");
}

// NOLIMITS-UNREADABLE r3 (1.0.16, the structural rule): on the waiver path a text the reader could not follow runs only
// when every command word, and every argument that could name a file, is a plain literal: no `$` expansion of any kind,
// no backtick, no brace expansion, no glob, no `~user`; and, in PowerShell, no call operator, no Invoke-Expression and
// no encoded command. Arguments count as file names unless the command only prints or tests them (`echo`, `printf`);
// a redirect target always does. The scan is quote aware; what it cannot place keeps the card.

/** One word as the shell would split it: `open` when any part of it is not a plain literal. */
interface PlainWord { text: string; open: boolean; redirect: boolean; data: boolean; varOnly?: boolean; refs?: VarRef[]; subOnly?: boolean; globbed?: boolean }
/** A simple variable read (`$f`, `${f}`, `${f%.png}`, `$1`) at [start, end) of the whole text. */
interface VarRef { name: string; op: string; lit: string; start: number; end: number; lead: boolean }
/** Where `{`, `}`, `do`, `done` and a function name `name()` sit, as the count of commands read before them. */
interface ScanEvent { k: "open" | "close" | "do" | "done" | "def"; at: number; name?: string }
interface PlainScan { commands: PlainWord[][]; pwshCall: boolean; quotedCode: boolean; events: ScanEvent[]; procSub?: boolean }

/** Commands whose arguments are printed, tested or stored, never opened as files or run. */
const DATA_COMMANDS = new Set(["echo", "printf", "[", "[[", "test", "true", "false", ":", "wait", "sleep", "exit", "return", "shift", "local", "declare", "typeset", "export", "readonly"]);
const PWSH_DATA = new Set(["write-host", "write-output", "echo", "write-verbose", "write-warning", "write-debug", "write-information", "start-sleep", "sleep"]);
/** Keywords before a command word. */
const PLAIN_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time", "function", "coproc", "esac"]);
/** An assignment to one of these changes what later words find or run (`PATH=$x ls`): its value must be plain. */
const STEERING = /^(?:PATH|IFS|HOME|CDPATH|ENV|BASH_ENV|PROMPT_COMMAND|GLOBIGNORE|ZDOTDIR|NODE_OPTIONS|PERL5OPT|RUBYOPT|PYTHONSTARTUP|PS4|SHELLOPTS|BASHOPTS|LD_\w+|DYLD_\w+|\w*PATH|\w*LIB)\+?=/;
/** bash reads these as arithmetic, which runs `$(…)` held in a quoted value (`x='a[$(cmd)]'; [[ $x -eq 1 ]]`). */
const ARITH_TRIGGER = /\(\(|\$\[|\blet\s|\s-(?:eq|ne|lt|le|gt|ge|v)\s|\b(?:declare|typeset|local|export|readonly)\s+-\w*[iaA]|\bprintf\s+-v|\bread\b|\bunset\b|\$\{\w+[[:]|\w\[/;
/** MurageMain ruling (a), 1.0.16 r3: options whose value is text a program reads as words, never a file it opens. A
 * double-quoted `$(…)` may stand as such a value (`--prompt "$(cat notes.txt)"`) when its own commands pass this rule;
 * the output is one word of data. Long options only: a short `-m` or `-p` names a module or a path in some programs. */
const DATA_OPTION = /^--(?:prompt|message|title|body|text|description|query|comment|subject|caption|summary|instructions|system-prompt|append-system-prompt)$/;
/** xargs and parallel options that take a value. */
const XARGS_VALUE = new Set(["-I", "-J", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "-R", "-S", "--replace", "--max-args", "--max-procs", "--delimiter", "--arg-file", "-j", "--jobs"]);

/** The index just past the `close` that matches the `open` at `start`, skipping quotes, escapes and nested
 * substitutions; the text's end when it never closes (the scan then reads it all as the inner part). */
function matchClose(src: string, start: number, open: string, close: string, pwsh: boolean): number {
  const esc = pwsh ? "`" : "\\";
  let depth = 1;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i]!;
    if (c === esc) { i++; continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e < 0) return src.length; i = e; continue; }
    if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === esc) i++;
        else if (src[i] === "$" && src[i + 1] === "(") i = matchClose(src, i + 1, "(", ")", pwsh) - 1;
      }
      continue;
    }
    if (!pwsh && c === "`") { const e = src.indexOf("`", i + 1); if (e < 0) return src.length; i = e; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Every `$(…)` and backtick inside text the scan does not split into words (an unquoted heredoc body, `${…}`,
 * `$((…))`): each one runs, so each is read as commands. */
function scanSubstitutions(text: string, pwsh: boolean, into: PlainScan, base = 0): void {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === (pwsh ? "`" : "\\")) { i++; continue; }
    if (c === "$" && text[i + 1] === "(") {
      const end = matchClose(text, i + 1, "(", ")", pwsh);
      scanInto(text.slice(i + 2, end - 1), pwsh, into, base + i + 2);
      i = end - 1;
    } else if (!pwsh && c === "`") {
      let e = i + 1;
      while (e < text.length && text[e] !== "`") e += text[e] === "\\" ? 2 : 1;
      scanInto(text.slice(i + 1, e), pwsh, into, base + i + 1);
      i = e;
    }
  }
}

/** Splits `src` into commands of words, as bash (or PowerShell) would, marking each word that is not a plain literal.
 * Commands inside substitutions are added as commands of their own. */
function scanInto(src: string, pwsh: boolean, into: PlainScan, base = 0): void {
  const esc = pwsh ? "`" : "\\";
  let cur: PlainWord[] = [];
  let word = "", raw = "", inWord = false, open = false, glob = false, brace = false, quoted = false, sub = false;
  let nextRedirect = false, nextData = false, nextTag: "" | "<<" | "<<-" = "";
  let refs: VarRef[] = [];
  const heredocs: { tag: string; quoted: boolean; strip: boolean }[] = [];
  const endWord = () => {
    if (!inWord) return;
    if (nextTag) heredocs.push({ tag: word, quoted, strip: nextTag === "<<-" });
    else {
      const globWord = glob && !/^(?:\[\[?|\]\]?)$/.test(raw);
      const wordOpen = open || globWord;
      if (!cur.length && !wordOpen && !refs.length && !quoted && (word === "do" || word === "done")) into.events.push({ k: word, at: into.commands.length });
      // `subOnly`: the word opens only through double-quoted `$(…)` (whose commands are read as commands of their own)
      // and variable reads; it may stand as a data argument (unplainCore), never as a command word or a path
      cur.push({ text: word, open: wordOpen || refs.length > 0 || sub, redirect: nextRedirect, data: nextData, ...(refs.length ? { varOnly: !wordOpen && !sub, refs } : {}), ...(sub && !wordOpen ? { subOnly: true } : {}), ...(globWord || brace ? { globbed: true } : {}) });
    }
    word = raw = ""; inWord = open = glob = brace = quoted = sub = false; nextRedirect = nextData = false; nextTag = ""; refs = [];
  };
  const endCommand = () => { endWord(); if (cur.length) into.commands.push(cur); cur = []; };
  const add = (text: string) => { word += text; raw += text; inWord = true; };
  /** A simple variable read the resolver may substitute (bash only): it does not open the word by itself. */
  const addRef = (s: number, e: number, name: string, op = "", lit = ""): number => {
    refs.push({ name, op, lit, start: base + s, end: base + e, lead: word === "" });
    word += src.slice(s, e); raw += src.slice(s, e); inWord = true;
    return e - 1;
  };
  /** A `$` at `i`: what it expands, read to its end. Returns the index of its last character. */
  const dollar = (i: number, inQuote = false): number => {
    const n = src[i + 1];
    if (n === "(" && src[i + 2] === "(" && !pwsh) {
      const end = matchClose(src, i + 1, "(", ")", pwsh);
      scanSubstitutions(src.slice(i + 3, end - 1), pwsh, into, base + i + 3);
      add(src.slice(i, end)); open = true; return end - 1;
    }
    if (n === "(") {
      const end = matchClose(src, i + 1, "(", ")", pwsh);
      scanInto(src.slice(i + 2, end - 1), pwsh, into, base + i + 2);
      // unquoted, its output is split and globbed into words the text never shows; quoted, it is one word
      add(src.slice(i, end));
      if (inQuote && !pwsh && src[end - 1] === ")") sub = true; else open = true;
      return end - 1;
    }
    if (n === "{" || (n === "[" && !pwsh)) {
      const end = matchClose(src, i + 1, n, n === "{" ? "}" : "]", pwsh);
      const simple = n === "{" && !pwsh && src[end - 1] === "}" ? /^([A-Za-z_]\w*|[1-9])(?:(%%?|##?)([\w.+-]*))?$/.exec(src.slice(i + 2, end - 1)) : null;
      if (simple) return addRef(i, end, simple[1]!, simple[2] ?? "", simple[3] ?? "");
      scanSubstitutions(src.slice(i + 2, end - 1), pwsh, into, base + i + 2);
      add(src.slice(i, end)); open = true; return end - 1;
    }
    if (n === "'" && !pwsh) {
      let e = i + 2;
      while (e < src.length && src[e] !== "'") e += src[e] === "\\" ? 2 : 1;
      add(src.slice(i, e + 1)); open = true; return e;
    }
    const name = pwsh ? /^(?:[A-Za-z_][\w]*(?::[\w]+)?|[$?^_]|\d+)/.exec(src.slice(i + 1)) : /^(?:[A-Za-z_]\w*|\d|[@*#?$!-])/.exec(src.slice(i + 1));
    if (name && !pwsh && /^(?:[A-Za-z_]\w*|[1-9])$/.test(name[0])) return addRef(i, i + 1 + name[0].length, name[0]);
    // PowerShell's $HOME is a constant the text cannot change; no other PowerShell variable resolves
    if (name && pwsh && /^home$/i.test(name[0])) return addRef(i, i + 1 + name[0].length, "HOME");
    if (name) { add(src.slice(i, i + 1 + name[0].length)); open = true; return i + name[0].length; }
    if (n === '"') { open = true; inWord = true; return i; }
    add("$");
    return i;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === esc) {
      if (next === "\n") { i++; continue; }
      if (next === "\r" && src[i + 2] === "\n") { i += 2; continue; }
      if (next !== undefined) { word += next; raw += c + next; inWord = true; quoted = true; }
      i++;
      continue;
    }
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      const body = src.slice(i + 1, e < 0 ? src.length : e);
      if (/\$[({]|`/.test(body)) into.quotedCode = true;
      word += body; raw += src.slice(i, e < 0 ? src.length : e + 1); inWord = true; quoted = true;
      i = e < 0 ? src.length : e;
      continue;
    }
    if (c === '"') {
      inWord = true; quoted = true; raw += '"';
      let j = i + 1;
      for (; j < src.length; j++) {
        const d = src[j]!;
        if (d === '"') { if (pwsh && src[j + 1] === '"') { word += '"'; j++; continue; } break; }
        if (d === esc) { word += src[j + 1] ?? ""; j++; continue; }
        if (d === "$") { j = dollar(j, true); continue; }
        if (!pwsh && d === "`") {
          let e = j + 1;
          while (e < src.length && src[e] !== "`") e += src[e] === "\\" ? 2 : 1;
          scanInto(src.slice(j + 1, e), pwsh, into, base + j + 1);
          open = true; j = e; continue;
        }
        word += d;
      }
      raw += '"';
      i = j;
      continue;
    }
    if (c === "$") { i = dollar(i); continue; }
    if (!pwsh && c === "`") {
      let e = i + 1;
      while (e < src.length && src[e] !== "`") e += src[e] === "\\" ? 2 : 1;
      scanInto(src.slice(i + 1, e), pwsh, into, base + i + 1);
      add(src.slice(i, e + 1)); open = true; i = e;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") { endWord(); continue; }
    if (c === "\n") {
      endCommand();
      // heredoc bodies start on the next line: a quoted one is data as written, an unquoted one runs its substitutions
      let at = i + 1;
      for (const doc of heredocs.splice(0)) {
        let end = src.length, after = src.length;
        const lines = src.slice(at).split("\n");
        let pos = at;
        for (const line of lines) {
          const bare = line.replace(/\r$/, "");
          if ((doc.strip ? bare.replace(/^\t+/, "") : bare) === doc.tag) { end = pos; after = pos + line.length; break; }
          pos += line.length + 1;
        }
        if (!doc.quoted) scanSubstitutions(src.slice(at, end), pwsh, into, base + at);
        at = Math.min(src.length, after + 1);
      }
      i = at - 1;
      continue;
    }
    if (c === "#" && !inWord) {
      if (pwsh && src[i - 1] === "<") continue;
      const nl = src.indexOf("\n", i);
      i = (nl < 0 ? src.length : nl) - 1;
      continue;
    }
    if (pwsh && c === "<" && next === "#") { const e = src.indexOf("#>", i + 2); i = e < 0 ? src.length : e + 1; continue; }
    // redirections: the word after one names a file; a number before it is the stream, not a word
    if (c === "<" || c === ">" || (c === "&" && next === ">") || (pwsh && c === "*" && next === ">")) {
      if (/^\d+$/.test(raw) && !quoted) { word = raw = ""; inWord = false; }
      else endWord();
      if ((c === "<" || c === ">") && next === "(" && !pwsh) {
        const end = matchClose(src, i + 1, "(", ")", pwsh);
        scanInto(src.slice(i + 2, end - 1), pwsh, into, base + i + 2);
        into.procSub = true;
        cur.push({ text: "<(…)", open: true, redirect: false, data: false });
        i = end - 1;
        continue;
      }
      const op = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||&>>|&>|\*>>|\*>|<|>)/.exec(src.slice(i))![0];
      // `2>&1`, `>&-`: a stream, not a file
      const dup = /^[<>]&$/.exec(op) && /^(?:\d+|-)/.exec(src.slice(i + op.length));
      if (dup) { i += op.length + dup[0].length - 1; continue; }
      if (op === "<<<") nextData = true;
      else if (op.startsWith("<<")) nextTag = op === "<<-" ? "<<-" : "<<";
      else nextRedirect = true;
      i += op.length - 1;
      continue;
    }
    if (c === "&" && pwsh && next !== "&") { into.pwshCall = true; endCommand(); continue; }
    if (c === ";" || c === "|" || c === "&") { endCommand(); if ((c === "&" || c === "|") && next === c) i++; continue; }
    if (c === "(" || c === ")") {
      // `name()` defines a function; `@(…)` and `arr=(…)` right after a word are read as an open word
      if (c === "(" && inWord) {
        const close = /^\s*\)/.exec(src.slice(i + 1));
        if (close) {
          endWord();
          if (cur.length === 1 && !cur[0]!.open) { into.events.push({ k: "def", at: into.commands.length, name: cur[0]!.text }); cur = []; }
          endCommand(); i += close[0].length; continue;
        }
        open = true;
      }
      endCommand();
      continue;
    }
    if (c === "{" || c === "}") {
      if (pwsh || (!inWord && (next === undefined || /[\s;]/.test(next)) && c === "{") || (!inWord && c === "}")) { endCommand(); into.events.push({ k: c === "{" ? "open" : "close", at: into.commands.length }); continue; }
      if (c === "{" && next === "}") { add("{}"); i++; continue; }
      add(c); open = true; if (c === "{") brace = true;
      continue;
    }
    if (!pwsh && (c === "*" || c === "?" || c === "[")) { add(c); glob = true; continue; }
    if (pwsh && (c === "*" || c === "?" || c === "[")) { add(c); glob = true; continue; }
    // `~bob`, `~+` and `~-` name a folder the text never spells out; `~` and `~/` are the home folder
    if (c === "~" && (!inWord || /[=:]$/.test(raw))) {
      if (next !== undefined && !/[\s/;&|)<>]/.test(next)) open = true;
      add(c);
      continue;
    }
    // zsh reads `=name` at a word's start as the path of a program
    if (c === "=" && !inWord && next !== undefined && /[\w./]/.test(next)) { add(c); open = true; continue; }
    if (pwsh && c === "@" && !inWord && next !== undefined && /[A-Za-z_]/.test(next)) { add(c); open = true; continue; }
    add(c);
  }
  endCommand();
}

/** A value the resolver substitutes: no space, quote, glob, tilde or `$`, so splitting and globbing leave it whole. */
const SAFE_VALUE = /^[\w./+@%,:-]+$/;
/** At most this many substituted texts; past it the text asks. */
const MAX_RESOLVED = 64;

/** MurageMain ruling, 1.0.16 r3 ("resolve, then check"): the values a variable read can take, when every one is known
 * from the same text, or null. Four bindings only: a for-loop over literal words (reads inside its body); assignments
 * from a literal at the very start of the text; `$1`..`$9` inside the one function that reads them, when every call
 * site passes literals; and `$HOME`, or `$PWD` before a slash, when the text never changes them. A name the text names
 * anywhere else (another assignment, `read`, arithmetic, a comment, a quoted string) is not resolved. */
/** Builtins that can write a variable whose name the text builds at run time (`printf -v "$(…)UT"`), sourcing, aliases
 * and arithmetic (which assigns names it expands): any of them turns the resolver off for the whole text. */
const NAME_WRITERS = /\b(?:read|readarray|mapfile|declare|typeset|local|export|readonly|unset|getopts|let|eval|source|coproc|alias|enable|builtin)\b|(?:^|[\s;&|(){}])\.\s|\$\{!\w*:?=/;

/** `printf … -v` and `wait … -p` in one command: the word, then ` -v`/` -p` later in the same `;`, `&`, `|` or newline
 * part. Read once per part from its first such word (1.0.17: the regex form `\bprintf\b[^;&|\n]*\s-v` rescanned the
 * rest of the part from every `printf`, quadratic on a long one). */
function writesNamedValue(text: string): boolean {
  for (const part of text.split(/[;&|\n]/)) {
    for (const [word, flag] of [[/\bprintf\b/, /\s-v/], [/\bwait\b/, /\s-p/]] as const) {
      const at = word.exec(part);
      if (at && flag.test(part.slice(at.index + at[0].length))) return true;
    }
  }
  return false;
}

/** Code handed to another shell on the readable path: read the same way, with no resolving (its variables are unknown). */
function innerReach(code: string, dialect: "pwsh" | undefined): Hiding | null {
  const hit = unplainCore(code, dialect, false, true);
  return typeof hit === "string" || hit === null ? hit : hit.hit;
}

/** Stands in for a variable read nobody can fill: it reaches anywhere. */
const UNKNOWN = "\u0000";
const SYSTEM_PREFIX = /^\/(?:etc|library|system|usr|private|var)(?:\/|$)/i;
/** Options and qualifiers that let a glob match a leading dot (bash dotglob, GLOBIGNORE, zsh GLOB_DOTS and `(D)`, extglob
 * and zsh qualifiers right after a glob). */
const dotModeOf = (text: string): boolean => /dotglob|glob_?dots|GLOBIGNORE/i.test(text) || /[*?\]@!+]\(/.test(text);

/** One path segment that is, or could match, a name starting with "." (`.ssh`, `..`, `.[s]sh`, `.ss?`, `[.]ssh`,
 * `[!x]sh`, `{x,.ssh}`), or any glob when the text lets globs match dots. */
function segmentReaches(seg: string, dotMode: boolean): boolean {
  if ((seg.startsWith(".") && seg !== ".") || seg.includes(UNKNOWN)) return true;
  if (/^\[[!^]/.test(seg) || /^\[[^\]]*\./.test(seg) || /[{,]\./.test(seg)) return true;
  return dotMode && /^[*?[]/.test(seg);
}

/** MurageMain ruling (c), 1.0.16 r3: whether a path word with a glob, a brace or a variable the text does not give could
 * reach a protected place: a literal prefix of `~`, `$HOME`, the home folder or a system folder (/etc, /Library,
 * /System, /usr, /private, /var); any segment that starts with "." or could match one; any variable nobody can fill; a
 * brace alternative that starts a new absolute or home path. A relative glob with no dot segment (`*.txt`, `src/*.ts`)
 * does not reach. Anything else that opens the word (a substitution, `~user`, zsh `=cmd`) reaches. */
function globReaches(t: string, pwsh: boolean, dotMode: boolean, cdMoved = false): boolean {
  if (t.includes(UNKNOWN) || /[$`()]/.test(t) || t.startsWith("=") || /^~[^/\\]/.test(t)) return true;
  if (cdMoved && /[*?[{]/.test(t)) return true;
  // `//etc`, `/./etc` and `/x/../etc` name the same folders; a glob or brace in the first folder of an absolute path
  // (`/[e]tc`, `/?ar`) could be any of them
  const abs = !pwsh && t.startsWith("/");
  const n = abs ? t.replace(/\/(?:\.?\/)+/g, "/") : t;
  if (abs && /(?:^|\/)\.\.(?:\/|$)/.test(n)) return true;
  if (abs && /[*?[{]/.test(n.split("/")[1] ?? "")) return true;
  const home = homedir().toLowerCase();
  const low = n.toLowerCase();
  if (n.startsWith("~") || (home !== "" && (low === home || low.startsWith(home + "/") || low.startsWith(home + "\\"))) || SYSTEM_PREFIX.test(n)) return true;
  if (/[{,][/~\\]/.test(t) || (t.includes("{") && t.includes("~"))) return true;
  if (pwsh && (/^[A-Za-z]:/.test(t) || t.startsWith("\\"))) return true;
  return n.split(pwsh ? /[\\/]/ : "/").some((seg) => segmentReaches(seg, dotMode));
}

/** cd and its kin: the shell builtins, and PowerShell's location cmdlets and their aliases. */
const MOVERS = new Set(["cd", "pushd", "popd", "chdir", "set-location", "sl", "push-location", "pop-location"]);
const ASSIGNMENT = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/;
interface DirectoryMove { at: number; same: boolean; targets: string[] | null }

/** MurageMain ruling (1), 1.0.16 r3: every directory change in the text, however it is reached: cd, pushd, popd, chdir,
 * Set-Location and Push-Location after keywords, assignments and any wrapper (command, builtin, exec, env, nohup, time,
 * sudo and the rest of WRAP), and a wrapper's own folder option (`env -C`, `sudo -D`, `--chdir`), which moves only the
 * command it runs (`same`). `targets` holds every folder it can move to, with `~` spelled as the home path, or null when
 * the text does not say (a variable it does not give, `-`, popd, a stack index, `~user`, zsh's two-word form, a relative
 * folder while CDPATH is named). */
function directoryMoves(text: string, scan: PlainScan, pwsh: boolean, valuesOf: (ref: VarRef) => string[] | null): DirectoryMove[] {
  const home = homedir();
  const cdpath = /CDPATH/i.test(text);
  // a text that sets HOME moves where `cd` and `~` go
  const homeSet = /(?:^|[\s;&|(])HOME\+?=/.test(text);
  const targetsOf = (w: PlainWord | undefined, spelled = w?.text): string[] | null => {
    if (!w || spelled === undefined) return null;
    let values = [spelled];
    if (w.open) {
      if (!w.varOnly || !w.refs?.length) return null;
      for (const r of w.refs) {
        const v = valuesOf(r);
        if (!v || v.some((x) => /[*?[{]/.test(x))) return null;
        const raw = text.slice(r.start, r.end);
        values = values.flatMap((t) => v.map((x) => t.replace(raw, x)));
        if (values.length > MAX_RESOLVED) return null;
      }
    }
    const out: string[] = [];
    for (const t of values) {
      if (t === "" || t === "-" || /^[+-]\d/.test(t) || /^~[^/\\]/.test(t) || (homeSet && t.startsWith("~"))) return null;
      const full = t === "~" ? home : /^~[/\\]/.test(t) ? home + t.slice(1) : t;
      if (cdpath && !/^[/\\]|^[A-Za-z]:/.test(full)) return null;
      out.push(full);
    }
    return out;
  };
  const moves: DirectoryMove[] = [];
  const moveAt = (at: number, plain: PlainWord[], j: number) => {
    const name = baseName(plain[j]!.text);
    if (name === "popd" || name === "pop-location") { moves.push({ at, same: false, targets: null }); return; }
    const args = plain.slice(j + 1).filter((a) => a.open || a.text === "-" || !a.text.startsWith("-"));
    if (!args.length) moves.push({ at, same: false, targets: name === "pushd" || name === "push-location" || homeSet ? null : [home] });
    else moves.push({ at, same: false, targets: args.length === 1 ? targetsOf(args[0]) : null });
  };
  scan.commands.forEach((words, at) => {
    const plain = words.filter((w) => !w.redirect && !w.data);
    let k = 0;
    while (plain[k] && ((!plain[k]!.open && PLAIN_KEYWORDS.has(plain[k]!.text)) || (!pwsh && ASSIGNMENT.test(plain[k]!.text)))) k++;
    const lead = k;
    const first = plain[lead];
    if (!first || first.open) return;
    // a lone path as the whole command moves there under zsh's AUTO_CD
    if (plain.length === lead + 1 && /[\\/]|^~$|^\.\.$/.test(first.text)) {
      const t = targetsOf(first);
      if (t === null || t.some((x) => protectedPlace(x, pwsh))) moves.push({ at, same: false, targets: t });
    }
    // a wrapper's own folder option moves the command it runs
    while (plain[k] && !plain[k]!.open && WRAP.has(baseName(plain[k]!.text))) {
      k++;
      while (plain[k] && (plain[k]!.text.startsWith("-") || ASSIGNMENT.test(plain[k]!.text) || (!plain[k]!.open && /^\d+(?:\.\d+)?[smhd]?$/.test(plain[k]!.text)))) {
        const o = plain[k]!.text;
        const joined = /^--chdir=(.*)$/.exec(o);
        if (joined) moves.push({ at, same: true, targets: targetsOf(plain[k], joined[1]) });
        else if (/^(?:-C|-D|--chdir)$/.test(o)) moves.push({ at, same: true, targets: targetsOf(plain[k + 1]) });
        if (WRAP_VALUE.has(o) || o === "--chdir") k++;
        k++;
      }
    }
    // a mover after any wrapper or precommand word (sudo, env, command, builtin, exec, nohup, noglob, setsid, ...): the
    // first mover word anywhere in the command, unless the command only prints its words
    if (DATA_COMMANDS.has(baseName(first.text)) || PWSH_DATA.has(baseName(first.text))) return;
    const j = plain.findIndex((w, at2) => at2 >= lead && !w.open && MOVERS.has(baseName(w.text)));
    if (j >= 0) moveAt(at, plain, j);
  });
  return moves;
}

/** A folder a move lands in that holds, or could hold, protected places: the root, a drive root, the home folder itself,
 * a system folder, any folder with a segment that starts with "." (`.ssh`, `..`), or a glob that could reach one. */
function protectedPlace(t: string, pwsh: boolean): boolean {
  const home = homedir().replace(/[\\/]+$/, "").toLowerCase();
  const n = t.replace(/[\\/]+$/, "").toLowerCase();
  if (n === "" || n === home || /^[a-z]:$/.test(n)) return true;
  if (/[*?[{]/.test(t)) return globReaches(t, pwsh, false);
  if (!pwsh && SYSTEM_PREFIX.test(t.replace(/\/(?:\.?\/)+/g, "/"))) return true;
  if (pwsh && /^[a-z]:[\\/](?:windows|program ?files|programdata)(?:[\\/]|$)/i.test(t)) return true;
  return t.split(/[\\/]/).some((seg) => seg.startsWith(".") && seg !== ".");
}

interface Spot { text: string; relative: boolean; redirect: boolean }
/** A command's words for ruling (1), each variable read the text gives written as its values (one word per value), each
 * marked when it is a relative path: not an option, an absolute or home path, a keyword, an assignment, a printed or
 * tested argument, or a command word with no slash. An open word the text does not give stays as written, unmarked (the
 * path checks read it). */
function relativeSpots(words: PlainWord[], pwsh: boolean, valuesOf: (ref: VarRef) => string[] | null, text: string): { relative: boolean; words: Spot[] } {
  const out: Spot[] = [];
  let lead = true, printed = false;
  const isRelative = (t: string) => t !== "" && !t.startsWith("-") && !/^[/\\~]|^[A-Za-z]:/.test(t);
  for (const w of words) {
    if (w.data) continue;
    let values = [w.text];
    if (w.open) {
      const known = w.varOnly && w.refs?.length && w.refs.every((r) => valuesOf(r)?.length);
      if (!known) { out.push({ text: w.text, relative: false, redirect: w.redirect }); if (!w.redirect) lead = false; continue; }
      for (const r of w.refs!) { const raw = text.slice(r.start, r.end); values = values.flatMap((t) => valuesOf(r)!.map((x) => t.replace(raw, x))).slice(0, MAX_RESOLVED); }
    }
    for (const t of values) {
      if (w.redirect) { out.push({ text: t, relative: isRelative(t), redirect: true }); continue; }
      if (lead && ((!w.open && PLAIN_KEYWORDS.has(t)) || (!pwsh && ASSIGNMENT.test(t)))) { out.push({ text: t, relative: false, redirect: false }); continue; }
      if (lead) {
        lead = false;
        printed = pwsh ? PWSH_DATA.has(baseName(t)) : DATA_COMMANDS.has(baseName(t));
        out.push({ text: t, relative: /[\\/]/.test(t) && isRelative(t), redirect: false });
        continue;
      }
      out.push({ text: t, relative: !printed && isRelative(t), redirect: false });
    }
  }
  return { relative: out.some((s) => s.relative), words: out };
}

function resolverOf(text: string, scan: PlainScan, pwsh: boolean, reach = false): (ref: VarRef) => string[] | null {
  const leadOf = (words: PlainWord[]) => { let i = 0; while (words[i] && !words[i]!.open && PLAIN_KEYWORDS.has(words[i]!.text)) i++; return i; };
  // MurageMain ruling (d), 1.0.16 r3: `local x="$1"` and `x="$1"` bind a name to a positional argument. A command that
  // is only such bindings is recorded; when every `local` in the text is of that form, `local` alone does not turn the
  // resolver off. Any other `local` (a flag, a value from elsewhere) keeps it off.
  const POS_BIND = /^([A-Za-z_]\w*)=(?:\$([1-9])|\$\{([1-9])\})$/;
  const posBound = new Map<string, { n: string; at: number } | null>();
  let pureLocals = true;
  scan.commands.forEach((words, at) => {
    const i = leadOf(words);
    const isLocal = words[i]?.text === "local" && !words[i]!.open;
    const binds = words.slice(isLocal ? i + 1 : i);
    const pure = binds.length > 0 && binds.every((w) => !w.redirect && !w.data && POS_BIND.test(w.text) && w.refs?.length === 1 && w.refs[0]!.op === "");
    if (isLocal && !pure) pureLocals = false;
    if (!pure || (!isLocal && words.length !== binds.length)) return;
    for (const w of binds) { const m = POS_BIND.exec(w.text)!; posBound.set(m[1]!, posBound.has(m[1]!) ? null : { n: (m[2] ?? m[3])!, at }); }
  });
  const writerText = pureLocals ? text.replace(/\blocal\b/g, " ") : text;
  if (!pwsh && (NAME_WRITERS.test(writerText) || writesNamedValue(writerText) || ARITH_TRIGGER.test(writerText))) return () => null;
  const located: { ref: VarRef; at: number }[] = [];
  scan.commands.forEach((words, at) => { for (const w of words) for (const ref of w.refs ?? []) located.push({ ref, at }); });
  const mentions = (name: string) => (text.match(new RegExp(`(?<![\\w])${name}(?![\\w])`, pwsh ? "gi" : "g")) ?? []).length;
  const readsOf = (name: string) => located.filter((l) => l.ref.name === name);
  // the frames: for-loop bodies by name, function bodies by name
  const loops = new Map<string, { values: string[] | null; from: number; to: number }[]>();
  const funcs = new Map<string, { from: number; to: number }[]>();
  const stack: { name: string | null; from: number; kind: "loop" | "func" | "brace" }[] = [];
  let pendingDef: string | undefined;
  scan.events.forEach((ev, k) => {
    if (ev.k === "def") { pendingDef = scan.events[k + 1]?.k === "open" && scan.events[k + 1]!.at === ev.at ? ev.name : undefined; if (pendingDef === undefined && ev.name) funcs.set(ev.name, [...(funcs.get(ev.name) ?? []), { from: -1, to: -1 }]); return; }
    if (ev.k === "open") { stack.push({ name: pendingDef ?? null, from: ev.at, kind: pendingDef !== undefined ? "func" : "brace" }); pendingDef = undefined; return; }
    if (ev.k === "do") {
      const words = scan.commands[ev.at - 1] ?? [];
      const i = leadOf(words);
      const isFor = words[i]?.text === "for" && !words[i]!.open && words[i + 2]?.text === "in" && !words[i + 2]!.open && /^[A-Za-z_]\w*$/.test(words[i + 1]?.text ?? "") && !words[i + 1]!.open;
      stack.push({ name: isFor ? words[i + 1]!.text : null, from: ev.at, kind: "loop" });
      if (isFor) {
        const list = words.slice(i + 3);
        // readable path (ruling c): a list word may also be a glob that cannot reach a protected place; the value is the
        // glob itself, so every word built from it is checked as that glob
        const safe = (w: PlainWord) => !w.redirect && (!w.open ? SAFE_VALUE.test(w.text) : reach && !w.refs?.length && /[*?[]/.test(w.text) && !globReaches(w.text, false, dotModeOf(text)));
        const values = list.length && list.every(safe) ? list.map((w) => w.text) : null;
        loops.set(words[i + 1]!.text, [...(loops.get(words[i + 1]!.text) ?? []), { values, from: ev.at, to: Number.MAX_SAFE_INTEGER }]);
      }
      return;
    }
    // close and done: pop the frame they end; a mismatch leaves the frame open to the end (reads stay inside it)
    const want = ev.k === "done" ? "loop" : "brace";
    const top = stack[stack.length - 1];
    if (!top || (want === "loop") !== (top.kind === "loop")) return;
    stack.pop();
    if (top.kind === "loop" && top.name) { const all = loops.get(top.name)!; all[all.length - 1]!.to = ev.at; }
    if (top.kind === "func" && top.name) funcs.set(top.name, [...(funcs.get(top.name) ?? []), { from: top.from, to: ev.at }]);
  });
  for (const top of stack) if (top.kind === "func" && top.name) funcs.set(top.name, [...(funcs.get(top.name) ?? []), { from: top.from, to: Number.MAX_SAFE_INTEGER }]);
  // assignments from a literal at the very start of the text, each name once
  const assigned = new Map<string, string | null>();
  const lead = /^\s*([A-Za-z_]\w*)=(?:([\w./+@%,:-]+)|"([\w./+@%,:-]+)"|'([\w./+@%,:-]+)')[ \t]*(?:;|&&|\n)/;
  if (!pwsh) for (let rest = text, m = lead.exec(rest); m; rest = rest.slice(m[0].length), m = lead.exec(rest)) assigned.set(m[1]!, assigned.has(m[1]!) ? null : (m[2] ?? m[3] ?? m[4])!);
  const cache = new Map<string, string[] | null>();
  const valuesOf = (name: string): string[] | null => {
    if (cache.has(name)) return cache.get(name)!;
    let out: string[] | null = null;
    const reads = readsOf(name);
    const bound = posBound.get(name);
    if (pwsh && name !== "HOME") out = null;
    else if (bound) {
      // `local x="$1"` inside one function: x takes the values of $1, when x is named nowhere else outside that function
      const frame = [...funcs].find(([, fr]) => fr.length === 1 && bound.at >= fr[0]!.from && bound.at < fr[0]!.to)?.[1][0];
      // the binding must be the body's first command (so it runs before anything else there, on every call), and every
      // read must come after it
      if (frame && bound.at === frame.from && mentions(name) === reads.length + 1 && reads.every((r) => r.at > bound.at && r.at < frame.to)) out = valuesOf(bound.n);
    } else if (/^[1-9]$/.test(name)) {
      // positional: every read in the body of one function, and every call of it passes a literal there
      const withReads = [...funcs].filter(([, frames]) => reads.some((r) => frames.some((f) => r.at >= f.from && r.at < f.to)));
      const allPositional = located.filter((l) => /^[1-9]$/.test(l.ref.name));
      const one = withReads.length === 1 ? withReads[0]! : undefined;
      if (one && /^[A-Za-z_]\w*$/.test(one[0]) && one[1].length === 1 && one[1][0]!.from >= 0 && !/\b(?:shift|set|getopts)\b/.test(text)
        && allPositional.every((l) => l.at >= one[1][0]!.from && l.at < one[1][0]!.to)) {
        const calls = scan.commands.filter((words) => { const i = leadOf(words); return words[i]?.text === one[0] && !words[i]!.open; });
        if (calls.length && mentions(one[0]) === calls.length + 1) {
          const values: string[] = [];
          for (const words of calls) {
            const args = words.slice(leadOf(words) + 1).filter((w) => !w.redirect && !w.data);
            const arg = args[Number(name) - 1];
            if (!arg || arg.open || !SAFE_VALUE.test(arg.text)) { values.length = 0; break; }
            values.push(arg.text);
          }
          if (values.length) out = [...new Set(values)];
        }
      }
    } else if (name === "HOME" || name === "PWD") {
      const home = homedir();
      const fine = mentions(name) === reads.length && reads.every((r) => r.ref.op === "" && (name === "HOME" || (r.ref.lead && text[r.ref.end] === "/")));
      if (fine && (name === "HOME" ? home !== "" : !/\b(?:cd|pushd|popd)\b/.test(text))) out = [name === "HOME" ? home : "."];
    } else if (!/IFS/.test(text)) {
      const frames = loops.get(name) ?? [];
      const literal = assigned.get(name);
      if (frames.length === 1 && literal === undefined && frames[0]!.values && mentions(name) === reads.length + 1 && reads.every((r) => r.at >= frames[0]!.from && r.at < frames[0]!.to)) out = frames[0]!.values;
      else if (!frames.length && typeof literal === "string" && mentions(name) === reads.length + 1) out = [literal];
    }
    cache.set(name, out);
    return out;
  };
  return (ref) => {
    const values = valuesOf(ref.name);
    if (!values) return null;
    if (ref.op === "" || ref.lit === "") return values;
    // a glob value stands for names the text never shows; cutting part of it off can leave a leading dot
    if (values.some((v) => /[*?[]/.test(v))) return null;
    return values.map((v) => ref.op.startsWith("%") ? (v.endsWith(ref.lit) ? v.slice(0, v.length - ref.lit.length) : v) : (v.startsWith(ref.lit) ? v.slice(ref.lit.length) : v));
  };
}

/** Commands that only print or test their arguments: a runner's name there is data. */
const PRINT_ONLY = new Set(["echo", "[", "[[", "test", "true", "false", ":"]);
/** 1.0.17 (NOLIMITS r3d CI fix): `after[i]` is whether any word after `i` passes `test`, in one pass from the end. The
 * per-word checks read this instead of slicing the rest of the command each time, which was quadratic in the word
 * count (a 20k-character `eval x x x ...` took 26 ms in runnerShapeIn alone). */
function anyAfter<T>(words: readonly T[], test: (word: T) => boolean): boolean[] {
  const after = new Array<boolean>(words.length).fill(false);
  for (let i = words.length - 2; i >= 0; i--) after[i] = after[i + 1]! || test(words[i + 1]!);
  return after;
}

const NAME_BUILTINS = new Set(["declare", "typeset", "local", "export", "readonly"]);
const NAME_READERS = new Set(["read", "mapfile", "readarray", "getopts"]);
const PLAIN_NAME = /^[A-Za-z_]\w*(?:\[[^\]$`]*\])?\+?$/;

/** MurageMain ruling, 1.0.16 r3 (fail closed, on the readable and the unreadable path of an owner No limits turn): the
 * shapes that always ask, whatever the rest of the text. A command runner that takes its command or its file from data
 * (xargs, parallel, find with -exec, -execdir, -ok or -okdir, fd with -x or -X); any process substitution (`<(…)`,
 * `>(…)`); a declare, typeset, local, export, readonly, printf -v, read, mapfile or getopts that writes a name the text
 * builds from a variable. bash only; PowerShell has its own call checks. A scan that throws asks. */
export function runnerShapeIn(text: string, dialect?: "pwsh"): Hiding | null {
  if (dialect === "pwsh") return null;
  const scan: PlainScan = { commands: [], pwshCall: false, quotedCode: false, events: [] };
  scanInto(text, false, scan);
  if (scan.procSub || /[<>]\(|(?:^|[\s;&|(])=\(/.test(text.replace(/'[^']*'/g, ""))) return "process-sub";
  for (const words of scan.commands) {
    const plain = words.filter((w) => !w.redirect && !w.data);
    const lead = plain.findIndex((w) => w.open || !(PLAIN_KEYWORDS.has(w.text) || /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(w.text)));
    if (lead < 0 || PRINT_ONLY.has(baseName(plain[lead]!.text))) continue;
    const rest = plain.slice(lead);
    const names = rest.map((w) => baseName(w.text));
    if (names.some((n) => n === "xargs" || n === "parallel")) return "data-runner";
    if (names.some((n) => n === "find" || n === "gfind") && rest.some((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w.text))) return "data-runner";
    if (names.some((n) => n === "fd" || n === "fdfind") && rest.some((w) => /^(?:-[a-zA-Z]*[xX]|--exec(?:-batch)?(?:=.*)?)$/.test(w.text))) return "data-runner";
    const builtAfter = anyAfter(rest, (w) => !w.text.startsWith("-") && w.open && !PLAIN_NAME.test(w.text.split("=")[0]!));
    const openAfter = anyAfter(rest, (w) => w.open);
    // the first `-v…` word after each place, read from the end
    const nextV = new Array<number>(rest.length).fill(-1);
    for (let k = rest.length - 2; k >= 0; k--) nextV[k] = /^-v/.test(rest[k + 1]!.text) ? k + 1 : nextV[k + 1]!;
    for (let k = 0; k < rest.length; k++) {
      const n = names[k]!;
      if (NAME_BUILTINS.has(n) && builtAfter[k]) return "built-name";
      if (n === "printf") {
        const v = nextV[k]!;
        if (v >= 0 && (rest[v]!.text === "-v" ? rest[v + 1]?.open !== false : rest[v]!.open)) return "built-name";
      }
      if (NAME_READERS.has(n) && openAfter[k]) return "built-name";
    }
  }
  return null;
}

/** The first word in this text that keeps the card under the structural rule, or null when every command word and
 * every argument that could name a file is a plain literal. */
export function unplainIn(text: string, dialect?: "pwsh"): Hiding | null {
  return unplainScan(text, dialect).hit;
}

/** unplainIn, with the texts the resolver built: one per combination of the values of every variable it resolved, each
 * read replaced by its value. The caller runs the delete, disk, key and startup-file checks on every one. Code handed to
 * another shell (`bash -c`, alias, trap) is read with no resolving. */
export function unplainScan(text: string, dialect?: "pwsh", resolve = true): { hit: Hiding | null; resolved: string[] } {
  const hit = unplainCore(text, dialect, resolve);
  return typeof hit === "string" || hit === null ? { hit, resolved: [] } : hit;
}

/** MurageMain ruling (c), 1.0.16 r3, for the readable path of an owner No limits turn: the same scan as unplainScan, but a
 * path argument or redirect target with a glob, a brace or a variable asks only when it could reach a protected place
 * (globReaches); a command word that is not a plain literal, a steering or environment value the text does not give, a
 * data runner, a process substitution and a built name ask as on the unreadable path. Each fully known value is
 * substituted and the resolved texts go to the key, startup-file and deny checks. */
export function reachScan(text: string, dialect?: "pwsh"): { hit: Hiding | null; resolved: string[] } {
  const hit = unplainCore(text, dialect, true, true);
  return typeof hit === "string" || hit === null ? { hit, resolved: [] } : hit;
}

function unplainCore(text: string, dialect: "pwsh" | undefined, resolve: boolean, reach = false): Hiding | null | { hit: Hiding | null; resolved: string[] } {
  const pwsh = dialect === "pwsh";
  const scan: PlainScan = { commands: [], pwshCall: false, quotedCode: false, events: [] };
  scanInto(text, pwsh, scan);
  const valuesOf = resolve ? resolverOf(text, scan, pwsh, reach) : () => null;
  const used: VarRef[] = [];
  const GLOB = /[*?[{]/;
  /** Open, unless every part that opens it is a variable read the resolver can fill (on the readable path, with values
   * that are not globs). */
  const opened = (w: PlainWord): boolean => {
    if (!w.open) return false;
    if (!w.varOnly || !w.refs || !w.refs.every((r) => valuesOf(r) !== null)) return true;
    if (reach && w.refs.some((r) => valuesOf(r)!.some((v) => GLOB.test(v)))) return true;
    used.push(...w.refs);
    return false;
  };
  const dotMode = dotModeOf(text);
  const moves = directoryMoves(text, scan, pwsh, valuesOf);
  // a cd anywhere but into a relative folder with no dot segment moves where a relative glob points
  const cdMoved = reach && moves.some((m) => m.targets === null || m.targets.some((t) => /^[/~\\]|^[A-Za-z]:/.test(t) || t.split(/[\\/]/).some((seg) => seg.startsWith("."))));
  /** Readable path: whether this open word could reach a protected place, in every combination of the values it reads. */
  const reaches = (w: PlainWord): boolean => {
    // opened by something other than a glob, a brace or a variable read: unknown
    if (!w.refs?.length && !GLOB.test(w.text)) return true;
    let variants = [w.text];
    for (const r of [...(w.refs ?? [])].sort((a, b) => a.start - b.start)) {
      const raw = text.slice(r.start, r.end);
      const values = valuesOf(r) ?? [UNKNOWN];
      variants = variants.flatMap((v) => { const at = v.indexOf(raw); return at < 0 ? [v + UNKNOWN] : values.map((x) => v.slice(0, at) + x + v.slice(at + raw.length)); });
      if (variants.length > MAX_RESOLVED) return true;
    }
    return variants.some((v) => globReaches(v, pwsh, dotMode, cdMoved));
  };
  const asks = (w: PlainWord): boolean => opened(w) && (!reach || reaches(w));
  const shape = runnerShapeIn(text, dialect);
  if (shape) return shape;
  if (pwsh && (scan.pwshCall || /\.invoke(?:script|command)?\s*\(|\$executioncontext|\binvokecommand\b|\[scriptblock\]/i.test(text))) return "pwsh-call";
  if (!reach && !pwsh && scan.quotedCode && ARITH_TRIGGER.test(text)) return "unplain-command";
  for (const words of scan.commands) {
    // MurageMain ruling (2), 1.0.16 r3: a glob or brace that could reach a protected place asks wherever it stands: an
    // argument, a for, select or case list, an assignment value, a redirection target
    if (!pwsh && words.some((w) => w.globbed && reaches(w))) return "unplain-path";
    if (words.some((w) => w.redirect && asks(w))) return "unplain-path";
    const plain = words.filter((w) => !w.redirect && !w.data);
    const commandAfter = anyAfter(plain, (n) => !/^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(n.text));
    let i = 0;
    for (;;) {
      const w = plain[i];
      if (w === undefined) break;
      if (!pwsh && PLAIN_KEYWORDS.has(w.text) && !w.open) { i++; continue; }
      if (!pwsh && /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(w.text)) {
        if (w.open && (STEERING.test(w.text) || /^\w+\[/.test(w.text))) return "unplain-path";
        // a value the text does not give, handed to the command after it as its environment, can name what it runs
        // (an editor or ssh command variable)
        if (opened(w) && commandAfter[i]) return "unplain-command";
        i++;
        continue;
      }
      if (pwsh && /^\$[\w:]+$/.test(w.text) && /^[-+*/]?=$/.test(plain[i + 1]?.text ?? "")) { i += 2; continue; }
      break;
    }
    const first = plain[i];
    if (first === undefined) continue;
    // `for name in …` and `case word in`: the list is data, the body is its own command
    if (!pwsh && (first.text === "for" || first.text === "select" || first.text === "case") && !first.open) continue;
    if (first.open) return "unplain-command";
    const cmd = baseName(first.text);
    const args = plain.slice(i + 1);
    if (pwsh ? PWSH_DATA.has(cmd) : DATA_COMMANDS.has(cmd)) {
      if (args.some((a) => a.open && STEERING.test(a.text))) return "unplain-path";
      // the same, exported to every later command
      if ((cmd === "export" || (NAME_BUILTINS.has(cmd) && args.some((a) => /^-\w*x/.test(a.text)))) && args.some((a) => a.text.includes("=") && opened(a))) return "unplain-command";
      continue;
    }
    // a data option's value may be a quoted `$(…)` whose commands pass (they were read as commands above); any other open
    // argument could name a file
    const dataValue = (a: PlainWord, k: number): boolean => {
      if (!a.subOnly) return false;
      const option = /^(--[\w-]+)=/.exec(a.text)?.[1];
      const named = option !== undefined ? DATA_OPTION.test(option) : k > 0 && !args[k - 1]!.open && DATA_OPTION.test(args[k - 1]!.text);
      if (!named || !(a.refs ?? []).every((r) => valuesOf(r) !== null)) return false;
      used.push(...(a.refs ?? []));
      return true;
    };
    if (args.some((a, k) => !dataValue(a, k) && asks(a))) return "unplain-path";
    // code handed over as a plain string is read as commands too (`bash -c '…'`, `alias x='…'`, `trap '…' EXIT`)
    const all = [first, ...args];
    // the first `-c`-like flag after each word, read once from the end
    const nextFlag = new Array<number>(all.length).fill(-1);
    for (let k = all.length - 2; k >= 0; k--) nextFlag[k] = /^-[a-z]*c$|^\/[ck]$|^-c(?:ommand)?$/i.test(all[k + 1]!.text) ? k + 1 : nextFlag[k + 1]!;
    // many shell words before one `-c` read the same payload: it is scanned once per dialect
    const innerSeen = new Map<string, Hiding | null>();
    for (let k = 0; k < all.length; k++) {
      const name = baseName(all[k]!.text);
      if (SHELLS.has(name)) {
        const flag = nextFlag[k]!;
        const code = flag >= 0 ? all[flag + 1] : undefined;
        if (code) {
          const d = POWERSHELLS.has(name) ? "pwsh" : undefined;
          const memo = `${d ?? ""}\u0000${flag}`;
          let inner = innerSeen.get(memo) ?? null;
          if (!innerSeen.has(memo)) {
            inner = reach ? innerReach(code.text, d) : unplainScan(code.text, d, false).hit ?? hidingIn(code.text, d);
            innerSeen.set(memo, inner);
          }
          if (inner) return inner;
        }
      }
    }
    const innerHit = (code: string) => reach ? innerReach(code, undefined) : unplainScan(code, undefined, false).hit ?? hidingIn(code);
    if (cmd === "alias") for (const a of args) { const v = a.text.slice(a.text.indexOf("=") + 1); if (a.text.includes("=") && innerHit(v)) return "unplain-command"; }
    if (cmd === "trap" && args[0] && innerHit(args[0].text)) return "unplain-command";
    // the program xargs, parallel or find runs is the text it is fed (`xargs -I@ @`, `-exec {} \;`)
    if (cmd === "xargs" || cmd === "parallel") {
      let k = 0, replace = "{}";
      while (args[k] && args[k]!.text.startsWith("-")) {
        const a = args[k]!.text;
        const joinedValue = /^(-I|-J|-i|--replace=?)(.+)$/.exec(a);
        if (joinedValue) replace = joinedValue[2]!;
        if (XARGS_VALUE.has(a)) { if (a === "-I" || a === "-J" || a === "--replace") replace = args[k + 1]?.text ?? replace; k++; }
        k++;
      }
      const run = args[k]?.text;
      if (run !== undefined && (run.includes(replace) || run.includes("{}") || run === ":::")) return "unplain-command";
    }
    if (cmd === "find") {
      const exec = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a.text));
      if (exec >= 0 && args[exec + 1]?.text.includes("{}")) return "unplain-command";
    }
  }
  // MurageMain ruling (1), 1.0.16 r3: after a move to a protected place, or to one the text does not give, every later
  // relative path counts as under that place (read here as every relative path in the text, since a loop or a function
  // can run it after the move). An unknown place asks; a known one is written out in front of each such
  // path, and that text joins the resolved texts for the key, startup-file, deny and delete checks.
  const placed: string[] = [];
  for (const m of moves) {
    if (m.targets !== null && !m.targets.some((t) => protectedPlace(t, pwsh))) continue;
    // every command but the move's own: a function body or a loop can run after it even when written before it
    const later = m.same ? [scan.commands[m.at]!] : scan.commands.filter((_c, i) => i !== m.at);
    const forms = later.map((words) => relativeSpots(words, pwsh, valuesOf, text));
    if (!forms.some((f) => f.relative)) continue;
    if (m.targets === null) return "unplain-path";
    for (const t of m.targets) {
      placed.push(forms.map((f) => f.words.map((w) => (w.relative ? (/[\\/]$/.test(t) ? t : t + (pwsh ? "\\" : "/")) + w.text : w.text)).map((s, k) => (f.words[k]!.redirect ? ">> " + s : s)).join(" ")).join("\n"));
      if (placed.length > MAX_RESOLVED) return "unplain-path";
    }
  }
  if (!used.length) return placed.length ? { hit: null, resolved: placed } : null;
  // resolve, then check: every read of a resolved name is replaced, in every combination of their values
  const names = [...new Set(used.map((r) => r.name))];
  const all = scan.commands.flat().flatMap((w) => w.refs ?? []).filter((r) => names.includes(r.name)).sort((a, b) => b.start - a.start);
  let combos: Map<string, number>[] = [new Map()];
  for (const name of names) {
    const count = Math.max(...all.filter((r) => r.name === name).map((r) => valuesOf(r)?.length ?? 0));
    combos = combos.flatMap((c) => Array.from({ length: count }, (_v, k) => new Map(c).set(name, k)));
    if (combos.length > MAX_RESOLVED) return "unplain-path";
  }
  const resolved = combos.map((c) => all.reduce((out, r) => out.slice(0, r.start) + valuesOf(r)![c.get(r.name)!]! + out.slice(r.end), text));
  return { hit: null, resolved: [...resolved, ...placed] };
}

const PRECOMMANDS = new Set([...WRAP, "noglob", "nocorrect", "setsid", "chroot", "unshare", "nsenter", "flock", "ionice", "chrt", "taskset", "firejail"]);
const CHDIR_OPTION = /^(?:-[CD]|--chdir|--working-directory|--wd)(?:=|$)|^-[CD]./;

/** MurageMain re-scope, 1.0.16 r3 (A/B): the narrow gate an unreadable text passes before it runs without a card on an
 * owner No limits turn. It runs only when no command word, after any keyword, assignment or wrapper, holds `$` or a
 * backtick; no wrapper's option holds a variable or moves the folder; no nested shell or interpreter string, eval, or
 * source of a variable; no directory change, except one plain leading `cd` into a known folder that is not protected;
 * and every assignment value and every resolved value is literal, with no glob that could reach a protected place.
 * Anything else keeps the card, as the base did before the waiver. When in doubt, it asks. */
export function narrowHold(text: string, dialect?: "pwsh"): Hiding | null {
  const pwsh = dialect === "pwsh";
  const scan: PlainScan = { commands: [], pwshCall: false, quotedCode: false, events: [] };
  scanInto(text, pwsh, scan);
  if (scan.pwshCall || scan.procSub) return "unplain-command";
  const valuesOf = resolverOf(text, scan, pwsh);
  const dotMode = dotModeOf(text);
  const known = (w: PlainWord): boolean => !w.open || (w.varOnly === true && (w.refs?.length ?? 0) > 0 && w.refs!.every((r) => valuesOf(r) !== null));
  // every resolved value, and every assignment value, read without its `X=` prefix
  for (const w of scan.commands.flat()) {
    for (const r of w.refs ?? []) for (const v of valuesOf(r) ?? []) if (/[*?[{]/.test(v) && globReaches(v, pwsh, dotMode, true)) return "unplain-path";
    if (!pwsh && ASSIGNMENT.test(w.text)) {
      const value = w.text.replace(ASSIGNMENT, "");
      if (!known(w)) return "unplain-path";
      if (/[*?[{]/.test(value) && globReaches(value, pwsh, dotMode, true)) return "unplain-path";
    }
  }
  const moves = directoryMoves(text, scan, pwsh, valuesOf);
  let leadCd = -1;
  for (let at = 0; at < scan.commands.length; at++) {
    const words = scan.commands[at]!;
    const plain = words.filter((w) => !w.redirect && !w.data);
    let k = 0;
    while (plain[k] && ((!plain[k]!.open && PLAIN_KEYWORDS.has(plain[k]!.text)) || (!pwsh && ASSIGNMENT.test(plain[k]!.text)))) k++;
    const lead = k;
    // wrappers and precommand words: none may be open, hold an open option or option value, or move the folder
    while (plain[k] && (plain[k]!.open || PRECOMMANDS.has(baseName(plain[k]!.text)))) {
      if (plain[k]!.open) return "unplain-command";
      k++;
      while (plain[k] && (plain[k]!.text.startsWith("-") || (!pwsh && ASSIGNMENT.test(plain[k]!.text)) || (!plain[k]!.open && /^\d+(?:\.\d+)?[smhd]?$/.test(plain[k]!.text)))) {
        const o = plain[k]!;
        if (o.open || CHDIR_OPTION.test(o.text)) return o.open ? "unplain-command" : "unplain-path";
        if (WRAP_VALUE.has(o.text) || o.text === "--chdir") { if (plain[k + 1]?.open) return "unplain-command"; k++; }
        k++;
      }
    }
    const first = plain[k];
    if (first && first.open) return "unplain-command";
    const shellFlagAfter = anyAfter(plain, (a) => /^-[a-z]*c$|^\/[ck]$|^-c(?:ommand)?$|^-[a-z]*s$/i.test(a.text));
    const inlineAfter = anyAfter(plain, (a) => INLINE_FLAG.test(a.text));
    const openAfter = anyAfter(plain, (a) => a.open);
    for (let i = 0; i < plain.length; i++) {
      const w = plain[i]!;
      if (w.open) continue;
      const name = baseName(w.text);
      // a nested shell or interpreter string, eval, or a source of a variable
      if (EVAL_WORDS.has(name)) return "unplain-command";
      if (SHELLS.has(name) && shellFlagAfter[i]) return "unplain-command";
      if (INTERPRETERS.test(name) && inlineAfter[i]) return "unplain-command";
      if (SOURCE.has(w.text) && i >= lead && openAfter[i]) return "unplain-command";
      if (/^-(?:exec|execdir|ok|okdir)$/.test(w.text) && plain[i + 1]?.open) return "unplain-command";
      // a directory change anywhere, except one plain `cd` leading the first command
      if (MOVERS.has(name)) {
        const args = plain.slice(i + 1);
        const plainLead = at === 0 && i === 0 && w.text === "cd" && !pwsh && args.length === 1 && !args[0]!.text.startsWith("-") && known(args[0]!);
        if (!plainLead || leadCd >= 0) return "unplain-path";
        leadCd = at;
      }
    }
  }
  // AUTO_CD lone paths, wrapper folder options and any move the walk above did not allow
  for (const m of moves) {
    if (m.at !== leadCd || m.same || m.targets === null || m.targets.some((t) => protectedPlace(t, pwsh) || /[*?[{]/.test(t))) return "unplain-path";
  }
  if (leadCd >= 0 && moves.length !== 1) return "unplain-path";
  return null;
}
