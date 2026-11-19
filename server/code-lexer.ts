// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import unicodeNames from "./python-unicode-names.json" with { type: "json" };

function unicodeByName(name: string): string | undefined {
  const key = name.toUpperCase();
  const names: Record<string, string> = unicodeNames.names;
  if (Object.hasOwn(names, key)) return names[key];
  const cjk = /^(CJK (?:UNIFIED|COMPATIBILITY) IDEOGRAPH)-([0-9A-F]{4,6})$/.exec(key);
  if (cjk) {
    const cp = Number.parseInt(cjk[2], 16);
    const ranges: Record<string, number[][]> = unicodeNames.ideographs;
    if (ranges[cjk[1]].some(([lo, hi]) => cp >= lo && cp <= hi)) return String.fromCodePoint(cp);
  }
  return undefined;
}

/** A lexical reader, never an interpreter. Offsets refer to the original, uncut source. */
export type CodeLanguage = "python" | "node";
export interface CodeToken {
  kind: "name" | "string" | "number" | "punct" | "newline";
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
  value?: string;
  template?: { parts: string[]; expressions: string[] };
}
export interface CodeLex { tokens: CodeToken[]; literals: string[]; unreadable: boolean }

/** Decode language string escapes without eval, JSON parsing, or host environment reads. */
export function decodeCodeString(raw: string, lang: CodeLanguage, verbatim = false, bytes = false): string | undefined {
  if (verbatim) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    let c = raw[i];
    if (c !== "\\") { out += c; continue; }
    c = raw[++i];
    if (c === undefined) return undefined;
    if (c === "\n") continue;
    if (c === "\r" && raw[i + 1] === "\n") { i++; continue; }
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"' };
    if (lang === "python") simple.a = "\x07";
    if (c in simple) { out += simple[c]; continue; }
    if (lang === "python" && !bytes && c === "N") {
      if (raw[i + 1] !== "{") return undefined;
      const end = raw.indexOf("}", i + 2);
      if (end < 0) return undefined;
      const value = unicodeByName(raw.slice(i + 2, end));
      if (value === undefined) return undefined;
      out += value; i = end; continue;
    }
    if (c === "x" || (!bytes && (c === "u" || (lang === "python" && c === "U")))) {
      const brace = lang === "node" && c === "u" && raw[i + 1] === "{";
      const count = c === "x" ? 2 : c === "u" ? 4 : 8;
      const end = brace ? raw.indexOf("}", i + 2) : i + count + 1;
      const hex = raw.slice(i + (brace ? 2 : 1), end);
      if (end < 0 || !/^[0-9a-f]+$/i.test(hex) || (!brace && hex.length !== count)) return undefined;
      const cp = Number.parseInt(hex, 16);
      if (cp > 0x10ffff) return undefined;
      out += String.fromCodePoint(cp); i = brace ? end : end - 1; continue;
    }
    if (/[0-7]/.test(c)) {
      let digits = c;
      while (digits.length < 3 && /[0-7]/.test(raw[i + 1] ?? "")) digits += raw[++i];
      out += String.fromCharCode(Number.parseInt(digits, 8) % (bytes ? 256 : 0x10000)); continue;
    }
    // Unknown Python escapes retain the backslash; JS identity escapes drop it.
    out += lang === "python" ? "\\" + c : c;
  }
  return out;
}

export function lexCode(lang: CodeLanguage, source: string): CodeLex {
  const tokens: CodeToken[] = [], literals: string[] = [];
  let i = 0, line = 0, lineStart = 0, unreadable = false;
  const advance = (end: number) => {
    while (i < end) { if (source[i] === "\n") { line++; lineStart = i + 1; } i++; }
  };
  while (i < source.length) {
    const start = i, tokenLine = line, column = i - lineStart, c = source[i];
    const emit = (kind: CodeToken["kind"], end: number, extra: Partial<CodeToken> = {}) => {
      tokens.push({ kind, text: source.slice(start, end), start, end, line: tokenLine, column, ...extra }); advance(end);
    };
    if (c === "\n") { emit("newline", i + 1); continue; }
    if (/\s/.test(c)) { if (lang === "python" && c !== " ") unreadable = true; advance(i + 1); continue; }
    if (c === "\\" && source[i + 1] === "\n") { advance(i + 2); continue; }
    if ((lang === "python" && c === "#") || (lang === "node" && source.startsWith("//", i))) {
      const end = source.indexOf("\n", i); advance(end < 0 ? source.length : end); continue;
    }
    if (lang === "node" && source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2); if (end < 0) unreadable = true;
      advance(end < 0 ? source.length : end + 2); continue;
    }
    const prefix = lang === "python" ? source.slice(i).match(/^(?:[rRuUbBfF]{1,2})(?=['"])/)?.[0] ?? "" : "";
    const qAt = i + prefix.length, q = source[qAt];
    if (q === "'" || q === '"' || (lang === "node" && q === "`")) {
      if (lang === "python" && !/^(?:r|u|b|f|br|rb|fr|rf)?$/i.test(prefix)) unreadable = true;
      const triple = lang === "python" && source.startsWith(q.repeat(3), qAt);
      const delimiter = triple ? q.repeat(3) : q;
      const templated = /f/i.test(prefix) || q === "`";
      const parts: string[] = [], expressions: string[] = [];
      let at = qAt + delimiter.length, chunk = at, closed = false;
      while (at < source.length) {
        if (source[at] === "\\") {
          // A named escape's braces belong to the escape, including inside an
          // f-string. Raw f-strings still treat these braces as interpolation.
          if (lang === "python" && !/[rb]/i.test(prefix) && source.startsWith("\\N{", at)) {
            const end = source.indexOf("}", at + 3);
            if (end < 0) { unreadable = true; at = source.length; break; }
            at = end + 1; continue;
          }
          at += 2; continue;
        }
        if (templated && lang === "python" && (source.startsWith("{{", at) || source.startsWith("}}", at))) { at += 2; continue; }
        const interpolation = templated && (lang === "python" ? source[at] === "{" : source.startsWith("${", at));
        if (interpolation) {
          parts.push(source.slice(chunk, at));
          const from = at + (lang === "python" ? 1 : 2);
          let nest = 1, cursor = from, quote = "";
          while (cursor < source.length && nest) {
            const ch = source[cursor];
            if (ch === "\\") { cursor += 2; continue; }
            if (quote) { if (ch === quote) quote = ""; }
            else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
            else if (ch === "{") nest++;
            else if (ch === "}") nest--;
            cursor++;
          }
          if (nest) { unreadable = true; at = source.length; break; }
          expressions.push(source.slice(from, cursor - 1)); at = cursor; chunk = at; continue;
        }
        if (lang === "python" && templated && source[at] === "}") unreadable = true;
        if (source.startsWith(delimiter, at)) { parts.push(source.slice(chunk, at)); at += delimiter.length; closed = true; break; }
        if (lang === "python" && !triple && source[at] === "\n") unreadable = true;
        at++;
      }
      if (!closed) { unreadable = true; emit("string", source.length); continue; }
      if (lang === "python" && /b/i.test(prefix) && parts.some(part => /[^\x00-\x7f]/.test(part))) unreadable = true;
      const decoded = parts.map(part => decodeCodeString(lang === "python" && templated ? part.replaceAll("{{", "{").replaceAll("}}", "}") : part, lang, /r/i.test(prefix), /b/i.test(prefix)));
      if (decoded.some(part => part === undefined)) { unreadable = true; emit("string", at); continue; }
      const values = decoded as string[];
      for (const value of values) literals.push(value);
      emit("string", at, expressions.length ? { template: { parts: values, expressions } } : { value: values[0] });
      continue;
    }
    const name = source.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (name) { if (lang === "python" && name.includes("$")) unreadable = true; emit("name", i + name.length); continue; }
    const number = source.slice(i).match(lang === "python"
      ? /^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:(?:[0-9](?:_?[0-9])*)?\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?)(?:[eE][+-]?[0-9](?:_?[0-9])*)?[jJ]?)/
      : /^\d+(?:\.\d+)?/)?.[0];
    if (number) { if (lang === "python" && /^0[0-9_]*[1-9][0-9_]*$/.test(number)) unreadable = true; emit("number", i + number.length); continue; }
    const op = ["===", "!==", "<<", ">>", "<=", ">=", "**=", "//=", "=>", "==", "!=", "+=", "-=", "*=", "/=", ":=", "++", "--", "&&", "||", "?.", "**", "//"].find(x => source.startsWith(x, i));
    if (lang === "python" && !op && !"()[]{}.,:;=+-*/%@&|^~<>".includes(c)) unreadable = true;
    emit("punct", i + (op?.length ?? 1));
  }
  return { tokens, literals, unreadable };
}
