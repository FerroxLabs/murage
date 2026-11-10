// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Retain mounted card identities while replacing authority. A failed read
 * forgets all retained content; only a successful read can restore controls. */
export function createItemsReader({ read, valid, publish }) {
  let alive = true, pending = null, again = false;
  let state = { data: null, refreshing: true, failed: false };
  const update = patch => {
    state = { ...state, ...patch };
    if (alive) publish(state);
  };
  const drain = async () => {
    do {
      again = false;
      try {
        const result = await Promise.resolve().then(() => alive ? read() : null);
        if (!alive) return null;
        if (!result.ok || !("items" in result) || !valid(result)) {
          update({ data: null, failed: true });
        } else if (!again) update({ data: result, failed: false });
      } catch {
        if (!alive) return null;
        update({ data: null, failed: true });
      }
    } while (alive && again);
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
    dispose() { alive = false; },
  };
}
