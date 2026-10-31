// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { knownComputer } from "./surface";

/** Whether this renderer is the owner's computer, for the choices only the computer makes (a bot-level "Always": its save,
 * its Undo and its take-back in Settings, and copying the bot's permissions onto a chat). The server's `isOwnersComputer`
 * decides; this only keeps the page from offering a row the route refuses. On a Cloud home the server answers false for
 * every surface, including a desktop app signed in to it (it has the Electron bridge and is still not the computer), so
 * the bridge never overrides `computer: false`. A harness without the `computer` field keeps the desktop answer.
 * `desktop` is `useDesktopSurface()` (true, false, or undefined while unasked). */
export function resolveComputer(desktop: boolean | undefined, computer: boolean | undefined): boolean | undefined {
  if (desktop !== true) return desktop;
  return computer !== false;
}

/** `resolveComputer` for this page. Not a hook: it re-renders with `useDesktopSurface`, whose `/api/config` fetch also
 * carries `computer`. */
export function computerHere(desktop: boolean | undefined): boolean | undefined {
  return resolveComputer(desktop, knownComputer());
}
