// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import { attentionDisplay } from "./attention-items.mjs";
import { OUTSIDE_SURFACES } from "../shared/outside-limits.mjs";

const refused = reason => ({ ok: false, reason });
const textOf = value => typeof value === "string" ? value : "";
const list = value => Array.isArray(value) ? value : [];
const message = value => {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "").trim();
  return text.length >= 1 && text.length <= 4000 ? text : null;
};

/** Handlers for createAttentionIpc.install. readItems(kind) returns
 * itemsFromAttention(...); transportFor(entry, info) returns a captured action
 * transport. surfaceFor maps popover/popup to flyout. All raw identities stay
 * here. Send effects accept (text, info), never renderer-supplied bot ids:
 * sendToChief MUST resolve only the home's Chief direct thread; sendToPinned
 * MUST resolve the configured pinned bot. Send/pause effects throw on failure
 * or return {ok:false}; their route responses never cross back to the window.
 * openTarget receives a main-only target.
 * floatWindows supplies readState/setExpanded/hideForAnHour for bubble/dock;
 * their idle Open target is {kind:"bot", botId}, scoped to the current home.
 * Ordering rule: authority (surfaceId, action and Open tokens) is retired when a read
 * starts or on any invalidation; continuity (card ids, bot keys) is written only when a
 * read commits, and a read that is superseded or discarded changes neither. A commit
 * carries a host-wide strictly increasing rev.
 * invalidateWindow(id, {retainBotKeys:true, retainCards:true}) retires the tokens while
 * preserving inert avatar keys and the opaque card ids (a pushed refresh keeps a Reply
 * draft). An items() read in flight then returns {ok:false, reason:"superseded"}: the
 * caller must read again. The default form (privacy, home change, unregister, teardown)
 * discards all state; an in-flight read then returns reason:"discarded".
 * On unregister/privacy or home change call invalidateWindow(windowId).
 * For pill only, readItems may include pill:{state,count}. pillExpand(id,bool)
 * resizes the panel and pushes a change; pillFocus(id,bool=true) toggles typing
 * without activating it. These are synchronous main-only effects, invoked by
 * one-use capabilities on the existing Open channel. replyTyping defaults off.
 */
export function createAttentionWindowHost({ actions, transportFor, readItems, openTarget, sendToChief, pauseAutomations, sendToPinned, surfaceFor, floatWindows,
  replyTyping = false, pillFocus, pillExpand, log = () => {} }) {
  const windows = new Map(), opens = new Map();
  let generation = 0;
  // Retire authority only. Continuity (cards, botKeys) is never touched here.
  const retire = (record, windowId) => {
    if (record.surfaceId) actions.invalidateSurface(record.surfaceId);
    record.surfaceId = null;
    for (const [token, entry] of opens) if (entry.windowId === windowId) opens.delete(token);
  };
  const invalidateWindow = (windowId, { retainBotKeys = false, retainCards = false } = {}) => {
    const record = windows.get(windowId);
    if (!record) { for (const [token, entry] of opens) if (entry.windowId === windowId) opens.delete(token); return; }
    retire(record, windowId);
    record.seq += 1;
    if (!retainBotKeys && !retainCards) { windows.delete(windowId); return; }
    // Same record object: an in-flight read is superseded (re-read), not discarded.
    if (!retainBotKeys) record.botKeys = new Map();
    if (!retainCards) record.cards = new Map();
  };
  const mintOpen = (info, state, target) => {
    const token = randomBytes(16).toString("hex");
    opens.set(token, { windowId: info.windowId, state, target });
    while (opens.size > 1024) opens.delete(opens.keys().next().value);
    return token;
  };
  const send = async (effect, info, value) => {
    const text = message(value);
    if (text === null || typeof effect !== "function") return refused("args");
    const result = await effect(text, info);
    return result?.ok === false ? refused("refused") : { ok: true };
  };
  return {
    invalidateWindow,
    async items(info) {
      let record = windows.get(info.windowId);
      if (!record) { record = { cards: new Map(), botKeys: new Map(), surfaceId: null, seq: 0 }; windows.set(info.windowId, record); }
      retire(record, info.windowId);
      const mySeq = ++record.seq;
      const data = await readItems(info.kind);
      // A read that is no longer current changes nothing: no tokens, no card ids.
      if (windows.get(info.windowId) !== record) return refused("discarded");
      if (record.seq !== mySeq) return refused("superseded");
      const floating = info.kind === "bubble" || info.kind === "dock";
      const floatState = floating ? floatWindows?.readState(info) : null;
      if (floating && !floatState) { invalidateWindow(info.windowId); return refused("hidden"); }
      const previousCards = record.cards, nextCards = new Map(), nextBotKeys = new Map();
      const surfaceId = `attention-window:${info.windowId}:${++generation}`;
      const state = { record, surfaceId };
      if (floating) for (const bot of floatState.bots) nextBotKeys.set(bot.botId, record.botKeys.get(bot.botId) ?? randomBytes(16).toString("hex"));
      const surface = surfaceFor(info.kind), previews = data?.previews === true;
      const entries = list(data?.items).slice(0, 100).filter(entry => entry && entry.threadId && entry.messageId &&
        (!floating || floatState.bots.some(bot => bot.botId === entry.botId)));
      const items = entries.map(entry => {
        const display = previews ? attentionDisplay(entry.display) : null;
        // Renderer identity is separate from single-use authority. Keep raw
        // request identity here and forget continuity when previews disappear.
        const identity = JSON.stringify([entry.home, entry.epoch, entry.threadId, entry.messageId, entry.requestId, entry.digest, entry.botId, display, entry.level]);
        const cardId = (display && previousCards.get(identity)) || randomBytes(16).toString("hex");
        if (display) nextCards.set(identity, cardId);
        const target = { kind: entry.reconnectIncidentId ? "connector" : "approval", home: entry.home, threadId: entry.threadId, messageId: entry.messageId, ...(entry.reconnectIncidentId ? { reconnectIncidentId: entry.reconnectIncidentId } : {}), ...(entry.botId ? { botId: entry.botId } : {}) };
        const openToken = mintOpen(info, state, target);
        let actionToken;
        if (!entry.reconnectIncidentId && entry.kind !== "question" && previews && display && OUTSIDE_SURFACES.includes(surface) && entry.outsideOk?.[surface] === true && /^[0-9a-f]{64}$/.test(entry.digest ?? "") && entry.requestId && entry.home && entry.epoch) {
          try {
            const transport = transportFor(entry, info);
            const identity = transport?.current();
            if (identity !== undefined && identity !== null) {
              // attention-actions.mjs takes a flat entry, not { entry: ... }.
              actionToken = actions.mint({ ...entry, transport, identity, surface, surfaceId, digest: entry.digest, windowId: info.windowId });
            }
          } catch { try { log(`attention-window: transport unavailable window=${info.windowId}`); } catch {} }
        }
        const replyFocusToken = info.kind === "pill" && actionToken && replyTyping && typeof pillFocus === "function"
          ? mintOpen(info, state, { kind: "pill-reply" }) : null;
        return { cardId, display, level: previews ? textOf(entry.level) : "", openToken, ...(actionToken ? { actionToken } : {}),
          ...(replyFocusToken ? { replyFocusToken } : {}) };
      });
      // Commit continuity and the new authority together, synchronously.
      record.cards = nextCards; record.botKeys = nextBotKeys; record.surfaceId = surfaceId;
      return { ok: true, rev: generation, items,
        openToken: mintOpen(info, state, { kind: "app" }),
        running: previews && !floating ? list(data?.running).filter(Boolean).map(row => ({ botName: textOf(row.botName), doing: textOf(row.doing) })) : [],
        receipts: previews && !floating ? list(data?.receipts).filter(Boolean).slice(info.kind === "pill" ? -100 : -3).map(row => ({ text: textOf(row.text) })) : [],
        chief: data?.chief && !floating ? { name: previews ? textOf(data.chief.name) : "" } : null,
        ...(floating ? { bots: floatState.bots.map(bot => ({
          key: nextBotKeys.get(bot.botId), name: previews ? textOf(bot.name) : "", state: bot.state,
          openToken: mintOpen(info, state, { kind: "bot", botId: bot.botId }),
          item: items[entries.findIndex(entry => entry.botId === bot.botId)] ?? null,
        })) } : {}),
        ...(info.kind === "pill" ? { pill: {
          state: ["collapsed", "expanded", "stacked", "finished"].includes(data?.pill?.state) ? data.pill.state : "hidden",
          count: Number.isInteger(data?.pill?.count) ? Math.max(0, Math.min(100, data.pill.count)) : 0,
          toggleToken: mintOpen(info, state, { kind: "pill-expand", expanded: !["expanded", "stacked"].includes(data?.pill?.state) }),
        } } : {}),
      };
    },
    async act(info, token, action, text) {
      try { return await actions.act(token, action, text, { windowId: info.windowId }); }
      finally { if (info.kind === "pill") pillFocus?.(info.windowId, false); }
    },
    async open(info, token) {
      const entry = opens.get(token);
      if (!entry) return refused("unknown");
      opens.delete(token);
      const current = windows.get(info.windowId);
      if (entry.windowId !== info.windowId || !current || current !== entry.state.record || current.surfaceId !== entry.state.surfaceId) return refused("window");
      // One-use capabilities on the existing, gated Open channel. These never
      // carry renderer-selected window ids and never dispatch an answer.
      if (entry.target.kind === "pill-reply") return info.kind === "pill" && replyTyping && pillFocus?.(info.windowId) === true ? { ok: true } : refused("focus");
      if (entry.target.kind === "pill-expand") return info.kind === "pill" && pillExpand?.(info.windowId, entry.target.expanded) === true ? { ok: true } : refused("window");
      if (info.kind === "pill") pillFocus?.(info.windowId, false);
      await openTarget(entry.target);
      return { ok: true };
    },
    sendToChief: (info, text) => send(sendToChief, info, text),
    sendToPinned: (info, text) => floatWindows && !floatWindows.readState(info) ? refused("hidden") : send(sendToPinned, info, text),
    hideForAnHour: info => floatWindows?.readState(info) ? floatWindows.hideForAnHour(info.kind) : refused("hidden"),
    setExpanded: (info, expanded) => floatWindows?.setExpanded(info, expanded) ?? refused("hidden"),
    async pauseAutomations(info) {
      const result = await pauseAutomations(info);
      return result?.ok === false ? refused("refused") : { ok: true };
    },
  };
}
