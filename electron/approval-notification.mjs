// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { randomBytes } from "node:crypto";
import { subscribeWindowsActivation } from "./windows-notification-activation.mjs";
export { createWindowsBanners } from "./windows-banners.mjs";
// Approval-only native presentation. OS sound settings and DND remain authoritative.
export const APPROVAL_SOUND = "murage-approval.wav";
const fields = new Set(["approvalId", "requestRef", "actionHash", "botId", "threadId", "requestId", "messageId", "requestTurnId", "title", "body", "silent"]);
const identity = value => typeof value === "string" && value.length > 0 && value.length <= 512 && /^[\w.:-]+$/.test(value);
export function approvalPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))) return null;
  if (![value.approvalId,value.requestRef,value.actionHash,value.botId, value.threadId, value.requestId, value.messageId].every(identity)) return null;
  if (value.requestTurnId !== undefined && !identity(value.requestTurnId)) return null;
  if (typeof value.title !== "string" || value.title.length > 300 || typeof value.body !== "string" || value.body.length > 1000) return null;
  if (value.silent !== undefined && typeof value.silent !== "boolean") return null;
  return { ...value };
}
const xml = value => value.replace(/[<>&"']/g, char => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;", "'":"&apos;" })[char]);
const activationPrefix = "murage-approval:";
const activationToken = value => typeof value === "string" && /^murage-approval:[a-f0-9]{32}$/.test(value);
/** `silent`: this computer muted notification sounds (upstream #1274). The
 *  banner still shows; only the sound is dropped. */
export function approvalOptions(payload, platform, launch, silent = false) {
  if (platform === "darwin") return silent
    ? { title: payload.title, body: payload.body, silent: true }
    : { title: payload.title, body: payload.body, sound: APPROVAL_SOUND, silent: false };
  if (platform === "win32" && launch !== undefined && !activationToken(launch)) return null;
  if (platform === "win32") return {
    toastXml: `<toast${launch ? ` launch="${xml(launch)}"` : ""}><visual><binding template="ToastGeneric"><text>${xml(payload.title)}</text><text>${xml(payload.body)}</text></binding></visual>${silent ? '<audio silent="true"/>' : '<audio src="ms-winsoundevent:Notification.Reminder" loop="false"/>'}</toast>`,
  };
  return null;
}

/** Bounded identities survive renderer remounts for this desktop launch.
 * Oldest of 1024 identities is evicted; SSE replay suppression is independent. */
export function createApprovalNotifications({ Notification, platform, onOpen, authorize, revalidate, limit = 1024 }) {
  // The ownership marker prevents an old cancellation from deleting a newer
  // reservation. Seen retains ids only, never payloads or native objects.
  const seen = new Map(), active = new Map(), pending = new Map();
  const pendingIdentities = new Map(), preparedSlots = new WeakMap(), routes = new Map();
  const capacity = Number.isSafeInteger(limit) && limit > 0 ? Math.max(1024, limit) : 1024;
  let activationRegistered = false, unsubscribeActivation, stopped = false, sequence = 0, onEvict;
  const releaseIdentity = slot => {
    if (seen.get(slot.identity) === slot.owner) seen.delete(slot.identity);
  };
  const forgetPending = slot => {
    if (pending.get(slot.key) === slot) pending.delete(slot.key);
    if (pendingIdentities.get(slot.identity) === slot) pendingIdentities.delete(slot.identity);
  };
  const current = slot => !stopped && pending.get(slot.key) === slot && slot.status === "pending";
  const reject = (slot, cancelled = false) => {
    if (slot.status !== "pending") return;
    slot.status = "ended";
    forgetPending(slot);
    if (cancelled || !slot.legacy) releaseIdentity(slot);
    slot.resolve({ ok: false });
  };
  const removeListeners = notice => {
    try { notice.removeAllListeners(); } catch { /* Continue withdrawing other notices. */ }
  };
  const closeActive = entry => {
    if (active.get(entry.key) !== entry || entry.closing) return false;
    // close() may synchronously emit failed or call back into close/dispose.
    entry.closing = true;
    try { entry.notice.close(); } catch { /* Still retire this activation route. */ }
    if (entry.token) routes.delete(entry.token);
    active.delete(entry.key);
    removeListeners(entry.notice);
    return true;
  };
  const registerActivation = () => {
    if (platform !== "win32" || activationRegistered) return;
    unsubscribeActivation = subscribeWindowsActivation(Notification, details => {
      if (stopped || details?.type !== "click" || !activationToken(details.arguments)) return;
      routes.get(details.arguments)?.();
    });
    activationRegistered = true;
  };
  const reserve = (input, key, onSlot) => {
    const payload = approvalPayload(input);
    if (!payload || stopped || typeof key !== "string" || !key || pending.has(key) || active.has(key)) return null;
    if (platform !== "darwin" && platform !== "win32") return null;
    const id = JSON.stringify([payload.approvalId,payload.actionHash,payload.botId, payload.threadId, payload.requestTurnId ?? "", payload.requestId]);
    if (seen.has(id) || pendingIdentities.has(id) || pending.size >= capacity) return null;
    const slot = { key, identity: id, owner: Symbol(), payload, status: "pending" };
    slot.promise = new Promise(resolve => { slot.resolve = resolve; });
    slot.cancel = () => reject(slot, true);
    seen.set(id, slot.owner);
    if (seen.size > 1024) seen.delete(seen.keys().next().value);
    pending.set(key, slot);
    pendingIdentities.set(id, slot);
    // Hand the caller its cancellation hook before any asynchronous work.
    try { onSlot?.({ cancel: slot.cancel }); } catch { slot.cancel(); }
    return slot;
  };
  const ready = (slot, payload) => {
    if (!current(slot)) return { ok: false };
    slot.prepared = { words: { title: payload.title, body: payload.body } };
    slot.display = payload;
    preparedSlots.set(slot.prepared, slot);
    const result = { ok: true, prepared: slot.prepared };
    slot.resolve(result);
    return result;
  };
  const prepare = slot => {
    if (!current(slot)) return slot.promise;
    if (platform === "win32" && typeof revalidate !== "function") {
      ready(slot, slot.payload);
    } else {
      void Promise.resolve().then(async () => {
        if (!current(slot)) return;
        if (platform === "darwin") {
          if (typeof authorize !== "function" || typeof revalidate !== "function") return reject(slot);
          const granted = await authorize();
          if (!current(slot)) return;
          if (granted !== true) return reject(slot);
        }
        // Re-read only this card's ids, and accept words only from that card.
        const payload = approvalPayload(await revalidate({ ...slot.payload }));
        if (!current(slot)) return;
        if (!payload || ["approvalId","requestRef","actionHash","botId", "threadId", "requestId", "messageId", "requestTurnId"].some(field => payload[field] !== slot.payload[field])) return reject(slot);
        if (platform === "darwin") {
          const stillGranted = await authorize(false);
          if (!current(slot)) return;
          if (stillGranted !== true) return reject(slot);
        }
        ready(slot, payload);
      }).catch(() => { if (current(slot)) reject(slot); });
    }
    return slot.promise;
  };
  const present = (prepared, { key, onFailed, onClick } = {}) => {
    const slot = preparedSlots.get(prepared);
    if (!slot || !current(slot) || slot.key !== key || slot.prepared !== prepared) return { accepted: false };
    slot.status = "presented";
    forgetPending(slot);
    preparedSlots.delete(prepared);
    const refused = () => {
      // Router attempts may retry with orphan words. Flag-off callers retain
      // their existing consumed-on-failure dedupe behavior.
      if (!slot.legacy) releaseIdentity(slot);
      return { accepted: false };
    };
    let entry;
    try {
      if (!Notification.isSupported()) return refused();
      registerActivation();
      const token = platform === "win32" ? activationPrefix + randomBytes(16).toString("hex") : undefined;
      // The local sound choice survives the server's privacy projection.
      const notice = new Notification(approvalOptions({ ...slot.display, title: prepared.words.title, body: prepared.words.body }, platform, token, slot.payload.silent === true));
      entry = { key, notice, token, closing: false };
      active.set(key, entry);
      let opened = false;
      const openOnce = () => {
        if (opened || stopped || entry.closing || active.get(key) !== entry || (token && !routes.has(token))) return;
        opened = true;
        if (token) routes.delete(token);
        const { botId, threadId, messageId, approvalId } = slot.payload;
        try {
          if (typeof onClick === "function") onClick();
          else onOpen({ botId, threadId, messageId, approvalId });
        } catch { /* Navigation failure never changes authority. */ }
      };
      if (token) routes.set(token, openOnce);
      notice.on("click", openOnce);
      // OS close (including a toast timeout) leaves ownership unchanged.
      notice.on("failed", () => {
        if (entry.closing || active.get(key) !== entry) return;
        active.delete(key);
        if (token) routes.delete(token);
        removeListeners(notice);
        try { onFailed?.(key); } catch { /* The route is already retired. */ }
      });
      while (active.size > capacity) {
        const oldest = active.values().next().value;
        if (!closeActive(oldest)) break;
        try { onEvict?.(oldest.key); } catch { /* The notice is already withdrawn. */ }
      }
      if (stopped || active.get(key) !== entry) return refused();
      notice.show();
      if (active.get(key) !== entry) return refused();
      return { accepted: true, handle: `n:${key}` };
    } catch {
      if (entry) closeActive(entry);
      return refused();
    }
  };
  // Keep flag-off callers' synchronous Windows reply and accepted-only shape.
  const show = input => {
    const key = `legacy|desktop|${++sequence}|1`, slot = reserve(input, key);
    if (!slot) return { accepted: false };
    slot.legacy = true;
    const commit = result => ({ accepted: result.ok ? present(result.prepared, { key }).accepted : false });
    if (platform === "win32") return commit(ready(slot, slot.payload));
    if (typeof authorize !== "function" || typeof revalidate !== "function") {
      reject(slot);
      return { accepted: false };
    }
    return prepare(slot).then(commit);
  };
  show.prepare = (input, { key, onSlot } = {}) => {
    const slot = reserve(input, key, onSlot);
    return slot ? prepare(slot) : Promise.resolve({ ok: false });
  };
  show.present = present;
  show.close = key => {
    const slot = pending.get(key);
    if (slot) slot.cancel();
    const entry = active.get(key);
    return (entry ? closeActive(entry) : false) || Boolean(slot);
  };
  show.setOnEvict = fn => { onEvict = typeof fn === "function" ? fn : undefined; };
  show.dispose = () => {
    stopped = true;
    unsubscribeActivation?.();
    for (const slot of pending.values()) slot.cancel();
    for (const entry of active.values()) closeActive(entry);
    routes.clear(); seen.clear();
  };
  return show;
}
