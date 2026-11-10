// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// S3R: main owns admission, payload ledgers and every OS handle. Electron,
// sessions, transports, presence and clocks are injected for isolated tests.
import { createAttentionRouter } from "./attention-router.mjs";

export const CAP_HOME = 256, CAP_ALL = 1024, LEDGER_MAX = 288, HANDOFF_MS = 10_000;
export const PLAIN_WORDS = Object.freeze({ title: "Murage", body: "Your attention is needed." });
const SHOW_RUNGS = new Set(["notify", "plain", "receipt-notify"]);
const CARD_KINDS = new Set(["approval", "question"]);
const KEPT_ID_FIELDS = ["botId", "threadId", "messageId", "requestId", "requestTurnId", "deliveryId"];
const text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const UPGRADE_FALLBACK = Object.freeze({ origin: "upgrade", notify: true, receipt: true, pill: false, bubble: false, hideFullscreen: false, respectFocus: false, quietSummary: false, nudgeMinutes: 0 });

export function routerPrefsFrom(state) {
  if (!state?.surfaces || !["new", "upgrade"].includes(state.origin)) return UPGRADE_FALLBACK;
  return { origin: state.origin, ...Object.fromEntries(["notify", "receipt", "pill", "bubble"].map(k => [k, state.surfaces[k] === true])),
    hideFullscreen: state.hideFullscreen === true, respectFocus: state.respectFocus === true, quietSummary: state.quietSummary === true,
    nudgeMinutes: Number.isFinite(state.nudgeMinutes) ? state.nudgeMinutes : 0 };
}
export function frameFromOffer(payload) {
  if (!payload || typeof payload !== "object" || !text(payload.kind, 64)) return null;
  const frame = { kind: payload.kind };
  for (const field of KEPT_ID_FIELDS) {
    if (payload[field] === undefined) continue;
    if (!text(payload[field])) return null;
    frame[field] = payload[field];
  }
  if (payload.ref !== undefined) { if (!text(payload.ref, 64)) return null; frame.ref = payload.ref; }
  if (payload.durationMs !== undefined) { if (!Number.isFinite(payload.durationMs) || payload.durationMs < 0) return null; frame.durationMs = payload.durationMs; }
  if (payload.at !== undefined) { if (!Number.isFinite(payload.at)) return null; frame.at = payload.at; }
  return frame;
}

export function createAttentionMain(deps) {
  const { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = deps;
  const presence = deps.presence;
  const records = new Map(), reservations = new Map(), sessions = new Set(), homeCounts = new Map();
  const epochs = new Map(), lastPreviews = new Map();
  let genCounter = 0, attemptCounter = 0, admissionCounter = 0, stopWatch = null, stopped = false;
  let reconciling = null, reconcileAgain = false;
  const keyOf = (s, ref) => JSON.stringify([s.home, s.session, ref]);
  const epochOf = home => `e${epochs.get(home) ?? 0}`;
  const current = record => records.get(record.key) === record && !record.retired;
  const validSession = s => s && s.alive === true && text(s.home) && text(s.session, 64) && s.ledger instanceof Set;
  const prefs = () => { try { return routerPrefsFrom(deps.prefs?.()); } catch { return UPGRADE_FALLBACK; } };
  const refresh = async () => { try { return await presence.refresh(); } catch { return { locked: true, rev: presence?.rev }; } };
  const send = (s, message) => {
    if (!s.alive) return false;
    try { return deps.sendToSession?.(s.home, s.session, { ...message, session: s.session }) === true; } catch { return false; }
  };
  const closePayload = record => { if (record.owner.ledger.has(record.ref)) send(record.owner, { type: "close", ref: record.ref, gen: record.gen }); };
  const retiredRefs = (s, own) => {
    const result = own ? [own] : [];
    for (const ref of s.ledger) {
      const r = records.get(keyOf(s, ref));
      if ((!r || r.state === "SHOWN" || r.state === "ORPHAN") && !result.includes(ref)) result.push(ref);
      if (result.length >= CAP_HOME) break;
    }
    return result;
  };
  const reply = (s, fields, own) => ({ ...fields, retired: retiredRefs(s, own) });
  const stale = s => reply(s, { ok: false, stale: true });
  function syncWatch() {
    const held = [...records.values()].some(r => r.state === "HELD" || r.state === "ORPHAN");
    if (held && !stopWatch) { try { stopWatch = deps.watchPresence?.() ?? presence?.watch?.() ?? null; } catch { /* retry on next transition */ } }
    else if (!held && stopWatch) { const stop = stopWatch; stopWatch = null; try { stop(); } catch { /* already stopped */ } }
  }
  function clearDeadline(record) { if (record.deadline !== null) { clearTimer(record.deadline); record.deadline = null; } }
  function supersede(record) {
    const slot = record.attempt?.slot; record.attempt = null;
    try { slot?.cancel(); } catch { /* cancelled attempt cannot pass its currency test */ }
    clearDeadline(record); record.gen = ++genCounter;
  }
  function closeHandle(record) {
    const handle = record.handle, notice = record.notice;
    record.handle = null; record.notice = null;
    if (!handle) return;
    try { if (handle.startsWith("n:")) deps.nativeApprovals?.close(handle.slice(2)); else notice?.close(); }
    catch { /* the OS may already have discarded the notice */ }
    finally { notice?.removeAllListeners(); }
  }
  function retire(record, outcome) {
    if (record.retired) return;
    record.retired = true; record.outcome = outcome;
    supersede(record); records.delete(record.key);
    if (reservations.get(record.cardKey) === record) reservations.delete(record.cardKey);
    const count = (homeCounts.get(record.home) ?? 1) - 1;
    if (count) homeCounts.set(record.home, count); else homeCounts.delete(record.home);
    closeHandle(record); closePayload(record);
    router.finish(record.entry, record.entryGeneration, outcome);
    router.pushCounts(); syncWatch();
  }
  const router = createAttentionRouter({
    now, setTimer, clearTimer, log, prefs, presence: { refresh, rev: () => presence?.rev, markConservative: () => presence?.markConservative?.() },
    available: () => ({ pill: deps.pillAvailable?.() === true, notify: true, pinnedBotId: deps.pinnedBotId?.() ?? null }),
    // show/close serve only the rungs the S3R path cannot hand off as a notice: a nudge to the bubble (S9 createFloatSurface) after the card's
    // notice was shown. A record-bearing card never reaches a surface through router.present's first show.
    surfaces: { show: (rung, entry, generation) => deps.showSurface?.(rung, entry, generation) ?? null,
      close: (ids, entry) => { try { deps.closeSurface?.(ids, entry); } catch (error) { log(`attention: surface close failed ${error?.message ?? error}`); } },
      counts: s => deps.onCounts?.(s), summary: deps.onSummary },
    delivery: { retire, route: async (r, rung, snapshot) => {
      if (!current(r)) return;
      if (r.state === "ORPHAN") await orphanRoute(r);
      else if (r.state === "HELD") applyDecision(r, router.decide(r.entry, snapshot));
    } },
    readCard: async (home, entry) => {
      const transport = deps.transportFor?.(home), { threadId, messageId } = entry.frame;
      return transport && threadId && messageId ? transport.readCard({ threadId, messageId }, () => {}) : { open: true };
    },
    invalidateTokens: entry => deps.invalidateTokens?.(entry),
  });
  function victim(home) {
    const rank = r => r.state === "SHOWN" && !r.cardKey ? 0 : r.state === "HELD" && !r.cardKey ? 1
      : r.state === "SHOWN" && r.cardKey ? 2 : r.cardKey && ["HELD", "ORPHAN"].includes(r.state) ? 3 : 4;
    return [...records.values()].filter(r => (home === undefined || r.home === home) && rank(r) < 4)
      .sort((a, b) => rank(a) - rank(b) || Number(a.owner.alive) - Number(b.owner.alive) || a.admittedAt - b.admittedAt)[0];
  }
  function hello(s) {
    if (!validSession(s) || stopped) return { ok: false };
    sessions.add(s); return reply(s, { ok: true, ledgerMax: LEDGER_MAX });
  }
  async function offer(s, payload) {
    if (!validSession(s) || stopped || payload?.session !== s.session) return { ok: false };
    sessions.add(s);
    if (payload.kind === "attention.settled") return reply(s, { ok: true, decision: settled(s.home, payload.threadId, payload.requestId) ? "settled" : "unknown" });
    if (payload.kind === "attention.config") { void previewsCheck(s.home); return reply(s, { ok: true, decision: "config" }); }
    const frame = frameFromOffer(payload);
    if (!frame?.ref) return { ok: false };
    const key = keyOf(s, frame.ref), existing = records.get(key), epoch = epochOf(s.home);
    if (existing) { if (existing.decisionPending) await existing.decisionPending; return reply(s, { ok: true, decision: existing.decision }); }
    if (s.ledger.has(frame.ref)) return reply(s, { ok: true, decision: "duplicate" }, frame.ref);
    const cardKey = CARD_KINDS.has(frame.kind) ? router.cardKey(s.home, epoch, frame) : null;
    if ((cardKey && reservations.has(cardKey)) || router.known(frame, s.home, epoch)) return reply(s, { ok: true, decision: "duplicate" }, frame.ref);
    const overflow = () => { router.count(frame, s.home, epoch); return reply(s, { ok: true, decision: "overflow" }, frame.ref); };
    if (s.ledger.size >= LEDGER_MAX) return overflow();
    if ((homeCounts.get(s.home) ?? 0) >= CAP_HOME || records.size >= CAP_ALL) {
      const old = victim((homeCounts.get(s.home) ?? 0) >= CAP_HOME ? s.home : undefined);
      if (!old) return overflow();
      retire(old, old.state === "SHOWN" ? "evicted" : "counted");
    }
    const record = { ...frame, key, home: s.home, session: s.session, owner: s, cardKey, state: "OFFERED", gen: 0,
      attempt: null, handle: null, notice: null, retired: false, deadline: null, admittedAt: ++admissionCounter, decision: "offered", epoch };
    records.set(key, record); if (cardKey) reservations.set(cardKey, record);
    homeCounts.set(s.home, (homeCounts.get(s.home) ?? 0) + 1); s.ledger.add(frame.ref);
    record.entry = router.register(frame, s.home, epoch, record); record.entryGeneration = record.entry.generation;
    record.decisionPending = (async () => {
      const snapshot = await refresh();
      if (!current(record) || record.state !== "OFFERED") return;
      applyDecision(record, router.decide(record.entry, snapshot));
    })();
    await record.decisionPending; if (current(record)) record.decisionPending = null;
    return reply(s, { ok: true, decision: record.outcome === "settled" ? (epochOf(s.home) !== epoch ? "stale" : "settled") : record.decision });
  }
  function hold(record) {
    clearDeadline(record);
    if (record.state !== "ORPHAN") record.state = "HELD";
    router.hold(record.entry); syncWatch();
  }
  function applyDecision(record, decision) {
    if (!current(record)) return;
    record.decision = decision; record.entry.rung = decision;
    if (decision === "held") { hold(record); return; }
    if (!SHOW_RUNGS.has(decision)) { retire(record, "counted"); return; }
    router.unhold(record.entry); supersede(record); record.state = "SENT";
    const gen = record.gen;
    record.deadline = setTimer(() => {
      if (!current(record) || record.state !== "SENT" || record.gen !== gen) return;
      supersede(record);
      if (!record.cardKey) { retire(record, "counted"); return; }
      record.state = "ORPHAN"; closePayload(record); void orphanRoute(record);
    }, HANDOFF_MS);
    if (!send(record.owner, { type: "show", ref: record.ref, gen, previews: lastPreviews.get(record.home) === true })) log(`attention: hand-off not delivered home=${record.home}`);
    syncWatch();
  }
  async function orphanRoute(record) {
    if (!current(record) || record.state !== "ORPHAN" || record.attempt || record.routing) return;
    const gen = record.gen; record.routing = true;
    try {
      const snapshot = await refresh();
      if (!current(record) || record.state !== "ORPHAN" || record.gen !== gen) return;
      const decision = router.decide(record.entry, snapshot, !record.owner.alive);
      record.decision = decision;
      if (decision === "held") { hold(record); return; }
      if (!SHOW_RUNGS.has(decision)) { retire(record, "counted"); return; }
      record.entry.rung = decision; await presentNow(record, null);
    } finally { if (current(record) && record.gen === gen) record.routing = false; syncWatch(); }
  }
  function rungOn(record) {
    const p = prefs();
    if (record.entry.rung === "notify") return p.notify;
    if (record.entry.rung === "receipt-notify" || record.kind === "done") return p.receipt;
    return p.notify || p.origin === "upgrade";
  }
  function validWords(payload) {
    return payload && typeof payload.title === "string" && payload.title.length <= 256 && typeof payload.body === "string" && payload.body.length <= 1024
      && typeof payload.privatePreview === "boolean" && typeof payload.silent === "boolean"
      && (payload.botId === undefined || text(payload.botId)) && (payload.threadId === undefined || text(payload.threadId))
      && (payload.icon === undefined || (typeof payload.icon === "string" && payload.icon.length <= 65536 && /^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/.test(payload.icon)));
  }
  async function present(s, payload) {
    if (!s || !(s.ledger instanceof Set) || payload?.session !== s.session || !text(payload.ref, 64) || !Number.isInteger(payload.gen) || !validWords(payload)) return { ok: false };
    const record = records.get(keyOf(s, payload.ref));
    if (!s.alive || !record || record.state !== "SENT" || record.gen !== payload.gen || record.attempt) return stale(s);
    const result = await presentNow(record, payload);
    return result === "stale" ? stale(s) : reply(s, { ok: true, kept: result === "held" });
  }
  async function presentNow(record, words) {
    if (!current(record) || record.attempt) return "stale";
    const token = ++attemptCounter, state = record.state;
    record.attempt = { token, gen: record.gen, slot: null };
    const currency = () => record.attempt?.token === token && current(record);
    const checks = () => {
      if (!currency()) return "stale";
      if (!router.current(record.entry) || record.entry.generation !== record.entryGeneration) { retire(record, "settled"); return "done"; }
      if (!rungOn(record)) { retire(record, "rolled-back"); return "done"; }
      return null;
    };
    let prepared = null, overtakes = 0, failure = false;
    // One decision per attempt. A native seam may decline a home (Linux without a banner service: the card is a plain main notice).
    const native = record.kind === "approval" && deps.nativeApprovals && deps.nativeApprovals.handles?.(record.home) !== false ? deps.nativeApprovals : null;
    try {
      while (true) {
        let stop = checks(); if (stop) return stop;
        const snapshot = await refresh();
        stop = checks(); if (stop) return stop;
        if (router.quietReason(snapshot)) { hold(record); return "held"; }
        if (native && !prepared) {
          const input = { ...PLAIN_WORDS, silent: words?.silent === true };
          for (const field of ["botId", "threadId", "messageId", "requestId", "requestTurnId"]) if (record[field] !== undefined) input[field] = record[field];
          if (words && lastPreviews.get(record.home) === true) { input.title = words.title; input.body = words.body; }
          const key = `${record.home}|${record.session}|${record.ref}|${record.gen}`;
          // epoch and previews let a banner adapter bind its action tokens to this card's server run (S4b/S4c); the Electron notifier ignores them.
          const result = await native.prepare(input, { key, epoch: record.epoch, previews: lastPreviews.get(record.home) === true, onSlot: slot => { if (currency()) record.attempt.slot = slot; else slot.cancel(); } });
          stop = checks(); if (stop) return stop;
          if (!result?.ok) {
            // The notifier does not distinguish authorization refusal from a
            // card that disappeared during its re-read. Resolve that distinction
            // using this record's own ids before keeping a counts identity.
            let card;
            try { card = await deps.transportFor?.(record.home)?.readCard({ threadId: record.threadId, messageId: record.messageId }, () => {}); }
            catch { card = null; }
            stop = checks(); if (stop) return stop;
            if (card?.open === false) { retire(record, "settled"); return "done"; }
            failure = true; break;
          }
          prepared = result.prepared; continue;
        }
        if (!currency() || record.state !== state) return "stale";
        if (presence.rev !== snapshot.rev) {
          if (++overtakes >= 3) { presence.markConservative(); hold(record); return "held"; }
          continue;
        }
        const previews = lastPreviews.get(record.home) === true;
        const display = previews ? (prepared?.words ?? words ?? PLAIN_WORDS) : PLAIN_WORDS;
        const key = `${record.home}|${record.session}|${record.ref}|${record.gen}`, handle = `${native ? "n" : "m"}:${key}`;
        const failed = () => {
          if (!current(record) || record.handle !== handle) return;
          record.handle = null; record.notice?.removeAllListeners(); record.notice = null; retire(record, "counted");
        };
        let opened = false;
        const onClick = () => {
          if (!opened && current(record)) {
            opened = true;
            deps.onOpen?.({ home: record.home, session: record.owner.alive ? record.session : null, botId: record.botId, threadId: record.threadId, messageId: record.messageId });
          }
        };
        if (native) {
          if (!previews) prepared.words = { ...PLAIN_WORDS };
          record.handle = handle;
          // canShow: a fallback notice shown after an asynchronous banner refusal is a presentation too; it needs a fresh, clear presence read.
          // stillClear is its synchronous twin, asked at the instant of presentation: no evidence may land between the read and the show.
          let freshRev = null;
          const canShow = async () => {
            if (!current(record) || record.handle !== handle) return false;
            const fresh = await refresh();
            freshRev = fresh.rev;
            return current(record) && record.handle === handle && !router.quietReason(fresh) && presence.rev === fresh.rev;
          };
          const stillClear = () => freshRev !== null && current(record) && record.handle === handle && presence.rev === freshRev;
          const result = native.present(prepared, { key, previews, silent: words?.silent === true, onFailed: failed, onClick, canShow, stillClear });
          if (!currency()) return "done";
          if (!result?.accepted) { record.handle = null; failure = true; break; }
          record.handle = result.handle;
        } else {
          const options = { title: display.title, body: display.body, silent: words?.silent === true };
          if (words?.icon && !words.privatePreview && previews) options.icon = words.icon;
          const notice = deps.createNotice(options); record.notice = notice; record.handle = handle;
          notice.on("failed", failed);
          notice.on("click", onClick);
          notice.show(); if (!currency()) return "done";
        }
        record.state = "SHOWN"; clearDeadline(record); router.unhold(record.entry); closePayload(record);
        router.armNudge(record.entry); // nudgeMinutes: one nudge to the next rung (a no-op for receipts, off, or an already-spent nudge)
        if (!native && record.botId) for (const old of [...records.values()]) {
          if (old !== record && old.home === record.home && old.botId === record.botId && old.state === "SHOWN" && old.handle?.startsWith("m:") && (record.cardKey || !old.cardKey)) retire(old, old.cardKey ? "counted" : "evicted");
        }
        router.pushCounts(); syncWatch(); return "done";
      }
    } catch (error) {
      if (!currency()) return "stale";
      log(`attention: presentation refused ${error?.message ?? error}`); failure = true; closeHandle(record);
    } finally {
      if (record.attempt?.token === token) {
        if (record.state !== "SHOWN") { try { record.attempt.slot?.cancel(); } catch { /* release the preparation identity */ } }
        record.attempt = null;
      }
    }
    if (failure && current(record)) {
      clearDeadline(record);
      if (!record.cardKey) retire(record, "rolled-back");
      else if (state === "ORPHAN") retire(record, "counted");
      else { record.state = "ORPHAN"; closePayload(record); await orphanRoute(record); }
    }
    return "done";
  }
  function gone(s, payload) {
    if (!s || !(s.ledger instanceof Set) || payload?.session !== s.session || !text(payload.ref, 64) || !Number.isInteger(payload.gen)) return { ok: false };
    const record = records.get(keyOf(s, payload.ref));
    if (!s.alive || !record || record.state !== "SENT" || record.gen !== payload.gen) return stale(s);
    supersede(record);
    if (!record.cardKey) retire(record, "rolled-back"); else { record.state = "ORPHAN"; closePayload(record); void orphanRoute(record); }
    return reply(s, { ok: true });
  }
  // R3: bounds are checked in main and in both preloads; a list past the ledger bound is ignored whole.
  function freed(s, refs) { if (validSession(s) && Array.isArray(refs) && refs.length <= LEDGER_MAX) for (const ref of refs) if (typeof ref === "string") s.ledger.delete(ref); }
  function sessionEnded(webContentsId, session, s) {
    if (!s || s.webContentsId !== webContentsId || s.session !== session) return;
    s.alive = false; s.ledger.clear(); sessions.delete(s);
    for (const record of [...records.values()]) {
      if (record.owner !== s || ["SHOWN", "ORPHAN"].includes(record.state)) continue;
      const was = record.state; if (was === "SENT") supersede(record);
      if (!record.cardKey) { retire(record, "counted"); continue; }
      record.state = "ORPHAN";
      if (was === "HELD") hold(record); else void orphanRoute(record);
    }
    syncWatch();
  }
  function visible(s, payload) {
    if (!validSession(s) || stopped || !payload || (payload.threadId !== null && !text(payload.threadId))) return { ok: false };
    router.visible(payload.threadId, payload.focused === true, s.home); return reply(s, { ok: true });
  }
  function settled(home, threadId, requestId) {
    if (!text(threadId) || !text(requestId)) return false;
    const result = router.settled(threadId, requestId, home); syncWatch(); return result;
  }
  function reconcile(home) {
    if (reconciling) { reconcileAgain = true; return reconciling; }
    reconciling = (async () => {
      try { do { reconcileAgain = false; await router.reconcile(home); } while (reconcileAgain); }
      catch (error) { log(`attention: reconcile failed ${error?.message ?? error}`); }
      finally { reconciling = null; syncWatch(); }
    })(); return reconciling;
  }
  async function previewsCheck(home = "local") {
    let value; try { value = await deps.readPreviews?.(home); } catch { value = null; }
    if (typeof value !== "boolean") { lastPreviews.delete(home); return false; }
    const before = lastPreviews.get(home); lastPreviews.set(home, value);
    const changed = before === undefined ? value === false : value !== before;
    if (changed) {
      if (!value) router.previewsChanged(home);
      for (const s of sessions) if (s.home === home) send(s, { type: "previews", previews: value });
      try { deps.onPreviewsChanged?.(home); } catch { /* independent consumer */ }
    }
    return changed;
  }
  function watcherFrame(frame) {
    if (frame?.kind === "attention.settled") settled("local", frame.threadId, frame.requestId);
    else if (frame?.kind === "config") void previewsCheck("local");
  }
  function homeGone(home) {
    epochs.set(home, (epochs.get(home) ?? 0) + 1); lastPreviews.delete(home);
    for (const record of [...records.values()]) if (record.home === home) retire(record, "settled");
    router.homeGone(home); syncWatch();
  }
  function dispose() {
    stopped = true;
    for (const record of [...records.values()]) retire(record, "settled");
    sessions.clear(); router.quietHoursUntil(null); syncWatch();
  }
  deps.nativeApprovals?.setOnEvict?.(key => {
    for (const record of records.values()) if (record.handle === `n:${key}`) { retire(record, "evicted"); break; }
  });
  return { hello, offer, present, gone, freed, sessionEnded, visible, settled, reconcile, previewsCheck, watcherFrame,
    serverChanged: () => homeGone("local"), homeGone, dispose, closeAll: dispose, records, router,
    quietChanged: async () => { await router.quietChanged(); syncWatch(); }, quietHoursUntil: (endsAt, onEnd) => router.quietHoursUntil(endsAt, onEnd) };
}
