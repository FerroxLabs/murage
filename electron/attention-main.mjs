// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 section 4.1 (S3): main's side of the router. It owns the router instance for one desktop launch and is the only
// thing the IPC handlers and the watcher talk to. Pure: Electron, the transports and the server reads all arrive injected.
//
// What crosses from a window is routing identity ONLY (kind, ids, an opaque `ref` the window chose): never a title or a body. When the
// router decides an event is shown through the notification rungs, main sends the SAME `ref` back to the window it came from and that
// window shows the event with the display code it already has (S4a/S4b/S4c replace this with native actionable banners, one rung at
// a time). The same ref later carries a close (the card settled, the previews changed) and a previews message. The home comes from the
// registered window that sent the call (main derives it), never from the payload.
//
// deps: {
//   prefs() -> notify-surfaces state (shared/notify-surfaces.mjs shape), presence() -> {fullscreen, sharing, focus, locked} (S3B; default none),
//   nativeBanner (optional, S4b: electron/mac-banners.mjs shape {available(), show({entry, record, actionsOn, plain}) -> ids|null, close(ids)}),
//   beforeDecision() -> Promise (a fresh presence read, awaited before each decision), watchPresence() -> stop (a poll while something is held),
//   sendShow(home, ref) -> boolean, sendClose(home, ref) -> boolean, sendPreviews(home, previews) -> boolean,
//   transportFor(home) -> attention transport | null, invalidateTokens(entry), onPreviewsChanged(home),
//   readPreviews(home) -> Promise<boolean | null>, onCounts(snapshot), onSummary(info), pillAvailable(), pinnedBotId(),
//   now, setTimer, clearTimer, log,
// }

import { createAttentionRouter } from "./attention-router.mjs";

const SHOW_RUNGS = new Set(["notify", "plain", "receipt-notify"]);
const MAX_ID = 256;
const MAX_REF = 64;
const MAX_KIND = 64;
const MAX_PENDING_OFFERS = 1024;
// The server's own allowlisted words for a card whose detail may not leave the app (previews off, or no full detail).
const PLAIN_WORDS = Object.freeze({ title: "Murage", body: "Your attention is needed." });
const KEPT_ID_FIELDS = ["botId", "threadId", "messageId", "requestId", "requestTurnId", "deliveryId"];
const NATIVE_PREFIX = "mb:";

const text = (value, max) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);
const routerActionsOn = deps => { try { return deps.prefs?.()?.notifyActions === true; } catch { return false; } };

/** Today's behaviour when the device file cannot be read: nothing new on, the old banners kept. */
const UPGRADE_FALLBACK = Object.freeze({ origin: "upgrade", notify: true, receipt: true, pill: false, bubble: false, hideFullscreen: false, respectFocus: false, quietSummary: false, nudgeMinutes: 0 });

export function routerPrefsFrom(state) {
  const s = state && typeof state === "object" ? state : null;
  if (!s || !s.surfaces || (s.origin !== "new" && s.origin !== "upgrade")) return UPGRADE_FALLBACK;
  return {
    origin: s.origin, notify: s.surfaces.notify === true, receipt: s.surfaces.receipt === true, pill: s.surfaces.pill === true, bubble: s.surfaces.bubble === true,
    hideFullscreen: s.hideFullscreen === true, respectFocus: s.respectFocus === true, quietSummary: s.quietSummary === true,
    nudgeMinutes: Number.isFinite(s.nudgeMinutes) ? s.nudgeMinutes : 0,
  };
}

/** The routing-only frame main keeps for one offer, or null when the payload is not an offer. */
export function frameFromOffer(payload) {
  if (!payload || typeof payload !== "object") return null;
  const kind = text(payload.kind, MAX_KIND);
  if (!kind) return null;
  const frame = { kind };
  for (const field of KEPT_ID_FIELDS) {
    if (payload[field] === undefined) continue;
    const value = text(payload[field], MAX_ID);
    if (value === null) return null;
    frame[field] = value;
  }
  if (payload.ref !== undefined) { const ref = text(payload.ref, MAX_REF); if (ref === null) return null; frame.ref = ref; }
  if (payload.durationMs !== undefined) { if (!Number.isFinite(payload.durationMs) || payload.durationMs < 0) return null; frame.durationMs = payload.durationMs; }
  if (payload.at !== undefined) { if (!Number.isFinite(payload.at)) return null; frame.at = payload.at; }
  return frame;
}

export function createAttentionMain(deps) {
  const { sendShow, transportFor, log = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = deps;
  const epochs = new Map(); // home -> counter (a new server run, a new Cloud session: a new epoch, so old keys never collide)
  const epochOf = home => `e${epochs.get(home) ?? 0}`;
  const lastPreviews = new Map(); // home -> boolean (per home: one home's change never touches another's surfaces)
  const inFlight = new Map(); // `${home}|${threadId}|${requestId}` -> {cancelled}: an offer that is still waiting for its presence read
  const undelivered = new Set(); // refs whose show message could not be sent to the window
  let reconciling = null, reconcileAgain = false;
  let stopWatch = null;
  /** The presence poll exists only while at least one event is held (design 4.2 rule 2, section 8). */
  function syncWatch() {
    const held = router.heldSize() > 0;
    if (held && !stopWatch) { try { stopWatch = deps.watchPresence?.() ?? null; } catch { stopWatch = null; } }
    else if (!held && stopWatch) { try { stopWatch(); } catch { /* stopping a poll never throws into routing */ } stopWatch = null; }
  }

  const router = createAttentionRouter({
    now, setTimer, clearTimer, log,
    prefs: () => { try { return routerPrefsFrom(deps.prefs()); } catch { return UPGRADE_FALLBACK; } },
    available: () => ({ pill: deps.pillAvailable?.() === true, notify: true, pinnedBotId: deps.pinnedBotId?.() ?? null }),
    quiet: () => { try { return { fullscreen: false, sharing: false, focus: false, locked: false, ...(deps.presence?.() ?? {}) }; } catch { return { fullscreen: false, sharing: false, focus: false, locked: true }; } },
    surfaces: {
      show: async (rung, entry) => {
        // A native banner surface (Mac, S4b) takes a card first; when it shows nothing (no addon, the OS refused) the path below runs.
        if (rung === "notify" && (entry.frame.kind === "approval" || entry.frame.kind === "question") && deps.nativeBanner?.available?.() === true) {
          try {
            const transport = transportFor(entry.home);
            const { threadId, messageId } = entry.frame;
            const record = transport && threadId && messageId ? await transport.readCard({ threadId, messageId }, () => {}).catch(() => null) : null;
            const ids = await deps.nativeBanner.show({ entry, record, actionsOn: routerActionsOn(deps), plain: PLAIN_WORDS });
            if (Array.isArray(ids) && ids.length > 0) return ids;
          } catch (error) { log(`attention: native banner failed ${error?.message ?? error}`); }
        }
        // The window that offered the event shows it as today, by ref. The ref is also the surface handle a later close names.
        if (SHOW_RUNGS.has(rung) && entry.frame.ref) {
          let sent = false;
          try { sent = sendShow(entry.home, entry.frame.ref) === true; } catch { sent = false; }
          if (sent) return [entry.frame.ref];
          undelivered.add(entry.frame.ref); // the offer reports it, so the window shows the event itself and nothing is lost
          log(`attention: ${rung} not delivered to the window home=${entry.home}`);
          return null;
        }
        log(`attention: ${rung} not shown (no surface) home=${entry.home}`);
        return null;
      },
      close: (ids, entry) => {
        const native = [], refs = [];
        for (const id of ids ?? []) (String(id).startsWith(NATIVE_PREFIX) ? native : refs).push(id);
        if (native.length > 0) { try { deps.nativeBanner?.close?.(native); } catch { /* withdrawing a gone banner never breaks routing */ } }
        for (const ref of refs) { try { deps.sendClose?.(entry.home, ref); } catch { /* the window may be gone */ } }
      },
      // An event that never reached a surface (held, counted) but whose window still waits on its ref: tell the window to drop it.
      cancel: entry => { if (entry.frame.ref) { try { deps.sendClose?.(entry.home, entry.frame.ref); } catch { /* the window may be gone */ } } },
      counts: snapshot => { try { deps.onCounts?.(snapshot); } catch { /* a counts consumer never breaks routing */ } },
      summary: deps.onSummary ? info => deps.onSummary(info) : undefined,
    },
    readCard: async (home, entry) => {
      const transport = transportFor(home);
      const { threadId, messageId } = entry.frame;
      if (!transport || !threadId || !messageId) return { open: true };
      return transport.readCard({ threadId, messageId }, () => {});
    },
    invalidateTokens: entry => { try { deps.invalidateTokens?.(entry); } catch { /* never breaks routing */ } },
  });

  const flightKey = (home, frame) => (frame.threadId && frame.requestId ? `${home}|${frame.threadId}|${frame.requestId}` : null);

  async function offer(home, payload) {
    if (typeof home !== "string" || !home) return { ok: false };
    if (payload && typeof payload === "object" && payload.kind === "attention.settled") return { ok: true, decision: settled(home, payload.threadId, payload.requestId) ? "settled" : "unknown" };
    if (payload && typeof payload === "object" && payload.kind === "attention.config") { void previewsCheck(home); return { ok: true, decision: "config" }; }
    const frame = frameFromOffer(payload);
    if (!frame) return { ok: false };
    // Identity captured BEFORE any await: a settle, a new server run or a replaced window while the presence read waits cancels this offer.
    const epoch = epochOf(home), key = flightKey(home, frame);
    const flight = { cancelled: false };
    if (key && inFlight.size < MAX_PENDING_OFFERS) inFlight.set(key, flight);
    try {
      try { await deps.beforeDecision?.(); } catch { /* a failed presence read is not detected, never a lost notification */ }
      if (flight.cancelled || epochOf(home) !== epoch) return { ok: true, decision: epochOf(home) !== epoch ? "stale" : "settled" };
      const result = await router.offer(frame, home, epoch);
      syncWatch();
      if (frame.ref && undelivered.delete(frame.ref)) return { ok: false, decision: "undelivered" };
      return { ok: true, decision: result.decision };
    } catch (error) {
      log(`attention: offer failed ${error?.message ?? error}`);
      return { ok: false };
    } finally { if (key && inFlight.get(key) === flight) inFlight.delete(key); }
  }

  function visible(home, payload) {
    if (typeof home !== "string" || !home || !payload || typeof payload !== "object") return { ok: false };
    const threadId = payload.threadId === null ? null : text(payload.threadId, MAX_ID);
    if (payload.threadId !== null && threadId === null) return { ok: false };
    router.visible(threadId, payload.focused === true, home);
    return { ok: true };
  }

  function settled(home, threadId, requestId) {
    const thread = text(threadId, MAX_ID), request = text(requestId, MAX_ID);
    if (!thread || !request) return false;
    const waiting = inFlight.get(`${home}|${thread}|${request}`);
    if (waiting) waiting.cancelled = true; // an offer still reading presence must not show a settled card
    const folded = router.settled(thread, request, home);
    syncWatch();
    return folded || Boolean(waiting);
  }

  /** Re-check every tracked card, one at a time. One run at a time; a request that lands mid-run schedules exactly one more. */
  function reconcile(home) {
    if (reconciling) { reconcileAgain = true; return reconciling; }
    reconciling = (async () => {
      try { do { reconcileAgain = false; await router.reconcile(home); } while (reconcileAgain); }
      catch (error) { log(`attention: reconcile failed ${error?.message ?? error}`); }
      finally { reconciling = null; syncWatch(); }
    })();
    return reconciling;
  }

  /**
   * Rule 7: a previews change closes every outside surface of that home and kills every token, and tells the window to re-word anything
   * it still holds. The first read of a home only records the baseline, EXCEPT a first read of "off": a baseline we cannot compare is
   * treated as a change, because closing and invalidating is cheap and showing detail the owner just hid is not.
   */
  async function previewsCheck(home = "local") {
    let value = null;
    try { value = await deps.readPreviews?.(home); } catch { value = null; }
    if (typeof value !== "boolean") return false;
    const before = lastPreviews.has(home) ? lastPreviews.get(home) : null;
    lastPreviews.set(home, value);
    const changed = before === null ? value === false : before !== value;
    if (changed) {
      router.previewsChanged(home);
      try { deps.sendPreviews?.(home, value); } catch { /* the window may be gone */ }
      try { deps.onPreviewsChanged?.(home); } catch { /* never breaks routing */ }
    }
    return changed;
  }

  /** One frame from main's own watcher stream (ids only, see inbox-watch.mjs). */
  function watcherFrame(frame) {
    if (!frame || typeof frame !== "object") return;
    if (frame.kind === "attention.settled") settled("local", frame.threadId, frame.requestId);
    else if (frame.kind === "config") void previewsCheck("local");
    // `bot` frames are for the dock (S9): nothing to do yet.
  }

  function cancelFlights(home) { for (const [key, flight] of inFlight) if (key.startsWith(`${home}|`)) flight.cancelled = true; }
  function newEpoch(home) { epochs.set(home, (epochs.get(home) ?? 0) + 1); lastPreviews.delete(home); }
  /** A new server run: everything of the local home folds and its keys restart under a new epoch. */
  function serverChanged() { newEpoch("local"); cancelFlights("local"); router.homeGone("local"); syncWatch(); }
  function homeGone(home) { newEpoch(home); cancelFlights(home); router.homeGone(home); syncWatch(); }

  return { offer, visible, settled, reconcile, previewsCheck, watcherFrame, serverChanged, homeGone, quietChanged: async () => { await router.quietChanged(); syncWatch(); }, quietHoursUntil: (endsAt, onEnd) => router.quietHoursUntil(endsAt, onEnd), router };
}
