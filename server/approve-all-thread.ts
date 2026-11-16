// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIM-UI2-SRV (Rev 3.3 U1-U3, V1, V2, W1, W2, X1, X2): the thread-scoped Approve all preview. The chat names the request
// ids it shows; the server reads the thread's own open-card index (never the Inbox page), partitions each requested id
// into exactly one of eligible / later / excluded / closed, and refuses to guess when the index cannot answer (503, no
// batch). Everything the route and the apply need that is not plain HTTP lives here, over small dependency interfaces, so
// the same code runs against the real Store in tests.
import { APPROVE_ALL_CAP, bulkEligibility, bulkKindKey, type ApproveAllBatch, type ApproveAllBatches, type BatchCard, type BulkReasonKey, type BulkVerdict } from "./approve-all.ts";
import { approvalDigestSync } from "./approval-fresh-auth.ts";
import type { Message, Store } from "./store.ts";

/** What the authoritative batch read says about a window of ids: the open cards it found (orphans included), or that the
 *  index cannot answer for this thread right now (never "closed"). */
export interface OpenLookup { found: Map<string, Message>; unknown: boolean }
export type OpenLookupOne = { found: Message } | { absent: true } | { unknown: true };

/** How one card is resolved by request id (X1): the sweep rows, then the authoritative lookup, then the newest-rows scan. */
export interface CardDeps {
  sweepRows(threadId: string): Message[];
  lookupOne(threadId: string, requestId: string): OpenLookupOne;
  scan(threadId: string, visit: (message: Message) => boolean): boolean;
}
export interface PartitionDeps {
  /** The thread's open-card rows, oldest first, orphans merged, and whether that read is COMPLETE (V1). */
  openRows(threadId: string): { rows: Message[]; complete: boolean };
  /** ONE batch read per window for the requested ids the rows do not hold (X2). */
  lookup(threadId: string, requestIds: string[]): OpenLookup;
  /** One bounded walker step for this thread (W2). */
  prepare(threadId: string): "ready" | "pending" | "failed";
  eligibility(card: unknown, requestId: string): BulkVerdict;
  digest(threadId: string, requestId: string, card: never): string;
  botIdOf(threadId: string, row: Message): string | undefined;
}
export type ThreadDeps = PartitionDeps & CardDeps;

export type ThreadStore = Pick<Store, "openRequestCardRowsStatus" | "openCardsForRequests" | "openCardForRequest" | "prepareOpenCardIndex" | "scanNewest" | "botByThread">;

/** The real dependencies over a Store. `sweepLimit` / `scanLimit` exist for tests that need a saturated index cheaply. */
export function storeDeps(store: ThreadStore, opts: { sweepLimit?: number; scanLimit?: number } = {}): ThreadDeps {
  return {
    sweepRows: (threadId) => store.openRequestCardRowsStatus(threadId, opts.sweepLimit).rows,
    lookupOne: (threadId, requestId) => store.openCardForRequest(threadId, requestId),
    scan: (threadId, visit) => store.scanNewest(threadId, visit, opts.scanLimit),
    openRows: (threadId) => store.openRequestCardRowsStatus(threadId, opts.sweepLimit),
    lookup: (threadId, requestIds) => store.openCardsForRequests(threadId, requestIds),
    prepare: (threadId) => store.prepareOpenCardIndex(threadId),
    eligibility: bulkEligibility,
    digest: approvalDigestSync as ThreadDeps["digest"],
    botIdOf: (threadId, row) => row.from?.botId ?? store.botByThread(threadId)?.id,
  };
}

const isOpen = (card: Message["card"] | undefined): boolean =>
  Boolean(card && (card.answered === undefined || card.answered === null) && !card.dismissed && !card.expired);

/** The card row for `requestId` (X1): an open one through the sweep, else through the authoritative thread-scoped lookup
 *  (independent of the sweep and history limits), else an answered one among the newest rows. `unknown` means nothing
 *  was found AND the authoritative step could not say: never read as "not open". */
export function resolveCard(deps: CardDeps, threadId: string, requestId: string, test: (message: Message) => boolean = () => true): { row?: Message; unknown?: true } {
  const swept = deps.sweepRows(threadId).find((message) => message.card?.requestId === requestId && test(message));
  if (swept) return { row: swept };
  const one = deps.lookupOne(threadId, requestId);
  if ("found" in one && one.found.card?.requestId === requestId && test(one.found)) return { row: one.found };
  let found: Message | undefined;
  deps.scan(threadId, (message) => (message.card?.requestId === requestId && test(message) ? ((found = message), true) : false));
  // an authoritative step that could not say stays "unknown" even when the scan found a row: the bulk path never lets a
  // history match stand in for it (Astra r1 #2); the non-bulk callers read only `row`
  const unknown = "unknown" in one ? ({ unknown: true } as const) : {};
  return found ? { row: found, ...unknown } : unknown;
}

/** Apply (U3, W1; Astra r1 #1, #3): whether one non-approved ticked card stops the batch, and how it is reported. A thread batch stops at
 *  the FIRST changed card (not open, not eligible, refused, unresolved) and the later ticks stay open; the Inbox screen batch keeps its
 *  rule (only a proof/digest change, a computer-only refusal or an unresolved card stops it). An unresolved card is itself `not-applied`. */
export function stopsBatch(batch: Pick<ApproveAllBatch, "scope">, code: string, reason: string): boolean {
  if (code.startsWith("fresh_auth") || code === "approve_on_computer" || reason === "unresolved") return true;
  return Boolean(batch.scope?.startsWith("thread:"));
}
export const skippedResult = (reason: string): "skipped" | "not-applied" => (reason === "unresolved" ? "not-applied" : "skipped");

/** Apply's live re-check of one ticked card (W1, X1): resolved through the same authoritative step as the preview, then
 *  open, then eligible NOW. An unresolved card answers nothing. */
export function bulkRecheck(deps: Pick<ThreadDeps, "sweepRows" | "lookupOne" | "scan" | "eligibility">, threadId: string, requestId: string): { ok: true; row: Message } | { ok: false; reason: string } {
  const resolved = resolveCard(deps, threadId, requestId);
  if (resolved.unknown) return { ok: false, reason: "unresolved" };
  const card = resolved.row?.card;
  if (!resolved.row || !isOpen(card)) return { ok: false, reason: "not-open" };
  const verdict = deps.eligibility(card, requestId);
  if (!verdict.ok) return { ok: false, reason: `not-eligible:${verdict.reasonKey}` };
  return { ok: true, row: resolved.row };
}

/** The preview could not be made now (the index is being prepared or failed): the route says 503 and creates no batch. */
export class PreviewUnavailable extends Error {
  readonly why: "pending" | "failed" | "unknown" | "lookup";
  constructor(why: "pending" | "failed" | "unknown" | "lookup", cause?: unknown) {
    super(`preview unavailable: ${why}`, cause === undefined ? undefined : { cause });
    this.why = why;
  }
}

export interface ThreadEntry { threadId: string; requestId: string; messageId: string | null }
export interface ThreadPartition {
  eligible: Array<ThreadEntry & Record<string, unknown> & BatchCard>;
  later: ThreadEntry[];
  excluded: Array<ThreadEntry & { botId?: string; summary: string; reasonKey: BulkReasonKey }>;
  closed: ThreadEntry[];
}

/** One read of a window: the rows the index holds for the requested ids, the fallback batch read for the rest (only when
 *  the first read is incomplete: "Merged-array length never establishes completeness"), and the ids that are authoritatively absent. */
function readWindow(deps: PartitionDeps, threadId: string, requestIds: string[]): { found: Map<string, Message>; absent: Set<string>; unknown: boolean } {
  const wanted = new Set(requestIds);
  const status = deps.openRows(threadId);
  const found = new Map<string, Message>();
  for (const row of status.rows) {
    const id = row.card?.requestId;
    if (id && wanted.has(id) && !found.has(id)) found.set(id, row);
  }
  const missing = requestIds.filter((id) => !found.has(id));
  if (!missing.length) return { found, absent: new Set(), unknown: false };
  if (status.complete) return { found, absent: new Set(missing), unknown: false };
  const looked = deps.lookup(threadId, missing);
  if (looked.unknown) return { found, absent: new Set(), unknown: true };
  for (const id of missing) {
    const row = looked.found.get(id);
    if (row && row.card?.requestId === id) found.set(id, row);
  }
  return { found, absent: new Set(missing.filter((id) => !found.has(id))), unknown: false };
}

/** U2, V1, V2, W1, W2: each requested id lands in EXACTLY ONE list. Throws PreviewUnavailable when completeness cannot be established. */
export function partitionThread(deps: PartitionDeps, threadId: string, requestIds: string[]): ThreadPartition {
  let window: ReturnType<typeof readWindow>;
  try {
    window = readWindow(deps, threadId, requestIds);
    if (window.unknown) {
      const prepared = deps.prepare(threadId);
      if (prepared !== "ready") throw new PreviewUnavailable(prepared);
      window = readWindow(deps, threadId, requestIds);
      if (window.unknown) throw new PreviewUnavailable("unknown");
    }
  } catch (error) {
    throw error instanceof PreviewUnavailable ? error : new PreviewUnavailable("lookup", error);
  }
  const rows = [...window.found].map(([requestId, row], index) => ({ requestId, row, index }))
    .sort((a, b) => (a.row.at - b.row.at) || (a.index - b.index));
  const closedById = new Map<string, ThreadEntry>();
  const out: ThreadPartition = { eligible: [], later: [], excluded: [], closed: [] };
  for (const { requestId, row } of rows) {
    const card = row.card!;
    const entry = { threadId, requestId, messageId: row.id };
    // judged on the row the preview resolved, never re-looked-up through the sweep (W1, X1)
    if (!isOpen(card)) { closedById.set(requestId, entry); continue; }
    const botId = deps.botIdOf(threadId, row);
    const excludeWith = (reasonKey: BulkReasonKey) => out.excluded.push({ ...entry, ...(botId ? { botId } : {}), summary: card.summary ?? card.subtitle ?? "", reasonKey });
    // V2: an orphaned row (answerable on its own) is excluded with its own reason; `not-open` is the closed list
    if (card.orphaned) { excludeWith("orphaned"); continue; }
    const verdict = deps.eligibility(card, requestId);
    if (!verdict.ok) { excludeWith(verdict.reasonKey); continue; }
    if (out.eligible.length >= APPROVE_ALL_CAP) { out.later.push(entry); continue; }
    out.eligible.push({
      ...entry, ...(botId ? { botId } : {}), kindLine: bulkKindKey(card.tool ?? ""),
      ...(typeof card.wants === "string" && card.wants ? { wants: card.wants } : {}),
      digest: deps.digest(threadId, requestId, card as never),
      // what the phone shows and digests (design 7.3), as on the Inbox path
      card: { tool: card.tool, title: card.title, subtitle: card.subtitle, summary: card.summary, held: card.held,
        toolInputTruncated: card.toolInputTruncated, approvalScope: card.approvalScope, taskAllowKey: card.taskAllowKey },
    });
  }
  for (const id of window.absent) closedById.set(id, { threadId, requestId: id, messageId: null });
  out.closed = requestIds.filter((id) => closedById.has(id)).map((id) => closedById.get(id)!);
  return out;
}

export const PREVIEW_UNAVAILABLE_BODY = { error: "Murage is still getting this chat ready. Press Approve all again in a moment.", code: "preview_unavailable" } as const;

/** The whole thread preview response: the partition, plus the frozen batch (exactly the eligible cards, scope thread:<id>). */
export function buildThreadPreview(
  deps: PartitionDeps, batches: ApproveAllBatches, surface: { key: string; deviceId: string | null }, threadId: string, requestIds: string[],
): { status: number; body: Record<string, unknown> } {
  let partition: ThreadPartition;
  try {
    partition = partitionThread(deps, threadId, requestIds);
  } catch (error) {
    if (error instanceof PreviewUnavailable) return { status: 503, body: { ...PREVIEW_UNAVAILABLE_BODY } };
    throw error;
  }
  const batch = partition.eligible.length
    ? batches.create(surface.key, surface.deviceId, partition.eligible.map(({ threadId: t, requestId, digest }) => ({ threadId: t, requestId, digest })), `thread:${threadId}`)
    : null;
  return {
    status: 200,
    body: { scope: "thread", threadId, batchId: batch?.batchId ?? null, ...partition, ...(surface.deviceId ? { deviceId: surface.deviceId } : {}) },
  };
}

/** U3: a thread batch is applied only while its thread is still visible to the caller's door (S13). The Inbox screen batch is not thread scoped. */
export function threadBatchAccessible(batch: Pick<ApproveAllBatch, "scope">, threads: ReadonlyArray<{ threadId: string }>): boolean {
  if (!batch.scope?.startsWith("thread:")) return true;
  const threadId = batch.scope.slice("thread:".length);
  return threads.some((thread) => thread.threadId === threadId);
}
