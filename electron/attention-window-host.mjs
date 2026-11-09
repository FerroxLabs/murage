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
 * invalidateWindow(id, {retainBotKeys:true, retainCards:true}) retires the tokens while preserving
 * inert avatar keys and the opaque card ids (a pushed refresh keeps a Reply draft; privacy changes pass neither). Unregister/privacy uses the default to discard all state.
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
  const invalidateWindow = (windowId, { retainBotKeys = false, retainCards = false } = {}) => {
    const previous = windows.get(windowId);
    if (previous?.surfaceId) actions.invalidateSurface(previous.surfaceId);
    if ((retainBotKeys || retainCards) && previous) windows.set(windowId, { ...(retainBotKeys ? { botKeys: previous.botKeys } : {}), ...(retainCards ? { cards: previous.cards } : {}) });
    else windows.delete(windowId);
    for (const [token, entry] of opens) if (entry.windowId === windowId) opens.delete(token);
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
      const previousCards = windows.get(info.windowId)?.cards;
      const botKeys = windows.get(info.windowId)?.botKeys ?? new Map();
      invalidateWindow(info.windowId);
      const state = { surfaceId: `attention-window:${info.windowId}:${++generation}`, cards: new Map(), botKeys };
      windows.set(info.windowId, state);
      const data = await readItems(info.kind);
      if (windows.get(info.windowId) !== state) return refused("superseded");
      const floating = info.kind === "bubble" || info.kind === "dock";
      const floatState = floating ? floatWindows?.readState(info) : null;
      if (floating && !floatState) { invalidateWindow(info.windowId); return refused("hidden"); }
      if (floating) {
        for (const id of botKeys.keys()) if (!floatState.bots.some(bot => bot.botId === id)) botKeys.delete(id);
        for (const bot of floatState.bots) if (!botKeys.has(bot.botId)) botKeys.set(bot.botId, randomBytes(16).toString("hex"));
      }
      const surface = surfaceFor(info.kind), previews = data?.previews === true;
      const entries = list(data?.items).slice(0, 100).filter(entry => entry && entry.threadId && entry.messageId &&
        (!floating || floatState.bots.some(bot => bot.botId === entry.botId)));
      const items = entries.map(entry => {
        const display = previews ? attentionDisplay(entry.display) : null;
        // Renderer identity is separate from single-use authority. Keep raw
        // request identity here and forget continuity when previews disappear.
        const identity = JSON.stringify([entry.home, entry.epoch, entry.threadId, entry.messageId, entry.requestId, entry.digest, entry.botId, display, entry.level]);
        const cardId = (display && previousCards?.get(identity)) || randomBytes(16).toString("hex");
        if (display) state.cards.set(identity, cardId);
        const target = { kind: "approval", home: entry.home, threadId: entry.threadId, messageId: entry.messageId, ...(entry.botId ? { botId: entry.botId } : {}) };
        const openToken = mintOpen(info, state, target);
        let actionToken;
        if (entry.kind !== "question" && previews && display && OUTSIDE_SURFACES.includes(surface) && entry.outsideOk?.[surface] === true && /^[0-9a-f]{64}$/.test(entry.digest ?? "") && entry.requestId && entry.home && entry.epoch) {
          try {
            const transport = transportFor(entry, info);
            const identity = transport?.current();
            if (identity !== undefined && identity !== null) {
              // attention-actions.mjs takes a flat entry, not { entry: ... }.
              actionToken = actions.mint({ ...entry, transport, identity, surface, surfaceId: state.surfaceId, digest: entry.digest, windowId: info.windowId });
            }
          } catch { try { log(`attention-window: transport unavailable window=${info.windowId}`); } catch {} }
        }
        const replyFocusToken = info.kind === "pill" && actionToken && replyTyping && typeof pillFocus === "function"
          ? mintOpen(info, state, { kind: "pill-reply" }) : null;
        return { cardId, display, level: previews ? textOf(entry.level) : "", openToken, ...(actionToken ? { actionToken } : {}),
          ...(replyFocusToken ? { replyFocusToken } : {}) };
      });
      return { ok: true, items,
        openToken: mintOpen(info, state, { kind: "app" }),
        running: previews && !floating ? list(data?.running).filter(Boolean).map(row => ({ botName: textOf(row.botName), doing: textOf(row.doing) })) : [],
        receipts: previews && !floating ? list(data?.receipts).filter(Boolean).slice(info.kind === "pill" ? -100 : -3).map(row => ({ text: textOf(row.text) })) : [],
        chief: data?.chief && !floating ? { name: previews ? textOf(data.chief.name) : "" } : null,
        ...(info.kind === "pill" ? { pill: {
          state: ["collapsed", "expanded", "stacked", "finished"].includes(data?.pill?.state) ? data.pill.state : "hidden",
          count: Number.isInteger(data?.pill?.count) ? Math.max(0, Math.min(100, data.pill.count)) : 0,
          toggleToken: mintOpen(info, state, { kind: "pill-expand", expanded: !["expanded", "stacked"].includes(data?.pill?.state) }),
        } } : {}),
        ...(floating ? { bots: floatState.bots.map(bot => ({
          key: botKeys.get(bot.botId), name: previews ? textOf(bot.name) : "", state: bot.state,
          openToken: mintOpen(info, state, { kind: "bot", botId: bot.botId }),
          item: items[entries.findIndex(entry => entry.botId === bot.botId)] ?? null,
        })) } : {}),
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
      if (entry.windowId !== info.windowId || windows.get(info.windowId) !== entry.state) return refused("window");
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
