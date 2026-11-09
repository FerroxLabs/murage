// Secret labels wrapped in markdown marks, for MACHINE sinks only: the native
// protocol log, server log lines and the desktop diagnostics tail. Design:
// design REDACT-MD-SINKS-1104.md (extent A). No imports: the server
// and the desktop shell both load this file.
//
// User-visible text keeps today's rule (redactSecretsInText); nothing here
// runs on stored messages, cards, channel replies or notifications.

/** A secret-shaped name and its separator, run over the NORMALIZED line. */
const SECRET_LABEL = /(?:api[ _-]?key|apikey|secret|token|password|passwd|authorization|auth[ _-]?token|access[ _-]?key|private[ _-]?key)s?[ \t]*[=:]/gi;
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
export function findSecretLabels(line) {
  const text = String(line ?? "");
  // Bound allocation, normalization, regex scanning and value lookahead. The
  // speech entry points catch exhaustion and release only the fixed fallback.
  let work = 1024 * 1024;
  const spend = (units = 1) => { if ((work -= units) < 0) throw new SecretLabelBudgetError(); };
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
export function maskSecretLabelsToEnd(text, mask) {
  const s = String(text ?? "");
  for (let start = 0; start <= s.length; ) {
    let end = s.indexOf("\n", start);
    if (end < 0) end = s.length;
    let hit;
    try {
      hit = findSecretLabels(s.slice(start, end)).find((label) => label.wrapped);
    } catch (error) {
      // Machine sinks discard the entire input on exhaustion, including any
      // preceding lines. Direct TTS callers still receive the budget error.
      if (error instanceof SecretLabelBudgetError) return "«redacted»";
      throw error;
    }
    if (hit) {
      const at = start + hit.sepEnd, rest = s.slice(at);
      return isExactMarker(rest.trim()) ? s : `${s.slice(0, at)} ${mask(rest)}`;
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
  return { len: 0, d: -1, lead: true, win: "", prevAlnum: false, pendU: -1, open: false };
}

function resetLine(st) {
  st.len = 0; st.d = -1; st.lead = true; st.win = ""; st.prevAlnum = false; st.pendU = -1; st.open = false;
}

/** Feeds one delta. Returns -1 when no wrapped label is found (state kept),
 * else the index in `raw` from which everything must be masked. */
export function scanLabelDelta(st, raw) {
  for (let from = 0; ; ) {
    const nl = raw.indexOf("\n", from);
    const to = nl < 0 ? raw.length : nl;
    const hit = scanSegment(st, raw, from, to, nl >= 0);
    if (hit >= 0) return hit;
    if (nl < 0) return -1;
    resetLine(st);
    from = nl + 1;
  }
}

function scanSegment(st, raw, from, to, closes) {
  const base = st.len;
  const toRaw = (abs) => Math.max(0, abs - base + from);
  let n = "";
  const map = [];
  for (let i = from; i < to; i++) {
    const c = raw[i], abs = base + (i - from);
    if (st.pendU >= 0) {
      if (ALNUM.test(c)) { n += "_"; map.push(st.pendU); } else if (st.d < 0) st.d = st.pendU;
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
    if (del) { if (st.d < 0) st.d = abs; } else { n += c; map.push(abs); }
  }
  st.len = base + (to - from);
  if (closes && st.pendU >= 0 && st.d < 0) st.d = st.pendU;
  const lineEnd = st.len;
  // A label from an earlier delta whose value had not begun.
  if (st.open) {
    let v = -1;
    for (let j = 0; j < n.length; j++) if (!isBlank(n[j])) { v = map[j]; break; }
    if (v >= 0 || closes) {
      st.open = false;
      if (st.d >= 0 && st.d < (v >= 0 ? v : lineEnd)) return 0;
    } else if (st.d >= 0) return 0;
  }
  const probe = st.win + n, offset = st.win.length;
  SECRET_LABEL.lastIndex = 0;
  for (let m; (m = SECRET_LABEL.exec(probe)); ) {
    const sep = m.index + m[0].length - 1;
    if (sep < offset) continue;
    let v = -1;
    for (let j = sep + 1; j < probe.length; j++) if (!isBlank(probe[j])) { v = map[j - offset]; break; }
    const sepEnd = toRaw(map[sep - offset] + 1);
    if (v >= 0) { st.open = false; if (st.d >= 0 && st.d < v) return sepEnd; continue; }
    if (st.d >= 0) return sepEnd;
    if (!closes) st.open = true;
  }
  let k = probe.length;
  while (k > 0 && isBlank(probe[k - 1])) k--;
  st.win = probe.slice(Math.max(0, k - WINDOW_NAME), k) + probe.slice(k, k + 2);
  return -1;
}
