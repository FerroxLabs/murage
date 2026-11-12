// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine permission only releases the call to the HighLevel host. The host alone
// authorizes the operation, reviews its exact values and dispatches it.
import type { RuntimeEvent } from "../contracts.ts";
import { HIGHLEVEL_FAMILY_TOOLS, HIGHLEVEL_HELPER_NAMES } from "../../shared/highlevel.ts";
import { resolveCall, type GrantCall } from "../../shared/app-action-grant.ts";
import { driverMountsPhoneJobs } from "../phone-jobs-engines.ts";
import { ApprovalNoLongerOpenError } from "../drivers/acp/approval-delivery.ts";
import type { HighLevelCallClass, HighLevelCallLedger, TrustedCallIdentity } from "./call-ledger.ts";
import type { HighLevelThreadMarkState } from "./thread-marks.ts";

/** HL-WRITES-1019-r2: every engine derives the same nineteen exact names. */
export const highlevelHandlerTools: readonly string[] = Object.freeze([
  ...Object.values(HIGHLEVEL_FAMILY_TOOLS), ...HIGHLEVEL_HELPER_NAMES,
]);
export const highlevelEngineSupported = driverMountsPhoneJobs;
export const HIGHLEVEL_UNPROVEN_DENIAL = "Murage could not confirm this HighLevel call. Use the bot's own HighLevel tools.";
export type HighlevelEngineAsk = { kind: "own"; tool: string } | { kind: "deny" };

/** A title, protocol kind or bare name never proves authority. On a marked
 * thread only the call ledger can relax withholding for a different tool. */
export function highlevelEngineAsk(call: GrantCall | undefined, mark: HighLevelThreadMarkState, classification?: HighLevelCallClass): HighlevelEngineAsk | undefined {
  if (mark === "unreadable") return { kind: "deny" };
  const resolved = resolveCall(call);
  if (resolved.kind === "mcp" && resolved.provenance === "own" && resolved.mountId === "own:highlevel") {
    return highlevelHandlerTools.includes(resolved.tool) ? { kind: "own", tool: resolved.tool } : { kind: "deny" };
  }
  if (mark === "marked" && classification !== "other") return { kind: "deny" };
  return undefined;
}

// Boot installs the same private ledger the original request handler records.
let engineLedger: Pick<HighLevelCallLedger, "classOf"> | undefined;
export function installHighlevelEngineLedger(ledger: typeof engineLedger): void { engineLedger = ledger; }

/** Resolve only driver-supplied identity, never an outward title or summary. */
export function trustedHighlevelCallIdentity(event: RuntimeEvent): TrustedCallIdentity | undefined {
  if (event.type !== 'request.opened') return;
  const resolved = resolveCall({ toolCall: event.toolCall, toolIdentity: event.toolIdentity,
    toolKind: event.toolKind, mcpMounts: event.mcpMounts, engine: event.toolEngine });
  if (resolved.kind === 'mcp') return { source: 'resolve_call', server: resolved.mountId, tool: resolved.tool };
  if (resolved.kind === 'engine') return { source: 'resolve_call', server: 'engine', tool: resolved.name };
  // Native Claude/Codex/Pi tools have exact names in the private driver request,
  // unlike ACP titles. Their MCP calls were resolved above against the mounts.
  const name = event.toolCall?.name;
  if (resolved.kind === 'unstamped' && name &&
    ((event.toolEngine === 'claude' && ['Bash','Read','Write','Edit','MultiEdit','Glob','Grep','NotebookEdit','WebFetch','WebSearch'].includes(name)) ||
     (event.toolEngine === 'codex' && ['Bash','shell','exec_command','apply_patch','read_file','write_file'].includes(name)) ||
     (event.toolEngine === 'pi' && ['bash','powershell','edit','write','read','grep','find','ls'].includes(name)))) {
    return { source: event.toolEngine === 'claude' ? 'claude_name' : event.toolEngine === 'codex' ? 'codex_server' : 'resolve_call', server: `engine:${event.toolEngine}`, tool: name };
  }
}

/** Consume the ORIGINAL private request, never its outward projection. C4's
 * projectHighLevelEvent returns null for a HighLevel ask, without replacing
 * this original event. No input cache or serialized identity field is added. */
export function highlevelEngineRequest(event: RuntimeEvent, mark: HighLevelThreadMarkState): HighlevelEngineAsk | undefined {
  if (event.type !== "request.opened") return undefined;
  let classification: HighLevelCallClass | undefined;
  try { classification = engineLedger?.classOf(event.threadId, event.turnId ?? "", event.itemId ?? event.requestId ?? ""); }
  catch { classification = "highlevel"; }
  return highlevelEngineAsk({ toolCall: event.toolCall, toolIdentity: event.toolIdentity, toolKind: event.toolKind,
    mcpMounts: event.mcpMounts, engine: event.toolEngine }, mark === "unmarked" && classification === "highlevel" ? "marked" : mark, classification);
}

/** r2 withdraws the engine fallback row. A proved own call reaches its handler;
 * if a retryable delivery failed, deny it instead. Never resend an ambiguous
 * Allow, publish an ask, or copy any engine/provider text into a row. */
export async function deliverHighlevelEngineAsk(ask: HighlevelEngineAsk, deps: {
  respond(answer: { behavior: "allow" | "deny"; message?: string }): Promise<unknown>;
  canFallback(error: unknown): boolean;
}): Promise<void> {
  try {
    await deps.respond(ask.kind === "own" ? { behavior: "allow" } : { behavior: "deny", message: HIGHLEVEL_UNPROVEN_DENIAL });
  } catch (error) {
    if (ask.kind !== "own" || error instanceof ApprovalNoLongerOpenError || !deps.canFallback(error)) return;
    try { await deps.respond({ behavior: "deny", message: HIGHLEVEL_UNPROVEN_DENIAL }); }
    catch { /* no permission was granted; no public fallback row */ }
  }
}
