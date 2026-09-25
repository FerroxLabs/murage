// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "Always allow" grants a bot remembers, as Settings shows them. The
// server is the one that decides what a key covers (server/auto-approve.ts,
// server/stop-line.ts, shared/exact-command.ts); this only puts it in words.
import { parseExactCommandKey } from "../../shared/exact-command";

export type GrantDescription =
  | { kind: "exact"; command: string; folder: string; engine: string }
  | { kind: "other"; text: string };

/** Every grant the bot's defaults and its tasks hold, each once, defaults
 * first. Removing one removes it from all of them (server/index.ts). */
export function rememberedGrants(bot: { alwaysAllow?: string[]; tasks?: { alwaysAllow?: string[] }[] }): string[] {
  return [...new Set([...(bot.alwaysAllow ?? []), ...(bot.tasks ?? []).flatMap((task) => task.alwaysAllow ?? [])])];
}

const PROGRAM_GRANT = /^(?:mcp__.+__)?(?:[\w-]+\.)?(?:bash|shell|execute|exec_command|run_command|computer_exec|terminal):([^:\s]+)$/i;

export function describeGrant(key: string, engines: readonly { instanceId: string; displayName: string }[]): GrantDescription {
  const exact = parseExactCommandKey(key);
  if (exact) {
    const engine = engines.find((candidate) => candidate.instanceId === exact.engine)?.displayName ?? exact.engine;
    return { kind: "exact", command: exact.command, folder: exact.cwd, engine };
  }
  return { kind: "other", text: grantWords(key) };
}

function grantWords(key: string): string {
  if (key.startsWith("local-computer:")) return `${grantWords(key.slice("local-computer:".length))} on this computer`;
  const program = PROGRAM_GRANT.exec(key)?.[1];
  if (program) return `Any ${program} command`;
  const stop = /^stop:(delete|pay|message|public):(.+)$/.exec(key);
  if (stop) {
    const [, kind, place] = stop;
    if (kind === "delete") return `Deleting in ${place}`;
    if (kind === "pay") return `Paying ${place}`;
    if (kind === "message") return `Messaging ${place}`;
    return `Posting publicly on ${place}`;
  }
  return key;
}
