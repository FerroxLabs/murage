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
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import type { BotRecord, Message, Store } from "./store.ts";

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
  onApproval?: (botId: string, threadId: string, requestId: string, messageId: string) => void;
  /** Is this bot's conversation still on Full access? Consulted only for a
   * handoff that was queued from a Full access turn the owner started. */
  fullAccessStanding?: (botId: string, threadId: string) => boolean;
  /** A scheduled or manual routine run owns the thread. `opened` says so
   * (true: the card is held open, with no 15-minute expiry, and the run waits
   * on the owner); `closed` reports the answer and says whether the run's
   * turn had already ended (true: the run carries on in a new turn). */
  routineCard?: RoutineCardHooks;
}

export interface RoutineCardHooks {
  opened: (threadId: string, requestId: string, summary: string) => boolean;
  closed: (threadId: string, requestId: string, answer: "allow" | "deny" | "none") => boolean;
}

interface Pending {
  resolve: (result: PeerApprovalOutcome) => void;
  /** Frees the requestId if the user never answers. None while a routine run
   * holds the card. */
  timer?: ReturnType<typeof setTimeout>;
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
}

/** Mark the card answered so the UI stops treating it as pending. Mirrors
 * what the `request.resolved` fold does for provider cards; a harness-native
 * card never emits that event, so it has to settle itself. */
function settleCard(pending: Pending, behavior: string, source: "user" | "system"): void {
  const existing = pending.bus.store
    .messagesFor(pending.threadId)
    .find((m) => m.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  pending.bus.store.patchMessage(pending.threadId, pending.messageId, {
    card: { ...existing.card, answered: behavior, dismissed: source !== "user" },
  });
}

/** requestId → pending ask. Lives only in memory — restarting the
 * server cancels every in-flight approval, like provider permissions do. */
const pendingComms = new Map<string, Pending>();

const APPROVAL_TIMEOUT_MS = 15 * 60_000;

/** An allow the owner gave after the routine run's turn had ended: the run
 * carries on in a new turn, and its same contact is not asked twice. Used
 * once. `threadId\u0000allowKey`. */
const lateAllows = new Set<string>();

function closeHeld(pending: Pending, answer: "allow" | "deny" | "none"): void {
  if (!pending.held) return;
  let resumed = false;
  try { resumed = pending.bus.routineCard?.closed(pending.threadId, pending.requestId, answer) === true; } catch { /* delivery never changes authority */ }
  if (resumed && answer === "allow") lateAllows.add(`${pending.threadId}\u0000${pending.allowKey}`);
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
  const note = bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "options",
    card: {
      title: `@${from.name} wants to ${action === "ask_bot" ? "contact" : "delegate to"} @${target.name}`,
      subtitle,
      options: ["Allow", "Deny", "Always allow"],
      requestId,
      tool: action,
      allowKey: peerAllowKey(action, target.id),
    },
  });
  return note;
}

/** Ask the user (in the source task thread) whether `from` may `action` `target`.
 * Resolves with `"allow"`, the user's `"deny"`, `"expired"` (nobody answered)
 * or `"cancelled"` (its bot or turn went away). If `from.alwaysAllow` already
 * covers the (action, target) pair, returns `"allow"` immediately
 * without a card. */
export function requestPeerApproval(
  bus: ApprovalBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  action: PeerAction,
  sourceThreadId = from.threadId,
): Promise<PeerApprovalOutcome> {
  if (allowKeyAllowed(from, peerAllowKey(action, target.id))) {
    return Promise.resolve("allow");
  }
  const late = `${sourceThreadId}\u0000${peerAllowKey(action, target.id)}`;
  if (lateAllows.delete(late)) return Promise.resolve("allow");
  return new Promise((resolve) => {
    const requestId = newId();
    // the card has to exist before the entry, so a timeout or an answer can
    // always find it to settle
    const card = pushApprovalCard(bus, from, target, message, action, requestId, sourceThreadId);
    let held = false;
    try { held = bus.routineCard?.opened(sourceThreadId, requestId, card.card?.title ?? "A bot-to-bot contact") === true; } catch { /* delivery never changes authority */ }
    const timer = held ? undefined : setTimeout(() => {
      // 15 minutes without an answer → expired. Keeps an unattended bot from
      // stalling its own turn forever (matches the Claude broker timeout).
      const pending = pendingComms.get(requestId);
      if (!pending) return;
      pendingComms.delete(requestId);
      settleCard(pending, "deny", "system");
      resolve("expired");
    }, APPROVAL_TIMEOUT_MS);
    timer?.unref?.(); // a waiting card must never hold the process open
    pendingComms.set(requestId, {
      resolve,
      timer,
      held,
      allowKey: peerAllowKey(action, target.id),
      requestId,
      fromBotId: from.id,
      toBotId: target.id,
      message,
      threadId: sourceThreadId,
      messageId: card.id,
      bus,
    });
    try { bus.onApproval?.(from.id, sourceThreadId, requestId, card.id); } catch { /* Delivery never changes approval authority. */ }
  });
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
  clearTimeout(pending.timer);
  const allow = behavior === "allow";
  settleCard(pending, allow ? "allow" : "deny", "user");
  closeHeld(pending, allow ? "allow" : "deny");
  pending.resolve(allow ? "allow" : "deny");
  return true;
}

/** Drop every approval waiting on a bot that no longer exists (or is being
 * deleted), cancelling it so the caller's turn doesn't wait out the timeout. */
export function cancelPeerApprovalsFor(botId: string): void {
  for (const [requestId, pending] of [...pendingComms]) {
    if (pending.fromBotId !== botId && pending.toBotId !== botId) continue;
    pendingComms.delete(requestId);
    clearTimeout(pending.timer);
    settleCard(pending, "deny", "system");
    closeHeld(pending, "none");
    pending.resolve("cancelled");
  }
}

/** Cancel every peer-communication approval owned by a thread whose turn was
 * interrupted. Patching the card alone is not enough: the in-memory promise
 * must resolve too, or the delegation queue waits until its 15-minute timer. */
export function cancelPeerApprovalsForThread(threadId: string): void {
  for (const [requestId, pending] of pendingComms) {
    if (pending.threadId !== threadId) continue;
    pendingComms.delete(requestId);
    clearTimeout(pending.timer);
    settleCard(pending, "deny", "system");
    closeHeld(pending, "none");
    pending.resolve("cancelled");
  }
}

/** Cards left on disk by a previous run can never be answered — their
 * in-memory approval died with the process. Settle them at boot so a
 * crashed run doesn't leave a thread with a permanently blocked composer. */
export function dismissStalePeerCards(bus: ApprovalBus): number {
  let dismissed = 0;
  // Every thread a peer card can be pushed into. Rooms are included because
  // a Chief's peer call is made FROM a room thread, and that card is where
  // the room's composer stays blocked until something settles it — a sweep
  // over each bot's own threads alone can never reach it.
  const threadIds = new Set<string>();
  for (const bot of bus.store.bots) {
    threadIds.add(bot.threadId);
    for (const task of bot.tasks ?? []) threadIds.add(task.threadId);
  }
  for (const group of bus.store.groups) {
    threadIds.add(group.threadId);
    for (const task of group.tasks ?? []) threadIds.add(task.threadId);
  }
  for (const threadId of threadIds) {
    for (const message of bus.store.messagesFor(threadId)) {
      const card = message.card;
      if (!card?.requestId || card.answered || card.dismissed) continue;
      if (card.tool !== "ask_bot" && card.tool !== "delegate_bot") continue;
      if (pendingComms.has(card.requestId)) continue;
      const patched = bus.store.patchMessage(threadId, message.id, {
        card: { ...card, answered: "deny", dismissed: true },
      });
      if (patched) dismissed += 1;
    }
  }
  return dismissed;
}
