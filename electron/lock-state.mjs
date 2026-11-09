// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One module that says whether the screen is locked (NOTIFY-EVERYWHERE-1019 section 5.2 #3, owned by S4a, consumed by S3B).
// Sources: the existing powerMonitor lock-screen / unlock-screen / suspend events on every OS, and an injected `readLocked()` that
// returns an EXPLICIT boolean (main wires Electron's getSystemIdleState(1) === "locked" on Mac and Windows, logind LockedHint on
// Linux). The state starts UNKNOWN on every OS, and UNKNOWN counts as locked, so Allow and Reply are refused until something has
// observed "unlocked". Only a real boolean unlocks: any other reader result (undefined, null, a string) is unknown. A refresh whose
// result arrives after a newer event is discarded. No timers: it only reacts to events and to refresh().

export function createLockState({ powerMonitor = null, readLocked = null }) {
  let state = "unknown";
  let generation = 0; // bumped by every EVENT (lock, unlock, suspend, markUnknown), so a slow refresh cannot overwrite a newer event
  let requestSeq = 0; // bumped by every refresh start: only the latest request's answer is applied (an older false never preserves "unlocked")
  const listeners = new Set();
  const locked = () => state !== "unlocked";
  const set = (next, fromRefresh = false) => {
    if (!fromRefresh) generation += 1;
    const before = locked();
    state = next;
    const after = locked();
    if (before !== after) for (const listener of [...listeners]) { try { listener(after); } catch { /* a listener never breaks the lock state */ } }
  };
  if (powerMonitor && typeof powerMonitor.on === "function") {
    powerMonitor.on("lock-screen", () => set("locked"));
    powerMonitor.on("unlock-screen", () => set("unlocked"));
    // Suspend counts as locked until an unlock event or a refresh says otherwise.
    powerMonitor.on("suspend", () => set("locked"));
  }
  return {
    locked,
    state: () => state,
    /** The OS can no longer be watched (Linux: the logind monitor died): fail closed until something reads an explicit boolean again. */
    markUnknown() { set("unknown"); },
    onChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    /** Read the OS now. Only an explicit true or false counts; anything else, or a failed read, is unknown (locked). */
    async refresh() {
      if (typeof readLocked !== "function") return locked();
      const started = generation, seq = ++requestSeq;
      let result;
      try { result = await readLocked(); } catch { result = undefined; }
      if (generation !== started || seq !== requestSeq) return locked(); // a newer event or a newer read decided while this one was in flight
      set(result === true ? "locked" : result === false ? "unlocked" : "unknown", true);
      return locked();
    },
  };
}
