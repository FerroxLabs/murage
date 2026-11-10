// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 S4b/S4c, wired into S3R: the actionable banners (electron/mac-banners.mjs, electron/linux-notify.mjs) behind
// the ONE native seam createAttentionMain already has (`nativeApprovals`: handles / prepare / present / close / setOnEvict).
//
//   prepare   reads the card once through the home's transport and SNAPSHOTS that transport and its identity next to the words: a
//             profile switch, an old server run or a swapped Cloud window can then never receive an answer minted for another one.
//             On a Mac the existing notifier's prepare runs first (notification permission, card re-read), so authority is unchanged.
//   present   is synchronous, as S3R requires (it is the commit point). The banner post is asynchronous: the card is SHOWN at once,
//             and when the banner service refuses the post the fallback notice (the existing notifier on a Mac, a plain main notice
//             on Linux) is shown instead, or `onFailed` retires the card to the counts when nothing can show it.
//   close     withdraws whichever of banner, fallback notice or pending post this key owns (settle, previews change, eviction).
//
// Nothing here decides routing, presence, previews or quiet: those are createAttentionMain's, before `present` is called.
export const MAX_ENTRIES = 1024; // the router's tracked-card bound: a banner entry exists only for a tracked card
export function createBannerApprovals({ banner = null, base = null, createNotice = null, transportFor, mint, actionsOn = () => true, log = () => {} }) {
  const entries = new Map(); // key -> { closed, failed, ids, notice }; bounded by MAX_ENTRIES, and emptied by every close and every failure
  const say = line => { try { log(line); } catch { /* logging never interrupts delivery */ } };
  const homeOf = key => String(key).split("|")[0];
  const bannerUsable = () => { try { return banner?.available?.() === true; } catch { return false; } };

  function handles() { return bannerUsable() || base !== null; }

  async function readCard(home, input) {
    let transport;
    try { transport = transportFor?.(home) ?? null; } catch { transport = null; }
    if (!transport || !input.threadId || !input.messageId) return { transport: null, identity: null, card: null };
    let identity = null, card = null;
    try { identity = transport.current(); } catch { identity = null; }
    if (typeof identity !== "string" || identity.length === 0) return { transport, identity: null, card: null };
    // The same currency test the action path applies: a session refresh or window swap during the read stops the send and voids the card.
    const same = () => { try { return transport.current() === identity; } catch { return false; } };
    const guard = () => { if (!same()) throw Object.assign(new Error("transport"), { guardReason: "transport" }); };
    try { card = await transport.readCard({ threadId: input.threadId, messageId: input.messageId }, guard); } catch { card = null; }
    if (!same()) card = null; // the card came from another identity than the one the token would be bound to
    // A card that is not the one named, or is no longer open, carries no buttons (the action path re-checks at answer time).
    if (!card || card.open === false || (input.requestId && card.requestId !== undefined && card.requestId !== input.requestId)) card = null;
    return { transport, identity, card };
  }

  async function prepare(input, options = {}) {
    const key = options.key, home = homeOf(key);
    let inner = null;
    if (base) {
      const result = await base.prepare(input, options);
      if (!result?.ok) return { ok: false };
      inner = result.prepared;
    } else {
      try { options.onSlot?.({ cancel() {} }); } catch { /* the caller's cancellation hook is optional */ }
    }
    // A banner service that cannot post (no daemon, no `actions` capability, answering off) returns null from show: the fallback notice runs then.
    const useBanner = bannerUsable();
    const words = inner?.words ?? { title: input.title, body: input.body };
    if (!useBanner) return { ok: true, prepared: { words, inner, banner: false } };
    const { transport, identity, card } = await readCard(home, input);
    return { ok: true, prepared: { words, inner, banner: true, transport, identity, card,
      epoch: options.epoch, home, route: { botId: input.botId, threadId: input.threadId, messageId: input.messageId, requestId: input.requestId } } };
  }

  // Every failure path ends here: the entry is released (main clears its handle before it retires the card, so close() never runs for it),
  // whatever this key had posted is withdrawn, and the card is handed back once.
  function fail(key, entry, onFailed) {
    if (entry.failed) return;
    entry.failed = true; entry.closed = true;
    if (entries.get(key) === entry) entries.delete(key);
    if (entry.ids) { try { banner.close(entry.ids); } catch { /* withdrawing a gone banner */ } entry.ids = null; }
    if (entry.notice) { const shown = entry.notice; entry.notice = null; try { shown.removeAllListeners?.(); } catch { /* gone */ } try { shown.close?.(); } catch { /* gone */ } }
    try { onFailed?.(key); } catch { /* the card is retired */ }
  }

  function notice(entry, prepared, options) {
    // The existing notifier on a Mac; on Linux a plain main notice (never a renderer fallback, never a second hand-off).
    const onFailed = () => fail(options.key, entry, options.onFailed);
    if (base && prepared.inner) {
      prepared.inner.words = prepared.words;
      let result = null;
      try { result = base.present(prepared.inner, { key: options.key, onFailed, onClick: options.onClick }); } catch { result = null; }
      if (!result?.accepted) onFailed();
      return;
    }
    if (typeof createNotice !== "function") { onFailed(); return; }
    try {
      const shown = createNotice({ title: prepared.words.title, body: prepared.words.body, silent: options.silent === true });
      entry.notice = shown;
      shown.on("failed", () => { if (!entry.closed) onFailed(); });
      shown.on("click", () => { if (!entry.closed) { try { options.onClick?.(); } catch { /* navigation failure never changes authority */ } } });
      shown.show();
    } catch { onFailed(); }
  }

  // A fallback shown after an asynchronous refusal is a presentation like any other: presence is read again first (sharing, a lock or
  // Focus may have begun since the commit), and anything but a clear yes retires the card to the counts.
  async function mayShowNow(options) {
    try { return typeof options.canShow === "function" && (await options.canShow()) === true; } catch { return false; }
  }

  function present(prepared, options = {}) {
    const key = options.key;
    if (!prepared || typeof key !== "string" || entries.has(key) || entries.size >= MAX_ENTRIES) return { accepted: false };
    const entry = { closed: false, failed: false, ids: null, notice: null };
    entries.set(key, entry);
    if (!prepared.banner) {
      notice(entry, prepared, options);
      return { accepted: true, handle: `n:${key}` };
    }
    const frame = { kind: "approval", ...prepared.route };
    const shownEntry = { home: prepared.home, epoch: prepared.epoch, frame };
    void (async () => {
      let ids = null;
      try {
        // `cancelled` lets the banner service stop before it mints a token or posts when the card settled while the bus was still coming up.
        ids = await banner.show({ entry: shownEntry, record: options.previews === true ? prepared.card : null, actionsOn: actionsOn() === true,
          silent: options.silent === true, plain: prepared.words, transport: prepared.transport, identity: prepared.identity, cancelled: () => entry.closed });
      } catch { say("banner: post failed"); ids = null; }
      if (entry.closed) { if (Array.isArray(ids) && ids.length > 0) { try { banner.close(ids); } catch { /* withdrawing a gone banner */ } } return; }
      if (Array.isArray(ids) && ids.length > 0) { entry.ids = ids; return; }
      if (!await mayShowNow(options)) { fail(key, entry, options.onFailed); return; }
      if (entry.closed) return;
      // The synchronous twin of canShow, evaluated at the moment of presentation: evidence that landed after the read cannot slip between them.
      let clear = true;
      try { clear = typeof options.stillClear !== "function" || options.stillClear() === true; } catch { clear = false; }
      if (!clear) { fail(key, entry, options.onFailed); return; }
      notice(entry, prepared, options);
    })();
    return { accepted: true, handle: `n:${key}` };
  }

  function close(key) {
    const entry = entries.get(key);
    let closed = false;
    if (entry) {
      entries.delete(key); entry.closed = true; closed = true;
      if (entry.ids) { try { banner.close(entry.ids); } catch { /* withdrawing a gone banner */ } }
      if (entry.notice) { try { entry.notice.close(); } catch { /* a notice already gone */ } try { entry.notice.removeAllListeners?.(); } catch { /* gone */ } }
    }
    if (base) { try { closed = base.close(key) === true || closed; } catch { /* the notifier may be gone */ } }
    return closed;
  }

  function dispose() {
    for (const key of [...entries.keys()]) close(key);
    try { banner?.dispose?.(); } catch { /* shutting down */ }
  }

  return { handles, prepare, present, close, dispose, setOnEvict: fn => { try { base?.setOnEvict?.(fn); } catch { /* optional */ } }, size: () => entries.size };
}
