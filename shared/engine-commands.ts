// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The addressed bot's ENGINE commands: the "/" commands Claude Code, Codex,
// Fuigo or Grok Build offer in their own terminals, read live from the engine
// and shown in the composer's "/" menu under Murage's own commands. Picking
// one sends it, as typed, into that bot's engine session.
//
// Shared because the server decides which typed text IS an engine command
// (engineCommandInText) and the composer has to agree with it when it offers
// the menu, or a picked command would reach the engine as ordinary chat.

/** One command as the engine reported it. `name` never has the leading "/". */
export interface EngineCommand {
  name: string;
  description?: string;
  /** What goes after the name ("[branch]", "query to search for"). Present
   * means the command takes input, so the composer leaves the caret after it
   * instead of sending straight away. */
  hint?: string;
}

/** GET /api/bots/:id/engine-commands.
 *  `ready`: the engine has reported (now or on an earlier run, cached).
 *  `unknown`: this engine reports its commands, but not yet for this bot.
 *  `unsupported`: this engine has no commands of its own (the Grok API). */
export interface EngineCommandsView {
  engine: string;
  driver: string;
  status: "ready" | "unknown" | "unsupported";
  commands: EngineCommand[];
}

/** A command name as engines spell them: letters, digits and `-_.:`
 * (Claude plugin commands are `plugin:command`). Bounded so a hostile or
 * broken engine cannot hand the composer a paragraph as a name. */
export const ENGINE_COMMAND_NAME = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

/** `/name args` → its parts when `name` is one of `commands`; null for
 * ordinary chat, including a "/" that names nothing the engine offers. The
 * whole text must be the command: a leading space or a second line before
 * the "/" makes it chat, exactly as the engines themselves read it. */
export function engineCommandInText(
  text: string,
  commands: readonly EngineCommand[],
): { name: string; args: string } | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd());
  if (!match) return null;
  const typed = match[1]!.toLowerCase();
  const command = commands.find((candidate) => candidate.name.toLowerCase() === typed);
  return command ? { name: command.name, args: (match[2] ?? "").trim() } : null;
}

/** The exact text an engine receives for a command turn. */
export const engineCommandText = (command: { name: string; args: string }) =>
  command.args ? `/${command.name} ${command.args}` : `/${command.name}`;
