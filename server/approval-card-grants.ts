// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The standing grants an approval card offers: "Always allow" (allowKey),
// "Always allow this exact command here" (exactAllowKey), "Allow for this
// task" (taskAllowKey) and "Always allow for this routine" (routineAllowKey).
// Decided here, once, so the server and the card can never derive them
// differently. A command that always asks (server/always-ask.ts) offers none
// of them: no grant could answer it next time, so offering one would only
// promise something Murage will not do.
import { approvalKey, type AutoVerdict } from "./auto-approve.ts";
import type { GrantCall } from "../shared/app-action-grant.ts";
import type { ApprovalGrantRequest } from "../shared/approval-grant-request.ts";
import { stopLineKey, type StopHit } from "./stop-line.ts";

export interface CardGrantInput {
  /** a permission ask, not a question */
  permission: boolean;
  questionAsk: boolean;
  /** the tool input was cut short on the card */
  inputCut: boolean;
  approvalScope?: "local-computer";
  stopHit?: StopHit | null;
  tool?: string;
  summary: string;
  exactAllowKey?: string;
  routineAllowCard: { routineAllowKey?: string; routineId?: string };
  verdict?: Pick<AutoVerdict, "source"> | null;
  /** the engine's call, so "Always allow" is never read off a cut call */
  call?: GrantCall;
  /** the per-action grant data (Rules 78, 81, 82) the card carries */
  grantCard?: { grantRequest?: ApprovalGrantRequest; allowKeys?: string[] };
}

export interface CardGrants {
  allowKey?: string;
  taskAllowKey?: string;
  exactAllowKey?: string;
  routineAllowKey?: string;
  routineId?: string;
  grantRequest?: ApprovalGrantRequest;
  allowKeys?: string[];
}

export function approvalCardGrants(input: CardGrantInput): CardGrants {
  if (input.verdict?.source === "always-ask") return { allowKey: undefined };
  const { permission, questionAsk, inputCut, approvalScope, stopHit } = input;
  const scopedKey = stopHit ? stopLineKey(stopHit) : undefined;
  return {
    // A stop-line card's grants are scoped to the place it touches (the
    // folder, the payee, the recipient), never the bare tool name.
    allowKey:
      permission && !approvalScope && !questionAsk && !inputCut
        ? stopHit ? scopedKey : approvalKey(input.tool ?? "", input.summary, approvalScope, input.call)
        : undefined,
    ...(permission && !approvalScope && stopHit && scopedKey ? { taskAllowKey: scopedKey } : {}),
    ...(input.exactAllowKey ? { exactAllowKey: input.exactAllowKey } : {}),
    ...(permission && !inputCut ? input.routineAllowCard : {}),
    ...(permission && input.grantCard ? input.grantCard : {}),
  };
}
