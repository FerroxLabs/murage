// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// meetgreet 1.0.19: a second Murage started with its own profile (MURAGE_USER_DATA / MURAGE_DATA_DIR) beside the owner's
// normal Murage closed by itself four times with nothing on screen and no cause in its log. Both copies share one bundle id,
// so a quit sent to "Murage" by another app (AppleScript, an installer, the Dock) can land on either. Every quit now leaves
// one line naming its cause and profile, and a quit the person did not ask for in a separate-profile copy says so on screen.

/** @param {{ cause: string | null | undefined, customProfile: boolean }} quit */
export function quitAnnouncement({ cause, customProfile }) {
  const named = typeof cause === "string" && /^[a-z-]{1,32}$/.test(cause) ? cause : "unclassified";
  const log = `desktop quit cause=${named} profile=${customProfile ? "separate" : "default"}`;
  if (!customProfile || named === "owner") return { log, notice: null };
  const why = named === "system"
    ? "Your computer asked it to quit."
    : named === "automatic"
      ? "Murage closed it to finish a backup, a restart or an update step."
      : "Another app asked Murage to quit, and this copy received the request.";
  return {
    log,
    notice: { title: "Murage (separate profile) is closing", body: `${why} Your chats are saved. Open it again with the same launcher.` },
  };
}
