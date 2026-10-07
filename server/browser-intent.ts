// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic intent rules I1, I2, I4, I5, I6, I7 (spec 3.1). I3 arrives as the content probe's flag.
//
// A pure function: no I/O, no clock, no state. The caller owns the task counters and the read-origin digests,
// so this module can be exercised by table tests and switched into the policy by the core lane.
//
// Contract with the rest of the check:
//  - the rules are the floor under the model check; they never pass a floor action and never turn a refusal into a card;
//  - "unsure" tightens: a target operation with no visibility facts is refused, an unparseable URL counts as data,
//    a recipient that is not byte-for-byte what the owner typed (zero-width characters, look-alikes) is a new recipient;
//  - every card rule that fires adds its line to the card (joined with "\n"); `rule` names the first. Only an unknown-recipient send is an I7 hit.

import { withoutSecretValues } from "./browser-recipient-safety.ts";

export type BrowserLevel = "L1" | "L2" | "L3" | "floor";
export type ApprovalMode = "step" | "task" | "full";
export type IntentRule = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7";
export type IntentResult = { result: "pass" | "card" | "refuse"; rule?: IntentRule; line?: string };

/** The visibility block of T01's collector (box, inViewport, opacity, visibility, ariaHidden, coveredBy). */
export type Visibility = {
  box: { x: number; y: number; width: number; height: number } | null;
  // null = the collector could not tell; every null reads as hidden (unsure tightens).
  inViewport: boolean | null;
  opacity: number | null;
  visibility: string | null;
  ariaHidden: boolean | null;
  /** A description of the element that covers the target at its centre, or null when nothing does. */
  coveredBy?: string | null;
};

export type IntentAction = {
  operation: string;
  level: BrowserLevel;
  /** The origin of the document the action runs in. */
  origin: string;
  /** Where the action goes: the navigation or read URL, or the form action URL of a submit. */
  destination?: string;
  /** Text the bot types, fills or submits. */
  typedText?: string;
  /** Recipient fields (email addresses, @handles, phone numbers) of a send-capable activation. */
  recipients?: string[];
  /** T22: the recipients scan could not read the page, so who a send-capable activation goes to is unknown. */
  recipientScanFailed?: boolean;
  /** Native action-kind classification, independent of the action level. */
  sendCapable?: boolean;
  /** The owner already allowed a send in this exact positively classified conversation for this task. */
  conversationApproved?: boolean;
  /** The complete native inventory counted zero field-like elements. */
  recipientNoField?: boolean;
  /** All fields were positively classified, with a composer and no explicit recipients. */
  recipientComposer?: boolean;
  conversationEligible?: boolean;
  /** Whether the operation acts on a page element, so visibility facts are required. When left out it is derived
   * from the operation: everything except navigate and read has a target. Only an explicit false turns it off. */
  hasTarget?: boolean;
  /** I6 facts, the same ones the extension policy already carries. */
  ownerRequested?: boolean;
  pageDataRead?: boolean;
  presentedLink?: boolean;
  /** The tab's current URL, for the same-origin I6 comparison. */
  currentUrl?: string;
};

export type IntentInput = {
  /** Owner-origin messages of this task. */
  ownerWords: string[];
  /** Origins named by the owner, reached from a task page, or granted in this task. */
  taskSites: Set<string>;
  /** Per origin read in this task: the entries `readEntriesOf(text)` built once when the text was read (hashed
   * 40-character shingles and secret-looking token digests). Pass the Set; an array is accepted and wrapped. */
  readOrigins: Map<string, ReadonlySet<string> | readonly string[]>;
  /** I3: the content probe flagged instruction-like text since the last owner message. */
  probeFlagged: boolean;
  action: IntentAction;
  visibility?: Visibility;
  /** I-rule cards and refusals already raised in this task. */
  counters: { hits: number };
  /** I1 is skipped in step mode, where every step already cards. Default "task". */
  mode?: ApprovalMode;
  /** T22: nobody can be asked (a routine run). A card that would be raised is a refusal instead, for the unknown-recipient case. */
  unattended?: boolean;
  /** Recipients of the thread being replied to. */
  threadRecipients?: string[];
  /** I5 running total per destination origin: what `nextTypedHistory` returned after earlier typing to that origin in
   * this task, so a span or token split across several fills is still seen. */
  typedHistory?: Map<string, string>;
};

export const INTENT_LINES = {
  I1: "This site was not part of your request.",
  I2: (recipient: string) => `New recipient not in your request: ${recipient}.`,
  I2_UNKNOWN: "Murage could not check who this goes to.",
  I2_CHAT: "If you allow this, Murage will not ask again for messages in this same conversation, for this task.",
  I2_CHAT_EACH: "This app does not show the conversation in its address, so Murage asks for each message.",
  I2_HIDDEN: "It contains hidden or look-alike characters.",
  I3: "This page has text that looks like instructions to Murage.",
  I4: "The bot tried to use a hidden control. Nothing was done.",
  I5: (from: string, to: string) => `This sends text from ${from} to ${to}.`,
  I6: (site: string) => `This link to ${site} carries information from your task.`,
  I7: "Murage paused this task. The page kept asking for things you did not ask for.",
} as const;

const SHINGLE = 40;
const MIN_TOKEN = 6;
const LEN_MARK = "len:";
/** MEM-001: one origin's provenance holds at most this many entries (about 5 MiB of hashes), and the secret-token digests get their own small reserve so
 * they survive a very long page. Past the span cap the set carries SATURATED: spans are no longer all known, so a long carry to another site asks. */
export const MAX_READ_ENTRIES = 100_000;
const MAX_TOKEN_ENTRIES = 20_000;
export const SATURATED = "saturated:spans";
export const SATURATED_TOKENS = "saturated:tokens";
const PAUSE_AT = 3;
const RECIPIENT_CAP = 80;
const MAX_RECIPIENT_LINES = 10;

/** NFKC, drop format characters (zero-width, bidi marks, soft hyphen), collapse whitespace. Case is kept. */
function clean(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}
function fold(text: string): string { return clean(text).toLowerCase(); }
/** Letters and digits only, after NFKC and lower-casing: spacing, punctuation and zero-width characters cannot split a span. */
function alnum(text: string): string { return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }

/** cyrb53: a fast 53-bit string hash. Set membership only; a collision can only add a card, never remove one. */
function h53(str: string, start = 0, end = str.length): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = start; i < end; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const KEY_TOKENS = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){1,2}/g,
  /[A-Za-z0-9+/_-]{33,}={0,2}/g,
];

/** Secret-looking tokens of page text, in their letters-and-digits form: digit runs of 6 or more (each digit group on its
 * own, and the run with spaces, dots, dashes and other non-letters between groups ignored), key prefixes, base64. */
function secretTokens(text: string): string[] {
  const cleaned = clean(text);
  const out: string[] = [];
  for (const m of cleaned.matchAll(/\d{6,}/g)) out.push(m[0]);
  for (const m of alnum(cleaned).matchAll(/\d{6,}/g)) out.push(m[0]);
  for (const re of KEY_TOKENS) for (const m of cleaned.matchAll(re)) out.push(alnum(m[0]));
  return out;
}

/** What I5 compares against, built ONCE when the bot reads `text` from an origin: hashed 40-character shingles of the
 * letters-and-digits form, hashed secret-looking tokens, and the token lengths present. Store the Set per origin and
 * pass it in `readOrigins`; merge sets when the same origin is read again. */
export function readEntriesOf(text: string, into: Set<string> = new Set()): Set<string> {
  const folded = alnum(text);
  for (let i = 0; i + SHINGLE <= folded.length; i++) {
    if (into.size >= MAX_READ_ENTRIES) { into.add(SATURATED); break; }
    into.add(h53(folded, i, i + SHINGLE));
  }
  for (const token of secretTokens(text)) {
    if (token.length < MIN_TOKEN || token.length >= SHINGLE) continue;
    if (into.size >= MAX_READ_ENTRIES + MAX_TOKEN_ENTRIES) { into.add(SATURATED_TOKENS); break; }
    into.add(h53(token));
    into.add(LEN_MARK + token.length);
  }
  return into;
}

/** The I5 running total the caller keeps per destination origin after each typing action: only the tail that can still
 * join a later fill into a span or token (39 letters and digits). */
export function nextTypedHistory(previous: string | undefined, typedText: string): string {
  return alnum((previous ?? "") + typedText).slice(-(SHINGLE - 1));
}

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.origin === "null" ? undefined : url.origin; } catch { return undefined; }
}
function hostOf(origin: string): string { try { return new URL(origin).host || origin; } catch { return origin; } }

const BOUNDARY_BEFORE = "(?<![a-z0-9._%+@-])";
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Whether the owner's words name this recipient. A recipient that differs from its normal form never matches. */
function ownerNamed(recipient: string, ownerText: string, ownerDigitRuns: string[]): boolean {
  const normal = fold(recipient);
  if (!normal || recipient !== recipient.normalize("NFKC") || /\p{Cf}/u.test(recipient)) return false;
  if (/^[+\d\s().-]+$/.test(normal)) {
    const digits = normal.replace(/\D/g, "");
    if (digits.length < 7) return false;
    // The full number: the same digits, or the same number with a country code in front when the shorter one has 10 digits.
    return ownerDigitRuns.some((run) => run === digits
      || (Math.min(run.length, digits.length) >= 10 && (run.endsWith(digits) || digits.endsWith(run))));
  }
  const tail = normal.startsWith("@") ? "(?![a-z0-9_@])" : "(?![a-z0-9_@-])(?!\\.[a-z0-9])";
  return new RegExp(`${BOUNDARY_BEFORE}${escapeRe(normal)}${tail}`).test(ownerText);
}

/** Strict: a missing, NaN or unexpected value counts as hidden. */
function hidden(v: Visibility): boolean {
  const box = v.box;
  const hasBox = !!box && Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0 && box.height > 0
    && Number.isFinite(box.width) && Number.isFinite(box.height);
  return !hasBox
    || !(typeof v.opacity === "number" && v.opacity >= 0.1)
    || String(v.visibility).toLowerCase() !== "visible"
    || (v.ariaHidden !== false && !hasBox)
    || v.ariaHidden == null
    || v.inViewport !== true
    || !!v.coveredBy;
}

/** A recipient as the owner should see it: invisible and non-ASCII characters escaped, capped. */
function showRecipient(recipient: string): { shown: string; odd: boolean } {
  let shown = ""; let odd = recipient !== recipient.normalize("NFKC");
  for (const ch of recipient) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x7e) shown += ch;
    else { odd = true; shown += `\\u{${cp.toString(16).toUpperCase().padStart(4, "0")}}`; }
  }
  if (shown.length > RECIPIENT_CAP) shown = `${shown.slice(0, RECIPIENT_CAP - 3)}...`;
  return { shown, odd };
}

const TARGETLESS = new Set(["navigate", "read"]);

/** The I6 rule of `browser-extension-policy.ts` `discloses`, as a pure function. True means the destination carries data.
 * Like the policy: the owner-requested exemption covers navigate and read only; any operation with a destination on
 * another origin is checked; the same-origin checks apply to navigate and read. Stricter than the policy: a username or
 * password in the destination URL is always data (the core lane should add the same check to the policy). */
export function navigationCarriesData(action: IntentAction): boolean {
  if (!action.destination) return false;
  const navigation = ["navigate", "read"].includes(action.operation);
  let destination: URL; try { destination = new URL(action.destination); } catch { return true; }
  if (destination.username || destination.password) return true;
  if (action.ownerRequested === true && navigation) return false;
  if (destination.origin !== (originOf(action.origin) ?? action.origin)) return destination.pathname !== "/" || !!destination.search || !!destination.hash;
  if (!navigation || action.pageDataRead !== true || action.presentedLink === true) return false;
  let current: URL; try { current = new URL(action.currentUrl ?? ""); } catch { return true; }
  return destination.pathname !== current.pathname || destination.search !== current.search;
}

/** I5: the first other origin whose read entries share a 40-character span or a secret-looking token with the new text. */
function carriedFrom(input: IntentInput, to: string, typedText: string): string | undefined {
  const typedText_ = typedText;
  const history = alnum(input.typedHistory?.get(to) ?? "").slice(-(SHINGLE - 1));
  const typed = history + alnum(typedText);
  const fresh = history.length; // only windows that end in the new text: earlier typing was checked when it was typed
  if (typed.length <= fresh) return undefined;
  for (const [origin, raw] of input.readOrigins) {
    if ((originOf(origin) ?? origin) === to) continue;
    const set: ReadonlySet<string> = raw instanceof Set ? raw : new Set(raw as readonly string[]);
    // A saturated origin lost some spans: typed text long enough to hold one is asked about rather than passed.
    if (set.has(SATURATED) && typed.length - fresh > 0 && typed.length >= SHINGLE) return origin;
    // A saturated token reserve lost some secret-looking tokens: typed text that holds one is asked about.
    if (set.has(SATURATED_TOKENS) && secretTokens(typedText_).length) return origin;
    const lengths = [SHINGLE];
    for (let n = MIN_TOKEN; n < SHINGLE; n++) if (set.has(LEN_MARK + n)) lengths.push(n);
    for (const n of lengths) {
      for (let end = Math.max(fresh + 1, n); end <= typed.length; end++) {
        if (set.has(h53(typed, end - n, end))) return origin;
      }
    }
  }
  return undefined;
}

export function recipientUnknown(action: { operation: string; sendCapable?: boolean; recipientScanFailed?: boolean; conversationApproved?: boolean }): boolean {
  return action.sendCapable !== false && ["click", "dblclick", "double_click", "tap", "activate", "keyboard_activate", "press", "keyboard_press", "key", "submit"].includes(action.operation.replace(/^agent_browser_/, "")) && action.recipientScanFailed === true && action.conversationApproved !== true;
}

export function checkIntent(input: IntentInput): IntentResult {
  const { action } = input;
  const prior = Number.isFinite(input.counters.hits) ? input.counters.hits : PAUSE_AT;
  const pause: IntentResult = { result: "refuse", rule: "I7", line: INTENT_LINES.I7 };
  const unknown = recipientUnknown(action);
  if (unknown && prior >= PAUSE_AT) return pause;

  const gated = action.level !== "L1";
  const mode = input.mode ?? "task";

  // I4 first: a refusal can never be softened by anything below.
  const targeted = action.hasTarget ?? !TARGETLESS.has(action.operation);
  const refuse4: IntentResult = unknown && prior + 1 >= PAUSE_AT ? pause : { result: "refuse", rule: "I4", line: INTENT_LINES.I4 };
  if (targeted ? !input.visibility || hidden(input.visibility) : !!input.visibility && hidden(input.visibility)) return refuse4;

  // Every card rule that fires adds its line; the first names the rule. Only an unknown-recipient send is an I7 hit.
  const hits: Array<{ rule: IntentRule; line: string }> = [];

  // I1 task scope.
  const navigating = ["navigate", "read"].includes(action.operation) && !!action.destination;
  if (mode !== "step" && (gated || navigating)) {
    const target = navigating ? originOf(action.destination) : originOf(action.origin);
    const sites = new Set([...input.taskSites].map((s) => originOf(s) ?? s));
    if (!target || !sites.has(target)) hits.push({ rule: "I1", line: INTENT_LINES.I1 });
  }

  // I2 new recipients of send-capable actions, each named with hidden characters shown.
  if (action.sendCapable !== false && withoutSecretValues(action.recipients).length) {
    const recipients = withoutSecretValues(action.recipients);
    const ownerText = fold(input.ownerWords.join(" \n "));
    const ownerDigitRuns = [...ownerText.matchAll(/\+?\d[\d\s().-]{5,}\d/g)].map((m) => m[0].replace(/\D/g, ""));
    const thread = new Set((input.threadRecipients ?? []).map((r) => fold(r)));
    const fresh = [...new Set(recipients.filter((r) => !ownerNamed(r, ownerText, ownerDigitRuns) && !(r === r.normalize("NFKC") && !/\p{Cf}/u.test(r) && thread.has(fold(r)))))];
    for (const r of fresh.slice(0, MAX_RECIPIENT_LINES)) {
      const { shown, odd } = showRecipient(r);
      hits.push({ rule: "I2", line: odd ? `${INTENT_LINES.I2(shown)} ${INTENT_LINES.I2_HIDDEN}` : INTENT_LINES.I2(shown) });
    }
  }

  // T22: the scan that finds recipients could not run. Unknown recipients are asked about (attended) or refused (a routine).
  if (unknown) {
    if (input.unattended === true) return { result: "refuse", rule: "I2", line: INTENT_LINES.I2_UNKNOWN };
    hits.push({ rule: "I2", line: INTENT_LINES.I2_UNKNOWN });
    if (action.recipientNoField === true || action.recipientComposer === true) hits.push({ rule: "I2", line: action.conversationEligible === true ? INTENT_LINES.I2_CHAT : INTENT_LINES.I2_CHAT_EACH });
  }

  // I3 from the probe's flag, once the action is gated.
  if (input.probeFlagged && gated) hits.push({ rule: "I3", line: INTENT_LINES.I3 });

  // I5 cross-site carry.
  if (gated && action.typedText) {
    const to = originOf(action.destination) ?? originOf(action.origin) ?? action.origin;
    const from = carriedFrom(input, to, action.typedText);
    if (from !== undefined) hits.push({ rule: "I5", line: INTENT_LINES.I5(hostOf(originOf(from) ?? from), hostOf(to)) });
  }

  // I6 data in navigation.
  if (navigationCarriesData(action)) hits.push({ rule: "I6", line: INTENT_LINES.I6(hostOf(originOf(action.destination) ?? action.origin)) });

  if (hits.length) {
    if (unknown && prior + 1 >= PAUSE_AT) return pause;
    return { result: "card", rule: hits[0].rule, line: hits.map((h) => h.line).join("\n") };
  }
  // The intent check never passes a floor action.
  if (action.level === "floor") return { result: "card" };
  return { result: "pass" };
}
