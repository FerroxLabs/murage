// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot #3181 (server/mcp-error-result.ts), Apache-2.0 (see NOTICE).
//
// The Anthropic API refuses a tool_result marked is_error whose content is not
// all text, failing the whole turn, and other engines pass MCP content through
// as is. A computer driver can attach a screenshot to a failure, so every error
// result that leaves the MCP bridge keeps its text (and structured content) and
// loses the rest, with a note saying so. Successes, text-only errors and every
// other frame pass through byte for byte.
type JsonObject = Record<string, unknown>;

const ERROR_FLAG = /"isError"\s*:\s*true/u;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const READ_AGAIN = "an error result can carry only text. Read the screen again before any pixel action.";

export function omittedFromErrorNote(count: number): string {
  return count === 1
    ? `[The screenshot or other attachment on this error was removed: ${READ_AGAIN}]`
    : `[The ${count} screenshots or other attachments on this error were removed: ${READ_AGAIN}]`;
}

/** Returns the same object unless it is an error result carrying non-text content. */
export function textOnlyErrorResult<T>(result: T): T {
  if (!isObject(result) || result.isError !== true || !Array.isArray(result.content)) return result;
  const text = result.content.filter((item): item is JsonObject & { text: string } => isObject(item) && item.type === "text" && typeof item.text === "string");
  const omitted = result.content.length - text.length;
  if (omitted === 0) return result;
  return { ...result, content: [...text, { type: "text", text: omittedFromErrorNote(omitted) }] } as T;
}

/** One MCP stdio frame. Only a response that says isError is parsed, so screenshots on success pass without a parse. */
export function textOnlyErrorResultLine(line: string): string {
  if (!ERROR_FLAG.test(line)) return line;
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isObject(frame) || !("result" in frame)) return line;
  const result = textOnlyErrorResult(frame.result);
  return result === frame.result ? line : JSON.stringify({ ...frame, result });
}
