// SPDX-License-Identifier: AGPL-3.0-or-later
import { isDeepStrictEqual } from "node:util";

/** An omitted input means Claude runs the original call. Only changes cross MCP. */
export function permissionAllowReply(input: Record<string, unknown>, updatedInput?: Record<string, unknown>) {
  return { behavior: "allow" as const,
    ...(updatedInput && !isDeepStrictEqual(input, updatedInput) ? { updatedInput } : {}) };
}

/** UTF-8 bytes bound the tokenizer's token count, including MCP content framing.
 * This deliberately favors a visible hold over letting Claude persist control data. */
export function permissionReplyFits(input: Record<string, unknown>, updatedInput: Record<string, unknown> | undefined, limit: number): boolean {
  const result = { content: [{ type: "text", text: JSON.stringify(permissionAllowReply(input, updatedInput)) }] };
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= limit;
}
export const PERMISSION_REPLY_TOO_LARGE = "Claude's managed output limit is too small for this changed input; raise the limit and retry.";
