// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

const STALL_AFTER = 8;
const cardIdsOf = data => new Set([
  ...(Array.isArray(data?.items) ? data.items.map(item => item?.cardId) : []),
  ...(Array.isArray(data?.bots) ? data.bots.map(bot => bot?.item?.cardId) : []),
].filter(id => typeof id === "string"));

/** Retain mounted card identities while replacing authority.
 *
 * A read the host reports as superseded (a newer read or a push overtook it) is
 * a wait, never a failure: the reader reads again, backing off after eight
 * misses and publishing `stalled` once while it keeps the last data and drafts
 * (controls stay disabled; the host has already retired the old tokens). Every
 * other refusal, a throw or invalid data is terminal: it forgets all retained
 * content and drafts, and only a successful read can restore controls. Every
 * accepted commit is published at once and prunes drafts of cards that are gone.
 * `rev` (host-wide, increasing) lets the reader refuse a result older than the
 * newest one it applied; results without a rev (legacy hosts) are accepted.
 * Unsent drafts live here, keyed by cardId, so a card that unmounts and comes
 * back with the same cardId gets its draft back. */
export function createItemsReader({ read, valid, publish, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let alive = true, pending = null, again = false, misses = 0, appliedRev = -Infinity, backoff = null;
  let state = { data: null, refreshing: true, failed: false, stalled: false, drafts: {} };
  const update = patch => {
    state = { ...state, ...patch };
    if (alive) publish(state);
  };
  const prune = (drafts, data) => {
    const keep = cardIdsOf(data), next = {};
    for (const id of Object.keys(drafts)) if (keep.has(id)) next[id] = drafts[id];
    return next;
  };
  const wait = ms => new Promise(resolve => {
    const timer = setTimer(() => { backoff = null; resolve(); }, ms);
    backoff = { timer, resolve };
  });
  const classify = result => {
    if (result.ok === false && result.reason === "superseded") return "miss";
    if (!result.ok || !("items" in result) || !valid(result)) return "terminal";
    if (Number.isInteger(result.rev) && result.rev <= appliedRev) return "miss";
    return "accepted";
  };
  const drain = async () => {
    for (;;) {
      again = false;
      let outcome, result;
      try {
        result = await Promise.resolve().then(() => alive ? read() : null);
        if (!alive) return null;
        outcome = classify(result);
      } catch {
        if (!alive) return null;
        outcome = "terminal";
      }
      if (outcome === "miss") {
        misses++;
        if (misses >= STALL_AFTER) {
          if (!state.stalled) update({ stalled: true });
          await wait(Math.min(250 * (misses - (STALL_AFTER - 1)), 2000));
          if (!alive) return null;
        }
        continue;
      }
      misses = 0;
      if (outcome === "accepted") {
        if (Number.isInteger(result.rev)) appliedRev = result.rev;
        update({ data: result, failed: false, stalled: false, drafts: prune(state.drafts, result) });
      } else update({ data: null, failed: true, stalled: false, drafts: {} });
      if (!alive || !again) break;
    }
    pending = null;
    update({ refreshing: false });
    return state.data;
  };
  return {
    refresh() {
      if (!alive) return Promise.resolve(null);
      if (pending) { again = true; return pending; }
      update({ refreshing: true });
      pending = drain();
      return pending;
    },
    setDraft(cardId, draft) {
      if (!alive || !state.data || !cardIdsOf(state.data).has(cardId) || typeof draft?.text !== "string") return;
      update({ drafts: { ...state.drafts, [cardId]: { text: draft.text, replying: draft.replying === true } } });
    },
    clearDraft(cardId) {
      if (!alive || !Object.hasOwn(state.drafts, cardId)) return;
      const { [cardId]: _gone, ...rest } = state.drafts;
      update({ drafts: rest });
    },
    dispose() {
      alive = false;
      state = { ...state, drafts: {} };
      if (backoff) { clearTimer(backoff.timer); backoff.resolve(); backoff = null; }
    },
  };
}
