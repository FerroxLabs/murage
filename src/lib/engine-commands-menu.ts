// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The engine group in the composer's "/" menu (shared/engine-commands.ts):
// which of the bot's engine commands match what is typed, what picking one
// does, and what the menu says before the engine has reported. Pure and out
// of the component, like composer-commands.ts, so it can be tested without
// mounting the composer.
import type { EngineCommand, EngineCommandsView } from "../../shared/engine-commands";

/** Commands whose name starts with the query, then the ones whose
 * description mentions it, each group in the engine's own order. */
export function matchEngineCommands(commands: readonly EngineCommand[], query: string): EngineCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const byName = commands.filter((command) => command.name.toLowerCase().startsWith(q));
  const byDescription = commands.filter(
    (command) => !byName.includes(command) && (command.description ?? "").toLowerCase().includes(q),
  );
  return [...byName, ...byDescription];
}

/** A command that takes input goes into the draft with the caret after it,
 * so the owner can type what it needs. One that takes none is sent as it
 * is, the way the engine's own terminal runs it on Enter. */
export function engineCommandPick(command: EngineCommand): { kind: "insert" | "send"; text: string } {
  return command.hint ? { kind: "insert", text: `/${command.name} ` } : { kind: "send", text: `/${command.name}` };
}

/** The line under the engine heading when there is nothing to pick yet. */
export function engineCommandsNote(view: EngineCommandsView | null): string | null {
  return view?.status === "unknown" ? `Start a chat to load ${view.engine} commands` : null;
}
