// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Bank, card, account and personal id numbers never reach memory. Memory keeps
// the SHAPE of such a number and loses its DIGITS: every ASCII digit (and, in
// an IBAN or an id, every ASCII letter after the first two) of a matched
// identifier becomes `*`, everything else stays as typed. `*` is one byte like
// the character it replaces, so the output has the same byte length as the
// input; evidence spans and content hashes over stored text stay valid when a
// stored cell is masked in place. Masked text has no candidates left, so the
// function is idempotent.
//
// Pure, no imports: the renderer, the server and (ported) Flux Memory run the
// same rules. shared/financial-ids.vectors.json is the shared test table.
//
// Every rule is linear: candidates start only at a token boundary, each
// candidate reads a bounded number of characters, and the context windows are
// bounded slices of the same line.

/** Bumped when a rule changes; the scrub of stored rows keys on it. */
export const FINANCIAL_RULE_VERSION = 1;

/** The fast path: four digits, each within 38 other characters of the next.
 * Every rule needs at least four digits inside one identifier, and the widest
 * identifier a rule accepts with fewer than four adjacent digits (an id of 20
 * letters or digits with a separator between each, such as a codice fiscale,
 * `RSSMRA85T10A562S`) spans 39 characters, so a text this test refuses holds
 * nothing any rule could mask. It is linear: each step reads at most 39
 * characters to the next digit. A text with fewer than four digits, which is
 * most chat, is returned unchanged at once. */
const FAST_PATH = /\d(?:\D{0,38}\d){3}/;

/** Four digits with at most one space or dash between neighbours: the shape of
 * every card, account, routing, sort code, SSN and "ending NNNN". */
const DIGIT_SHAPE = /\d(?:[ -]?\d){3}/;

/** True when the text may hold an identifier: a four digit run, or a number
 * any rule masks. It is not the decider: "the 2026 budget" is true and is
 * returned unchanged by the mask. Used where a false yes costs little (the
 * Flux Memory capture hold) and a false no would let a number through. */
export function hasFinancialIdentifier(text: string): boolean {
  if (typeof text !== "string") return false;
  return DIGIT_SHAPE.test(text) || maskFinancialIdentifiers(text) !== text;
}

/** True only when a rule masks something in the text: the test the Flux
 * Memory capture hold keys on, so a year or a date never turns capture off
 * for a thread (GrokBuild r2 on S7). */
export function containsFinancialIdentifier(text: string): boolean {
  return typeof text === "string" && maskFinancialIdentifiers(text) !== text;
}

/** The fast-path test alone, exported for the table test (F1). */
export function passesFinancialFastPath(text: string): boolean {
  return FAST_PATH.test(text);
}

export function maskFinancialIdentifiers(text: string): string {
  if (typeof text !== "string" || !FAST_PATH.test(text)) return text;
  let out = text;
  out = maskIban(out);
  out = maskCards(out);
  out = maskRouting(out);
  out = maskContextIds(out, SSN_CONTEXT, parseSsn, false);
  out = maskContextIds(out, TAX_CONTEXT, parseIdentifier, true);
  out = maskContextIds(out, NATIONAL_CONTEXT, parseIdentifier, true);
  out = maskAccountPhrases(out);
  out = maskEndings(out);
  return out;
}

// ---------------------------------------------------------------- helpers

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}
function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z"));
}
function isAlnum(ch: string | undefined): boolean {
  return isDigit(ch) || isLetter(ch);
}
/** A character that glues a candidate to its neighbour: no candidate may be
 * preceded or followed by one (hex, hashes, UUIDs, `0x…`, masked spans). */
function isGlue(ch: string | undefined): boolean {
  return isAlnum(ch) || ch === "_" || ch === "*";
}

/** Replace the characters at the given offsets with `*`. */
function starAt(text: string, offsets: number[]): string {
  if (offsets.length === 0) return text;
  offsets.sort((a, b) => a - b);
  // Slices between the offsets, not one string per character: a 32 MiB tool
  // output must not become 32 million strings.
  let out = "";
  let last = 0;
  for (const i of offsets) {
    if (i < last) continue; // the same offset twice
    out += text.slice(last, i) + "*";
    last = i + 1;
  }
  return out + text.slice(last);
}

/** The part of the line that ends at `end`, at most `width` characters. */
function lineBefore(text: string, end: number, width: number): string {
  const from = Math.max(0, end - width);
  const slice = text.slice(from, end);
  const nl = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("\r"));
  return nl >= 0 ? slice.slice(nl + 1) : slice;
}

// ---------------------------------------------------------------- IBAN

/** IBAN registry: country code to the full compact length. */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
  LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/** Two letters, two digits, then up to 30 more letters or digits with at most
 * one space or dash between neighbours (any grouping, any case). */
const IBAN_CANDIDATE = /(?<![A-Za-z0-9_*])[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){11,30}/g;

function ibanChecksumOk(compact: string): boolean {
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) rem = (rem * 10 + (code - 48)) % 97;
    else rem = (rem * 100 + (code - 55)) % 97; // A=10 .. Z=35
  }
  return rem === 1;
}

function maskIban(text: string): string {
  const offsets: number[] = [];
  IBAN_CANDIDATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IBAN_CANDIDATE.exec(text)) !== null) {
    const start = m.index;
    const country = m[0].slice(0, 2).toUpperCase();
    const length = IBAN_LENGTHS[country];
    let accepted = false;
    if (length !== undefined) {
      // Take exactly `length` letters or digits from the candidate.
      const positions: number[] = [];
      let compact = "";
      for (let i = 0; i < m[0].length && positions.length < length; i++) {
        const ch = m[0][i];
        if (isAlnum(ch)) {
          positions.push(start + i);
          compact += ch.toUpperCase();
        }
      }
      const end = positions.length === length ? positions[positions.length - 1] + 1 : -1;
      if (end > 0 && !isGlue(text[end]) && ibanChecksumOk(compact)) {
        for (const p of positions.slice(2)) offsets.push(p);
        IBAN_CANDIDATE.lastIndex = end;
        accepted = true;
      }
    }
    if (!accepted) IBAN_CANDIDATE.lastIndex = start + 1;
  }
  return starAt(text, offsets);
}

// ---------------------------------------------------------------- CARD

/** A maximal run of digits with at most one space or dash between digits. */
const DIGIT_RUN = /(?<![A-Za-z0-9_*])\d(?:[ -]?\d)*/g;
const PHONE_WORDS = /(?<![A-Za-z])(?:phone|tel|mobile|cell|fax|call)(?![A-Za-z])|tel:/i;

function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function phoneGuarded(text: string, start: number): boolean {
  const before = lineBefore(text, start, 24);
  const trimmed = before.replace(/[ (]+$/, "");
  const last = trimmed[trimmed.length - 1];
  if (last === "+" || last === "#") return true;
  return PHONE_WORDS.test(before);
}

function cardDigitsOk(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  const first = digits[0];
  if (first < "2" || first > "6") return false;
  return luhnOk(digits);
}

interface Group { start: number; digits: string; sep: string }

function maskCards(text: string): string {
  const offsets: number[] = [];
  DIGIT_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIGIT_RUN.exec(text)) !== null) {
    const run = m[0];
    const runStart = m.index;
    const runEnd = runStart + run.length;
    if (isGlue(text[runEnd])) continue; // glued to a letter after it
    if (run.length < 13) continue; // fewer than 13 digits: never a card
    // Split into groups by separator.
    const groups: Group[] = [];
    let cur = "";
    let curStart = runStart;
    let sepBefore = "";
    for (let i = 0; i < run.length; i++) {
      const ch = run[i];
      if (isDigit(ch)) {
        if (cur === "") curStart = runStart + i;
        cur += ch;
      } else {
        groups.push({ start: curStart, digits: cur, sep: sepBefore });
        sepBefore = ch;
        cur = "";
      }
    }
    groups.push({ start: curStart, digits: cur, sep: sepBefore });
    if (groups.length === 1) {
      const g = groups[0];
      if (cardDigitsOk(g.digits) && !phoneGuarded(text, g.start)) {
        for (let i = 0; i < g.digits.length; i++) offsets.push(g.start + i);
      }
      continue;
    }
    // Grouped: any window of 3 to 5 consecutive groups of 4 to 6 digits,
    // one separator kind throughout, forms a card. A card typed before an
    // expiry ("4111 1111 1111 1111 12/27") is found this way.
    let i = 0;
    while (i < groups.length) {
      const lead = groups[i].digits.length;
      if (lead < 4 || lead > 6) { i++; continue; } // no window starts here
      let found = 0;
      for (let size = Math.min(5, groups.length - i); size >= 3 && !found; size--) {
        const window = groups.slice(i, i + size);
        if (!window.every((g) => g.digits.length >= 4 && g.digits.length <= 6)) continue;
        const sep = window[1].sep;
        if (!window.slice(1).every((g) => g.sep === sep)) continue;
        const digits = window.map((g) => g.digits).join("");
        if (!cardDigitsOk(digits) || phoneGuarded(text, window[0].start)) continue;
        for (const g of window) for (let k = 0; k < g.digits.length; k++) offsets.push(g.start + k);
        found = size;
      }
      i += found || 1;
    }
  }
  return starAt(text, offsets);
}

// ---------------------------------------------------------------- ROUTING

const ROUTING = /(?<![A-Za-z0-9_])(?:routing|aba|rtn|transit)(?![A-Za-z0-9_])[^0-9\n\r]{0,24}?(\d{3}[ -]?\d{3}[ -]?\d{3})/gi;

function abaOk(d: string): boolean {
  const prefix = Number(d.slice(0, 2));
  const prefixOk = (prefix >= 0 && prefix <= 12) || (prefix >= 21 && prefix <= 32) || (prefix >= 61 && prefix <= 72) || prefix === 80;
  if (!prefixOk) return false;
  const n = (k: number) => d.charCodeAt(k) - 48;
  const sum = 3 * (n(0) + n(3) + n(6)) + 7 * (n(1) + n(4) + n(7)) + (n(2) + n(5) + n(8));
  return sum % 10 === 0;
}

function maskRouting(text: string): string {
  const offsets: number[] = [];
  ROUTING.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTING.exec(text)) !== null) {
    const numStart = m.index + m[0].length - m[1].length;
    const numEnd = m.index + m[0].length;
    if (isGlue(text[numStart - 1]) || isGlue(text[numEnd])) continue;
    const digits = m[1].replace(/[ -]/g, "");
    if (!abaOk(digits)) continue;
    for (let i = numStart; i < numEnd; i++) if (isDigit(text[i])) offsets.push(i);
  }
  return starAt(text, offsets);
}

// ---------------------------------------------------------------- context-gated ids (SSN, TAX_ID, NATIONAL_ID)

/** Characters after the context word in which the identifier must start. */
const CONTEXT_WINDOW = 32;

const SSN_CONTEXT = /(?<![A-Za-z0-9_])(social[ -]security|taxpayer[ \t]+id|itin|ssn|ssa|tin)(?![A-Za-z0-9_])/gi;
const TAX_CONTEXT = new RegExp(
  "(?<![A-Za-z0-9_])(" +
    [
      "employer identification", "employer id", "tax number", "tax id", "federal id", "USt-IdNr", "Steuer-ID", "Steuernummer",
      "codice fiscale", "partita IVA", "organisationsnummer", "org\\.nr", "Y-tunnus", "SIRET", "SIREN", "CNPJ", "REGON", "PESEL",
      "EIN", "VAT", "UID", "ABN", "ACN", "GST", "HST", "BN", "NIF", "CIF", "IdNr", "CPF", "RFC", "CUIT", "RUT", "RUC", "NIP",
      "BSN", "KvK", "CVR",
    ].map((w) => w.replace(/ /g, "[ \\t]+")).join("|") +
    ")(?![A-Za-z0-9_])",
  "gi",
);
const NATIONAL_CONTEXT = new RegExp(
  "(?<![A-Za-z0-9_])(" +
    [
      "national insurance", "national id", "NI number", "NINO", "social insurance", "SIN", "tax file", "TFN", "PAN", "Aadhaar",
      "CURP", "DNI", "NIE", "CPR", "personnummer", "personal number", "fodselsnummer", "henkilotunnus", "kennitala", "CNP",
      "OIB", "EMBG", "JMBG", "ID number", "ID no", "ID card", "identity number", "identity card", "passport number",
      "passport no", "passport", "driver licence", "driver's license", "driving licence", "DL number",
    ].map((w) => w.replace(/ /g, "[ \\t]+")).join("|") +
    ")(?![A-Za-z0-9_])",
  "gi",
);

/** A parsed identifier: the offsets to mask and where it ends. */
interface Parsed { mask: number[]; end: number }
type Parser = (text: string, start: number, context: string) => Parsed | null;

function maskContextIds(text: string, context: RegExp, parse: Parser, contextFree: boolean): string {
  const offsets: number[] = [];
  context.lastIndex = 0;
  let m: RegExpExecArray | null;
  // Where the last window stopped reading. A parser whose answer does not
  // depend on the context word reads each position once however many context
  // words sit before it, which keeps "VAT VAT VAT ..." linear.
  let scannedTo = 0;
  while ((m = context.exec(text)) !== null) {
    const word = m[1].toLowerCase().startsWith("taxpayer") ? "tin" : m[1].toLowerCase();
    const wordEnd = m.index + m[0].length;
    const from = contextFree || !ITIN_WORDS.has(word) ? Math.max(wordEnd, scannedTo) : wordEnd;
    const limit = Math.min(text.length, wordEnd + CONTEXT_WINDOW);
    let p = from;
    for (; p < limit; p++) {
      const ch = text[p];
      if (ch === "\n" || ch === "\r") break;
      if (!isAlnum(ch) || isGlue(text[p - 1])) continue;
      if (!isDigit(ch)) {
        // A word of letters only that cannot open an id (lowercase, or longer
        // than a two-letter prefix) is passed over whole.
        let q = p;
        let upper = true;
        while (isLetter(text[q])) { if (text[q] > "Z") upper = false; q++; }
        if (!isDigit(text[q]) && text[q] !== "*" && (!upper || q - p > 2)) { p = q - 1; continue; }
      }
      const parsed = parse(text, p, word);
      if (parsed) {
        // Keep reading the window after it: a second pass must find nothing
        // the first one left (idempotence).
        for (const i of parsed.mask) offsets.push(i);
        p = parsed.end - 1;
      }
    }
    scannedTo = Math.max(scannedTo, p);
  }
  return starAt(text, offsets);
}

function inRange(n: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([a, b]) => n >= a && n <= b);
}
const ITIN_GROUPS = [[70, 88], [90, 92], [94, 99]] as const;
/** The words under which a 9xx area is an ITIN, not an invalid SSN. Only the
 * SSN parser's answer depends on its context word, and only through these:
 * after any other word a position already read is not read again. */
const ITIN_WORDS = new Set(["itin", "tin"]);

/** `\d{3}[ -]?\d{2}[ -]?\d{4}` at `start`, not glued, valid as an SSN (or an
 * ITIN under the ITIN, TIN or taxpayer id words). */
function parseSsn(text: string, start: number, context: string): Parsed | null {
  const digits: number[] = [];
  let p = start;
  for (const count of [3, 2, 4]) {
    if (digits.length > 0 && (text[p] === " " || text[p] === "-") && isDigit(text[p + 1])) p++;
    for (let k = 0; k < count; k++, p++) {
      if (!isDigit(text[p])) return null;
      digits.push(p);
    }
  }
  if (isGlue(text[p])) return null;
  const n = (from: number, to: number) => {
    let v = 0;
    for (let k = from; k < to; k++) v = v * 10 + (text.charCodeAt(digits[k]) - 48);
    return v;
  };
  const area = n(0, 3);
  const group = n(3, 5);
  const serial = n(5, 9);
  if (group === 0 || serial === 0 || area === 0 || area === 666) return null;
  if (area >= 900) {
    if (!ITIN_WORDS.has(context) || !inRange(group, ITIN_GROUPS)) return null;
  }
  return { mask: digits, end: p };
}

/** An identifier of 6 to 20 letters or digits with single spaces, dashes, dots
 * or slashes between them, at least four digits. Tokens are letter-or-digit
 * runs; a token with a digit always belongs; a letters-only token belongs only
 * as an uppercase prefix of one or two letters before a token with a digit
 * (`GB 123 4567 89`, `AB 12 34 56 C`) or a single uppercase letter at the end.
 * Lowercase words end it, so "is on the 2026-10-23 letter" yields the date. */
function parseIdentifier(text: string, start: number): Parsed | null {
  // A `*` is a character an earlier pass masked: it counts as a digit here, so
  // a second pass reads the same identifier the first one did (idempotence).
  const isPart = (ch: string | undefined) => isAlnum(ch) || ch === "*";
  const alnum: number[] = [];
  let length = 0;
  let digitCount = 0;
  let tokens = 0;
  let lastHadDigit = false;
  let p = start;
  let end = start;
  while (p < text.length) {
    const tokStart = p;
    let hasDigit = false;
    let upper = true;
    while (isPart(text[p])) {
      if (isDigit(text[p]) || text[p] === "*") hasDigit = true;
      else if (text[p] < "A" || text[p] > "Z") upper = false;
      p++;
    }
    const len = p - tokStart;
    let belongs = hasDigit;
    let stop = false;
    if (!hasDigit) {
      if (tokens === 0 && upper && len <= 2) belongs = true; // a prefix: kept only if a digit token follows
      else if (tokens > 0 && lastHadDigit && upper && len === 1) { belongs = true; stop = true; } // a one-letter suffix
    }
    if (!belongs || (tokens === 1 && !lastHadDigit && !hasDigit)) break;
    for (let i = tokStart; i < p; i++) {
      if (isAlnum(text[i])) alnum.push(i);
      if (isDigit(text[i]) || text[i] === "*") digitCount++;
    }
    length += len;
    tokens++;
    lastHadDigit = hasDigit;
    end = p;
    if (stop) break;
    const sep = text[p];
    if ((sep === " " || sep === "-" || sep === "." || sep === "/") && isPart(text[p + 1])) p++;
    else break;
  }
  if (tokens === 0 || (tokens === 1 && !lastHadDigit)) return null;
  // Longer than any id: not one, and no part of it is tried on its own.
  if (length > 20) return { mask: [], end };
  if (isGlue(text[end]) || length < 6 || digitCount < 4) return null;
  const first = text[start];
  const keep = isLetter(first) ? (isLetter(text[start + 1]) ? 2 : 1) : 0;
  return { mask: alnum.filter((i) => i >= start + keep), end };
}

// ---------------------------------------------------------------- ACCOUNT_PHRASE

const ACCOUNT_PHRASE = /(?<![A-Za-z0-9_])(account|acct|a\/c|sort[ -]?code|bsb)(?![A-Za-z0-9_])(?:[ \t]*(?:number|num|nr|no\.?|#)(?![A-Za-z0-9_]))?[ \t]*[:#]?[ \t]*(\d(?:[ -]?\d)*)/gi;

function maskAccountPhrases(text: string): string {
  const offsets: number[] = [];
  ACCOUNT_PHRASE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ACCOUNT_PHRASE.exec(text)) !== null) {
    const run = m[2];
    const runStart = m.index + m[0].length - run.length;
    const runEnd = m.index + m[0].length;
    if (isGlue(text[runStart - 1]) || isGlue(text[runEnd])) continue;
    const word = m[1].toLowerCase();
    const digits = run.replace(/[ -]/g, "");
    if (word.startsWith("sort") || word === "bsb") {
      const shape = word === "bsb" ? /^\d{3}[ -]?\d{3}$/ : /^\d{2}([ -]?)\d{2}\1\d{2}$/;
      if (!shape.test(run)) continue;
    } else if (digits.length < 6 || digits.length > 17) continue;
    for (let i = runStart; i < runEnd; i++) if (isDigit(text[i])) offsets.push(i);
  }
  return starAt(text, offsets);
}

// ---------------------------------------------------------------- ENDING

const ENDING = /(?<![A-Za-z0-9_])(?:ending(?:[ \t]+(?:in|with))?|ends[ \t]+(?:in|with)|last[ \t]+(?:four|4)(?:[ \t]+digits)?)(?:[ \t]+of(?:[ \t]+[A-Za-z]+){1,3})?(?:[ \t]+(?:are|is))?[ \t]*:?[ \t]*(\d{4})(?![A-Za-z0-9_*])/gi;
const ENDING_CONTEXT = /(?<![A-Za-z])(?:account|acct|card|visa|mastercard|amex|iban|checking|savings|debit|credit)/i;

function maskEndings(text: string): string {
  const offsets: number[] = [];
  ENDING.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENDING.exec(text)) !== null) {
    const window = lineBefore(text, m.index, 48) + m[0];
    if (!ENDING_CONTEXT.test(window)) continue;
    const start = m.index + m[0].length - 4;
    for (let i = 0; i < 4; i++) offsets.push(start + i);
  }
  return starAt(text, offsets);
}
