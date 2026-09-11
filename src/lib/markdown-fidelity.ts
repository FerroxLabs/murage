// Markdown fidelity gate for the workspace editor (F4-T2, adopted U-06).
//
// The `.md` file on disk is canonical. Rich (Tiptap) editing is offered only
// when the pinned @tiptap/markdown 3.31.3 parser and serializer reproduce the
// file's Markdown body byte for byte AND every token class in the file belongs
// to the frozen supported set. Anything else opens in Source mode, which edits
// the exact text. Refusing lossy rich editing is never a refusal to open.
//
// Bytes the editor never sees are carried as opaque parts: the UTF-8 BOM
// (already removed by the read contract and echoed back on write), the
// newline style (CRLF is normalized to LF for the editor and restored on
// compose), YAML frontmatter, and the blank lines before and after the body
// (the serializer never emits a trailing newline).
import { Editor, type AnyExtension, type JSONContent, type MarkdownToken } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import type { WorkspaceNewline } from "../../shared/workspace-files";

/** Measured on the pinned parser: dense Markdown takes ~30 ms at 16 KiB,
 * ~0.3 s at 32 KiB and ~1.8 s at 64 KiB (it grows super-linearly). Larger
 * files open in Source mode so opening a document never stalls the window. */
export const MARKDOWN_RICH_EDIT_MAX_BYTES = 32 * 1024;

/** Frozen supported token classes. `markdown-fidelity.test.ts` proves every
 * class here round-trips in the committed corpus. A class is the marked token
 * type, refined where one token type covers syntaxes the serializer rewrites
 * (for example `code:indented`, `heading:setext`, `list:bullet:loose`). */
export const SUPPORTED_MARKDOWN_TOKEN_CLASSES = Object.freeze([
  "blockquote",
  "br",
  "code:fenced",
  "codespan",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "link",
  "list:bullet",
  "list:ordered",
  "list_item",
  "paragraph",
  "space",
  "strong",
  // The TaskList extension's own tokenizer claims `- [ ]` lists before marked
  // sees them, so task lists lex as these two classes, not `list_item`.
  "taskItem",
  "taskList",
  "text",
] as const);
export type SupportedMarkdownTokenClass = (typeof SUPPORTED_MARKDOWN_TOKEN_CLASSES)[number];
const SUPPORTED = new Set<string>(SUPPORTED_MARKDOWN_TOKEN_CLASSES);

/** One extension set for the fidelity check and the live editor, so the gate
 * proves exactly what the editor will do. Underline has no Markdown syntax;
 * the trailing-node plugin would append an unauthored paragraph on the first
 * keystroke; links never open or auto-create from typed or pasted text.
 * Tables stay registered so pasted tables keep their structure, but a file
 * containing one opens in Source mode because 3.31.3 re-pads table cells and
 * adds blank lines around them. There is no image extension: rich mode never
 * fetches a local or remote image. */
export function createMarkdownExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      underline: false,
      trailingNode: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: false },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Markdown,
  ];
}

/** A document whose body is empty. ProseMirror requires one block. */
export const EMPTY_MARKDOWN_DOC: JSONContent = Object.freeze({ type: "doc", content: [{ type: "paragraph" }] }) as JSONContent;

export interface MarkdownDocumentParts {
  /** Newline style of the whole text. `crlf` parts are stored with LF. */
  newline: Exclude<WorkspaceNewline, "mixed">;
  /** YAML frontmatter including both delimiter lines, or "". */
  frontmatter: string;
  /** Blank lines between the frontmatter (or file start) and the body. */
  leading: string;
  /** What the rich editor shows and serializes. */
  body: string;
  /** Newlines after the body. */
  trailing: string;
}

export type MarkdownFidelityReason =
  | "too-large"
  | "mixed-newlines"
  | "unsupported-syntax"
  | "round-trip-changed"
  | "parse-failed";

export interface MarkdownFidelityReport {
  richEditable: boolean;
  /** Empty when rich editing is allowed. Ordered by check. */
  reasons: MarkdownFidelityReason[];
  /** UTF-8 bytes of the analyzed text (BOM excluded). */
  bytes: number;
  newline: WorkspaceNewline;
  /** Sorted token classes found in the body (empty when not lexed). */
  tokenClasses: string[];
  unsupportedTokenClasses: string[];
  /** `null` when the text cannot be split without changing bytes. */
  parts: MarkdownDocumentParts | null;
}

const encoder = new TextEncoder();
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Newline style of text as written. A lone CR makes the text `mixed`. */
export function detectNewline(text: string): WorkspaceNewline {
  let lf = 0;
  let crlf = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) !== 10) return "mixed";
      crlf += 1;
      index += 1;
    } else if (code === 10) {
      lf += 1;
    }
  }
  if (lf && crlf) return "mixed";
  return crlf ? "crlf" : lf ? "lf" : "none";
}

// YAML frontmatter: an opening `---` line whose next line is not blank, up to
// the first closing `---` or `...` line. Requiring a non-blank first line
// keeps a document that merely starts with a thematic break (`---`, blank,
// prose, `---`) editable as prose instead of hiding it as opaque metadata.
const FRONTMATTER = /^---[ \t]*\n(?:(?![ \t]*\n)[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/;

/** Split text (BOM already removed) into opaque parts and the editable body.
 * Returns `null` for mixed newlines, which Source mode edits verbatim. */
export function splitMarkdownDocument(text: string): MarkdownDocumentParts | null {
  const newline = detectNewline(text);
  if (newline === "mixed") return null;
  const lf = newline === "crlf" ? text.replace(/\r\n/g, "\n") : text;
  const frontmatter = FRONTMATTER.exec(lf)?.[0] ?? "";
  const rest = lf.slice(frontmatter.length);
  const leading = /^\n*/.exec(rest)?.[0] ?? "";
  const afterLeading = rest.slice(leading.length);
  const trailing = /\n*$/.exec(afterLeading)?.[0] ?? "";
  const body = afterLeading.slice(0, afterLeading.length - trailing.length);
  const parts: MarkdownDocumentParts = { newline, frontmatter, leading, body, trailing };
  // Defensive: the split must be lossless or the parts are unusable.
  return composeMarkdownDocument(parts, body) === text ? parts : null;
}

/** Recombine opaque parts with a (possibly edited) LF body. */
export function composeMarkdownDocument(parts: MarkdownDocumentParts, body: string): string {
  const lf = parts.frontmatter + parts.leading + body + parts.trailing;
  return parts.newline === "crlf" ? lf.replace(/\r?\n/g, "\r\n") : lf;
}

function tokenClass(token: MarkdownToken): string {
  const raw = typeof token.raw === "string" ? token.raw : "";
  switch (token.type) {
    case "list":
      return `list:${token.ordered ? "ordered" : "bullet"}${token.loose ? ":loose" : ""}`;
    case "list_item":
      return token.task ? "list_item:task" : "list_item";
    case "code": {
      const opener = raw.replace(/^ {0,3}/, "");
      return opener.startsWith("```") ? "code:fenced" : opener.startsWith("~~~") ? "code:tilde" : "code:indented";
    }
    case "heading":
      return /^ {0,3}#/.test(raw) ? "heading" : "heading:setext";
    case "link":
      return raw.startsWith("[^") ? "footnote" : raw.startsWith("[") ? "link" : raw.startsWith("<") ? "link:autolink" : "link:bare";
    case "paragraph":
      // marked has no tokens for directives or display math; they lex as
      // plain paragraphs and would be edited as prose.
      if (/^ {0,3}:{3,}/m.test(raw)) return "directive";
      if (/^ {0,3}\$\$/m.test(raw)) return "math";
      return "paragraph";
    default:
      return String(token.type ?? "unknown");
  }
}

function collectTokenClasses(tokens: MarkdownToken[] | undefined, into: Set<string>): Set<string> {
  for (const token of tokens ?? []) {
    into.add(tokenClass(token));
    collectTokenClasses(token.tokens, into);
    collectTokenClasses(token.items, into);
    for (const cell of (token.header ?? []) as MarkdownToken[]) collectTokenClasses(cell.tokens, into);
    for (const row of (token.rows ?? []) as MarkdownToken[][]) for (const cell of row) collectTokenClasses(cell.tokens, into);
  }
  return into;
}

let analysisEditor: Editor | null = null;
/** A never-mounted editor that owns the schema and Markdown manager. */
function analyzer(): Editor {
  analysisEditor ??= new Editor({
    element: null,
    injectCSS: false,
    extensions: createMarkdownExtensions(),
    content: EMPTY_MARKDOWN_DOC,
  });
  return analysisEditor;
}

/** Token classes in an LF Markdown body, lexed exactly as the editor lexes. */
export function markdownTokenClasses(body: string): string[] {
  const manager = analyzer().markdown;
  if (!manager) throw new Error("Markdown extension is not registered");
  const lexer = new manager.instance.Lexer(manager.instance.defaults);
  return [...collectTokenClasses(lexer.lex(body) as MarkdownToken[], new Set())].sort();
}

/** Parse an LF body into schema-checked editor JSON and serialize it back. */
export function roundTripMarkdownBody(body: string): { doc: JSONContent; markdown: string } {
  const editor = analyzer();
  const manager = editor.markdown;
  if (!manager) throw new Error("Markdown extension is not registered");
  const parsed = body === "" ? EMPTY_MARKDOWN_DOC : manager.parse(body);
  const node = editor.schema.nodeFromJSON(parsed);
  node.check();
  const doc = node.toJSON() as JSONContent;
  return { doc, markdown: manager.serialize(doc) };
}

/** Decide whether `text` (strict UTF-8 content, BOM removed) may open in rich
 * mode. Pure apart from the cached analysis editor; never touches bytes. */
export function analyzeMarkdownFidelity(text: string, options: { maxRichBytes?: number } = {}): MarkdownFidelityReport {
  const bytes = utf8ByteLength(text);
  const newline = detectNewline(text);
  const report: MarkdownFidelityReport = {
    richEditable: false,
    reasons: [],
    bytes,
    newline,
    tokenClasses: [],
    unsupportedTokenClasses: [],
    parts: splitMarkdownDocument(text),
  };
  if (bytes > (options.maxRichBytes ?? MARKDOWN_RICH_EDIT_MAX_BYTES)) report.reasons.push("too-large");
  if (!report.parts) {
    report.reasons.push("mixed-newlines");
    return report;
  }
  if (report.reasons.length) return report;
  const { body } = report.parts;
  try {
    report.tokenClasses = markdownTokenClasses(body);
    report.unsupportedTokenClasses = report.tokenClasses.filter(name => !SUPPORTED.has(name));
    if (report.unsupportedTokenClasses.length) {
      report.reasons.push("unsupported-syntax");
      return report;
    }
    if (roundTripMarkdownBody(body).markdown !== body) report.reasons.push("round-trip-changed");
  } catch {
    report.reasons.push("parse-failed");
  }
  report.richEditable = report.reasons.length === 0;
  return report;
}
