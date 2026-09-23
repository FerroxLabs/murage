// Math in chat, found before Markdown sees the text.
//
// Adapted from OpenMausBot a1590458 (#1608), with one rule reversed on
// purpose: a single dollar sign is NEVER a math delimiter. Murage is used by
// traders, and "$5 to $10" or "costs $20 and $30" are prices, not formulas.
// What counts as math here:
//   $$ … $$     display math on its own line(s), or inline math when it sits
//               inside a sentence with no space just inside either fence
//   \[ … \]     display math
//   \( … \)     inline math, on one line
// Code is never math: fenced blocks and inline code spans are set aside before
// the search, and anything that still reaches a code element (an indented
// block, say) is turned back into its source text by rehypeChatMath.
//
// Why the text is rewritten before parsing rather than after: Markdown would
// eat the delimiters first. "\(" is an escaped "(", and "$$a_1*b_1$$" would
// lose its "*" to emphasis. So each math span is swapped for a private-use
// placeholder that Markdown leaves alone, and rehypeChatMath swaps it back for
// a math element once the tree is built. No markdown-math package is needed,
// which keeps this rule ours to test.

/** One math span taken out of a message. */
export interface MathSpan {
  /** The TeX between the delimiters, trimmed. */
  tex: string;
  /** Display (block) math rather than inline. */
  display: boolean;
  /** The original text, delimiters included, for code and fallbacks. */
  raw: string;
}

/** Longest TeX we hand to KaTeX. Longer spans stay as plain text. */
export const MAX_TEX_LENGTH = 4000;
/** Most math spans taken from one message. The rest stay as plain text. */
export const MAX_MATH_SPANS = 200;

const MATH_OPEN = "\uE000";
const MATH_CLOSE = "\uE001";
const CODE_OPEN = "\uE002";
const CODE_CLOSE = "\uE003";
const RESERVED = /[\uE000-\uE003]/;
const PLACEHOLDER = /\uE000(\d+)\uE001/g;
// the same placeholder after Markdown percent-encoded it into a link target
const ENCODED_PLACEHOLDER = /%EE%80%80(\d+)%EE%80%81/gi;
const CODE_TOKEN = /\uE002(\d+)\uE003/g;
const HAS_CODE_TOKEN = /\uE002\d+\uE003/;

/** Set CommonMark fenced code blocks aside (from OpenMausBot #1608): an
 * opener at up to three spaces, optionally inside block quotes, runs to a
 * closer of the same character at least as long, or to the end. */
function protectFencedCode(text: string, protect: (value: string) => string): string {
  const opener =
    /(^|\r?\n)((?: {0,3}>[ \t]?)* {0,3})(?:(`{3,})([^`\r\n]*)|(~{3,})([^\r\n]*))(?:\r?\n|$)/g;
  let cursor = 0;
  let tokenized = "";
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    const fence = match[3] ?? match[5]!;
    const closer = new RegExp(
      `(^|\\r?\\n)(?: {0,3}>[ \\t]?)* {0,3}${fence[0]}{${fence.length},}[ \\t]*(?=\\r?\\n|$)`,
      "g",
    );
    closer.lastIndex = opener.lastIndex;
    const closing = closer.exec(text);
    const end = closing === null ? text.length : closing.index + closing[0].length;
    // keep the line break before the fence outside the token so the next
    // opener's (^|\n) anchor still sees it
    const start = match.index + match[1]!.length;
    tokenized += text.slice(cursor, start) + protect(text.slice(start, end));
    cursor = end;
    opener.lastIndex = end;
  }
  return tokenized + text.slice(cursor);
}

// One pass, so whichever delimiter comes first in the text wins.
// (?<!\\) keeps an escaped "\$$" out. "\[" and "\(" must not follow a
// letter, digit or backslash: "C:\Apps\x\(1\).md" is a Windows path with
// Markdown-escaped parentheses, not math, while "where \(x\) is" still is.
const MATH = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<![\\\w])\\\[([\s\S]+?)\\\]|(?<![\\\w])\\\(([^\r\n]+?)\\\)/g;

/** True when [start, end) fills its own line(s): only indentation or block
 * quote markers before it, only spaces after it. */
function aloneOnLine(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (!/^(?:[ \t]*>)*[ \t]*$/.test(text.slice(lineStart, start))) return false;
  const lineEnd = text.indexOf("\n", end);
  return /^[ \t\r]*$/.test(text.slice(end, lineEnd === -1 ? text.length : lineEnd));
}

/**
 * Take the math out of a message. Returns the text with each math span
 * replaced by a placeholder, and the spans in placeholder order. Text with no
 * math (or that already contains the private-use characters the placeholders
 * are made of) comes back unchanged with no spans.
 */
export function extractMath(text: string): { text: string; spans: MathSpan[] } {
  if (!/\$\$|\\\[|\\\(/.test(text) || RESERVED.test(text)) return { text, spans: [] };
  const code: string[] = [];
  const protect = (value: string) => `${CODE_OPEN}${code.push(value) - 1}${CODE_CLOSE}`;
  // fenced blocks first, then inline code spans (a run of N backticks to the
  // next run of exactly N)
  const tokenized = protectFencedCode(text, protect).replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, protect);
  const spans: MathSpan[] = [];
  const replaced = tokenized.replace(MATH, (raw: string, dollars?: string, bracket?: string, paren?: string, offset?: number) => {
    const body = dollars ?? bracket ?? paren ?? "";
    // math never swallows code, and too much math stays text
    if (HAS_CODE_TOKEN.test(body) || spans.length >= MAX_MATH_SPANS) return raw;
    const tex = body.trim();
    if (!tex || tex.length > MAX_TEX_LENGTH) return raw;
    let display: boolean;
    if (dollars !== undefined) {
      // "$$$" and "$$ and $$" are money talk, not math
      if (tex.startsWith("$") || tex.endsWith("$")) return raw;
      display = aloneOnLine(tokenized, offset ?? 0, (offset ?? 0) + raw.length);
      if (!display && /^\s|\s$/.test(body)) return raw;
    } else {
      display = bracket !== undefined;
    }
    spans.push({ tex, display, raw });
    return `${MATH_OPEN}${spans.length - 1}${MATH_CLOSE}`;
  });
  if (!spans.length) return { text, spans: [] };
  return { text: replaced.replace(CODE_TOKEN, (_m, index: string) => code[Number(index)]!), spans };
}

/** Put the original source back in place of every placeholder. */
export function restoreMathSource(value: string, spans: readonly MathSpan[]): string {
  const back = (match: string, index: string) => spans[Number(index)]?.raw ?? match;
  return value.replace(PLACEHOLDER, back).replace(ENCODED_PLACEHOLDER, back);
}

// The few hast shapes this file touches, kept local rather than pulling a
// types package in for them.
interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }

/** The attribute a math element carries; ChatMarkdown's span renderer reads it. */
export const MATH_INDEX_ATTRIBUTE = "data-chat-math";

function mathElement(index: number, span: MathSpan): HastNode {
  return {
    type: "element",
    tagName: "span",
    properties: { dataChatMath: String(index) },
    // the source is the element's text, so anything that renders it without
    // KaTeX (a copy, a search, a plain renderer) still reads the formula
    children: [{ type: "text", value: span.raw }],
  };
}

function restoreProperties(node: HastNode, spans: readonly MathSpan[]) {
  const properties = node.properties;
  if (!properties) return;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string") properties[key] = restoreMathSource(value, spans);
  }
}

/**
 * A rehype plugin that turns each placeholder left by extractMath into a
 * math element, except inside code, where it becomes the original text again.
 * Attribute values (a link target, an image's alt) get the original text too.
 */
export function rehypeChatMath(spans: readonly MathSpan[]) {
  return () => (tree: HastNode) => {
    if (!spans.length) return;
    const walk = (node: HastNode, inCode: boolean) => {
      restoreProperties(node, spans);
      const children = node.children;
      if (!children) return;
      const code = inCode || (node.type === "element" && (node.tagName === "code" || node.tagName === "pre"));
      const next: HastNode[] = [];
      for (const child of children) {
        if (child.type !== "text" || typeof child.value !== "string" || !child.value.includes(MATH_OPEN)) {
          walk(child, code);
          next.push(child);
          continue;
        }
        if (code) {
          next.push({ type: "text", value: restoreMathSource(child.value, spans) });
          continue;
        }
        let cursor = 0;
        for (const match of child.value.matchAll(PLACEHOLDER)) {
          const index = Number(match[1]);
          const span = spans[index];
          if (!span) continue;
          if (match.index! > cursor) next.push({ type: "text", value: child.value.slice(cursor, match.index) });
          next.push(mathElement(index, span));
          cursor = match.index! + match[0].length;
        }
        if (cursor < child.value.length) next.push({ type: "text", value: child.value.slice(cursor) });
      }
      node.children = next;
    };
    walk(tree, false);
  };
}
