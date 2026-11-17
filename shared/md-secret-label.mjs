import { vendorSecretSpans } from "./provider-secret-mask.mjs";
// Shared original-offset secret-label vocabulary, standalone candidate policy,
// and incremental detector. Machine/speech compatibility exports stay intact.
// User-text activation is owned by Wave 2A; this module does not activate sinks.

/** A secret-shaped name and its separator, run over the NORMALIZED line. */
const SECRET_NAME = "(?:api[ _-]?key|apikey|secret|token|password|passwd|authorization|auth[ _-]?token|access[ _-]?key|private[ _-]?key)s?";
const SECRET_LABEL = new RegExp(SECRET_NAME + "[ \\t]*[=:]", "gi");
const SECRET_NAME_LINE = new RegExp("^[ \\t]*" + SECRET_NAME + "[ \\t]*$", "i");
const MARKS = new Set(["*", "`", "~", "«", "»"]);
const LEAD = new Set([">", "-", "+", " ", "\t"]);
const ALNUM = /[A-Za-z0-9]/;
const isBlank = (c) => c === " " || c === "\t";
/** Longest name the label can end in (`authorization` + `s`), with room. */
const WINDOW_NAME = 16;
class SecretLabelBudgetError extends Error {
  constructor() { super("secret label scan budget"); }
}

/** Stream masking stops counting past this much text per (thread, field). */
export const MD_STREAM_CAP = 64 * 1024;

const MARKER = /^(?:«redacted \d{1,9} chars»|«redacted»|«redacted private key»|«redacted provider credentials»)$/;
/** Exactly one of our own markers, nothing before or after it. */
export function isExactMarker(s) { return MARKER.test(String(s)); }

/** A copy of the line with marks deleted, the index of each kept character,
 * and D, the index of the first deleted character (-1 when none). */
function normalize(line, spend) {
  let n = "", d = -1, lead = true;
  const map = [];
  for (let i = 0; i < line.length; i++) {
    spend();
    const c = line[i];
    let del;
    if (lead && LEAD.has(c)) del = true;
    else {
      lead = false;
      if (MARKS.has(c)) del = true;
      else if (c === "_") del = !(i > 0 && ALNUM.test(line[i - 1]) && i + 1 < line.length && ALNUM.test(line[i + 1]));
      else del = false;
    }
    if (del) { if (d < 0) d = i; } else { n += c; map.push(i); }
  }
  return { n, map, d };
}

/** Every secret label on one line, left to right: `sepEnd` is the index just
 * after its separator, `wrapped` says a mark was deleted before the value. */
export function findSecretLabels(line, charge) {
  const text = String(line ?? "");
  // Bound allocation, normalization, regex scanning and value lookahead. The
  // speech entry points catch exhaustion and release only the fixed fallback.
  let work = 1024 * 1024;
  const spend = charge ?? ((units = 1) => { if ((work -= units) < 0) throw new SecretLabelBudgetError(); });
  spend(text.length);
  const { n, map, d } = normalize(text, spend);
  const out = [];
  SECRET_LABEL.lastIndex = 0;
  for (let m; (m = SECRET_LABEL.exec(n)); ) {
    spend();
    const sep = m.index + m[0].length - 1;
    let v = text.length;
    for (let j = sep + 1; j < n.length; j++) { spend(); if (!isBlank(n[j])) { v = map[j]; break; } }
    out.push({ sepEnd: map[sep] + 1, wrapped: d >= 0 && d < v });
  }
  return out;
}

/** Extent A: at the first wrapped label, everything after its separator to the
 * END OF THE TEXT becomes one mask, unless that rest is exactly one marker. */
export function maskSecretLabelsToEnd(text, mask, charge, edits, discardCarry) {
  const s = String(text ?? "");
  for (let start = 0; start <= s.length; ) {
    let end = s.indexOf("\n", start);
    if (end < 0) end = s.length;
    let hit;
    try {
      hit = findSecretLabels(s.slice(start, end), charge).find((label) => label.wrapped);
    } catch (error) {
      // Machine sinks discard the entire input on exhaustion, including any
      // preceding lines. Direct TTS callers still receive the budget error.
      if (error instanceof SecretLabelBudgetError && !charge) {
        // A5: Basic forwarding on exhaustion must remain exactly as on the
        // release base, which reported no edit here. The carrying adapter drops
        // vendor extents instead. Standalone edit consumers still get the edit.
        if (discardCarry) discardCarry();
        else edits?.({ start: 0, end: s.length, length: "«redacted»".length });
        return "«redacted»";
      }
      throw error;
    }
    if (hit) {
      const at = start + hit.sepEnd, rest = s.slice(at);
      if (isExactMarker(rest.trim())) return s;
      const replacement = ` ${mask(rest)}`;
      edits?.({ start: at, end: s.length, length: replacement.length });
      return s.slice(0, at) + replacement;
    }
    start = end + 1;
  }
  return s;
}

// ── streaming ─────────────────────────────────────────────────────────
// The detector over `line + raw` for each delta, kept incremental so a long
// unfinished line costs nothing per delta: the line's D, whether it is still
// in its leading run, the last normalized characters a label can end in, and
// an open label whose value has not started yet.

/** Fresh per-(thread, field) line state. `len` is the unfinished line length. */
export function createLabelStream() {
  return { len: 0, d: -1, lead: true, win: "", prevAlnum: false, pendU: -1, open: false, units: 0 };
}
function resetLine(st) {
  st.len = 0; st.d = -1; st.lead = true; st.win = ""; st.prevAlnum = false; st.pendU = -1; st.open = false;
}
// A bounded normalized suffix retaining the first two horizontal whitespace
// units verbatim. Two units preserve non-matching internal name gaps; retaining
// tabs avoids manufacturing a space-separated name. Longer separator gaps can
// be compressed without losing a name. No growing-line
// rescans or offset arrays are needed. CR is an ordinary character, never EOL.
function normalizedUnit(st, c) {
  if (st.open && !isBlank(c)) {
    st.open = false;
    if (st.d >= 0) return true;
  }
  if (!(isBlank(c) && isBlank(st.win.at(-1)) && isBlank(st.win.at(-2)))) st.win = (st.win + c).slice(-32);
  if (c !== ":" && c !== "=") return false;
  SECRET_LABEL.lastIndex = 0;
  let endingHere = false;
  for (let m; (m = SECRET_LABEL.exec(st.win));) if (m.index + m[0].length === st.win.length) endingHere = true;
  if (!endingHere) return false;
  if (st.d >= 0) return true;
  st.open = true;
  return false;
}
/** Feed only new UTF-16 units; return the safe prefix length in this delta. */
export function scanLabelDelta(st, raw) {
  if (typeof raw !== "string") throw new SecretLabelBudgetError();
  if (raw.length > 1_048_576) throw new SecretLabelBudgetError();
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i], abs = st.len;
    st.units++;
    if (c === "\n") {
      if (st.pendU >= 0) { if (st.d < 0) st.d = st.pendU; st.pendU = -1; }
      if (st.open && st.d >= 0) return i;
      resetLine(st); continue;
    }
    st.len++;
    if (st.pendU >= 0) {
      if (ALNUM.test(c)) { if (normalizedUnit(st, "_")) return i; }
      else if (st.d < 0) st.d = st.pendU;
      st.pendU = -1;
    }
    let del = false;
    if (st.lead && LEAD.has(c)) del = true;
    else {
      st.lead = false;
      if (MARKS.has(c)) del = true;
      else if (c === "_") {
        if (st.prevAlnum) { st.pendU = abs; st.prevAlnum = false; continue; }
        del = true;
      }
    }
    st.prevAlnum = ALNUM.test(c);
    if (del) {
      if (st.d < 0) st.d = abs;
      // A mark after an otherwise plain label makes its value wrapped too.
      if (st.open) return i;
    } else if (normalizedUnit(st, c)) return c === ":" || c === "=" ? i + 1 : i;
  }
  return -1;
}

export const SECRET_SCAN_BUDGET = 1_048_576;
export const SECRET_TYPE_WORDS = Object.freeze(["string", "number", "boolean", "null", "object", "array", "undefined", "unknown", "any", "void", "never", "token"]);
const TYPES = new Set(SECRET_TYPE_WORDS);
// Provider registry shared with the candidate adapter. Wave 2A can consume
// these spans before its legacy rewrites. Complete scalar tails and folded
// SG/PyPI segments belong to the same credential, not independent regex hits.
export const SECRET_PROVIDER_PATTERN = /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gl(?:pat|dt|rtr?)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*|xox[abposr]-[A-Za-z0-9-]{20,}|xapp-\d-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}\b|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{40,}|hf_[A-Za-z0-9]{30,}|SG\.[A-Za-z0-9_-]{22}\.[ \t]*(?:\r?\n[ \t]*)?[A-Za-z0-9_-]{43,}|pypi-[A-Za-z0-9_-]{16,}(?:\r?\n[ \t]*[A-Za-z0-9_-]+)?)/g;
const AUTH_SPAN = /\b(?:Bearer|Basic)[ \t]+([A-Za-z0-9._~+/=-]{12,})/gi;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/g;
const SCALAR_TAIL = /[^\s<>"'`«»]/;
function providerSpans(text, spend) {
  // Four bounded native passes: PEM header/footer, provider, auth.
  spend(text.length * 4);
  const out = [];
  PEM_BEGIN.lastIndex = 0;
  for (let m; (m = PEM_BEGIN.exec(text));) {
    const body = m.index + m[0].length;
    PEM_END.lastIndex = body;
    const close = PEM_END.exec(text);
    // Preserve header/footer for ordinary PEM, but unmatched bodies extend
    // through end-of-unit; later BEGIN markers cannot re-open a raw suffix.
    out.push({ from: body, to: close ? close.index : text.length, pem: true });
    if (!close) break;
    PEM_BEGIN.lastIndex = close.index + close[0].length;
  }
  SECRET_PROVIDER_PATTERN.lastIndex = 0;
  for (let m; (m = SECRET_PROVIDER_PATTERN.exec(text));) {
    let to = SECRET_PROVIDER_PATTERN.lastIndex;
    while (to < text.length && SCALAR_TAIL.test(text[to])) { spend(); to++; }
    out.push({ from: m.index, to }); SECRET_PROVIDER_PATTERN.lastIndex = to;
  }
  AUTH_SPAN.lastIndex = 0;
  for (let m; (m = AUTH_SPAN.exec(text));) {
    const from = m.index + m[0].length - m[1].length;
    let to = AUTH_SPAN.lastIndex;
    while (to < text.length && SCALAR_TAIL.test(text[to])) { spend(); to++; }
    out.push({ from, to }); AUTH_SPAN.lastIndex = to;
  }
  return out;
}
/**
 * One original-input pass: candidates and rendered Markdown/plain additions.
 * `user` applies D3's narrow type/count exceptions; `turn` never exempts wrapped
 * labels. `machine` adds the historical bare-name and multiline registry.
 * Existing machine/speech exports stay source-compatible; Wave 2A owns sink
 * activation. Caller-specific legacy rules still follow the candidate pass.
 */
export function scanSecretText(text, options = {}) { return scan(text, options); }

/** One cap for the complete checker, including caller compatibility passes.
 * complete receives the SAME charging function as normalization and providers. */
export function scan(text, options = {}, complete) {
  let budget = 0, workUnits = 0;
  const spend = (n = 1) => { if (n > budget - workUnits) { workUnits = budget; throw new SecretLabelBudgetError(); } workUnits += n; };
  const candidates = [], spans = [];
  try {
    const requested = options.budget ?? SECRET_SCAN_BUDGET;
    if (!Number.isFinite(requested) || requested < 0) throw new SecretLabelBudgetError();
    budget = Math.min(SECRET_SCAN_BUDGET, Math.floor(requested));
    if (typeof text !== "string") throw new SecretLabelBudgetError();
    // Reserve normalization/input and output work before copies or offset maps.
    spend(text.length * 2);
    const providers = options.providers === false ? [] : providerSpans(text, spend);
    for (let start = 0; start < text.length;) {
      let end = text.indexOf("\n", start); if (end < 0) end = text.length;
      const line = text.slice(start, end), { n, map, d } = normalize(line, spend);
      // The historical machine registry also recognizes a bare name on its
      // own line. User text deliberately keeps no-separator/multiline prose.
      if (options.mode === "machine" && SECRET_NAME_LINE.test(n)) {
        candidates.push({ start, sepEnd: end, wrapped: d >= 0, name: n.trim().toLowerCase(), separator: "" });
        spans.push({ from: end, to: text.length, wrapped: true }); break;
      }
      let wordEnd = line.length; while (wordEnd > 0 && isBlank(line[wordEnd - 1])) wordEnd--;
      let wordStart = wordEnd; while (wordStart > 0 && !/\s/.test(line[wordStart - 1])) wordStart--;
      SECRET_LABEL.lastIndex = 0;
      for (let m; (m = SECRET_LABEL.exec(n));) {
        spend();
        const sep = m.index + m[0].length - 1, sepEnd = map[sep] + 1;
        let v = sep + 1; while (v < n.length && isBlank(n[v])) { spend(); v++; }
        const wrapped = d >= 0 && d < (v < n.length ? map[v] : line.length);
        const name = m[0].slice(0, -1).trim().toLowerCase();
        const candidate = { start: start + map[m.index], sepEnd: start + sepEnd, wrapped, name, separator: n[sep] };
        candidates.push(candidate);
        let nameEnd = sep; while (nameEnd > m.index && isBlank(n[nameEnd - 1])) nameEnd--;
        const code = line[map[m.index] - 1] === "`" && line[map[nameEnd - 1] + 1] === "`";
        const word = line.slice(Math.max(wordStart, sepEnd), wordEnd).trim();
        let valueStart = sepEnd; while (valueStart < wordEnd && isBlank(line[valueStart])) valueStart++;
        const plainValue = valueStart < wordEnd && !/\s/.test(line.slice(valueStart, wordEnd));
        if (wrapped || options.mode === "machine") {
          const exempt = (options.mode === undefined || options.mode === "user") && code && plainValue && TYPES.has(word) && !/\S/.test(text.slice(end));
          if (!exempt) { spans.push({ from: start + sepEnd, to: text.length, wrapped: true }); break; }
        } else if (n[sep] === ":" && (m.index === 0 || !/[A-Za-z0-9]/.test(n[m.index - 1])) && plainValue && !TYPES.has(word) && !(name === "tokens" && /^\d+$/.test(word))) {
          spans.push({ from: start + valueStart, to: start + wordEnd, wrapped: false });
        }
      }
      if (spans.at(-1)?.wrapped) break;
      start = end + 1;
    }
    // Union overlaps before rendering anything. Preserve wrapped extent even
    // when a provider span begins earlier, without exposing a provider suffix.
    spans.push(...providers);
    spend(spans.length * (1 + Math.ceil(Math.log2(spans.length + 1))));
    spans.sort((a, b) => a.from - b.from || b.to - a.to);
    const merged = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span.from < last.to) { last.to = Math.max(last.to, span.to); last.wrapped ||= span.wrapped; }
      else merged.push({ ...span });
    }
    const parts = []; let at = 0;
    for (const span of merged) {
      if (span.from < at) continue;
      parts.push(text.slice(at, span.from));
      const rest = text.slice(span.from, span.to);
      const replacement = (span.wrapped || span.pem) && isExactMarker(rest.trim()) ? rest
        : span.pem ? "\n" + (options.mode === "turn" ? "«redacted»" : `«redacted ${rest.trim().length} chars»`) + "\n"
        : (span.wrapped ? " " : "") + (options.mode === "turn" ? "«redacted»" : `«redacted ${rest.length} chars»`);
      spend(replacement.length); parts.push(replacement); at = span.to;
    }
    parts.push(text.slice(at));
    const result = { text: parts.join(""), detected: spans.length > 0, exhausted: false, candidates, spans: merged, workUnits };
    const combined = complete ? complete(text, result, spend) : result;
    // A1/A2: compatibility, rendering and the exhaustion decision finish
    // before vendor discovery. No vendor extent enters a charged sort.
    const base = { ...combined, workUnits };
    if (options.vendor === false || options.providers === false || base.exhausted) return base;
    return addVendorSpans(text, base, options);
  } catch {
    // No input, error message, secondary traversal or partial prefix escapes.
    return { text: "«redacted»", detected: true, exhausted: true, candidates: [], spans: [], workUnits };
  }
}

/** A3: both lists are already ordered. The addition is linear and uncharged. */
export function addVendorSpans(text, base, options = {}) {
  if (base.exhausted) return base;
  const vendors = vendorSecretSpans(text);
  if (!vendors.length) return base;
  const legacy = base.spans ?? [], visible = [];
  // B1: subtract base-covered input first. A fully covered vendor disappears;
  // a partial overlap contributes only its visible remainder, never a base
  // marker, label, count or the spacing retained by the base renderer.
  let i = 0;
  for (const vendor of vendors) {
    let from = vendor.start;
    while (i < legacy.length && legacy[i].to <= from) i++;
    let j = i;
    while (j < legacy.length && legacy[j].from < vendor.end) {
      const covered = legacy[j];
      if (from < covered.from) visible.push({ from, to: covered.from, vendor: true });
      from = Math.max(from, covered.to);
      if (from >= vendor.end) break;
      j++;
    }
    if (from < vendor.end) visible.push({ from, to: vendor.end, vendor: true });
    i = j;
  }
  if (!visible.length) return base;
  const merged = [], parts = [];
  let j = 0, at = 0; i = 0;
  // A3: ordered two-list merge, with rendering kept separate from span union.
  // Adjacent vendor/base masks may coalesce in metadata only.
  while (i < legacy.length || j < visible.length) {
    const a = legacy[i], b = visible[j];
    const span = !b || (a && a.from <= b.from) ? legacy[i++] : visible[j++];
    parts.push(text.slice(at, span.from));
    const rest = text.slice(span.from, span.to);
    const replacement = span.vendor || options.turnComplete
      ? (options.mode === "turn" ? "«redacted»" : `«redacted ${rest.length} chars»`)
      : (span.wrapped || span.pem) && isExactMarker(rest.trim()) ? rest
      : span.pem ? "\n" + (options.mode === "turn" ? "«redacted»" : `«redacted ${rest.trim().length} chars»`) + "\n"
      : (span.wrapped ? " " : "") + (options.mode === "turn" ? "«redacted»" : `«redacted ${rest.length} chars»`);
    parts.push(replacement); at = span.to;
    const last = merged.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  parts.push(text.slice(at));
  return { ...base, text: parts.join(""), spans: merged, detected: true };
}
