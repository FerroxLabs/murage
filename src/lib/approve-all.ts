// SPDX-License-Identifier: AGPL-3.0-or-later
// Approve all in Inbox > Approvals (APPROVE-ALL-1016 rev 3, batch B). The server decides who sees the button
// (ownerAppSurface), which cards qualify and why the rest stay; this file only words and groups what it sent, and on
// the phone signs the exact ticked set once with the existing device prompt.
import { APPROVE_ALL_THREAD, approvalBatchDigest, approvalDigest, type BatchLine, type DigestCard } from "../../shared/approval-digest";
import { FreshAuthError, type FreshAuthCode } from "./fresh-auth";
import type { LocaleKey } from "../locales";
import { t } from "./i18n";
import { callNative, nativeAvailable } from "./native-shell";

export type BulkKindKey = "command" | "edit" | "app" | "other";
import { BULK_REASON_KEYS, reasonLine, type BulkReasonKey } from "./approval-row";
export { BULK_REASON_KEYS, reasonLine, type BulkReasonKey };

/** `messageId` is the Inbox row the card is (a press binds to the rows on screen); `wants` is the bot's own line the
 *  phone sheet shows. Neither is in the digest. */
export interface EligibleCard { threadId: string; requestId: string; messageId?: string; wants?: string; botId?: string; kindLine: BulkKindKey; digest: string; card: DigestCard }
export interface ExcludedCard { threadId: string; requestId: string; botId?: string; summary: string; reasonKey: BulkReasonKey }
export interface ApproveAllPreview { batchId: string | null; eligible: EligibleCard[]; excluded: ExcludedCard[]; more: number; deviceId?: string }
export interface ApproveAllSurface { show: boolean; app?: "desktop" | "phone"; cautionDismissed?: boolean }
export interface ApplyResult { threadId: string; requestId: string; result: "approved" | "skipped" | "not-applied"; reason?: string }

/** The Inbox views that offer Approve all: Approvals, and Needs you (`decisions`, the default tab; Sean 11-06: three
 *  approval rows and no Approve all). Elsewhere null. APPROVALS-SIMPLE-1018 section 3 (Astra r1 H4): the count is the
 *  rows ON SCREEN the server stamped `bulk: "ok"` (the same verdict the preview and respond run), never the page's
 *  approval count, so the button never says a number it would not approve. Under 2 it stays away. */
export function approveAllHint(view: string, shown: ReadonlyArray<{ kind?: string; bulk?: string }>): number | null {
  if (view !== "approvals" && view !== "decisions") return null;
  return shown.filter((item) => item.kind === "request" && item.bulk === "ok").length;
}

/** Section 3b: the list's generation token, the set of displayed request rows. It moves when that set changes, never
 *  on a quiet poll that reads the same rows back. */
export function listToken(keys: readonly string[]): string {
  return [...new Set(keys)].sort().join("\n");
}

/** Section 3 (Astra r1 H4): a press answers exactly the rows on screen stamped ok that the preview also lists. Any
 *  such row the preview does not list means the list moved under the press: nothing is applied ("changed"). A preview
 *  that lists none of them: "none" ("Nothing left to approve."). */
export function boundToScreen(preview: ApproveAllPreview, shownKeys: readonly string[]): { at: "cards"; cards: EligibleCard[] } | { at: "changed" } | { at: "none" } {
  const keyOf = (card: EligibleCard) => (card.messageId ? `${card.threadId}\u0000${card.messageId}` : "");
  const listed = new Set(preview.eligible.map(keyOf).filter(Boolean));
  if (!preview.batchId || preview.eligible.length === 0 || shownKeys.length === 0) return { at: "none" };
  if (shownKeys.some((key) => !listed.has(key))) return { at: "changed" };
  const shown = new Set(shownKeys);
  const cards = preview.eligible.filter((card) => shown.has(keyOf(card)));
  return cards.length ? { at: "cards", cards } : { at: "none" };
}

/** Section 3b: a result line stays while the list only loses rows it was pressed over (the apply answering them);
 *  a row that was not there at the press means the list moved, and the line goes. */
export function resultSurvives(pressKeys: readonly string[], nextKeys: readonly string[]): boolean {
  const pressed = new Set(pressKeys);
  return nextKeys.every((key) => pressed.has(key));
}

const KIND_ORDER: readonly BulkKindKey[] = ["command", "edit", "app", "other"];
const KIND_KEYS: Record<BulkKindKey, LocaleKey> = { command: "approveAll.kind.command", edit: "approveAll.kind.edit", app: "approveAll.kind.app", other: "approveAll.kind.other" };

export function kindLine(kind: string, n: number): string {
  return t(KIND_KEYS[(KIND_ORDER as readonly string[]).includes(kind) ? kind as BulkKindKey : "other"], { n });
}

export interface BotGroup { botId: string; requestIds: string[]; kinds: Array<{ kind: BulkKindKey; n: number }> }
/** Design 3: grouped by bot (in the order the server listed them), then by kind in a fixed order. */
export function groupByBot(eligible: readonly EligibleCard[]): BotGroup[] {
  const groups = new Map<string, { requestIds: string[]; counts: Map<BulkKindKey, number> }>();
  for (const card of eligible) {
    const id = card.botId ?? "";
    const group = groups.get(id) ?? { requestIds: [] as string[], counts: new Map<BulkKindKey, number>() };
    group.requestIds.push(card.requestId);
    const kind: BulkKindKey = (KIND_ORDER as readonly string[]).includes(card.kindLine) ? card.kindLine : "other";
    group.counts.set(kind, (group.counts.get(kind) ?? 0) + 1);
    groups.set(id, group);
  }
  return [...groups].map(([botId, group]) => ({ botId, requestIds: group.requestIds, kinds: KIND_ORDER.filter((kind) => group.counts.has(kind)).map((kind) => ({ kind, n: group.counts.get(kind)! })) }));
}

/** The cards left ticked, in the preview's order (the order apply answers them in). These exact objects are what the
 *  sheet shows and what the phone signs. */
export function tickedCards(eligible: readonly EligibleCard[], unticked: ReadonlySet<string>): EligibleCard[] {
  return eligible.filter((card) => !unticked.has(card.botId ?? ""));
}
export function tickedIds(eligible: readonly EligibleCard[], unticked: ReadonlySet<string>): string[] {
  return tickedCards(eligible, unticked).map((card) => card.requestId);
}

export interface CardDetail { tool: string; subtitle: string; summary: string; held: string }
/** Design 7.3: what a signed card shows, the same fields InboxRequest shows before a device proof (tool, subtitle,
 *  summary when it differs from the subtitle, held line). */
export function cardDetail(card: EligibleCard): CardDetail {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const subtitle = text(card.card.subtitle);
  const summary = text(card.card.summary);
  return { tool: text(card.card.tool), subtitle, summary: summary === subtitle ? "" : summary, held: text(card.card.held) };
}

/** One preview at a time, and none once a sign has started (review H2). begin() hands out a token, or null while a
 *  preview is loading or a sign is in flight; only the latest token is accepted, and never during or after a sign it
 *  did not start under. sign() locks; done() unlocks and retires every older token. */
export function previewGate() {
  let generation = 0;
  let loading = false;
  let signing = false;
  return {
    begin(): number | null { if (loading || signing) return null; loading = true; return ++generation; },
    accepts(token: number): boolean { const ok = token === generation && !signing; if (token === generation) loading = false; return ok; },
    sign(): boolean { if (signing || loading) return false; signing = true; return true; },
    done(): void { signing = false; loading = false; generation += 1; },
    /** Section 3b: the list moved. A preview still loading is dropped when it lands (it never restores a sheet); a sign
     *  or apply already in flight keeps its lock until it settles. */
    retire(): void { generation += 1; loading = false; },
    get signing(): boolean { return signing; },
  };
}

const plural = (n: number): "one" | "other" => (n === 1 ? "one" : "other");

/** Design 5: one line after apply, no undo. Cards whose bot had stopped waiting are named by bot; anything else that was
 *  not approved is counted and said to be still in the Inbox. */
export function resultLine(results: readonly ApplyResult[], botName: (threadId: string) => string): string {
  const approved = results.filter((r) => r.result === "approved").length;
  const stoppedWaiting = results.filter((r) => r.result !== "approved" && r.reason === "not-open");
  const others = results.filter((r) => r.result !== "approved" && r.reason !== "not-open").length;
  let line = stoppedWaiting.length
    ? t(`approveAll.result.stopped.${plural(stoppedWaiting.length)}` as LocaleKey, { n: approved, m: stoppedWaiting.length, bot: [...new Set(stoppedWaiting.map((r) => botName(r.threadId)))].join(", ") })
    : t(`approveAll.result.done.${plural(approved)}` as LocaleKey, { n: approved });
  if (others) line += ` ${t(`approveAll.result.left.${plural(others)}` as LocaleKey, { m: others })}`;
  return line;
}

interface Challenge { v: 1; nonce: string; digest: string; decision: "allow"; expiresAt: number }
function batchChallenge(value: unknown): Challenge | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  return c.v === 1 && typeof c.nonce === "string" && /^[A-Za-z0-9_-]{43}$/.test(c.nonce) && typeof c.digest === "string" && /^[0-9a-f]{64}$/.test(c.digest)
    && c.decision === "allow" && Number.isInteger(c.expiresAt) ? { v: 1, nonce: c.nonce, digest: c.digest, decision: "allow", expiresAt: c.expiresAt as number } : null;
}

const SERVER_CODES: Record<string, FreshAuthCode> = { approve_on_computer: "computerOnly", fresh_auth_unattested: "pairAgain", fresh_auth_failed: "failed", fresh_auth_changed: "changed" };
const NATIVE_CODES: Record<string, FreshAuthCode> = { cancelled: "cancelled", no_lock: "noLock", no_key: "noKey" };

/**
 * Apply the ticked set. The desktop posts once. The phone posts, meets the gate's challenge, and signs only when its
 * own digest over exactly the ticked cards it shows equals the challenge's (design 7.3), then posts once more. One
 * signed retry, never a loop. Every card digest is recomputed from the body on screen, not taken from the server.
 */
export async function applyApproveAll(
  post: (body: Record<string, unknown>) => Promise<{ approved: number; results: ApplyResult[] }>,
  preview: ApproveAllPreview,
  shown: readonly EligibleCard[],
  reason: string,
  onDevicePrompt?: (up: boolean) => void,
): Promise<{ approved: number; results: ApplyResult[] }> {
  const requestIds = shown.map((card) => card.requestId);
  const body = { batchId: preview.batchId, requestIds };
  try {
    return await post(body);
  } catch (error) {
    const { status, body: refusal } = (error ?? {}) as { status?: number; body?: { code?: unknown; challenge?: unknown } };
    const code = typeof refusal?.code === "string" ? refusal.code : "";
    if (Object.hasOwn(SERVER_CODES, code)) throw new FreshAuthError(SERVER_CODES[code]);
    if (status !== 403 || code !== "fresh_auth") throw error;
    const challenge = batchChallenge(refusal?.challenge);
    if (!challenge || !preview.batchId || !preview.deviceId) throw new FreshAuthError("changed");
    if (!globalThis.crypto?.subtle) throw new FreshAuthError("update");
    // Sign exactly the cards on screen: each must be the preview's own card object for that id (no duplicates), and its
    // body must hash to the digest the server froze for it, so the ids and hashes signed are the ones shown.
    const lines: BatchLine[] = [];
    const seen = new Set<string>();
    for (const card of shown) {
      const key = `${card.threadId}\u0000${card.requestId}`;
      if (seen.has(key) || !preview.eligible.includes(card)) throw new FreshAuthError("changed");
      seen.add(key);
      const digest = await approvalDigest(card.threadId, card.requestId, card.card);
      if (digest !== card.digest) throw new FreshAuthError("changed");
      lines.push([card.threadId, card.requestId, digest]);
    }
    if ((await approvalBatchDigest(preview.batchId, preview.deviceId, lines)) !== challenge.digest) throw new FreshAuthError("changed");
    if (!(await nativeAvailable("approveWithDevice"))) throw new FreshAuthError("update");
    let signed: unknown;
    onDevicePrompt?.(true);
    try {
      signed = await callNative("approveWithDevice", { ...challenge, threadId: APPROVE_ALL_THREAD, requestId: preview.batchId, reason: reason.slice(0, 160) });
    } catch (cause) {
      throw new FreshAuthError(NATIVE_CODES[cause instanceof Error ? cause.message : ""] ?? "failed");
    } finally {
      onDevicePrompt?.(false);
    }
    const signature = (signed as { signature?: unknown } | null)?.signature;
    if (typeof signature !== "string") throw new FreshAuthError("failed");
    return post({ ...body, freshAuth: { nonce: challenge.nonce, signature } });
  }
}

/** The line under the phone's device prompt: how many, and from which bots. At most 160 characters. */
export function batchReason(n: number, botNames: readonly string[]): string {
  return t(`approveAll.deviceReason.${plural(n)}` as LocaleKey, { n, bots: botNames.join(", ") }).slice(0, 160);
}
