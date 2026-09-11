// Read a CLI's own JSON config before Murage merges an entry into it.
//
// A config file that exists but cannot be read or parsed is the user's data,
// not an empty object. Replacing it would erase their settings, providers and
// any credentials kept inline. Callers therefore refuse: they write nothing,
// leave the original bytes exactly as they were, and surface repair guidance
// (0.1.52 A8). Several CLIs (Qwen Code, OpenCode) accept JSONC comments that a
// JSON.parse/JSON.stringify round trip would delete, so a commented file is
// refused with its own message rather than rewritten.
//
// Messages never echo parser output: V8's JSON.parse errors quote the file's
// text, which can hold API keys. They are also kept short, because a dispatch
// failure is shown to the user truncated to 160 characters.
import { readFileSync } from "node:fs";
import { sep } from "node:path";

export type NativeConfigProblem = "unreadable" | "comments" | "invalid-json" | "not-object" | "unexpected-shape";

function refusalMessage(path: string, problem: NativeConfigProblem, detail: string | undefined): string {
  switch (problem) {
    case "unreadable":
      return `Murage could not read ${path} (${detail ?? "read failed"}) and left it unchanged. Check its permissions, then try again.`;
    case "comments":
      return `${path} has comments or trailing commas Murage can't keep, so it was left unchanged. Remove them or add the entry by hand, then try again.`;
    case "invalid-json":
      return `${path} is not valid JSON, so Murage left it unchanged. Fix or move the file, then try again.`;
    case "not-object":
      return `${path} is not a JSON object, so Murage left it unchanged. Fix or move the file, then try again.`;
    case "unexpected-shape":
      return `${path} has an unexpected "${detail ?? "value"}" entry, so Murage left it unchanged. Fix that entry, then try again.`;
  }
}

/** Murage refused to change a native config file it could not safely merge. */
export class NativeConfigRefusal extends Error {
  readonly problem: NativeConfigProblem;
  readonly displayPath: string;

  constructor(displayPath: string, problem: NativeConfigProblem, detail?: string) {
    super(refusalMessage(displayPath, problem, detail));
    this.name = "NativeConfigRefusal";
    this.problem = problem;
    this.displayPath = displayPath;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `~/…` for a path under the user's home, so guidance is short and readable. */
export function displayConfigPath(path: string, home: string): string {
  const root = home.endsWith(sep) ? home : `${home}${sep}`;
  return home && path.startsWith(root) ? `~${sep}${path.slice(root.length)}` : path;
}

/** Remove JSONC comments and trailing commas outside strings. Used only to
 * classify a file JSON.parse rejected; the result is never written anywhere. */
function stripJsoncSyntax(text: string): string {
  let uncommented = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      uncommented += ch;
      if (ch === "\\") {
        uncommented += text[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      uncommented += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i += 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return text;
      uncommented += " ";
      i = end + 1;
    } else {
      uncommented += ch;
    }
  }

  let result = "";
  inString = false;
  for (let i = 0; i < uncommented.length; i += 1) {
    const ch = uncommented[i]!;
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += uncommented[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ",") {
      let next = i + 1;
      while (next < uncommented.length && /\s/.test(uncommented[next]!)) next += 1;
      if (uncommented[next] === "}" || uncommented[next] === "]") continue;
    }
    result += ch;
  }
  return result;
}

function looksLikeJsonc(text: string): boolean {
  const stripped = stripJsoncSyntax(text);
  if (stripped === text) return false;
  try {
    JSON.parse(stripped);
    return true;
  } catch {
    return false;
  }
}

/** Parse existing config text into a plain object, or throw a refusal.
 * Whitespace-only text holds nothing to preserve and parses as `{}`. */
export function parseNativeJsonConfig(text: string, displayPath: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NativeConfigRefusal(displayPath, looksLikeJsonc(text) ? "comments" : "invalid-json");
  }
  if (!isPlainObject(parsed)) throw new NativeConfigRefusal(displayPath, "not-object");
  return parsed;
}

/** Read and parse a native JSON config. Returns null only when the file does
 * not exist (or is whitespace-only); any other read or parse failure throws a
 * NativeConfigRefusal and the file is left untouched. */
export function readNativeJsonConfig(
  path: string,
  home: string,
): { text: string; value: Record<string, unknown> } | null {
  const displayPath = displayConfigPath(path, home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new NativeConfigRefusal(displayPath, "unreadable", code);
  }
  if (!text.trim()) return null;
  return { text, value: parseNativeJsonConfig(text, displayPath) };
}
