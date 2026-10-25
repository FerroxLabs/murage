// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Learn about me: the paste parser. Pure code, no model and no I/O. The pasted
// text is untrusted: nothing in it is interpreted, headings only choose the
// group a line is shown in, and every line waits for the owner's Keep.
import { maskFinancialIdentifiers } from "../financial-ids.ts";

export type LamSection = "instructions" | "identity" | "career" | "projects" | "preferences" | "unsorted";
export type LamFlag = "tooLong" | "dateIgnored" | "duplicate" | "looksLikeAnInstruction" | "mentionsAnotherAssistant" | "maskedIdentifier";
export interface LamLine {
  /** 1-based position in the parsed list. */
  n: number;
  section: LamSection;
  /** ISO date with the precision given ("2025", "2025-03", "2025-03-10"), or null when undated. */
  date: string | null;
  text: string;
  flags: LamFlag[];
  /** For a `duplicate` line: the n of the first line with the same words. */
  duplicateOf?: number;
}
export type ParsedExport =
  | { ok: true; lines: LamLine[] }
  | { ok: false; reason: "tooLong" | "tooManyLines"; chars: number; lines: number };

export const LAM_MAX_CHARS = 100_000;
export const LAM_MAX_LINES = 400;
export const LAM_MAX_LINE = 1000;
export const LAM_PROVIDERS = ["chatgpt", "claude", "gemini", "grok", "copilot", "other"] as const;
export type LamProvider = (typeof LAM_PROVIDERS)[number];

const HEADINGS: Record<string, Exclude<LamSection, "unsorted">> = {
  INSTRUCTIONS: "instructions", "INSTRUCTIONS FOR YOU": "instructions",
  IDENTITY: "identity", "ABOUT ME": "identity", "WHO I AM": "identity",
  CAREER: "career", WORK: "career", JOB: "career",
  PROJECTS: "projects", "CURRENT PROJECTS": "projects",
  PREFERENCES: "preferences", "LIKES AND DISLIKES": "preferences", STYLE: "preferences",
};
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_WORD = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";
const SEPARATOR = "(?:\\s*[:\\-]\\s*|\\s+)";
const DATE_FORMS: Array<{ re: RegExp; read: (m: RegExpMatchArray) => { y: number; m?: number; d?: number } | null }> = [
  { re: new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})${SEPARATOR}`), read: m => ({ y: +m[1]!, m: +m[2]!, d: +m[3]! }) },
  { re: new RegExp(`^(\\d{4})-(\\d{2})${SEPARATOR}`), read: m => ({ y: +m[1]!, m: +m[2]! }) },
  { re: new RegExp(`^(\\d{1,2})\\s+${MONTH_WORD}\\.?,?\\s+(\\d{4})${SEPARATOR}`, "i"), read: m => ({ y: +m[3]!, m: monthOf(m[2]!), d: +m[1]! }) },
  { re: new RegExp(`^${MONTH_WORD}\\.?\\s+(\\d{4})${SEPARATOR}`, "i"), read: m => ({ y: +m[2]!, m: monthOf(m[1]!) }) },
  { re: new RegExp(`^(\\d{4})${SEPARATOR}`), read: m => ({ y: +m[1]! }) },
];
const UNDATED = new RegExp(`^undated${SEPARATOR}`, "i");
const INSTRUCTION_START = /^(please\s+)?(always|never|do not|don't|dont|from now on|ignore|you must|you should)\b/i;
const NAMES_THE_ASSISTANT = /\b(you|your|yours|yourself)\b/i;
// zero-width, bidi overrides and isolates, and C0/C1 controls except tab and newline
const INVISIBLE = /[​-‏⁠﻿‪-‮⁦-⁩\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const LIST_MARKER = /^(?:[-*+•·]\s+|\d{1,3}[.)]\s+)/;
const RULE_LINE = /^[\s|:=*_\-#>]*$/;

function monthOf(word: string): number {
  const lower = word.toLowerCase();
  return MONTHS.findIndex(name => name.startsWith(lower.slice(0, 3))) + 1;
}
const countChars = (text: string) => [...text].length;

/** The heading this line opens, or null. */
export function headingOf(line: string): Exclude<LamSection, "unsorted"> | null {
  const bare = line.replace(/[#*_:`"'|]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
  return bare.length <= 40 ? HEADINGS[bare] ?? null : null;
}

/** True when the line opens with a date form the parser reads, or the word "undated" (detect.ts counts these). */
export function opensWithDate(line: string): boolean {
  const text = line.replace(LIST_MARKER, "").trim();
  return UNDATED.test(text) || DATE_FORMS.some(form => form.re.test(text));
}

function readDate(text: string, today: Date): { date: string | null; rest: string; ignored: boolean } {
  const undated = text.match(UNDATED);
  if (undated) return { date: null, rest: text.slice(undated[0].length), ignored: false };
  for (const form of DATE_FORMS) {
    const match = text.match(form.re);
    if (!match) continue;
    const parts = form.read(match);
    const rest = text.slice(match[0].length);
    if (!parts || !rest.trim()) return { date: null, rest: text, ignored: false };
    const { y, m, d } = parts;
    const valid = (m === undefined || (m >= 1 && m <= 12)) && (d === undefined || (d >= 1 && d <= new Date(y, m!, 0).getDate()));
    const start = new Date(y, (m ?? 1) - 1, d ?? 1);
    if (!valid || y < 1970 || start.getTime() > today.getTime()) return { date: null, rest, ignored: true };
    const iso = `${String(y).padStart(4, "0")}${m ? `-${String(m).padStart(2, "0")}` : ""}${d ? `-${String(d).padStart(2, "0")}` : ""}`;
    return { date: iso, rest, ignored: false };
  }
  return { date: null, rest: text, ignored: false };
}

const sameWords = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?;,:]+$/, "").trim();

/** Turns a pasted export into review lines. Refuses the whole paste (with the counts) when it is too big; never truncates. */
export function parseExport(input: string, today: Date = new Date()): ParsedExport {
  const chars = countChars(input);
  const raw = input.replace(/\r\n?/g, "\n").split("\n");
  if (chars > LAM_MAX_CHARS) return { ok: false, reason: "tooLong", chars, lines: raw.length };
  const lines: LamLine[] = [];
  const firstOf = new Map<string, number>();
  let section: LamSection = "unsorted";
  for (const original of raw) {
    let line = original.replace(INVISIBLE, "").replace(/\t/g, " ").trim();
    if (!line || RULE_LINE.test(line)) continue;
    const heading = headingOf(line);
    if (heading) { section = heading; continue; }
    // a table row rendered as text: its cells joined by spaces
    if (line.startsWith("|")) line = line.replace(/^\|+|\|+$/g, "").split("|").map(cell => cell.trim()).filter(Boolean).join(" ");
    line = line.replace(LIST_MARKER, "").replace(/^(\*\*|__)(.+?)\1/, "$2").trim();
    if (!line) continue;
    const { date, rest, ignored } = readDate(line, today);
    // The owner reviews exactly what Keep stores: a bank, card, account or id number reads masked (the server masks again, idempotent).
    const typed = rest.trim(), text = maskFinancialIdentifiers(typed);
    if (!text) continue;
    const flags: LamFlag[] = [];
    if (text !== typed) flags.push("maskedIdentifier");
    if (text.length > LAM_MAX_LINE) flags.push("tooLong");
    if (ignored) flags.push("dateIgnored");
    if (section !== "instructions" && INSTRUCTION_START.test(text)) flags.push("looksLikeAnInstruction");
    if (NAMES_THE_ASSISTANT.test(text)) flags.push("mentionsAnotherAssistant");
    const n = lines.length + 1;
    const key = sameWords(text), first = firstOf.get(key);
    if (first !== undefined) flags.push("duplicate"); else firstOf.set(key, n);
    lines.push({ n, section, date, text, flags, ...(first !== undefined ? { duplicateOf: first } : {}) });
  }
  if (lines.length > LAM_MAX_LINES) return { ok: false, reason: "tooManyLines", chars, lines: lines.length };
  return { ok: true, lines };
}
