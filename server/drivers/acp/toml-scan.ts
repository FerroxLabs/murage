// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A tolerant TOML statement scanner and a small value reader, shared by the Grok and Fuigo scoped homes
// (grok-scope.ts, fuigo-scope.ts). The scanner finds each table header and each key/value pair with its full
// extent; the value reader decodes the plain subset a permission table uses (strings, arrays, inline tables,
// booleans, integers). Anything outside that subset is reported as unreadable, never guessed at.

export interface TomlStatement {
  start: number;
  end: number;
  /** "header" is `[a.b]` or `[[a.b]]`; "pair" is `key = value`. */
  kind: "header" | "pair";
  /** The decoded key path: `"mcp_servers" . 'x'` is ["mcp_servers", "x"]. */
  path: string[];
  /** For a pair: where its value starts (just past `=`). */
  valueStart?: number;
  /** For a pair: where its value ends (before the newline; a trailing comment is inside). */
  valueEnd?: number;
}

export class TomlScanError extends Error {}

/** A tolerant TOML statement scanner: it finds each table header and each key/value pair (with the full extent of a value, even across lines), decoding quoted keys. It does not validate values. */
export function scanToml(text: string): TomlStatement[] {
  const out: TomlStatement[] = [];
  let i = 0;
  const n = text.length;
  const skipBlank = () => { while (i < n && (text[i] === " " || text[i] === "\t")) i++; };
  const endOfLine = () => { while (i < n && text[i] !== "\n") i++; if (i < n) i++; };
  const keyPart = (): string => {
    skipBlank();
    const c = text[i];
    if (c === '"') {
      let value = "";
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\n") throw new TomlScanError("newline in key");
        if (text[i] === "\\") {
          const e = text[i + 1];
          const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
          if (e && e in simple) { value += simple[e]; i += 2; continue; }
          const width = e === "u" ? 4 : e === "U" ? 8 : 0;
          const hex = width ? text.slice(i + 2, i + 2 + width) : "";
          if (!width || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new TomlScanError("bad escape in key");
          value += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + width;
          continue;
        }
        value += text[i++];
      }
      if (text[i] !== '"') throw new TomlScanError("unterminated key");
      i++;
      return value;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const nl = text.indexOf("\n", i + 1);
      if (close < 0 || (nl >= 0 && nl < close)) throw new TomlScanError("unterminated key");
      const value = text.slice(i + 1, close);
      i = close + 1;
      return value;
    }
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256));
    if (!m) throw new TomlScanError("bad key");
    i += m[0].length;
    return m[0];
  };
  const keyPath = (): string[] => {
    const path = [keyPart()];
    for (;;) {
      skipBlank();
      if (text[i] !== ".") return path;
      i++;
      path.push(keyPart());
    }
  };
  /** Past one value, inside any nesting and across lines. */
  const skipValue = () => {
    let depth = 0;
    while (i < n) {
      const c = text[i]!;
      if (c === '"' || c === "'") {
        const triple = c.repeat(3);
        if (text.startsWith(triple, i)) {
          const close = (() => {
            let at = i + 3;
            for (;;) {
              at = text.indexOf(triple, at);
              if (at < 0) return -1;
              if (c === '"' && text[at - 1] === "\\" && text[at - 2] !== "\\") { at++; continue; }
              let end = at + 3;
              while (text[end] === c) end++; // up to two extra quotes belong to the string
              return Math.min(end, at + 5);
            }
          })();
          if (close < 0) throw new TomlScanError("unterminated string");
          i = close;
          continue;
        }
        i++;
        while (i < n && text[i] !== c) {
          if (text[i] === "\n") throw new TomlScanError("newline in string");
          if (c === '"' && text[i] === "\\") i++;
          i++;
        }
        if (i >= n) throw new TomlScanError("unterminated string");
        i++;
        continue;
      }
      if (c === "[" || c === "{") { depth++; i++; continue; }
      if (c === "]" || c === "}") { depth--; i++; if (depth < 0) throw new TomlScanError("unbalanced"); continue; }
      if (c === "#") { while (i < n && text[i] !== "\n") i++; continue; }
      if (c === "\n") { if (depth === 0) return; i++; continue; }
      i++;
    }
    if (depth !== 0) throw new TomlScanError("unterminated value");
  };
  while (i < n) {
    const start = i;
    skipBlank();
    const c = text[i];
    if (i >= n) break;
    if (c === "\n" || c === "\r") { endOfLine(); continue; }
    if (c === "#") { endOfLine(); continue; }
    if (c === "[") {
      i++;
      const array = text[i] === "[";
      if (array) i++;
      const path = keyPath();
      skipBlank();
      if (text[i] !== "]") throw new TomlScanError("unterminated header");
      i++;
      if (array) { if (text[i] !== "]") throw new TomlScanError("unterminated header"); i++; }
      endOfLine();
      out.push({ start, end: i, kind: "header", path });
      continue;
    }
    const path = keyPath();
    skipBlank();
    if (text[i] !== "=") throw new TomlScanError("expected =");
    i++;
    const valueStart = i;
    skipValue();
    const valueEnd = i;
    endOfLine();
    out.push({ start, end: i, kind: "pair", path, valueStart, valueEnd });
  }
  return out;
}

/** The text without every table and key whose full decoded path `drop` names (a header's path for a table, the
 *  table path plus the key path for a pair), comments of a dropped table going with it. Everything else is kept byte
 *  for byte. A file the scanner cannot read gives "" (nothing of it may reach a bot turn). */
export function filterTomlPaths(text: string, drop: (path: string[]) => boolean): string {
  let statements: TomlStatement[];
  try { statements = scanToml(text); } catch { return ""; }
  let out = "";
  let at = 0;
  let table: string[] = [];
  let tableDropped = false;
  for (const [index, statement] of statements.entries()) {
    let personal: boolean;
    let inTable = true;
    if (statement.kind === "header") {
      table = statement.path;
      personal = tableDropped = drop(table);
    } else {
      inTable = table.length > 0;
      personal = (inTable && tableDropped) || drop([...table, ...statement.path]);
      if (personal && inTable && !tableDropped) inTable = false; // one key of a kept table: only that pair goes
    }
    if (!personal) continue;
    out += text.slice(at, statement.start);
    // A dropped table takes its comments and blank lines with it, up to the next statement.
    at = inTable ? (statements[index + 1]?.start ?? text.length) : statement.end;
  }
  return out + text.slice(at);
}


export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

/** One value from `text[start, end)`: the plain subset (basic and literal one-line strings, arrays across lines with
 *  comments and a trailing comma, inline tables, booleans, integers) and, as values, multi-line strings (A6). Throws
 *  TomlScanError on anything else (a float, a date): the caller treats that value as unreadable. */
export function readTomlValue(text: string, start: number, end: number = text.length): TomlValue {
  let i = start;
  const gap = (lines: boolean) => {
    for (;;) {
      while (i < end && (text[i] === " " || text[i] === "\t" || (lines && (text[i] === "\n" || text[i] === "\r")))) i++;
      if (lines && text[i] === "#") { while (i < end && text[i] !== "\n") i++; continue; }
      return;
    }
  };
  // One escape at i (a backslash): its decoded text, i moved past it.
  const escape = (): string => {
    const e = text[i + 1];
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (e && Object.hasOwn(simple, e)) { i += 2; return simple[e]!; }
    const width = e === "u" ? 4 : e === "U" ? 8 : 0;
    const hex = width ? text.slice(i + 2, i + 2 + width) : "";
    if (!width || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new TomlScanError("bad escape");
    const point = parseInt(hex, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new TomlScanError("bad escape");
    i += 2 + width;
    return String.fromCodePoint(point);
  };
  // A6: a multi-line string (`"""…"""` with escapes and line-ending backslashes, `'''…'''` raw), decoded as TOML 1.0 does: a
  // newline right after the opening quotes is trimmed, and up to two quotes just before the closing three belong to the text.
  const multiline = (quote: '"' | "'"): string => {
    const fence = quote.repeat(3);
    i += 3;
    if (text[i] === "\n") i++; else if (text[i] === "\r" && text[i + 1] === "\n") i += 2;
    let value = "";
    for (;;) {
      if (i >= end) throw new TomlScanError("unterminated string");
      if (text.startsWith(fence, i)) {
        let run = 3;
        while (run < 5 && text[i + run] === quote) run++;
        value += quote.repeat(run - 3);
        i += run;
        return value;
      }
      const c = text[i]!;
      if (quote === '"' && c === "\\") {
        let j = i + 1;
        while (j < end && (text[j] === " " || text[j] === "\t")) j++;
        if (text[j] === "\n" || (text[j] === "\r" && text[j + 1] === "\n")) {
          i = j;
          while (i < end && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
          continue;
        }
        value += escape();
        continue;
      }
      value += c;
      i++;
    }
  };
  const basic = (allowMultiline = false): string => {
    if (text.startsWith('"""', i)) { if (allowMultiline) return multiline('"'); throw new TomlScanError("multi-line string"); }
    let value = "";
    i++;
    while (i < end && text[i] !== '"') {
      const c = text[i]!;
      if (c === "\n") throw new TomlScanError("newline in string");
      if (c === "\\") { value += escape(); continue; }
      value += c;
      i++;
    }
    if (text[i] !== '"') throw new TomlScanError("unterminated string");
    i++;
    return value;
  };
  const literal = (allowMultiline = false): string => {
    if (text.startsWith("'''", i)) { if (allowMultiline) return multiline("'"); throw new TomlScanError("multi-line string"); }
    const close = text.indexOf("'", i + 1);
    const nl = text.indexOf("\n", i + 1);
    if (close < 0 || close >= end || (nl >= 0 && nl < close)) throw new TomlScanError("unterminated string");
    const value = text.slice(i + 1, close);
    i = close + 1;
    return value;
  };
  const key = (): string => {
    gap(false);
    if (text[i] === '"') return basic();
    if (text[i] === "'") return literal();
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, Math.min(end, i + 256)));
    if (!m) throw new TomlScanError("bad key");
    i += m[0].length;
    return m[0];
  };
  const value = (): TomlValue => {
    const c = text[i];
    if (c === '"') return basic(true);
    if (c === "'") return literal(true);
    if (c === "[") {
      i++;
      const out: TomlValue[] = [];
      for (;;) {
        gap(true);
        if (text[i] === "]") { i++; return out; }
        out.push(value());
        gap(true);
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return out; }
        throw new TomlScanError("bad array");
      }
    }
    if (c === "{") {
      i++;
      // A7: a null-prototype record and own-property checks only, so a key named `__proto__` (or `constructor`) is an
      // ordinary key and never reaches Object.prototype.
      const out = Object.create(null) as { [key: string]: TomlValue };
      gap(false);
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        const path = [key()];
        for (;;) { gap(false); if (text[i] !== ".") break; i++; path.push(key()); }
        gap(false);
        if (text[i] !== "=") throw new TomlScanError("expected =");
        i++;
        gap(false);
        let at = out;
        for (const part of path.slice(0, -1)) {
          const next = Object.hasOwn(at, part) ? at[part] : undefined;
          if (next === undefined) at = (at[part] = Object.create(null) as { [key: string]: TomlValue }) as { [key: string]: TomlValue };
          else if (typeof next === "object" && !Array.isArray(next)) at = next;
          else throw new TomlScanError("key defined twice");
        }
        const last = path[path.length - 1]!;
        if (Object.hasOwn(at, last)) throw new TomlScanError("key defined twice");
        at[last] = value();
        gap(false);
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return out; }
        throw new TomlScanError("bad inline table");
      }
    }
    const word = /^(true|false|[+-]?[0-9][0-9_]*)(?=[\s,\]}#]|$)/.exec(text.slice(i, end));
    if (!word) throw new TomlScanError("unsupported value");
    i += word[0].length;
    if (word[1] === "true" || word[1] === "false") return word[1] === "true";
    return Number(word[1]!.replaceAll("_", ""));
  };
  gap(false);
  const out = value();
  gap(false);
  if (i < end && text[i] === "#") i = end;
  gap(true);
  if (i < end) throw new TomlScanError("trailing text");
  return out;
}

/** Every table of `text` as decoded values, keyed by its dotted path joined with NUL: the pairs of each `[table]`,
 *  each `[[array.table]]` entry as one element of a list, and top-level pairs under "". Only for the subset
 *  readTomlValue reads; a pair outside it is listed in `unreadable` by its path. Throws TomlScanError when the
 *  scanner cannot read the file at all. */
export function readTomlTables(text: string): { tables: Map<string, Array<Record<string, TomlValue>>>; unreadable: string[] } {
  const tables = new Map<string, Array<Record<string, TomlValue>>>();
  const unreadable: string[] = [];
  let current: Record<string, TomlValue> = Object.create(null) as Record<string, TomlValue>; // A7: no prototype to reach
  tables.set("", [current]);
  let table: string[] = [];
  for (const statement of scanToml(text)) {
    if (statement.kind === "header") {
      table = statement.path;
      const id = table.join("\u0000");
      current = Object.create(null) as Record<string, TomlValue>;
      const list = tables.get(id);
      if (list) list.push(current); else tables.set(id, [current]);
      continue;
    }
    try { current[statement.path.join(".")] = readTomlValue(text, statement.valueStart!, statement.valueEnd!); }
    catch (error) { if (error instanceof TomlScanError) unreadable.push([...table, ...statement.path].join(".")); else throw error; }
  }
  return { tables, unreadable };
}
