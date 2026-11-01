// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

const REASONS = new Set(["update", "backup", "quit", "system-shutdown", "restart"]);

/** Why this app run stops its server, logged once as the stop begins. An ordinary Quit
 * sets nothing, so `quit` is what remains when no path named another reason. The first
 * named reason stands; a stop that has been logged does not change. */
export function createServerStopReason(log) {
  let reason = null;
  let logged = false;
  return {
    note(next) {
      if (!logged && reason === null && REASONS.has(next)) reason = next;
    },
    logOnce() {
      if (logged) return;
      logged = true;
      log(`server stop reason=${reason ?? "quit"}`);
    },
  };
}
