// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot server/drivers/claude-model-extras.ts (Apache-2.0), see NOTICE.

/** Models the owner's own Claude Code setup names, for the Claude picker.
 *
 *  Claude Code reads ANTHROPIC_CUSTOM_MODEL_OPTION (a model id, with an
 *  optional _NAME label) and ANTHROPIC_DEFAULT_OPUS / SONNET / HAIKU_MODEL
 *  (the model each tier runs). A gateway or cloud-hosted id placed there is
 *  one no built-in list can know, so it is offered next to the standard rows.
 *  The values come from the `env` block of settings.json (a value a shell
 *  switcher left in the process environment is not offered: it is stripped
 *  before the spawn, so it could not run), and only the picked id ever
 *  reaches the bot's CLI; none of these values are copied into it. Ids only,
 *  never a key. */
export interface ClaudeModelExtra {
  id: string;
  label: string;
}

const TIERS = [
  { env: "ANTHROPIC_DEFAULT_OPUS_MODEL", name: "Opus" },
  { env: "ANTHROPIC_DEFAULT_SONNET_MODEL", name: "Sonnet" },
  { env: "ANTHROPIC_DEFAULT_HAIKU_MODEL", name: "Haiku" },
] as const;

/** Official Anthropic ids already have a row of their own. */
const OFFICIAL_CLAUDE_ID = /^claude-[a-z0-9.-]+$/;

function text(settingsEnv: Record<string, unknown>, name: string): string | undefined {
  const value = settingsEnv[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The custom option first, then each tier whose model is not an official id.
 *  An id with characters a model id never has is dropped. */
export function claudeModelExtras(
  settingsEnv: Record<string, unknown>,
  validId: RegExp,
): ClaudeModelExtra[] {
  const extras: ClaudeModelExtra[] = [];
  const custom = text(settingsEnv, "ANTHROPIC_CUSTOM_MODEL_OPTION");
  if (custom && validId.test(custom)) {
    const name = text(settingsEnv, "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME");
    extras.push({ id: custom, label: name || custom });
  }
  for (const tier of TIERS) {
    const id = text(settingsEnv, tier.env);
    if (!id || !validId.test(id) || OFFICIAL_CLAUDE_ID.test(id)) continue;
    extras.push({ id, label: `${tier.name} tier: ${id}` });
  }
  return extras;
}
