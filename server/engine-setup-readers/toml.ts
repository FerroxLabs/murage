// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mcpServerTablesInToml } from "../drivers/codex-mcp-names.ts";
import { MAX_JSON_DEPTH, ReadRefused } from "../claude-code-import.ts";

type Value = string | boolean | typeof OTHER | Value[] | Table;
type Kind = "implicit" | "explicit" | "dotted" | "inline" | "array-item";
class Table extends Map<string, Value> {
  kind: Kind;
  constructor(kind: Kind) { super(); this.kind = kind; }
}
const OTHER = Symbol();
const ESCAPES = new Map([["b", "\b"], ["t", "\t"], ["n", "\n"], ["f", "\f"], ["r", "\r"], ['"', '"'], ["\\", "\\"]]);
const SCALAR = /^(?:[+-]?(?:inf|nan|(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)|0x[\da-fA-F](?:_?[\da-fA-F])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|\d{4}-\d\d-\d\d(?:(?:[Tt ]\d\d:\d\d:\d\d)(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)?)?|\d\d:\d\d:\d\d(?:\.\d+)?)$/;

const refuse = (): never => { throw new ReadRefused("refused"); };

/** Validate table and assignment ownership, which the driver's tolerant scan
 * deliberately does not enforce. Only single-line strings, booleans, string
 * arrays and string tables can become MCP fields. */
function readToml(text: string, check: () => void): Table {
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(source)) refuse();
  let at = 0;
  const root = new Table("explicit");
  let current = root;

  const take = (token: string) => {
    if (!source.startsWith(token, at)) return false;
    at += token.length;
    return true;
  };
  const requireToken = (token: string) => { if (!take(token)) refuse(); };
  const blanks = () => { while (source[at] === " " || source[at] === "\t") at++; };
  const comment = () => { if (take("#")) while (at < source.length && source[at] !== "\n") at++; };
  const gap = () => { do { blanks(); comment(); } while (take("\n")); };
  const bare = /[a-zA-Z0-9_-]+/y;
  const quoted = (quote: string, multiline: boolean): string => {
    if (multiline) take("\n");
    const chunks: string[] = [];
    let chunkStart = at;
    while (at < source.length) {
      const end = at;
      if (take(quote)) {
        if (multiline) {
          for (let extra = 0; extra < 2 && take(quote[0]!); extra++) continue;
        }
        chunks.push(source.slice(chunkStart, at - quote.length));
        return chunks.join("");
      }
      const c = source[at++]!;
      if (c === "\\" && quote[0] === '"') {
        chunks.push(source.slice(chunkStart, end));
        if (multiline && /^[ \t\n]/.test(source[at] ?? "")) {
          blanks();
          requireToken("\n");
          while (/^[ \t\n]/.test(source[at] ?? "")) at++;
        } else {
          const escape = source[at++];
          const simple = escape === undefined ? undefined : ESCAPES.get(escape);
          if (simple !== undefined) chunks.push(simple);
          else {
            const width = escape === "u" ? 4 : escape === "U" ? 8 : 0;
            const hex = source.slice(at, at + width);
            if (!width || hex.length !== width || !/^[\da-fA-F]+$/.test(hex)) refuse();
            const code = Number.parseInt(hex, 16);
            if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) refuse();
            chunks.push(String.fromCodePoint(code));
            at += width;
          }
        }
        chunkStart = at;
      } else if ((c < " " && c !== "\t" && !(multiline && c === "\n")) || c === "\x7f") refuse();
    }
    return refuse();
  };
  const key = () => {
    const parts: string[] = [];
    do {
      blanks();
      if (take('"')) parts.push(quoted('"', false));
      else if (take("'")) parts.push(quoted("'", false));
      else {
        bare.lastIndex = at;
        const part = bare.exec(source)?.[0] ?? refuse();
        parts.push(part);
        at += part.length;
      }
      if (parts.length > MAX_JSON_DEPTH) throw new ReadRefused("budget");
      blanks();
    } while (take("."));
    return parts;
  };
  const descend = (table: Table, part: string, header: boolean): Table => {
    const existing = table.get(part);
    if (existing === undefined) {
      const child = new Table(header ? "implicit" : "dotted");
      table.set(part, child);
      return child;
    }
    if (header && Array.isArray(existing)) {
      const last = existing.at(-1);
      if (last instanceof Table && last.kind === "array-item") return last;
    }
    if (existing instanceof Table && (header ? existing.kind !== "inline" : existing.kind === "dotted")) return existing;
    return refuse();
  };
  const pair = (table: Table, depth: number) => {
    const path = key();
    const name = path.pop()!;
    const parent = path.reduce((node, part) => descend(node, part, false), table);
    requireToken("=");
    blanks();
    if (parent.has(name)) refuse();
    parent.set(name, value(depth + 1));
  };
  const value = (depth: number): Value => {
    if (depth > MAX_JSON_DEPTH) throw new ReadRefused("budget");
    if (take('"""')) { quoted('"""', true); return OTHER; }
    if (take("'''")) { quoted("'''", true); return OTHER; }
    if (take('"')) return quoted('"', false);
    if (take("'")) return quoted("'", false);
    if (take("[")) {
      const items: Value[] = [];
      gap();
      while (!take("]")) {
        items.push(value(depth + 1));
        gap();
        if (take("]")) break;
        requireToken(",");
        gap();
      }
      return items;
    }
    if (take("{")) {
      const table = new Table("inline");
      blanks();
      if (!take("}")) {
        do { pair(table, depth); blanks(); } while (take(","));
        requireToken("}");
      }
      return table;
    }
    const start = at;
    while (at < source.length && !"\n,]}#".includes(source[at]!)) at++;
    const literal = source.slice(start, at).trim();
    if (literal === "true" || literal === "false") return literal === "true";
    if (SCALAR.test(literal)) return OTHER;
    return refuse();
  };

  gap();
  while (at < source.length) {
    check();
    if (take("[")) {
      const array = take("[");
      const path = key();
      const name = path.pop()!;
      requireToken(array ? "]]" : "]");
      const parent = path.reduce((node, part) => descend(node, part, true), root);
      const existing = parent.get(name);
      if (array) {
        current = new Table("array-item");
        if (existing === undefined) parent.set(name, [current]);
        else if (Array.isArray(existing) && existing[0] instanceof Table && existing[0].kind === "array-item") existing.push(current);
        else refuse();
      } else {
        if (existing !== undefined && (!(existing instanceof Table) || existing.kind !== "implicit")) refuse();
        current = existing instanceof Table ? existing : new Table("explicit");
        current.kind = "explicit";
        parent.set(name, current);
      }
    } else pair(current, 0);
    blanks();
    comment();
    if (at < source.length) requireToken("\n");
    gap();
  }
  return root;
}

export function readTomlServers(text: string, check: () => void): Map<string, Record<string, unknown> | null> {
  const root = readToml(text, check);
  const servers = root.get("mcp_servers");
  if (servers !== undefined && !(servers instanceof Table)) return refuse();
  const tables = mcpServerTablesInToml(text);
  check();
  if (tables.size !== (servers?.size ?? 0)) return refuse();
  return new Map([...tables.keys()].map(name => {
    const table = servers?.get(name);
    if (!(table instanceof Table)) return [name, null];
    const fields = Object.fromEntries([...table].map(([key, item]) => [key, item instanceof Table ? Object.fromEntries(item) : item]));
    return [name, fields];
  }));
}
