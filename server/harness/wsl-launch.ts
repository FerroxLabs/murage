// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G9, adapted from OpenMausBot efc8b350a. On Windows an engine whose own command starts it through wsl.exe (or the
// System32 bash.exe that forwards to WSL) can chat, but Murage's tool servers are Windows programs it can neither
// start nor reach from inside WSL, so team, browser, computer and data tools are missing with no word why. Settings
// says so on that engine. Nothing changes on other platforms or for a native install.
import { win32 } from "node:path";

import type { ProviderSnapshot } from "../contracts.ts";
import { splitCliString } from "../env-path.ts";

/** The line on the engine's Settings row (customer-facing words: MurageMain signs off on them). */
export const WSL_ENGINE_NOTE =
  "This engine's command starts it inside WSL, so it can chat but cannot use Murage's tools (team, browser, computer, data and the rest). " +
  "To get them, install the engine on Windows itself and point its program location at that install.";

/** Whether an engine's own command starts it through WSL on Windows: wsl.exe, or the bash.exe in System32 that forwards
 *  to WSL (Git Bash's bash.exe is a native Windows program and is not counted). Never true off Windows. */
export function launchesThroughWsl(cli: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32" || !cli) return false;
  const head = (splitCliString(cli)[0] ?? "").toLowerCase();
  const name = win32.basename(head);
  if (name === "wsl" || name === "wsl.exe") return true;
  return /[\\/]windows[\\/](system32|sysnative)[\\/]bash(\.exe)?$/.test(head);
}

/** An available engine's status with the WSL line added when its command goes through WSL, unless the engine already
 *  shows a line of its own there. An unavailable engine keeps just its reason: it cannot chat either. */
export function withWslNote(snapshot: ProviderSnapshot, cli: string | undefined, platform: NodeJS.Platform = process.platform): ProviderSnapshot {
  const note = snapshot.state === "available" && !snapshot.versionNote && launchesThroughWsl(cli, platform);
  return note ? { ...snapshot, versionNote: WSL_ENGINE_NOTE } : snapshot;
}
