// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Builds the data a pending permission card carries (shared/approval-grant
// -request.ts) and decides what a remembered choice saves from it
// (APP-GRANT-AMEND-13.AGREED-r2.md Rules 78, 80b, 81, 82). One place, so the
// card and the grant routes can never disagree about the set.

import { actionGrantSet, resolveCall, type GrantCall } from "../shared/app-action-grant.ts";
import { APP_LOOKUPS, appAction, ownAppTool } from "../shared/app-action-words.ts";
import type { ApprovalActionRow, ApprovalGrantRequest, ApprovalRowFinding, RoutineGrantOffer, RoutineStopOffer } from "../shared/approval-grant-request.ts";
import { isRoutineGrantKey } from "./routine-permissions.ts";
import { rowDestinations, stopFindings, stopLineKey, type StopHit } from "./stop-line.ts";
import { redactSecretsForCard } from "./redact.ts";

const finding = (hit: StopHit): ApprovalRowFinding => {
  const key = stopLineKey(hit);
  return { kind: hit.kind, what: hit.what, ...(key ? { key } : {}) };
};

/** Plain reasons the routine choice is not offered (Rule 82a). */
export const ROUTINE_GRANT_REASONS = {
  host: "This controls your computer, so Murage asks every time.",
  cut: "Murage could not read this request whole, so it can only be allowed once.",
  unread: "Murage could not name every action in this request, so it can only be allowed once.",
  nothing: "Nothing in this request can be remembered for this routine, so it can only be allowed once.",
} as const;

/** The routine offer's line for a pay finding: it asks on every run. */
export const ROUTINE_PAY_NOT_REMEMBERED = "Paying asks on every run.";

export interface GrantRequestInput {
  ask: GrantCall & { tool: string; summary: string };
  /** the call-level stop finding (server/stop-line.ts classifyAsk) */
  stopHit: StopHit | null;
  /** the per-row findings of a connector batch (classifyAskRows) */
  stopRows?: StopHit[][];
  /** "Always allow this exact command here", when the card offers it */
  exactAllowKey?: string;
  inputCut: boolean;
  scope?: "local-computer";
  /** the routine whose attended run raised the card, as the server proved it */
  routine?: { routineId: string; routineName: string } | null;
}

/** The operations of this request in call order (Rule 82), or none for a
 * call that is not a connected-app call. */
function actionRows(input: GrantRequestInput): ApprovalActionRow[] {
  const set = input.inputCut ? null : actionGrantSet(input.ask.tool, input.ask);
  if (!set) return [];
  if (set.rows.length) {
    return set.rows.map((row, index) => {
      const named = appAction(row.slug);
      return {
        index, kind: "action", operation: row.slug, app: named?.app ?? row.slug, action: named?.action ?? row.slug,
        ...(row.account ? { account: row.account } : {}),
        destinations: rowDestinations(row.arguments),
        findings: (input.stopRows?.[index] ?? []).map(finding),
        // shown under "Show the details it sends" and kept with the card:
        // scrubbed as the card's title and summary are (1.0.4, 09-3)
        arguments: redactedArguments(row.arguments ?? {}),
      };
    });
  }
  const lookup = ownAppTool(set.keys[0] ?? "");
  if (lookup === undefined || APP_LOOKUPS[lookup] === undefined) return [];
  const resolved = resolveCall(input.ask);
  return [{
    index: 0, kind: "lookup", operation: lookup, app: "Connected apps", action: APP_LOOKUPS[lookup]!, destinations: [], findings: [],
    arguments: redactedArguments(resolved.kind === "mcp" ? resolved.input ?? {} : input.ask.toolCall?.input ?? {}),
  }];
}

function redactedArguments(args: unknown): Record<string, unknown> {
  const out = redactSecretsForCard(args);
  return out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {};
}

/** "Always allow for this routine" as offered on this card (Rules 76, 80, 81c). */
function routineOffer(input: GrantRequestInput, routine: { routineId: string; routineName: string }): RoutineGrantOffer {
  const base = { routineId: routine.routineId, routineName: routine.routineName };
  const closed = (reason: string): RoutineGrantOffer => ({ ...base, eligible: false, reason, actionKeys: [], stopKeys: [], notRemembered: [] });
  if (input.scope === "local-computer") return closed(ROUTINE_GRANT_REASONS.host);
  if (input.inputCut) return closed(ROUTINE_GRANT_REASONS.cut);
  const set = actionGrantSet(input.ask.tool, input.ask);
  if (set === null) return closed(ROUTINE_GRANT_REASONS.unread);
  const notRemembered: string[] = [];
  let actionKeys: string[] = [];
  if (set) {
    // a custom or external tool is never a routine grant (Rule 76)
    if (set.keys.every(isRoutineGrantKey)) actionKeys = [...set.keys];
    else notRemembered.push("This tool can only be allowed once for a routine.");
  } else if (input.exactAllowKey && !input.stopHit && isRoutineGrantKey(input.exactAllowKey)) {
    actionKeys = [input.exactAllowKey];
  }
  const hits = input.stopRows && input.stopRows.length > 1 && input.stopRows.some((row) => row.length) ? input.stopRows.flat() : input.stopHit ? stopFindings(input.stopHit) : [];
  const stopKeys: RoutineStopOffer[] = [];
  for (const hit of hits) {
    const key = stopLineKey(hit);
    // a payment is never remembered, for a routine either (UX-TRUST-MOMENTS-1012 2.3.4)
    if (hit.kind === "pay") { if (!notRemembered.includes(ROUTINE_PAY_NOT_REMEMBERED)) notRemembered.push(ROUTINE_PAY_NOT_REMEMBERED); continue; }
    if (!key || !isRoutineGrantKey(key)) { notRemembered.push(hit.what); continue; }
    if (stopKeys.some((offer) => offer.key === key)) continue;
    const recipient = hit.kind === "message" && hit.place && !hit.place.startsWith("public:") && !hit.place.includes(",") ? hit.place : undefined;
    stopKeys.push({ key, what: hit.what, ...(recipient ? { recipient } : {}) });
  }
  if (!actionKeys.length && !stopKeys.length) return { ...closed(ROUTINE_GRANT_REASONS.nothing), notRemembered };
  return { ...base, eligible: true, actionKeys, stopKeys, notRemembered };
}

/** The card's data, or undefined when there is nothing to add (an ordinary
 * tool on a card no routine raised). */
export function grantRequestFor(input: GrantRequestInput): ApprovalGrantRequest | undefined {
  const rows = actionRows(input);
  const routine = input.routine ? routineOffer(input, input.routine) : undefined;
  if (!rows.length && !routine) return undefined;
  return { rows, ...(routine ? { routine } : {}) };
}

/**
 * Rule 81: what a "remember for this routine" decision saves, from the
 * card's own offer and nothing a client adds. `chosen` are stop keys the
 * owner also picked; each must be one the card offered. With no action
 * keys (a pure stop card) the choice is its stop keys, as before.
 * A string says why the decision is refused.
 */
export function routineDecisionKeys(offer: RoutineGrantOffer | undefined, legacyKey: string | undefined, chosen: readonly string[] | undefined): string[] | string {
  if (!offer) return legacyKey && isRoutineGrantKey(legacyKey) ? [legacyKey] : "This approval can only be allowed once.";
  if (!offer.eligible) return offer.reason ?? ROUTINE_GRANT_REASONS.nothing;
  const offered = new Set(offer.stopKeys.map((stop) => stop.key));
  if (chosen?.some((key) => !offered.has(key))) return "That choice is not on this approval.";
  const stops = offer.actionKeys.length ? [...(chosen ?? [])] : chosen?.length ? [...chosen] : [...offered];
  const keys = [...new Set([...offer.actionKeys, ...stops])];
  return keys.length ? keys : ROUTINE_GRANT_REASONS.nothing;
}

/**
 * AMEND-13 Rules 76, 81 (Astra a13 r1 item 1): the routine identity a card
 * carries. Every card the executing bot's run raised that offers the routine
 * anything (a stop place or exact command key, or an app action, lookup or
 * several-row offer from grantRequestFor) names that routine, as the server
 * derived it, so the owner can choose it and the save route can reread it.
 * Nothing when no run of a routine raised the card or it offers nothing.
 */
export function routineCardFields(
  offered: { routineId: string } | null,
  routineAllowKey: string | undefined,
  request: ApprovalGrantRequest | undefined,
): { routineId?: string; routineAllowKey?: string } {
  if (!offered || !(routineAllowKey || request?.routine)) return {};
  return { ...(routineAllowKey ? { routineAllowKey } : {}), routineId: offered.routineId };
}
