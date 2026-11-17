// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// NOTIFY-EVERYWHERE-1019 S3R rev 3.0, R2: the renderer session, an extension of A14 (electron/app-readiness.mjs), not a second owner.
//
// A14 keeps one record per webContents (ready / navigating / probing, epoch, defer queue). This module keeps a second, independent
// record per webContents for the notification delivery path: the bound `session` nonce, the `home`, the payload ledger (R4) and an
// `onEnd(webContentsId, session, record)` hook. It never reads or writes A14's state and never uses A14's queue: payloads and
// show / close / previews pushes are session-addressed and a push to a dead session is simply dropped (session end recovers the record).
//
// Ends a session (reported exactly once): a committed main-frame cross-document navigation (`did-navigate`; Electron does not emit it for
// pushState or hash routes), `render-process-gone`, `destroyed`, or a `hello` carrying a different nonce from the same webContents.
// Does NOT end it: same-document navigation, did-start-navigation, did-stop-loading, an ERR_ABORTED did-fail-load, an A14 `alive` ack,
// or a `hello` re-sent with the same nonce. Pure: no Electron import.
import { trustedTopFrame } from "./app-readiness.mjs";

export const SESSION_PATTERN = /^[a-z0-9]{16,64}$/;
const MAX_ENDED = 8;

/**
 * @param {{ origin: () => string | null | undefined, onEnd?: (webContentsId: number, session: string, record: object) => void }} deps
 */
export function createRendererSessions({ origin, onEnd } = {}) {
  // contents -> { bound: record | null, ended: Set<string> }
  const slots = new WeakMap();
  const live = new Map(); // session nonce -> record, for uniqueness across windows

  const end = (slot) => {
    const record = slot.bound;
    if (!record) return false;
    slot.bound = null;
    live.delete(record.session);
    slot.ended.add(record.session);
    if (slot.ended.size > MAX_ENDED) slot.ended.delete(slot.ended.values().next().value);
    record.alive = false;
    if (typeof onEnd === "function") {
      try { onEnd(record.webContentsId, record.session, record); } catch { /* the consumer must never break a navigation */ }
    }
    return true;
  };

  return {
    /** Start watching one window's webContents. Call it next to appReadiness.track. */
    track(contents) {
      if (!contents || typeof contents !== "object" || slots.has(contents)) return;
      const slot = { bound: null, ended: new Set() };
      slots.set(contents, slot);
      contents.on("did-navigate", () => { end(slot); });
      contents.on("render-process-gone", () => { end(slot); });
      contents.on("destroyed", () => { end(slot); });
    },

    /**
     * `attention:hello` / `cloud-attention:hello`. Accepted only from the top frame on the app origin (A14 sender trust), or with
     * the caller's registered Cloud sender proof (`trusted:true`). Binds
     * `session` to (webContents.id, home). A different nonce ends the old session first, then binds the new one. The same nonce is a
     * re-subscribe: the session continues and its home must not change. A nonce another live window holds, or one this window already
     * ended, is refused.
     * Returns { ok:true, record, started } or { ok:false }.
     */
    hello(contents, { session, home, top, url, trusted } = {}) {
      const slot = contents && typeof contents === "object" ? slots.get(contents) : undefined;
      if (!slot) return { ok: false };
      if (top !== true || (trusted !== true && !trustedTopFrame({ top, url, origin: origin?.() }))) return { ok: false };
      if (typeof session !== "string" || !SESSION_PATTERN.test(session)) return { ok: false };
      if (typeof home !== "string" || !home) return { ok: false };
      if (slot.bound && slot.bound.session === session) {
        if (slot.bound.home !== home) return { ok: false };
        return { ok: true, record: slot.bound, started: false };
      }
      if (slot.ended.has(session) || live.has(session)) return { ok: false };
      end(slot);
      const record = { session, home, webContentsId: contents.id, ledger: new Set(), alive: true };
      slot.bound = record;
      live.set(session, record);
      return { ok: true, record, started: true };
    },

    /** The record bound to this webContents, or null. */
    current(contents) {
      return (contents && typeof contents === "object" ? slots.get(contents)?.bound : null) ?? null;
    },

    /** Renderer to main calls: the record only when `session` is the bound session of that sender (and the sender is the trusted top frame). */
    check(contents, session, { top, url, trusted } = {}) {
      const record = this.current(contents);
      if (!record || record.session !== session) return null;
      if (top !== true || (trusted !== true && !trustedTopFrame({ top, url, origin: origin?.() }))) return null;
      return record;
    },

    /** Whether a session nonce is bound to a live document. */
    isLive(session) { return live.has(session); },
  };
}
