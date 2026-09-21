// An OVERFLOW LIMITER for the built-in agents tools, and nothing more.
//
// What it is NOT: a redaction boundary. A result of 24,000 characters or fewer
// is returned to the engine byte-for-byte, unredacted and unexamined — the same
// text the harness produced. Do not describe this file, in code or in a commit
// message, as a place where tool output gets scrubbed. Redaction happens here
// only to the tail that is about to be PARKED on the harness for later paging,
// because that copy outlives the turn and can be read back by a second tool
// call; it is a property of the cache, not of tool results.
//
// The defect it fixes is narrow and real: the proxy handed the engine whatever
// a tool returned, at any length, so one oversized reply could blow past the
// engine's context window and cost the turn its history — and the model's only
// recovery was to run the action again.
import { redactSecretsInText } from "../redact.ts";
import { TOOL_RESULT_MAX_CHARS, TOOL_RESULT_PREVIEW_CHARS, toolResultPrefix } from "../tool-results.ts";

/** Anything at or under this is passed through untouched. */
export const AGENT_RESULT_CAP_CHARS = 24_000;

/** The operation already happened. Saving overflow must never retry it or turn
 * a successful operation into a failed MCP call, so every failure below falls
 * back to the preview and says the tail was lost. Only the cache I/O is timed. */
export async function boundedAgentResult(text: string, save: (text: string, truncated: boolean) => Promise<unknown>): Promise<string> {
  if (text.length <= AGENT_RESULT_CAP_CHARS) return text;
  const redacted = redactSecretsInText(text);
  const prefix = toolResultPrefix(redacted, TOOL_RESULT_PREVIEW_CHARS);
  const retained = toolResultPrefix(redacted, TOOL_RESULT_MAX_CHARS);
  const truncated = retained.length < redacted.length;
  try {
    const saved = await save(retained, truncated) as { id?: unknown; truncated?: unknown } | null;
    if (!saved || typeof saved.id !== "string" || !/^r-[0-9a-f-]{36}$/.test(saved.id)) throw new Error("Invalid saved result");
    return `${prefix}\n\n[Large tool result: showing the first ${prefix.length} characters. ${truncated || saved.truncated
      ? "Only a bounded portion was retained; the remaining tail was omitted."
      : "The rest of the result is temporarily saved."} If a missing detail is needed, call tool_result_read with id "${saved.id}" and offset ${prefix.length}. Saved results expire after one hour, on app restart, or under cache pressure. Do not repeat an action just to retrieve its output.]`;
  } catch {
    return `${prefix}\n\n[Large tool result: showing the first ${prefix.length} characters. The remaining output could not be saved and is not retrievable. The original operation was not retried. Do not repeat an action just to retrieve its output.]`;
  }
}
