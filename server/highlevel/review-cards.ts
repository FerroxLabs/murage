// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A HighLevel change waiting for the owner becomes one of our approval cards (GAP-HIGHLEVEL-109 sections 5.2 and 7).
// The card shows the action details, the location and the fixed review copy (the values come live from the open review
// on the desktop), and its Allow approves that one review digest through actions.ts. Nothing else can approve it: Full access, No limits and auto-approval never see a
// `highlevel-` request, and the engine's own permission flow does not reach it.
//
// Allow counts only from the owner's desktop app (ownerAppSurface kind "desktop", server/owner-app.ts) AND only with the
// digest of the review the desktop just showed (HL-S2-WRITES (a)4): a chat button, a push action, a paired phone, a
// browser, Full access, No limits, auto-approve, a routine or a standing grant can decline (or nothing), never approve.
// A card whose review ended (Stop, expiry, a changed grant, a disconnect) closes as unavailable and approves nothing.
import type { OperationSpec } from "./operations/registry.ts";
import type { HighLevelOutcomeRecord } from "./host.ts";
import { operationSpec } from "./operations/registry.ts";
import type { Message, Store } from "../store.ts";
import { murageLine } from "../murage-line.ts";
import type { InternalCapability } from "../internal-capabilities.ts";
import type { OwnerAppRefusal } from "../owner-app.ts";
import { ActionRefused, type ActionReview, type HighLevelActions } from "./actions.ts";

export const HIGHLEVEL_REQUEST_PREFIX = "highlevel-";

const TOOL_TITLES: Record<string, string> = {
  HIGHLEVEL_CREATE_CONTACT: "Create a contact", HIGHLEVEL_UPDATE_CONTACT: "Update a contact", HIGHLEVEL_ADD_TAGS: "Add tags to a contact",
  HIGHLEVEL_REMOVE_TAGS: "Remove tags from a contact", HIGHLEVEL_ADD_NOTE: "Add a note to a contact", HIGHLEVEL_ADD_TASK: "Add a task to a contact",
  HIGHLEVEL_CREATE_OPPORTUNITY: "Create a deal", HIGHLEVEL_UPDATE_OPPORTUNITY: "Update a deal",
};

/** The card's held text: the action details and the fixed copy, never the values. The conversation row is durable plaintext
 * history, so the proposed CRM values are read live from the open review on the desktop instead (reviewValues, GET
 * /api/highlevel/reviews/:actionId) and end with it (GrokBuild HL-S2 r2 H5, GAP-HIGHLEVEL-109 section 7). */
export function reviewHeldText(review: ActionReview): string {
  const records = review.recordRefs.length ? `\nRecords: ${review.recordRefs.join(", ")}` : "";
  return `Location: ${review.locationId}${records}\n\n${review.copy}`;
}

/** What the desktop shows for an open review: every value in full, exactly what Allow approves, and the digest Allow
 * must carry back. */
export interface HighLevelReviewValues { actionId: string; tool: string; operation: ActionReview['operation']; completionKind?: 'private_generated_password_v1'; locationId: string; recordRefs: string[]; fields: string[]; values: unknown; reviewDigest: string; expiresAt: number }

/** Where an answer came from, as the respond route proved it: the owner's desktop app or not, and the digest it posted. */
export interface HighLevelApproval { desktop: boolean; reviewDigest?: string }

/** What a refused surface reads instead of the values (HL-S2-WRITES (c)). */
export const HIGHLEVEL_ON_COMPUTER = "Open Murage on your computer to see the exact values and approve.";

/** The card's title, from the tool. */
export function highlevelToolTitle(tool: string): string { return TOOL_TITLES[tool] ?? "Change a record"; }

const SAFE_ID = /^[A-Za-z0-9_.~%:-]{1,180}$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/;
function metadataLine(title: string, locationId: unknown, recordRefs: readonly string[], fields: readonly string[], risk?: string) {
  return { title, subtitle: `HighLevel${typeof locationId === "string" && SAFE_ID.test(locationId) ? `, location ${locationId}` : ""}. Records: ${recordRefs.filter(id => SAFE_ID.test(id)).join(", ") || "none"}. Fields: ${fields.filter(field => SAFE_FIELD.test(field)).join(", ") || "none"}.`,
    ...(risk === "D" ? { riskLine: "This can't be undone from Murage." } : {}) };
}
/** Frozen operation metadata, never the argument values. The host supplies the authorized location separately on its review. */
export function highlevelRedactedLine(spec: OperationSpec, args: unknown): { title: string; subtitle: string; riskLine?: string } {
  const parsed = spec.args.safeParse(args);
  if (!parsed.success) return metadataLine(spec.title, undefined, [], [], spec.risk);
  return metadataLine(spec.title, parsed.data.locationId, spec.recordRefs(parsed.data), spec.fields(parsed.data), spec.risk);
}
/** Only host-owned outcome words and numeric HTTP status can enter a receipt. */
export function highlevelOutcomeLine(outcome: HighLevelOutcomeRecord): string {
  const title = operationSpec(outcome.operation)?.title ?? "HighLevel change";
  const fields = outcome.fields.filter(field => SAFE_FIELD.test(field)).join(", ") || "none";
  const records = outcome.recordIds.filter(id => SAFE_ID.test(id)).join(", ") || "none";
  const providerRecords = (outcome.providerRecordIds ?? []).filter(id => SAFE_ID.test(id)).join(", ") || "none";
  const suffix = ` Approved records: ${records}. Provider records: ${providerRecords}. Fields: ${fields}.`;
  if (outcome.outcome === "read_withheld") return "The read finished, but its result is not shown because access changed." + suffix;
  if (outcome.outcome === "outcome_unknown") return "Not sure it went through. Check HighLevel; Murage will not send it again." + suffix;
  if (outcome.outcome === "stale") return "Not changed: the review expired or the bot's access changed first." + suffix;
  if (outcome.outcome === "not_applied") return (Number.isInteger(outcome.status) && outcome.status! >= 100 && outcome.status! <= 599 ? `Not changed: HighLevel said no (${outcome.status}).` : "Not changed in HighLevel.") + suffix;
  return `${outcome.risk === "R" ? "Read" : "Changed"} in HighLevel: ${title}.${outcome.basis !== "owner_exact_review" ? " (No limits)" : ""}${suffix}`;
}

/** GET /api/highlevel/reviews/:actionId. Values only to the owner's desktop app (ownerAppSurface ok with kind desktop);
 * every other surface gets 403 with the refusal code and no values. Never cached. */
export function highlevelReviewResponse(cards: Pick<HighLevelReviewCards, "reviewValues">, actionId: string,
  surface: { ok: true; app: { kind: string } } | { ok: false; refusal: OwnerAppRefusal }):
  { status: 200 | 403 | 404; headers: Record<string, string>; body: Record<string, unknown> } {
  const headers = { "cache-control": "no-store" };
  if (!surface.ok || surface.app.kind !== "desktop") {
    return { status: 403, headers, body: { error: HIGHLEVEL_ON_COMPUTER, code: surface.ok ? "on_computer" : surface.refusal } };
  }
  const review = cards.reviewValues(actionId);
  if (!review) return { status: 404, headers, body: { error: "This change is no longer waiting for you." } };
  const { tool, locationId, recordRefs, fields, values, reviewDigest, expiresAt, operation, completionKind } = review;
  return { status: 200, headers, body: { actionId, tool, locationId, recordRefs, fields, values, reviewDigest, expiresAt,
    ...(operation ? { operation } : {}), ...(completionKind ? { completionKind } : {}) } };
}

interface Open { threadId: string; botId: string; messageId: string; actionId: string; reviewDigest: string }

export class HighLevelReviewCards {
  readonly #store: Pick<Store, "appendMessage" | "messageById" | "patchMessage">;
  readonly #actions: Pick<HighLevelActions, "approve" | "deny" | "review">;
  readonly #waiting: (threadId: string, waiting: boolean, requestId: string, messageId?: string, botId?: string) => void;
  readonly #speaker?: (threadId: string, botId: string) => Message["from"] | undefined;
  readonly #open = new Map<string, Open>();
  readonly #present?: (claim: InternalCapability, row: Omit<Message, "id" | "at">, review: ActionReview) => Message | undefined;
  readonly #closed?: (actionId: string) => void;

  constructor(options: {
    store: Pick<Store, "appendMessage" | "messageById" | "patchMessage">;
    actions: Pick<HighLevelActions, "approve" | "deny" | "review">;
    waiting: (threadId: string, waiting: boolean, requestId: string, messageId?: string, botId?: string) => void;
    speaker?: (threadId: string, botId: string) => Message["from"] | undefined;
    present?: (claim: InternalCapability, row: Omit<Message, "id" | "at">, review: ActionReview) => Message | undefined;
    closed?: (actionId: string) => void;
  }) {
    this.#present = options.present; this.#closed = options.closed;
    this.#store = options.store; this.#actions = options.actions; this.#waiting = options.waiting; this.#speaker = options.speaker;
  }

  /** host.ts onReview: one card per proposed change, in the turn's own conversation. */
  opened(claim: InternalCapability, review: ActionReview & { title?: string }): void {
    const requestId = `${HIGHLEVEL_REQUEST_PREFIX}${review.actionId}`;
    const from = this.#speaker?.(claim.threadId, claim.botId);
    const row: Omit<Message, "id" | "at"> = murageLine({
      role: "bot", kind: "options", turnId: claim.generation, ...(from ? { from } : {}), card: {
        ...metadataLine(review.title ?? highlevelToolTitle(review.tool), review.locationId, review.recordRefs, review.fields, review.risk),
        held: `${review.risk === "D" ? "This can\'t be undone from Murage.\n\n" : ""}${reviewHeldText(review)}`, options: ["Allow", "Deny"], requestId, tool: review.tool,
      },
    });
    const card = this.#present ? this.#present(claim, row, review) : this.#store.appendMessage(claim.threadId, row);
    if (!card) return;
    this.#open.set(requestId, { threadId: claim.threadId, botId: claim.botId, messageId: card.id, actionId: review.actionId, reviewDigest: review.reviewDigest });
    this.#waiting(claim.threadId, true, requestId, card.id, claim.botId);
  }

  /** host.ts onReviewClosed: the review ended without this card (Stop, expiry, a decision elsewhere). */
  closed(actionId: string): void {
    const requestId = `${HIGHLEVEL_REQUEST_PREFIX}${actionId}`;
    const open = this.#open.get(requestId);
    if (open) this.#finish(requestId, open, "unavailable");
  }

  #finish(requestId: string, open: Open, answered: "allow" | "deny" | "unavailable"): void {
    this.#open.delete(requestId);
    this.#closed?.(open.actionId);
    const current = this.#store.messageById(open.threadId, open.messageId);
    if (current?.card && !current.card.answered) this.#store.patchMessage(open.threadId, open.messageId, { card: { ...current.card, answered, dismissed: answered === "unavailable" } });
    this.#waiting(open.threadId, false, requestId, undefined, open.botId);
  }

  /** Whether an Allow from this surface with this digest may approve the card: the owner's desktop app, and the digest of
   * the review that is open now. Anything else leaves the card open and waiting. */
  allowPermitted(threadId: string, requestId: string, approval: HighLevelApproval | undefined): boolean {
    const open = this.#open.get(requestId);
    if (!open || open.threadId !== threadId || approval?.desktop !== true) return false;
    const review = this.#actions.review(open.actionId);
    return !!review && (review.operation === 'users.create' ? review.completionKind === 'private_generated_password_v1' : !review.completionKind) && typeof approval.reviewDigest === "string" && approval.reviewDigest === open.reviewDigest && review.reviewDigest === open.reviewDigest;
  }

  /** The owner's answer from deliverAnswer. null: not a HighLevel card. Deny works from any owner surface with no digest;
   * Allow only as allowPermitted says (an Allow it refuses changes nothing). */
  resolve(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", approval?: HighLevelApproval): "allowed-once" | "rejected" | "unavailable" | null {
    if (!requestId.startsWith(HIGHLEVEL_REQUEST_PREFIX)) return null;
    const open = this.#open.get(requestId);
    if (!open || open.threadId !== threadId || behavior === "answer") return "unavailable";
    if (behavior === "allow" && !this.allowPermitted(threadId, requestId, approval)) return "unavailable";
    // The review the card was made for, still open: anything else approves nothing.
    const review = this.#actions.review(open.actionId);
    if (!review || review.reviewDigest !== open.reviewDigest) { this.#finish(requestId, open, "unavailable"); return "unavailable"; }
    if (behavior === "deny") { this.#actions.deny(open.actionId); this.#finish(requestId, open, "deny"); return "rejected"; }
    try {
      this.#actions.approve(open.actionId, open.reviewDigest);
    } catch (error) {
      if (!(error instanceof ActionRefused)) throw error;
      this.#finish(requestId, open, "unavailable");
      return "unavailable";
    }
    this.#finish(requestId, open, "allow");
    return "allowed-once";
  }

  /** The values of a review whose card is still open and whose review is unchanged; undefined once it is settled, expired,
   * stopped or replaced, or after a restart (the card map is memory only). */
  reviewValues(actionId: string): HighLevelReviewValues | undefined {
    const open = this.#open.get(`${HIGHLEVEL_REQUEST_PREFIX}${actionId}`);
    if (!open) return undefined;
    const review = this.#actions.review(actionId);
    if (!review || review.reviewDigest !== open.reviewDigest || review.expiresAt <= Date.now()) return undefined;
    return { actionId, tool: review.tool, operation: review.operation, ...(review.completionKind ? { completionKind: review.completionKind } : {}), locationId: review.locationId, recordRefs: [...review.recordRefs], fields: [...review.fields], values: review.values, reviewDigest: review.reviewDigest, expiresAt: review.expiresAt };
  }

  cancelThread(threadId: string): void {
    for (const [requestId, open] of this.#open) if (open.threadId === threadId) this.#finish(requestId, open, "unavailable");
  }

  get size(): number { return this.#open.size; }
}
