// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Bank, card, account and personal id numbers never reach memory. Memory keeps
// the SHAPE of such a number and loses its DIGITS: every ASCII digit (and, in
// an IBAN or an id, every ASCII letter after the first two) of a matched
// identifier becomes `*`, everything else stays as typed. `*` is one byte like
// the character it replaces, so the output has the same byte length as the
// input; evidence spans and content hashes over stored text stay valid when a
// stored cell is masked in place.
//
// v3, one pass (designs/FINANCIAL-IDS-V3-ONEPASS.md). Two fixed stages, each
// run once: stage 1 finds cards and IBANs in the ORIGINAL text; stage 2 finds
// every other id in the original text and in the original text with the stage
// 1 numbers as `*` separators. The masks are a union. Nothing is repeated
// until it settles. The first call is final because of how the rules are
// written, not because of a loop:
//   - every mask covers whole digit groups or whole letter-or-digit tokens,
//     except a kept prefix of 1 or 2 letters at the start of a token (an IBAN
//     country code, an id's prefix), so the output only differs from the
//     input in tokens that became `*` and in kept letters now followed by `*`;
//   - `*` is a separator: it never joins or glues anything, except that a
//     kept-prefix shape (1 or 2 letters starting a token, then `*`) is glued,
//     in both passes alike;
//   - context windows are positions after a context word, set once;
//   - a run read as a whole (an account run, an id chain) has only "at least"
//     limits, so a shorter run never passes where the whole failed;
//   - a card (13 to 19 digits, first digit 2 to 6, Luhn) is masked wherever it
//     stands, in one group or a grouped window, with no guard word.
//
// Pure, no imports: the renderer, the server and (ported) Flux Memory run the
// same rules. shared/financial-ids.vectors.json is the shared test table.
//
// Every rule is linear: candidates start only at a token boundary, each
// candidate reads a bounded number of characters, and the context windows are
// bounded slices of the same line.

/** Bumped when a rule changes; the scrub of stored rows keys on it. */
export const FINANCIAL_RULE_VERSION = 3;

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

type Rule = (text: string, out: number[]) => void;

/** Stage 1: the self-delimiting numbers, read from the original text. A card
 * or an IBAN is masked wherever it stands and outranks every other rule. */
const STAGE1: readonly (readonly [string, Rule])[] = [
  ["card", findCards],
  ["iban", findIbans],
];
/** Stage 2: the rules that read a number beside a word or as a run. They read
 * the original text, and again the original text with the stage 1 numbers as
 * `*` separators: the first read keeps an id whole when a card span took one
 * of its groups ("EIN 12-3456789 4111 1111 1111 1111"), the second reads an id
 * on its own beside a card ("PAN 3782 822463 10005 459-80-5615"). The order of
 * the rules and of the reads does not change the output: the masks are a
 * union, and a mask beats a kept letter. */
const STAGE2: readonly (readonly [string, Rule])[] = [
  ["routing", findRouting],
  ["account", findAccountRuns],
  ["ending", findEndings],
  ["ssn", (text, out) => findContextIds(text, SSN_CONTEXT, parseSsn, out)],
  ["tax", (text, out) => findContextIds(text, TAX_CONTEXT, parseIdentifier, out)],
  ["national", (text, out) => findContextIds(text, NATIONAL_CONTEXT, parseIdentifier, out)],
  // An account word opens the same id window, so an account number that does
  // not stand right after the word is read too ("account 12*345678901234").
  ["account-window", (text, out) => findContextIds(text, ACCOUNT_CONTEXT, parseIdentifier, out)],
];

function runStage(rules: readonly (readonly [string, Rule])[], text: string, out: number[]): void {
  for (const [, rule] of rules) rule(text, out);
}

export function maskFinancialIdentifiers(text: string): string {
  if (typeof text !== "string" || !FAST_PATH.test(text)) return text;
  // Two fixed stages, each once; nothing is repeated until it settles.
  const offsets: number[] = [];
  runStage(STAGE1, text, offsets);
  const view = starAt(text, offsets.slice());
  runStage(STAGE2, text, offsets);
  if (view !== text) runStage(STAGE2, view, offsets);
  return starAt(text, offsets);
}

/** Each rule's offsets on its own, read from `text` (no fast path, no stage
 * order). The property tests check that on a masked text every list is
 * empty: nothing a second pass would mask survives the first. */
export function financialRuleOffsets(text: string): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [name, rule] of [...STAGE1, ...STAGE2]) {
    const offsets: number[] = [];
    rule(text, offsets);
    result[name] = offsets;
  }
  return result;
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
 * preceded or followed by one (hex, hashes, UUIDs, `0x…`). A `*` is not one:
 * it is a separator, typed or masked. */
function isGlue(ch: string | undefined): boolean {
  return isAlnum(ch) || ch === "_";
}

/** True when `text[end]` is a `*` after a run of 1 or 2 letters that starts a
 * token: the shape a kept prefix has once the rest of its token is masked
 * ("DE*********", "X*******"). Before the mask those letters were glued to
 * the letter or digit after them, so they count as glued here too, in the
 * first pass and in the second alike. */
function keptPrefixBefore(text: string, end: number): boolean {
  return text[end] === "*" && shortTail(text, end);
}

/** True when the letters just before `end` are a run of 1 or 2 letters that
 * starts its token. */
function shortTail(text: string, end: number): boolean {
  let k = end;
  while (k > 0 && isLetter(text[k - 1])) {
    k--;
    if (end - k > 2) return false;
  }
  return end - k >= 1 && !isGlue(text[k - 1]);
}

/** True when a candidate that ends just before `end` is glued to what follows. */
function gluedAfter(text: string, end: number): boolean {
  return isGlue(text[end]) || keptPrefixBefore(text, end);
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
    if (i < last) continue; // the same offset twice (two rules, one digit)
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

/** A run of digit groups: each group's first offset and its digits. */
interface Group { start: number; digits: string; sep: string }

/** Split a run of digits joined by spaces or dashes into its groups. */
function groupsOf(run: string, runStart: number): Group[] {
  const groups: Group[] = [];
  let sep = "";
  let i = 0;
  while (i < run.length) {
    if (isDigit(run[i])) {
      const from = i;
      while (i < run.length && isDigit(run[i])) i++;
      groups.push({ start: runStart + from, digits: run.slice(from, i), sep });
      sep = "";
    } else sep += run[i++];
  }
  return groups;
}

function pushGroup(out: number[], g: Group): void {
  for (let k = 0; k < g.digits.length; k++) out.push(g.start + k);
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
 * two separator characters (GROUP_SEP) between neighbours (any grouping, any
 * case). */
const IBAN_CANDIDATE = /(?<![0-9_])[A-Za-z]{2}\d{2}(?:[ \t.\/-]{0,2}[A-Za-z0-9]){11,30}/g;

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

function findIbans(text: string, out: number[]): void {
  IBAN_CANDIDATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IBAN_CANDIDATE.exec(text)) !== null) {
    const start = m.index;
    const length = IBAN_LENGTHS[m[0].slice(0, 2).toUpperCase()];
    let accepted = false;
    // After a letter, an IBAN starts only behind a short tail (1 or 2 letters
    // that start the token, "org.nrDE89..."), and then the whole token is
    // masked, the tail and the country code too: a kept letter there could
    // read as a word ("nr") once the rest is masked.
    let tail = 0;
    if (isLetter(text[start - 1])) {
      if (!shortTail(text, start)) { IBAN_CANDIDATE.lastIndex = start + 1; continue; }
      while (isLetter(text[start - tail - 1])) tail++;
    }
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
      if (end > 0 && !gluedAfter(text, end) && ibanChecksumOk(compact)) {
        if (tail > 0) for (let p = start - tail; p < start + 2; p++) out.push(p);
        for (const p of positions.slice(2)) out.push(p);
        IBAN_CANDIDATE.lastIndex = end;
        accepted = true;
      }
    }
    if (!accepted) IBAN_CANDIDATE.lastIndex = start + 1;
  }
}

// ---------------------------------------------------------------- CARD

/** A maximal run of digits with one or two separator characters between
 * groups. GROUP_SEP, the characters a card or an IBAN is typed with: space,
 * tab, dot, slash, dash. Not a comma, `+` or `:` (they join lists, phone
 * numbers and times), and never `*` (R3). */
const DIGIT_RUN = /(?<![A-Za-z0-9_])\d(?:[ \t.\/-]{0,2}\d)*/g;

/** The card test: 13 to 19 digits, a first digit of 2 to 6, Luhn valid.
 * findCards runs it with a running Luhn sum over each span. */

/** A number that passes the card test is masked wherever it stands: no guard
 * word, `+` or `#` keeps it, and any grouping counts. A card is any span of
 * consecutive whole digit groups, joined by one or two GROUP_SEP characters in
 * any mix, that holds 13 to 19 digits and passes the card test ("4111111111111111",
 * "4111 1111 1111 1111 12/27", "3782 822463 10005", "4111 1111-1111 1111",
 * "4111.1111.1111.1111", "4222 2222 2222 2"). Every span is tested (every start, every length) and
 * the masks are a union, so any span of a shorter run left between masked
 * groups was already tested on the whole run. */
function findCards(text: string, out: number[]): void {
  for (const m of text.matchAll(DIGIT_RUN)) {
    const run = m[0];
    if (run.length < 13) continue; // fewer than 13 digits: never a card
    const groups = groupsOf(run, m.index);
    // A last group glued to what follows it (a letter, `_`) is part of
    // something else (hex, a hash) and is no card digit; the groups before it
    // are still read ("4222222222222 4111111111111111x" masks the first).
    if (isGlue(text[m.index + run.length])) groups.pop();
    // Each group is pushed once per run however many spans hold it, and the
    // Luhn sum of a span grows by one digit at a time, so a run costs at most
    // 19 steps per group ("4 4 4 ...": every 17 fours pass the card test).
    let pushedTo = -1;
    for (let i = 0; i < groups.length; i++) {
      const first = groups[i].digits[0];
      if (first < "2" || first > "6") continue; // no card starts here
      // Two running sums over the span's digits, left to right: one doubling
      // the digits at even offsets, one doubling those at odd offsets. The
      // Luhn sum doubles every second digit counted from the right, so a span
      // of `length` digits uses the first sum when `length` is even.
      let doubledEven = 0;
      let doubledOdd = 0;
      let length = 0;
      for (let j = i; j < groups.length && length <= 19; j++) {
        const g = groups[j].digits;
        for (let k = 0; k < g.length && length <= 19; k++, length++) {
          const d = g.charCodeAt(k) - 48;
          const twice = d * 2 > 9 ? d * 2 - 9 : d * 2;
          if (length % 2 === 0) { doubledEven += twice; doubledOdd += d; } else { doubledEven += d; doubledOdd += twice; }
        }
        if (length < 13 || length > 19) continue;
        if ((length % 2 === 0 ? doubledEven : doubledOdd) % 10 !== 0) continue;
        for (let k = Math.max(i, pushedTo + 1); k <= j; k++) pushGroup(out, groups[k]);
        pushedTo = Math.max(pushedTo, j);
      }
    }
  }
}

// ---------------------------------------------------------------- ROUTING

const ROUTING_WORD = /(?<![A-Za-z0-9_])(?:routing|aba|rtn|transit)(?![A-Za-z0-9_])/gi;
/** Characters after the routing word in which the number must start. */
const ROUTING_WINDOW = 24;

function abaOk(d: string): boolean {
  const prefix = Number(d.slice(0, 2));
  const prefixOk = (prefix >= 0 && prefix <= 12) || (prefix >= 21 && prefix <= 32) || (prefix >= 61 && prefix <= 72) || prefix === 80;
  if (!prefixOk) return false;
  const n = (k: number) => d.charCodeAt(k) - 48;
  const sum = 3 * (n(0) + n(3) + n(6)) + 7 * (n(1) + n(4) + n(7)) + (n(2) + n(5) + n(8));
  return sum % 10 === 0;
}

/** `\d{3}[ -]?\d{3}[ -]?\d{3}` at `start`: the offsets of its nine digits and
 * where it ends, or null. */
function readNine(text: string, start: number): { digits: number[]; end: number } | null {
  const digits: number[] = [];
  let p = start;
  for (let part = 0; part < 3; part++) {
    if (part > 0 && (text[p] === " " || text[p] === "-") && isDigit(text[p + 1])) p++;
    for (let k = 0; k < 3; k++, p++) {
      if (!isDigit(text[p])) return null;
      digits.push(p);
    }
  }
  return { digits, end: p };
}

/** Every ABA-valid nine digit number that starts within 24 characters after a
 * routing word on the same line, whatever sits between ("routing 4111111111111111
 * 021000021", "routing 021000021 011000015-4811832"). */
function findRouting(text: string, out: number[]): void {
  for (const m of text.matchAll(ROUTING_WORD)) {
    const wordEnd = m.index + m[0].length;
    const limit = Math.min(text.length - 1, wordEnd + ROUTING_WINDOW);
    for (let s = wordEnd; s <= limit; s++) {
      const ch = text[s];
      if (ch === "\n" || ch === "\r") break;
      if (!isDigit(ch) || isGlue(text[s - 1])) continue;
      const nine = readNine(text, s);
      if (!nine || isGlue(text[nine.end])) continue;
      if (abaOk(nine.digits.map((i) => text[i]).join(""))) for (const i of nine.digits) out.push(i);
    }
  }
}

// ---------------------------------------------------------------- context-gated ids (SSN, TAX_ID, NATIONAL_ID)

/** Characters after the context word in which the identifier must start. */
const CONTEXT_WINDOW = 32;

// A context word ends before anything but a letter or `_`; findContextIds
// drops one before a digit unless it ends in a short run (shortTail).
const SSN_CONTEXT = /(?<![A-Za-z0-9_])(social[ -]security|taxpayer[ \t]+id|itin|ssn|ssa|tin)(?![A-Za-z_])/gi;
const TAX_CONTEXT = new RegExp(
  "(?<![A-Za-z0-9_])(" +
    [
      "employer identification", "employer id", "tax number", "tax id", "federal id", "USt-IdNr", "Steuer-ID", "Steuernummer",
      "codice fiscale", "partita IVA", "organisationsnummer", "org\\.nr", "Y-tunnus", "SIRET", "SIREN", "CNPJ", "REGON", "PESEL",
      "EIN", "VAT", "UID", "ABN", "ACN", "GST", "HST", "BN", "NIF", "CIF", "IdNr", "CPF", "RFC", "CUIT", "RUT", "RUC", "NIP",
      "BSN", "KvK", "CVR",
    ].map((w) => w.replace(/ /g, "[ \\t]+")).join("|") +
    ")(?![A-Za-z_])",
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
    ")(?![A-Za-z_])",
  "gi",
);

/** Account words open an id window; a sort code or BSB word does not (its
 * codes are read by shape, so a date after it stays). */
const ACCOUNT_CONTEXT = /(?<![A-Za-z0-9_])(account|acct|a\/c)(?![A-Za-z_])/gi;

/** A parsed identifier: the offsets to mask and where it ends. */
interface Parsed { mask: number[]; end: number }
/** `itin` is true when the start lies in the window of an ITIN, TIN or
 * taxpayer id word: only the SSN parser reads it. */
type Parser = (text: string, start: number, itin: boolean) => Parsed | null;

/** The words under which a 9xx area is an ITIN, not an invalid SSN. */
const ITIN_WORDS = new Set(["itin", "tin"]);

/** Ids that start inside a window after a context word. The windows are
 * positions, fixed by where the words are, and EVERY token start in them is
 * tried, also one inside an id already accepted from an earlier start (that
 * id may end before the next one: "EIN 12-1273819, <card> 59-3426150-<card>"
 * reads the card and 59 as one id from the card's start, and 59-3426150 from
 * its own). Each try reads a bounded number of characters (parseIdentifier
 * stops a token at 21), so the scan is linear. */
function findContextIds(text: string, context: RegExp, parse: Parser, out: number[]): void {
  // [from, to, itin], in text order (matchAll does not overlap).
  const windows: [number, number, boolean][] = [];
  for (const m of text.matchAll(context)) {
    const wordEnd = m.index + m[0].length;
    // A word ends before anything but a letter or `_`. Before a digit it is a
    // word only when it ends in a run of 1 or 2 letters that starts its token
    // ("BN", "Steuer-ID", "org.nr", "ID no"): such a run can be a kept prefix,
    // "BN*****" once "BN12345678" is masked, and it must open the same window
    // before the mask as after it. "BN* 809123456" is read the same way.
    if (isDigit(text[wordEnd]) && !shortTail(text, wordEnd)) continue;
    let to = Math.min(text.length, wordEnd + CONTEXT_WINDOW);
    for (let k = wordEnd; k < to; k++) if (text[k] === "\n" || text[k] === "\r") { to = k; break; }
    const word = m[1].toLowerCase();
    windows.push([wordEnd, to, word.startsWith("taxpayer") || ITIN_WORDS.has(word)]);
  }
  let w = 0;
  let anyTo = 0;
  let itinTo = 0;
  let p = 0;
  for (;;) {
    while (w < windows.length && windows[w][0] <= p) {
      anyTo = Math.max(anyTo, windows[w][1]);
      if (windows[w][2]) itinTo = Math.max(itinTo, windows[w][1]);
      w++;
    }
    if (p >= anyTo) {
      if (w >= windows.length) return;
      p = Math.max(p, windows[w][0]);
      continue;
    }
    const ch = text[p];
    if (!isAlnum(ch) || isGlue(text[p - 1])) { p++; continue; }
    if (isLetter(ch)) {
      // A word of letters only that cannot open an id (lowercase, or longer
      // than a two-letter prefix) is passed over whole.
      let q = p;
      let upper = true;
      while (isLetter(text[q])) { if (text[q] > "Z") upper = false; q++; }
      if (!isDigit(text[q]) && (!upper || q - p > 2)) { p = q; continue; }
    }
    const parsed = parse(text, p, p < itinTo);
    if (parsed) for (const i of parsed.mask) out.push(i);
    p++;
  }
}

function inRange(n: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([a, b]) => n >= a && n <= b);
}
const ITIN_GROUPS = [[70, 88], [90, 92], [94, 99]] as const;

/** `\d{3}[ -]?\d{2}[ -]?\d{4}` at `start`, not glued, valid as an SSN (or an
 * ITIN in an ITIN, TIN or taxpayer id window). */
function parseSsn(text: string, start: number, itin: boolean): Parsed | null {
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
  if (area >= 900 && (!itin || !inRange(group, ITIN_GROUPS))) return null;
  return { mask: digits, end: p };
}

interface Token { start: number; end: number; digits: number; hasDigit: boolean }

/** An identifier of 6 to 20 letters or digits with single spaces, dashes, dots
 * or slashes between them, at least four digits. Tokens are letter-or-digit
 * runs (a `*` ends one and never joins two); a token with a digit always
 * belongs; a letters-only token belongs only as an uppercase prefix of one or
 * two letters before a token with a digit (`GB 123 4567 89`, `AB 12 34 56 C`)
 * or a single uppercase letter at the end. Lowercase words end it, so "is on
 * the 2026-10-23 letter" yields the date. A token that would take the id past
 * 20 characters ends it before that token (the scan reads the rest on its
 * own). A last token glued to what follows is dropped and the rest is tried:
 * the limits are all "at least", so a shorter chain never passes where the
 * longer one failed. */
function parseIdentifier(text: string, start: number): Parsed | null {
  const tokens: Token[] = [];
  let length = 0;
  let lastHadDigit = false;
  let p = start;
  while (p < text.length) {
    const tokStart = p;
    let digits = 0;
    let upper = true;
    // A token is read to at most 21 characters: past 20 it ends the id
    // either way, and the scan tries every start, so reading on would make
    // it quadratic in a long token.
    while (isAlnum(text[p]) && p - tokStart <= 20) {
      if (isDigit(text[p])) digits++;
      else if (text[p] < "A" || text[p] > "Z") upper = false;
      p++;
    }
    const len = p - tokStart;
    if (len > 20) {
      if (tokens.length === 0) return null; // one token longer than any id: not one
      break; // it would take the id past 20 characters
    }
    const hasDigit = digits > 0;
    let belongs = hasDigit;
    let stop = false;
    if (!hasDigit) {
      if (tokens.length === 0 && upper && len <= 2) belongs = true; // a prefix: kept only if a digit token follows
      else if (tokens.length > 0 && lastHadDigit && upper && len === 1) { belongs = true; stop = true; } // a one-letter suffix
    }
    if (!belongs || (tokens.length === 1 && !lastHadDigit && !hasDigit)) break;
    if (tokens.length > 0 && length + len > 20) break;
    tokens.push({ start: tokStart, end: p, digits, hasDigit });
    length += len;
    lastHadDigit = hasDigit;
    if (stop) break;
    const sep = text[p];
    if ((sep === " " || sep === "-" || sep === "." || sep === "/") && isAlnum(text[p + 1])) p++;
    else break;
  }
  if (tokens.length === 0) return null;
  if (gluedAfter(text, tokens[tokens.length - 1].end)) tokens.pop();
  if (tokens.length === 0 || !tokens.some((t) => t.hasDigit)) return null;
  let total = 0;
  let digitCount = 0;
  for (const t of tokens) {
    total += t.end - t.start;
    digitCount += t.digits;
  }
  if (total < 6 || digitCount < 4) return null;
  // The kept prefix: the token's whole leading letter run when it is 1 or 2
  // letters ("DE123456789", "X1234567", "AB 12 34 56 C"). A longer run is
  // masked whole ("ABCDE1234F"): a kept letter is then always one that stood
  // before a digit or a separator, which is what shortTail reads the same
  // before the mask and after it.
  let run = 0;
  while (isLetter(text[start + run])) run++;
  const keep = run <= 2 ? run : 0;
  const mask: number[] = [];
  for (const t of tokens) for (let i = Math.max(t.start, start + keep); i < t.end; i++) mask.push(i);
  return { mask, end: tokens[tokens.length - 1].end };
}

// ---------------------------------------------------------------- ACCOUNT_PHRASE

const ACCOUNT_PHRASE = /(?<![A-Za-z0-9_])(account|acct|a\/c|sort[ -]?code|bsb)(?![A-Za-z0-9_])(?:[ \t]*(?:number|num|nr|no\.?|#)(?![A-Za-z0-9_]))?[ \t]*[:#*]?[ \t]*(\d(?:[ -]?\d)*)/gi;
/** Digits an account run needs. There is no upper limit: a run that a second
 * pass could cut shorter must not pass only then. */
const ACCOUNT_MIN_DIGITS = 6;

/** Every sort code (a 6 digit group, or 2-2-2 with one separator) or BSB (a 6
 * digit group, or 3-3) in the run, as group indexes to mask. Every position of
 * the run is read, so a run cut shorter by a mask beside it holds no code the
 * whole run did not ("sort code 4111111111111111 40-47-84" masks both;
 * "sort code 2026-10-24" is a date). */
function codeGroups(groups: Group[], sizes: readonly number[]): number[] {
  const take: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].digits.length === 6) take.push(i);
    if (i + sizes.length > groups.length) continue;
    let ok = true;
    for (let k = 0; k < sizes.length && ok; k++) ok = groups[i + k].digits.length === sizes[k];
    for (let k = 2; k < sizes.length && ok; k++) ok = groups[i + k].sep === groups[i + 1].sep;
    if (ok) for (let k = 0; k < sizes.length; k++) take.push(i + k);
  }
  return take;
}

/** The run of digit groups right after an account phrase: masked whole when it
 * holds at least six digits; after a sort code or BSB word, every code in it.
 * A last group glued to what follows is dropped, the rest is still read. */
function findAccountRuns(text: string, out: number[]): void {
  for (const m of text.matchAll(ACCOUNT_PHRASE)) {
    const run = m[2];
    const runStart = m.index + m[0].length - run.length;
    if (isGlue(text[runStart - 1])) continue;
    const groups = groupsOf(run, runStart);
    if (isGlue(text[runStart + run.length])) groups.pop();
    const word = m[1].toLowerCase();
    if (word.startsWith("sort") || word === "bsb") {
      for (const k of codeGroups(groups, word === "bsb" ? [3, 3] : [2, 2, 2])) pushGroup(out, groups[k]);
      continue;
    }
    let digits = 0;
    for (const g of groups) digits += g.digits.length;
    if (digits < ACCOUNT_MIN_DIGITS) continue;
    for (const g of groups) pushGroup(out, g);
  }
}

// ---------------------------------------------------------------- ENDING

/** "ending 4471", "last four digits of my card are 2222": four digits that
 * start their own token. */
const ENDING = /(?<![A-Za-z0-9_])(?:ending(?:[ \t]+(?:in|with))?|ends[ \t]+(?:in|with)|last[ \t]+(?:four|4)(?:[ \t]+digits)?)(?:[ \t]+of(?:[ \t]+[A-Za-z]+){1,3})?(?:[ \t]+(?:are|is))?[ \t]*:?[ \t]*(?<![A-Za-z0-9_])(\d{4})(?![A-Za-z0-9_])/gi;
const ENDING_CONTEXT = /(?<![A-Za-z])(?:account|acct|card|visa|mastercard|amex|iban|checking|savings|debit|credit)/i;

function findEndings(text: string, out: number[]): void {
  for (const m of text.matchAll(ENDING)) {
    const window = lineBefore(text, m.index, 48) + m[0];
    if (!ENDING_CONTEXT.test(window)) continue;
    const start = m.index + m[0].length - 4;
    for (let i = 0; i < 4; i++) out.push(start + i);
  }
}
