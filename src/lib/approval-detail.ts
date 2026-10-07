// Turns a tool approval's raw input into something an owner can read.
//
// The rule: the plain summary may ADD readability but never hides anything an
// owner would decide on. A headline (`primary`, `secondary`) says the main
// thing; every other argument stays on the card as a `key: value` line in
// `extra`. A long value is cut with a visible count of what is hidden and
// carries its full text in `full` so the card can expand it in place.
// `raw` is the ORIGINAL text of the input, never a re-serialized copy.
import { t } from "@/lib/i18n";

export interface ApprovalLine {
  text: string;
  /** the whole line, when `text` was cut */
  full?: string;
  /** characters not shown in `text` */
  hidden?: number;
  mono?: boolean;
}

export interface ApprovalDetail {
  /** headline; monospace when `mono` */
  primary: string;
  mono: boolean;
  secondary?: string;
  /** every remaining argument */
  extra: ApprovalLine[];
  raw?: string;
}

type Input = Record<string, unknown>;

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Read"]);
const SHELL_TOOLS = new Set(["Bash"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
const LINE_LIMIT = 80;
const CLAUDE_TOOLS = new Set([...FILE_TOOLS, ...SHELL_TOOLS, ...WEB_TOOLS]);

/** Only Claude sends structured tool input: its exact-case built-ins and
 * mcp__ tools. Every other source (Codex, ACP, pi, peer bots, the browser
 * extension, routines) sends model-written text, which renders verbatim so
 * it can never be dressed up as a verified path or command. */
export function formatsToolInput(tool: string | undefined): boolean {
  return Boolean(tool) && (tool!.startsWith("mcp__") || CLAUDE_TOOLS.has(tool!));
}

function builtIn(toolName: string): string | undefined {
  return CLAUDE_TOOLS.has(toolName) ? toolName : undefined;
}

/** User-visible characters. Never splits an emoji or a combined glyph. */
function graphemes(s: string): string[] {
  const Seg = (Intl as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  return Seg ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), x => x.segment) : [...s];
}

function parse(input: unknown): { obj?: Input; text?: string } {
  if (typeof input === "string") {
    if (input.trim().startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(input);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { obj: parsed as Input };
      } catch { /* plain text that merely starts with a brace */ }
    }
    return { text: input };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) return { obj: input as Input };
  return {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Shows bidi controls, zero-width characters and stacked combining marks as
 * visible escapes, so text can never display as something else. */
export function visibleText(s: string): string {
  return s
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, c => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`)
    .replace(/(\p{M}{3})\p{M}+/gu, "$1…");
}

const LITERAL_LIKE = /^(true|false|null|-?\d[\d.eE+-]*)$|^\s|\s$|^$/;

function display(v: unknown): string {
  return visibleText(displayRaw(v));
}

function displayRaw(v: unknown): string {
  if (typeof v === "string") return LITERAL_LIKE.test(v) ? JSON.stringify(v) : v.replace(/\s*\n\s*/g, " ⏎ ");
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every(x => ["number", "boolean"].includes(typeof x) || (typeof x === "string" && !x.includes(", ") && !x.includes("\n") && !LITERAL_LIKE.test(x)))) return v.join(", ");
  return JSON.stringify(v);
}

function line(key: string, v: unknown, mono = false): ApprovalLine {
  const full = `${visibleText(key)}: ${display(v)}`;
  const chars = graphemes(full);
  if (chars.length <= LINE_LIMIT) return { text: full, mono };
  return { text: `${chars.slice(0, LINE_LIMIT).join("")}…`, full, hidden: chars.length - LINE_LIMIT, mono };
}

function rest(o: Input, consumed: ReadonlySet<string>): ApprovalLine[] {
  return Object.keys(o).filter(k => !consumed.has(k)).map(k => line(k, o[k]));
}

function lineCount(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

function editExtent(e: Input): number {
  return Math.max(lineCount(String(e.old_string ?? "")), lineCount(String(e.new_string ?? "")));
}

function changes(n: number, every: boolean): string {
  return t(every ? (n === 1 ? "approval.changesLineEvery" : "approval.changesLinesEvery") : (n === 1 ? "approval.changesLine" : "approval.changesLines"), { n: String(n) });
}

function recipientKey(o: Input): { key: string; value: string } | undefined {
  for (const k of ["to", "recipient_email", "recipient", "recipients", "to_email", "email"]) {
    const v = o[k];
    if (Array.isArray(v)) {
      // only a list of plain strings is a recipient list; anything else is listed in full
      if (v.length && v.every(x => typeof x === "string" && x !== "")) return { key: k, value: v.join(", ") };
    } else if (str(v)) return { key: k, value: str(v)! };
  }
  return undefined;
}

function contentLines(content: string): ApprovalLine[] {
  const all = display(content);
  const chars = graphemes(all);
  const size = { text: t("approval.contentSize", { chars: String(graphemes(content).length), lines: String(lineCount(content)) }) };
  if (chars.length <= 160) return [size, { text: all, mono: true }];
  return [size, { text: `${chars.slice(0, 160).join("")}…`, full: all, hidden: chars.length - 160, mono: true }];
}

export function approvalDetail(toolName: string, input: unknown): ApprovalDetail {
  const d = buildDetail(toolName, input);
  return {
    ...d,
    primary: visibleText(d.primary),
    ...(d.secondary !== undefined ? { secondary: visibleText(d.secondary) } : {}),
    ...(d.raw !== undefined ? { raw: visibleText(d.raw) } : {}),
  };
}

function buildDetail(toolName: string, input: unknown): ApprovalDetail {
  const { obj, text } = parse(input);
  const tool = builtIn(toolName);
  if (text !== undefined) return { primary: text, mono: tool !== undefined && SHELL_TOOLS.has(tool), extra: [] };
  if (!obj || Object.keys(obj).length === 0) return { primary: "", mono: false, extra: [] };
  const raw = typeof input === "string" ? input : JSON.stringify(obj, null, 2);
  const nested: Input | undefined = obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments) ? (obj.arguments as Input) : undefined;
  const args: Input = nested ?? obj;
  const outer = (consumed: Set<string>): ApprovalLine[] => (nested ? rest(obj, new Set(["arguments"])) : []).concat(rest(args, consumed));

  // shell: the command is the headline, in full
  const command = str(obj.command);
  if (tool && SHELL_TOOLS.has(tool) && command) {
    const note = str(obj.description);
    const one = note ? note.replace(/\s+/g, " ").trim() : undefined;
    return {
      primary: command, mono: true,
      ...(one ? { secondary: t("approval.botNote", { note: one.length > 120 ? `${one.slice(0, 119)}…` : one }) } : {}),
      extra: rest(obj, new Set(note ? ["command", "description"] : ["command"])), raw,
    };
  }

  // known file tools only
  const path = str(obj.file_path) ?? str(obj.notebook_path) ?? str(obj.path);
  if (tool && FILE_TOOLS.has(tool) && path) {
    const consumed = new Set([str(obj.file_path) ? "file_path" : str(obj.notebook_path) ? "notebook_path" : "path"]);
    let secondary: string | undefined;
    let extra: ApprovalLine[];
    if (tool === "Write" && typeof obj.content === "string") {
      consumed.add("content");
      extra = [...contentLines(obj.content), ...rest(obj, consumed)];
    } else if (tool === "Edit") {
      const n = editExtent(obj);
      secondary = changes(n, obj.replace_all === true);
      if (typeof obj.replace_all === "boolean") consumed.add("replace_all");
      extra = rest(obj, consumed);
    } else if (tool === "MultiEdit" && Array.isArray(obj.edits)) {
      const edits = obj.edits.filter((e): e is Input => Boolean(e) && typeof e === "object");
      secondary = changes(edits.reduce((n, e) => n + editExtent(e), 0), false);
      consumed.add("edits");
      extra = [...obj.edits.map((e, i) => line(`edit ${i + 1}`, e)), ...rest(obj, consumed)];
    } else if (tool === "NotebookEdit") {
      if (obj.edit_mode === "delete") secondary = t("approval.deletesCell");
      extra = rest(obj, consumed);
    } else extra = rest(obj, consumed);
    return { primary: path, mono: false, ...(secondary ? { secondary } : {}), extra, raw };
  }

  // web tools only
  const web = str(obj.url) ?? str(obj.query);
  if (tool && WEB_TOOLS.has(tool) && web) {
    return { primary: web, mono: false, extra: rest(obj, new Set([str(obj.url) ? "url" : "query"])), raw };
  }

  // send-type tools: recipient headline, everything else (cc, bcc, attachments, body) stays visible
  const to = recipientKey(args);
  if (to && /send|mail|reply|draft/.test(toolName.toLowerCase().replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ""))) {
    const subject = str(args.subject);
    const consumed = new Set([to.key, ...(subject ? ["subject"] : [])]);
    return {
      primary: t("approval.to", { to: to.value }),
      mono: false,
      ...(subject ? { secondary: t("approval.subject", { subject }) } : {}),
      extra: outer(consumed), raw,
    };
  }

  // anything else: every key, in order
  const all = outer(new Set());
  const [head, ...others] = all;
  return { primary: head?.full ?? head?.text ?? "", mono: false, extra: others, raw };
}
