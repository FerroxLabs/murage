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
import { newId } from "./contracts.js";
import { peerAllowKey } from "./peer-approval-key.js";
export { peerAllowKey } from "./peer-approval-key.js";
/** Mark the card answered so the UI stops treating it as pending. Mirrors
 * what the `request.resolved` fold does for provider cards; a harness-native
 * card never emits that event, so it has to settle itself. */
function settleCard(pending, behavior, source) {
    const existing = pending.bus.store
        .messagesFor(pending.threadId)
        .find((m) => m.id === pending.messageId);
    if (!existing?.card || existing.card.answered)
        return;
    const patched = pending.bus.store.patchMessage(pending.threadId, pending.messageId, {
        card: { ...existing.card, answered: behavior, dismissed: source !== "user" },
    });
    if (patched) {
        pending.bus.broadcast({ kind: "message.patch", threadId: pending.threadId, message: patched });
    }
}
/** requestId → pending ask. Lives only in memory — restarting the
 * server cancels every in-flight approval, like provider permissions do. */
const pendingComms = new Map();
const APPROVAL_TIMEOUT_MS = 15 * 60_000;
/** The narrow grant "always allow" remembers for a peer comm. Mirrored
 * back into `bot.alwaysAllow` when the user picks "Always allow" on the
 * card. */
function allowKeyAllowed(from, allowKey) {
    return from.alwaysAllow?.includes(allowKey) ?? false;
}
function pushApprovalCard(bus, from, target, message, action, requestId, sourceThreadId) {
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
    bus.broadcast({ kind: "message", threadId: sourceThreadId, message: note });
    return note;
}
/** Ask the user (in the source task thread) whether `from` may `action` `target`.
 * Resolves with `"allow"` or `"deny"`. If `from.alwaysAllow` already
 * covers the (action, target) pair, returns `"allow"` immediately
 * without a card. */
export function requestPeerApproval(bus, from, target, message, action, sourceThreadId = from.threadId) {
    if (allowKeyAllowed(from, peerAllowKey(action, target.id))) {
        return Promise.resolve("allow");
    }
    return new Promise((resolve) => {
        const requestId = newId();
        // the card has to exist before the entry, so a timeout or an answer can
        // always find it to settle
        const card = pushApprovalCard(bus, from, target, message, action, requestId, sourceThreadId);
        const timer = setTimeout(() => {
            // 15 minutes without an answer → deny. Keeps an unattended bot from
            // stalling its own turn forever (matches the Claude broker timeout).
            const pending = pendingComms.get(requestId);
            if (!pending)
                return;
            pendingComms.delete(requestId);
            settleCard(pending, "deny", "system");
            resolve("deny");
        }, APPROVAL_TIMEOUT_MS);
        timer.unref?.(); // a waiting card must never hold the process open
        pendingComms.set(requestId, {
            resolve,
            timer,
            fromBotId: from.id,
            toBotId: target.id,
            message,
            threadId: sourceThreadId,
            messageId: card.id,
            bus,
        });
    });
}
/** Called by the respond endpoints BEFORE forwarding to the provider
 * adapter. Returns true if the requestId belonged to a pending peer
 * approval (and resolves it); false if it was a provider request and
 * the endpoint should keep going. */
export function resolvePeerComms(_bus, requestId, behavior) {
    const pending = pendingComms.get(requestId);
    if (!pending)
        return false;
    pendingComms.delete(requestId);
    clearTimeout(pending.timer);
    const allow = behavior === "allow";
    settleCard(pending, allow ? "allow" : "deny", "user");
    pending.resolve(allow ? "allow" : "deny");
    return true;
}
/** Drop every approval waiting on a bot that no longer exists (or is being
 * deleted), denying it so the caller's turn doesn't wait out the timeout. */
export function cancelPeerApprovalsFor(botId) {
    for (const [requestId, pending] of [...pendingComms]) {
        if (pending.fromBotId !== botId && pending.toBotId !== botId)
            continue;
        pendingComms.delete(requestId);
        clearTimeout(pending.timer);
        settleCard(pending, "deny", "system");
        pending.resolve("deny");
    }
}
/** Cards left on disk by a previous run can never be answered — their
 * in-memory approval died with the process. Settle them at boot so a
 * crashed run doesn't leave a thread with a permanently blocked composer. */
export function dismissStalePeerCards(bus) {
    let dismissed = 0;
    for (const bot of bus.store.bots) {
        const threadIds = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
        for (const threadId of threadIds) {
            for (const message of bus.store.messagesFor(threadId)) {
                const card = message.card;
                if (!card?.requestId || card.answered || card.dismissed)
                    continue;
                if (card.tool !== "ask_bot" && card.tool !== "delegate_bot")
                    continue;
                if (pendingComms.has(card.requestId))
                    continue;
                const patched = bus.store.patchMessage(threadId, message.id, {
                    card: { ...card, answered: "deny", dismissed: true },
                });
                if (patched) {
                    bus.broadcast({ kind: "message.patch", threadId, message: patched });
                    dismissed += 1;
                }
            }
        }
    }
    return dismissed;
}
