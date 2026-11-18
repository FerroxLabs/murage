// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 section 2.1 (S4b): the Mac adapter for actionable banners, written against the addon contract below so it
// tests with a fake. The ObjC++ side is native/notification-authorization (banners.mm, readiness.h), built ONLY on a Mac;
// until the addon exposes the first four functions `available()` is false and every caller keeps today's path (the Electron notification).
//
// Addon contract (all calls are on the main process):
//   registerCategories()                              one UNNotificationCategory "murage.approval": Allow and Reply marked
//                                                     .authenticationRequired, Deny and Mute plain. Idempotent.
//   post({id, title, body, category, silent})         -> Promise<boolean> (false = the OS refused). category is null for Open only.
//   remove(id)                                        withdraw a delivered or pending banner.
//   onResponse(cb)                                    cb(id, actionId, replyText) with actionId one of "allow" | "deny" | "reply" |
//                                                     "mute" | "open"; returns an unsubscribe function.
//   readiness()                                       -> Promise<{authorization, alert, previews, category, failed}>, read from the OS at
//                                                     call time: authorization and alert as status() reports them (2 = authorized,
//                                                     enabled), previews = UNShowPreviewsSetting (0 always, 1 when unlocked, 2 never),
//                                                     category = the "murage.approval" category is registered WITH its Allow, Deny and
//                                                     Reply actions (Allow and Reply authentication-required, Reply a text input).
//                                                     A failed read is {-1, -1, -1, false, failed: true}.
//                                                     Optional: an addon without it posts Open-only banners.
// Fail closed (banner-actions design, section 5): notifications not authorised, previews set to never, or the action category missing
// each give an Open-only banner, as does a readiness read that is absent, fails, throws or does not answer in time.
// Buttons appear only when the server marked this exact card `outsideOk["banner-mac"]` with its full detail, previews are on, and the owner
// kept "answer from the banner" on. Anything else is an Open-only banner. A click re-reads readiness() before `act`, which re-checks
// everything else at answer time.

import { randomBytes } from "node:crypto";

export const CATEGORY = "murage.approval";
export const SURFACE = "banner-mac";
const MAX_ROUTES = 1024;
const ACTIONS = new Map([["allow", "allow"], ["deny", "deny"], ["reply", "reply"]]);

export const READINESS_TIMEOUT_MS = 3000;

/** Whether the OS would show this banner's full detail and its buttons right now. Anything but an exact, complete yes is a named no. */
export function macActionReadiness(value) {
  if (!value || typeof value !== "object" || value.failed !== false) return { ok: false, reason: "unavailable" };
  if (value.authorization !== 2 || value.alert !== 2) return { ok: false, reason: "unauthorised" };
  if (value.previews !== 0 && value.previews !== 1) return { ok: false, reason: "previews" };
  if (value.category !== true) return { ok: false, reason: "category" };
  return { ok: true };
}

export function createMacBanners({ platform = process.platform, loadAddon, mint, act, open, mute = () => {}, log = () => {}, readinessTimeoutMs = READINESS_TIMEOUT_MS }) {
  let addon = null, tried = false, unsubscribe = null, registered = false;
  const routes = new Map(); // banner id -> { token|null, route:{ botId, threadId, messageId } }

  function binding() {
    if (platform !== "darwin") return null;
    if (!tried) {
      tried = true;
      try {
        const loaded = loadAddon();
        const ok = loaded && ["registerCategories", "post", "remove", "onResponse"].every(name => typeof loaded[name] === "function");
        addon = ok ? loaded : null;
      } catch (error) { addon = null; log(`mac-banners: addon unavailable (${error?.message ?? error})`); }
    }
    return addon;
  }

  function remember(id, value) {
    routes.set(id, value);
    while (routes.size > MAX_ROUTES) routes.delete(routes.keys().next().value);
  }

  async function onResponse(id, actionId, replyText) {
    const entry = routes.get(id);
    if (!entry) return; // unknown banner: nothing happens
    try {
      if (actionId === "open" || actionId === undefined) { routes.delete(id); open(entry.route, entry.home); return; }
      if (actionId === "mute") { mute(entry.route, entry.home); return; }
      const action = ACTIONS.get(actionId);
      if (!action || !entry.token) { open(entry.route, entry.home); return; } // an action on an Open-only banner is an open, never an answer
      routes.delete(id);
      const withdraw = () => { open(entry.route, entry.home); try { binding()?.remove(id); } catch { /* withdrawing a gone banner */ } };
      // The OS settings may have changed since the banner was posted (previews set to never, notifications off, category gone): the
      // server cannot see them, so the click reads them again and anything but ready opens the card instead of answering.
      const ready = await actionsReady(binding() ?? {});
      if (!ready.ok) { log(`mac-banners: answer refused, open only (${ready.reason})`); withdraw(); return; }
      const result = await act(entry.token, action, action === "reply" ? replyText : undefined);
      if (!result || result.ok !== true) withdraw();
    } catch (error) { log(`mac-banners: response failed ${error?.message ?? error}`); }
  }

  /** One bounded read of the OS state behind the buttons. Never throws; a slow or broken read is a no. */
  async function actionsReady(bridge) {
    if (typeof bridge.readiness !== "function") return { ok: false, reason: "unavailable" };
    let timer;
    try {
      const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), readinessTimeoutMs); });
      return macActionReadiness(await Promise.race([Promise.resolve().then(() => bridge.readiness()), late]));
    } catch { return { ok: false, reason: "unavailable" }; } finally { clearTimeout(timer); }
  }

  function ensureReady() {
    const bridge = binding();
    if (!bridge) return null;
    if (!registered) {
      bridge.registerCategories();
      registered = true;
      unsubscribe = bridge.onResponse((id, actionId, replyText) => { void onResponse(id, actionId, replyText); });
    }
    return bridge;
  }

  return {
    available: () => binding() !== null,
    /**
     * Show one card. Returns the banner ids, or null when nothing was shown here (no addon, the OS refused): the caller then keeps the
     * existing path. `record` is the server's attention record for this card ({display, outsideOk, digest}) or null.
     */
    async show({ entry, record, actionsOn, silent = false, plain, transport, identity, cancelled = () => false }) {
      try { if (cancelled() === true) return null; } catch { return null; } // settled before it began: nothing is minted or posted
      let bridge;
      try { bridge = ensureReady(); } catch (error) { log(`mac-banners: setup failed ${error?.message ?? error}`); return null; }
      if (!bridge) return null;
      const id = `mb:${randomBytes(8).toString("hex")}`;
      const route = { botId: entry.frame.botId, threadId: entry.frame.threadId, messageId: entry.frame.messageId };
      const display = record?.display;
      let buttons = actionsOn === true && display && record.outsideOk?.[SURFACE] === true && typeof record.digest === "string" && record.digest.length > 0
        && [record.approvalId, record.requestRef, record.actionHash].every(part => typeof part === "string" && part.length > 0);
      if (buttons) {
        const ready = await actionsReady(bridge);
        if (!ready.ok) { buttons = false; log(`mac-banners: open only (${ready.reason})`); }
        // The read took time: a card that settled meanwhile mints and posts nothing.
        try { if (cancelled() === true) return null; } catch { return null; }
      }
      let token = null;
      if (buttons) {
        // The transport and identity captured with the card read travel with the mint (see native-banner-approvals.mjs).
        try { token = mint({ entry, surface: SURFACE, surfaceId: id, digest: record.digest, transport, identity }); } catch { token = null; }
      }
      const shown = buttons && token
        ? { title: `${display.botName}: ${display.title}`, body: display.willRun, category: CATEGORY }
        : { title: display ? `${display.botName}: ${display.title}` : plain.title, body: display ? display.botName : plain.body, category: null };
      remember(id, { token, route, home: entry.home }); // the home travels with the route: a click opens the card in the home that offered it
      try {
        const posted = await bridge.post({ id, title: shown.title, body: shown.body, category: shown.category, silent: silent === true });
        if (posted !== true) { routes.delete(id); return null; }
        return [id];
      } catch (error) { routes.delete(id); log(`mac-banners: post failed ${error?.message ?? error}`); return null; }
    },
    /** A card settled, previews changed or the entry was evicted: withdraw every banner and forget its routes. */
    close(ids) {
      const bridge = binding();
      for (const id of ids ?? []) {
        routes.delete(id);
        try { bridge?.remove(id); } catch { /* withdrawing a banner that is already gone */ }
      }
    },
    size: () => routes.size,
    dispose() { try { unsubscribe?.(); } catch { /* shutting down */ } unsubscribe = null; routes.clear(); },
  };
}
