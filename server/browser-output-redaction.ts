// SPDX-License-Identifier: AGPL-3.0-or-later
// Murage for Chrome: the one place page-derived text is cleaned before it leaves the machine or lands on disk. The action checker request,
// the activity log, the native diagnostics, the raw HTML read and (through the C2 hook) every tool result run through here.
//
// What counts as a secret is decided by the shared classifier (shared/browser-secret-classifier.ts) and nothing else: this file only finds the
// places in running text, URLs and markup where a value sits (candidate extraction), then asks that classifier about each candidate.
import { parse, parseFragment, serialize } from "parse5";
import {
  looksLikeOpaqueToken, looksLikeOrdinaryNumber, looksLikeSecretContext, looksLikeSecretName, looksLikeSecretValue, looksLikeSsn, luhnValid, secretDigits,
} from "../shared/browser-secret-classifier.ts";
import { redactSecretsInText } from "./redact.ts";

export const HIDDEN = "[hidden]";
// cause22-E (b) (MAIN-RULING 2026-11-22T17:58:19Z Q4 + 18:02:24Z): page output is not cut at 4 MiB before it is cleaned. The cut
// dropped the rest of a long page silently, and a page with nothing to remove in its first 4 MiB came back whole with its tail unchecked.
// NEVER-UNREDACTED floor (MAIN 2026-11-22, ASTRA 0489638c7a): no walk here stops early and returns the rest as it came. The tree walk
// has no node or depth cutoff, a long attribute is cleaned like a short one, a long URL is cleaned whole; when the walk cannot finish
// (it throws), the whole output is withheld as HIDDEN by the callers' catch, never passed through.

// ---- values ---------------------------------------------------------------------------------------------------------------------------------

/** A value is a secret by shape: a number of 4 to 9 or 13 to 19 digits (not a year, date or price), an SSN, or an opaque key. */
function secretShaped(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return (looksLikeSecretValue(v) && !looksLikeOrdinaryNumber(v)) || looksLikeSsn(v) || looksLikeOpaqueToken(v);
}
function decode(value: string, plusIsSpace = false): string {
  const v = plusIsSpace ? value.replace(/\+/g, " ") : value;
  try { return decodeURIComponent(v); } catch { return v; }
}
function secretSegment(raw: string, previous: string): boolean {
  const d = decode(raw), base = d.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  if (!d) return false;
  if (secretShaped(d) || secretShaped(base)) return true;
  return !!previous && looksLikeSecretName(previous) && !looksLikeOrdinaryNumber(base);
}

// ---- URLs -----------------------------------------------------------------------------------------------------------------------------------

function cleanSegments(path: string): string {
  let previous = "";
  return path.split("/").map(seg => {
    const hide = secretSegment(seg, previous);
    previous = decode(seg);
    return hide ? HIDDEN : seg;
  }).join("/");
}
function cleanParams(params: string): string {
  return params.split("&").map(item => {
    const i = item.indexOf("=");
    if (i < 0) return item && secretShaped(decode(item, true)) ? HIDDEN : item;
    const key = item.slice(0, i), value = item.slice(i + 1);
    return value && (looksLikeSecretName(decode(key, true)) || secretShaped(decode(value, true))) ? `${key}=${HIDDEN}` : item;
  }).join("&");
}

/** A URL with the places a value can hide cleaned: credentials out; a number, key or percent-encoded value in the path, in a segment after a
 * password-like word, in the query (form-encoded too) or in the fragment (a path or parameters). The origin and the readable parts stay. */
export function redactUrlForOutput(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return redactText(raw); }
  if (!/^https?:$/.test(u.protocol)) return `${u.protocol}${HIDDEN}`;
  const query = u.search.length > 1 ? "?" + cleanParams(u.search.slice(1)) : "";
  const frag = u.hash.length > 1 ? u.hash.slice(1) : "";
  const hash = !frag ? "" : "#" + (frag.includes("=") ? cleanParams(frag) : cleanSegments(frag));
  return `${u.protocol}//${u.host}${cleanSegments(u.pathname)}${query}${hash}`;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}]+$/;
function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, match => {
    const tail = TRAILING.exec(match)?.[0] ?? "";
    return redactUrlForOutput(tail ? match.slice(0, -tail.length) : match) + tail;
  });
}

// ---- running text ---------------------------------------------------------------------------------------------------------------------------

// A label is up to four short words before ":" or "="; the value runs to the end of the line or the next delimiter, or to the closing quote.
const LABEL_SEP = /((?:[\p{L}\p{N}_'\-]{1,40}[ \t]+){0,3}[\p{L}\p{N}_\-]{1,40}["']?)([ \t]*[:=][ \t]*)/gu;
function redactLabelled(text: string): string {
  let out = "", last = 0;
  LABEL_SEP.lastIndex = 0;
  for (let m = LABEL_SEP.exec(text); m; m = LABEL_SEP.exec(text)) {
    const start = m.index + m[0].length;
    if (!looksLikeSecretName(m[1].replace(/["']/g, ""))) continue;
    let end: number;
    const q = text[start];
    if (q === '"' || q === "'") {
      let i = start + 1;
      while (i < text.length && text[i] !== q && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      end = text[i] === q ? i + 1 : Math.min(i, text.length);
    } else {
      let i = start;
      while (i < text.length && !"\n,;}]<".includes(text[i])) i++;
      end = i;
    }
    if (end <= start || text.startsWith(HIDDEN, start) || text.slice(start, end).trim() === HIDDEN) continue;
    const quoted = q === '"' || q === "'";
    out += text.slice(last, start) + (quoted ? q + HIDDEN + q : HIDDEN);
    last = end;
    LABEL_SEP.lastIndex = Math.max(end, LABEL_SEP.lastIndex);
  }
  return last ? out + text.slice(last) : text;
}

const NUMBER_RUN = /\p{Nd}+(?:[ \t  -  　\-./\\|_'‐-―−·٫٬]\p{Nd}+)*/gu;
const SPLIT_RUN = /\p{Nd}+|[^\p{Nd}]+/gu;
const isDigits = (part: string) => /^\p{Nd}/u.test(part);
function nearCode(text: string, offset: number, length: number): boolean {
  // Words on the same line, or the line above when that line only names the field: "Your code is" / newline / "48291637".
  // The line above counts only for a number that starts its own line.
  const head = text.slice(Math.max(0, offset - 60), offset), startsLine = /(^|\n)[ \t]*$/.test(head);
  const before = (startsLine ? head.split(/\n\s*\n/).pop()!.replace(/\s*\n\s*/g, " ") : head.split("\n").pop()!).slice(-44);
  const after = text.slice(offset + length, offset + length + 40).split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " ").slice(0, 24);
  const around = before + " " + after;
  return looksLikeSecretName(around) || looksLikeSecretContext(around);
}
/** A content type (or any header-like token) with its digit runs hidden: media types never need one. */
export function redactMediaType(type: string): string { return redactPageOutput(type.slice(0, 200)).replace(/\p{Nd}{4,}/gu, HIDDEN); }
/** Cards and SSNs anywhere; a 4 to 9 digit number only when a word beside it says it is a code. Years, dates and prices stay. */
function redactNumbers(text: string): string {
  return text.replace(NUMBER_RUN, (run: string, offset: number) => {
    const near = () => nearCode(text, offset, run.length);
    const digits = secretDigits(run);
    if (digits && looksLikeSecretValue(run)) {
      if (looksLikeSsn(run)) return HIDDEN;
      if (digits.length >= 13) return luhnValid(digits) || /[^\p{Nd}]/u.test(run) || near() ? HIDDEN : run;
      return looksLikeOrdinaryNumber(run) && !near() ? run : near() ? HIDDEN : run;
    }
    const parts = run.match(SPLIT_RUN) ?? [];
    if (parts.length < 3) return isDigits(run) && looksLikeSecretValue(run) && !looksLikeOrdinaryNumber(run) && near() ? HIDDEN : run;
    // A run that is not one clean number (two numbers side by side, a long list): look for a card inside it, then judge each group.
    const idx: number[] = [];
    parts.forEach((part, i) => { if (isDigits(part)) idx.push(i); });
    const spans: { from: number; to: number }[] = [];
    for (let a = 0; a < idx.length;) {
      let total = 0, b = a;
      while (b < idx.length && total < 13) { total += secretDigits(parts[idx[b]]).length || parts[idx[b]].length; b++; }
      const joined = idx.slice(a, b).map(i => parts[i]).join("");
      if (total >= 13 && total <= 19 && (luhnValid(secretDigits(joined) || joined) || b - a > 1 || near())) { spans.push({ from: idx[a], to: idx[b - 1] }); a = b; } else a++;
    }
    let out = "", s = 0;
    for (let i = 0; i < parts.length; i++) {
      if (s < spans.length && spans[s].from === i) { out += HIDDEN; i = spans[s].to; s++; continue; }
      const part = parts[i];
      out += isDigits(part) && looksLikeSecretValue(part) && !looksLikeOrdinaryNumber(part) && near() ? HIDDEN : part;
    }
    return out;
  });
}

function redactText(text: string): string {
  if (!text) return text;
  return redactNumbers(redactLabelled(redactUrls(redactSecretsInText(text))));
}

// ---- markup ---------------------------------------------------------------------------------------------------------------------------------

type HtmlNode = { nodeName: string; tagName?: string; value?: string; data?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[]; content?: HtmlNode; parentNode?: HtmlNode | null };
const URL_ATTRS = new Set(["src", "href", "srcset", "poster", "data", "action", "formaction", "background", "xlink:href"]);
const FIELD_TAGS = new Set(["input", "textarea", "select"]);
const MARKUP = /<[a-zA-Z!/]/;
const EXEMPT_ATTRS = new Set(["class", "id", "for", "type", "name", "rel", "lang", "dir", "role", "tabindex", "autocomplete"]);

/** The text under a node, without script and style. Iterative: a deep tree is read whole, never cut by the call stack. */
function textOf(root: HtmlNode): string {
  const parts: string[] = [], pending: HtmlNode[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.nodeName === "#text") { parts.push(node.value ?? ""); continue; }
    if (["script", "style"].includes(node.tagName ?? "")) continue;
    if (node.content) pending.push(node.content);
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return parts.join(" ");
}
const attrMap = (node: HtmlNode): Record<string, string> => Object.fromEntries((node.attrs ?? []).map(a => [a.name.toLowerCase(), a.value]));

/** Walks a parsed tree and cleans it in place. Returns true when anything changed. */
function cleanTree(root: HtmlNode): boolean {
  let changed = false;
  const byId = new Map<string, HtmlNode>(), labelFor = new Map<string, string[]>();
  const order: { node: HtmlNode; above: string }[] = [];
  const pending: { node: HtmlNode; above: string }[] = [{ node: root, above: "" }];
  // Every node is visited: there is no node count or depth at which the walk stops and leaves the rest of the tree as it came.
  while (pending.length) {
    const { node, above } = pending.pop()!;
    order.push({ node, above });
    const tag = (node.tagName ?? "").toLowerCase(), attrs = attrMap(node);
    if (attrs.id && !byId.has(attrs.id)) byId.set(attrs.id, node);
    let inside = above;
    if (tag === "label") { const own = textOf(node); inside = `${above} ${own}`; if (attrs.for) labelFor.set(attrs.for, [...(labelFor.get(attrs.for) ?? []), own]); }
    for (const child of node.childNodes ?? []) pending.push({ node: child, above: inside });
    if (node.content) pending.push({ node: node.content, above: inside });
  }
  for (const { node, above } of order) {
    const tag = (node.tagName ?? "").toLowerCase();
    if (node.nodeName === "#comment") { if (node.data) { node.data = ""; changed = true; } continue; }
    if (node.nodeName === "#text") {
      const parentTag = (node.parentNode?.tagName ?? "").toLowerCase();
      if (parentTag === "script" || parentTag === "noscript") continue;
      const next = parentTag === "style" ? (node.value ?? "").replace(/url\(\s*["']?data:[^)]*\)/gi, "url(data:[removed])") : redactText(node.value ?? "");
      if (next !== node.value) { node.value = next; changed = true; }
      continue;
    }
    const attrs = attrMap(node), list = node.attrs ?? [];
    const set = (a: { value: string }, value: string) => { if (a.value !== value) { a.value = value; changed = true; } };
    if ((tag === "script" || tag === "noscript") && node.childNodes?.length) { node.childNodes = []; changed = true; }
    // Content that is not on screen is not the bot's to read.
    if (("hidden" in attrs || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style ?? "")) && node.childNodes?.length) { node.childNodes = []; changed = true; }
    // A field is private by what it says it is and by what its label says.
    const named = [attrs.type, attrs.name, attrs.id, attrs.autocomplete, attrs["aria-label"], attrs.placeholder, attrs.title, above];
    if (attrs.id) named.push(...(labelFor.get(attrs.id) ?? []));
    if (attrs["aria-labelledby"]) for (const id of attrs["aria-labelledby"].split(/\s+/)) { const target = byId.get(id); if (target) named.push(textOf(target)); }
    const secretLabel = looksLikeSecretName(named.filter(Boolean).join(" "));
    const editable = ("contenteditable" in attrs && attrs.contenteditable !== "false") || attrs.role === "textbox" || tag === "textarea";
    const type = (attrs.type ?? "").toLowerCase();
    if (FIELD_TAGS.has(tag)) {
      const value = list.find(a => a.name.toLowerCase() === "value");
      if (value && (type === "hidden" || type === "password" || secretLabel || secretShaped(value.value))) set(value, HIDDEN);
    }
    if (editable && (secretLabel || type === "hidden") && node.childNodes?.length && !(node.childNodes.length === 1 && node.childNodes[0].value === HIDDEN)) {
      node.childNodes = [{ nodeName: "#text", value: HIDDEN, parentNode: node }];
      changed = true;
    }
    if (tag === "meta") {
      const content = list.find(a => a.name.toLowerCase() === "content");
      if (content && (looksLikeSecretName(`${attrs.name ?? ""} ${attrs.property ?? ""} ${attrs["http-equiv"] ?? ""}`) || secretShaped(content.value))) set(content, HIDDEN);
    }
    for (const a of list) {
      const name = a.name.toLowerCase();
      if (name.startsWith("on")) set(a, "");
      else if (name === "srcdoc") set(a, "");
      else if (/^\s*(javascript|vbscript):/i.test(a.value)) set(a, "javascript:[removed]");
      else if (/^\s*data:/i.test(a.value) && (URL_ATTRS.has(name) || name === "style")) set(a, "data:[removed]");
      else if (name === "style") set(a, a.value.replace(/url\(\s*["']?data:[^)]*\)/gi, "url(data:[removed])"));
      else if (name === "value" && FIELD_TAGS.has(tag)) continue;
      else if (name.startsWith("data-") && (looksLikeSecretName(name) || secretShaped(a.value))) set(a, HIDDEN);
      else if (URL_ATTRS.has(name) && /^https?:\/\//i.test(a.value.trim())) set(a, redactUrlForOutput(a.value.trim()));
      else if (!EXEMPT_ATTRS.has(name)) set(a, redactText(a.value));
    }
  }
  return changed;
}

/** Parses and cleans markup. `whole` is false when the parser reported an error: it may then have dropped part of the source
 * (a duplicate attribute, a stray end tag), so the source string no longer equals what was walked and must not be returned.
 * MAIN-RULING 2026-11-22T20:41:56Z redact-cutoff: redaction is total or the text is withheld. */
function cleaned(source: string, run: typeof parse | typeof parseFragment): { tree: HtmlNode; changed: boolean; whole: boolean } {
  let errors = 0;
  // A missing doctype drops nothing from the source (the parser only notes it), so a plain page without one is still whole.
  const tree = (run as (html: string, options: object) => unknown)(source, { onParseError: (error: { code?: string }) => { if (error?.code !== "missing-doctype") errors++; } }) as HtmlNode;
  return { tree, changed: cleanTree(tree), whole: errors === 0 };
}

// ---- the exports ----------------------------------------------------------------------------------------------------------------------------

/** Page-derived text, cleaned, with its provenance: `withheld` is true only when the PLATFORM replaced the whole text with the
 * placeholder because it could not be cleaned in full (a parse error, a walk or a cleaner that could not finish). A page that
 * merely spells the placeholder comes back as text with `withheld` false. MAIN-RULING 2026-11-22T21:44:35Z redact-parse-error (a):
 * on a parse error the placeholder is returned, never text that only went through the text cleaner (the parser may have dropped
 * a duplicate attribute or a stray tag from the tree that was walked, so the source no longer equals what was cleaned). */
export function redactPageOutputChecked(content: string, noLimits = false): { text: string; withheld: boolean } {
  // Only authorized model payloads opt out; diagnostics keep the default redaction.
  if (noLimits === true) return { text: content, withheld: false };
  if (typeof content !== "string") return { text: "", withheld: false };
  if (!content) return { text: content, withheld: false };
  try {
    if (MARKUP.test(content)) {
      // Page TEXT that only looks like markup keeps its shape (a name, a line of prose with "<b>"): when the tree needed no change
      // and the parser reported no error, the text itself is returned, and all of it goes through the text cleaner below.
      const { tree, changed, whole } = cleaned(content, parseFragment);
      if (!whole) return { text: HIDDEN, withheld: true };
      return { text: redactText(changed ? serialize(tree as never) : content), withheld: false };
    }
    return { text: redactText(content), withheld: false };
  } catch {
    return { text: HIDDEN, withheld: true };
  }
}

/** The one call for page-derived text. Idempotent, never throws, keeps the shape of the text. Markup is parsed (entities decoded) and cleaned;
 * text that could not be cleaned in full is the placeholder alone (redactPageOutputChecked). */
export function redactPageOutput(content: string, noLimits = false): string {
  return redactPageOutputChecked(content, noLimits).text;
}

/** Deep copy of a diagnostic record with every string (and every key) run through redactPageOutput; a secret-named field loses its value. */
export function redactPageOutputDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactPageOutput(value);
  if (typeof value === "bigint") return looksLikeSecretValue(String(value)) ? HIDDEN : value;
  if (value === null || typeof value !== "object") return value;
  if (depth > 12 || seen.has(value as object)) return HIDDEN;
  seen.add(value as object);
  try {
    if (Array.isArray(value)) return value.map(item => redactPageOutputDeep(item, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [rawKey, item] of Object.entries(value as Record<string, unknown>)) {
      const base = redactPageOutput(rawKey);
      let key = base;
      for (let n = 2; Object.hasOwn(out, key); n++) key = `${base}#${n}`;
      const secretKey = looksLikeSecretName(rawKey) && !/tokens?$/i.test(rawKey);
      out[key] = secretKey && (typeof item === "string" || typeof item === "number" || typeof item === "bigint") ? HIDDEN : redactPageOutputDeep(item, depth + 1, seen);
    }
    return out;
  } finally { seen.delete(value as object); }
}

/** Raw HTML as the bot may see it: hidden and secret field values, hidden elements, inline script data, comments, data: URLs and srcdoc removed,
 * and the decoded text and attributes cleaned. Returns the original string untouched when there was nothing to remove. Markup the
 * parser could not keep (a parse error) is left out and the output ends with the withheld marker. */
export function sanitizeRawHtml(html: string): string {
  try {
    const { tree, changed, whole } = cleaned(html, parse);
    if (!changed && whole) return html;
    // MAIN-RULING 2026-11-22T20:41:56Z redact-cutoff: source the parser dropped is never returned, and the reader says so: the
    // cleaned tree (all of it was walked) is followed by the plain withheld marker on a line of its own.
    return whole ? serialize(tree as never) : `${serialize(tree as never)}\n${HIDDEN}`;
  } catch { return HIDDEN; } // the walk or the serializer could not finish: nothing of the page is returned unchecked
}
