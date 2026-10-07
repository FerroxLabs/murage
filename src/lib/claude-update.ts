// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { InstanceInfo } from "@/state/store";

/** The engine a "Claude Code is too old for this model" error may offer to
 * update: only a Claude Code engine (upstream #1840). */
export function claudeUpdateTarget(engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return engine?.driverKind === "claudeAgent" ? engine : undefined;
}

/** The command to update this engine's Claude Code by hand: its configured
 * executable when it has one, quoted if it has spaces, else `claude`. */
export function claudeUpdateCommand(cli: string | undefined): string {
  const exe = cli?.trim() || "claude";
  return `${/\s/.test(exe) ? `"${exe}"` : exe} update`;
}
