// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Literal-for-literal port of judge.py's lexical JsReader (not a JS evaluator).
import { boundedText, ReaderBudget } from "./no-limits-budget.ts";
import { joinPath, quoteTarget, type Twin } from "./no-limits-shell.ts";
type Token = [string, string];
type Slice = [number, number];
class Unresolved extends Error {}
function unescape(body: string): string {
  try { return JSON.parse('"' + body.replaceAll('"', '\\"').replaceAll("\\'", "'") + '"') as string; } catch (error) { if (!(error instanceof SyntaxError)) throw error; return body; }
}
function tokens(code: string, budget: ReaderBudget): Token[] {
  const out: Token[] = [];
  const rx = /(?<ws>\s+|\/\/[^\n]*|\/\*.*?\*\/)|(?<str>'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(?<tpl>`(?:\\.|[^`\\])*`)|(?<id>[A-Za-z_$][A-Za-z0-9_$]*)|(?<num>\d+(?:\.\d+)?)|(?<p>=>|\.\.\.|[{}()[\];,.:=+?!<>|&*/%-])/sy;
  for (let i = 0; i < code.length;) {
    budget.tick();
    rx.lastIndex = i; const m = rx.exec(code);
    if (!m) { out.push(["p", code[i++]]); continue; }
    i = rx.lastIndex;
    const k = Object.keys(m.groups!).find(k => m.groups![k] !== undefined)!, v = m[0];
    if (k === "ws") continue;
    if (k === "str") out.push(["str", unescape(v.slice(1, -1))]);
    else if (k === "tpl") { const body = v.slice(1, -1); out.push(body.includes("${") ? ["tpl", body] : ["str", unescape(body)]); }
    else out.push([k, v]);
  }
  return out;
}
const is = (t: Token | undefined, k: string, v: string) => t?.[0] === k && t[1] === v;
const opens = ["(", "[", "{"], closes = [")", "]", "}"];
export class JsReader {
  t: Token[] = [];
  alias = new Map<string, string>();
  assign = new Map<string, Slice>();
  count = new Map<string, number>();
  unresolvedN = 0;
  twins: Twin[] = [];
  literals: string[] = [];
  cut = false;
  budget: ReaderBudget;
  onTwin?: (twin: Twin) => void;
  constructor(code: string, budget = new ReaderBudget(), onTwin?: (twin: Twin) => void) {
    this.budget = budget; this.onTwin = onTwin;
    try {
      boundedText(code);
      this.t = tokens(code, budget);
      this.literals = this.t.filter(t => t[0] === "str").map(t => t[1]);
      this.bindings();
    } catch { this.cut = true; }
  }
  emit(twin: Twin): void { this.twins.push(twin); this.onTwin?.(twin); }
  fresh(): string { return "$MURAGE_U" + ++this.unresolvedN; }
  bump(name: string, n = 1): void { this.count.set(name, (this.count.get(name) ?? 0) + n); }
  moduleOf(i: number): [string | undefined, number] {
    const t = this.t;
    return is(t[i], "id", "require") && is(t[i + 1], "p", "(") && t[i + 2]?.[0] === "str" && is(t[i + 3], "p", ")") ? [t[i + 2][1], i + 4] : [undefined, i];
  }
  kind(mod: string | undefined): string | undefined {
    if (["fs", "node:fs", "fs/promises", "node:fs/promises", "fs-extra", "graceful-fs"].includes(mod ?? "")) return "fs";
    if (["child_process", "node:child_process"].includes(mod ?? "")) return "cp";
    if (["os", "node:os"].includes(mod ?? "")) return "os";
    if (["path", "node:path"].includes(mod ?? "")) return "path";
    if (mod === "rimraf") return "rimraf";
    if (["vm", "node:vm"].includes(mod ?? "")) return "vm";
    return undefined;
  }
  endOfExpr(i: number): number {
    let depth = 0;
    for (; i < this.t.length; i++) {
      this.budget.tick();
      const v = this.t[i][1];
      if (opens.includes(v)) depth++;
      else if (closes.includes(v)) { if (!depth) return i; depth--; }
      else if (!depth && [";", ","].includes(v)) return i;
    }
    return i;
  }
  bindings(): void {
    const t = this.t, n = t.length;
    for (let i = 0; i < n; i++) {
      this.budget.tick();
      const [k, v] = t[i];
      if (k === "id" && v === "import") {
        let j = i + 1; const names: [string, string | undefined][] = [];
        if (is(t[j], "p", "*") && is(t[j + 1], "id", "as") && t[j + 2]) { names.push([t[j + 2][1], undefined]); j += 3; }
        else if (t[j]?.[0] === "id" && t[j][1] !== "from") { names.push([t[j++][1], undefined]); if (is(t[j], "p", ",")) j++; }
        if (is(t[j], "p", "{")) {
          j++;
          while (j < n && !is(t[j], "p", "}")) {
            this.budget.tick();
            if (t[j][0] === "id") {
              const src = t[j][1]; let loc = src;
              if (is(t[j + 1], "id", "as") && t[j + 2]) { loc = t[j + 2][1]; j += 2; }
              names.push([loc, src]);
            }
            j++;
          }
          j++;
        }
        if (is(t[j], "id", "from") && t[j + 1]?.[0] === "str") {
          const kind = this.kind(t[j + 1][1]);
          if (kind) for (const [loc, src] of names) { this.budget.tick(); this.alias.set(loc, kind + (src ? "." + src : "")); this.bump(loc); }
        }
      }
      if (k === "id" && ["const", "let", "var"].includes(v)) {
        let j = i + 1;
        if (is(t[j], "p", "{")) {
          j++; const pairs: [string, string][] = [];
          while (j < n && !is(t[j], "p", "}")) {
            this.budget.tick();
            if (t[j][0] === "id") {
              const src = t[j][1]; let loc = src;
              if (is(t[j + 1], "p", ":") && t[j + 2]?.[0] === "id") { loc = t[j + 2][1]; j += 2; }
              pairs.push([loc, src]);
            }
            j++;
          }
          j++;
          if (is(t[j], "p", "=")) {
            const [mod] = this.moduleOf(j + 1), kind = this.kind(mod);
            for (const [loc, src] of pairs) { this.budget.tick(); this.bump(loc); if (kind) this.alias.set(loc, kind + "." + src); }
          }
          continue;
        }
        while (j < n && t[j][0] === "id") {
          this.budget.tick();
          const name = t[j][1]; this.bump(name);
          if (is(t[j + 1], "p", "=")) {
            const [mod, after] = this.moduleOf(j + 2), kind = this.kind(mod), end = this.endOfExpr(j + 2);
            if (kind) {
              const chain: string[] = []; let q = after;
              while (is(t[q], "p", ".") && t[q + 1]?.[0] === "id") { this.budget.tick(); if (t[q + 1][1] !== "promises") chain.push(t[q + 1][1]); q += 2; }
              this.alias.set(name, kind + (chain.length ? "." + chain[0] : ""));
            } else this.assign.set(name, [j + 2, end]);
            j = end;
          } else j++;
          if (is(t[j], "p", ",")) j++; else break;
        }
      }
      if (k === "id" && is(t[i + 1], "p", "=") && (!i || !["const", "let", "var", ".", ",", "{"].includes(t[i - 1][1]))) this.bump(v);
      if (k === "id" && ["+", "-"].includes(t[i + 1]?.[1]) && is(t[i + 2], "p", "=")) this.bump(v, 2);
    }
  }
  callee(i: number): [string | undefined, number] {
    const t = this.t; const [mod, after] = this.moduleOf(i); let base: string | undefined, j = after;
    if (mod) { base = this.kind(mod); if (!base) return [undefined, i]; }
    else if (t[i]?.[0] === "id" && this.alias.has(t[i][1])) { base = this.alias.get(t[i][1]); j = i + 1; }
    else if (t[i]?.[0] === "id" && ["eval", "Function", "process"].includes(t[i][1])) { base = t[i][1]; j = i + 1; }
    else return [undefined, i];
    const chain = base!.split(".");
    while (j < t.length) {
      this.budget.tick();
      if (is(t[j], "p", ".") && t[j + 1]?.[0] === "id") { chain.push(t[j + 1][1]); j += 2; }
      else if (is(t[j], "p", "[") && t[j + 1] && is(t[j + 2], "p", "]")) { chain.push(t[j + 1][0] === "str" ? t[j + 1][1] : "<dynamic>"); j += 3; }
      else break;
    }
    return is(t[j], "p", "(") ? [chain.filter(c => c !== "promises").join("."), j] : [undefined, i];
  }
  args(lp: number): Slice[] {
    const out: Slice[] = []; let depth = 0, start = lp + 1;
    for (let j = start; j < this.t.length; j++) {
      this.budget.tick();
      const v = this.t[j][1];
      if (opens.includes(v)) depth++;
      else if (closes.includes(v)) { if (!depth) { if (j > start) out.push([start, j]); return out; } depth--; }
      else if (v === "," && !depth) { out.push([start, j]); start = j + 1; }
    }
    return out;
  }
  resolve(s: number, e: number, depth = 0): string {
    this.budget.tick();
    const t = this.t.slice(s, e); if (!t.length) throw new Unresolved();
    const parts: Token[][] = []; let cur: Token[] = [], d = 0;
    for (const tok of t) {
      this.budget.tick();
      const v = tok[1]; if (opens.includes(v)) d++; else if (closes.includes(v)) d--;
      if (v === "+" && !d) { parts.push(cur); cur = []; } else cur.push(tok);
    }
    parts.push(cur);
    return parts.map(p => { this.budget.tick(); return this.atom(p, depth); }).join("");
  }
  atom(t: Token[], depth: number): string {
    if (t.length === 1 && ["str", "num"].includes(t[0][0])) return t[0][1];
    if (t.length === 1 && t[0][0] === "id") {
      const name = t[0][1], sl = this.assign.get(name);
      if (depth >= 1 || this.count.get(name) !== 1 || !sl) throw new Unresolved();
      return this.resolve(...sl, depth + 1);
    }
    if (t.map(x => x[1]).join("\0") === ["process", ".", "env", ".", "HOME"].join("\0")) return "$HOME";
    if (t.length >= 2 && is(t.at(-1), "p", ")")) {
      const sub = new JsReader("", this.budget); sub.t = t; sub.alias = this.alias;
      const [dotted, lp] = sub.callee(0);
      if (dotted === "os.homedir") return "~";
      if (["path.join", "path.resolve", "path.posix.join"].includes(dotted ?? "")) return joinPath(sub.args(lp).map(([a, b]) => {
        const saved = this.t; try { this.t = t; return this.resolve(a, b, depth); } finally { this.t = saved; }
      }));
    }
    throw new Unresolved();
  }
  arg(sl: Slice): string { try { return this.resolve(...sl); } catch (e) { if (!(e instanceof Unresolved)) throw e; return this.fresh(); } }
  argv([s, e]: Slice): string[] {
    const t = this.t.slice(s, e);
    if (is(t[0], "p", "[") && is(t.at(-1), "p", "]")) {
      const items: Slice[] = []; let d = 0, st = 1;
      for (let j = 1; j < t.length - 1; j++) { this.budget.tick(); const v = t[j][1]; if (opens.includes(v)) d++; else if (closes.includes(v)) d--; else if (v === "," && !d) { items.push([s + st, s + j]); st = j + 1; } }
      if (t.length - 1 > st) items.push([s + st, s + t.length - 1]);
      return items.map(x => this.arg(x));
    }
    return [this.fresh()];
  }
  hasTrue([s, e]: Slice, key: string): boolean {
    for (let j = s; j < e - 2; j++) {
      this.budget.tick();
      if (this.t[j][1] === key && this.t[j + 1][1] === ":" && this.t[j + 2][1] === "true") return true;
    }
    return false;
  }
  run(): this {
    const q = quoteTarget;
    for (let i = 0; i < this.t.length; i++) {
      this.budget.tick();
      if (is(this.t[i - 1], "p", ".")) continue;
      const [dotted, lp] = this.callee(i); if (!dotted) continue;
      const a = this.args(lp), parts = dotted.split("."), kind = parts[0], name = parts.at(-1)!;
      const sh = (s: string, why = dotted) => this.emit(["sh", s, why]);
      if (kind === "fs") {
        const rec = a.length > 1 && this.hasTrue(a[1], "recursive");
        if (name === "<dynamic>") sh('rm -rf -- "' + this.fresh() + '"', "unresolved fs callee");
        else if (["rmSync", "rm", "rmdirSync", "rmdir", "remove", "removeSync", "emptyDirSync", "emptyDir"].includes(name) && a.length) {
          const t = this.arg(a[0]);
          sh((["remove", "removeSync", "emptyDirSync", "emptyDir"].includes(name) || rec ? "rm -rf" : name.startsWith("rmdir") ? "rmdir" : "rm -f") + " -- " + q(t));
        } else if (["unlinkSync", "unlink"].includes(name) && a.length) sh("rm -f -- " + q(this.arg(a[0])));
        else if (["truncateSync", "truncate"].includes(name) && a.length) { const size = a.length > 1 ? this.arg(a[1]) : "0"; sh("truncate -s " + q(size) + " -- " + q(this.arg(a[0]))); }
      } else if (kind === "rimraf" && a.length) sh("rm -rf -- " + q(this.arg(a[0])));
      else if (kind === "cp" && a.length) {
        if (["exec", "execSync"].includes(name)) { const v = this.arg(a[0]); sh(v.startsWith("$MURAGE_U") ? '"' + v + '"' : v); }
        else if (["spawn", "spawnSync", "execFile", "execFileSync", "fork"].includes(name)) {
          const prog = this.arg(a[0]), rest = a.length > 1 ? this.argv(a[1]) : [], shell = a.slice(1).some(x => this.hasTrue(x, "shell")), words = [prog, ...rest];
          sh((shell ? words : words.map(q)).join(" "));
        }
      } else if (["eval", "Function"].includes(kind) && a.length) {
        try { this.emit(["js", this.resolve(...a.at(-1)!), dotted]); } catch (e) { if (!(e instanceof Unresolved)) throw e; }
      } else if (kind === "vm" && name.startsWith("run") && a.length) {
        try { this.emit(["js", this.resolve(...a[0]), dotted]); } catch (e) { if (!(e instanceof Unresolved)) throw e; }
      }
    }
    return this;
  }
}

export function readJavascript(code: string, budget = new ReaderBudget(), onTwin?: (twin: Twin) => void): JsReader {
  const reader = new JsReader(code, budget, onTwin);
  try { if (!reader.cut) reader.run(); } catch { reader.cut = true; }
  return reader;
}
