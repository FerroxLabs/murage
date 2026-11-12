import { registerBusyloopPayloadSite } from "../../shared/flux-route.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// D20, adapted from OpenMausBot cc411b61b. A tool call Codex cannot route never reaches an MCP server and never becomes
// an app-server item: Codex answers the model with "unsupported call: <tool>" and the turn carries on without it. That
// happens when a provider sends an MCP tool's function_call back without the `namespace` Codex sent it under (seen with
// non-OpenAI models behind an OpenAI-compatible gateway). The only trace is the thread's rollout file, so the turn reads
// what it appended there and says which tools were refused.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";

import { redactSecretsInText } from "../redact.ts";

/** Where the thread's rollout file ended when the turn started, and which file that was. */
export interface RolloutMark {
  path: string;
  offset: number;
  /** The file's identity at the mark: a different file at the path later is read from its top, never from this offset. */
  dev?: number;
  ino?: number;
}

/** A turn reads at most this much of what it appended, from its start. */
export const ROLLOUT_SCAN_MAX_BYTES = 16 * 1024 * 1024;
const UNSUPPORTED = /^unsupported call: ([\w.:-]{1,200})/;
const MARKER = Buffer.from("unsupported call: ", "utf8");
const NEWLINE = 0x0a;
const MAX_NAMED = 6;


/** Whether `path`'s real folder is inside one of `roots` (Codex state folders this driver configured). */
function insideRoots(path: string, roots: readonly (string | undefined)[]): boolean {
  let folder: string;
  try { folder = realpathSync(dirname(path)); } catch { return false; }
  return roots.some((root) => {
    if (!root) return false;
    try {
      const rel = relative(realpathSync(root), folder);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    } catch {
      return false;
    }
  });
}

/** The rollout file's current end, or null when Codex named no usable file: only an absolute .jsonl path inside one of
 *  `roots` (the Codex home this turn's app-server runs with) that is a regular file itself (never a link, a FIFO or a
 *  device) is read. */
export function rolloutMark(path: unknown, roots: readonly (string | undefined)[]): RolloutMark | null {
  if (typeof path !== "string" || !path || !isAbsolute(path) || !path.endsWith(".jsonl") || !insideRoots(path, roots)) return null;
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? { path, offset: stat.size, dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}

// Not through a link, and never waiting on a FIFO someone put at the path since the mark (O_NONBLOCK): the read runs on
// the server's event loop, so it must not block. Windows has neither flag; the regular-file check below still holds.
const OPEN_FLAGS = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);

const outputText = (output: unknown): string =>
  typeof output === "string" ? output
    : Array.isArray(output) ? output.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
      : output && typeof output === "object" && typeof (output as { content?: unknown }).content === "string" ? (output as { content: string }).content
        : "";

function refusedTool(line: string): string | undefined {
  let record: { type?: unknown; payload?: { type?: unknown; output?: unknown } };
  try {
    record = registerBusyloopPayloadSite("read", JSON.parse(line));
  } catch {
    return undefined;
  }
  if (record?.type !== "response_item" || record.payload?.type !== "function_call_output") return undefined;
  return UNSUPPORTED.exec(outputText(record.payload.output))?.[1];
}

/** The tools Codex refused in these rollout lines, each once, in the order it refused them. Only lines that carry the
 *  refusal are decoded, so a long turn costs a byte search. */
export function unsupportedCallsIn(text: string | Buffer): string[] {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  const tools = new Set<string>();
  for (let at = bytes.indexOf(MARKER); at !== -1;) {
    const start = bytes.lastIndexOf(NEWLINE, at) + 1;
    const newline = bytes.indexOf(NEWLINE, at);
    const end = newline === -1 ? bytes.length : newline;
    const tool = refusedTool(bytes.subarray(start, end).toString("utf8"));
    if (tool) tools.add(tool);
    if (newline === -1) break;
    at = bytes.indexOf(MARKER, end);
  }
  return [...tools];
}

/** The tools Codex refused since `mark`; none when the file cannot be read. */
export function unsupportedCallsSince(mark: RolloutMark | null, maxBytes = ROLLOUT_SCAN_MAX_BYTES): string[] {
  if (!mark) return [];
  let fd: number | undefined;
  try {
    fd = openSync(mark.path, OPEN_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return [];
    const end = stat.size;
    // A different file at the path is not the one marked: nothing is read from it.
    if ((mark.ino !== undefined && stat.ino !== mark.ino) || (mark.dev !== undefined && stat.dev !== mark.dev)) return [];
    // The marked file shrank (rewritten in place): read it from the top.
    const from = end < mark.offset ? 0 : mark.offset;
    const length = Math.min(end - from, maxBytes, ROLLOUT_SCAN_MAX_BYTES);
    if (length <= 0) return [];
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, from);
    return unsupportedCallsIn(bytes.subarray(0, read));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** The chat line for the refused tools (customer-facing words: MurageMain signs off on them). */
export function unsupportedCallsNotice(engine: string, tools: readonly string[]): string {
  const named = tools.slice(0, MAX_NAMED).join(", ") + (tools.length > MAX_NAMED ? ` and ${tools.length - MAX_NAMED} more` : "");
  return `${engine} could not run ${tools.length === 1 ? "the tool" : "the tools"} ${named}: the AI provider sent the call back ` +
    "without the tool's app name, so it never reached the tool. Pick a model for this bot whose provider handles tool calls fully.";
}

/** Logs and tells the thread about every call Codex refused since `mark`, so a dropped namespace is never silent. */
export function reportUnsupportedCalls(engine: string, mark: RolloutMark | null, notice: (message: string) => void): void {
  const tools = unsupportedCallsSince(mark).map((tool) => redactSecretsInText(tool));
  if (!tools.length) return;
  console.warn(`[codex] unsupported tool call (provider dropped the MCP namespace): ${tools.slice(0, MAX_NAMED).join(", ")}${tools.length > MAX_NAMED ? ` and ${tools.length - MAX_NAMED} more` : ""}`);
  notice(unsupportedCallsNotice(engine, tools));
}
