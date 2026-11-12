// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { boundedText, ReaderBudget, ReaderCut } from "./no-limits-budget.ts";
import { lexCode, type CodeToken } from "./code-lexer.ts";
import { joinPath, quote, quoteTarget, type Twin } from "./no-limits-shell.ts";

// An inert Python expression tree. Statement bindings are global, just as the
// reference's ast.walk scan is global (there is deliberately no scope inference).
type Expr = (
  | { kind: "constant"; value: string | boolean | null; literal: boolean; numericOutside?: boolean }
  | { kind: "name"; name: string }
  | { kind: "attr"; value: Expr; name: string }
  | { kind: "subscript"; value: Expr; index: Expr }
  | { kind: "call"; func: Expr; args: Expr[]; keywords: Map<string, Expr> }
  | { kind: "bin"; op: string; left: Expr; right: Expr }
  | { kind: "parameters" | "visits"; count: number }
  | { kind: "keyword" | "formatted"; value: Expr }
  | { kind: "list" | "unknown" | "joined"; children: Expr[] }) & { bindings?: Binding[] };
type Binding = { names: string[]; value?: Expr; times: number; alias?: string; visits?: number };
class Unresolved extends Error {}
class PythonSyntaxError extends Error {}
function children(e: Expr): Expr[] {
  switch (e.kind) {
    case "name": return [{ kind: "visits", count: 1 }];
    case "attr": return [e.value, { kind: "visits", count: 1 }];
    case "subscript": return [e.value, e.index, { kind: "visits", count: 1 }];
    case "call": return [e.func, ...e.args, ...[...e.keywords.values()].map(value => ({ kind: "keyword" as const, value }))];
    case "bin": return [e.left, { kind: "visits", count: 1 }, e.right];
    case "parameters": return [{ kind: "visits", count: e.count }];
    case "keyword": case "formatted": return [e.value];
    case "list": return [...e.children, { kind: "visits", count: 1 }];
    case "unknown": return e.bindings ? e.children : [{ kind: "visits", count: 1 }, ...e.children];
    case "joined": return e.children;
    default: return [];
  }
}
function* walk(roots: Expr[], budget: ReaderBudget): Generator<Expr> {
  const queue = roots.slice();
  for (let i = 0; i < queue.length; i++) { const e = queue[i];
    // Omitted argument leaves occupy their actual breadth-first position.
    // Charging them at the function statement could hide an earlier call.
    if (e.kind === "visits") { for (let n = 0; n < e.count; n++) budget.tick(); continue; }
    budget.tick();
    // Contexts, operators, keywords and formatted values are queued at their
    // actual AST depth; early charging can otherwise conceal a retained effect.
    yield e; for (const child of children(e)) queue.push(child); }
}
const namesIn = (e: Expr, budget: ReaderBudget): string[] => [...walk([e], budget)].filter((n): n is Extract<Expr, { kind: "name" }> => n.kind === "name").map(n => n.name);
const unknown = (children: Expr[] = []): Expr => ({ kind: "unknown", children });
const constant = (value: string, literal = true): Expr => ({ kind: "constant", value, literal });

/** Parses expressions without evaluating them. Unsupported expression operators
 * retain their children but cannot resolve to a target. Invalid token structure
 * takes the same lexical fallback as ast.parse's SyntaxError. */
const KEYWORDS = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));
class Parser {
  t: CodeToken[];
  i = 0;
  roots: Expr[] = [];
  bindings: Binding[] = [];
  rejected = false;
  budget: ReaderBudget;
  constructor(code: string, budget: ReaderBudget) {
    this.budget = budget;
    boundedText(code);
    const lex = lexCode("python", code);
    this.rejected = lex.unreadable;
    // These tokens are retained for an additive effect walk, never for a clean read.
    for (const token of lex.tokens) {
      if (token.text.length > 16_384 || token.kind === "number" && token.text.replaceAll("_", "").length > 4300) this.rejected = true;
      if (token.kind === "name" && ["async", "await", "yield", "lambda", "class", "match", "case", "with", "try", "except", "finally", "global", "nonlocal"].includes(token.text)) this.rejected = true;
      if (token.kind === "punct" && ["<<", ">>", "<=", ">="].includes(token.text)) this.rejected = true;
    }
    // Python's implicit line continuation applies only inside brackets.
    let level = 0; const stack: string[] = [];
    this.t = lex.tokens.filter(t => {
      if (t.kind === "punct" && ["(", "[", "{"].includes(t.text)) { stack.push(t.text); level++; if (level > 200) throw new ReaderCut("parser nesting limit"); }
      else if (t.kind === "punct" && [")", "]", "}"].includes(t.text)) {
        const open = stack.pop(); if (open !== ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[t.text]) this.rejected = true;
        level--;
      }
      return t.kind !== "newline" || !level;
    });
    if (stack.length) this.rejected = true;
  }
  at(v: string): boolean { return this.t[this.i]?.text === v; }
  take(v: string): boolean { if (!this.at(v)) return false; this.i++; return true; }
  need(v: string): void { if (!this.take(v)) throw new PythonSyntaxError(); }
  name(): string { const t = this.t[this.i++]; if (t?.kind !== "name") throw new PythonSyntaxError(); if (KEYWORDS.has(t.text)) this.rejected = true; return t.text; }
  dottedName(): string { let s = this.name(); while (this.take(".")) s += "." + this.name(); return s; }
  end(): boolean { return this.i >= this.t.length || this.at("\n") || this.at(";"); }
  string(): Expr {
    const nodes: Expr[] = []; let joined = false; let bytes: boolean | undefined;
    while (this.t[this.i]?.kind === "string") {
      const t = this.t[this.i++];
      const isBytes = /^[rRuUbBfF]*b/i.test(t.text);
      if (bytes !== undefined && bytes !== isBytes) this.rejected = true;
      bytes = isBytes;
      if (t.template) {
        joined = true;
        for (let j = 0; j < t.template.parts.length; j++) {
          if (t.template.parts[j]) nodes.push(constant(t.template.parts[j]));
          if (j < t.template.expressions.length) {
            const p = new Parser(t.template.expressions[j], this.budget);
            const e = p.expr();
            if (p.rejected || p.i !== p.t.length) this.rejected = true;
            nodes.push({ kind: "formatted", value: p.i === p.t.length ? e : unknown([e]) });
          }
        }
      } else if (t.value !== undefined) {
        if (/^[fF]/.test(t.text)) joined = true;
        nodes.push(constant(t.value));
      } else throw new PythonSyntaxError();
    }
    // ast folds adjacent ordinary literals into ONE Constant, before S2.
    if (!joined) return constant(nodes.map(n => n.kind === "constant" ? n.value : "").join(""));
    return { kind: "joined", children: nodes };
  }
  expr(min = 0): Expr {
    let left = this.atom();
    while (this.i < this.t.length) {
      if (this.take(".")) { left = { kind: "attr", value: left, name: this.name() }; continue; }
      if (this.take("[")) { const index = this.sequence("]"); this.need("]"); left = { kind: "subscript", value: left, index }; continue; }
      if (this.take("(")) {
        const args: Expr[] = [], keywords = new Map<string, Expr>();
        while (!this.at(")")) {
          if (this.i >= this.t.length) throw new PythonSyntaxError();
          if (this.t[this.i]?.kind === "name" && this.t[this.i + 1]?.text === "=") { const key = this.name(); this.need("="); const value = this.expr(); if (keywords.has(key)) { this.rejected = true; args.push(value); } else keywords.set(key, value); }
          else { if (keywords.size) this.rejected = true; args.push(this.expr()); }
          if (!this.take(",")) break;
        }
        this.need(")"); left = { kind: "call", func: left, args, keywords }; continue;
      }
      const op = this.t[this.i].text;
      const prec: Record<string, number> = { ":=": 1, or: 2, and: 3, in: 4, is: 4, "==": 4, "!=": 4, "<": 4, ">": 4, "<=": 4, ">=": 4, "|": 5, "^": 6, "&": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "//": 10, "%": 10, "@": 10, "**": 11 };
      if (prec[op] === undefined || prec[op] < min) break;
      this.i++; const right = this.expr(prec[op] + (op === "**" ? 0 : 1));
      if (op === ":=") { if (left.kind === "name") this.bindings.push({ names: [left.name], times: 2 }); else this.rejected = true; }
      left = { kind: "bin", op, left, right };
    }
    return left;
  }
  sequence(close?: string): Expr {
    const first = this.expr();
    if (!this.take(",")) return first;
    const children = [first];
    while (!this.end() && (!close || !this.at(close)) && !this.at("=")) {
      children.push(this.expr()); if (!this.take(",")) break;
    }
    return { kind: "list", children };
  }
  atom(): Expr {
    const t = this.t[this.i]; if (!t) throw new PythonSyntaxError();
    if (t.kind === "string") return this.string();
    if (t.kind === "number") {
      this.i++;
      const number = t.text.replaceAll("_", "");
      if (number.length > 4300) { this.rejected = true; return unknown(); }
      if (/^(?:0[xob][0-9a-f]+|[0-9]+)$/i.test(number)) {
        try { return constant(BigInt(number).toString(), false); } catch { this.rejected = true; return unknown(); }
      }
      // Floats/imaginaries may occur in benign code, but only exact integer
      // conversion is in the value subset. Resolving these fails closed.
      return { kind: "constant", value: null, literal: false, numericOutside: true };
    }
    if (["+", "-", "~", "*", "**", "not", "await", "yield"].includes(t.text)) { if (["*", "**"].includes(t.text)) this.rejected = true; this.i++; return unknown([this.expr(11)]); }
    if (this.take("lambda")) {
      while (!this.at(":")) {
        if (this.i >= this.t.length) throw new PythonSyntaxError();
        if (this.t[this.i].kind === "name") this.bindings.push({ names: [this.name()], times: 2, visits: 2 }); else this.i++;
      }
      this.need(":"); return unknown([this.expr()]);
    }
    if (t.kind === "name") {
      this.i++;
      if (["True", "False", "None"].includes(t.text)) return { kind: "constant", value: t.text === "None" ? null : t.text === "True", literal: false };
      if (KEYWORDS.has(t.text)) this.rejected = true;
      return { kind: "name", name: t.text };
    }
    if (this.take("(")) { if (this.take(")")) return { kind: "list", children: [] }; const e = this.sequence(")"); this.need(")"); return e; }
    if (this.at("[") || this.at("{")) {
      const list = this.take("["); if (!list) this.need("{"); const close = list ? "]" : "}";
      const elts: Expr[] = [];
      while (!this.at(close)) {
        if (this.i >= this.t.length) throw new PythonSyntaxError();
        elts.push(this.expr());
        if (this.take(":")) elts.push(this.expr());
        if (this.take("for")) {
          const target = this.expr(5); if (!this.validTarget(target)) this.rejected = true; this.bindings.push({ names: namesIn(target, this.budget), times: 2 });
          this.need("in"); elts.push(target, this.expr());
          while (this.take("if")) elts.push(this.expr());
          this.need(close); return unknown(elts);
        }
        if (!this.take(",")) break;
      }
      this.need(close); return { kind: list ? "list" : "unknown", children: elts };
    }
    throw new PythonSyntaxError();
  }
  validTarget(e: Expr): boolean {
    if (e.kind === "name") return true;
    // The subset admits name-rooted attributes and subscripts directly on names.
    // Python accepts more shapes; rejecting them triggers additive fallback.
    if (e.kind === "subscript") return e.value.kind === "name";
    if (e.kind === "attr") return this.validTargetBase(e.value);
    return e.kind === "list" && e.children.length > 0 && e.children.every(child => this.validTarget(child));
  }
  validTargetBase(e: Expr): boolean {
    return e.kind === "name" || (e.kind === "attr" || e.kind === "subscript") && this.validTargetBase(e.value);
  }
  parse(): this {
    // Statement wrappers retain the suite hierarchy. Walking these wrappers is
    // breadth first, like ast.walk; source indentation width is not AST depth.
    const statements: Expr[] = [];
    const suites: { indent: number; node: Extract<Expr, { children: Expr[] }> }[] = [];
    const branches = new Map<number, Extract<Expr, { children: Expr[] }>>();
    let previousLine = -1, pendingIndent = -1;
    let pendingSuite: Extract<Expr, { children: Expr[] }> | undefined;
    try {
      while (this.i < this.t.length) {
        if (this.take("\n") || this.take(";")) continue;
        const token = this.t[this.i];
        if (token.line !== previousLine) {
          while (suites.length && token.column < suites.at(-1)!.indent) suites.pop();
          if (pendingSuite) {
            if (token.column <= pendingIndent) this.rejected = true;
            suites.push({ indent: token.column, node: pendingSuite });
          } else if (token.column !== (suites.at(-1)?.indent ?? 0)) this.rejected = true;
          previousLine = token.line;
        } else if (pendingSuite) suites.push({ indent: token.column, node: pendingSuite });
        const branch = branches.get(token.column);
        const reuse = branch && ["else", "finally"].includes(token.text);
        const statement: Extract<Expr, { children: Expr[] }> = reuse ? branch : { kind: "unknown", children: [], bindings: [] };
        if (!reuse) {
          const parent = branch && ["elif", "except"].includes(token.text) ? branch.children : suites.at(-1)?.node.children ?? statements;
          parent.push(statement);
        }
        if (["if", "elif", "for", "while", "try"].includes(token.text)) branches.set(token.column, statement);
        this.roots = statement.children;
        this.bindings = statement.bindings!;
        pendingSuite = undefined;
        try {
          if (this.take("async")) { /* async changes neither binding nor effect resolution */ }
          if (this.take("import")) {
            do {
              const mod = this.dottedName(), aliased = this.take("as");
              const loc = aliased ? this.name() : mod.split(".")[0];
              this.bindings.push({ names: [loc], alias: aliased ? mod : mod.split(".")[0], times: 1 });
              this.roots.push({ kind: "visits", count: 1 }); // ast.alias
            } while (this.take(","));
            if (!this.end()) this.rejected = true;
            continue;
          }
          if (this.take("from")) {
            while (this.take(".")) { /* relative level is absent from ast.ImportFrom.module */ }
            const mod = this.at("import") ? "" : this.dottedName(); this.need("import"); const paren = this.take("(");
            do { const src = this.take("*") ? "*" : this.name(), loc = this.take("as") ? this.name() : src; if (mod) this.bindings.push({ names: [loc], alias: mod + "." + src, times: 1 }); this.roots.push({ kind: "visits", count: 1 }); } while (this.take(",") && !this.at(")"));
            if (paren) this.need(")"); if (!this.end()) this.rejected = true; continue;
          }
          if (this.take("def")) {
            this.budget.tick(); // arguments node in the additional binding walk
            const parameters = { kind: "parameters" as const, count: 0 };
            this.roots.push(parameters);
            this.name(); this.need("(");
            while (!this.at(")")) {
              if (this.i >= this.t.length) throw new PythonSyntaxError();
              if (this.take("*") || this.take("**") || this.take("/")) { this.rejected = true; continue; }
              if (this.take(",")) continue;
              const name = this.name(); this.bindings.push({ names: [name], times: 2, visits: 1 });
              // Retain the prior conservative parameter-list ceiling, but
              // reject without discarding the tree or its collected effects.
              if (++parameters.count > 250_000) this.rejected = true;
              if (this.take(":")) { this.rejected = true; this.roots.push(this.expr()); }
              if (this.take("=")) { this.rejected = true; this.roots.push(this.expr()); }
              if (!this.at(")")) this.need(",");
            }
            this.need(")"); if (this.take("-")) { this.need(">"); this.roots.push(this.expr()); }
            this.need(":"); continue;
          }
          if (this.take("for")) {
            const target = this.expr(5); if (!this.validTarget(target)) this.rejected = true; this.bindings.push({ names: namesIn(target, this.budget), times: 2 }); this.need("in"); this.roots.push(target, this.expr()); this.need(":"); continue;
          }
          if (this.take("with")) {
            do { this.roots.push(this.expr()); if (this.take("as")) { const target = this.expr(); if (!this.validTarget(target)) this.rejected = true; this.bindings.push({ names: namesIn(target, this.budget), times: 2 }); this.roots.push(target); } } while (this.take(","));
            this.need(":"); continue;
          }
          if (["if", "elif", "while", "match", "case", "class", "except"].includes(this.t[this.i]?.text)) {
            this.i++; if (!this.at(":")) this.roots.push(this.expr()); this.need(":"); continue;
          }
          if (["else", "try", "finally"].includes(this.t[this.i]?.text)) { this.i++; this.need(":"); continue; }
          if (["pass", "break", "continue"].includes(this.t[this.i]?.text)) { this.i++; if (!this.end()) this.rejected = true; continue; }
          if (["return", "raise", "del", "assert", "global", "nonlocal"].includes(this.t[this.i]?.text)) {
            const statement = this.t[this.i++].text;
            if (!this.end()) { const value = this.sequence(); if (statement === "del" && !this.validTarget(value)) this.rejected = true; this.roots.push(value); }
            if (!this.end()) this.rejected = true;
            continue;
          }
          const lhs = this.sequence(); this.roots.push(lhs);
          if (this.take("=")) {
            const targets = [lhs]; let value = this.sequence();
            while (this.take("=")) { targets.push(value); value = this.sequence(); }
            this.roots.push(value);
            for (const target of targets) { if (!this.validTarget(target)) this.rejected = true; this.bindings.push({ names: namesIn(target, this.budget), times: 1, ...(target.kind === "name" ? { value } : {}) }); }
          } else if (this.take(":")) {
            if (!["name", "attr", "subscript"].includes(lhs.kind) || !this.validTarget(lhs)) this.rejected = true;
            this.roots.push(this.expr()); const value = this.take("=") ? this.sequence() : undefined;
            if (value) this.roots.push(value);
            if (lhs.kind === "name") this.bindings.push({ names: [lhs.name], times: 1, value });
          } else if (["+=", "-=", "*=", "/=", "//=", "**="].includes(this.t[this.i]?.text)) {
            if (!["name", "attr", "subscript"].includes(lhs.kind) || !this.validTarget(lhs)) this.rejected = true;
            this.i++; this.roots.push(this.expr()); if (lhs.kind === "name") this.bindings.push({ names: [lhs.name], times: 2 });
          }
          if (!this.end()) throw new PythonSyntaxError();
        } finally {
          if (this.t[this.i - 1]?.text === ":") { pendingSuite = statement; pendingIndent = token.column; }
        }
      }
      if (pendingSuite) this.rejected = true;
    } finally {
      this.roots = statements;
      this.bindings = [];
      this.budget.tick(); // ast.Module
      for (const node of walk(statements, this.budget)) for (const binding of node.bindings ?? []) {
        // Import aliases and function arguments are omitted from the expression
        // tree. Assignment targets were already charged by namesIn; charging
        // them again here could lose an earlier effect before the oracle cut.
        for (let i = 0; i < (binding.visits ?? 0); i++) this.budget.tick();
        this.bindings.push(binding);
      }
    }
    return this;
  }
}

const str = (v: string | string[]): string => Array.isArray(v) ? v.join(" ") : v;
const BUILTINS = ["exec", "eval", "compile", "open", "getattr", "__import__"];
export class PyReader {
  tree: Expr[];
  aliases = new Map<string, string>();
  assign = new Map<string, Expr>();
  assignCount = new Map<string, number>();
  unresolvedN = 0;
  literals: string[] = [];
  twins: Twin[] = [];
  cut = false;
  rejected = false;
  budget: ReaderBudget;
  onTwin?: (twin: Twin) => void;
  constructor(code: string, budget = new ReaderBudget(), onTwin?: (twin: Twin) => void) {
    this.budget = budget; this.onTwin = onTwin;
    const p = new Parser(code, this.budget);
    try { p.parse(); } catch (error) {
      if (error instanceof PythonSyntaxError) this.rejected = true;
      else this.cut = true;
    }
    this.rejected ||= p.rejected;
    this.tree = p.roots;
    for (const b of p.bindings) for (const n of b.names) {
      this.assignCount.set(n, (this.assignCount.get(n) ?? 0) + b.times);
      if (b.alias) this.aliases.set(n, b.alias);
      if (b.value) this.assign.set(n, b.value);
    }
    for (const mod of ["os", "shutil", "subprocess", "pathlib", "sys", "importlib"]) if (!this.aliases.has(mod) && !this.assignCount.get(mod)) this.aliases.set(mod, mod);
  }
  fresh(): string { return "$MURAGE_U" + ++this.unresolvedN; }
  dotted(e: Expr): string | undefined {
    this.budget.tick();
    if (e.kind === "name") return this.aliases.get(e.name) ?? (BUILTINS.includes(e.name) ? e.name : undefined);
    if (e.kind === "attr") { const base = this.dotted(e.value); return base ? base + "." + e.name : undefined; }
    if (e.kind === "call") {
      const f = this.dotted(e.func);
      if (["__import__", "importlib.import_module"].includes(f ?? "") && e.args.length) {
        try { const v = this.resolve(e.args[0], 0); return typeof v === "string" ? v : undefined; } catch (err) { if (!(err instanceof Unresolved)) throw err; return undefined; }
      }
      if (f === "getattr" && e.args.length >= 2) {
        const base = this.dotted(e.args[0]); if (!base) return undefined;
        try { return base + "." + str(this.resolve(e.args[1], 0)); } catch (err) { if (!(err instanceof Unresolved)) throw err; return base + ".<dynamic>"; }
      }
      if (["pathlib.Path", "pathlib.PurePath", "pathlib.PosixPath"].includes(f ?? "")) return "pathlib.Path()";
    }
    return undefined;
  }
  resolve(e: Expr, depth: number): string | string[] {
    this.budget.tick();
    if (e.kind === "constant") { if (e.numericOutside) { this.cut = true; throw new Unresolved(); } if (typeof e.value === "string") return e.value; throw new Unresolved(); }
    if (e.kind === "formatted") return this.resolve(e.value, depth);
    if (e.kind === "joined") return e.children.map(v => str(this.resolve(v, depth))).join("");
    if (e.kind === "list") return e.children.map(v => str(this.resolve(v, depth)));
    if (e.kind === "bin" && e.op === "+") {
      const a = this.resolve(e.left, depth), b = this.resolve(e.right, depth);
      return Array.isArray(a) && Array.isArray(b) ? [...a, ...b] : str(a) + str(b);
    }
    if (e.kind === "bin" && e.op === "/") return joinPath([str(this.resolve(e.left, depth)), str(this.resolve(e.right, depth))]);
    if (e.kind === "name") {
      const value = this.assign.get(e.name);
      if (depth >= 1 || this.assignCount.get(e.name) !== 1 || !value) throw new Unresolved();
      return this.resolve(value, depth + 1);
    }
    if (e.kind === "attr") {
      const d = this.dotted(e); if (d === "os.sep") return "/"; if (d === "sys.executable") return "python3"; throw new Unresolved();
    }
    if (e.kind === "subscript") { if (this.dotted(e.value) === "os.environ" && this.resolve(e.index, depth) === "HOME") return "$HOME"; throw new Unresolved(); }
    if (e.kind === "call") {
      const f = this.dotted(e.func), args = e.args;
      if (["os.path.join", "posixpath.join"].includes(f ?? "") && args.length) return joinPath(args.map(a => str(this.resolve(a, depth))));
      if (["os.path.expanduser", "os.path.abspath", "os.path.normpath", "os.path.realpath", "str", "os.fspath"].includes(f ?? "") && args.length === 1) return this.resolve(args[0], depth);
      if (["pathlib.Path", "pathlib.PurePath", "pathlib.PosixPath"].includes(f ?? "")) return args.length ? joinPath(args.map(a => str(this.resolve(a, depth)))) : ".";
      if (["pathlib.Path.home", "os.getcwd"].includes(f ?? "") || (e.func.kind === "attr" && e.func.name === "home" && ["pathlib.Path", "pathlib.PurePath"].includes(this.dotted(e.func.value) ?? ""))) {
        if (f === "os.getcwd") throw new Unresolved(); return "~";
      }
      if (["os.getenv", "os.environ.get"].includes(f ?? "") && args.length) { if (this.resolve(args[0], depth) === "HOME") return "$HOME"; throw new Unresolved(); }
      if (e.func.kind === "attr") {
        if (["expanduser", "resolve", "absolute"].includes(e.func.name) && !args.length) return this.resolve(e.func.value, depth);
        if (e.func.name === "joinpath") return joinPath([str(this.resolve(e.func.value, depth)), ...args.map(a => str(this.resolve(a, depth)))]);
      }
    }
    throw new Unresolved();
  }
  arg(e: Expr): string { try { return str(this.resolve(e, 0)); } catch (err) { if (!(err instanceof Unresolved)) throw err; return this.fresh(); } }
  emit(twin: Twin): void { this.twins.push(twin); this.onTwin?.(twin); }
  twinDelete(flag: string, target: string, why: string): void { this.emit(["sh", flag + " -- " + quoteTarget(target), why]); }
  run(): this {
    this.budget.tick(); // ast.Module
    for (const node of walk(this.tree, this.budget)) {
      if (node.kind === "constant" && node.literal && typeof node.value === "string") this.literals.push(node.value);
      if (node.kind === "bin" && node.op === "+") { try { this.literals.push(str(this.resolve(node, 1))); } catch (err) { if (!(err instanceof Unresolved)) throw err; } }
      if (node.kind !== "call") continue;
      let f = this.dotted(node.func);
      const attr = node.func.kind === "attr" ? node.func.name : undefined, first = node.args[0];
      if (!f && ["unlink", "rmdir"].includes(attr ?? "") && node.func.kind === "attr") {
        const recv = node.func.value; if (recv.kind === "call" && this.dotted(recv.func)?.startsWith("pathlib.")) f = "pathlib.Path()." + attr;
      }
      if (!f) continue;
      const dot = f.lastIndexOf("."), mod = dot < 0 ? "" : f.slice(0, dot), name = f.slice(dot + 1);
      if (f.endsWith(".<dynamic>") && ["shutil", "os", "pathlib"].includes(mod.split(".")[0])) this.twinDelete("rm -rf", this.fresh(), "unresolved callee on " + mod);
      else if (["shutil.rmtree", "os.removedirs"].includes(f) && first) this.twinDelete("rm -rf", this.arg(first), f);
      else if (["os.remove", "os.unlink"].includes(f) && first) this.twinDelete("rm -f", this.arg(first), f);
      else if (f === "os.rmdir" && first) this.twinDelete("rmdir", this.arg(first), f);
      else if (f === "os.truncate" && first) {
        const size = node.args.length > 1 ? this.arg(node.args[1]) : "0", t = this.arg(first);
        this.emit(["sh", "truncate -s " + quote(size) + " -- " + quoteTarget(t), f]);
      } else if (node.func.kind === "attr" && (["pathlib.Path().unlink", "pathlib.Path().rmdir"].includes(f) || (["unlink", "rmdir"].includes(attr ?? "") && node.func.value.kind === "call" && this.dotted(node.func.value.func)?.startsWith("pathlib.")))) {
        this.twinDelete(name === "unlink" ? "rm -f" : "rmdir", this.arg(node.func.value), f);
      } else if (mod === "pathlib.Path()" && ["unlink", "rmdir"].includes(name)) this.twinDelete(name === "unlink" ? "rm -f" : "rmdir", this.fresh(), f);
      else if (["os.system", "os.popen", "subprocess.getoutput", "subprocess.getstatusoutput", "commands.getoutput"].includes(f) && first) this.emit(["sh", this.arg(first), f]);
      else if (mod === "subprocess" && ["run", "call", "check_call", "check_output", "Popen"].includes(name) && first) {
        const kw = node.keywords.get("shell"), shell = kw?.kind === "constant" && kw.value === true;
        let v: string | string[]; try { v = this.resolve(first, 0); } catch (err) { if (!(err instanceof Unresolved)) throw err; v = this.fresh(); }
        if (Array.isArray(v)) this.emit(["sh", v.map(x => x.startsWith("$MURAGE_U") ? '"' + x + '"' : quote(x)).join(" "), f]);
        else if (shell || v.startsWith("$MURAGE_U")) this.emit(["sh", v.startsWith("$MURAGE_U") ? '"' + v + '"' : v, f]);
        else this.emit(["sh", quote(v), f + " (argv0)"]);
      } else if (mod === "os" && ["execv", "execve", "execvp", "execvpe", "execl", "execle", "execlp", "execlpe", "spawnv", "spawnve", "spawnvp", "spawnvpe", "spawnl", "spawnle", "spawnlp", "spawnlpe", "posix_spawn", "posix_spawnp"].includes(name) && node.args.length) {
        let argv: string | string[];
        if (/(v|ve|vp|vpe)$/.test(name) || name.startsWith("posix_spawn")) {
          try { argv = node.args[1] ? this.resolve(node.args[1], 0) : []; } catch (err) { if (!(err instanceof Unresolved)) throw err; argv = [this.fresh()]; }
        } else argv = node.args.slice(1).map(a => this.arg(a));
        this.emit(["sh", (Array.isArray(argv) ? argv : [argv]).map(x => x.startsWith("$MURAGE_U") ? '"' + x + '"' : quote(x)).join(" "), f]);
      } else if (["exec", "eval", "compile"].includes(f) && first) {
        try { this.emit(["py", str(this.resolve(first, 0)), f]); } catch (err) { if (!(err instanceof Unresolved)) throw err; }
      }
    }
    return this;
  }
}
/** Forward-only fallback scanner: every code unit is visited at most once.
 * Its optional counter is only used by tests; payloads never supply callbacks. */
export function* lexicalStrings(code: string, visit?: () => void): Generator<[number, number, string]> {
  let i = 0;
  while (i < code.length) {
    const quote = code[i++]; visit?.();
    if (quote !== "\"" && quote !== "'") continue;
    const start = i - 1, body = i;
    let closed = false;
    while (i < code.length) {
      const c = code[i++]; visit?.();
      if (c === "\\") { if (i < code.length) { i++; visit?.(); } }
      else if (c === quote) { yield [start, i, code.slice(body, i - 1)]; closed = true; break; }
    }
    if (!closed) throw new ReaderCut("unterminated fallback string");
  }
}
export function pythonFallback(code: string, twins: Twin[], literals: string[], budget: ReaderBudget, onTwin?: (twin: Twin) => void): void {
  const emit = (twin: Twin) => { twins.push(twin); onTwin?.(twin); budget.tick(); };
  for (const m of code.matchAll(/\b(shutil\.rmtree|os\.removedirs|os\.remove|os\.unlink|os\.rmdir|os\.truncate|\.unlink\(\)|\.rmdir\(\))/g))
    emit(["sh", 'rm -rf -- "$MURAGE_U0"', "lexical " + m[1]]);
  const calls = new Map<number, string>();
  for (const m of code.matchAll(/\b(os\.system|os\.popen|subprocess\.\w+)\s*\(\s*/g)) calls.set(m.index + m[0].length, m[1]);
  for (const [start, end, body] of lexicalStrings(code, () => budget.tick())) {
    literals.push(body);
    if (!calls.has(start)) continue;
    let j = end;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (j < code.length && [",", ")"].includes(code[j])) emit(["sh", body, "lexical " + calls.get(start)]);
  }
}
export function readPython(code: string, budget = new ReaderBudget(), onTwin?: (twin: Twin) => void): { twins: Twin[]; literals: string[]; cut: boolean } {
  let reader: PyReader | undefined, cut = code.includes("\r") || code.includes("\0");
  // Normalization is for additive effects ONLY: the original CR keeps the cut.
  code = code.replace(/\r\n?/g, "\n");
  try {
    boundedText(code);
    reader = new PyReader(code, budget, onTwin);
    // A grammar rejection selects the lexical reader. A partial AST is never
    // mistaken for a successfully parsed program, but collected effects survive.
    cut ||= reader.rejected || reader.cut;
    reader.run();
    if (!reader.rejected && !cut) return reader;
  } catch { cut = true; }
  const twins = reader?.twins ?? [], literals = reader?.literals ?? [];
  try { boundedText(code); pythonFallback(code, twins, literals, budget, onTwin); } catch { cut = true; }
  return { twins, literals, cut };
}
