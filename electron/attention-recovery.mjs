// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs

const LEAVE_SETTLE_MS = 1500, POLL_MS = 30_000, READ_MS = 3000, CARD_READ_MS = 2000, FRESH_MS = 4000;
const PASS_CARD_READS = 3, MAX_READS = 12;
const RETRY_MS = [5000, 15_000, 60_000, 300_000];

export const stableCardId = (home, threadId, requestId) => JSON.stringify([home, threadId, requestId]);
function remember(set, key, limit = 1024) {
  set.add(key);
  if (set.size > limit) set.delete(set.values().next().value);
}
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 256;

export function createAttentionRecovery(deps) {
  const { now, setTimer, clearTimer, router, log } = deps;
  const noticed = new Set(), recoveryPosted = new Set(), batchKeys = new Set(), settledDuring = new Set();
  const coveredThrough = new Map(), pending = new Set(), sounds = new Map(), readTimers = new Map(), failedCards = new Set();
  let credit = null, leftAt = null, leaveSeq = 0, token = 0, passSeq = 0, candidate = null, active = null;
  let lastShown = null, previousShown = null, stopped = false, running = false, again = false, holdForPresence = false;
  let eventOrder = 0, leftOrder = 0;
  const enabled = typeof deps.isAppFocused === "function" && typeof deps.prefsTrusted === "function";
  let leaveTimer = null, pollTimer = null, retryTimer = null, retryStep = 0, leaveOwed = false, prefsLogged = false;
  const shuttingDown = () => !enabled || stopped || deps.shuttingDown?.() === true;
  const away = () => { try { return deps.isAppFocused?.() === false; } catch { return false; } };
  const settled = () => leftAt !== null && now() - leftAt >= LEAVE_SETTLE_MS;
  const livePaid = () => lastShown !== null
    && (lastShown.at > credit.cut || (lastShown.at === credit.cut && lastShown.order > credit.cutOrder));

  function clearRetry() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }
  function hold(value) {
    if (holdForPresence === value) return;
    holdForPresence = value;
    deps.syncWatch();
  }
  function lapse() {
    credit = null;
    retryStep = 0;
    clearRetry();
    hold(false);
  }
  function closeActive() {
    if (!active) return false;
    const { notice } = active;
    active = null;
    notice.removeAllListeners();
    try { notice.close(); } catch { /* Already discarded by the OS. */ }
    return true;
  }
  function shown(key) {
    remember(noticed, key);
    previousShown = lastShown;
    lastShown = { key, at: now(), order: ++eventOrder };
  }
  function unshown(key) {
    noticed.delete(key);
    recoveryPosted.delete(key);
    if (previousShown?.key === key) previousShown = null;
    if (lastShown?.key === key) { lastShown = previousShown; previousShown = null; }
  }

  function syncPoll() {
    const poll = !shuttingDown() && leftAt === null
      && (credit !== null || router.snapshot().needsYou > 0);
    if (!poll && pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; }
    if (poll && pollTimer === null) {
      pollTimer = setTimer(() => { pollTimer = null; focusChanged(); }, POLL_MS);
    }
  }
  function armLeave() {
    if (leaveTimer !== null || leftAt === null) return;
    const seq = leaveSeq;
    leaveTimer = setTimer(() => {
      leaveTimer = null;
      if (shuttingDown() || seq !== leaveSeq) return;
      if (!away()) { focusChanged(); return; }
      router.clearFocus();
      if (leaveOwed) { leaveOwed = false; earn("all", [], leftAt, true); }
      else requestPass();
    }, Math.max(0, leftAt + LEAVE_SETTLE_MS - now()));
  }
  function focusChanged() {
    if (shuttingDown()) return;
    if (away()) {
      if (leftAt === null) {
        leftAt = now();
        leftOrder = ++eventOrder;
        leaveSeq++;
        leaveOwed = true;
        armLeave();
      }
    } else if (leftAt !== null) {
      leftAt = null;
      leaveSeq++;
      token++;
      if (leaveTimer !== null) clearTimer(leaveTimer);
      leaveTimer = null;
      clearRetry();
      hold(false);
    }
    syncPoll();
  }
  function earn(full, delta, since, leave = false) {
    if (shuttingDown()) return;
    const order = leave ? leftOrder : ++eventOrder;
    if (!credit) {
      credit = { full: new Set(), delta: new Set(), since, cut: since, cutOrder: order, refunded: false, tried: new Map(), reads: 0, reruns: 0, requeues: 0 };
    } else {
      credit.since = Math.min(credit.since, since);
      if (leave && since >= credit.cut) { credit.cut = since; credit.cutOrder = order; }
      for (const [key, state] of credit.tried) if (state === "ineligible") credit.tried.delete(key);
      if (running && credit.full !== "all" && (full === "all" || full.some(home => !credit.full.has(home))
        || delta.some(home => !credit.full.has(home) && !credit.delta.has(home)))) token++;
    }
    if (full === "all") credit.full = "all";
    else if (credit.full !== "all") for (const home of full) credit.full.add(home);
    for (const home of delta) credit.delta.add(home);
    requestPass();
  }
  function lifecycle(home, key) {
    if (shuttingDown() || batchKeys.has(key)) return;
    remember(batchKeys, key, 256);
    if (deps.homeExpected(home)) pending.add(home);
    else pending.delete(home);
    earn([], [home], now());
  }

  function retry() {
    if (retryTimer !== null || !away() || shuttingDown()) return;
    hold(false);
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (credit) { credit.reads = 0; credit.reruns = 0; credit.requeues = 0; requestPass(); }
    }, RETRY_MS[Math.min(retryStep++, RETRY_MS.length - 1)]);
  }
  function abandon() {
    if (!credit || shuttingDown() || !away() || !settled()) return;
    if (++credit.requeues <= 4) again = true;
    else { again = false; retry(); }
  }
  function rerun() {
    if (++credit.reruns <= 2) again = true;
    else retry();
  }
  function prefsAllow() {
    try { if (deps.prefsAllow()) return true; } catch { /* Unreadable choices cannot authorize an outside notice. */ }
    if (!prefsLogged) { prefsLogged = true; log("attention: recovery banners unavailable under current preferences"); }
    lapse();
    return false;
  }
  async function readWithin(ms, read) {
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimer(() => resolve(null), ms);
      readTimers.set(timer, () => resolve(null));
    });
    try { return await Promise.race([deadline, Promise.resolve().then(read)]); }
    catch { return null; }
    finally { if (readTimers.delete(timer)) clearTimer(timer); }
  }

  function post(item, record) {
    const { key, home, threadId, messageId, botId } = item;
    const words = record.words;
    const privateWords = typeof words?.botName === "string" && typeof words?.title === "string"
      && words.botName.length <= 256 && words.title.length <= 1024;
    const options = privateWords ? { title: words.botName, body: words.title } : deps.plainWords;
    const attempt = { key, home, privateWords, outcome: "posting", notice: null };
    closeActive();
    try {
      const notice = deps.createNotice({ ...options, silent: sounds.get(home) !== true });
      attempt.notice = notice;
      notice.on("failed", () => {
        if (attempt.outcome === "posting") attempt.outcome = "failed";
        else if (attempt.outcome === "shown") {
          attempt.outcome = "failed";
          unshown(key);
          if (active === attempt) closeActive();
          if (!failedCards.has(key)) { remember(failedCards, key); log("attention: the OS refused a recovery notice"); }
        }
      });
      notice.once("click", () => deps.openRecovered?.({ home, threadId, messageId, botId }));
      notice.show();
      if (attempt.outcome === "posting") {
        attempt.outcome = "shown";
        active = attempt;
        shown(key);
        remember(recoveryPosted, key);
        return true;
      }
    } catch { /* A pre-commit failure allows one retry on this credit. */ }
    attempt.notice?.removeAllListeners();
    try { attempt.notice?.close(); } catch { /* The OS may have discarded it. */ }
    return false;
  }

  async function pass() {
    if (!credit || shuttingDown()) return;
    if (!away()) { focusChanged(); return; }
    if (leftAt === null) focusChanged();
    if (!settled() || leaveOwed) { armLeave(); return; }
    if (!prefsAllow()) return;
    if (livePaid()) { lapse(); return; }
    const t = token, seq = ++passSeq;
    settledDuring.clear();
    const valid = () => token === t && passSeq === seq && !shuttingDown() && away() && settled();
    const homes = new Set([...(credit.full === "all" ? deps.homes() : credit.full), ...credit.delta]);
    if (credit.full === "all") for (const home of pending) homes.add(home);
    const lists = await Promise.all([...homes].map(async home => {
      const transport = deps.transportFor?.(home), epoch = deps.epochOf(home);
      if (!transport) return { home, unknown: pending.has(home) && deps.homeExpected(home) };
      const identity = transport.current();
      const current = () => transport.current() === identity && deps.epochOf(home) === epoch;
      const guard = () => { if (!valid() || !current()) throw new Error("stale attention recovery read"); };
      const response = await readWithin(READ_MS, () => transport.readRecover(guard));
      if (response?.status !== 200 || !response.body || typeof response.body !== "object" || Array.isArray(response.body)) return { home, current, unknown: true };
      const body = response.body;
      if (body.mode === undefined) return { home, current };
      if (body.mode !== "recover" || !validId(body.epoch) || !Array.isArray(body.items) || body.items.length > 50) {
        return { home, current, unknown: true };
      }
      const items = body.items.filter(item => validId(item?.threadId) && validId(item.messageId) && validId(item.requestId) && Number.isFinite(item.at));
      if (items.length !== body.items.length) return { home, current, unknown: true };
      return { home, current, guard, transport, items, epoch: body.epoch };
    }));
    if (!valid() || lists.some(list => list.current && !list.current())) { abandon(); return; }
    for (const list of lists) if (!list.unknown || !deps.homeExpected(list.home)) pending.delete(list.home);
    const cover = () => {
      for (const { home, items } of lists) if (items?.length) {
        coveredThrough.set(home, Math.max(coveredThrough.get(home) ?? -Infinity, ...items.map(item => item.at)));
      }
    };
    const eligible = item => !noticed.has(item.key) && !settledDuring.has(item.key) && !deps.inFlight(item.key);
    const items = lists.flatMap(list => (list.items ?? []).map(item => ({
      ...item, botId: validId(item.botId) ? item.botId : undefined, home: list.home, list,
      key: stableCardId(list.home, item.threadId, item.requestId),
    }))).filter(item => eligible(item)
      && (credit.full === "all" || credit.full.has(item.home) || (credit.delta.has(item.home) && item.at > (coveredThrough.get(item.home) ?? -Infinity)))
      && !["closed", "ineligible"].includes(credit.tried.get(item.key)))
      .sort((a, b) => Number(credit.tried.has(a.key)) - Number(credit.tried.has(b.key)) || b.at - a.at);
    if (items.length) {
      const snapshot = await deps.refresh();
      if (!valid()) { abandon(); return; }
      if (router.quietReason(snapshot)) { hold(true); return; }
    }
    hold(false);
    for (const item of items.slice(0, PASS_CARD_READS)) {
      if (!eligible(item)) continue;
      candidate = item;
      const sentAt = now();
      const { list, key } = item;
      const record = await readWithin(CARD_READ_MS, () => list.transport.readRecoverCard(item, list.guard));
      if (!valid() || !list.current()) { abandon(); return; }
      credit.reads++;
      if (!record) { credit.tried.set(key, "unknown"); candidate = null; continue; }
      if (!record.open) { credit.tried.set(key, "closed"); candidate = null; continue; }
      const quietIn = record.quietStartsInMs;
      if (record.threadId !== item.threadId || record.messageId !== item.messageId || record.requestId !== item.requestId
        || record.epoch !== list.epoch || record.notifyOk !== true || (quietIn !== null && (!Number.isFinite(quietIn) || quietIn < 0))) {
        credit.tried.set(key, "ineligible"); candidate = null; continue;
      }
      const snapshot = await deps.refresh();
      if (!valid() || !list.current()) { abandon(); return; }
      if (router.quietReason(snapshot)) { hold(true); return; }
      if (!prefsAllow()) return;
      if (livePaid()) { cover(); lapse(); return; }
      if (!eligible(item)) { candidate = null; continue; }
      if (now() - sentAt > FRESH_MS || deps.presenceRev() !== snapshot.rev) { rerun(); return; }
      if (quietIn !== null && now() >= sentAt + quietIn) {
        credit.tried.set(key, "ineligible"); candidate = null; continue;
      }
      if (post(item, record)) { cover(); lapse(); }
      else if (!credit.refunded) { credit.refunded = true; again = true; }
      else { cover(); lapse(); }
      return;
    }
    if (items.some(item => eligible(item) && !credit.tried.has(item.key)) && credit.reads < MAX_READS) again = true;
    else if (lists.some(list => list.unknown) || items.some(item => eligible(item) && credit.tried.get(item.key) === "unknown")) retry();
    else { cover(); lapse(); }
  }

  function requestPass() {
    if (shuttingDown()) return;
    syncPoll();
    if (running) { again = true; return; }
    running = true;
    void (async () => {
      try {
        do { again = false; await pass(); candidate = null; } while (again && !shuttingDown());
      } catch {
        log("attention: recovery check failed");
        retry();
      } finally { candidate = null; running = false; syncPoll(); }
    })();
  }

  return {
    start() {
      if (shuttingDown()) return;
      if (away()) { leftAt = now(); armLeave(); }
      lifecycle("local", "start|local");
    },
    requestPass, focusChanged, syncPoll, lifecycle, shown, unshown, recoveryPosted,
    get holdForPresence() { return holdForPresence; },
    release: homes => earn(homes, [], now()),
    sounds(home, enabled) { if (typeof enabled === "boolean") sounds.set(home, enabled); },
    settled(home, threadId, requestId) {
      const key = stableCardId(home, threadId, requestId);
      if (active?.key === key) closeActive();
      if (!running) return;
      settledDuring.add(key);
      if (candidate?.key === key) token++;
    },
    homeGone(home) {
      if (active?.home === home) closeActive();
      sounds.delete(home);
      token++;
      lifecycle(home, JSON.stringify(["epoch", home, deps.epochOf(home)]));
    },
    configChanged(home, botId) {
      if (running && (!botId || (candidate?.home === home && (!candidate.botId || botId === candidate.botId)))) token++;
    },
    previewsOff(home, onlyPrivate) {
      if (active?.home === home && (!onlyPrivate || active.privateWords)) { closeActive(); if (running) token++; }
    },
    stop() {
      stopped = true;
      token++;
      lapse();
      if (leaveTimer !== null) clearTimer(leaveTimer);
      if (pollTimer !== null) clearTimer(pollTimer);
      leaveTimer = pollTimer = null;
      for (const [timer, cancel] of readTimers) { clearTimer(timer); cancel(); }
      readTimers.clear();
      closeActive();
    },
  };
}
