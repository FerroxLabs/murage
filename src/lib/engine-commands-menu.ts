// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The engine group in the composer's "/" menu (shared/engine-commands.ts):
// which of the bot's engine commands match what is typed, what picking one
// does, and what the menu says before the engine has reported. Pure and out
// of the component, like composer-commands.ts, so it can be tested without
// mounting the composer.
import type { EngineCommand, EngineCommandsView } from "../../shared/engine-commands";

// PROVISIONAL INTERFACE: mirrors frozen F8/1B shared/audience-wire.ts until
// that independently owned module lands on the integration branch.
export type DisplayCommand = Readonly<{ handle: string; label: string; description?: string; hint?: string; takesArguments: boolean }>;
export type DisplayCommandsView = Readonly<{ engine: string; driver: string; status: "ready" | "unknown" | "unsupported"; commands: readonly DisplayCommand[] }>;
export const commandLabel = (command: EngineCommand | DisplayCommand): string => "handle" in command ? command.label : command.name;

/** Commands whose name starts with the query, then the ones whose
 * description mentions it, each group in the engine's own order. */
export function matchEngineCommands<T extends EngineCommand | DisplayCommand>(commands: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const byName = commands.filter((command) => commandLabel(command).toLowerCase().startsWith(q));
  const byDescription = commands.filter(
    (command) => !byName.includes(command) && (command.description ?? "").toLowerCase().includes(q),
  );
  return [...byName, ...byDescription];
}

/** A command that takes input goes into the draft with the caret after it,
 * so the owner can type what it needs. One that takes none is sent as it
 * is, the way the engine's own terminal runs it on Enter. */
export function engineCommandPick(command: EngineCommand | DisplayCommand): { kind: "insert" | "send"; text: string; commandHandle?: string } {
  const takesArguments = "handle" in command ? command.takesArguments : Boolean(command.hint);
  return { kind: takesArguments ? "insert" : "send", text: `/${commandLabel(command)}${takesArguments ? " " : ""}`,
    ...("handle" in command ? { commandHandle: command.handle } : {}),
  };
}

/** Only a menu selection grants a handle; typing identical display text does
 * not. Preserve argument bytes after the one separator inserted by the UI. */
export function selectedCommandSend(command: DisplayCommand, draft: string, sendId: string) {
  const prefix = `/${command.label}`;
  if (draft !== prefix && !draft.startsWith(prefix + " ")) return null;
  return { commandHandle: command.handle, args: draft === prefix ? "" : draft.slice(prefix.length + 1), sendId };
}

/** The line under the engine heading when there is nothing to pick yet. */
export function engineCommandsNote(view: EngineCommandsView | DisplayCommandsView | null): string | null {
  return view?.status === "unknown" ? `Start a chat to load ${view.engine} commands` : null;
}
