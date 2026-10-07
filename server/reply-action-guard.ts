// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phantom-action guard. When a turn settles, compare what its closing
// reply says was done with what the turn's own record shows was done, and
// mark the reply. No model, no network: text against rows. It runs on every
// engine and route, tool-using ones included, because a capable engine that
// says "Sent." with no send behind it is the same defect as a tool-less one.
// Nothing is cut from the reply; the owner reads the words that were said.

import type { Message } from "./store.ts";
import {
  detectActionClaims,
  type ActionCheck,
  type ActionClass,
  type CheckedClaim,
} from "../shared/reply-action-claims.ts";

type OperationOutcome = "completed" | "failed" | "pending" | "opaque";
type Operation = { name: string; callId?: string; classes: ActionClass[]; outcome: OperationOutcome };

function structured(value: unknown): any {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return undefined; } }
  if (Array.isArray(value)) return structured(value.find(item => item?.type === "text")?.text);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.isError !== true && "structuredContent" in record) return structured(record.structuredContent);
    if (record.isError !== true && "content" in record) return structured(record.content);
  }
  return value;
}

/** Normalize identifiers and wrapper arguments, never a prose summary. */
export function toolAction(name: string, ok?: boolean, input?: unknown, result?: unknown): { name?: string; classes: ActionClass[]; outcome: OperationOutcome; operations?: Operation[] } {
  const identifier = name.split("__").at(-1)!.toLowerCase();
  const inputObject = structured(input);
  const inner = inputObject?.tool_name ?? inputObject?.toolName;
  if (typeof inner === "string" && (/^(?:tool|use_tool|call_tool|execute_tool)$/.test(identifier) || inner.toLowerCase() === identifier)) {
    input = inputObject.tool_input ?? inputObject.toolInput ?? inputObject.arguments ?? inputObject.args ?? inputObject.input;
    if (inner.toLowerCase() !== identifier) return toolAction(inner, ok, input, result);
  }
  const operation = identifier.replace(/^[a-z0-9]+_(?=send_email$|send_message$|create_calendar_event$)/, "");
  const classes: ActionClass[] = [];
  const operations: Partial<Record<ActionClass, RegExp>> = {
    send: /^(?:send(?:_| )|send$|email$|post_message$|publish$|ask_bot$)/,
    save: /^(?:write(?:_file)?|save(?:_file)?|edit|create_file|export_file|upload_file|apply_patch)$/,
    schedule: /^(?:create_routine|schedule(?:_event)?|create_reminder|create_calendar_event)$/,
    delegate: /^(?:ask_bot|delegate(?:_task)?|assign_task)$/,
    pay: /^(?:pay_invoice|transfer_funds|create_payment)$/,
    delete: /^(?:delete_file|remove_file|cancel_event)$/,
    run: /^(?:run_tests|deploy|install_package)$/,
    change: /^(?:update_settings|rename_file|edit|apply_patch)$/,
  };
  if (/(?:^|_)(?:multi_execute_tool|execute_tool)$/.test(identifier)) {
    const args = structured(input), output = structured(result);
    const calls = Array.isArray(args?.tools) ? args.tools : args?.tool_slug ? [args] : [];
    const results = output?.data?.results ?? output?.results;
    const callId = (entry: any): string | undefined => {
      const id = entry?.call_id ?? entry?.tool_call_id ?? entry?.toolCallId ?? entry?.id;
      return typeof id === "string" ? id : undefined;
    };
    const receipts = Array.isArray(results) ? results : [];
    const byId = new Map<string, any>();
    for (const receipt of receipts) {
      const id = callId(receipt);
      if (id) byId.set(id, byId.has(id) ? undefined : receipt);
    }
    const entries: Operation[] = calls.filter((call: any) => typeof call?.tool_slug === "string").map((call: any, index: number) => {
      const id = callId(call), positional = receipts[index];
      // Identity wins. Otherwise consume the receipt at this occurrence,
      // checking its slug without using that slug to find another receipt.
      const receipt = Array.isArray(results)
        ? id && byId.has(id) ? byId.get(id)
          : !callId(positional) ? positional : undefined
        : calls.length === 1 ? output : undefined;
      const matched = !receipt?.tool_slug || receipt.tool_slug === call.tool_slug ? receipt : undefined;
      const response = matched?.response ?? matched;
      const success = ok === false || output?.isError === true || output?.successful === false || response?.successful === false || response?.success === false || response?.error
        ? false : response?.successful === true || response?.success === true ? true : undefined;
      const action = toolAction(call.tool_slug, success);
      return { name: call.tool_slug, ...(id ? { callId: id } : {}), classes: action.classes, outcome: success === undefined && ok === true ? "opaque" : action.outcome };
    });
    return { name, classes: [...new Set(entries.filter(entry => entry.outcome === "completed").flatMap(entry => entry.classes))],
      outcome: ok === false ? "failed" : entries.some(entry => entry.outcome === "completed") ? "completed" : entries.length && entries.every(entry => entry.outcome === "failed") ? "failed" : ok === true ? "opaque" : "pending", operations: entries };
  }
  for (const [cls, pattern] of Object.entries(operations)) if (pattern.test(operation)) classes.push(cls as ActionClass);
  const output = structured(result);
  if (output?.successful === false || output?.success === false || output?.isError === true || output?.error) ok = false;
  if (/^(?:bash|shell|terminal|exec|run_command|command|execute)(?:_|$)/.test(operation)) {
    const exitCode = output?.exitCode ?? output?.exit_code;
    if (typeof exitCode === "number" && exitCode !== 0) ok = false;
    return { name, classes: ["save", "change", "run"], outcome: ok === false ? "failed" : ok === true ? "opaque" : "pending" };
  }
  return { name, classes, outcome: ok === false ? "failed" : ok !== true ? "pending" : classes.length ? "completed" : "pending" };
}

/** Only completed relevant outcomes establish an action. */
function rowActions(row: Message): ReturnType<typeof toolAction> {
  if (row.murage || row.actorKind === "murage" || row.role !== "bot" || row.copyOf || row.tool?.notice) return { classes: [], outcome: "pending" };
  if (row.comm && row.tool?.ok === true) return { classes: ["send", "delegate"], outcome: "completed" };
  if (row.artifactIds?.length || row.tool?.imageRecord) return { classes: ["save"], outcome: "completed" };
  if (row.kind === "activity" && row.tool) {
    const action = row.tool.action;
    return action && (action.name || action.outcome !== "pending" || row.tool.ok !== true) ? action : toolAction(row.tool.name, row.tool.ok, row.tool.summary);
  }
  return { classes: [], outcome: "pending" };
}

export function authoredTurnPieces(path: readonly Message[], reply: Pick<Message, "id" | "text" | "turnId" | "from">): readonly Pick<Message, "id" | "text" | "turnId" | "from">[] {
  if (!reply.turnId) return [reply];
  const pieces = path.filter(row => row.turnId === reply.turnId && row.role === "bot" && row.kind === "text"
    && row.actorKind !== "murage" && !row.murage && !row.copyOf && row.removedText === undefined && row.from?.botId === reply.from?.botId);
  return pieces.length ? pieces : [reply];
}

export interface ReplyActionInput {
  /** the closing reply row, already marked terminal */
  reply: Pick<Message, "id" | "text" | "turnId" | "from">;
  /** the active branch, root to leaf, including this turn's rows */
  path: readonly Message[];
  /** the driver has tools but reports no tool events (see DRIVERS_WITHOUT_TOOL_EVENTS) */
  unverifiable?: boolean;
}

export function checkReplyActions(input: ReplyActionInput): ActionCheck {
  const pieces = authoredTurnPieces(input.path, input.reply);
  const scans = pieces.map(piece => ({ piece, scan: detectActionClaims(piece.text ?? "") }));
  if (scans.every(({ scan }) => !scan.checked)) return { state: "unchecked", claims: [] };
  const current = new Set<ActionClass>(), earlier = new Map<ActionClass, string>();
  const opaqueClasses = new Set<ActionClass>();
  for (const row of input.path) {
    const evidence = rowActions(row);
    const sameTurn = input.reply.turnId !== undefined && row.turnId === input.reply.turnId;
    for (const operation of evidence.operations?.length ? evidence.operations : [evidence]) {
      if (sameTurn && operation.outcome === "opaque") {
        for (const cls of operation.classes) opaqueClasses.add(cls);
      }
      if (operation.outcome !== "completed") continue;
      for (const cls of operation.classes) {
        if (sameTurn) current.add(cls);
        else earlier.set(cls, row.id);
      }
    }
  }
  const claims: CheckedClaim[] = scans.flatMap(({ piece, scan }) => scan.claims.map(claim => {
    const located = { ...claim, pieceId: piece.id, text: (piece.text ?? "").slice(...claim.span) };
    if (current.has(claim.class)) return { ...located, state: "recorded" as const };
    if (input.unverifiable || opaqueClasses.has(claim.class)) return { ...located, state: "unverifiable" as const };
    const rowId = earlier.get(claim.class);
    if (rowId) return { ...located, state: "earlier" as const, rowId };
    return { ...located, state: "flagged" as const };
  }));
  if (!claims.length) return { state: "none", claims: [] };
  const has = (state: CheckedClaim["state"]) => claims.some((claim) => claim.state === state);
  const state = has("flagged") ? "flagged"
    : has("unverifiable") ? "unverifiable"
    : has("earlier") ? "earlier"
    : "recorded";
  return { state, claims };
}

/** True when the closing row of this turn is a flagged reply. */
export function isFlaggedReply(message: Pick<Message, "actionCheck"> | undefined): boolean {
  return message?.actionCheck?.state === "flagged";
}
