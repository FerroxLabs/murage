// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP owner-evidence grammar (I-3), authored-statement grammar (I-3b) and the
// claim comparison rules (A.4). Local and deterministic: no model, no network,
// no database. The model proposes only `{act, spans}`; this module turns the
// owner's own bytes into a parsed claim and the template sentence that may be
// kept. Published forms live in lanes/pip/CLAIM-VOCABULARY.md (v1).
import { classifyPastedText } from "./prospect-text.ts";
import { BASE_VERBS, CONTRACTIONS, HEDGES, LEXICON, LIGHT_VERBS, NEGATION_TOKENS, REPORTED_SPEECH, SUBORDINATORS } from "./pip-vocabulary.ts";

export type ClaimKind = "self-trait" | "commitment";
export type TemporalScope = "present" | "prospective" | "from-now-on" | "next-time";
export type TemporalBucket = "present" | "standing" | "next-time";
export type Frequency = "always" | "usually" | "often" | "never";
export interface ParsedClaim {
  kind: ClaimKind;
  subject: "bot";
  predicateKey: string;
  property: string | null;
  value: string | null;
  polarity: "positive" | "negative";
  aspect: "state" | "habit" | "cessation";
  frequency: Frequency | null;
  modality: "none" | "should" | "must" | "attempt";
  temporalScope: TemporalScope;
  /** The key with the value token and a preceding light verb removed (A.4); may be empty. */
  predicateScope: string;
  temporalBucket: TemporalBucket;
  /** The production that produced the claim (`AUTHORED` for I-3b). Never compared. */
  act: string;
}
/** A stance event: the owner retracts a standing claim. Resolved to its target by the caller (design I-3 RETRACT). */
export interface RetractEvent { kind: "retract"; predicateKey: string; act: "RETRACT" }
export type Production = "RETRACT" | "INSTR-STOP" | "INSTR-BE" | "INSTR-DO" | "AGREE" | "OBS-HABIT" | "OBS-TEND" | "OBS-STATE";
export type RefusalReason = "empty" | "question" | "uncertain" | "no-match" | "double-negation" | "negation-inside" | "frequency-in-pred" | "bad-verb" | "no-template" | "bad-predicate";
export type OwnerSentenceResult =
  | { ok: true; production: Exclude<Production, "RETRACT">; claim: ParsedClaim; statement: string }
  | { ok: true; production: "RETRACT"; retract: RetractEvent }
  | { ok: false; reason: RefusalReason };

const BASE_SET = new Set(BASE_VERBS);
const LIGHT = new Set<string>(LIGHT_VERBS);
const NEG = new Set<string>(NEGATION_TOKENS);

/** Fold curly apostrophes and the published contraction table and collapse whitespace, keeping the owner's capitals. */
function foldKeepCase(text: string): string {
  let out = text.normalize("NFKC").replace(/[‘’ʼ`]/g, "'");
  for (const [short, long] of CONTRACTIONS) out = out.replace(new RegExp(`(^|[^A-Za-z'])${short}(?![A-Za-z'])`, "gi"), `$1${long}`);
  return out.replace(/\s+/g, " ").trim();
}
/** Lower-case, fold curly apostrophes and the published contraction table, collapse whitespace. */
export function foldContractions(text: string): string { return foldKeepCase(text).toLowerCase(); }

const tokenBounded = (haystack: string, phrase: string) => new RegExp(`(^| )${phrase}( |$)`).test(haystack);

/** The gerund rule: a token ending `ing` whose stem, with `e` restored or a doubled consonant undone, is a base verb. */
export function gerundBase(token: string): string | undefined {
  if (!/^[a-z][a-z-]*ing$/.test(token)) return undefined;
  const stem = token.slice(0, -3);
  const candidates = [stem, `${stem}e`];
  if (/([b-df-hj-np-tv-z])\1$/.test(stem)) candidates.push(stem.slice(0, -1));
  if (token === "being") candidates.push("be");
  if (token.endsWith("ying")) candidates.push(`${token.slice(0, -4)}ie`);
  return candidates.find(candidate => BASE_SET.has(candidate));
}
const isBaseVp = (vp: string) => BASE_SET.has(vp.split(" ")[0].toLowerCase());
const isGerundVp = (vp: string) => gerundBase(vp.split(" ")[0].toLowerCase()) !== undefined;

/** Keys a RETRACT may resolve against: the key as authored, and with a gerund first token turned back into its base verb. */
export function retractTargetKeys(event: RetractEvent): string[] {
  const [first, ...rest] = event.predicateKey.split(" ");
  const base = gerundBase(first);
  return base ? [event.predicateKey, [base, ...rest].join(" ")] : [event.predicateKey];
}
/** A key never starts with a light verb: `be brief`, `being brief` and `brief` share the key `brief`, so the same promise phrased three ways compares as one. */
const stripLight = (body: string): string => {
  const tokens = body.split(" ");
  const light = LIGHT.has(tokens[0].toLowerCase());
  return tokens.length > 1 && light ? tokens.slice(1).join(" ") : tokens.length === 1 && light ? "" : body;
};

function temporalBucket(scope: TemporalScope): TemporalBucket {
  return scope === "present" ? "present" : scope === "next-time" ? "next-time" : "standing";
}

interface ClaimInput {
  kind: ClaimKind; key: string; polarity: "positive" | "negative"; aspect: ParsedClaim["aspect"];
  frequency: Frequency | null; modality: ParsedClaim["modality"]; temporalScope: TemporalScope; act: string;
}
function buildClaim(input: ClaimInput): ParsedClaim {
  const key = input.key.toLowerCase();
  const tokens = key.split(" ").filter(Boolean);
  const at = tokens.findIndex(token => LEXICON[token] !== undefined);
  let property: string | null = null, value: string | null = null, scope: string[];
  if (at >= 0) {
    [property, value] = LEXICON[tokens[at]];
    const from = at > 0 && LIGHT.has(tokens[at - 1]) ? at - 1 : at;
    scope = [...tokens.slice(0, from), ...tokens.slice(at + 1)];
  } else scope = tokens.length && LIGHT.has(tokens[0]) ? tokens.slice(1) : tokens;
  return {
    kind: input.kind, subject: "bot", predicateKey: key, property, value, polarity: input.polarity, aspect: input.aspect,
    frequency: input.frequency, modality: input.modality, temporalScope: input.temporalScope,
    predicateScope: scope.join(" "), temporalBucket: temporalBucket(input.temporalScope), act: input.act,
  };
}

/** Strip one leading polarity token. A negative anchor plus a stripped token is a double negation. */
function negate(body: string, anchorNegative: boolean): { body: string; negative: boolean } | RefusalReason {
  let negative = anchorNegative, stripped = false;
  for (const lead of ["no longer ", "not ", "never "]) {
    if (body.toLowerCase().startsWith(lead)) { body = body.slice(lead.length); stripped = true; break; }
  }
  if (stripped) {
    if (anchorNegative) return "double-negation";
    negative = true;
  }
  if (!body) return "bad-predicate";
  if (body.split(" ").some(token => NEG.has(token.toLowerCase()))) return "negation-inside";
  return { body, negative };
}

const isRefusal = (value: unknown): value is RefusalReason => typeof value === "string";

/** The first-person statement for a commitment claim and its verb phrase, by the published template table. */
function commitmentStatement(claim: ParsedClaim, vp: string): string | undefined {
  const neg = claim.polarity === "negative";
  if (claim.aspect === "cessation") return `I will stop ${vp}`;
  if (neg) {
    if (claim.frequency === "never") return `I will never ${vp}`;
    if (claim.frequency) return undefined;
    if (claim.modality === "should") return `I should not ${vp}`;
    if (claim.modality === "must") return `I must not ${vp}`;
    if (claim.modality === "attempt") return `I will try not to ${vp}`;
    if (claim.temporalScope === "from-now-on") return `From now on, I will not ${vp}`;
    if (claim.temporalScope === "next-time") return `Next time, I will not ${vp}`;
    return `I will not ${vp}`;
  }
  if (claim.frequency && claim.frequency !== "always") return undefined;
  if (claim.modality === "should") return `I should ${vp}`;
  if (claim.modality === "must") return `I must ${vp}`;
  if (claim.modality === "attempt") return `I will try to ${vp}`;
  if (claim.frequency === "always") return `I will always ${vp}`;
  if (claim.temporalScope === "from-now-on") return `From now on, I will ${vp}`;
  if (claim.temporalScope === "next-time") return `Next time, I will ${vp}`;
  return `I will ${vp}`;
}

/** Vocative and filler lead-ins that may precede a production. */
function stripLead(sentence: string, botName: string | undefined): string {
  let s = sentence;
  if (botName) {
    const name = foldContractions(botName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (name) s = s.replace(new RegExp(`^${name}[,:]? `, "i"), "");
  }
  for (;;) {
    const next = s.replace(/^(?:ok|okay|so|well|hey|hi|also|and|then|right) /i, "");
    if (next === s) return s;
    s = next;
  }
}

/** Uncertainty and question checks on one raw sentence. */
function uncertain(raw: string, folded: string): boolean {
  // Any quotation mark, paired or not: quoted text is somebody's words, and a lone mark means the quotation was cut.
  if (/["“”]/.test(raw)) return true;
  if (/,\s*but\b/.test(folded) || folded.includes(";") || / or /.test(` ${folded.replace(/,/g, " ")} `)) return true;
  const spaced = folded.replace(/[^a-z0-9' -]/g, " ").replace(/\s+/g, " ").trim();
  return [...REPORTED_SPEECH, ...SUBORDINATORS, ...HEDGES].some(phrase => tokenBounded(spaced, phrase));
}

/** Parse one owner sentence. `botName` lets a leading vocative be dropped. */
export function parseOwnerSentence(sentence: string, options: { botName?: string } = {}): OwnerSentenceResult {
  const raw = sentence.trim();
  if (!raw) return { ok: false, reason: "empty" };
  if (raw.includes("?")) return { ok: false, reason: "question" };
  const folded = foldKeepCase(raw);
  if (uncertain(raw, folded.toLowerCase())) return { ok: false, reason: "uncertain" };
  let s = folded.replace(/[.!]+$/g, "").replace(/[^A-Za-z0-9' -]/g, " ").replace(/\s+/g, " ").trim();
  s = stripLead(s, options.botName);
  if (!s) return { ok: false, reason: "empty" };
  const refuse = (reason: RefusalReason): OwnerSentenceResult => ({ ok: false, reason });
  let m: RegExpMatchArray | null;

  // RETRACT: a stance event only.
  const retract = /^you are not (.+?) any ?more$/i.exec(s) ?? /^you do not need to (.+?) any ?more$/i.exec(s) ?? /^you can stop (.+)$/i.exec(s)
    ?? /^we are not doing (.+)$/i.exec(s) ?? /^never mind about (.+)$/i.exec(s) ?? /^forget about (.+)$/i.exec(s);
  if (retract) {
    const key = stripLight(retract[1].trim()).toLowerCase();
    return key ? { ok: true, production: "RETRACT", retract: { kind: "retract", predicateKey: key, act: "RETRACT" } } : refuse("bad-predicate");
  }

  const commitment = (production: Exclude<Production, "RETRACT">, rest: string, o: { anchorNegative: boolean; modality?: ParsedClaim["modality"]; temporalScope?: TemporalScope; frequency?: Frequency | null; aspect?: ParsedClaim["aspect"]; gerund?: boolean }): OwnerSentenceResult => {
    const n = negate(rest, o.anchorNegative);
    if (isRefusal(n)) return refuse(n);
    if (o.gerund ? !isGerundVp(n.body) : !isBaseVp(n.body)) return refuse("bad-verb");
    const key = stripLight(n.body);
    if (!key) return refuse("bad-predicate");
    const aspect = o.aspect ?? (LIGHT.has(n.body.split(" ")[0].toLowerCase()) ? "state" : "habit");
    const claim = buildClaim({
      kind: "commitment", key, polarity: n.negative ? "negative" : "positive", aspect,
      frequency: o.frequency ?? null, modality: o.modality ?? "none", temporalScope: o.temporalScope ?? "prospective", act: production,
    });
    const statement = commitmentStatement(claim, n.body);
    return statement ? { ok: true, production, claim, statement } : refuse("no-template");
  };

  // INSTR-STOP
  if ((m = /^(?:please )?(do not|never|stop|no more) (.+)$/i.exec(s))) {
    const anchor = m[1].toLowerCase();
    if (anchor === "stop") return commitment("INSTR-STOP", m[2], { anchorNegative: true, aspect: "cessation", gerund: true });
    if (anchor === "never") return commitment("INSTR-STOP", m[2], { anchorNegative: true, frequency: "never", temporalScope: "from-now-on" });
    return commitment("INSTR-STOP", m[2], { anchorNegative: true });
  }
  // INSTR-BE
  if ((m = /^(?:please )?(be|always be) (.+)$/i.exec(s))) {
    const always = m[1].toLowerCase() === "always be";
    const n = negate(m[2], false);
    if (isRefusal(n)) return refuse(n);
    if (n.negative) return refuse("double-negation");
    const key = stripLight(n.body);
    if (!key) return refuse("bad-predicate");
    const claim = buildClaim({ kind: "commitment", key, polarity: "positive", aspect: "state", frequency: always ? "always" : null, modality: "none", temporalScope: always ? "from-now-on" : "prospective", act: "INSTR-BE" });
    const statement = commitmentStatement(claim, `be ${n.body}`);
    return statement ? { ok: true, production: "INSTR-BE", claim, statement } : refuse("no-template");
  }
  // INSTR-DO
  if ((m = /^(?:please )?(do|always|from now on|going forward|next time|make sure to|make sure you|try to|you should|you need to|you must|i want you to|i would like you to) (?:(do not|not|never) )?(.+)$/i.exec(s))) {
    const anchor = m[1].toLowerCase(), negative = Boolean(m[2]);
    const modality = ({ "you should": "should", "you need to": "should", "i want you to": "should", "i would like you to": "should", "you must": "must", "make sure to": "must", "make sure you": "must", "try to": "attempt" } as Record<string, ParsedClaim["modality"]>)[anchor] ?? "none";
    const temporalScope: TemporalScope = anchor === "always" || anchor === "from now on" || anchor === "going forward" ? "from-now-on" : anchor === "next time" ? "next-time" : "prospective";
    return commitment("INSTR-DO", `${negative ? "not " : ""}${m[3]}`, { anchorNegative: false, modality, temporalScope, frequency: anchor === "always" ? "always" : null });
  }
  // AGREE
  if ((m = /^we agreed to (not )?(.+)$/i.exec(s))) return commitment("AGREE", `${m[1] ?? ""}${m[2]}`, { anchorNegative: false });
  if ((m = /^we agreed that you (will|would|should) (not )?(.+)$/i.exec(s))) return commitment("AGREE", `${m[2] ?? ""}${m[3]}`, { anchorNegative: false, modality: m[1].toLowerCase() === "should" ? "should" : "none" });

  // OBS-*: traits about the bot, present tense.
  const trait = (production: Exclude<Production, "RETRACT">, key: string, negative: boolean, aspect: ParsedClaim["aspect"], frequency: Frequency | null, statement: string): OwnerSentenceResult => {
    const claim = buildClaim({ kind: "self-trait", key, polarity: negative ? "negative" : "positive", aspect, frequency, modality: "none", temporalScope: "present", act: production });
    return { ok: true, production, claim, statement };
  };
  // OBS-HABIT
  if ((m = /^you (always|usually|often|never) (.+)$/i.exec(s))) {
    const frequency = m[1].toLowerCase() as Frequency, never = frequency === "never";
    const n = negate(m[2], never);
    if (isRefusal(n)) return refuse(n);
    if (n.negative !== never) return refuse("negation-inside");
    if (!isBaseVp(n.body)) return refuse("bad-verb");
    return trait("OBS-HABIT", stripLight(n.body) || n.body, never, "habit", frequency, `I ${frequency} ${n.body}`);
  }
  // OBS-TEND
  if ((m = /^you (tend to not|tend not to|tend to|keep) (.+)$/i.exec(s))) {
    const tend = m[1].toLowerCase(), keep = tend === "keep", anchorNegative = tend === "tend to not" || tend === "tend not to";
    if (keep && /^(not|never|no longer) /i.test(m[2])) return refuse("double-negation");
    const n = negate(m[2], anchorNegative);
    if (isRefusal(n)) return refuse(n);
    if (n.negative !== anchorNegative) return refuse("negation-inside");
    if (keep ? !isGerundVp(n.body) : !isBaseVp(n.body)) return refuse("bad-verb");
    const statement = keep ? `I keep ${n.body}` : anchorNegative ? `I tend not to ${n.body}` : `I tend to ${n.body}`;
    return trait("OBS-TEND", stripLight(n.body) || n.body, anchorNegative, "habit", null, statement);
  }
  // OBS-STATE
  if ((m = /^you are (not )?(.+)$/i.exec(s))) {
    const pred = m[2], negative = Boolean(m[1]);
    if (/^(always|usually|often|never) /i.test(pred)) return refuse("frequency-in-pred");
    const n = negate(pred, negative);
    if (isRefusal(n)) return refuse(n);
    // Polarity is what negate() returns: a leading `no longer` or `not` in PRED is negative, never silently positive.
    if (n.body.split(" ").length > 8) return refuse("bad-predicate");
    return trait("OBS-STATE", n.body, n.negative, "state", null, n.negative ? `I am not ${n.body}` : `I am ${n.body}`);
  }
  return refuse("no-match");
}

/**
 * Sentence pieces of a message with their start index. A boundary (`.`, `!`, `?`, newline) inside a quotation is not a
 * boundary: the quoted span stays whole, with its quote marks, so the quotation check sees both of them. An unterminated
 * quotation swallows the rest of the message into one piece, which is then refused. The split is shared with sentenceRanges.
 */
export function sentenceSpans(text: string): Array<{ index: number; raw: string }> {
  const out: Array<{ index: number; raw: string }> = [];
  let start = 0, i = 0, inQuote = false;
  const flush = (end: number) => { if (end > start) out.push({ index: start, raw: text.slice(start, end) }); };
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { inQuote = !inQuote; i++; continue; }
    if (c === "\u201C") { inQuote = true; i++; continue; }
    if (c === "\u201D") { inQuote = false; i++; continue; }
    if (!inQuote && c === "\n") { flush(i); i++; start = i; continue; }
    if (!inQuote && (c === "." || c === "!" || c === "?")) {
      let j = i + 1;
      while (j < text.length && (text[j] === "." || text[j] === "!" || text[j] === "?")) j++;
      flush(j); i = j; start = j; continue;
    }
    i++;
  }
  flush(text.length);
  return out;
}

/** Admissible complete sentences with byte offsets in the original payload. */
export function admissibleSentenceRanges(text: string, options: { botName?: string } = {}) {
  const normalized = text.replace(/\r\n/g, "\n"), offsets: number[] = [];
  for (let i = 0; i < text.length; i++) if (!(text[i] === "\r" && text[i + 1] === "\n")) offsets.push(i);
  offsets.push(text.length);
  const out: Array<{ start: number; end: number; text: string; result: OwnerSentenceResult }> = [];
  const ownerRanges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const segment of classifyPastedText(normalized)) {
    const at = normalized.indexOf(segment.text, cursor);
    cursor = at + segment.text.length;
    if (segment.party === "owner") ownerRanges.push({ start: at, end: cursor });
  }
  // Split the complete source so a quotation spanning a pasted block keeps its context.
  for (const span of sentenceSpans(normalized)) {
    const raw = span.raw.trim(), result = parseOwnerSentence(raw, options);
    const start = span.index + span.raw.length - span.raw.trimStart().length;
    if (!result.ok || !ownerRanges.some(r => start >= r.start && start + raw.length <= r.end)) continue;
    out.push({ start: Buffer.byteLength(text.slice(0, offsets[start])), end: Buffer.byteLength(text.slice(0, offsets[start + raw.length])), text: raw, result });
  }
  return out;
}

/** Split an owner message into sentences after dropping pasted third-party text. Questions are kept so they can be refused. */
export function ownerSentences(text: string): string[] {
  const owner = classifyPastedText(text).filter(segment => segment.party === "owner").map(segment => segment.text).join("\n");
  return sentenceSpans(owner).map(part => part.raw.trim()).filter(part => /[a-z0-9]/i.test(part));
}
export function parseOwnerText(text: string, options: { botName?: string } = {}): Array<{ sentence: string; result: OwnerSentenceResult }> {
  return ownerSentences(text).map(sentence => ({ sentence, result: parseOwnerSentence(sentence, options) }));
}

/** I-3b: the first-person canonical forms only. Yields the claim json that Reconcile, collapse and compatibility read; never admits owner evidence. */
export function parseAuthoredStatement(statement: string): ParsedClaim | null {
  let s = statement.normalize("NFKC").trim().replace(/[.]+$/g, "").replace(/\s+/g, " ");
  if (!s || /[?;!]/.test(s)) return null;
  let m: RegExpMatchArray | null;
  const lead = /^(from now on|next time), /i.exec(s);
  let temporalScope: TemporalScope = "prospective";
  if (lead) { temporalScope = lead[1].toLowerCase() === "next time" ? "next-time" : "from-now-on"; s = s.slice(lead[0].length); }
  if (!s.startsWith("I ")) return null;
  s = s.slice(2);
  const plain = (rest: string, anchorNegative: boolean): { body: string; negative: boolean } | undefined => {
    const n = negate(rest, anchorNegative);
    return isRefusal(n) ? undefined : n;
  };
  const make = (kind: ClaimKind, key: string, negative: boolean, o: Partial<ClaimInput>): ParsedClaim =>
    buildClaim({ kind, key, polarity: negative ? "negative" : "positive", aspect: "habit", frequency: null, modality: "none", temporalScope, act: "AUTHORED", ...o });
  const commitment = (rest: string, o: { negative?: boolean; modality?: ParsedClaim["modality"]; frequency?: Frequency | null; temporalScope?: TemporalScope; aspect?: ParsedClaim["aspect"]; gerund?: boolean }): ParsedClaim | null => {
    const n = plain(rest, false);
    if (!n || n.negative) return null;
    if (o.gerund ? !isGerundVp(n.body) : !isBaseVp(n.body)) return null;
    const key = stripLight(n.body);
    if (!key) return null;
    return make("commitment", key, o.negative ?? false, { aspect: o.aspect ?? (LIGHT.has(n.body.split(" ")[0].toLowerCase()) ? "state" : "habit"), modality: o.modality ?? "none", frequency: o.frequency ?? null, temporalScope: o.temporalScope ?? temporalScope });
  };
  const timed = temporalScope !== "prospective";
  if ((m = /^will stop (.+)$/.exec(s))) return timed ? null : commitment(m[1], { negative: true, aspect: "cessation", gerund: true });
  if ((m = /^will try not to (.+)$/.exec(s))) return timed ? null : commitment(m[1], { negative: true, modality: "attempt" });
  if ((m = /^will try to (.+)$/.exec(s))) return timed ? null : commitment(m[1], { modality: "attempt" });
  if ((m = /^will never (.+)$/.exec(s))) return timed ? null : commitment(m[1], { negative: true, frequency: "never", temporalScope: "from-now-on" });
  if ((m = /^will always (.+)$/.exec(s))) return timed ? null : commitment(m[1], { frequency: "always", temporalScope: "from-now-on" });
  if ((m = /^will not (.+)$/.exec(s))) return commitment(m[1], { negative: true });
  if ((m = /^will (.+)$/.exec(s))) return commitment(m[1], {});
  if ((m = /^should not (.+)$/.exec(s))) return timed ? null : commitment(m[1], { negative: true, modality: "should" });
  if ((m = /^should (.+)$/.exec(s))) return timed ? null : commitment(m[1], { modality: "should" });
  if ((m = /^must not (.+)$/.exec(s))) return timed ? null : commitment(m[1], { negative: true, modality: "must" });
  if ((m = /^must (.+)$/.exec(s))) return timed ? null : commitment(m[1], { modality: "must" });
  if (timed) return null;
  if ((m = /^am (not )?(.+)$/.exec(s))) {
    if (/^(always|usually|often|never) /.test(m[2])) return null;
    const n = plain(m[2], Boolean(m[1]));
    if (!n || n.body.split(" ").length > 8) return null;
    return make("self-trait", n.body, n.negative, { aspect: "state", temporalScope: "present" });
  }
  if ((m = /^(always|usually|often|never) (.+)$/.exec(s))) {
    const frequency = m[1] as Frequency, n = plain(m[2], frequency === "never");
    if (!n || !isBaseVp(n.body)) return null;
    if (n.negative !== (frequency === "never")) return null;
    return make("self-trait", stripLight(n.body) || n.body, frequency === "never", { frequency, temporalScope: "present" });
  }
  if ((m = /^tend not to (.+)$/.exec(s))) { const n = plain(m[1], true); return n && isBaseVp(n.body) ? make("self-trait", stripLight(n.body) || n.body, true, { temporalScope: "present" }) : null; }
  if ((m = /^tend to (.+)$/.exec(s))) { const n = plain(m[1], false); return n && !n.negative && isBaseVp(n.body) ? make("self-trait", stripLight(n.body) || n.body, false, { temporalScope: "present" }) : null; }
  if ((m = /^keep (.+)$/.exec(s))) { const n = plain(m[1], false); return n && !n.negative && isGerundVp(n.body) ? make("self-trait", stripLight(n.body) || n.body, false, { temporalScope: "present" }) : null; }
  return null;
}

/** Reinforce rule (A.4): equal kind, polarity, aspect, frequency, modality and temporal bucket, and either the same key or the same property, value and scope. */
export function claimsCompatible(a: ParsedClaim, b: ParsedClaim): boolean {
  if (a.kind !== b.kind || a.polarity !== b.polarity || a.aspect !== b.aspect || a.frequency !== b.frequency || a.modality !== b.modality || a.temporalBucket !== b.temporalBucket) return false;
  if (a.predicateKey === b.predicateKey) return true;
  return a.property !== null && a.property === b.property && a.value === b.value && a.predicateScope === b.predicateScope;
}

/** Contradiction rule (A.4, M3): same kind and temporal bucket, and the same key with opposite polarity; or the same property and scope with the same value
 * and opposite polarity, or with an exclusive value pair (two distinct values of one property) both stated positively; or a RETRACT resolving to the target. */
export function claimsContradict(a: ParsedClaim, b: ParsedClaim | RetractEvent): boolean {
  if ("kind" in b && b.kind === "retract") return retractTargetKeys(b).includes(a.predicateKey);
  const other = b as ParsedClaim;
  if (a.kind !== other.kind || a.temporalBucket !== other.temporalBucket) return false;
  if (a.predicateKey === other.predicateKey) return a.polarity !== other.polarity;
  if (a.property === null || a.property !== other.property || a.predicateScope !== other.predicateScope) return false;
  if (a.value === other.value) return a.polarity !== other.polarity;
  return a.polarity === "positive" && other.polarity === "positive";
}

/** Shown together on the Self tab, never counted: same kind, and they share a key or a property without being compatible or contradictory. */
export function claimsRelated(a: ParsedClaim, b: ParsedClaim): boolean {
  if (a.kind !== b.kind || claimsCompatible(a, b) || claimsContradict(a, b)) return false;
  return a.predicateKey === b.predicateKey || (a.property !== null && a.property === b.property);
}

export const PIP_CLAIM_ENTITY_PREFIX = "claim:";
export function claimEntity(claim: ParsedClaim | null): string { return `claim:${claim ? JSON.stringify(claim) : "null"}`; }
