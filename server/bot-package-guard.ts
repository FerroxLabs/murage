// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Import guard: an imported bot or team goes through the same Skill Guard as a
// skill. Every text a model may read is checked, not only SKILL.md bodies: each
// string in the manifest (names, listing text, personas, instructions, routine
// prompts, memory seeds, examples), the names of fields, related fields read
// together, and every bundled file. Text is also read again with hidden
// characters and look-alike letters cleaned up, with its line breaks folded,
// and with every encoded blob (base64, base32, hex, percent, escape or number
// codes, gzip, UTF-16, ROT13, reversed text) decoded, so a command hidden in a
// listing line is found like one in plain view. A limit that is reached stops
// the import rather than letting the rest through. A warning system, not a
// guarantee.
import { gunzipSync } from "node:zlib";
import { scanBotPackageContents, redactSecrets, type BotPackageFinding, type BotPackageScanFile, type BotPackageScanResult } from "./bot-package-scan.ts";
import { MAX_BOT_PACKAGE_ENTRIES } from "./bot-package-manifest.ts";
import { evidence as clip, paddingEvidence } from "./skill-guard/rules.ts";
import { plainMessage } from "./skill-guard/messages.ts";
import { findingBlocks, scanSkill } from "./skill-guard/scan.ts";
import type { SkillFinding, SkillScanFile } from "./skill-guard/types.ts";

const MAX_FINDINGS = 1000;
const MAX_FIELDS = 60_000;
const MAX_DECODED_VIEWS = 400;
const MAX_VARIANTS_PER_TEXT = 40;
const MAX_DECODE_DEPTH = 3;
const MIN_SCANNED_LENGTH = 8;
const COMBINED_MAX = 50_000;
/** Characters of extra ROT13 and reversed views across the whole package. */
const BULK_VIEW_BUDGET = 4_000_000;
const BULK_VIEW_MAX_TEXT = 200_000;

interface TextUnit { path: string; field?: string; text: string; together?: boolean }

// ── Which strings the package holds ─────────────────────────────────────────

interface Walk { fields: number; truncated: boolean }

function* walkStrings(value: unknown, field: string, walk: Walk, depth = 0): Generator<{ field: string; text: string }> {
  if (depth > 40) { walk.truncated = true; return; }
  const take = () => (++walk.fields <= MAX_FIELDS ? true : (walk.truncated = true, false));
  if (typeof value === "string") { if (take()) yield { field, text: value }; return; }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      yield* walkStrings(value[index], `${field}[${index}]`, walk, depth + 1);
      if (walk.truncated) return;
    }
    const strings = value.filter((item): item is string => typeof item === "string");
    // Items of a list are read together, as a model reads them.
    if (strings.length >= 2 && take()) yield { field: `${field} (items together)`, text: strings.join(" ").slice(0, COMBINED_MAX) };
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [name, child] of entries) {
      // A field's own name is text a model can read as well.
      if (take()) yield { field: `${field}${field ? "." : ""}${name} (field name)`, text: name };
      yield* walkStrings(child, field ? `${field}.${name}` : name, walk, depth + 1);
      if (walk.truncated) return;
    }
    // The words of one record are read together: a phrase may be split
    // across a name, a title and a description.
    const strings = entries.map(([, child]) => child).filter((child): child is string => typeof child === "string");
    if (strings.length >= 2 && take()) yield { field: `${field || "(top level)"} (fields together)`, text: strings.join(" ").slice(0, COMBINED_MAX) };
  }
}

function toText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(content);
}

function textUnits(files: readonly BotPackageScanFile[]): { units: TextUnit[]; truncated: boolean } {
  const units: TextUnit[] = [];
  const walk: Walk = { fields: 0, truncated: false };
  for (const file of files) {
    const text = toText(file.content);
    if (file.path === "manifest.json") {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { units.push({ path: file.path, text }); continue; }
      for (const { field, text: value } of walkStrings(parsed, "", walk)) units.push({ path: file.path, field: field.replace(/^definition\./, ""), text: value, ...(/ \((?:fields|items) together\)$/.test(field) ? { together: true } : {}) });
    } else units.push({ path: file.path, text });
  }
  return { units, truncated: walk.truncated };
}

// ── Hidden characters and look-alike letters ────────────────────────────────

// Letters from other alphabets that read as a Latin letter.
const CONFUSABLE_PAIRS = [
  "А", "A", "В", "B", "Е", "E", "К", "K", "М", "M", "Н", "H", "О", "O", "Р", "P", "С", "C", "Т", "T", "Х", "X", "У", "Y", "І", "I", "Ј", "J", "Ѕ", "S", "Ӏ", "I",
  "а", "a", "е", "e", "о", "o", "р", "p", "с", "c", "х", "x", "у", "y", "і", "i", "ј", "j", "ѕ", "s", "һ", "h", "ԁ", "d", "ԛ", "q", "ԝ", "w", "ѵ", "v", "ӏ", "l",
  "Α", "A", "Β", "B", "Ε", "E", "Ζ", "Z", "Η", "H", "Ι", "I", "Κ", "K", "Μ", "M", "Ν", "N", "Ο", "O", "Ρ", "P", "Τ", "T", "Υ", "Y", "Χ", "X",
  "α", "a", "ε", "e", "ι", "i", "κ", "k", "ν", "v", "ο", "o", "ρ", "p", "τ", "t", "υ", "u", "χ", "x", "γ", "y",
  "ı", "i", "ɑ", "a", "ɡ", "g", "ɩ", "i", "ɴ", "n", "ʀ", "r", "ᴀ", "a", "ᴄ", "c", "ᴅ", "d", "ᴇ", "e", "ɢ", "g", "ʜ", "h", "ɪ", "i", "ᴊ", "j", "ᴋ", "k", "ʟ", "l", "ᴍ", "m", "ᴏ", "o", "ᴘ", "p", "ꜱ", "s", "ᴛ", "t", "ᴜ", "u", "ᴠ", "v", "ᴡ", "w", "ᴢ", "z",
  "ս", "u", "օ", "o", "ո", "n", "ց", "g", "հ", "h", "ԍ", "g", "ꓲ", "l", "ꓚ", "C", "ꓜ", "Z",
];
const CONFUSABLE = new Map<string, string>();
for (let index = 0; index < CONFUSABLE_PAIRS.length; index += 2) CONFUSABLE.set(CONFUSABLE_PAIRS[index]!, CONFUSABLE_PAIRS[index + 1]!);
const MIXABLE = /[\u0131\u0250-\u02af\u0370-\u03ff\u0400-\u052f\u0530-\u058f\ua4d0-\ua4ff]/u;

const INVISIBLE_RE = /[\u0080-\u0084\u0086-\u009f\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u08e2\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/u;
const EMOJI = /\p{Extended_Pictographic}/u;

/** The text as a person would read it: hidden characters gone (invisible tag
 * characters turned back into the letters they spell), look-alike and
 * full-width letters turned into plain ones, accents dropped. `gap` stands in
 * for what was removed, for a second reading where hidden characters or
 * marks were doing the work of spaces. */
export function cleanedText(text: string, gap = ""): string {
  let out = text.replace(/[\u2028\u2029]/g, "\n");
  // Invisible tag characters spell ASCII; a run of them is a message of its own.
  out = out.replace(/[\u{e0000}-\u{e007f}]+/gu, (run) => ` ${[...run].map((ch) => { const cp = ch.codePointAt(0)! - 0xe0000; return cp >= 0x20 && cp < 0x7f ? String.fromCharCode(cp) : ""; }).join("")} `);
  out = out.replace(INVISIBLE_RE, gap);
  out = out.normalize("NFKC");
  out = [...out].map((ch) => CONFUSABLE.get(ch) ?? ch).join("");
  return out.normalize("NFD").replace(/\p{M}+/gu, gap).normalize("NFC");
}

const codePointName = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
function describeChar(cp: number): string {
  if (cp >= 0xe0000 && cp <= 0xe007f) return "invisible tag character";
  if (cp >= 0xe0100 && cp <= 0xe01ef || cp >= 0xfe00 && cp <= 0xfe0f || cp >= 0x180b && cp <= 0x180f) return "invisible selector";
  if (cp === 0x200b) return "zero-width space";
  if (cp === 0x200c || cp === 0x200d) return "zero-width joiner";
  if (cp === 0x2060 || (cp >= 0x2061 && cp <= 0x2064)) return "invisible word joiner";
  if (cp === 0xfeff) return "zero-width no-break space";
  if (cp === 0x00ad) return "soft hyphen";
  if (cp === 0x200e || cp === 0x200f || cp === 0x061c) return "invisible direction mark";
  if (cp >= 0x202a && cp <= 0x202e || cp >= 0x2066 && cp <= 0x2069) return "text direction override";
  if (cp >= 0x80 && cp <= 0x9f) return "control character";
  return "hidden character";
}

interface Hit { rule: string; category: string; severity: SkillFinding["severity"]; confidence: number; index: number; evidence: string }

/** Hidden-character and look-alike checks that need a position, so the
 * finding can say where and what. Mirrors Skill Guard's M1 and M2 (zero-width
 * medium, direction override high) and adds tag characters, invisible runs
 * and mixed-alphabet words. Runs on every string, however short. */
function unicodeHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const context = (index: number, length: number, label: string) =>
    clip(`${text.slice(Math.max(0, index - 18), index).replace(/\s+/g, " ")}[${label}]${text.slice(index + length, index + length + 18).replace(/\s+/g, " ")}`);
  // Runs of invisible characters carry a message (zero-width binary, tag text).
  let runStart = -1, runEnd = -1;
  const flushRun = () => {
    if (runStart < 0) return;
    const length = runEnd - runStart;
    if (length >= 4 && !seen.has("run")) {
      seen.add("run");
      hits.push({ rule: "G-HID-RUN", category: "tag-characters", severity: "high", confidence: 0.95, index: runStart, evidence: context(runStart, length, `${length} hidden characters in a row`) });
    }
    runStart = -1;
  };
  for (const match of text.matchAll(INVISIBLE_RE)) {
    const index = match.index ?? 0;
    const cp = match[0].codePointAt(0)!;
    if (runStart >= 0 && index === runEnd) runEnd = index + match[0].length; else { flushRun(); runStart = index; runEnd = index + match[0].length; }
    // A joiner or selector inside an emoji sequence is ordinary.
    if ((cp === 0x200d || cp === 0xfe0f) && (EMOJI.test(text.slice(Math.max(0, index - 2), index)) || EMOJI.test(text.slice(index + 1, index + 3)))) continue;
    if (cp === 0xfeff && index === 0) continue;
    if (BIDI_RE.test(match[0])) {
      if (!seen.has("bidi")) { seen.add("bidi"); hits.push({ rule: "M2", category: "direction-override", severity: "high", confidence: 0.9, index, evidence: context(index, match[0].length, `${describeChar(cp)} ${codePointName(cp)}`) }); }
      continue;
    }
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      if (!seen.has("tag")) { seen.add("tag"); hits.push({ rule: "G-TAG", category: "tag-characters", severity: "high", confidence: 0.95, index, evidence: context(index, match[0].length, `${describeChar(cp)} ${codePointName(cp)}`) }); }
      continue;
    }
    if (!seen.has("hid")) {
      seen.add("hid");
      hits.push({ rule: "M1", category: "hidden-text", severity: "medium", confidence: 0.8, index, evidence: context(index, match[0].length, `${describeChar(cp)} ${codePointName(cp)}`) });
    }
  }
  flushRun();
  // A word that mixes plain letters with look-alikes from another alphabet.
  for (const word of text.matchAll(/[\p{L}\p{M}]{3,60}/gu)) {
    const token = word[0];
    if (!/[A-Za-z]/.test(token) || !MIXABLE.test(token)) continue;
    const lookalike = [...token].find((ch) => CONFUSABLE.has(ch) && MIXABLE.test(ch));
    if (!lookalike) continue;
    if (!seen.has("homoglyph")) {
      seen.add("homoglyph");
      hits.push({ rule: "G-HOMOGLYPH", category: "homoglyph", severity: "medium", confidence: 0.8, index: word.index ?? 0, evidence: clip(`"${token}" has the look-alike letter "${lookalike}" (${codePointName(lookalike.codePointAt(0)!)})`) });
    }
  }
  return hits;
}

// ── Encoded blobs ───────────────────────────────────────────────────────────

interface Variant { encoding: string; text: string; source: string }

function readableText(text: string): string | null {
  let readable = 0, letters = 0, total = 0;
  for (const ch of text) {
    total++;
    if (/[\p{L}\p{N}\p{P}\p{S}\s]/u.test(ch)) readable++;
    if (/[\p{L}\s]/u.test(ch)) letters++;
  }
  return total > 0 && readable / total >= 0.93 && letters / total >= 0.5 ? text : null;
}

/** Bytes that read as text: plain UTF-8, UTF-16 (with or without a mark) or
 * a gzip of either. Anything else is not text. */
function bytesToText(bytes: Uint8Array, unzipped = false): string | null {
  if (bytes.length < 8) return null;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (unzipped) return null;
    try { return bytesToText(gunzipSync(bytes, { maxOutputLength: 1_000_000 }), true); } catch { return null; }
  }
  let zeros = 0, evenZeros = 0;
  for (let index = 0; index < Math.min(bytes.length, 400); index++) if (bytes[index] === 0) { zeros++; if (index % 2 === 0) evenZeros++; }
  const sample = Math.min(bytes.length, 400);
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff) || zeros / sample > 0.3;
  try {
    if (utf16) {
      const bigEndian = (bytes[0] === 0xfe && bytes[1] === 0xff) || evenZeros > zeros / 2;
      return readableText(new TextDecoder(bigEndian ? "utf-16be" : "utf-16le", { fatal: true }).decode(bytes).replace(/^\ufeff/, ""));
    }
    return readableText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return null; }
}

const fromBase64 = (value: string): Uint8Array | null => {
  const cleaned = value.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (cleaned.length < 16 || cleaned.length % 4 === 1) return null;
  return Buffer.from(cleaned, "base64");
};
const fromBase32 = (value: string): Uint8Array | null => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = value.replace(/=+$/, "");
  let bits = 0, acc = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    acc = (acc << 5) | alphabet.indexOf(ch); bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1; }
  }
  return out.length >= 12 ? Uint8Array.from(out) : null;
};
const fromHex = (value: string): Uint8Array | null => {
  const cleaned = value.replace(/0x|[\s:,]/gi, "");
  return cleaned.length >= 16 && cleaned.length % 2 === 0 && /^[0-9a-f]+$/i.test(cleaned) ? Buffer.from(cleaned, "hex") : null;
};
const rotate = (text: string, shift: number) => text.replace(/[a-z]/gi, (ch) => { const base = ch <= "Z" ? 65 : 97; return String.fromCharCode((ch.charCodeAt(0) - base + shift) % 26 + base); });
const cueLine = (text: string, cue: RegExp) => text.split("\n").find((line) => cue.test(line)) ?? text.slice(0, 60);

/** Every percent, backslash, octal and character-code escape in the text,
 * written out as the characters they stand for. */
function unescapeText(text: string): { text: string; first: string } | null {
  let first = "";
  let out = text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    first ||= run;
    try { return decodeURIComponent(run); } catch { return run.replace(/%([0-9a-fA-F]{2})/g, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16))); }
  });
  out = out.replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\u\{([0-9a-fA-F]{1,6})\}|\\([0-7]{3})|&#([xX]?)([0-9a-fA-F]{1,6});/g,
    (all, x?: string, u?: string, braces?: string, octal?: string, hexFlag?: string, entity?: string) => {
      const cp = x !== undefined ? parseInt(x, 16) : u !== undefined ? parseInt(u, 16) : braces !== undefined ? parseInt(braces, 16)
        : octal !== undefined ? parseInt(octal, 8) : parseInt(entity!, hexFlag ? 16 : 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return all;
      first ||= all;
      return String.fromCodePoint(cp);
    });
  return out !== text ? { text: out, first } : null;
}

/** Every encoded form in the text that reads as words once decoded. */
export function decodedViews(text: string): Variant[] & { capped?: boolean } {
  const out: Variant[] & { capped?: boolean } = [];
  const seen = new Set<string>();
  const add = (encoding: string, readable: string | null, source: string) => {
    if (!readable || seen.has(readable)) return;
    if (out.length >= MAX_VARIANTS_PER_TEXT) { out.capped = true; return; }
    seen.add(readable);
    out.push({ encoding, text: readable, source: source.trim() });
  };
  const addBytes = (encoding: string, bytes: Uint8Array | null, source: string) => { if (bytes) add(encoding, bytesToText(bytes), source); };
  for (const run of text.matchAll(/(?:[A-Za-z0-9+/_-]{16,}={0,2}[ \t]*\r?\n?){1,300}/g)) {
    addBytes("base64", fromBase64(run[0]), run[0]);
    // Several blobs with their own padding, one after another.
    const pieces = run[0].split(/\s+/).filter((piece) => piece.length >= 16);
    if (pieces.length > 1) for (const piece of pieces) addBytes("base64", fromBase64(piece), piece);
  }
  // Base64 folded into short lines.
  for (const run of text.matchAll(/(?:[A-Za-z0-9+/_-]{4,15}={0,2}[ \t]*\r?\n){3,400}/g)) addBytes("base64", fromBase64(run[0]), run[0]);
  for (const run of text.matchAll(/(?:(?:0x)?[0-9a-fA-F]{2}[ \t:,]{0,2}){12,}/g)) addBytes("hex", fromHex(run[0]), run[0]);
  for (const run of text.matchAll(/\b[A-Z2-7]{24,}={0,6}(?![A-Za-z0-9])/g)) addBytes("base32", fromBase32(run[0]), run[0]);
  for (const run of text.matchAll(/(?<![\d.])(?:\d{2,3}[ \t]*[,;][ \t]*){11,}\d{2,3}(?![\d.])/g)) {
    const codes = run[0].split(/[,;]/).map((part) => Number(part.trim()));
    if (codes.every((code) => code >= 9 && code < 127)) addBytes("number codes", Buffer.from(String.fromCharCode(...codes), "utf8"), run[0]);
  }
  const unescaped = unescapeText(text);
  if (unescaped) add("escape codes", unescaped.text, unescaped.first);
  // A declared shift (rot5, rot7 ...); ROT13 and reversal are read for every text.
  const shift = text.match(/rot-?(\d{1,2})\b/i);
  const shiftBy = shift ? Number(shift[1]) : 0;
  if (shift && shiftBy >= 1 && shiftBy <= 25 && shiftBy !== 13) add(`rot${shiftBy}`, rotate(text, 26 - shiftBy), cueLine(text, /rot-?\d/i));
  return out;
}

// ── The scan ────────────────────────────────────────────────────────────────

const NOT_ESCALATED = new Set(["obfuscation", "padding", "index-poisoning", "hidden-text", "direction-override", "tag-characters", "homoglyph"]);
const OWN_RULES = new Set(["M1", "M2", "M3"]);
const MESSAGES = {
  obfuscated: "Hides instructions behind disguised text",
  "encoded-payload": "Contains encoded text that decodes to instructions",
  "tag-characters": "Contains invisible characters that can carry a hidden message",
  homoglyph: "Uses look-alike letters from another alphabet inside words",
} as const;
const message = (category: string) => (MESSAGES as Record<string, string>)[category] ?? plainMessage(category);

/** What a person is shown: no secret, and no long unbroken blob. */
const shown = (text: string) => redactSecrets(text).replace(/[A-Za-z0-9+/_=-]{40,}/g, (blob) => `[${blob.length} characters]`);
const norm = (text: string) => cleanedText(text).replace(/\s+/g, " ").trim();

/** Long stretches of blanks are cut to 40 characters for the pattern scan (the
 * padding check reads the whole text itself), so a very long run of spaces
 * cannot make the patterns slow. Line numbers come from the original text. */
function squeeze(text: string): string {
  let out = "";
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) { i++; continue; }
    let j = i;
    while (j < text.length) { const d = text.charCodeAt(j); if (d === 32 || d === 9 || d === 10 || d === 13) j++; else break; }
    if (j - i > 80) { out += text.slice(last, i + 40); last = j; }
    i = j;
  }
  return last === 0 ? text : out + text.slice(last);
}

interface Meta { unit: TextUnit; key: string; kind: "raw" | "plain" | "cleaned" | "decoded"; chain?: string; source?: string; view?: string; reversed?: boolean; bulk?: boolean }

function lineOf(text: string, needle: string): number {
  const first = needle.replace(/…$/, "").split("\n").map((part) => part.trim()).find(Boolean);
  if (!first) return 0;
  const direct = text.indexOf(first);
  if (direct >= 0) return text.slice(0, direct).split("\n").length;
  const lines = text.split("\n");
  const wanted = norm(first).slice(0, 60);
  if (wanted.length >= 6) for (let index = 0; index < lines.length; index++) if (norm(lines[index]!).includes(wanted)) return index + 1;
  const probe = first.slice(0, 24);
  const at = probe.length >= 8 ? text.indexOf(probe) : -1;
  return at >= 0 ? text.slice(0, at).split("\n").length : 0;
}

function toFinding(unit: TextUnit, found: { rule: string; category: string; severity: SkillFinding["severity"]; confidence: number; evidence: string; source?: SkillFinding["source"] }, line: number, offset: number): BotPackageFinding {
  const block = findingBlocks({ ...found, message: "", file: "", source: found.source ?? "murage" });
  return {
    path: shown(unit.path), rule: found.rule, severity: block ? "block" : "review", offset, line,
    message: message(found.category), category: found.category,
    ...(unit.field ? { field: shown(unit.field) } : {}),
    evidence: shown(found.evidence),
  };
}

/** How far the two long stages of the check have got, each from 0 to 1. */
export type GuardProgress = (stage: "prepare" | "scan", fraction: number) => void;

const DECLARED_ENCODING = /\b(?:base-?58|base-?85|ascii-?85|uuencode|xxencode|z85)\b/i;

/** The Skill Guard findings for every text in the package. */
export function guardBotPackage(files: readonly BotPackageScanFile[], onProgress?: GuardProgress): { findings: BotPackageFinding[]; truncated: boolean } {
  const findings: BotPackageFinding[] = [];
  const walked = textUnits(files);
  // A limit that is reached stops the import: the rest was not read.
  let truncated = walked.truncated;
  const push = (finding: BotPackageFinding) => {
    if (findings.length < MAX_FINDINGS) findings.push(finding); else truncated = true;
  };
  // The same string repeated in many fields is read once.
  const seenText = new Set<string>();
  const units = walked.units.filter((unit) => {
    const id = `${unit.field ? "f" : unit.path}\u0000${unit.text}`;
    if (seenText.has(id)) return false;
    seenText.add(id);
    return true;
  });
  // Corroboration between categories happens within a group only, so the
  // extra readings (decoded text, ROT13, reversed text) cannot tip a plain text.
  const groups: { plain: SkillScanFile[]; decoded: SkillScanFile[]; bulk: SkillScanFile[] } = { plain: [], decoded: [], bulk: [] };
  const metas = new Map<string, Meta>();
  let decodedCount = 0;
  let bulkLeft = BULK_VIEW_BUDGET;
  const register = (label: string, text: string, meta: Meta) => {
    // Raw, cleaned and folded text is read the way Skill Guard reads a skill
    // (prose, and code inside fences); text decoded from a blob is read as both.
    groups[meta.bulk ? "bulk" : meta.kind === "decoded" ? "decoded" : "plain"].push({ path: label, content: squeeze(text), ...(meta.kind === "decoded" ? { both: true } : {}) });
    metas.set(label, meta);
  };
  const expand = (unit: TextUnit, key: string, text: string, depth: number, chain: string, source?: string) => {
    const found = decodedViews(text);
    if (found.capped || (depth >= MAX_DECODE_DEPTH && found.length)) truncated = true;
    if (depth >= MAX_DECODE_DEPTH) return;
    for (const variant of found) {
      if (++decodedCount > MAX_DECODED_VIEWS) { truncated = true; return; }
      const label = `decoded:${decodedCount}/${unit.path}#${unit.field ?? ""}`;
      const nextChain = chain ? `${chain}, then ${variant.encoding}` : variant.encoding;
      const origin = source ?? variant.source;
      // Hidden characters inside an encoded blob are on purpose.
      for (const hit of unicodeHits(variant.text)) {
        push(toFinding(unit, { rule: "G-ENC-HID", category: "encoded-payload", severity: "high", confidence: 0.9, evidence: `decoded from ${nextChain}: ${hit.evidence}` }, lineOf(unit.text, origin), 0));
      }
      register(label, cleanedText(variant.text), { unit, key, kind: "decoded", chain: nextChain, source: origin });
      expand(unit, key, variant.text, depth + 1, nextChain, origin);
    }
  };
  const prepareTotal = Math.max(1, units.reduce((sum, unit) => sum + unit.text.length, 0));
  let prepared = 0;
  for (const [index, unit] of units.entries()) {
    onProgress?.("prepare", prepared / prepareTotal);
    prepared += unit.text.length;
    const key = `u${index}`;
    const text = unit.text;
    for (const hit of unicodeHits(text)) push(toFinding(unit, hit, text.slice(0, hit.index).split("\n").length, hit.index));
    if (text.length < MIN_SCANNED_LENGTH) continue;
    const label = unit.field ? `${unit.path}#${unit.field}` : unit.path;
    register(label, text, { unit, key, kind: "raw" });
    const paddingFound = paddingEvidence(text);
    if (paddingFound) push(toFinding(unit, { rule: "M3", category: "padding", severity: "medium", confidence: 0.7, evidence: paddingFound }, lineOf(text, paddingFound.replace(/^.*?, then: /, "")), 0));
    const cleaned = cleanedText(text);
    if (cleaned !== text) register(`cleaned:${label}`, cleaned, { unit, key, kind: "cleaned", view: cleaned });
    // Hidden characters or marks standing in for the spaces between words.
    const spaced = cleanedText(text, " ");
    if (spaced !== cleaned && spaced !== text) register(`spaced:${label}`, spaced, { unit, key, kind: "cleaned", view: spaced });
    // A line break or tab where a phrase has a space.
    const collapsed = text.replace(/[\s\u00a0]+/g, " ");
    if (collapsed !== text && text.length <= BULK_VIEW_MAX_TEXT) register(`folded:${label}`, collapsed, { unit, key, kind: "plain", view: collapsed });
    if (text.length >= 16 && text.length <= BULK_VIEW_MAX_TEXT && bulkLeft > 0) {
      bulkLeft -= text.length * 2;
      const turned = rotate(cleaned, 13);
      register(`rot13:${label}`, turned, { unit, key, kind: "decoded", chain: "rot13", view: turned, bulk: true });
      const backwards = [...cleaned].reverse().join("");
      register(`reversed:${label}`, backwards, { unit, key, kind: "decoded", chain: "reversed text", view: backwards, reversed: true, bulk: true });
    }
    if (DECLARED_ENCODING.test(text) && /\S{32,}/.test(text)) {
      push(toFinding(unit, { rule: "G-ENC-DECLARED", category: "obfuscation", severity: "medium", confidence: 0.75, evidence: `mentions ${text.match(DECLARED_ENCODING)![0]} next to a long block of encoded text` }, lineOf(text, text.match(/\S{32,}/)![0]), 0));
    }
    expand(unit, key, cleaned, 0, "");
    if (cleaned !== text) expand(unit, key, text, 0, "");
  }
  onProgress?.("prepare", 1);
  const found: SkillFinding[] = [];
  const scanTotal = Math.max(1, Object.values(groups).reduce((sum, files) => sum + files.reduce((inner, file) => inner + file.content.length, 0), 0));
  let scanned = 0;
  for (const files of Object.values(groups)) {
    if (files.length) found.push(...scanSkill({ name: "package", description: "", triggerTerms: [], files }, undefined, onProgress ? (length) => { scanned += length; onProgress("scan", Math.min(1, scanned / scanTotal)); } : undefined).findings);
  }
  const scan = { findings: found };
  const plainKeys = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, meta: Meta, found: SkillFinding) => {
    const set = map.get(meta.key) ?? map.set(meta.key, new Set()).get(meta.key)!;
    set.add(`${found.rule}|${norm(found.evidence)}`);
  };
  for (const found of scan.findings) {
    const meta = metas.get(found.file);
    if (meta?.kind === "raw") note(plainKeys, meta, found);
  }
  const reported = new Set<string>();
  // Related fields read together add a finding only when it is new.
  const inFields = new Set<string>();
  for (const found of scan.findings) {
    const meta = metas.get(found.file);
    if (meta && !meta.unit.together) inFields.add(`${found.rule}|${norm(found.evidence)}`);
  }
  for (const found of scan.findings) {
    if (OWN_RULES.has(found.rule)) continue;
    const meta = metas.get(found.file);
    if (!meta) continue;
    // Folded text is one long line, so it is read only for the override phrase
    // that wants a plain space (a line break or tab where the space belongs);
    // ROT13 and reversed text must show a clear phrase.
    if (meta.kind === "plain" && found.rule !== "SG5") continue;
    if (meta.bulk && found.source === "skillspector" && !((found.severity === "critical" || found.severity === "high") && found.evidence.length >= 16)) continue;
    const evidenceKey = `${found.rule}|${norm(found.evidence)}`;
    if (meta.unit.together && inFields.has(evidenceKey)) continue;
    if (meta.kind !== "raw" && plainKeys.get(meta.key)?.has(evidenceKey)) continue;
    let out: Parameters<typeof toFinding>[1] = { rule: found.rule, category: found.category, severity: found.severity, confidence: found.confidence, evidence: found.evidence, source: found.source };
    let text = meta.unit.text;
    if (meta.kind === "plain") text = meta.view ?? text;
    else if (meta.kind === "cleaned" || meta.kind === "decoded") {
      if (NOT_ESCALATED.has(found.category)) continue;
      const how = meta.kind === "cleaned" ? "hidden characters and look-alike letters removed" : `decoded from ${meta.chain}`;
      out = { rule: `G-${meta.kind === "cleaned" ? "OBF" : "ENC"}:${found.rule}`, category: meta.kind === "cleaned" ? "obfuscated" : "encoded-payload", severity: "high", confidence: 0.9, evidence: clip(`${how}: "${found.evidence}"`) };
      if (meta.kind === "cleaned") text = meta.view ?? text;
    }
    const dedupe = `${meta.key}|${out.rule}|${evidenceKey}`;
    if (reported.has(dedupe)) continue;
    reported.add(dedupe);
    let line: number;
    if (meta.kind === "decoded" && meta.view !== undefined) {
      const inView = lineOf(meta.view, found.evidence);
      line = inView && meta.reversed ? meta.view.split("\n").length - inView + 1 : inView;
    } else line = lineOf(meta.kind === "decoded" ? meta.unit.text : text, meta.kind === "decoded" ? (meta.source ?? found.evidence) : found.evidence);
    push(toFinding(meta.unit, out, line, 0));
    if (truncated) break;
  }
  return { findings, truncated };
}

/** The existing secret and path scan plus the Skill Guard import check, as one
 * result for the import review. Blocked findings stop the import; review
 * findings ask the owner. */
export function scanBotPackageForImport(files: readonly BotPackageScanFile[], onProgress?: (fraction: number) => void): BotPackageScanResult {
  // One bar across the three stages: the secret and path scan, then reading
  // each text, then the Skill Guard rules over every reading of it.
  const base = scanBotPackageContents(files, onProgress ? (fraction) => onProgress(0.1 * fraction) : undefined);
  if (base.truncated || files.length > MAX_BOT_PACKAGE_ENTRIES) {
    const overLimit = base.findings.some((finding) => finding.rule === "byte-limit" || finding.rule === "file-count-limit");
    return overLimit ? { ...base, state: "too-large" } : base;
  }
  const guard = guardBotPackage(files, onProgress ? (stage, fraction) => onProgress(stage === "prepare" ? 0.1 + 0.3 * fraction : 0.4 + 0.6 * fraction) : undefined);
  const result: BotPackageScanResult = { ...base, findings: [...base.findings] };
  for (const finding of guard.findings) {
    if (result.findings.length >= MAX_FINDINGS) { result.truncated = true; result.blocked = true; break; }
    result.findings.push(finding);
    if (finding.severity === "block") result.blocked = true; else result.reviewRequired = true;
  }
  // Anything left unread because a limit was reached stops the import.
  if (guard.truncated) { result.truncated = true; result.blocked = true; }
  return result;
}

/** One plain sentence for a caller that shows only an error line: what was
 * found first, and where. The full list rides along as `scan`. */
export function importGuardSummary(scan: BotPackageScanResult): string {
  const first = scan.findings.filter((f) => f.message).slice(0, 3)
    .map((f) => `${f.field ?? f.path}${f.line ? `, line ${f.line}` : ""}: ${f.message}`);
  if (scan.state === "too-large") return "This package is too large to check, so it was not imported.";
  if (scan.state === "unavailable") return "The check could not finish, so nothing was imported. Please try again.";
  const lead = scan.blocked ? "This file was not imported. " : "Look this over before importing. ";
  return first.length ? `${lead}${first.join("; ")}.` : `${lead}${scan.truncated ? "It is larger than the check can read in full." : "It holds text that is worth a look."}`;
}
