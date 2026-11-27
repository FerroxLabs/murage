// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 cause B (deep1022-causeB-design/DESIGN.md sections 2-4, with the FABLE design review's H1-H3 and the ASTRA notes folded
// in, MAIN-RULING 2026-11-24T19:07:24Z). Owners: the value recorder and the masked-value view = harness (this file,
// audience-collector.ts intake, bus.ts hand-over per event); the policy's latch payload = redact-turn.ts; the owner reply rule that
// reads the view = owner-display.ts; rulings = MAIN.
//
// What it is for: one credential in a turn (a tool result, a reply, reasoning) latches the turn, and until 1.0.21 every later reply
// of that turn was held back from the owner, harmless or not. The recorder keeps WHAT the turn masked (derived forms only), so the
// owner's reply rule can hold back only a reply that repeats one of those values. Whenever the recorder cannot prove the list is
// whole it says so (complete:false) and every later reply keeps the 1.0.21 outcome. Nothing here is ever logged.
import { SECRET_SCAN_BUDGET } from "../../shared/md-secret-label.mjs";
import { CONTEXT_LIMIT, checkTurnUnit, type Scanner } from "../redact-stream-release.ts";
import { redactCredentialShapesInText } from "../redact.ts";

/** One value the turn's policy masked. Only derived forms are kept; the raw span is dropped once these are built. */
/** `shape` (q1023-rcready, MAIN-RULING 2026-11-26T21:44:41Z): recorded from a span that is a PEM private-key body or holds a
 * high-precision credential shape (redact.ts redactCredentialShapesInText: PEM, Bearer, JWT, vendor-prefix keys). Only these values
 * are masked in place in the owner's own chat (owner-display.ts credentialGradeView); every other value keeps option B (shown). */
export type MaskedValue = Readonly<{ norm: string; mixed: boolean; cls: MaskedClass; shape?: true }>;
/** q1023-heldscan: what KIND of token a masked value is. Only this name is ever logged (never the value, a length or an index). */
export type MaskedClass = "uuid" | "digest" | "base64" | "url" | "digits" | "region-line" | "encoded" | "word" | "other";
export type Incomplete = "unproven-latch" | "unmatched-hit" | "scan-limit" | "bound" | "blind" | "tail-evicted" | "recorder-error" | "unavailable";
/** What the host may read for ONE execution event: an immutable snapshot taken at that event's intake. */
export type MaskedValueView = Readonly<{
  /** false = no proof of what was masked; the host keeps the 1.0.21 outcome. */
  complete: boolean;
  /** The first reason `complete` went false (a log code only). */
  reason?: Incomplete;
  /** Deduplicated by norm, insertion order. Each masked value, and its encoded forms (base64, hex, reversed). */
  values: readonly MaskedValue[];
  /** Every MIXED_GRAM-char window of a value's norm that is itself mixed. */
  gramsMixed: GramSet;
  /** Every ANY_GRAM-char window of any value's norm (single-class values: passphrases, long digit runs). */
  gramsAny: GramSet;
  /** Raw last CARRY chars of the PREVIOUS assistant item of this admission ("" for the first). */
  carry: string;
}>;
/** The windows as of one snapshot. Only membership is read (design: ReadonlySet; a snapshot shares the recorder's table and sees
 * the windows that existed when it was taken, so handing one out per event copies nothing). */
export type GramSet = Readonly<{ has(gram: string): boolean; /** the class of the value the window came from (a log code) */ classOf?(gram: string): MaskedClass | undefined }>;
/** The carriers of one intake, as the collector's extractor built them (structural: redact-turn.ts ManifestBatch). */
type Carrier = Readonly<{ path: string; stream: string; mode: "delta" | "whole" | "snapshot"; text: string }>;
type Batch = Readonly<{ carriers: readonly Carrier[]; terminal?: string }>;
export interface MaskedValueRecorder {
  /** Every carrier of one intake of the admission. Before the latch only bounded raw tails are kept; after it the text is scanned. */
  absorb(batch: Batch, type: string, stream: string): void;
  /** The intake whose decision latched the turn: what the policy found, then the catch-up over the batch and every open stream. */
  latch(found: readonly string[], kind: "hit" | "unproven" | undefined, batch: Batch, type: string, stream: string): void;
  /** Sticky for the admission. */
  incomplete(reason: Incomplete): void;
  /** Copy-on-write snapshot, frozen. */
  view(): MaskedValueView;
  /** A re-dispatch of the same owner message: the earlier attempt's values carry (design section 4). */
  carryFrom(previous: MaskedValueView | undefined): void;
}

/** Each bound is a fail-closed edge (past it the list is not proven whole), never a display cap of a clean turn. BACK_PIECES is the
 * policy's own (redact-turn.ts): how many take-backs of one item are read. PEEL: how many labels one wrapped region is read for.
 * q1023-heldbound (MAIN-RULING 2026-11-26T18:44:07Z (A)): VALUE_MAX was 512, so one private key, JWT or cookie header a tool printed
 * (a service-account JSON's one-line PEM is 1.7 to 3 KB) was cut, the list was not whole and every later reply of the owner's turn
 * was held. A value is now recorded whole up to 16 KiB (every window of it, and its encoded forms), the turn's total and its count
 * of distinct values are sized for several such values plus the PEM body lines of a few certificates; past them it still fails closed. */
export const MASKED_VALUE_BOUNDS = Object.freeze({ MAX_VALUES: 1024, VALUE_MAX: 16 * 1024, VALUES_TOTAL: 128 * 1024, TAIL: CONTEXT_LIMIT, OPEN_TAILS: 32, ITEM_MAX: 1024 * 1024, CARRY: 512, BACK_PIECES: 8, CHAIN_TAILS: 16, PEEL: 64,
  /** One-shot fields whose end is kept for the next rewrite of the same field, and how much of each. */
  FIELDS: 8192, FIELD_TAIL: 512, SHED_FIELDS: 16_384,
  /** Characters one admission's recorder reads after the latch, all readings together. */
  READ_TOTAL: 64 * 1024 * 1024,
  /** PART rule windows. Design 2.3 says 8 for a mixed window; the attack set's EXT-L3 row (three replies, six characters of the
   * value in each) is a reply 1.0.21 held, so a mixed window is 6. A window of one class stays 12. */
  MIXED_GRAM: 6, ANY_GRAM: 12 });
const { MAX_VALUES, VALUE_MAX, VALUES_TOTAL, TAIL, OPEN_TAILS, ITEM_MAX, CARRY, BACK_PIECES, CHAIN_TAILS, PEEL, FIELDS, FIELD_TAIL, SHED_FIELDS, READ_TOTAL, MIXED_GRAM, ANY_GRAM } = MASKED_VALUE_BOUNDS;

const STRIP = /[\s\p{M}\p{Cf}­`'"*_~|>\\]/gu;
/** Both sides of the match use this: compatibility decomposition (NFKD), lower case, then combining marks and variation selectors,
 * whitespace, zero-width/format characters and the markdown and quoting characters removed. Removing more only finds more matches
 * (fail closed). Design 2.2 says NFKC; ASTRA N2: a combining mark put after each letter composes under NFKC and hid the value, so
 * the decomposed form with its marks removed is used on both sides. */
export function normValue(text: string): string { return fold(text.normalize("NFKD").toLowerCase().replace(STRIP, "")); }
/** Letters of another alphabet that read as a Latin letter (the attack set's lookalike row; Cyrillic and Greek): folded to that
 * letter on both sides, so a value written with them is still the value. */
const LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
  "\u0430": "a", "\u0432": "b", "\u0435": "e", "\u043a": "k", "\u043c": "m", "\u043d": "h", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0442": "t", "\u0443": "y", "\u0445": "x",
  "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04bb": "h", "\u04cf": "l", "\u0261": "g",
  "\u03b1": "a", "\u03b2": "b", "\u03b5": "e", "\u03b6": "z", "\u03b7": "h", "\u03b9": "i", "\u03ba": "k", "\u03bc": "m", "\u03bd": "v", "\u03bf": "o", "\u03c1": "p", "\u03c4": "t", "\u03c5": "y", "\u03c7": "x" });
const FOLDABLE = /[\u0261\u03b1-\u03c7\u0430-\u0458\u04bb\u04cf\u0501]/g;
const fold = (text: string) => text.replace(FOLDABLE, ch => LOOKALIKES[ch] ?? ch);
/** Decomposed and lower case, with combining marks and format characters removed; everything else kept (whitespace, punctuation):
 * the text a SHORT value is looked for in, character by character with up to three other characters between two of them. */
export function lightValue(text: string): string { return fold(text.normalize("NFKD").replace(/[\p{M}\p{Cf}\u00AD]/gu, "").toLowerCase()); }
/** The letters and digits of a normalised form: a value repeated with other separators between its characters (ASTRA N2). */
export function skeletonValue(norm: string): string { return norm.replace(/[^\p{L}\p{N}]/gu, ""); }
const LETTER = /\p{L}/u, DIGIT = /\p{N}/u;
/** At least two of {letter, digit, other}. */
export function mixedValue(norm: string): boolean {
  let letter = false, digit = false, other = false;
  for (const ch of norm) { if (LETTER.test(ch)) letter = true; else if (DIGIT.test(ch)) digit = true; else other = true; if (+letter + +digit + +other >= 2) return true; }
  return false;
}
/** The text holds a high-precision credential shape (the rules the owner's own chat masks in place). A throw counts as a shape. */
const shapeSpan = (text: string) => { try { return redactCredentialShapesInText(text) !== text; } catch { return true; } };
/** q1023-rcready (MAIN-RULING 2026-11-26T23:37:25Z W9): the span's value stands right after a CREDENTIAL LABEL (`api_key=`, `token:`,
 * `password=`, joined labels): the line the span starts on, up to the end of the span's first line, names a credential by the same
 * matcher the shared-audience hold uses (namesCredentialWord). Such a value is an obvious key: the owner chat masks it in place. */
const labelledSpan = (text: string, span: Readonly<{ from: number; to: number }>) => {
  const start = text.lastIndexOf("\n", span.from - 1) + 1, nl = text.indexOf("\n", span.from);
  return namesCredentialWord(text.slice(start, nl < 0 || nl > span.to ? span.to : nl));
};
/** The part of a labelled span that is the label's own value: its first line, or, when that line holds the label alone
 * (`Authorization: Bearer`), up to the end of the next non-empty line. The later lines of a wrapped region (tool names, ids) are not
 * "right after the label" and stay option-B unsure values. */
const labelValueSpan = (text: string, span: Readonly<{ from: number; to: number }>) => {
  const lineEnd = (at: number) => { const nl = text.indexOf("\n", at); return nl < 0 || nl > span.to ? span.to : nl; };
  let to = lineEnd(span.from);
  if (!spanValues(text.slice(span.from, to)).length) for (let at = to + 1; at < span.to; at = to + 1) { to = lineEnd(at); if (text.slice(at, to).trim()) break; }
  return { from: span.from, to };
};
/** q1023-labelfloor (MAIN-RULING 2026-11-27T03:17:37Z): a value after a credential label is credential grade (masked in place in the owner
 * chat) only when it is 16 or more characters or itself holds a credential shape; a shorter labelled value (`token: D-4821`) is shown. */
const LABEL_FLOOR = 16;
const gradeValue = (value: string) => value.trim().length >= LABEL_FLOOR || shapeSpan(value);
const tokenShaped = (line: string) => line.length >= 12 && !/\s/.test(line) && mixedValue(normValue(line));
/** q1023-heldscan: an ordinary identifier a tool prints in a listing, never a credential's own line: a UUID, or a bare hex digest
 * (MD5, SHA-1, SHA-256, SHA-512 length). Used ONLY for a line that stands deep inside a masked region (past the label's own first
 * lines): there it is the next item of a list the label's span swallowed, not the value of the label. A UUID line (hyphenated, never
 * base64 key material) is skipped there always; a hex-digest-shaped line only inside a LISTING (three or more such id lines past the
 * first lines, no key block): a lone hex line after a label may be the credential itself, and key material may be hex-shaped
 * (ASTRA 1 and 2). A line the label itself
 * heads (the first lines) and any line of another shape (base64 key bodies, mixed-case tokens, URLs) stay recorded. */
const UUID_LINE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, DIGEST_LINE = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})$/i;
export const ordinaryIdLine = (line: string, digestsToo = false) => UUID_LINE.test(line.trim()) || (digestsToo && DIGEST_LINE.test(line.trim()));
/** q1023-heldscan r5 (MAIN-RULING 2026-11-26T17:44Z): a line that names a credential (`Authorization: Bearer <v>`, `api_key=<v>`,
 * `| password | <v> |`, `secret <v>`, `token: <v>`) is held whatever the shape of its value, a UUID included; so is the line right
 * after a line that only names one (`Authorization: Bearer`, then the value). The exemption for UUID lines is for plain id
 * listings only. */
/** The 1.0.23 r6 word match, kept whole so the suffix rule below can only ADD labels (a digit is a word boundary here: `password2`, `api key1`). */
const CREDENTIAL_LABEL = /(?<!\p{L})(?:pass(?:word|wd|phrase|code)?|pwd|secrets?|tokens?|keys?|apikeys?|auth(?:orization|orisation)?|bearer|cred(?:ential)?s?|(?:access|refresh|auth|bearer|session|id|client|secret|private|signing|bot|app|master|service|api)(?:token|key|secret)s?)(?!\p{L})/iu;
/** Fail closed (MAIN brief, Astra High q1023-rcready-r15): ANY single identifier word (letters and digits, any case, `_` / `-` / camelCase
 * start a new word) that ENDS in token, key, secret, passwd, password, pwd or credential(s) names a credential: `oauthtoken`,
 * `webhooksecret`, `encryptionkey`, `deploy_key`, `GithubToken`. A word that only happens to end in "key" is an ordinary word. */
const CREDENTIAL_SUFFIX = /(?:token|key|secret|passwd|password|pwd|credentials?)s?$/i;
const KEY_WORDS = /^(?:monkeys?|donkeys?|turkeys?|hockey|whiskeys?|jockeys?|lackeys?|mickeys?|turnkeys?|hickeys?)$/i;
/** A word of the line, not a part of one (the raw word AND the camelCase-split form are both tried, so `dbpassWord` and `myToKen` stay credentials) (`Bypass results` and `Keyboard shortcuts` name no credential); camelCase is split first (`AuthToken`). */
const labelWord = (w: string) => { const base = w.replace(/\d+$/, ""); return CREDENTIAL_SUFFIX.test(base) && !KEY_WORDS.test(base); };
const namesCredentialWord = (line: string) => CREDENTIAL_LABEL.test(line.replace(/([a-z])([A-Z])/g, "$1 $2")) || [line, line.replace(/([a-z\d])([A-Z])/g, "$1 $2")].some(text => text.split(/[^\p{L}\p{N}]+/u).some(labelWord));
/** A line that ONLY names a credential (`oauthtoken`, `hmackey`, `Authorization`, no colon): the value, a UUID included, is on the next line. */
const headsCredential = (line: string) => !UUID_LINE.test(line.trim()) && !DIGEST_LINE.test(line.trim()) && namesCredentialWord(line) && /[\p{L}\p{N}]/u.test(line);
const namesCredential = (line: string) => !UUID_LINE.test(line.trim()) && namesCredentialWord(line) && /[\p{L}\p{N}]/u.test(line) && /[\s:=]/.test(line.trim());
/** A word that is only the bare name of a credential (a heading or a scheme word); any other last word of a labelled line is its value, whatever it ends in. */
const BARE_LABEL = /^(?:pass(?:word|wd|phrase|code)?|pwd|secrets?|tokens?|keys?|apikeys?|auth(?:orization|orisation)?|bearer|cred(?:ential)?s?)$/i;
function credentialLineValues(line: string): string[] {
  const out: string[] = tokenShaped(line) ? [line] : [];
  const words = line.split(/[\s|,;:=()[\]{}<>"'`]+/).map(word => word.replace(EDGES, "")).filter(Boolean);
  // the label wins (MAIN-RULING 2026-11-27): everything after the label's own leading words is a value, listed whatever its character
  // classes, its length (3 or more characters) or its depth in the region, and even when it itself ends in a label word
  // (`password: sunshinekey`): a single-class hex credential past the first lines is not dropped by tokenShaped's mixed-class test.
  // The leading label words (`Authorization: Bearer`) are not values; a last word that is not a bare credential name never counts as one.
  let at = 0;
  while (at < words.length && namesCredentialWord(words[at]!) && !(at === words.length - 1 && at > 0 && !BARE_LABEL.test(words[at]!))) at++;
  for (const [i, w] of words.entries()) if (tokenShaped(w) || (i >= at && w.length >= 3)) out.push(w);
  return out;
}
/** The class name of one masked value's raw text. */
export function classOfValue(raw: string): MaskedClass {
  const t = raw.trim();
  if (UUID_LINE.test(t)) return "uuid";
  if (DIGEST_LINE.test(t)) return "digest";
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t)) return "url";
  if (/^[\d\s.-]{8,}$/.test(t) && /\d{8}/.test(t.replace(/[\s.-]/g, ""))) return "digits";
  if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(t) && mixedValue(normValue(t))) return "base64";
  if (/^\p{L}{1,11}$/u.test(t)) return "word";
  return "other";
}
/** FABLE design review H1: a compatibility rule's span is its WHOLE match, label included (`DB_PASSWORD=<v>`, `?token=<v>`,
 * `Bearer <v>`, `authorization: Basic <v>`), so a one-class value of 8 to 11 characters repeated bare matched nothing. The value is
 * what stands after the label's separator, less a scheme word and quotes; the label is never a value. A span with no label is its
 * own value. */
const LABELLED = /^[?&]?([A-Za-z0-9_.-]{1,64})["']?\s*[=:]\s*["']?([^\s"'][^\n]*?)["']?$/;
/** FABLE 4f1bc47bb3 H1: `name=value` is only a reading of the text. A span or a region line with NO label (the scanner's region
 * starts after its marked label) can hold `=` or `:` inside the value itself (base64 padding `<tok>==`, `aaa:bbb`), and cutting at
 * it kept `=` or the tail alone. The head is taken for a label, and left out, only when it NAMES a credential (the words the
 * label rules fire on) and something with a letter or digit follows it; in every other case the WHOLE text is recorded as a value,
 * and the part after the separator as well. */
const NAMES_CREDENTIAL = /pass|pwd|secret|token|key|auth|cred|bearer|session|cookie|signature|private|access|api|login|pin\b/i;
const HAS_WORD = /[\p{L}\p{N}]/u;
const SCHEME = /^(?:bearer|basic|token|digest)\s+(\S[^\n]*)$/i;
const TOKEN_RUN = /[A-Za-z0-9._~+/=-]+/g;
export function spanValues(slice: string): string[] {
  const whole = slice.trim();
  if (!whole) return [];
  const labelled = LABELLED.exec(whole), tail = labelled?.[2];
  let value = tail !== undefined && HAS_WORD.test(tail) ? tail : whole;
  value = SCHEME.exec(value)?.[1] ?? value;
  // the whole text first when its head is not a credential's name: it may be the value itself
  const out = value !== whole && labelled && !NAMES_CREDENTIAL.test(labelled[1]!) && !SCHEME.test(whole) ? [whole, value] : [value];
  // a lead character a rule kept in its match (a quote, a bracket): the longest run of credential characters is the token itself
  let longest = "";
  for (const run of value.match(TOKEN_RUN) ?? []) if (run.length > longest.length) longest = run;
  if (longest.length >= 8 && longest !== value && !/\s/.test(value)) out.push(longest);
  return out;
}

const EDGES = /^[\s()[\]{}<>,;:.!?"'`*_~|]+|[\s()[\]{}<>,;:.!?"'`*_~|]+$/g;
/** One of the first lines of a region. `name: value` (H1): its value, never the line with its label. Otherwise the line whole. A
 * value of several words (`sunshine (prod)`) is also each run of 8 or more credential characters, and on the label's own line
 * (`first`) each word of 4 or more characters: the words after the value must not hide it (self-review H2). */
function lineValues(line: string, first: boolean): string[] {
  const bare = line.replace(/^[\s>*+`~|-]+/, "");
  // spanValues gives the whole line first whenever its head is not a credential's name (FABLE 4f1bc47bb3 H1)
  const inner = spanValues(bare), whole = bare.trim(), labelled = inner.length > 0 && inner[0] !== whole;
  const out = labelled ? [...inner] : [line, ...inner.slice(1)];
  const value = labelled ? inner[0]! : inner.length > 1 ? inner[1]! : line;
  if (/\s/.test(value)) {
    for (const run of value.match(TOKEN_RUN) ?? []) if (run.length >= 8) out.push(run);
    if (first) for (const word of value.split(/\s+/)) { const w = word.replace(EDGES, ""); if (w.length >= 4) out.push(w); }
  }
  return out;
}

/** Design 2.1: the value text of one scan result's spans. A precise span is its value (spanValues). A wrapped span (a label whose
 * value the scanner could not bound: it masks to the end of the text) gives each of its first 3 non-empty lines, whole and as
 * `name: value`, plus every later token-shaped line; the recorder also reads the rest of the region for the labels after the first
 * (peel, FABLE H2). `open`: a wrapped span with no non-empty line yet (an OPEN LABEL: the value is still to come). `rest`: the text
 * after the first line of each wrapped region. */
export function maskedSpanValues(text: string, spans: readonly Readonly<{ from: number; to: number; wrapped?: boolean; pem?: boolean }>[]): { values: string[]; open: boolean; rest: string[] } {
  const values: string[] = [], rest: string[] = []; let open = false;
  for (const span of spans) {
    const region = text.slice(span.from, span.to), wrapped = span.wrapped === true;
    // a merged span can lose its wrapped flag (redact.ts scanTurnText: a compatibility span that starts at the label swallows the
    // wrapped one): a span of several lines is a region too, never one value
    const lined = wrapped || region.includes("\n");
    if (!lined) values.push(...spanValues(region));
    if (lined) {
      let lines = 0;
      // q1023-heldscan: only a UUID-shaped line past the label's first three lines is an ordinary id (the next item of a listing). A hex or
      // digest-shaped line may be the credential itself, so it is never freed, whatever else the region lists and however many UUIDs
      // or other hex lines sit beside it: hex never corroborates hex (MAIN-RULING c8799a0c77)
      const all = region.split("\n").map(raw => raw.trim()).filter(Boolean);
      let before = "";
      for (const line of all) {
        if (lines++ < 3) values.push(...lineValues(line, lines === 1));
        else if (namesCredential(line)) values.push(...credentialLineValues(line));
        else if (headsCredential(before) && (UUID_LINE.test(line) || line.length >= 3)) values.push(line);
        else if (tokenShaped(line) && !ordinaryIdLine(line)) values.push(line);
        before = line;
      }
      if (wrapped && lines === 0) open = true;
      const nl = region.indexOf("\n");
      if (nl >= 0 && region.slice(nl + 1).trim()) rest.push(region.slice(nl + 1));
    }
  }
  return { values, open, rest };
}
/** The values on credential-LABELLED lines of each wrapped or multi-line region, at every depth (the same lines, by the same
 * matcher, as maskedSpanValues records them): credential grade, so the owner's own chat masks them in place (MAIN-RULING 2026-11-27). */
export function labelledRegionValues(text: string, spans: readonly Readonly<{ from: number; to: number; wrapped?: boolean }>[]): string[] {
  const out: string[] = [];
  for (const span of spans) {
    const region = text.slice(span.from, span.to);
    if (span.wrapped !== true && !region.includes("\n")) continue;
    let before = "";
    for (const line of region.split("\n").map(raw => raw.trim()).filter(Boolean)) {
      // every depth, the first three lines too (ASTRA/FABLE q1023-heldscan 3f7013d354: `| secret | <v> |` on line 2 or 3, a bare heading then the value)
      if (namesCredential(line)) out.push(...credentialLineValues(line).filter(gradeValue));
      else if (headsCredential(before) && (UUID_LINE.test(line) || line.length >= 3) && gradeValue(line)) out.push(line);
      before = line;
    }
  }
  return out;
}

/** The view of a turn nothing can be said about (no recorder, no entry for the event): the host keeps the 1.0.21 outcome. */
const NO_GRAMS: GramSet = Object.freeze({ has: () => false });
export const UNAVAILABLE_VIEW: MaskedValueView = Object.freeze({ complete: false, reason: "unavailable" as const, values: Object.freeze([]), gramsMixed: NO_GRAMS, gramsAny: NO_GRAMS, carry: "" });

const clip = (text: string) => text.length > TAIL ? text.slice(-TAIL) : text;
const chainOf = (stream: string) => /(?:^|:)(assistant|reasoning)$/.exec(stream)?.[1] ?? "other";
/** Two texts read as one line, and as two lines (the policy's item boundary, redact-stream-release.ts joinItems). */
const joins = (left: string, right: string) => !left ? [] : left.endsWith("\n") ? [left + right] : [left + right, `${left}\n${right}`];

// tail: the item's text so far (bounded). pieces: what the item took back, one piece per take-back (content.reset). pend: text not
// read yet (after the latch).
// cut: text of this item was let go before the latch without the recorder reading it.
type Open = { tail: string; pieces: string[]; pend: string; cut?: boolean };

export function createMaskedValueRecorder(options: { scan?: Scanner } = {}): MaskedValueRecorder {
  let latched = false, complete = true, reason: Incomplete | undefined, total = 0, detections = 0;
  // every table only grows; a snapshot is the table as of a sequence number (no copy per event)
  const values: MaskedValue[] = [], norms = new Set<string>(), gramsMixed = new Map<string, number>(), gramsAny = new Map<string, number>();
  let cached: MaskedValueView | undefined, read8 = 0;
  // the end of each one-shot field, for the next rewrite of the same field (the policy joins a field's rewrite to its earlier
  // value, redact-turn.ts whole.clean(s.emitted + c.text): a tool call's input and its result share their preview fields)
  const fields = new Map<string, string>(), shed = new Set<string>();
  // the end of the previous one-shot field of the same kind (the same event type and path: one tool result, then the next), read
  // joined to the next one after the latch: a label at the end of one tool result and its value at the start of the next
  const kinds = new Map<string, string>();
  let carry = "", viewCarry = "", count = 0; // count: distinct masked values (their encoded forms are not counted)
  // chains: every way the text before the chain's next item can be read (the previous item, and that item after each run of the
  // pieces it took back)
  const streams = new Map<string, Open>(), chains = new Map<string, string[]>();
  const incomplete = (why: Incomplete) => { if (complete) { complete = false; reason = why; cached = undefined; } };
  const put = (norm: string, cls: MaskedClass, shape = false) => {
    if (!norm) return;
    // a value seen first outside a credential shape and then inside one is a credential: fail closed, the mark is never dropped
    if (norms.has(norm)) { const at = shape ? values.findIndex(value => value.norm === norm && !value.shape) : -1; if (at >= 0) { values[at] = Object.freeze({ ...values[at]!, shape: true as const }); cached = undefined; } return; }
    norms.add(norm); values.push(Object.freeze({ norm, mixed: mixedValue(norm), cls, ...(shape ? { shape: true as const } : {}) }));
    const seq = values.length;
    for (let i = 0; i + MIXED_GRAM <= norm.length; i++) { const gram = norm.slice(i, i + MIXED_GRAM); if (mixedValue(gram) && !gramsMixed.has(gram)) gramsMixed.set(gram, seq); }
    for (let i = 0; i + ANY_GRAM <= norm.length; i++) { const gram = norm.slice(i, i + ANY_GRAM); if (!gramsAny.has(gram)) gramsAny.set(gram, seq); }
    cached = undefined;
  };
  const add = (raw: string, cls?: MaskedClass, shape = false) => {
    let value = raw;
    if (value.length > VALUE_MAX) { incomplete("bound"); value = value.slice(0, VALUE_MAX); }
    const norm = normValue(value);
    if (!norm) return;
    if (norms.has(norm)) { if (shape) put(norm, cls ?? classOfValue(value), true); return; }
    if (total + value.length > VALUES_TOTAL) { incomplete("bound"); return; }
    if (++count > MAX_VALUES) { incomplete("bound"); return; }
    const kind = cls ?? classOfValue(value);
    total += value.length; put(norm, kind, shape);
    // ASTRA N1: the value repeated in an encoded form (base64, hex, written backwards) is the value too. A value of 8 or more
    // characters only: the encoded form of a short word is not a finding of its own.
    if (norm.length >= 8) {
      try {
        const bytes = Buffer.from(value, "utf8");
        for (const form of [bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url"), bytes.toString("hex"), [...value].reverse().join("")]) put(normValue(form), "encoded");
      } catch { incomplete("recorder-error"); }
    }
  };
  /** One READING: one scan of one text, budgeted per character like the policy's own unit check. `continues`: later text of the
   * same stream or chain is read joined to this one, so an open label here is completed there. */
  const read = (text: string, continues = true, depth = 0, unitAt = -1) => {
    if (!text) return;
    // one admission's readings are bounded together: past it nothing more is read and the list is not claimed whole
    if ((read8 += text.length) > READ_TOTAL) { incomplete("scan-limit"); return; }
    let result;
    try { result = checkTurnUnit(text, SECRET_SCAN_BUDGET, options.scan); } catch { incomplete("scan-limit"); return; }
    if (result.exhausted) { incomplete("scan-limit"); return; }
    if (!result.detected) return;
    // the label scanner marks a span it could not bound (`wrapped`); the unit result's type does not name that field
    const spans: readonly Readonly<{ from: number; to: number; wrapped?: boolean; pem?: boolean }>[] = result.spans ?? [];
    // a finding the scanner gave no extent for cannot be recorded
    if (!spans.length) { incomplete("scan-limit"); return; }
    detections++;
    const { values: found, open: openLabel, rest } = maskedSpanValues(text, spans);
    // q1023-rcready: the values of a PEM body span, of a span holding a credential shape, or of a span right after a credential
    // label (MAIN-RULING 23:37:25Z W9) are marked `shape` (credential grade: masked in place in the owner chat)
    const sure = spans.filter(span => span.pem === true || shapeSpan(text.slice(span.from, span.to)));
    const labelled = spans.filter(span => !sure.includes(span) && labelledSpan(text, span)).map(span => labelValueSpan(text, span));
    // a value on a credential-labelled line deep in a wrapped region is credential grade too (label wins, MAIN-RULING 2026-11-27); a
    // labelled value under the 16-character floor with no credential shape is not (MAIN-RULING 2026-11-27T03:17:37Z)
    const shaped = new Set([...maskedSpanValues(text, sure).values, ...maskedSpanValues(text, labelled).values.filter(gradeValue), ...labelledRegionValues(text, spans)]);
    for (const value of found) add(value, undefined, shaped.has(value));
    // The unit read here (from `unitAt`) lies inside a region a label BEFORE it opened (a marked label in the previous item or in a
    // taken-back piece masks to the end of the text): every line of the unit is then masked text, not only the region's first lines.
    if (unitAt >= 0 && spans.some(span => span.wrapped === true && span.from <= unitAt && span.to > unitAt)) for (const line of text.slice(unitAt).split("\n")) if (line.trim()) add(line.trim(), "region-line");
    // an OPEN LABEL is read joined to the next text of its stream or chain; a field that has no next text (a whole carrier) leaves
    // a value the recorder will never see labelled, so the list cannot be claimed whole
    if (openLabel && !continues) incomplete("unmatched-hit");
    // PEEL (FABLE H2): a wrapped label masks to the end of the text and the scan stops there; the labels after it in the region
    // (an indented config with two credentials) are read as text of their own, label by label
    for (const later of rest) { if (depth >= PEEL) { incomplete("bound"); break; } read(later, true, depth + 1); }
  };
  const open = (key: string): Open => {
    let s = streams.get(key);
    if (!s) {
      if (streams.size >= OPEN_TAILS) { incomplete("tail-evicted"); streams.delete(streams.keys().next().value as string); }
      s = { tail: "", pieces: [], pend: "" }; streams.set(key, s);
    }
    return s;
  };
  /** Every contiguous run of taken-back pieces (FABLE H3; the policy's own reading set, redact-turn.ts retract: `Checking config`,
   * reset, `api_key=`, reset, `<v>` is caught on the run `api_key=`, not on all pieces joined). ASTRA 4f1bc47bb3: the policy keeps
   * the runs that ended at EARLIER take-backs too (retract: s.back = [...back, ...runs]) and reads later text after each, so a
   * label taken back first, then other words taken back, then the value (`api_key=`, reset, `Checking config`, reset, `<v>`) is
   * caught on the run `api_key=`, which ends before the last piece. The runs ending at the last piece come first. */
  const runs = (s: Open | undefined) => {
    const pieces = s?.pieces ?? [], out: string[] = [];
    for (let end = pieces.length; end > 0; end--) for (let from = 0; from < end; from++) out.push(pieces.slice(from, end).join(""));
    return [...new Set(out)];
  };
  /** The readings of a unit of stream `s` in chain `k`: alone (R1); after every run of the taken-back pieces, as the same line
   * and as the next line (R3); after each open tail of the chain (R4), and after such a tail followed by a run. */
  const readings = (unit: string, s: Open | undefined, k: string) => {
    read(unit);
    const tails = chains.get(k) ?? [], back = runs(s);
    const after = (joined: string) => read(joined, true, 0, joined.length - unit.length);
    for (const run of back) for (const joined of joins(run, unit)) after(joined);
    for (const tail of tails) {
      for (const joined of joins(tail, unit)) after(joined);
      for (const run of back) for (const left of joins(tail, run)) for (const joined of joins(left, unit)) after(joined);
    }
  };
  /** The unscanned deltas of an open stream, with TAIL overlap. */
  const flush = (key: string, s: Open) => {
    if (!s.pend) return;
    const unit = s.tail + s.pend;
    s.tail = clip(unit); s.pend = "";
    readings(unit, s, chainOf(key));
  };
  const close = (key: string, s: Open, completed?: string, resent = false) => {
    if (latched) flush(key, s);
    const k = chainOf(key);
    // what the next item of the chain is read after: this item's text; what streamed before a resend, then its text; and each of
    // those after every run of the pieces this item took back
    const text = completed === undefined ? s.tail : completed;
    const ends = resent ? [text, s.tail + text] : [text];
    const tails = [...new Set([...ends, ...runs(s).flatMap(run => ends.map(end => run + end))].map(clip))];
    if (tails.length > CHAIN_TAILS) { incomplete("bound"); tails.length = CHAIN_TAILS; }
    chains.set(k, tails);
    streams.delete(key);
  };
  const absorb = (batch: Batch, type: string, stream: string) => {
    // an assistant reply or an error row is about to be judged against the list: every open stream's unscanned part is read first
    if (latched && (type === "runtime.error" || type === "item.completed" || batch.terminal)) for (const [key, s] of streams) flush(key, s);
    if (type === "content.reset") {
      const s = streams.get(stream);
      if (s) {
        if (latched) flush(stream, s);
        if (s.tail) s.pieces.push(clip(s.tail));
        s.tail = "";
        if (s.pieces.length > BACK_PIECES) { incomplete("bound"); s.pieces = s.pieces.slice(-BACK_PIECES); }
      }
    }
    for (const c of batch.carriers) {
      if (c.mode === "whole") {
        if (shed.has(c.stream)) incomplete("tail-evicted"); // a field whose earlier end was let go is written again: the join is lost
        const earlier = fields.get(c.stream);
        const kind = `${type}:${c.path}`, before = kinds.get(kind);
        if (latched) { read(c.text, false); if (earlier) read(earlier + c.text, false, 0, earlier.length); }
        if (latched && before && before !== earlier) for (const joined of joins(before, c.text)) read(joined, false, 0, joined.length - c.text.length);
        if (c.text) { kinds.delete(kind); kinds.set(kind, c.text.slice(-FIELD_TAIL)); if (kinds.size > FIELDS) kinds.delete(kinds.keys().next().value as string); }
        fields.delete(c.stream); fields.set(c.stream, (earlier ?? "").concat(c.text).slice(-FIELD_TAIL));
        if (fields.size > FIELDS) { const oldest = fields.keys().next().value as string; fields.delete(oldest); if (shed.size < SHED_FIELDS) shed.add(oldest); else incomplete("tail-evicted"); }
        continue;
      }
      if (c.mode === "delta") {
        const s = open(c.stream);
        // kept to at most 2 x TAIL and cut back to TAIL then, so a long stream of small deltas costs its own length once
        if (!latched) { s.tail += c.text; if (s.tail.length > 2 * TAIL) { s.tail = s.tail.slice(-TAIL); s.cut = true; } continue; }
        s.pend += c.text;
        if (s.pend.length > ITEM_MAX) { incomplete("bound"); flush(c.stream, s); }
        continue;
      }
      // snapshot: a completed item's whole text. Claude completes an anonymous item with the whole text after streaming it, with
      // no reset and no item id: when it is not what streamed, the streamed text and the completed text are read as one (R2).
      const s = streams.get(c.stream);
      if (s && latched) flush(c.stream, s);
      const resent = Boolean(s?.tail) && !(c.text.endsWith(s!.tail) || c.text.startsWith(s!.tail));
      if (latched) {
        readings(c.text, s, chainOf(c.stream));
        if (resent) for (const joined of joins(s!.tail, c.text)) read(joined, true, 0, joined.length - c.text.length);
      }
      if (c.path === "text" && chainOf(c.stream) === "assistant") { viewCarry = carry; carry = c.text.slice(-CARRY); cached = undefined; }
      close(c.stream, s ?? { tail: "", pieces: [], pend: "" }, c.text, resent);
    }
    if (type === "item.completed") { const s = streams.get(stream); if (s) close(stream, s); }
    if (type !== "item.completed" && viewCarry !== carry) { viewCarry = carry; cached = undefined; }
  };
  return {
    absorb,
    latch(found, kind, batch, type, stream) {
      latched = true;
      if (kind === undefined) incomplete("unavailable");
      else if (kind === "unproven") incomplete("unproven-latch");
      for (const value of found) add(value);
      // CATCH-UP: everything kept before the latch is read now; then the latching intake itself, with every reading
      const before = detections;
      // ASTRA e167d43947 class (text let go unread): an item still open at the latch whose earlier text was cut to its tail. The
      // policy may not have read that text either (an item waiting behind another), so the list is not claimed whole.
      for (const s of streams.values()) if (s.cut) incomplete("tail-evicted");
      for (const [key, s] of streams) { if (s.tail) readings(s.tail, s, chainOf(key)); }
      for (const tails of chains.values()) for (const tail of tails) read(tail);
      // the latching intake's deltas were not kept yet: absorb takes them in, and the flush reads them joined to their stream
      absorb(batch, type, stream);
      for (const [key, s] of streams) flush(key, s);
      // the policy saw a hit the recorder cannot reproduce: it cannot claim to know the values
      if (kind === "hit" && detections === before) incomplete("unmatched-hit");
    },
    incomplete,
    view() {
      if (!cached) {
        const seq = values.length, as = (table: Map<string, number>): GramSet => Object.freeze({ has: (gram: string) => (table.get(gram) ?? Infinity) <= seq, classOf: (gram: string) => { const at = table.get(gram); return at !== undefined && at <= seq ? values[at - 1]?.cls : undefined; } });
        cached = Object.freeze({ complete, ...(reason ? { reason } : {}), values: Object.freeze(values.slice()) as readonly MaskedValue[], gramsMixed: as(gramsMixed), gramsAny: as(gramsAny), carry: viewCarry });
      }
      return cached;
    },
    carryFrom(previous) {
      latched = true;
      if (!previous) { incomplete("unavailable"); return; }
      if (!previous.complete) incomplete(previous.reason ?? "unavailable");
      // the windows are rebuilt from the carried forms (a snapshot gives membership only)
      // q1023-rcready: the credential-shape mark carries too, so the rebuilt attempt still masks a quote of it in the owner chat
      for (const value of previous.values) put(value.norm, value.cls ?? "other", value.shape === true);
      count = Math.max(count, Math.ceil(values.length / 5));
      carry = viewCarry = previous.carry; cached = undefined;
    },
  };
}
