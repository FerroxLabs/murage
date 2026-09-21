// What a tool chip should say.
//
// Some engines do not call tools directly. They expose one or two tools of
// their own — "use a tool", "search for a tool" — and pass the real call
// through as an argument. Left alone, every chip in the transcript reads as
// that wrapper, so the transcript says the bot ran the same thing twenty
// times and never says what it actually did. These helpers pull the real
// name, and a short human summary of the arguments, back out.
//
// And when a tool fails, the reason arrives with the result. It used to go
// only to the model; these helpers pull it out so the person can read it too.

/** What a chip shows: the tool's own name, plus a short read of its input. */
export type ToolLabel = { name: string; summary?: string };

const MAX_NAME = 80;
const MAX_SUMMARY = 80;

/** Argument names that carry the point of the call, best first. A value under
 * one of these reads as a summary on its own ("sweep1 canary"); anything else
 * is labelled with its argument name so it is not mistaken for prose. */
const SUMMARY_KEYS = ["query", "q", "prompt", "text", "path", "file_path", "filename", "url", "command", "pattern", "name", "title"];

function clean(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** `murage-memory-1f83c2b4__memory_search` and `mcp__files__read` are both
 * one tool with a server bolted to the front. The person cares about the
 * tool. */
export function bareToolName(name: string): string {
  const parts = name.split("__").filter(Boolean);
  return (parts.length > 1 ? parts[parts.length - 1] : name).trim();
}

function summarize(input: unknown): string | undefined {
  if (typeof input === "string") return clean(input, MAX_SUMMARY) || undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clean(value, MAX_SUMMARY);
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim()) return clean(`${key}: ${value}`, MAX_SUMMARY);
    if (typeof value === "number" || typeof value === "boolean") return clean(`${key}: ${value}`, MAX_SUMMARY);
  }
  return undefined;
}

/**
 * The chip for one tool call.
 *
 * `rawInput.command` still wins, because a shell chip has always shown the
 * command and that is the most useful thing it could say. Otherwise a
 * `tool_name` argument means this call went through a wrapper: that inner
 * name is the tool, and the wrapper's own name is noise.
 */
export function resolveToolLabel(title: unknown, rawInput: unknown): ToolLabel {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : undefined;
  const command = input?.command;
  if (typeof command === "string" && command.trim()) {
    return { name: clean(command, MAX_NAME) };
  }
  const inner = input?.tool_name ?? input?.toolName;
  if (typeof inner === "string" && inner.trim()) {
    const name = clean(bareToolName(inner), MAX_NAME) || clean(inner, MAX_NAME);
    return { name, summary: summarize(input?.tool_input ?? input?.toolInput ?? input?.arguments ?? input?.args ?? input?.input) };
  }
  const name = clean(typeof title === "string" && title.trim() ? title : "tool", MAX_NAME) || "tool";
  // A tool-search wrapper has no inner tool to name, so the chip keeps its
  // name and borrows the query — "what was it looking for" is the only thing
  // that distinguishes one of these from the next.
  const summary = /(^|[_-])(search|find)([_-]|$)/i.test(name) ? summarize(input) : undefined;
  return summary ? { name, summary } : { name };
}

/**
 * The tool that actually ran, for decisions a chip's wording must not steer.
 *
 * `resolveToolLabel` is a DISPLAY helper and deliberately does not answer this
 * question: a call carrying `command` is shown as its shell command, because
 * the command is the useful thing for a person to read. Anything that has to
 * classify the tool — retention, admission, gating — must not read that.
 * An ACP `computer_exec` running `firefox` is still Murage's computer surface;
 * labelled "firefox" it stops looking like one, and the live screen frame it
 * answers with becomes a permanent file.
 *
 * Returns the name the engine called, never an argument it was called with,
 * or undefined when the update carries no name at all.
 */
export function resolveToolIdentity(title: unknown, rawInput: unknown): string | undefined {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : undefined;
  const inner = input?.tool_name ?? input?.toolName;
  if (typeof inner === "string" && inner.trim()) return clean(bareToolName(inner), MAX_NAME) || clean(inner, MAX_NAME);
  return typeof title === "string" && title.trim() ? clean(title, MAX_NAME) : undefined;
}

const MAX_FAILURE = 4000;

/** ACP hands a failed tool's reason back in one of three shapes depending on
 * the engine: text content parts, a structured `rawOutput`, or a plain
 * `error`. Returns the text a person should be shown, or undefined when the
 * engine genuinely said nothing. */
export function toolFailureText(update: unknown): string | undefined {
  if (!update || typeof update !== "object") return undefined;
  const u = update as Record<string, unknown>;
  const parts: string[] = [];

  const content = u.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      const block = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
      const inner = block?.content && typeof block.content === "object" ? (block.content as Record<string, unknown>) : block;
      const text = inner?.text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }

  if (!parts.length) {
    const fromRaw = errorFromOutput(u.rawOutput) ?? errorFromOutput(u.output) ?? errorFromOutput(u.error);
    if (fromRaw) parts.push(fromRaw);
  }

  const joined = parts.join("\n\n").trim();
  if (!joined) return undefined;
  return joined.length > MAX_FAILURE ? `${joined.slice(0, MAX_FAILURE)}\n…` : joined;
}

function errorFromOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (!/err/i.test(key)) continue;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    if (nested && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  // Fuigo nests the result one level down (`output.ErrorOutput`), so look
  // through a single wrapper before giving up.
  for (const key of ["output", "result", "data"]) {
    const nested = record[key];
    if (nested && nested !== value) {
      const found = errorFromOutput(nested);
      if (found) return found;
    }
  }
  const message = record.message;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

/** The one line a chip shows. The rest belongs in Technical details. */
export function toolFailureSummary(detail: string, max = 160): string {
  const firstLine = detail.split("\n").map((line) => line.trim()).find(Boolean) ?? detail.trim();
  return firstLine.length > max ? `${firstLine.slice(0, max - 1).trimEnd()}…` : firstLine;
}
