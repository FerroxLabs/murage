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
//
// 1.0.13 (UX-TRUST-MOMENTS-1012 1.2, 2.3.1 to 2.3.5): the card is classified
// once here (`cardClass`), and the keys it carries are exactly the keys of the
// rows shared/fold-scopes.ts offers for that class: no stop:pay "always", no
// bot-level key on a routine's card, none on a guard, unread, always-ask or
// unattended card, no `local-computer:` program key.
import { approvalKey, type AutoVerdict } from "./auto-approve.ts";
import type { GrantCall } from "../shared/app-action-grant.ts";
import type { ApprovalGrantRequest } from "../shared/approval-grant-request.ts";
import { foldScopes, type CardClass, type CardKeyField, type CardKeys } from "../shared/fold-scopes.ts";
import { durableGrantAllowed } from "../shared/durable-grant-allowed.ts";
import { stopFindings, stopLineKey, type StopHit } from "./stop-line.ts";

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
  /** the turn was marked unattended (webhook, channel, unproven origin) */
  unattended?: boolean;
  /** a routine's or an automation's turn */
  automated?: boolean;
}

export interface CardGrants {
  allowKey?: string;
  taskAllowKey?: string;
  exactAllowKey?: string;
  routineAllowKey?: string;
  routineId?: string;
  grantRequest?: ApprovalGrantRequest;
  allowKeys?: string[];
  /** 1.2: written once when the request opens; absent on a question */
  cardClass?: CardClass;
}

/** 2.3.1: the card's class, from the facts the server has when it opens. */
export function cardClassFor(input: CardGrantInput, keys: CardKeys): CardClass {
  const stop = input.stopHit;
  const fields = (Object.keys(keys) as (keyof CardKeys)[])
    .filter((field): field is CardKeyField => field !== "routineId" && keys[field] !== undefined);
  const routineId = keys.routineId ?? keys.routineOffer?.routineId;
  return {
    reason: input.questionAsk ? "question" : input.verdict?.source ?? "no-grant",
    ...(stop ? { stop: { kind: stop.kind, public: stop.kind === "message" && !!stop.place?.startsWith("public:"), placed: stopLineKey(stop) !== undefined, places: stopFindings(stop).length } } : {}),
    ...(routineId ? { routine: { routineId } } : {}),
    unattended: input.unattended === true,
    automated: input.automated === true,
    ...(input.approvalScope ? { scope: input.approvalScope } : {}),
    keys: fields,
  };
}

/** The keys as today's rules would put them on the card, before the fold. */
function rawKeys(input: CardGrantInput): CardKeys & { grantRequest?: ApprovalGrantRequest } {
  const { permission, questionAsk, inputCut, approvalScope, stopHit } = input;
  const scopedKey = stopHit ? stopLineKey(stopHit) : undefined;
  const allowKey =
    permission && !approvalScope && !questionAsk && !inputCut
      ? stopHit ? scopedKey : approvalKey(input.tool ?? "", input.summary, approvalScope, input.call)
      : undefined;
  const routine = permission && !inputCut ? input.routineAllowCard : {};
  const grant = permission && input.grantCard ? input.grantCard : {};
  return {
    ...(allowKey ? { allowKey } : {}),
    ...(permission && !approvalScope && stopHit && scopedKey ? { taskAllowKey: scopedKey } : {}),
    ...(input.exactAllowKey ? { exactAllowKey: input.exactAllowKey } : {}),
    // a payment is never remembered for good, for a routine either (2.3.4)
    ...(routine.routineAllowKey && durableGrantAllowed(routine.routineAllowKey) ? { routineAllowKey: routine.routineAllowKey } : {}),
    ...(routine.routineId ? { routineId: routine.routineId } : {}),
    ...(grant.allowKeys ? { allowKeys: grant.allowKeys } : {}),
    ...(grant.grantRequest?.routine ? { routineOffer: grant.grantRequest.routine } : {}),
    ...(grant.grantRequest ? { grantRequest: grant.grantRequest } : {}),
  };
}

export function approvalCardGrants(input: CardGrantInput): CardGrants {
  if (input.verdict?.source === "always-ask") {
    return input.permission ? { allowKey: undefined, cardClass: cardClassFor(input, {}) } : { allowKey: undefined };
  }
  const { grantRequest, ...keys } = rawKeys(input);
  if (!input.permission) return {};
  // the fold decides: a key no row offers is not put on the card
  const rows = foldScopes(cardClassFor(input, keys), keys);
  // each field by the scope that saves it: a bot row's key, the task row's key
  const bot = new Set(rows.filter((row) => row.scope === "bot").flatMap((row) => row.keys));
  const task = new Set(rows.filter((row) => row.scope === "task").flatMap((row) => row.keys));
  const routineRow = rows.some((row) => row.scope === "routine");
  const kept: CardKeys = {
    ...(keys.allowKey && bot.has(keys.allowKey) ? { allowKey: keys.allowKey } : {}),
    ...(keys.taskAllowKey && task.has(keys.taskAllowKey) ? { taskAllowKey: keys.taskAllowKey } : {}),
    ...(keys.exactAllowKey && bot.has(keys.exactAllowKey) ? { exactAllowKey: keys.exactAllowKey } : {}),
    ...(keys.allowKeys && keys.allowKeys.every((key) => bot.has(key)) ? { allowKeys: keys.allowKeys } : {}),
    // the routine fields stay whenever the card is a routine's (the route rereads the offer and refuses what it does not carry)
    ...(keys.routineAllowKey && routineRow ? { routineAllowKey: keys.routineAllowKey } : {}),
    ...(keys.routineId ? { routineId: keys.routineId } : {}),
  };
  // an eligible routine offer stays only when the fold shows its row: a guard
  // or unattended card of a routine's run carries no offer a direct request
  // could save (the routine route reads the same fold again). An ineligible
  // one stays to say what is not remembered; it saves nothing either way.
  const offer = keys.routineOffer && (routineRow || !keys.routineOffer.eligible) ? keys.routineOffer : undefined;
  const cardClass = cardClassFor(input, { ...kept, ...(offer ? { routineOffer: offer } : {}) });
  const { routineOffer: _offer, ...cardKeys } = kept;
  const request = grantRequest && !offer && grantRequest.routine ? withoutRoutineOffer(grantRequest) : grantRequest;
  return { ...cardKeys, ...(request ? { grantRequest: request } : {}), cardClass };
}

function withoutRoutineOffer(request: ApprovalGrantRequest): ApprovalGrantRequest | undefined {
  const { routine: _routine, ...rest } = request;
  return rest.rows.length ? rest : undefined;
}
