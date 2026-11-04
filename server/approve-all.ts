// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// APPROVE-ALL (design rev 3, designs/APPROVE-ALL-1016.md): the pure parts of "Approve all" in Inbox > Approvals.
//
// - bulkEligibility: a positive allowlist, fail closed. A card qualifies only when every fact the server wrote on it
//   when it opened says it is an ordinary one-time step in a turn the owner started. The preview uses it, and the
//   respond path re-runs it on the live card before anything is answered (design 6.2 step 1b).
// - ApproveAllBatches: the frozen list. A preview makes a batch bound to the device and surface that asked; it lives
//   2 minutes and is burned on the first apply that passes the proof.
// - CaptureResponse: the sink a bulk answer writes its reply to, so Approve all answers each card through the very
//   same respond function the card's own button uses (design 6.1).
//
// The grant never widens: every approval is the "Allow once" the owner would tap. Nothing is remembered.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { CardReason } from "../shared/fold-scopes.ts";
import type { BatchLine } from "../shared/approval-digest.ts";

export const APPROVE_ALL_CAP = 25;
export const APPROVE_ALL_BATCH_TTL_MS = 120_000;
/** Batches held at once, across every device (each lives 2 minutes; a flood evicts the oldest). */
export const APPROVE_ALL_MAX_BATCHES = 64;
export const BATCH_ID = /^aab-[0-9a-f]{32}$/;

/** Why a card stays for one-by-one. Content free: the sheet words each key (batch B). */
export type BulkReasonKey =
  | "always-ask" | "pay" | "message" | "delete" | "needs-look" | "held" | "unattended"
  | "truncated" | "local-computer" | "routine" | "origin" | "not-approval" | "not-open";

/** Every verdict source has an explicit answer, so a new source cannot reach Approve all without a decision here.
 *  null: the source may qualify (only an ordinary card no grant answered). Anything else: the reason it stays. */
export const BULK_REASON: Readonly<Record<CardReason, BulkReasonKey | null>> = {
  "no-grant": null,
  "always-ask": "always-ask",
  narrow: "held",
  "stop-line": "held",
  "destructive-guard": "held",
  "sensitive-guard": "held",
  "prompt-guard": "held",
  "unread-call": "held",
  "unattended-block": "unattended",
  "local-computer-block": "local-computer",
  "routine-allow": "routine",
  "question-tool": "not-approval",
  question: "not-approval",
  // sources that answer without a card; a card that carries one anyway is not ordinary
  "always-allow": "held",
  "exact-command": "held",
  "auto-mode": "held",
  "full-access": "held",
  "no-limits": "held",
  "own-workspace": "held",
  "own-files": "held",
  "own-tool-results": "held",
  "project-work-roots": "held",
  "own-unasked": "held",
  "task-allowance": "held",
};

export type BulkVerdict = { ok: true } | { ok: false; reasonKey: BulkReasonKey };
const no = (reasonKey: BulkReasonKey): BulkVerdict => ({ ok: false, reasonKey });
const has = (record: Record<string, unknown>, key: string): boolean => record[key] !== undefined && record[key] !== null && record[key] !== false;

/** Design 2: may Approve all give this card the owner's Allow once? Read only from facts the server wrote; `lowRisk`
 *  is advisory and never read. Anything missing, unknown or malformed stays for one-by-one. */
export function bulkEligibility(card: unknown, requestId: string): BulkVerdict {
  if (!card || typeof card !== "object" || Array.isArray(card)) return no("not-open");
  const c = card as Record<string, unknown>;
  if (typeof requestId !== "string" || !requestId || c.requestId !== requestId) return no("not-open");
  if (c.answered !== undefined && c.answered !== null) return no("not-open");
  if (has(c, "dismissed") || has(c, "expired") || has(c, "orphaned")) return no("not-open");
  // questions, folder trust, intake, setup and other cards that are not a tool approval
  if (has(c, "questions") || has(c, "folderTrust") || has(c, "intake") || has(c, "setup") || has(c, "answerAsSend")) return no("not-approval");
  if (has(c, "routineRequest")) return no("routine");
  if (has(c, "skillRequest")) return no("needs-look");
  if (typeof c.tool !== "string" || !c.tool) return no("not-approval");
  if (/^(?:image|publish|limit|email)-/.test(requestId)) return no("needs-look");
  if (c.kind !== undefined) return c.kind === "email-send" ? no("message") : no("needs-look");
  for (const twin of ["emailSend", "publish", "mcpEnable", "emailTrustOffer", "limitOffer", "browserSetup"]) {
    if (has(c, twin)) return twin === "emailSend" ? no("message") : no("needs-look");
  }
  if (c.browserCardKind !== undefined) return c.browserCardKind === "delete" ? no("delete") : no("message");
  if (has(c, "unattended")) return no("unattended");
  if (has(c, "toolInputTruncated")) return no("truncated");
  if (c.approvalScope !== undefined) return no("local-computer");
  const cls = c.cardClass;
  // older cards carry no class: never
  if (!cls || typeof cls !== "object" || Array.isArray(cls)) return no("held");
  const k = cls as Record<string, unknown>;
  if (typeof k.reason !== "string" || !Object.prototype.hasOwnProperty.call(BULK_REASON, k.reason)) return no("held");
  if (k.reason === "always-ask") return no("always-ask");
  if (k.stop !== undefined) {
    const stop = k.stop as Record<string, unknown> | null;
    const kind = stop && typeof stop === "object" ? stop.kind : undefined;
    return kind === "pay" ? no("pay") : kind === "delete" ? no("delete") : no("message");
  }
  const byReason = BULK_REASON[k.reason as CardReason];
  if (byReason !== null) return no(byReason);
  if (k.unattended !== false) return no("unattended");
  if (k.automated !== false) return no("routine");
  if (k.routine !== undefined) return no("routine");
  if (k.scope !== undefined) return no("local-computer");
  if (k.origin !== "owner") return no("origin");
  if (has(c, "held")) return no("held");
  return { ok: true };
}

/** The plain kind of a qualifying card, as a key the sheet words (batch B): never English here. */
export function bulkKindKey(tool: string): "command" | "edit" | "app" | "other" {
  if (/^(?:mcp__.+__)?(?:[\w-]+\.)?(?:bash|shell|execute|exec_command|run_command|terminal|powershell|pwsh)$/i.test(tool)) return "command";
  if (/^(?:mcp__.+__)?(?:edit|write|multiedit|multi_edit|apply_patch|notebookedit|str_replace_editor|create_file|edit_file|write_file)$/i.test(tool)) return "edit";
  if (tool.startsWith("mcp__")) return "app";
  return "other";
}

/** The special cards Approve all never answers, in respondToCard's own branch order (design 6.2). */
export const BULK_SPECIAL_KINDS = ["limit", "email", "question", "skill", "routine", "peer", "extension", "host-consent"] as const;
export type BulkSpecialKind = (typeof BULK_SPECIAL_KINDS)[number];
/** One read-only probe per special kind: each is the live predicate that kind's own branch in respondToCard tests. */
export type BulkSpecialProbes = { readonly [K in BulkSpecialKind]: () => boolean };
/** The second fence (GrokBuild ruling 11-03): in bulk, respondToCard asks this once, right after the live re-read and before
 *  any resolver, attempt record or await. Synchronous; the first kind that matches, in branch order, refuses the card. A probe
 *  that throws propagates (nothing is answered). bulkEligibility already keeps these cards out of the preview. */
export function bulkSpecialRefusal(probes: BulkSpecialProbes): `special-card:${BulkSpecialKind}` | null {
  for (const kind of BULK_SPECIAL_KINDS) if (probes[kind]()) return `special-card:${kind}`;
  return null;
}

export interface BatchCard { threadId: string; requestId: string; digest: string }
export interface ApproveAllBatch {
  batchId: string;
  /** "desktop", or "app:<deviceId>" for the paired phone that asked */
  surface: string;
  deviceId: string | null;
  cards: BatchCard[];
  expiresAt: number;
}

/** Design 1 and 7.4: the frozen list, held in memory only. */
export class ApproveAllBatches {
  private readonly batches = new Map<string, ApproveAllBatch>();
  private readonly burned = new Map<string, number>();
  private readonly now: () => number;
  private readonly newId: () => string;
  constructor(deps: { now: () => number; id?: () => string }) {
    this.now = deps.now;
    this.newId = deps.id ?? (() => `aab-${randomBytes(16).toString("hex")}`);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, batch] of this.batches) if (batch.expiresAt <= now) this.batches.delete(id);
    for (const [id, until] of this.burned) if (until <= now) this.burned.delete(id);
  }

  create(surface: string, deviceId: string | null, cards: BatchCard[]): ApproveAllBatch {
    this.sweep();
    while (this.batches.size >= APPROVE_ALL_MAX_BATCHES) this.batches.delete(this.batches.keys().next().value!);
    const batch: ApproveAllBatch = { batchId: this.newId(), surface, deviceId, cards: cards.slice(0, APPROVE_ALL_CAP), expiresAt: this.now() + APPROVE_ALL_BATCH_TTL_MS };
    this.batches.set(batch.batchId, batch);
    return batch;
  }

  /** Design 7.4 step 2: the batch exists, is unexpired, not burned and bound to this surface; the ticked ids are
   *  unique, at most 25 and all in it. Returns the ticked cards in preview order. */
  open(batchId: unknown, surface: string, requestIds: unknown): { ok: true; batch: ApproveAllBatch; ticked: BatchCard[] } | { ok: false; code: string } {
    this.sweep();
    if (typeof batchId !== "string" || !BATCH_ID.test(batchId)) return { ok: false, code: "batch_unknown" };
    if (this.burned.has(batchId)) return { ok: false, code: "batch_used" };
    const batch = this.batches.get(batchId);
    if (!batch) return { ok: false, code: "batch_unknown" };
    if (batch.surface !== surface) return { ok: false, code: "batch_unknown" };
    if (!Array.isArray(requestIds) || requestIds.length < 1 || requestIds.length > APPROVE_ALL_CAP) return { ok: false, code: "bad_selection" };
    if (!requestIds.every((id) => typeof id === "string") || new Set(requestIds).size !== requestIds.length) return { ok: false, code: "bad_selection" };
    const wanted = new Set(requestIds as string[]);
    const ticked = batch.cards.filter((card) => wanted.has(card.requestId));
    if (ticked.length !== wanted.size) return { ok: false, code: "bad_selection" };
    return { ok: true, batch, ticked };
  }

  /** Design 7.4 step 4: once burned, no apply with this id is taken again. */
  burn(batchId: string): void {
    this.batches.delete(batchId);
    this.burned.set(batchId, this.now() + APPROVE_ALL_BATCH_TTL_MS);
  }
}

export const batchLines = (cards: readonly BatchCard[]): BatchLine[] => cards.map((card) => [card.threadId, card.requestId, card.digest] as const);

/** The reply sink a bulk answer writes to (design 6.1): records status and body and emits `finish`, as a real
 *  ServerResponse does after `end`, so answeredWhere.attempt drops a refused attempt exactly as on a single answer. */
export class CaptureResponse extends EventEmitter {
  statusCode = 200;
  body: Record<string, unknown> | null = null;
  ended = false;
  writeHead(status: number): this { this.statusCode = status; return this; }
  setHeader(): this { return this; }
  end(data?: unknown): this {
    if (this.ended) return this;
    this.ended = true;
    try { this.body = typeof data === "string" ? JSON.parse(data) as Record<string, unknown> : null; } catch { this.body = null; }
    this.emit("finish");
    return this;
  }
}

/** What the apply route hands respondToCard for one card of a batch (design 6.2, 6.3). */
export interface BulkCard {
  batchId: string;
  batchSize: number;
  /** the card's digest taken at preview, and for a phone the digest the batch proof signed for it */
  previewDigest: string;
  /** the batch proof passed freshAuth.check (phone) */
  proven: boolean;
  /** the batch was asked for and applied from the desktop app */
  desktop: boolean;
}
