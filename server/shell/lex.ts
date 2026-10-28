// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shell lexer behind the always-ask reader (server/always-ask.ts). It
// turns command text into tokens the way a POSIX shell reads it: words made
// of parts that each know their quoting, operators, newlines, and heredoc
// bodies attached to the operator that opened them. There is one reader and
// it is total: it either returns tokens or throws `Unreadable`, and the
// reader's caller asks the owner whenever that happens. No regex ever runs
// over the raw text; this is a single pass with a small state stack.

export type UnreadableReason =
  | "length" | "quote" | "heredoc" | "substitution" | "expansion" | "operator" | "syntax" | "escape"
  | "wrapper-option" | "dynamic-name" | "dynamic-eval" | "branch" | "pwsh" | "depth" | "nesting"
  | "folder" | "indirect" | "opaque" | "dialect" | "cmd" | "shadow" | "device";

/** Thrown when the text cannot be read with certainty. The reader asks. */
export class Unreadable extends Error {
  readonly reason: UnreadableReason;
  constructor(reason: UnreadableReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "Unreadable";
    this.reason = reason;
  }
}

/** More text than this asks: nothing an owner types is that long. */
export const MAX_TEXT_CHARS = 256 * 1024;

export type Quote = "none" | "single" | "double";

export type Part =
  /** plain characters, with the quoting they were written in */
  | { kind: "lit"; text: string; quote: Quote }
  /** `$NAME`, `${NAME}` and the `${NAME<op>word}` family; `word` is the
   * operand, lexed as a nested word. */
  | { kind: "var"; name: string; quote: Quote; op?: string; word?: Word }
  /** `$(…)` or `` `…` ``: the raw inner text. `block`: PowerShell's `{…}`
   * script block, as opposed to its `(…)` expression. */
  | { kind: "subst"; text: string; quote: Quote; block?: true }
  /** `$((…))`: kept so the word is not literal; the text is not executed */
  | { kind: "arith"; text: string; quote: Quote }
  /** `<(…)` or `>(…)`: the inner text runs as a script */
  | { kind: "procsub"; text: string; dir: "<" | ">" }
  /** an unquoted `~` or `~name` at the start of a word; never quoted */
  | { kind: "tilde"; user: string }
  /** an unquoted `*` or `?` */
  | { kind: "glob"; text: string }
  /** an unquoted `{a,b}` or `{1..3}`: every alternative, each lexed as an
   * unquoted word of its own (so `{~,./x}` holds a `tilde`) */
  | { kind: "brace"; alts: Word[] };

export interface Word {
  parts: Part[];
}

export interface Heredoc {
  delimiter: string;
  /** a quoted delimiter (`<<'EOF'`) keeps the body literal */
  quoted: boolean;
  /** `<<-` strips leading tabs */
  strip: boolean;
  body: string;
}

export type Token =
  | { kind: "word"; word: Word }
  /** `((` carries the arithmetic text up to its `))`; nothing in there runs
   * but the substitutions, which the parser lexes out of it */
  | { kind: "op"; op: string; fd?: number; heredoc?: Heredoc; arith?: string }
  | { kind: "newline" }
  | { kind: "eof" };

/** The operators, longest first so `;;&` wins over `;;` over `;`. */
const OPERATORS = [
  ";;&", ";;", ";&", ";", "&&", "&>>", "&>", "&", "||", "|&", "|",
  "((", "(", "))", ")", "<<<", "<<-", "<<", "<&", "<>", "<", ">>", ">&", ">|", ">",
];
/** `\r` is an ordinary character, as it is to the shell: never a blank, never
 * stripped from a word, a delimiter or a heredoc line. */
const BLANK = " \t";
const WORD_END = " \t\n;&|()<>";
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_VAR = "@*#?-$!0123456789";
const TILDE_USER = /[A-Za-z0-9._-]/;
/** The `${name<op>…}` operators the reader understands. Anything else asks. */
const VAR_OPS = [":-", ":=", ":+", ":?", "##", "#", "%%", "%", "//", "/#", "/%", "/", "^^", "^", ",,", ",", "-", "=", "+", "?", ":"];
/** A subscript is a name, a number, `@`, `*` or plain arithmetic over
 * those: nothing with a `(` or a backtick, which could run something. */
const SUBSCRIPT = /^[A-Za-z0-9_$@*+\-\s{}]+$/;
const MAX_BRACE_ALTS = 512;
/** Reserved words after which a command name stands. */
const KEEPS_COMMAND_POSITION = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "time", "{"]);
const REDIRECT_OPS = new Set(["<<<", "<<-", "<<", "<&", "<>", "<", ">>", ">&", ">|", ">", "&>", "&>>"]);
/** Substitutions nested deeper than this ask. */
const MAX_LEX_DEPTH = 64;

/** What a lexer reads: the whole text, the body of a `$( )` up to its
 * closing `)`, or an old-form backtick substitution up to its closer. */
type LexMode = "top" | "nested" | "backtick";

class Lexer {
  private readonly s: string;
  private i: number;
  private readonly tokens: Token[] = [];
  /** heredocs opened on the current line; each nested lexer has its own */
  private readonly pending: Heredoc[] = [];
  private readonly depth: number;
  /** a nested lexer (the body of `$( )` or `<( )`) stops at the `)` that
   * closes it: one at paren depth 0 that is not a case pattern's */
  private readonly nestedBody: boolean;
  /** "backtick": `run()` reads to the backtick that closes the substitution
   * opened just before `start` and reports its index in `closer` */
  private readonly mode: LexMode;
  /** in backtick mode, the index of the closing backtick once `run()` returned */
  closer = -1;
  private parens = 0;
  private cases = 0;
  /** the next word stands where a command name stands: only there are
   * `case` and `esac` reserved words (`$(echo case)` opens nothing) */
  private commandPosition = true;
  /** the next word is a redirect's target, which moves no position */
  private redirectTarget = false;
  /** inside `case WORD in`: 1 the subject is next, 2 `in` is next, 3 a
   * pattern or `esac` is next */
  private casePhase = 0;

  constructor(text: string, start = 0, depth = 0, mode: LexMode = "top") {
    this.s = text;
    this.i = start;
    this.depth = depth;
    this.mode = mode;
    this.nestedBody = mode === "nested";
    if (depth > MAX_LEX_DEPTH) throw new Unreadable("depth");
  }

  run(): Token[] {
    if (this.mode === "backtick") {
      this.closer = this.backtickCloser();
      return [];
    }
    this.scan();
    if (this.pending.length) throw new Unreadable("heredoc", "no terminator");
    this.tokens.push({ kind: "eof" });
    return this.tokens;
  }

  /** The body of a `$( )`, `<( )` or `>( )` opened just before `from`: the
   * same lexer re-entered one level deeper, with its own heredoc queue,
   * comments, quoting and continuations, up to its closing `)`. Returns the
   * index just past that `)`. */
  private nested(from: number): number {
    const inner = new Lexer(this.s, from, this.depth + 1, "nested");
    if (!inner.scan()) throw new Unreadable("substitution", "$(");
    if (inner.pending.length) throw new Unreadable("heredoc", "no terminator inside a substitution");
    return inner.i + 1;
  }

  /** Read tokens to the end of the text, or (nested) to the closing `)`;
   * true when it stopped at that `)`. */
  private scan(): boolean {
    const s = this.s;
    for (;;) {
      this.skipBlanks();
      if (this.i >= s.length) return false;
      const c = s[this.i]!;
      if (this.nestedBody && c === ")") {
        if (this.parens > 0) { this.parens--; this.tokens.push({ kind: "op", op: ")" }); this.i++; this.commandPosition = true; continue; }
        if (this.cases > 0) { this.tokens.push({ kind: "op", op: ")" }); this.i++; this.commandPosition = true; this.casePhase = 0; continue; }
        return true;
      }
      if (c === "\n") {
        this.i++;
        this.tokens.push({ kind: "newline" });
        this.drainHeredocs();
        if (this.casePhase !== 3) this.commandPosition = true;
        continue;
      }
      // `2>file`, `3<>f`: a run of digits glued to a redirect operator
      let j = this.i;
      while (j < s.length && s[j]! >= "0" && s[j]! <= "9") j++;
      if (j > this.i && j < s.length && (s[j] === "<" || s[j] === ">") && s[j + 1] !== "(") {
        const fd = Number(s.slice(this.i, j));
        this.i = j;
        this.operator(fd);
        continue;
      }
      // `{` and `}` are reserved words only when they stand alone
      if ((c === "{" || c === "}") && (this.i + 1 >= s.length || WORD_END.includes(s[this.i + 1]!))) {
        this.i++;
        this.tokens.push({ kind: "op", op: c });
        this.commandPosition = true;
        continue;
      }
      if ((c === "<" || c === ">") && s[this.i + 1] === "(") {
        this.pushWord(this.word());
        continue;
      }
      if ("(;&|)<>".includes(c)) {
        this.operator();
        continue;
      }
      this.pushWord(this.word());
    }
  }

  /** A word, with where it stands tracked: `case … esac` inside a
   * substitution makes its pattern `)` close nothing, and only a `case`
   * where a command name stands opens one. */
  private pushWord(word: Word): void {
    const option = optionExpansion(word);
    if (option) throw new Unreadable("expansion", option);
    this.tokens.push({ kind: "word", word });
    if (this.redirectTarget) { this.redirectTarget = false; return; }
    const bare = word.parts.length === 1 && word.parts[0]!.kind === "lit" && word.parts[0]!.quote === "none" ? word.parts[0]!.text : undefined;
    if (this.casePhase === 1) { this.casePhase = 2; return; }
    if (this.casePhase === 2) { this.casePhase = bare === "in" ? 3 : 0; return; }
    if (this.casePhase === 3) {
      this.casePhase = 0;
      if (bare === "esac" && this.cases > 0) { this.cases--; this.commandPosition = false; }
      return;
    }
    if (this.commandPosition && bare === "case") { this.cases++; this.casePhase = 1; this.commandPosition = false; return; }
    if (this.commandPosition && bare === "esac" && this.cases > 0) { this.cases--; this.commandPosition = false; return; }
    // after these a command name stands next; an assignment keeps the place
    this.commandPosition = this.commandPosition && bare !== undefined && (KEEPS_COMMAND_POSITION.has(bare) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(bare));
  }

  /** Blanks, backslash-newline continuations and comments between tokens. */
  private skipBlanks(): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === undefined) return;
      if (BLANK.includes(c)) { this.i++; continue; }
      if (c === "\\" && s[this.i + 1] === "\n") { this.i += 2; continue; }
      if (c === "#") {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
        continue;
      }
      return;
    }
  }

  private operator(fd?: number): void {
    const s = this.s;
    const op = OPERATORS.find((candidate) => s.startsWith(candidate, this.i));
    if (!op) throw new Unreadable("operator", s[this.i]);
    this.i += op.length;
    if (op === "((") {
      // `(( … ))` is read to its closer here, so `<` and `<<` inside it are
      // arithmetic and not redirects; `( (a) )` is two subshells
      let end: number | undefined;
      try {
        end = this.matchArith(this.i);
      } catch (error) {
        if (error instanceof Unreadable && error.reason === "substitution") throw new Unreadable("syntax", "(( without ))");
        throw error;
      }
      if (end === undefined) {
        this.tokens.push({ kind: "op", op: "(" }, { kind: "op", op: "(" });
        return;
      }
      this.tokens.push({ kind: "op", op, arith: s.slice(this.i, end) });
      this.i = end + 2;
      return;
    }
    if (op === "(") this.parens++;
    else if (op === ")" && this.parens > 0) this.parens--;
    if (REDIRECT_OPS.has(op)) this.redirectTarget = op !== "<<" && op !== "<<-";
    else {
      this.commandPosition = true;
      this.redirectTarget = false;
      // a pattern may open with `(`: `case x in (a) …`
      if (!(this.casePhase === 3 && op === "(")) this.casePhase = 0;
    }
    const token: Extract<Token, { kind: "op" }> = fd === undefined ? { kind: "op", op } : { kind: "op", op, fd };
    if (op === "<<" || op === "<<-") {
      // the delimiter is read now; the body comes after the next newline
      while (this.i < s.length && BLANK.includes(s[this.i]!)) this.i++;
      if (this.i >= s.length || WORD_END.includes(s[this.i]!)) throw new Unreadable("heredoc", "no delimiter");
      const raw = this.i;
      const delimiterWord = this.word();
      const rawText = s.slice(raw, this.i);
      // a delimiter continued over a line: shells disagree on what it is
      if (rawText.includes("\\\n")) throw new Unreadable("heredoc", "continued delimiter");
      const heredoc: Heredoc = {
        delimiter: delimiterWord.parts.map((part) => part.kind === "lit" ? part.text : part.kind === "tilde" ? `~${part.user}` : "").join(""),
        quoted: /['"\\]/.test(rawText),
        strip: op === "<<-",
        body: "",
      };
      token.heredoc = heredoc;
      this.pending.push(heredoc);
    }
    this.tokens.push(token);
  }

  /** At the newline that ends the line a heredoc was opened on: read every
   * pending body, in order, each up to its own delimiter line. For an
   * unquoted delimiter the body is read as the shell reads it, in logical
   * lines: a line ending in an odd run of backslashes is joined to the next
   * (the `\⏎` dropped) before it is compared, and the joined text is what the
   * body holds. A quoted delimiter keeps physical lines. `\r` is a character. */
  private drainHeredocs(): void {
    const s = this.s;
    while (this.pending.length) {
      const heredoc = this.pending.shift()!;
      let found = false;
      const lines: string[] = [];
      while (this.i <= s.length) {
        let line = "";
        let compare = "";
        let last = false;
        for (;;) {
          let nl = s.indexOf("\n", this.i);
          last = nl < 0;
          if (last) nl = s.length;
          const physical = s.slice(this.i, nl);
          this.i = nl + 1;
          const stripped = heredoc.strip ? physical.replace(/^\t+/, "") : physical;
          const run = /\\+$/.exec(physical)?.[0].length ?? 0;
          if (!heredoc.quoted && run % 2 === 1 && !last) {
            line += physical.slice(0, -1);
            compare += stripped.slice(0, -1);
            continue;
          }
          line += physical;
          compare += stripped;
          break;
        }
        if (compare === heredoc.delimiter) { found = true; break; }
        lines.push(line);
        if (last) break;
      }
      if (!found) throw new Unreadable("heredoc", `no terminator ${heredoc.delimiter}`);
      heredoc.body = lines.map((line) => `${line}\n`).join("");
      if (this.i > s.length) this.i = s.length;
    }
  }

  /** The whole text as the inside of a double-quoted word. */
  body(): Part[] {
    const parts: Part[] = [];
    const lit = (text: string, quote: Quote) => {
      const last = parts[parts.length - 1];
      if (last && last.kind === "lit" && last.quote === quote) last.text += text;
      else parts.push({ kind: "lit", text, quote });
    };
    this.doubleQuoted(parts, lit, false);
    return parts;
  }

  private word(): Word {
    const s = this.s;
    const parts: Part[] = [];
    const lit = (text: string, quote: Quote) => {
      const last = parts[parts.length - 1];
      if (last && last.kind === "lit" && last.quote === quote) last.text += text;
      else parts.push({ kind: "lit", text, quote });
    };
    const atStart = () => parts.length === 0;
    const afterAssignment = () => {
      const last = parts[parts.length - 1];
      return parts.length === 1 && last?.kind === "lit" && last.quote === "none" && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(last.text);
    };
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (WORD_END.includes(c)) {
        if ((c === "<" || c === ">") && s[this.i + 1] === "(") {
          const dir = c;
          const after = this.nested(this.i + 2);
          parts.push({ kind: "procsub", text: s.slice(this.i + 2, after - 1), dir });
          this.i = after;
          continue;
        }
        break;
      }
      if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) throw new Unreadable("quote", "'");
        lit(s.slice(this.i + 1, end), "single");
        this.i = end + 1;
        continue;
      }
      if (c === '"') {
        this.i++;
        const before = parts.length;
        this.doubleQuoted(parts, lit);
        // `""` is an empty word, not no word
        if (parts.length === before) lit("", "double");
        continue;
      }
      if (c === "\\") {
        const next = s[this.i + 1];
        if (next === undefined) { lit("\\", "none"); this.i++; continue; }
        if (next === "\n") { this.i += 2; continue; }
        lit(next, "none");
        this.i += 2;
        continue;
      }
      if (c === "$") {
        this.dollar(parts, lit, "none");
        continue;
      }
      if (c === "`") {
        parts.push({ kind: "subst", text: this.backtick(), quote: "none" });
        continue;
      }
      if (c === "~" && (atStart() || afterAssignment())) {
        let j = this.i + 1;
        while (j < s.length && TILDE_USER.test(s[j]!)) j++;
        parts.push({ kind: "tilde", user: s.slice(this.i + 1, j) });
        this.i = j;
        continue;
      }
      if (c === "*" || c === "?") {
        parts.push({ kind: "glob", text: c });
        this.i++;
        continue;
      }
      if (c === "{") {
        const brace = this.brace();
        if (brace) { parts.push(brace); continue; }
      }
      lit(c, "none");
      this.i++;
    }
    return { parts };
  }

  /** Inside `"…"`: only `\" \\ \$ \`` and backslash-newline escape; `$` and
   * backticks still expand. The opening quote is already consumed. With
   * `terminated` false (an unquoted heredoc body) a `"` is a character and
   * the text ends at its end. */
  private doubleQuoted(parts: Part[], lit: (text: string, quote: Quote) => void, terminated = true): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === undefined) { if (terminated) throw new Unreadable("quote", '"'); return; }
      if (c === '"' && terminated) { this.i++; return; }
      if (c === "\\") {
        const next = s[this.i + 1];
        if (next === "\n") { this.i += 2; continue; }
        if (next !== undefined && '"\\$`'.includes(next)) { lit(next, "double"); this.i += 2; continue; }
        lit("\\", "double");
        this.i++;
        continue;
      }
      if (c === "$") { this.dollar(parts, lit, "double"); continue; }
      if (c === "`") { parts.push({ kind: "subst", text: this.backtick(), quote: "double" }); continue; }
      lit(c, "double");
      this.i++;
    }
  }

  /** At a `$`: a variable, a substitution, arithmetic, `$'…'`, `$"…"`, or a
   * plain dollar sign. */
  private dollar(parts: Part[], lit: (text: string, quote: Quote) => void, quote: Quote): void {
    const s = this.s;
    const next = s[this.i + 1];
    if (next === "'" && quote === "none") {
      const end = this.ansiEnd(this.i + 2);
      lit(ansiUnescape(s.slice(this.i + 2, end)), "single");
      this.i = end + 1;
      return;
    }
    if (next === '"' && quote === "none") {
      this.i += 2;
      this.doubleQuoted(parts, lit);
      return;
    }
    if (next === "(") {
      if (s[this.i + 2] === "(") {
        const end = this.matchArith(this.i + 3);
        if (end !== undefined) {
          parts.push({ kind: "arith", text: s.slice(this.i + 3, end), quote });
          this.i = end + 2;
          return;
        }
      }
      const after = this.nested(this.i + 2);
      parts.push({ kind: "subst", text: s.slice(this.i + 2, after - 1), quote });
      this.i = after;
      return;
    }
    if (next === "{") {
      parts.push(this.bracedVar(quote));
      return;
    }
    if (next !== undefined && NAME_START.test(next)) {
      let j = this.i + 1;
      while (j < s.length && NAME_CHAR.test(s[j]!)) j++;
      parts.push({ kind: "var", name: s.slice(this.i + 1, j), quote });
      this.i = j;
      return;
    }
    if (next !== undefined && SPECIAL_VAR.includes(next)) {
      parts.push({ kind: "var", name: next, quote });
      this.i += 2;
      return;
    }
    lit("$", quote);
    this.i++;
  }

  /** `${…}`: the name, an optional operator and its operand. */
  private bracedVar(quote: Quote): Part {
    const s = this.s;
    const open = this.i + 2;
    const close = this.matchBrace(open);
    const inner = s.slice(open, close);
    this.i = close + 1;
    if (inner.startsWith("!")) throw new Unreadable("expansion", "${!…}");
    let rest = inner;
    let length = false;
    if (rest.startsWith("#") && rest.length > 1) { length = true; rest = rest.slice(1); }
    let name = "";
    if (NAME_START.test(rest[0] ?? "")) {
      let j = 0;
      while (j < rest.length && NAME_CHAR.test(rest[j]!)) j++;
      name = rest.slice(0, j);
      rest = rest.slice(j);
    } else if (/^\d/.test(rest)) {
      // `${10}`: a positional parameter above 9
      const digits = /^\d+/.exec(rest)![0];
      name = digits;
      rest = rest.slice(digits.length);
    } else if (rest.length > 0 && SPECIAL_VAR.includes(rest[0]!)) {
      name = rest[0]!;
      rest = rest.slice(1);
    } else {
      throw new Unreadable("expansion", `\${${inner}}`);
    }
    if (rest.startsWith("[")) {
      // a subscript that could run something (`a[$(x)]`) asks
      const end = rest.indexOf("]");
      if (end < 0 || !SUBSCRIPT.test(rest.slice(1, end))) throw new Unreadable("expansion", `\${${inner}}`);
      rest = rest.slice(end + 1);
    }
    if (length) {
      if (rest !== "") throw new Unreadable("expansion", `\${${inner}}`);
      return { kind: "var", name, quote, op: "#" };
    }
    if (rest === "") return { kind: "var", name, quote };
    const op = VAR_OPS.find((candidate) => rest.startsWith(candidate));
    if (!op) throw new Unreadable("expansion", `\${${inner}}`);
    const operand = rest.slice(op.length);
    // every operand is lexed as a word, whatever the operator, so a
    // substitution inside `${X#…}` or `${X/…/…}` is walked like any other
    if (operand === "") return { kind: "var", name, quote, op };
    return { kind: "var", name, quote, op, word: lexWordText(operand, quote) };
  }

  /** The index of the `))` closing `$((`, or undefined when the text is not
   * arithmetic after all (then it is read as `$( (…) )`). */
  private matchArith(from: number): number | undefined {
    const s = this.s;
    let depth = 0;
    let i = from;
    while (i < s.length) {
      const c = s[i]!;
      if (c === "\\") { i += 2; continue; }
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) throw new Unreadable("quote", "'");
        i = end + 1;
        continue;
      }
      if (c === '"') { i = this.skipQuoted(i + 1); continue; }
      if (c === "`") { i = this.backtickAt(i).after; continue; }
      if (c === "$" && s[i + 1] === "(") { i = this.nested(i + 2); continue; }
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) return s[i + 1] === ")" ? i : undefined;
        depth--;
      }
      i++;
    }
    throw new Unreadable("substitution", "$((");
  }

  /** The index of the `}` closing `${` at `from`. */
  private matchBrace(from: number): number {
    const s = this.s;
    let depth = 1;
    let i = from;
    while (i < s.length) {
      const c = s[i]!;
      if (c === "\\") { i += 2; continue; }
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) throw new Unreadable("quote", "'");
        i = end + 1;
        continue;
      }
      if (c === '"') { i = this.skipQuoted(i + 1); continue; }
      if (c === "`") { i = this.backtickAt(i).after; continue; }
      if (c === "$" && s[i + 1] === "(") { i = this.nested(i + 2); continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
    throw new Unreadable("expansion", "${");
  }

  /** Past a double-quoted string opened before `from`, read by the one
   * double-quote routine (so a `$( )` inside it re-enters the lexer). */
  private skipQuoted(from: number): number {
    const inner = new Lexer(this.s, from, this.depth + 1);
    inner.doubleQuoted([], () => {});
    return inner.i;
  }

  /** The text of a backtick substitution, with its own escapes undone. */
  private backtick(): string {
    const { text, after } = this.backtickAt(this.i);
    this.i = after;
    return text;
  }

  /** A backtick substitution opened at `at`: where it closes (the first
   * backtick no backslash escapes, as bash reads the old form), its text
   * with `\``, `\\` and `\$` undone, and that text read now by the same
   * lexer re-entered one level deeper, with its own quoting, heredoc queue
   * and substitutions. Whatever that inner text leaves open asks here, at
   * every site a backtick is read (a word, double quotes, `$(( ))`, `${ }`). */
  private backtickAt(at: number): { text: string; after: number } {
    const closing = new Lexer(this.s, at + 1, this.depth + 1, "backtick");
    closing.run();
    const end = closing.closer;
    const text = this.s.slice(at + 1, end).replace(/\\([`\\$])/g, "$1");
    new Lexer(text, 0, this.depth + 1).run();
    return { text, after: end + 1 };
  }

  /** Backtick mode: the first backtick not preceded by a backslash, as bash
   * reads the old form. The rule keeps no quote state (a backtick inside
   * double quotes in the body closes it there, as in bash), so it needs no
   * quoting of its own: this is the whole of the mode. */
  private backtickCloser(): number {
    const s = this.s;
    while (this.i < s.length) {
      if (s[this.i] === "\\") { this.i += 2; continue; }
      if (s[this.i] === "`") return this.i;
      this.i++;
    }
    throw new Unreadable("substitution", "`");
  }

  private ansiEnd(from: number): number {
    const s = this.s;
    let i = from;
    while (i < s.length) {
      if (s[i] === "\\") { i += 2; continue; }
      if (s[i] === "'") return i;
      i++;
    }
    throw new Unreadable("quote", "$'");
  }

  /** `{a,b}` or `{1..3}` at the current `{`, or undefined when the brace is
   * a plain character (`{}` for xargs, `${` handled elsewhere). */
  private brace(): Part | undefined {
    const s = this.s;
    const close = s.indexOf("}", this.i + 1);
    if (close < 0) return undefined;
    const inner = s.slice(this.i + 1, close);
    // 1.0.7 (Grok r2): the first `}` may sit inside a quote, an escape or a substitution (`{--output="}",x}`,
    // `{a,$(echo })}`), where bash reads on to a later one: a brace with any of those in its first span asks. A `{`
    // followed by a blank is a command group (`{ echo "a"; }`), never a brace.
    if (inner !== "" && !/^\s/.test(inner) && /['"`\\]|[$<>]\(/.test(inner)) throw new Unreadable("expansion", `{${inner}}`);
    if (inner === "" || /\s/.test(inner)) return undefined;
    if (/['"`$\\{()<>|&;]/.test(inner)) {
      // Not modeled, but bash still expands it when nothing ends the word first: `{-exec,sh,-c,x,\;}` is five
      // words, `{a,'b'}` and `{$X,y}` are two, `{a,{b,c}}` is three. Only an unescaped, unquoted `;|&<>()` ends the
      // word inside (`{a;b}` is no brace), and only outside a quote, `$(`, `<(`, `>(` or backtick; anything else with a `,`
      // or `..` asks: a quote, a `$`, a backtick, a `\`, a nested `{`, a `(` or a redirection sign.
      const endsWord = !/['"`]|[$<>]\(/.test(inner) && /(^|[^\\])[;|&]/.test(inner);
      if (!endsWord && (inner.includes(",") || inner.includes(".."))) throw new Unreadable("expansion", `{${inner}}`);
      return undefined;
    }
    let alts: string[] | undefined;
    const range = /^(-?\d+)\.\.(-?\d+)$/.exec(inner);
    if (range) {
      const [lo, hi] = [Number(range[1]), Number(range[2])];
      if (Math.abs(hi - lo) + 1 > MAX_BRACE_ALTS) throw new Unreadable("expansion", `{${inner}}`);
      alts = [];
      for (let n = lo; lo <= hi ? n <= hi : n >= hi; n += lo <= hi ? 1 : -1) alts.push(String(n));
    } else if (/^[A-Za-z]\.\.[A-Za-z]$/.test(inner)) {
      // `{a..c}` is `a b c` to bash (a range between letters, ASCII order)
      const [lo, hi] = [inner.charCodeAt(0), inner.charCodeAt(3)];
      alts = [];
      for (let n = lo; lo <= hi ? n <= hi : n >= hi; n += lo <= hi ? 1 : -1) alts.push(String.fromCharCode(n));
    } else if (/^(?:-?\d+|[A-Za-z])\.\.(?:-?\d+|[A-Za-z])\.\.-?\d+$/.test(inner)) {
      throw new Unreadable("expansion", `{${inner}}`);
    } else if (inner.includes(",")) {
      alts = inner.split(",");
    } else {
      return undefined;
    }
    this.i = close + 1;
    // each alternative is an unquoted word of its own: `{~,./x}` holds a `~`
    return { kind: "brace", alts: alts.map((alt) => (alt === "" ? { parts: [] } : new Lexer(alt, 0, this.depth + 1).word())) };
  }
}

/**
 * A word in option position that bash expands after this reader has read it: the rules read an option by its
 * spelling, and an expansion there decides which options the program gets. Asks (Fuigo 1.0.32 sends every shell
 * command here, and Auto answers what the readers pass):
 *   - a brace that puts an option on the command line: `--{output=../x,stat}`, `-r{f,}`, `{-exec,sh,-c,x,+}`;
 *   - a glob, substitution, arithmetic or process substitution in a word that starts with `-`: `-*`, `-[r]f`,
 *     `--output=$(…)`, `-$((1))`.
 * After an `=` in the option's own literal prefix a brace or glob only fills the option's value, every
 * expansion keeping the prefix (`--include=*.ts`, `--include={a,b}.ts`), so those stay ordinary. A variable is
 * read by the rules as a value and stays as it was. Returns why, or undefined.
 */
function optionExpansion(word: Word): string | undefined {
  const parts = word.parts;
  // the word's leading literal text, whatever its quoting (`''--{a,b}` starts with `--` too)
  const leadOf = (list: readonly Part[]): string => {
    let text = "";
    for (const part of list) { if (part.kind !== "lit") break; text += part.text; }
    return text;
  };
  const lead = leadOf(parts);
  const after = parts.find((part) => part.kind !== "lit");
  if (lead === "" && after?.kind === "brace" && after.alts.some((alt) => leadOf(alt.parts).startsWith("-"))) {
    return "a brace that expands to an option";
  }
  if (!lead.startsWith("-") || (lead.length < 2 && !after)) return undefined;
  let prefix = "";
  for (const part of parts) {
    if (part.kind === "lit") {
      // an unquoted `[…]` is a glob to bash (walk.ts reads it as one); this lexer keeps it literal. Any `[` in the
      // option's name, however quoted (`--['o']utput=`, `-['r']['f']`), asks: no split spelling is told apart
      if (!prefix.includes("=")) {
        const open = part.text.indexOf("["), eq = part.text.indexOf("=");
        if (open >= 0 && (eq < 0 || open < eq)) return "a glob in an option";
      }
      prefix += part.text;
      continue;
    }
    if (part.kind === "var" || part.kind === "tilde") continue;
    if ((part.kind === "brace" || part.kind === "glob") && prefix.includes("=")) continue;
    return part.kind === "brace" ? "a brace in an option" : part.kind === "glob" ? "a glob in an option" : "a substitution in an option";
  }
  return undefined;
}

const ANSI_SIMPLE: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "?": "?", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v",
};

/** The text of `$'…'` with every escape decoded as bash decodes it: the
 * named ones, `\xHH`, octal, `\uHHHH`, `\UHHHHHHHH` and `\cX`, so
 * `$'\x72m'` is `rm`. A NUL (bash cuts the word there), a code point no
 * character has, or an escape outside bash's list (bash keeps the two
 * characters) is a spelling the reader does not decode: it asks. */
function ansiUnescape(text: string): string {
  let out = "";
  const decoded = (code: number, spelled: string): string => {
    if (code === 0) throw new Unreadable("escape", `NUL in $'…' (${spelled})`);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Unreadable("escape", `${spelled} in $'…'`);
    return String.fromCodePoint(code);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c !== "\\") { out += c; continue; }
    const next = text[i + 1];
    if (next === undefined) throw new Unreadable("escape", "$'…' ends with \\");
    if (next in ANSI_SIMPLE) { out += ANSI_SIMPLE[next]; i++; continue; }
    const numeric = next === "x" ? /^x([0-9A-Fa-f]{1,2})/.exec(text.slice(i + 1))
      : next === "u" ? /^u([0-9A-Fa-f]{1,4})/.exec(text.slice(i + 1))
      : next === "U" ? /^U([0-9A-Fa-f]{1,8})/.exec(text.slice(i + 1))
      : /^([0-7]{1,3})/.exec(text.slice(i + 1));
    if (numeric) {
      out += decoded(parseInt(numeric[1]!, next === "x" || next === "u" || next === "U" ? 16 : 8), `\\${numeric[0]}`);
      i += numeric[0].length;
      continue;
    }
    if (next === "c") {
      const target = text[i + 2];
      if (target === undefined) throw new Unreadable("escape", "$'…' ends with \\c");
      const code = target.toUpperCase().charCodeAt(0);
      if (code > 0x7f) throw new Unreadable("escape", `\\c${target} in $'…'`);
      out += decoded(code ^ 0x40, `\\c${target}`);
      i += 2;
      continue;
    }
    throw new Unreadable("escape", `\\${next} in $'…'`);
  }
  return out;
}

/** Tokens for a whole script. */
export function lex(text: string): Token[] {
  if (text.length > MAX_TEXT_CHARS) throw new Unreadable("length");
  return new Lexer(text).run();
}

/** One word lexed on its own (the operand of `${X:-word}`, an item xargs or
 * cmd's `for` reads), in the quoting context it sits in. A double-quoted
 * operand is still one word. */
export function lexWordText(text: string, quote: Quote = "none"): Word {
  if (quote === "double") return { parts: lexQuotedBody(text) };
  const tokens = new Lexer(text).run();
  const parts: Part[] = [];
  for (const token of tokens) if (token.kind === "word") parts.push(...token.word.parts);
  return { parts };
}

/** The parts of text that sits inside double quotes with no closing quote
 * of its own: an unquoted heredoc body, where `$( )` still runs. */
export function lexQuotedBody(text: string): Part[] {
  return new Lexer(text).body();
}

/** The text of a word whose parts are all literal (any quoting), else undefined. */
export function literalText(word: Word): string | undefined {
  let out = "";
  for (const part of word.parts) {
    if (part.kind !== "lit") return undefined;
    out += part.text;
  }
  return out;
}

/** Does the word stand for exactly one fixed string? */
export function isLiteral(word: Word): boolean {
  return word.parts.every((part) => part.kind === "lit");
}

/** Is the word fixed by the text: literal, or a `~` the shell fills in from
 * who runs it? Anything else (a value, a substitution, a glob, a brace) is
 * something the reader would have to expand itself. */
export function isPlain(word: Word): boolean {
  return word.parts.every((part) => part.kind === "lit" || part.kind === "tilde");
}

/** The word written back out as script text, for a script that one shell
 * hands to another (`bash -c "…"`, `eval …`). Literal text goes through as
 * the inner shell would receive it; an expansion is written back as the
 * expansion, so the inner reader sees it as a value it cannot know. */
export function renderWord(word: Word): string {
  let out = "";
  for (const part of word.parts) {
    switch (part.kind) {
      case "lit": out += part.text; break;
      case "var": out += part.op === "#" ? `\${#${part.name}}` : part.op ? `\${${part.name}${part.op}${part.word ? renderWord(part.word) : ""}}` : `\${${part.name}}`; break;
      case "subst": out += `$(${part.text})`; break;
      case "arith": out += `$((${part.text}))`; break;
      case "procsub": out += `${part.dir}(${part.text})`; break;
      case "tilde": out += `~${part.user}`; break;
      case "glob": out += part.text; break;
      case "brace": out += `{${part.alts.map(renderWord).join(",")}}`; break;
    }
  }
  return out;
}
