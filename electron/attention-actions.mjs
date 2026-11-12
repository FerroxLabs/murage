// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One action function for every outside surface (NOTIFY-EVERYWHERE-1019 section 5.2, S4a). Banners, the tray menu, the flyout,
// the pill, the bubble and the dock all call `act(token, action, replyText)`. A token is the only identity an OS callback carries:
// 128 bits of randomness minted when a surface shows an item, single use, held in memory, bounded at 1024. Effects (the card read, the
// POST, the lock state, what to do on a refusal) are injected, so this file is pure and tests with fakes. It never calls the server
// itself: the transport captured at mint time does, so a profile switch, an old server run or a swapped Cloud window can never receive
// the answer.
import { randomBytes } from "node:crypto";

export const MAX_TOKENS = 1024;
const ACTIONS = new Set(["allow", "deny", "reply"]);

/** The owner's reply: control characters except the line break stripped, trimmed, 1..2000 characters; otherwise null (nothing is sent). */
export function cleanReply(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "").trim();
  return text.length >= 1 && text.length <= 2000 ? text : null;
}

/**
 * deps: { lock: {locked()}, onRefuse(entry, reason), log(line) }.
 * A minted entry: { home, epoch, threadId, messageId, requestId, digest, surfaceId, surface, identity, transport, windowId? }, where
 * transport = { current() -> identity, readCard(entry, guard) -> {open, requestId, outsideOk:{[surface]:boolean}, digest}, post(body, guard, entry) -> {ok, status?, code?} };
 * `guard()` throws when the token died, the screen locked (Allow and Reply) or the live identity moved; a transport MUST call it right before every network send.
 */
export function createAttentionActions({ lock, onRefuse = () => {}, log = () => {} }) {
  const tokens = new Map();
  const inflight = new Map();

  const refuse = (entry, reason) => {
    // Ids only, never card content.
    try { log(`attention: refused ${reason} home=${entry.home} thread=${entry.threadId} request=${entry.requestId} surface=${entry.surface}`); } catch { /* logging never throws */ }
    try { onRefuse(entry, reason); } catch { /* the refusal path never breaks the action path */ }
    return { ok: false, reason };
  };

  return {
    mint(entry) {
      const token = randomBytes(16).toString("hex");
      tokens.set(token, { ...entry, token, dead: false });
      while (tokens.size > MAX_TOKENS) {
        const oldest = tokens.keys().next().value;
        const gone = tokens.get(oldest); if (gone) gone.dead = true;
        tokens.delete(oldest);
      }
      return token;
    },
    /** Lock, suspend, server restart or recovery, data-owner change, Cloud disconnect or window replacement, previews change. */
    invalidateAll(_reason) {
      for (const entry of tokens.values()) entry.dead = true;
      for (const entry of inflight.values()) entry.dead = true;
      tokens.clear();
    },
    /** A rebuilt tray menu spends the previous build's tokens. */
    invalidateSurface(surfaceId) {
      for (const [token, entry] of tokens) if (entry.surfaceId === surfaceId) { entry.dead = true; tokens.delete(token); }
      for (const entry of inflight.values()) if (entry.surfaceId === surfaceId) entry.dead = true;
    },
    get size() { return tokens.size; },
    async act(token, action, replyText, context = {}) {
      const entry = typeof token === "string" ? tokens.get(token) : undefined;
      if (!entry) return { ok: false, reason: "unknown" };
      tokens.delete(token); // single use: a recognised token is spent by its first call, whatever happens next
      if (entry.windowId !== undefined && context.windowId !== entry.windowId) return refuse(entry, "window");
      if (!ACTIONS.has(action)) return refuse(entry, "action");
      const message = action === "reply" ? cleanReply(replyText) : undefined;
      if (action === "reply" && message === null) return refuse(entry, "empty");
      const needsUnlock = action === "allow" || action === "reply";
      if (needsUnlock && lock.locked()) return refuse(entry, "locked");
      if (entry.dead) return refuse(entry, "invalidated");
      const key = `${entry.home}|${entry.approvalId}|${entry.threadId}|${entry.requestId}`;
      if (inflight.has(key)) return { ok: false, reason: "in-flight" };
      inflight.set(key, entry);
      // The synchronous guard goes to the captured transport, which calls it immediately before EVERY network send (for Cloud:
      // fetchHome's beforeSend, so the first send, the 401 refresh retry and the step-up retry are each re-checked). A throw stops
      // that send. Deny does not need the screen unlocked; nothing else is skipped for it.
      const guard = () => {
        if (entry.dead) throw Object.assign(new Error("invalidated"), { guardReason: "invalidated" });
        if (needsUnlock && lock.locked()) throw Object.assign(new Error("locked"), { guardReason: "locked" });
        if (entry.transport.current() !== entry.identity) throw Object.assign(new Error("transport"), { guardReason: "transport" });
      };
      try {
        let card;
        try { card = await entry.transport.readCard(entry, guard); } catch (error) { return refuse(entry, error?.guardReason ?? "read"); }
        if (entry.dead) return refuse(entry, "invalidated");
        if (!entry.approvalId || card?.approvalId!==entry.approvalId || card.requestRef!==entry.requestRef || card.actionHash!==entry.actionHash || !card || card.open !== true || card.requestId !== entry.requestId || card.outsideOk?.[entry.surface] !== true || card.digest !== entry.digest) return refuse(entry, "card");
        // Synchronously, immediately before dispatch: nothing awaits between these checks and the post call.
        if (entry.dead) return refuse(entry, "invalidated");
        if (needsUnlock && lock.locked()) return refuse(entry, "locked");
        if (entry.transport.current() !== entry.identity) return refuse(entry, "transport");
        const body = { approvalId:entry.approvalId,requestRef:entry.requestRef,actionHash:entry.actionHash,requestId: entry.requestId, behavior: action === "allow" ? "allow" : "deny", ...(message ? { message } : {}), outside: { digest: entry.digest, surface: entry.surface } };
        let result;
        try { result = await entry.transport.post(body, guard, entry); } catch (error) { return refuse(entry, error?.guardReason ?? "post"); }
        if (!result || result.ok !== true) return refuse(entry, `server-${Number.isInteger(result?.status) ? result.status : "error"}`);
        return { ok: true };
      } finally { inflight.delete(key); }
    },
  };
}
