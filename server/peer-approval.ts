// Harness-native peer-comm approval gate.
//
// A bot with `approvePeerComms = true` may not call ask_bot or
// delegate_bot without a human approving the specific contact. The
// approval rides on the same options-card flow provider permissions
// already use: a card pushed into the SOURCE bot's thread with a
// `requestId`, answered by the user via /api/bots/:id/respond (or
// /api/threads/:id/respond) which the harness intercepts via
// `resolvePeerComms` BEFORE forwarding to the provider adapter. That
// way nothing front-end has to learn about peer comms.
//
// "Always allow" rides on the existing per-bot `alwaysAllow` list. The
// card carries an ID-based `allowKey` and
// the user-facing Always-allow flow already mirrors that key back into
// `alwaysAllow`, so the two sides never disagree about what was granted.

import { newId } from "./contracts.ts";
import { messagesHighWater, openToolCardPage, openToolCardRowsInRange, openToolCardRowsIndexed, type OpenCardKey } from "./message-db.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import type { RoutinePeerSource } from "./routine-permissions.ts";
import { murageLine } from "./murage-line.ts";

export { peerAllowKey } from "./peer-approval-key.ts";

/** Only allow authorizes work. A card nobody answered, or one cancelled
 * because its bot or turn went away, is not the user saying no, and the
 * calling bot must not be told it was (upstream OpenMausBot #1526). */
export type PeerApprovalOutcome = "allow" | "deny" | "expired" | "cancelled";
export type PeerApprovalFailure = Exclude<PeerApprovalOutcome, "allow">;

export function peerApprovalFailure(outcome: PeerApprovalFailure): {
  error: string;
  approvalOutcome: PeerApprovalFailure;
  approvalSource: "user" | "system";
} {
  return {
    error: outcome === "deny" ? "denied by user"
      : outcome === "expired" ? "the approval card expired without an answer"
        : "the approval was cancelled before a decision",
    approvalOutcome: outcome,
    approvalSource: outcome === "deny" ? "user" : "system",
  };
}

/** What a peer-approval helper needs from the outside world: the store
 * for thread append + persist, and the SSE broadcaster so the chat
 * updates without waiting for a refresh. */
export interface ApprovalBus {
  store: Store;
  /** SSE broadcast (kind: "message" envelope). */
  broadcast: (payload: Record<string, unknown>) => void;
  /** The provider turn running in a conversation now (internal-capabilities.ts providerTurnOf), from the server's own turn state, never a request.
   * A card that quotes a bot's message or names its choices names that turn, so revoking the turn's inputs withholds it. */
  turnOf?: (threadId: string) => string | undefined;
  onApproval?: (botId: string, threadId: string, requestId: string, messageId: string) => void;
  /** Does the current sender still cover the queued contact's ceiling? */
  fullAccessStanding?: (botId: string, threadId: string, routineAuthority?: RoutinePeerSource) => boolean;
  /** Scheduled routines also count as unattended for remembered contacts. */
  unattended?: (threadId: string) => boolean;
  /** A scheduled or manual routine run owns the thread. `opened` says so
   * (true: the card is held for the run, and the run waits
   * on the owner); `closed` reports the answer and says whether the run's
   * turn had already ended (true: the run carries on in a new turn). */
  routineCard?: RoutineCardHooks;
  holdProjectApproval?: (threadId:string)=>boolean;
}

export interface RoutineCardHooks {
  opened: (threadId: string, requestId: string, summary: string) => boolean;
  closed: (threadId: string, requestId: string, answer: "allow" | "deny" | "none") => boolean;
}

interface Pending {
  resolve: (result: PeerApprovalOutcome) => void;
  /** Held open by a routine run (RoutineCardHooks). */
  held?: boolean;
  allowKey: string;
  requestId: string;
  fromBotId: string;
  toBotId: string;
  message: string;
  /** Where the card lives, so answering it can settle it. A card that is
   * never settled keeps matching the client's "unanswered" filter, and the
   * composer stays disabled behind it — the thread is unusable from then on. */
  threadId: string;
  messageId: string;
  bus: ApprovalBus;
  /** The room request this card decides, when there is one (a shared
   *  request waiting in the drain): stopping that request cancels the card. */
  boundRequestId?: string;
}

/** Mark the card answered so the UI stops treating it as pending. Mirrors
 * what the `request.resolved` fold does for provider cards; a harness-native
 * card never emits that event, so it has to settle itself. */
function settleCard(pending: Pending, behavior: string, source: "user" | "system"): void {
  const existing = pending.bus.store.messageById(pending.threadId, pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  pending.bus.store.patchMessage(pending.threadId, pending.messageId, {
    // A close the owner did not choose reads "Not answered", never "Denied" (LONGWORK H2). An "allow" stays "allow" whatever its source: an allow that went through ran the action, so "Not answered" would be untrue (GROK-STOPPED F6, kept on purpose).
    card: { ...existing.card, answered: source === "user" || behavior === "allow" ? behavior : "unavailable", dismissed: source !== "user" },
  });
}

/** requestId → pending ask. Lives only in memory — restarting the
 * server cancels every in-flight approval, like provider permissions do. */
const pendingComms = new Map<string, Pending>();

/** An allow the owner gave after the routine run's turn had ended: the run
 * carries on in a new turn, and its same contact is not asked twice. Used
 * once. `threadId\u0000allowKey`. */
const lateAllows = new Set<string>();

function closeHeld(pending: Pending, answer: "allow" | "deny" | "none"): void {
  if (!pending.held) return;
  let resumed = false;
  try { resumed = pending.bus.routineCard?.closed(pending.threadId, pending.requestId, answer) === true; } catch { /* delivery never changes authority */ }
  // An event-limit Allow already raised the run's saved limit, which carries into the resumed turn: remembering it too would extend twice.
  if (resumed && answer === "allow" && !pending.allowKey.startsWith("event_limit:")) lateAllows.add(`${pending.threadId}\u0000${pending.allowKey}`);
}

/** The narrow grant "always allow" remembers for a peer comm. Mirrored
 * back into `bot.alwaysAllow` when the user picks "Always allow" on the
 * card. */
function allowKeyAllowed(from: BotRecord, allowKey: string): boolean {
  return from.alwaysAllow?.includes(allowKey) ?? false;
}

function pushApprovalCard(
  bus: ApprovalBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  action: PeerAction,
  requestId: string,
  sourceThreadId: string,
): Message {
  const subtitle = message.length > 200 ? `${message.slice(0, 200)}…` : message;
  const note = bus.store.appendMessage(sourceThreadId, murageLine({
    role: "bot",
    kind: "options",
    turnId: bus.turnOf?.(sourceThreadId),
    card: {
      title: `@${from.name} wants to ${action === "ask_bot" ? "contact" : "delegate to"} @${target.name}`,
      subtitle,
      options: ["Allow", "Deny", "Always allow"],
      requestId,
      tool: action,
      allowKey: peerAllowKey(action, target.id),
    },
  }));
  return note;
}

/** Ask the user (in the source task thread) whether `from` may `action` `target`.
 * Resolves with `"allow"`, the user's `"deny"` or `"cancelled"` (its bot or turn went away). If `from.alwaysAllow` already
 * covers the (action, target) pair, returns `"allow"` immediately
 * without a card. */
export function requestPeerApproval(
  bus: ApprovalBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  action: PeerAction,
  sourceThreadId = from.threadId,
  boundRequestId?: string,
  routineAuthority?: RoutinePeerSource,
): Promise<PeerApprovalOutcome> {
  if (!bus.unattended?.(sourceThreadId) && routineAuthority?.triggerSource !== "schedule" && allowKeyAllowed(from, peerAllowKey(action, target.id))) {
    return Promise.resolve("allow");
  }
  const late = `${sourceThreadId}\u0000${peerAllowKey(action, target.id)}`;
  if (lateAllows.delete(late)) return Promise.resolve("allow");
  return waitOnCard(bus, from.id, target.id, message, peerAllowKey(action, target.id), sourceThreadId, boundRequestId,
    (requestId) => pushApprovalCard(bus, from, target, message, action, requestId, sourceThreadId));
}

/** The one place a harness-native card is opened and awaited: the card has to
 * exist before the entry, so an answer or a cancel can always find it. */
function waitOnCard(
  bus: ApprovalBus,
  fromBotId: string,
  toBotId: string,
  message: string,
  allowKey: string,
  sourceThreadId: string,
  boundRequestId: string | undefined,
  push: (requestId: string) => Message,
): Promise<PeerApprovalOutcome> {
  return new Promise((resolve) => {
    const requestId = newId();
    const card = push(requestId);
    let held = false;
    try { held = bus.routineCard?.opened(sourceThreadId, requestId, card.card?.title ?? "A bot-to-bot contact") === true; } catch { /* delivery never changes authority */ }
    // The card waits for the owner until it is answered or its turn, bot or
    // request goes away (cards-wait 1.0.8, GROK-STOPPED F1): no expiry timer.
    // Bot-to-bot caller waits stay bounded where they wait, not here.
    pendingComms.set(requestId, {
      resolve,
      held,
      allowKey,
      requestId,
      fromBotId,
      toBotId,
      message,
      threadId: sourceThreadId,
      messageId: card.id,
      bus,
      ...(boundRequestId ? { boundRequestId } : {}),
    });
    try { bus.onApproval?.(fromBotId, sourceThreadId, requestId, card.id); } catch { /* Delivery never changes approval authority. */ }
  });
}

/** The two tools an event-run limit card carries. They are not peer contacts:
 * there is no "always allow" for them, so no allowKey rides on the card. */
export const EVENT_LIMIT_TOOLS = ["more_handoffs", "more_new_bots"] as const;

/** An event-started run (a channel message, a webhook, a routine) has reached
 * how many hand-offs or new bots it may do on its own. Ask the owner, in the
 * source thread, whether it may do another batch of that kind. "Allow" extends
 * the run by that batch; "Not now" ends that kind for the rest of the run; no
 * answer or a cancelled turn leaves it as it was. */
export function requestEventLimitApproval(
  bus: ApprovalBus,
  from: BotRecord,
  kind: "create" | "handoff",
  done: number,
  eventId: string,
  sourceThreadId = from.threadId,
  targetName?: string,
  /** How many more Allow gives, and whether those are the last this run can ever do. */
  allowMore = 4,
  lastOnes = false,
): Promise<PeerApprovalOutcome> {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const more = allowMore;
  const last = lastOnes ? ", the last ones this run can do" : "";
  const title = kind === "handoff" ? `@${from.name} wants to hand off more work` : `@${from.name} wants to add more bots`;
  const body = kind === "handoff"
    ? `This run has handed off ${plural(done, "task", "tasks")}, the most it can without you. Next it wants to ask @${targetName ?? "another bot"}. Allow lets this run hand off up to ${more} more${last}. Not now stops hand-offs for the rest of this run. Work already handed off carries on.`
    : `This run has added ${plural(done, "bot", "bots")}, the most it can without you. Next it wants to add @${targetName ?? "another bot"}. Allow lets this run add up to ${more} more${last}. Not now stops new bots for the rest of this run.`;
  return waitOnCard(bus, from.id, from.id, title, `event_limit:${eventId}:${kind}`, sourceThreadId, undefined, (requestId) =>
    bus.store.appendMessage(sourceThreadId, murageLine({
      role: "bot",
      kind: "options",
      turnId: bus.turnOf?.(sourceThreadId),
      card: {
        title,
        subtitle: body,
        options: ["Allow", "Not now"],
        requestId,
        tool: kind === "handoff" ? "more_handoffs" : "more_new_bots",
      },
    })));
}

/** Called by the respond endpoints BEFORE forwarding to the provider
 * adapter. Returns true if the requestId belonged to a pending peer
 * approval (and resolves it); false if it was a provider request and
 * the endpoint should keep going. */
export function resolvePeerComms(
  _bus: ApprovalBus,
  requestId: string,
  behavior: string | undefined,
): boolean {
  const pending = pendingComms.get(requestId);
  if (!pending) return false;
  pendingComms.delete(requestId);
  const allow = behavior === "allow";
  settleCard(pending, allow ? "allow" : "deny", "user");
  closeHeld(pending, allow ? "allow" : "deny");
  pending.resolve(allow ? "allow" : "deny");
  return true;
}

/** The bus holds this request (a bot-to-bot contact card is waiting on
 * it): where its card lives and which bot asked, so the approval choke
 * point (server/grant-choke.ts, A13-FIX-DESIGN C1b) can prove the card's
 * "Always allow" names the asking bot's own request before it saves and
 * answers through resolvePeerComms. */
export function peerApprovalHolder(requestId: string): { threadId: string; fromBotId: string; allowKey: string } | undefined {
  const pending = pendingComms.get(requestId);
  return pending ? { threadId: pending.threadId, fromBotId: pending.fromBotId, allowKey: pending.allowKey } : undefined;
}

/** Drop every approval waiting on a bot that no longer exists (or is being
 * deleted), cancelling it so the caller's turn doesn't wait out the timeout. */
export function cancelPeerApprovalsFor(botId: string): void {
  for (const [requestId, pending] of [...pendingComms]) {
    if (pending.fromBotId !== botId && pending.toBotId !== botId) continue;
    pendingComms.delete(requestId);
    settleCard(pending, "deny", "system");
    closeHeld(pending, "none");
    pending.resolve("cancelled");
  }
}

/** Cancel every peer-communication approval owned by a thread whose turn was
 * interrupted. Patching the card alone is not enough: the in-memory promise
 * must resolve too, or the delegation queue waits on a card nobody can answer. */
export function cancelPeerApprovalsForThread(threadId: string): void {
  for (const [requestId, pending] of pendingComms) {
    if (pending.threadId !== threadId) continue;
    pendingComms.delete(requestId);
    settleCard(pending, "deny", "system");
    closeHeld(pending, "none");
    pending.resolve("cancelled");
  }
}

/** Cancel the card that decides one room request, wherever it waits: the
 *  request was stopped (sharing removed with Stop it now), so the owner can
 *  no longer answer it and nothing starts from a late answer. */
export function cancelPeerApprovalsForRequest(requestId: string): boolean {
  let cancelled = false;
  for (const [id, pending] of [...pendingComms]) {
    if (pending.boundRequestId !== requestId) continue;
    pendingComms.delete(id);
    settleCard(pending, "deny", "system");
    closeHeld(pending, "none");
    pending.resolve("cancelled");
    cancelled = true;
  }
  return cancelled;
}

/** Cards left on disk by a previous run can never be answered — their
 * in-memory approval died with the process. Settle them at boot so a
 * crashed run doesn't leave a thread with a permanently blocked composer.
 * Only the open cards are read (the open-card list, or a bounded rowid range),
 * never a transcript: a 48 GB history costs the same as an empty one. */
export const STALE_PEER_CARD_TOOLS = ["ask_bot", "delegate_bot", ...EVENT_LIMIT_TOOLS] as const;
export function dismissStalePeerCards(bus: ApprovalBus, range?: { after: number; upTo: number } | "indexed", owned?: ReadonlySet<string>): number {
  return dismissStaleToolCards(bus, STALE_PEER_CARD_TOOLS, (card) => !card.requestId || pendingComms.has(card.requestId), range, owned);
}
/** A kind of card a dead run leaves open: the tools it carries and which of them are still answerable (kept). */
export interface StaleCardKind { tools: readonly string[]; keep: (card: NonNullable<Message["card"]>) => boolean }
export function stalePeerCardKind(): StaleCardKind {
  return { tools: STALE_PEER_CARD_TOOLS, keep: (card) => !card.requestId || pendingComms.has(card.requestId) };
}
/** One page of the open-card list (openToolCardPage), every kind settled from it at once: the cards of a dead run are dismissed, as dismissStaleToolCards
 * does. `next` is where the following page starts (null: the list is done); null as a whole while the list is not complete. */
export function settleStaleCardPage(bus: ApprovalBus, kinds: readonly StaleCardKind[], after: OpenCardKey | null, limit: number, upTo: number, ownedThreads?: ReadonlySet<string>): { dismissed: number; next: OpenCardKey | null } | null {
  const tools = kinds.flatMap((kind) => [...kind.tools]);
  const page = openToolCardPage(tools, after, limit, upTo);
  if (!page) return null;
  const owned = ownedThreads ?? ownedCardThreads(bus);
  let dismissed = 0;
  for (const { threadId, message } of page.rows) {
    const card = message.card;
    const kind = kinds.find((candidate) => candidate.tools.includes(String(card?.tool)));
    if (!card || !kind || !owned.has(threadId) || card.answered || card.dismissed || kind.keep(card)) continue;
    if (bus.store.patchMessagePoint(threadId, message.id, { card: { ...card, answered: "unavailable", dismissed: true } })) dismissed += 1;
  }
  return { dismissed, next: page.next };
}
/** Rows of the open-card list one page reads. */
export const STALE_CARD_PAGE = 2_000;
/** The rest of the open-card list after `after` (all of it from null), page by page with the loop handed back between pages, every kind settled up to
 * `upTo` (the start's high-water mark). The start uses it after listen: for what its page before listen did not reach, and as the explicit handoff
 * when the list was completed while the rowid sweep ran (the sweep stops there; the cards it had not reached are settled here, and dismissed, not
 * orphaned). Returns how many it dismissed; 0 while the list is not complete. */
export async function settleStaleCardsFromList(bus: ApprovalBus, kinds: readonly StaleCardKind[], after: OpenCardKey | null, upTo: number, ownedThreads?: ReadonlySet<string>, pause: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve))): Promise<number> {
  const owned = ownedThreads ?? ownedCardThreads(bus);
  let dismissed = 0;
  for (let at: OpenCardKey | null = after, first = true; first || at !== null; first = false) {
    const page = settleStaleCardPage(bus, kinds, at, STALE_CARD_PAGE, upTo, owned);
    if (!page) break;
    dismissed += page.dismissed;
    at = page.next;
    if (at !== null) await pause();
  }
  return dismissed;
}

/** Where the start's walk of the open-card list stands: undefined while the list is not complete (or from its start), otherwise the key the walk after
 * listen resumes from, null once the last page committed. */
export interface StaleCardMark { at: OpenCardKey | null | undefined }
/** settleStaleCardsFromList from `mark`, moving the mark past each page only once that page committed and to null only after the last one: a page that
 * throws (a held write lock) leaves the mark where the walk stood, so a retry carries on from there and never reads the walk as done. A list that is not
 * complete (no page) leaves the mark as it is. Returns how many it dismissed. */
export async function settleStaleCardsFromMark(bus: ApprovalBus, kinds: readonly StaleCardKind[], mark: StaleCardMark, upTo: number, ownedThreads?: ReadonlySet<string>, pause: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve))): Promise<number> {
  if (mark.at === null) return 0;
  const owned = ownedThreads ?? ownedCardThreads(bus);
  let dismissed = 0;
  for (;;) {
    const page = settleStaleCardPage(bus, kinds, mark.at ?? null, STALE_CARD_PAGE, upTo, owned);
    if (!page) return dismissed;
    dismissed += page.dismissed;
    mark.at = page.next;
    if (mark.at === null) return dismissed;
    await pause();
  }
}

/** Every thread a peer card can be pushed into: built once by a caller that settles several kinds of card, not once per kind. */
export function ownedCardThreads(bus: ApprovalBus): Set<string> {
  const owned = new Set<string>();
  for (const bot of bus.store.bots) {
    owned.add(bot.threadId);
    for (const task of bot.tasks ?? []) owned.add(task.threadId);
  }
  for (const group of bus.store.groups) {
    owned.add(group.threadId);
    for (const task of group.tasks ?? []) owned.add(task.threadId);
  }
  return owned;
}

/** Settle every open card of `tools` in a bot, task or room thread whose resolver is gone. `range` walks one slice of storage positions (the sweep that runs
 * after the server listens); "indexed" answers from the open-card list only (nothing while it is still being built: the sweep after listen covers it);
 * without it the list answers, or, while that list is still being built, the whole range in one go. */
export function dismissStaleToolCards(bus: ApprovalBus, tools: readonly string[], keep: (card: NonNullable<Message["card"]>) => boolean, range?: { after: number; upTo: number } | "indexed", ownedThreads?: ReadonlySet<string>): number {
  // Every thread a peer card can be pushed into. Rooms are included because
  // a Chief's peer call is made FROM a room thread, and that card is where
  // the room's composer stays blocked until something settles it.
  const owned = ownedThreads ?? ownedCardThreads(bus);
  const hits = range === "indexed" ? (openToolCardRowsIndexed(tools) ?? [])
    : range ? openToolCardRowsInRange(tools, range.after, range.upTo)
      : (openToolCardRowsIndexed(tools) ?? openToolCardRowsInRange(tools, 0, messagesHighWater()));
  let dismissed = 0;
  for (const { threadId, message } of hits) {
    const card = message.card;
    if (!card || !owned.has(threadId) || card.answered || card.dismissed || keep(card)) continue;
    if (bus.store.patchMessagePoint(threadId, message.id, { card: { ...card, answered: "unavailable", dismissed: true } })) dismissed += 1;
  }
  return dismissed;
}
