// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected-app events v1 (design GAP-APP-TRIGGERS-109 section 4.3; Flux contracts/app-events/v1/README.md "Transport"):
// the integer-only RFC 8785 (JCS) profile and `body_digest`, exactly as Flux defines them. The vectors are the Flux
// FINAL set copied byte-identically to test/fixtures/flux-app-events-v1/jcs/.
//
//   body_digest(value) = unpadded base64url( SHA-256( UTF-8( JCS(value) ) ) )
//
// The profile: numbers are integers in -(2^53-1)..2^53-1 (a fraction, an exponent, NaN or Infinity is refused, and so is
// any value that lost precision on the way in); strings and member names are well-formed UTF-16 (a lone surrogate is
// refused); member names sort by UTF-16 code units; array order is kept; duplicate members, a byte order mark and
// malformed UTF-8 are refused by the strict reader. Nothing here normalizes Unicode: the digest covers the exact text.
// A plain .mjs with no server imports, so any process can share it.
import { createHash } from "node:crypto";

/** A refusal. `code` is one of: float, int_range, lone_surrogate, duplicate_member, invalid_utf8, invalid_json, invalid_value, too_deep. */
export class JcsError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "JcsError";
    this.code = code;
  }
}

const MAX_DEPTH = 64;
const fail = (code, message) => { throw new JcsError(code, message); };

function checkString(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      fail("lone_surrogate", "a string holds a lone high surrogate");
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) fail("lone_surrogate", "a string holds a lone low surrogate");
  }
  return text;
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value, depth) {
  if (depth > MAX_DEPTH) fail("too_deep", "the value is nested too deeply");
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) fail("float", "numbers are integers only");
    if (!Number.isSafeInteger(value)) fail("int_range", "integers are limited to 2^53 - 1 in magnitude");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return JSON.stringify(checkString(value));
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) fail("invalid_value", "an array has a hole");
      parts.push(serialize(value[i], depth + 1));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object" && isPlainObject(value)) {
    const keys = Object.keys(value);
    for (const key of keys) checkString(key);
    // Array.prototype.sort without a comparator orders strings by UTF-16 code units: exactly RFC 8785 section 3.2.3.
    keys.sort();
    const parts = [];
    for (const key of keys) {
      const member = value[key];
      if (member === undefined) fail("invalid_value", "a member has no value");
      parts.push(`${JSON.stringify(key)}:${serialize(member, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return fail("invalid_value", `a ${typeof value} cannot be canonicalized`);
}

/** The canonical JCS text of a parsed value. Throws JcsError on anything outside the integer-only profile. */
export function canonicalize(value) {
  return serialize(value, 0);
}

/** The UTF-8 bytes of the canonical text. */
export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), "utf8");
}

/** `body_digest`: unpadded base64url SHA-256 of the canonical bytes (43 characters). */
export function bodyDigest(value) {
  return createHash("sha256").update(canonicalBytes(value)).digest("base64url");
}

// ── the strict reader ────────────────────────────────────────────────────────
// JSON.parse keeps the last of two duplicate members, reads 1.0 as 1 and 1e400 as Infinity; the contract refuses all
// three, so control bodies and fixtures are read here. The grammar is RFC 8259 with those extra refusals.

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** Parse JSON text under the contract's rules. Returns plain objects (own members only, a "__proto__" name is an ordinary member). */
export function parseStrictJson(text) {
  if (typeof text !== "string") fail("invalid_json", "JSON text must be a string");
  if (text.charCodeAt(0) === 0xfeff) fail("invalid_json", "a byte order mark is refused");
  let at = 0;
  const skip = () => { while (at < text.length && WS.has(text.charCodeAt(at))) at++; };
  const expect = (char) => { if (text[at] !== char) fail("invalid_json", `expected ${char} at ${at}`); at++; };

  function readString() {
    expect('"');
    let out = "";
    for (;;) {
      if (at >= text.length) fail("invalid_json", "unterminated string");
      const code = text.charCodeAt(at);
      if (code === 0x22) { at++; break; }
      if (code < 0x20) fail("invalid_json", "a control character must be escaped");
      if (code !== 0x5c) { out += text[at++]; continue; }
      at++;
      const esc = text[at++];
      if (esc === '"' || esc === "\\" || esc === "/") out += esc;
      else if (esc === "b") out += "\b";
      else if (esc === "f") out += "\f";
      else if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "u") {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid_json", "a \\u escape needs four hex digits");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        at += 4;
      } else fail("invalid_json", "unknown escape");
    }
    return checkString(out);
  }

  function readNumber() {
    const match = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at, at + 400));
    if (!match) fail("invalid_json", `unexpected character at ${at}`);
    if (match[1] !== undefined || match[2] !== undefined) fail("float", "numbers are integers only");
    at += match[0].length;
    const value = Number(match[0]);
    // A digit string longer than 2^53 can round to a safe-looking value; the text must survive the trip unchanged.
    const digits = match[0].replace(/^-/, "");
    if (!Number.isSafeInteger(value) || String(Math.abs(value)) !== digits) fail("int_range", "integers are limited to 2^53 - 1 in magnitude");
    return Object.is(value, -0) ? 0 : value;
  }

  function readValue(depth) {
    if (depth > MAX_DEPTH) fail("too_deep", "the value is nested too deeply");
    skip();
    const char = text[at];
    if (char === "{") {
      at++;
      const out = {};
      const seen = new Set();
      skip();
      if (text[at] === "}") { at++; return out; }
      for (;;) {
        skip();
        const key = readString();
        if (seen.has(key)) fail("duplicate_member", "a member name repeats");
        seen.add(key);
        skip();
        expect(":");
        const member = readValue(depth + 1);
        Object.defineProperty(out, key, { value: member, enumerable: true, writable: true, configurable: true });
        skip();
        if (text[at] === ",") { at++; continue; }
        expect("}");
        return out;
      }
    }
    if (char === "[") {
      at++;
      const out = [];
      skip();
      if (text[at] === "]") { at++; return out; }
      for (;;) {
        out.push(readValue(depth + 1));
        skip();
        if (text[at] === ",") { at++; continue; }
        expect("]");
        return out;
      }
    }
    if (char === '"') return readString();
    if (text.startsWith("true", at)) { at += 4; return true; }
    if (text.startsWith("false", at)) { at += 5; return false; }
    if (text.startsWith("null", at)) { at += 4; return null; }
    if (text.startsWith("NaN", at) || text.startsWith("Infinity", at) || text.startsWith("-Infinity", at)) fail("float", "NaN and Infinity are refused");
    return readNumber();
  }

  const value = readValue(0);
  skip();
  if (at !== text.length) fail("invalid_json", "text follows the value");
  return value;
}

/** Parse UTF-8 bytes: malformed UTF-8 is refused before the JSON rules apply. */
export function parseStrictJsonBytes(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("invalid_utf8", "the body is not valid UTF-8"); }
  return parseStrictJson(text);
}
