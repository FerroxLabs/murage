// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 ERRORS-NAME relay 4. Flux names why it refused in a code, but not always in the same place. Recorded on flux-router
// origin/master:
//   Rate-limit gate  429 {"error":{"type":"rate_limit_exceeded","state":"free_cap_reached","message":"Your account's monthly
//                    free-tier token allowance is exhausted. ..."}}: the code is in `state`, never in the sentence, and LiteLLM
//                    flattens the dict into error.message as a Python repr ('state': 'free_cap_reached').
//   Billing gate     402 credit_exhausted (metering on): the body is a plain sentence plus "Top up at ..."; the code rides only the
//                    X-Flux-Hold-Reason header. Metering off: {"error":"credit_exhausted","message":...}.
//   Credit gate      402 credit_unresolved; 429 hold with X-Flux-Hold-Reason and "Retry in Ns." in the message.
//   Billing gate     429 {"error":"hourly_burn_limit", ..., "retry_after": <seconds>} from the hourly spend gate (FLUX-BURN-COPY-1018);
//                    Fuigo relays it as ACP -32003 "API error (status 429 Too Many Requests): None: hourly_burn_limit".
// The engine relays some of this as sanitised prose (embedded JSON removed), so the code is read here from the raw error, its
// RPC data and Fuigo's retry notice, and travels on the runtime.error as its own field.

export type FluxRefusalCode = "free_cap_reached" | "credit_exhausted" | "credit_unresolved" | "hourly_burn_limit" | "hold";
export const FLUX_REFUSAL_CODES: ReadonlySet<string> = new Set<FluxRefusalCode>(["free_cap_reached", "credit_exhausted", "credit_unresolved", "hourly_burn_limit", "hold"]);

const TEXT_MAX = 16_384;
const MAX_STRINGS = 64;
const HOLD_TEXT = /because other requests have temporarily reserved it/i;
const HOLD_HEADER = /^x-flux-hold-reason$/i;

/** Every string in a value, depth 4 at most and a bounded count, with the key each one sat under. `numbers`: a finite number
 * is read as its decimal text too (retry_after arrives as a JSON number). */
function strings(value: unknown, out: Array<[string, string]>, key = "", depth = 0, numbers = false): void {
  if (out.length >= MAX_STRINGS || depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") { out.push([key, value.slice(0, TEXT_MAX)]); return; }
  if (typeof value === "number") { if (numbers && Number.isFinite(value)) out.push([key, String(value)]); return; }
  if (value instanceof Error) { strings(value.message, out, "message", depth + 1, numbers); strings((value as { data?: unknown }).data, out, "data", depth + 1, numbers); return; }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 16)) strings(item, out, key, depth + 1, numbers); return; }
  for (const name of Object.keys(value).slice(0, 32)) strings((value as Record<string, unknown>)[name], out, name, depth + 1, numbers);
}

/** The Flux refusal code anywhere in these sources, or undefined. A spent free allowance wins over a credit code, a credit code
 * wins over the hourly spend gate, and that gate wins over a hold, so the strongest "sending again will not help" reading is kept. */
export function fluxRefusalCode(...sources: unknown[]): FluxRefusalCode | undefined {
  const found: Array<[string, string]> = [];
  for (const source of sources) strings(source, found);
  let credit: FluxRefusalCode | undefined;
  let hold = false;
  let hourly = false;
  for (const [key, text] of found) {
    // A code this module already read and carried structurally (ProviderHttpError.data.flux_code) reads back as itself: a
    // header-only hold stores the bare word "hold", which the text patterns below do not match.
    if (["flux_code", "state", "code", "error"].includes(key) && text === "hold") { hold = true; continue; }
    if (/\bfree_cap_reached\b|monthly free-tier token allowance/i.test(text)) return "free_cap_reached";
    if (/\bcredit_exhausted\b/i.test(text)) credit = "credit_exhausted";
    else if (!credit && /\bcredit_unresolved\b/i.test(text)) credit = "credit_unresolved";
    if (/\bhourly_burn_limit\b/i.test(text)) hourly = true;
    if (/["'](?:state|code|error)["']\s*:\s*["']hold["']/i.test(text)) hold = true;
    if (HOLD_HEADER.test(key) || /x-flux-hold-reason/i.test(text) || HOLD_TEXT.test(text)) hold = true;
  }
  return credit ?? (hourly ? "hourly_burn_limit" : hold ? "hold" : undefined);
}

/** A code the engine may resend once (a hold names a real wait); the others never get a second send. */
export function fluxRefusalFinal(code: FluxRefusalCode | undefined): boolean {
  return code === "free_cap_reached" || code === "credit_exhausted" || code === "credit_unresolved" || code === "hourly_burn_limit";
}

// FLUX-BURN-COPY-1018 design r16: the hourly reset time is read only from a refusal body document, never from prose, a header,
// an array or any key outside the wrappers below. A document is one whole JSON / Python-repr object, optionally after one of
// the exact transport prefixes Fuigo was recorded sending.
/** The Flux service sends at least 60 seconds and about an hour at most; anything outside two hours is not trusted as a time. */
const RETRY_AFTER_MAX_S = 2 * 60 * 60;
const BODY_WRAPPERS = ["detail", "error", "data", "body"] as const;
const BODY_DEPTH = 6;
const PARSE_NESTING = 32;
const DOCUMENT_PREFIXES = ["", "429 Too Many Requests: ", "API error (status 429 Too Many Requests): None: ", "API error (status 429 Too Many Requests): "] as const;
const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([["\\", "\\"], ["'", "'"], ["\"", "\""], ["/", "/"], ["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"], ["t", "\t"]]);
const HEX = /^[0-9a-fA-F]$/;
const DIGITS = /^\d{1,4}$/;

/** A number read from a body document, kept as its source lexeme so 1e3 or 60.5 is never taken for whole seconds. */
class Lexeme {
  readonly text: string;
  constructor(text: string) { this.text = text; }
}
/** A parsed array: kept opaque so no rule ever reads inside it. */
const ARRAY = Symbol("array");
const FAIL = Symbol("fail");
type Parsed = string | Lexeme | boolean | null | typeof ARRAY | { [key: string]: Parsed };

function isSpace(ch: string | undefined): boolean { return ch === " " || ch === "\t" || ch === "\r" || ch === "\n"; }
function isDigit(ch: string | undefined): boolean { return ch !== undefined && ch >= "0" && ch <= "9"; }

/** The strict grammar of design r16 (JSON plus the Python literal forms a repr emits). Every failure is FAIL, never a throw. */
class BodyParser {
  i = 0;
  open = 0;
  readonly text: string;
  constructor(text: string) { this.text = text; }
  space(): void { while (isSpace(this.text[this.i])) this.i++; }
  value(): Parsed | typeof FAIL {
    const ch = this.text[this.i];
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === "\"" || ch === "'") return this.string();
    if (ch === "-" || isDigit(ch)) return this.number();
    for (const [word, value] of [["true", true], ["false", false], ["null", null], ["True", true], ["False", false], ["None", null]] as const) {
      if (this.text.startsWith(word, this.i)) { this.i += word.length; return value; }
    }
    return FAIL;
  }
  object(): Parsed | typeof FAIL {
    if (++this.open > PARSE_NESTING) return FAIL;
    this.i++;
    const out: { [key: string]: Parsed } = Object.create(null);
    this.space();
    if (this.text[this.i] === "}") { this.i++; this.open--; return out; }
    for (;;) {
      const quote = this.text[this.i];
      if (quote !== "\"" && quote !== "'") return FAIL;
      const key = this.string();
      if (key === FAIL || Object.prototype.hasOwnProperty.call(out, key)) return FAIL;
      this.space();
      if (this.text[this.i] !== ":") return FAIL;
      this.i++;
      this.space();
      const value = this.value();
      if (value === FAIL) return FAIL;
      out[key] = value;
      this.space();
      if (this.text[this.i] === ",") { this.i++; this.space(); continue; }
      if (this.text[this.i] === "}") { this.i++; this.open--; return out; }
      return FAIL;
    }
  }
  array(): Parsed | typeof FAIL {
    if (++this.open > PARSE_NESTING) return FAIL;
    this.i++;
    this.space();
    if (this.text[this.i] === "]") { this.i++; this.open--; return ARRAY; }
    for (;;) {
      if (this.value() === FAIL) return FAIL;
      this.space();
      if (this.text[this.i] === ",") { this.i++; this.space(); continue; }
      if (this.text[this.i] === "]") { this.i++; this.open--; return ARRAY; }
      return FAIL;
    }
  }
  string(): string | typeof FAIL {
    const quote = this.text[this.i++];
    let out = "";
    while (this.i < this.text.length) {
      const ch = this.text[this.i++]!;
      if (ch === quote) return out;
      if (ch.charCodeAt(0) < 0x20) return FAIL;
      if (ch !== "\\") { out += ch; continue; }
      const esc = this.text[this.i++];
      if (esc === undefined) return FAIL;
      const simple = SIMPLE_ESCAPES.get(esc);
      if (simple !== undefined) { out += simple; continue; }
      const width = esc === "u" ? 4 : esc === "x" ? 2 : 0;
      if (!width) return FAIL;
      const hex = this.text.slice(this.i, this.i + width);
      if (hex.length !== width || ![...hex].every((digit) => HEX.test(digit))) return FAIL;
      out += String.fromCharCode(parseInt(hex, 16));
      this.i += width;
    }
    return FAIL;
  }
  number(): Lexeme | typeof FAIL {
    const start = this.i;
    if (this.text[this.i] === "-") this.i++;
    if (!this.digits()) return FAIL;
    if (this.text[this.i] === ".") { this.i++; if (!this.digits()) return FAIL; }
    if (this.text[this.i] === "e" || this.text[this.i] === "E") {
      this.i++;
      if (this.text[this.i] === "+" || this.text[this.i] === "-") this.i++;
      if (!this.digits()) return FAIL;
    }
    return new Lexeme(this.text.slice(start, this.i));
  }
  digits(): boolean { const start = this.i; while (isDigit(this.text[this.i])) this.i++; return this.i > start; }
}

/** The object a whole body document holds (an optional recorded prefix, one object, nothing after it), or undefined. */
function bodyDocument(text: string): { [key: string]: Parsed } | undefined {
  if (text.length > TEXT_MAX) return undefined;
  let start = 0;
  while (isSpace(text[start])) start++;
  for (const prefix of DOCUMENT_PREFIXES) {
    if (!text.startsWith(prefix, start)) continue;
    const parser = new BodyParser(text);
    parser.i = start + prefix.length;
    parser.space();
    if (text[parser.i] !== "{") continue;
    const value = parser.object();
    if (value === FAIL || typeof value !== "object" || value === null || value instanceof Lexeme) continue;
    parser.space();
    if (parser.i === text.length) return value;
  }
  return undefined;
}

/** Whole seconds in 1..7200, from a JS number, a parsed number lexeme or a string of plain digits; otherwise undefined. */
function retryAfterSeconds(value: unknown): number | undefined {
  const seconds = typeof value === "number" ? value
    : value instanceof Lexeme ? (DIGITS.test(value.text) ? Number(value.text) : NaN)
    : typeof value === "string" ? (DIGITS.test(value) ? Number(value) : NaN)
    : NaN;
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= RETRY_AFTER_MAX_S ? seconds : undefined;
}

/** retry_after from one refusal-body value (design r16 "Reading a source"). `underError`: this value sat under an `error` key,
 * the one place LiteLLM puts its repr of the Flux dict, as the string `message`. */
function bodyRetryAfter(value: unknown, depth: number, underError = false): number | undefined {
  if (depth > BODY_DEPTH || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const document = bodyDocument(value);
    return document ? bodyRetryAfter(document, depth + 1) : undefined;
  }
  if (typeof value !== "object" || Array.isArray(value) || value instanceof Lexeme) return undefined;
  if (value instanceof Error) return bodyRetryAfter((value as { data?: unknown }).data, depth + 1);
  // Only a plain record (a JSON-shaped object or a parsed body): a Date, Map or class instance carries no body (Astra FBC16b).
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const record = value as Record<string, unknown>;
  const own = (key: string): unknown => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
  const direct = retryAfterSeconds(own("retry_after"));
  if (direct !== undefined) return direct;
  for (const key of BODY_WRAPPERS) {
    const found = bodyRetryAfter(own(key), depth + 1, key === "error");
    if (found !== undefined) return found;
  }
  const message = own("message");
  return underError && typeof message === "string" ? bodyRetryAfter(message, depth + 1) : undefined;
}

/** FLUX-BURN-COPY-1018: when Flux hourly spend gate lifts (epoch ms), from the retry_after seconds a refusal body document
 * carried at its top level or under detail/error/data/body (or LiteLLM's error.message repr); undefined otherwise. */
export function fluxHourlyResetsAt(now: number, ...sources: unknown[]): number | undefined {
  for (const source of sources) {
    const seconds = bodyRetryAfter(source, 0);
    if (seconds !== undefined) return now + seconds * 1000;
  }
  return undefined;
}

/** A refusal that is still the hourly gate but whose last answer named no reset keeps the reset an earlier notice named. */
export function fluxRefusalFieldsKeeping(code: FluxRefusalCode | undefined, now: number, saved: { code?: FluxRefusalCode; resetsAt?: number } | undefined, ...sources: unknown[]): { gatewayCode?: FluxRefusalCode; gatewayResetsAt?: number } {
  const fields = fluxRefusalFields(code, now, ...sources);
  if (code === "hourly_burn_limit" && fields.gatewayResetsAt === undefined && saved?.code === "hourly_burn_limit" && saved.resetsAt !== undefined) return { ...fields, gatewayResetsAt: saved.resetsAt };
  return fields;
}

/** The runtime.error fields for a Flux refusal: its code and, for the hourly gate only, the reset time its body carried. */
export function fluxRefusalFields(code: FluxRefusalCode | undefined, now: number, ...sources: unknown[]): { gatewayCode?: FluxRefusalCode; gatewayResetsAt?: number } {
  if (!code) return {};
  const resetsAt = code === "hourly_burn_limit" ? fluxHourlyResetsAt(now, ...sources) : undefined;
  return resetsAt === undefined ? { gatewayCode: code } : { gatewayCode: code, gatewayResetsAt: resetsAt };
}

/** HTTP evidence from ACP data or the recorded Fuigo transport prefix; never the JSON-RPC code (-32003). */
export function refusalHttpStatus(...sources: unknown[]): number | undefined {
  const found: Array<[string, string]> = [];
  for (const source of sources) strings(source, found, "", 0, true);
  for (const [key, value] of found) {
    if (["http_status", "httpStatus", "status", "status_code"].includes(key) && /^[45]\d{2}$/.test(value)) return Number(value);
  }
  for (const [, value] of found) {
    const match = /^(?:API error \(status |HTTP )([45]\d{2})\b/.exec(value);
    if (match) return Number(match[1]);
  }
  return undefined;
}
