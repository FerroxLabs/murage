// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hook gates for the Fuigo and Grok engines on bot turns (fuigo.ts and grok.ts
// transformEnv). Reflection (memory/pip-transport.ts) forces every compat cell
// off on its own, since it is reached from fuigo.ts and cannot import it back.
//
// Fuigo 1.0.32 runs the owner's personal hooks (~/.claude, ~/.cursor, ~/.codex)
// on every run, headless included, behind these env-first compat cells. A hook
// is code the owner wrote for their own sessions; it must never run inside a
// bot turn or a reflection run, so an owner value of "1" does NOT win here
// (unlike the MCP/skills/rules cells, where an explicit opt-in is respected).

export const FUIGO_HOOK_GATES = ["FUIGO_CLAUDE_HOOKS_ENABLED", "FUIGO_CURSOR_HOOKS_ENABLED", "FUIGO_CODEX_HOOKS_ENABLED"] as const;
export const GROK_HOOK_GATES = ["GROK_CLAUDE_HOOKS_ENABLED", "GROK_CURSOR_HOOKS_ENABLED", "GROK_CODEX_HOOKS_ENABLED"] as const;

/**
 * Forces every `<PREFIX>_*HOOKS_ENABLED` gate to "0", including one the owner set to "1" and any casing of it.
 * Windows env names are case-insensitive, so a lower-case duplicate left beside the upper-case "0" could win
 * in the child; every casing is removed first, then the canonical upper-case name is written.
 */
export function forceHookGatesOff(env: Record<string, string | undefined>, prefix: "FUIGO" | "GROK"): void {
  const known: readonly string[] = prefix === "FUIGO" ? FUIGO_HOOK_GATES : GROK_HOOK_GATES;
  const pattern = new RegExp(`^${prefix}_[A-Z0-9_]*HOOKS_ENABLED$`, "i");
  const names = new Set<string>(known);
  for (const key of Object.keys(env)) {
    if (!pattern.test(key)) continue;
    names.add(key.toUpperCase());
    delete env[key];
  }
  for (const name of names) env[name] = "0";
}
