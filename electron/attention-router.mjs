// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 section 4 (S3): the one decision point for every surface outside the app, for one desktop launch.
// Pure: the clock, timers, surfaces, the card re-check and the device preferences are all injected, so it tests with a fake clock.
// It decides ONE surface per event (rule 3), holds while quiet (rule 2), folds everything when a card settles (rule 4), nudges once
// (rule 5), shows one receipt per delivery (rule 6) and closes + invalidates on a previews change (rule 7). State is in memory only,
// keyed by home and server epoch, bounded at 1024 (oldest evicted first, its surfaces closed and its tokens invalidated first).
//
// deps: {
//   now(), setTimer(fn, ms) -> handle, clearTimer(handle),
//   prefs() -> { origin: "new"|"upgrade", notify, receipt, pill, bubble, hideFullscreen, respectFocus, quietSummary, nudgeMinutes },
//   available() -> { pill: boolean, notify: boolean, pinnedBotId: string|null },
//   quiet() -> { fullscreen, sharing, focus, locked },
//   surfaces: { show(rung, entry, generation) -> Promise<string[]|string|null>, close(surfaceIds, entry), counts(snapshot), summary(info) },
//   readCard(home, entry) -> Promise<{open:boolean}>,      // a failed read counts as still open (never silently drop a card)
//   invalidateTokens(entry), log(line),
// }
// Rungs: "pill" | "notify" | "bubble" | "counts" | "plain" (an Open-only notification) | "receipt-pill" | "receipt-notify".

export const MAX_TRACKED = 1024;
export const MAX_RECEIPTS = 4096;
const CARD_KINDS = new Set(["approval", "question"]);
const PLAIN_KINDS = new Set(["routine-failed", "turn-failed", "takeover", "backup-waiting", "memories-waiting", "email-digest", "email-status"]);

export function createAttentionRouter(deps) {
  const { now, setTimer, clearTimer, surfaces, readCard, invalidateTokens = () => {}, log = () => {} } = deps;
  const tracked = new Map(); // key -> entry
  const receipts = new Set(); // shown deliveryIds, bounded
  const held = new Map(); // key -> entry (events that arrived while quiet)
  let visibleState = new Map(); // home -> { threadId, focused }
  let generationCounter = 0;
  let quietWasOn = false;
  let quietHoursTimer = null;

  const prefs = () => deps.prefs();
  const quietReason = () => {
    const p = prefs(), q = deps.quiet();
    if (q.sharing) return "sharing";
    if (q.fullscreen && p.hideFullscreen) return "fullscreen";
    if (q.focus && p.respectFocus) return "focus";
    if (q.locked) return "locked";
    return null;
  };
  const cardKey = (home, epoch, frame) => `${home}|${epoch}|${frame.botId}|${frame.threadId}|${frame.requestTurnId ?? ""}|${frame.requestId ?? ""}`;
  const receiptKey = (home, epoch, frame) => `${home}|${epoch}|${frame.deliveryId}`;
  const snapshot = () => {
    const counts = { needsYou: 0, byHome: {} };
    for (const entry of tracked.values()) if (CARD_KINDS.has(entry.frame.kind)) { counts.needsYou += 1; counts.byHome[entry.home] = (counts.byHome[entry.home] ?? 0) + 1; }
    return counts;
  };
  const pushCounts = () => { try { surfaces.counts(snapshot()); } catch (error) { log(`router: counts failed ${error?.message ?? error}`); } };
  const surfaceIds = value => (Array.isArray(value) ? value : value ? [value] : []);

  function forget(entry, reason) {
    entry.generation = ++generationCounter; // a show still pending re-checks this and closes itself
    entry.dead = true; // nothing may put it back (a release that was reading when it settled)
    if (entry.nudgeTimer) clearTimer(entry.nudgeTimer);
    tracked.delete(entry.key); held.delete(entry.key);
    try { invalidateTokens(entry); } catch { /* never breaks routing */ }
    if (entry.surfaceIds.length > 0) { try { surfaces.close(entry.surfaceIds, entry); } catch (error) { log(`router: close failed ${error?.message ?? error}`); } }
    else { try { surfaces.cancel?.(entry); } catch { /* the window may be gone */ } } // never reached a surface: a window may still wait on it
    entry.surfaceIds = [];
    log(`router: ${reason} ${entry.key}`);
  }

  /** Held events are bounded with the tracked ones: the oldest is dropped (its window told to forget it) before the cap is passed. */
  function hold(entry) {
    held.set(entry.key, entry);
    while (held.size > MAX_TRACKED) forget(held.values().next().value, "evict-held");
  }

  function remember(entry) {
    if (entry.dead) return;
    tracked.set(entry.key, entry);
    while (tracked.size > MAX_TRACKED) forget(tracked.values().next().value, "evict");
  }

  async function present(entry, rung) {
    entry.rung = rung; entry.shownAt = now();
    const generation = entry.generation;
    let ids = [];
    try { ids = surfaceIds(await surfaces.show(rung, entry, generation)); } catch (error) { log(`router: show failed ${error?.message ?? error}`); }
    // Rule 4: a settle that landed while the show was pending cancels it.
    if (entry.generation !== generation || !tracked.has(entry.key)) {
      if (ids.length > 0) { try { surfaces.close(ids, entry); } catch { /* closing a dead surface */ } }
      return;
    }
    entry.surfaceIds.push(...ids);
  }

  /** Rule 3: the highest rung that is on and available. */
  function cardRung(entry, below = null) {
    const p = prefs(), a = deps.available();
    const order = [
      ["pill", p.pill === true && a.pill === true],
      ["notify", p.notify === true && a.notify === true],
      ["bubble", p.bubble === true && a.pinnedBotId != null && a.pinnedBotId === entry.frame.botId],
    ];
    let skipping = below !== null;
    for (const [rung, on] of order) {
      if (skipping) { if (rung === below) skipping = false; continue; }
      if (on) return rung;
    }
    return below === null ? "counts" : null;
  }

  function scheduleNudge(entry) {
    const minutes = prefs().nudgeMinutes;
    if (!CARD_KINDS.has(entry.frame.kind) || !(minutes > 0) || entry.rung === "counts") return;
    entry.nudgeTimer = setTimer(() => { entry.nudgeTimer = null; void nudge(entry); }, minutes * 60_000);
  }

  async function nudge(entry) {
    if (!tracked.has(entry.key) || entry.nudged) return;
    if (quietReason()) { entry.nudgeDue = true; return; } // a nudge due during a hold is spent by the release
    entry.nudged = true;
    const rung = cardRung(entry, entry.rung);
    if (rung && rung !== "counts") await present(entry, rung);
  }

  async function offer(frame, home = "local", epoch = "e") {
    if (!frame || typeof frame !== "object") return { decision: "ignored" };
    const kind = frame.kind;
    const p = prefs();
    if (kind === "done") {
      if (typeof frame.deliveryId === "string" && frame.deliveryId) {
        const rkey = receiptKey(home, epoch, frame);
        if (receipts.has(rkey)) return { decision: "duplicate" };
        receipts.add(rkey);
        while (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.values().next().value);
        if (p.receipt !== true) return { decision: "counts" };
        const entry = { key: rkey, home, epoch, frame, surfaceIds: [], generation: ++generationCounter, nudged: true };
        const a = deps.available();
        const rung = p.pill === true && a.pill === true ? "receipt-pill" : a.notify === true ? "receipt-notify" : "counts";
        if (quietReason()) { entry.reason = quietReason(); hold(entry); return { decision: "held", reason: entry.reason }; }
        if (rung === "counts") return { decision: "counts" };
        remember(entry); await present(entry, rung);
        return { decision: rung };
      }
      // Rule 6: no deliveryId (an older Cloud home server): today's plain "X finished" banner when receipts are on.
      if (p.receipt !== true) return { decision: "counts" };
      return routePlain({ key: `${home}|${epoch}|done|${frame.threadId}|${frame.at ?? now()}`, home, epoch, frame, surfaceIds: [], generation: ++generationCounter, nudged: true }, "plain");
    }
    if (CARD_KINDS.has(kind)) {
      const key = cardKey(home, epoch, frame);
      if (tracked.has(key) || held.has(key)) return { decision: "duplicate" };
      const entry = { key, home, epoch, frame, surfaceIds: [], generation: ++generationCounter, nudged: false, rung: "counts" };
      remember(entry); pushCounts();
      // Rule 1: already on screen. New installs: approvals too. Upgrades: approvals still banner.
      const seen = visibleState.get(home);
      if (seen && seen.focused && seen.threadId === frame.threadId && (kind !== "approval" || p.origin === "new")) return { decision: "on-screen" };
      const reason = quietReason();
      if (reason) { entry.reason = reason; hold(entry); return { decision: "held", reason }; }
      const rung = cardRung(entry);
      if (rung === "counts") return { decision: "counts" };
      await present(entry, rung); scheduleNudge(entry);
      return { decision: rung };
    }
    // Every other kind, and a kind this router does not recognise, goes as today: one plain notification, Open only.
    const entry = { key: `${home}|${epoch}|${kind}|${frame.threadId ?? ""}|${frame.at ?? now()}|${frame.deliveryId ?? ""}`, home, epoch, frame, surfaceIds: [], generation: ++generationCounter, nudged: true };
    const known = PLAIN_KINDS.has(kind);
    if (known && p.notify !== true && p.origin !== "upgrade") return { decision: "counts" };
    // Rule 1 as today for non-approvals.
    const seen = visibleState.get(home);
    if (seen && seen.focused && frame.threadId && seen.threadId === frame.threadId && known) return { decision: "on-screen" };
    return routePlain(entry, "plain");
  }

  async function routePlain(entry, rung) {
    const reason = quietReason();
    if (reason) { entry.reason = reason; hold(entry); return { decision: "held", reason }; }
    if (deps.available().notify !== true) return { decision: "counts" };
    remember(entry); await present(entry, rung);
    return { decision: rung };
  }

  /** Rule 4: idempotent. */
  function settled(threadId, requestId, home = "local") {
    let any = false;
    for (const entry of new Set([...tracked.values(), ...held.values()])) {
      if (entry.home === home && entry.frame.threadId === threadId && entry.frame.requestId === requestId && CARD_KINDS.has(entry.frame.kind)) { forget(entry, "settled"); any = true; }
    }
    if (any) pushCounts();
    return any;
  }

  function visible(threadId, focused, home = "local") { visibleState.set(home, { threadId: threadId ?? null, focused: focused === true }); }

  /** Reconcile: re-check EACH tracked card individually (never a page); a settled one folds. */
  async function reconcile(home) {
    const entries = [...tracked.values(), ...held.values()].filter(e => CARD_KINDS.has(e.frame.kind) && (home === undefined || e.home === home));
    for (const entry of entries) {
      let card; try { card = await readCard(entry.home, entry); } catch { card = { open: true }; }
      if (card && card.open === false) forget(entry, "reconciled");
    }
    pushCounts();
  }

  let releasing = false, releaseAgain = false;
  /** Called when any quiet source changes. A release spends held events: summary, or one banner for the newest. Serialized: a change that lands mid-release runs one more pass. */
  async function quietChanged() {
    if (releasing) { releaseAgain = true; return; }
    releasing = true;
    try { do { releaseAgain = false; await releaseOnce(); } while (releaseAgain); } finally { releasing = false; }
  }

  async function releaseOnce() {
    const reason = quietReason();
    if (reason) { quietWasOn = true; return; }
    if (!quietWasOn && held.size === 0) return;
    quietWasOn = false;
    const candidates = [];
    for (const entry of [...held.values()]) {
      if (held.get(entry.key) !== entry) continue; // settled or evicted while this release was reading
      if (CARD_KINDS.has(entry.frame.kind)) {
        let card; try { card = await readCard(entry.home, entry); } catch { card = { open: true }; }
        if (card && card.open === false) { forget(entry, "released-settled"); continue; }
      }
      if (held.get(entry.key) !== entry) continue; // settled during the read
      candidates.push(entry);
    }
    // Quiet came back while the cards were being read: everything stays held for the next release.
    if (quietReason()) { quietWasOn = true; return; }
    // Only what this release processes leaves the held set: an event that arrived meanwhile stays held for the next pass.
    const open = candidates.filter(entry => held.get(entry.key) === entry && !entry.dead);
    for (const entry of open) held.delete(entry.key);
    const p = prefs();
    if (open.length === 0) return;
    // No summary surface yet (it arrives with the slice that owns it): fail safe to ONE banner for the newest held card, never silence.
    const summaryOn = p.quietSummary === true && typeof surfaces.summary === "function";
    if ((p.origin === "upgrade" && p.quietSummary !== true) || (p.quietSummary === true && !summaryOn)) {
      // One banner for the newest held card; the rest stay in the counts.
      const newest = [...open].reverse().find(e => CARD_KINDS.has(e.frame.kind)) ?? open.at(-1);
      remember(newest);
      const rung = CARD_KINDS.has(newest.frame.kind) ? cardRung(newest) : "plain";
      if (rung && rung !== "counts") { await present(newest, rung); scheduleNudge(newest); }
      for (const e of open) if (e !== newest && CARD_KINDS.has(e.frame.kind)) remember(e);
      pushCounts();
      return;
    }
    if (!summaryOn) { for (const e of open) if (CARD_KINDS.has(e.frame.kind)) remember(e); pushCounts(); return; }
    // quietSummary on: ONE notification. N = 1 shows that event itself; a summary never carries Allow.
    if (open.length === 1) {
      const only = open[0]; remember(only);
      const rung = CARD_KINDS.has(only.frame.kind) ? cardRung(only) : "plain";
      if (rung && rung !== "counts") await present(only, rung);
    } else {
      const needs = open.filter(e => CARD_KINDS.has(e.frame.kind)).length;
      for (const e of open) if (CARD_KINDS.has(e.frame.kind)) remember(e);
      try { await surfaces.summary({ total: open.length, needsYou: needs, finished: open.filter(e => e.frame.kind === "done").length, other: open.length - needs - open.filter(e => e.frame.kind === "done").length }); } catch (error) { log(`router: summary failed ${error?.message ?? error}`); }
    }
    for (const entry of open) if (entry.nudgeDue) { entry.nudgeDue = false; entry.nudged = true; }
    pushCounts();
  }

  /** Server quiet hours: one timer at endsAt, then the server's held list (muted bots and disabled categories never appear). */
  function quietHoursUntil(endsAt, onEnd) {
    if (quietHoursTimer) clearTimer(quietHoursTimer);
    if (!Number.isFinite(endsAt)) { quietHoursTimer = null; return; }
    quietHoursTimer = setTimer(() => { quietHoursTimer = null; void onEnd(); }, Math.max(0, endsAt - now()));
  }

  /** Rule 7: previews changed: every outside surface is closed and every token invalidated; open cards are offered again by the caller. */
  function previewsChanged(home) {
    for (const entry of [...tracked.values()]) {
      if (home !== undefined && entry.home !== home) continue;
      try { invalidateTokens(entry); } catch { /* never breaks routing */ }
      if (entry.surfaceIds.length > 0) { try { surfaces.close(entry.surfaceIds, entry); } catch { /* closing */ } entry.surfaceIds = []; }
      entry.generation = ++generationCounter;
    }
  }

  /** A home went away (Cloud disconnect or window swap): everything of that home folds. */
  function homeGone(home) {
    for (const entry of [...tracked.values(), ...held.values()]) if (entry.home === home) forget(entry, "home-gone");
    visibleState.delete(home);
    pushCounts();
  }

  return { offer, settled, visible, reconcile, quietChanged, quietHoursUntil, previewsChanged, homeGone, size: () => tracked.size, heldSize: () => held.size, snapshot };
}
