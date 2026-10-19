// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which connected-app calls are VERIFIED to only read. The reviewed list itself lives in
// shared/connected-app-read-tools.ts (authority is that list and nothing else; unknown means protected); this adds the
// classifier for a whole dispatched call.
import { dispatchedCall } from "./connected-app-calls.ts";
import { isVerifiedReadTool } from "./connected-app-read-tools.ts";

export { VERIFIED_READ_TOOLS, isVerifiedReadTool, suggestsRead, type ReadTool } from "./connected-app-read-tools.ts";

/**
 * "read": every action the call runs is verified read-only. "protected":
 * anything else, including a batch with one write or unknown tool, a call
 * routed to the workbench, and shapes this does not recognise.
 */
export function classifyConnectedAppCall(name: string, args: unknown): "read" | "protected" {
  // Classify what is dispatched: the outer tool decides, only a validated
  // wrapper is unwrapped, and a conflicting or unrecognised shape is protected.
  const call = dispatchedCall(name, args);
  if (call.target !== "COMPOSIO_MULTI_EXECUTE_TOOL" || !call.wellFormed || !call.body) return "protected";
  if (call.body.sync_response_to_workbench !== undefined && call.body.sync_response_to_workbench !== false) return "protected";
  for (const row of call.rows) {
    const slug = row.tool_slug ?? row.toolSlug ?? row.slug;
    if (typeof slug !== "string" || !isVerifiedReadTool(slug)) return "protected";
  }
  return call.rows.length > 0 ? "read" : "protected";
}
