// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A recursive-descent parser over server/shell/lex.ts tokens into a small
// AST: lists, pipelines, simple commands and the compound forms (if, loops,
// case, groups, subshells, functions, `(( ))`, `[[ ]]`). It is total: it
// returns a Script or throws `Unreadable`. There is no partial result and no
// recovery, because a shape the reader did not understand must ask, not
// approve.

import { lex, lexQuotedBody, type Heredoc, type Token, type Word, Unreadable } from "./lex.ts";

export interface Script {
  items: Item[];
}
export interface Item {
  andOr: AndOr;
  background: boolean;
}
export interface AndOr {
  pipelines: Pipeline[];
  /** the operator before each pipeline after the first: `&&` or `||` */
  ops: string[];
}
export interface Pipeline {
  commands: Command[];
  negated: boolean;
}
export interface Assign {
  name: string;
  value: Word;
  /** `NAME+=value`: joined to whatever the name held */
  append?: boolean;
  /** `NAME=(a b c)`: the elements; `value` is then empty */
  elements?: Word[];
}
export interface Redirect {
  op: string;
  fd?: number;
  target?: Word;
  heredoc?: Heredoc;
}
export type Command =
  | { kind: "simple"; assigns: Assign[]; words: Word[]; redirects: Redirect[] }
  | { kind: "if"; clauses: Array<{ cond: Script; body: Script }>; otherwise?: Script; redirects: Redirect[] }
  | { kind: "loop"; until: boolean; cond: Script; body: Script; redirects: Redirect[] }
  /** `header` is the text of a `for (( … ))` loop, lexed for its substitutions */
  | { kind: "for"; name: string; words?: Word[]; header?: Word; body: Script; redirects: Redirect[] }
  | { kind: "case"; word: Word; clauses: Array<{ patterns: Word[]; body: Script }>; redirects: Redirect[] }
  | { kind: "subshell"; body: Script; redirects: Redirect[] }
  | { kind: "group"; body: Script; redirects: Redirect[] }
  | { kind: "function"; name: string; body: Command; redirects: Redirect[] }
  | { kind: "arith"; words: Word[]; redirects: Redirect[] }
  | { kind: "cond"; words: Word[]; redirects: Redirect[] };

/** zsh `repeat foreach end always nocorrect noglob`, fish `begin end and or
 * not switch`. */
const DIALECT_WORDS = ["repeat", "foreach", "end", "always", "nocorrect", "noglob", "begin", "and", "or", "not", "switch"];
const REDIRECT_OPS = new Set(["<", ">", ">>", ">|", "<>", "<&", ">&", "&>", "&>>", "<<<", "<<", "<<-"]);
const RESERVED = new Set([
  "if", "then", "elif", "else", "fi", "while", "until", "do", "done", "for", "select", "in", "case", "esac", "function", "!", "time", "coproc", "[[", "]]",
  // reserved in a shell Murage may run under (zsh, fish) and not modelled
  // here: at command position they ask, except `repeat`, read as a loop
  ...DIALECT_WORDS,
]);
const CASE_ENDS = new Set([";;", ";&", ";;&"]);
const MAX_NESTING = 64;

/** The text of a word that could be a reserved word: one unquoted literal part. */
function bareWord(token: Token): string | undefined {
  if (token.kind !== "word" || token.word.parts.length !== 1) return undefined;
  const part = token.word.parts[0]!;
  return part.kind === "lit" && part.quote === "none" ? part.text : undefined;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private nesting = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Script {
    const script = this.script(new Set());
    if (this.peek().kind !== "eof") throw new Unreadable("syntax", this.describe(this.peek()));
    return script;
  }

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)]!;
  }
  private next(): Token {
    const token = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return token;
  }
  private isOp(token: Token, op: string): boolean {
    return token.kind === "op" && token.op === op;
  }
  private isReserved(token: Token, word: string): boolean {
    return bareWord(token) === word;
  }
  private describe(token: Token): string {
    return token.kind === "op" ? token.op : token.kind === "word" ? bareWord(token) ?? "word" : token.kind;
  }
  private skipNewlines(): void {
    while (this.peek().kind === "newline") this.next();
  }
  private expectReserved(word: string): void {
    if (!this.isReserved(this.peek(), word)) throw new Unreadable("syntax", `expected ${word}, got ${this.describe(this.peek())}`);
    this.next();
  }
  private expectOp(op: string): void {
    // `))` closes two subshells as readily as one arithmetic command
    if (op === ")" && this.isOp(this.peek(), "))")) { this.tokens[this.pos] = { kind: "op", op: ")" }; return; }
    if (!this.isOp(this.peek(), op)) throw new Unreadable("syntax", `expected ${op}, got ${this.describe(this.peek())}`);
    this.next();
  }
  /** Does this token end the list being read? */
  private atStop(token: Token, stops: Set<string>): boolean {
    const word = bareWord(token);
    if (word !== undefined) return stops.has(word);
    if (token.kind !== "op") return false;
    return stops.has(token.op) || CASE_ENDS.has(token.op) || (token.op === "))" && stops.has(")"));
  }
  private enter(): void {
    if (++this.nesting > MAX_NESTING) throw new Unreadable("nesting");
  }
  private leave(): void {
    this.nesting--;
  }

  /** A list of items up to (not including) one of `stops`: reserved words or
   * operators that close the enclosing compound. */
  private script(stops: Set<string>): Script {
    const items: Item[] = [];
    for (;;) {
      this.skipNewlines();
      const token = this.peek();
      if (token.kind === "eof" || this.atStop(token, stops)) break;
      const andOr = this.andOr();
      const sep = this.peek();
      let background = false;
      if (this.isOp(sep, "&")) { background = true; this.next(); }
      else if (this.isOp(sep, ";") || sep.kind === "newline") this.next();
      else if (sep.kind !== "eof" && !this.atStop(sep, stops)) throw new Unreadable("syntax", `unexpected ${this.describe(sep)}`);
      items.push({ andOr, background });
    }
    return { items };
  }

  private andOr(): AndOr {
    const pipelines = [this.pipeline()];
    const ops: string[] = [];
    while (this.isOp(this.peek(), "&&") || this.isOp(this.peek(), "||")) {
      const op = this.next();
      ops.push(op.kind === "op" ? op.op : "");
      this.skipNewlines();
      pipelines.push(this.pipeline());
    }
    return { pipelines, ops };
  }

  private pipeline(): Pipeline {
    let negated = false;
    while (this.isReserved(this.peek(), "!")) { negated = !negated; this.next(); }
    // `time`, `time -p`, `! time`, `time !` and `time time` all run one pipeline
    while (this.isReserved(this.peek(), "time")) {
      this.next();
      if (bareWord(this.peek()) === "-p") this.next();
      while (this.isReserved(this.peek(), "!")) { negated = !negated; this.next(); }
    }
    const commands = [this.command()];
    while (this.isOp(this.peek(), "|") || this.isOp(this.peek(), "|&")) {
      this.next();
      this.skipNewlines();
      commands.push(this.command());
    }
    return { commands, negated };
  }

  private redirects(): Redirect[] {
    const out: Redirect[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind !== "op" || !REDIRECT_OPS.has(token.op)) return out;
      this.next();
      const redirect: Redirect = { op: token.op };
      if (token.fd !== undefined) redirect.fd = token.fd;
      if (token.heredoc) { redirect.heredoc = token.heredoc; out.push(redirect); continue; }
      const target = this.peek();
      if (target.kind !== "word") throw new Unreadable("syntax", `${token.op} without a target`);
      this.next();
      redirect.target = target.word;
      out.push(redirect);
    }
  }

  private command(): Command {
    this.enter();
    try {
      const token = this.peek();
      if (this.isOp(token, "(")) {
        this.next();
        const body = this.script(new Set([")"]));
        this.expectOp(")");
        return { kind: "subshell", body, redirects: this.redirects() };
      }
      if (this.isOp(token, "{")) {
        this.next();
        const body = this.script(new Set(["}"]));
        this.expectOp("}");
        return { kind: "group", body, redirects: this.redirects() };
      }
      if (this.isOp(token, "((")) {
        this.next();
        return { kind: "arith", words: [this.arithWord(token)], redirects: this.redirects() };
      }
      const word = bareWord(token);
      switch (word) {
        case "if": return this.ifCommand();
        case "while":
        case "until": return this.loopCommand(word === "until");
        case "for":
        case "select": return this.forCommand();
        case "case": return this.caseCommand();
        case "function": return this.functionCommand();
        case "[[": return this.condCommand();
        case "coproc": this.next(); if (bareWord(this.peek()) !== undefined && (this.isOp(this.peek(1), "{") || this.isOp(this.peek(1), "("))) this.next(); return this.command();
        case "repeat": return this.repeatCommand();
        default: break;
      }
      if (word !== undefined && DIALECT_WORDS.includes(word)) throw new Unreadable("dialect", word);
      if (word !== undefined && RESERVED.has(word)) throw new Unreadable("syntax", `unexpected ${word}`);
      if (token.kind === "word" && this.isOp(this.peek(1), "(") && this.isOp(this.peek(2), ")")) {
        const name = bareWord(token) ?? "";
        this.next(); this.next(); this.next();
        this.skipNewlines();
        const body = this.command();
        return { kind: "function", name, body, redirects: this.redirects() };
      }
      return this.simple();
    } finally {
      this.leave();
    }
  }

  private simple(): Command {
    const assigns: Assign[] = [];
    const words: Word[] = [];
    const redirects: Redirect[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === "op" && REDIRECT_OPS.has(token.op)) { redirects.push(...this.redirects()); continue; }
      if (token.kind !== "word") break;
      const first = token.word.parts[0];
      const arrayMatch = token.word.parts.length === 1 && first?.kind === "lit" && first.quote === "none" && this.isOp(this.peek(1), "(") ? /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=$/.exec(first.text) : null;
      const arrayName = arrayMatch?.[1];
      if (arrayMatch && arrayName !== undefined) {
        // `F=(a b c)`, also after declare/local/export: an array, in one place
        this.next(); this.next();
        const elements: Word[] = [];
        for (;;) {
          this.skipNewlines();
          const element = this.peek();
          if (this.isOp(element, ")")) { this.next(); break; }
          if (element.kind !== "word") throw new Unreadable("syntax", `array element ${this.describe(element)}`);
          elements.push(element.word);
          this.next();
        }
        assigns.push({ name: arrayName, value: { parts: [] }, elements, ...(arrayMatch[2] === "+" ? { append: true } : {}) });
        continue;
      }
      const bare = first?.kind === "lit" && first.quote === "none" ? first : undefined;
      const assignment = words.length === 0 && bare ? /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(bare.text) : null;
      if (assignment && bare) {
        const rest = bare.text.slice(assignment[0].length);
        const value: Word = { parts: rest === "" ? token.word.parts.slice(1) : [{ kind: "lit", text: rest, quote: "none" }, ...token.word.parts.slice(1)] };
        assigns.push({ name: assignment[1]!, value, ...(assignment[0].endsWith("+=") ? { append: true } : {}) });
        this.next();
        continue;
      }
      words.push(token.word);
      this.next();
    }
    if (assigns.length === 0 && words.length === 0 && redirects.length === 0) throw new Unreadable("syntax", `unexpected ${this.describe(this.peek())}`);
    return { kind: "simple", assigns, words, redirects };
  }

  private ifCommand(): Command {
    this.expectReserved("if");
    const clauses: Array<{ cond: Script; body: Script }> = [];
    let otherwise: Script | undefined;
    for (;;) {
      const cond = this.script(new Set(["then"]));
      this.expectReserved("then");
      const body = this.script(new Set(["elif", "else", "fi"]));
      clauses.push({ cond, body });
      if (this.isReserved(this.peek(), "elif")) { this.next(); continue; }
      if (this.isReserved(this.peek(), "else")) {
        this.next();
        otherwise = this.script(new Set(["fi"]));
      }
      this.expectReserved("fi");
      break;
    }
    const redirects = this.redirects();
    return otherwise ? { kind: "if", clauses, otherwise, redirects } : { kind: "if", clauses, redirects };
  }

  /** zsh `repeat N cmd`: `cmd` run N times, read as a loop over it. A count
   * the text does not fix asks. */
  private repeatCommand(): Command {
    this.next();
    const count = this.peek();
    if (count.kind !== "word" || !count.word.parts.every((part) => part.kind === "lit")) throw new Unreadable("dialect", "repeat");
    this.next();
    const command = this.command();
    const body: Script = { items: [{ andOr: { pipelines: [{ commands: [command], negated: false }], ops: [] }, background: false }] };
    return { kind: "loop", until: false, cond: { items: [] }, body, redirects: [] };
  }

  private loopCommand(until: boolean): Command {
    this.next();
    const cond = this.script(new Set(["do"]));
    this.expectReserved("do");
    const body = this.script(new Set(["done"]));
    this.expectReserved("done");
    return { kind: "loop", until, cond, body, redirects: this.redirects() };
  }

  private forCommand(): Command {
    this.next();
    if (this.isOp(this.peek(), "((")) {
      // for (( init; test; step )): arithmetic, no words to bind; the
      // header is kept so a substitution inside it is walked
      const header = this.arithWord(this.next());
      this.skipNewlines();
      if (this.isOp(this.peek(), ";")) this.next();
      this.skipNewlines();
      return { ...this.doBlock(""), header };
    }
    const name = bareWord(this.peek());
    if (name === undefined) throw new Unreadable("syntax", "for without a name");
    this.next();
    this.skipNewlines();
    let words: Word[] | undefined;
    if (this.isReserved(this.peek(), "in")) {
      this.next();
      words = [];
      for (;;) {
        const token = this.peek();
        if (token.kind === "word") { words.push(token.word); this.next(); continue; }
        if (this.isOp(token, ";") || token.kind === "newline") { this.next(); break; }
        throw new Unreadable("syntax", `unexpected ${this.describe(token)} in for`);
      }
    } else if (this.isOp(this.peek(), ";")) {
      this.next();
    }
    this.skipNewlines();
    const loop = this.doBlock(name);
    return words && loop.kind === "for" ? { ...loop, words } : loop;
  }

  private doBlock(name: string): Extract<Command, { kind: "for" }> {
    this.expectReserved("do");
    const body = this.script(new Set(["done"]));
    this.expectReserved("done");
    return { kind: "for", name, body, redirects: this.redirects() };
  }

  private caseCommand(): Command {
    this.expectReserved("case");
    const subject = this.peek();
    if (subject.kind !== "word") throw new Unreadable("syntax", "case without a word");
    this.next();
    this.skipNewlines();
    this.expectReserved("in");
    const clauses: Array<{ patterns: Word[]; body: Script }> = [];
    for (;;) {
      this.skipNewlines();
      if (this.isReserved(this.peek(), "esac")) break;
      if (this.isOp(this.peek(), "(")) this.next();
      const patterns: Word[] = [];
      for (;;) {
        const token = this.peek();
        if (token.kind !== "word") throw new Unreadable("syntax", `case pattern ${this.describe(token)}`);
        patterns.push(token.word);
        this.next();
        if (this.isOp(this.peek(), "|")) { this.next(); continue; }
        break;
      }
      this.expectOp(")");
      const body = this.script(new Set(["esac"]));
      clauses.push({ patterns, body });
      const end = this.peek();
      if (end.kind === "op" && CASE_ENDS.has(end.op)) this.next();
    }
    this.expectReserved("esac");
    return { kind: "case", word: subject.word, clauses, redirects: this.redirects() };
  }

  private functionCommand(): Command {
    this.expectReserved("function");
    const name = bareWord(this.peek());
    if (name === undefined) throw new Unreadable("syntax", "function without a name");
    this.next();
    if (this.isOp(this.peek(), "(")) { this.next(); this.expectOp(")"); }
    this.skipNewlines();
    const body = this.command();
    return { kind: "function", name, body, redirects: this.redirects() };
  }

  /** The text inside `(( … ))` as one word: nothing in arithmetic runs
   * except its substitutions, which are its parts. */
  private arithWord(token: Token): Word {
    if (token.kind !== "op" || token.arith === undefined) throw new Unreadable("syntax", "(( without ))");
    return { parts: lexQuotedBody(token.arith) };
  }

  /** The words inside `[[ … ]]`; nothing in there is a command. */
  private condCommand(): Command {
    this.expectReserved("[[");
    const words: Word[] = [];
    for (;;) {
      const token = this.next();
      if (token.kind === "eof") throw new Unreadable("syntax", "[[ without ]]");
      if (this.isReserved(token, "]]")) break;
      if (token.kind === "word") words.push(token.word);
    }
    return { kind: "cond", words, redirects: this.redirects() };
  }
}

/** The script, or `Unreadable`. */
export function parse(text: string): Script {
  return new Parser(lex(text)).parse();
}
