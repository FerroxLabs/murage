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
 * On unregister/privacy or home change call invalidateWindow(windowId).
 */
export function createAttentionWindowHost({ actions, transportFor, readItems, openTarget, sendToChief, pauseAutomations, sendToPinned, surfaceFor, log = () => {} }) {
  const windows = new Map(), opens = new Map();
  let generation = 0;
  const invalidateWindow = windowId => {
    const previous = windows.get(windowId);
    if (previous) actions.invalidateSurface(previous.surfaceId);
    windows.delete(windowId);
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
      invalidateWindow(info.windowId);
      const state = { surfaceId: `attention-window:${info.windowId}:${++generation}` };
      windows.set(info.windowId, state);
      const data = await readItems(info.kind);
      if (windows.get(info.windowId) !== state) return refused("superseded");
      const surface = surfaceFor(info.kind), previews = data?.previews === true;
      const items = list(data?.items).slice(0, 100).filter(entry => entry && entry.threadId && entry.messageId).map(entry => {
        const display = previews ? attentionDisplay(entry.display) : null;
        const target = { kind: "approval", home: entry.home, threadId: entry.threadId, messageId: entry.messageId, ...(entry.botId ? { botId: entry.botId } : {}) };
        const openToken = mintOpen(info, state, target);
        let actionToken;
        if (previews && display && OUTSIDE_SURFACES.includes(surface) && entry.outsideOk?.[surface] === true && /^[0-9a-f]{64}$/.test(entry.digest ?? "") && entry.requestId && entry.home && entry.epoch) {
          try {
            const transport = transportFor(entry, info);
            const identity = transport?.current();
            if (identity !== undefined && identity !== null) {
              // attention-actions.mjs takes a flat entry, not { entry: ... }.
              actionToken = actions.mint({ ...entry, transport, identity, surface, surfaceId: state.surfaceId, digest: entry.digest, windowId: info.windowId });
            }
          } catch { try { log(`attention-window: transport unavailable window=${info.windowId}`); } catch {} }
        }
        return { display, level: previews ? textOf(entry.level) : "", openToken, ...(actionToken ? { actionToken } : {}) };
      });
      return { ok: true, items,
        openToken: mintOpen(info, state, { kind: "app" }),
        running: previews ? list(data?.running).filter(Boolean).map(row => ({ botName: textOf(row.botName), doing: textOf(row.doing) })) : [],
        receipts: previews ? list(data?.receipts).filter(Boolean).slice(-3).map(row => ({ text: textOf(row.text) })) : [],
        chief: data?.chief ? { name: previews ? textOf(data.chief.name) : "" } : null,
      };
    },
    act: (info, token, action, text) => actions.act(token, action, text, { windowId: info.windowId }),
    async open(info, token) {
      const entry = opens.get(token);
      if (!entry) return refused("unknown");
      opens.delete(token);
      if (entry.windowId !== info.windowId || windows.get(info.windowId) !== entry.state) return refused("window");
      await openTarget(entry.target);
      return { ok: true };
    },
    sendToChief: (info, text) => send(sendToChief, info, text),
    sendToPinned: (info, text) => send(sendToPinned, info, text),
    async pauseAutomations(info) {
      const result = await pauseAutomations(info);
      return result?.ok === false ? refused("refused") : { ok: true };
    },
  };
}
