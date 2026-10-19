// SPDX-License-Identifier: AGPL-3.0-or-later
/** The managed config files a Cloud turn starts with, relative to the engine home. The
 * content is the launcher's own (deploy/cloud-home/murage-turn-launch.py render_plan,
 * CLOUD-ENGINES-DESIGN.md 2.2): the server sends typed `render` parameters and never a
 * file, so this list exists for the server's own tests and diagnostics only. */
export const CLOUD_MANAGED_TURN_PATHS: Readonly<Record<string, readonly string[]>> = {
  claudeAgent: [".claude/settings.json", ".claude/settings.local.json"],
  codex: [".codex/config.toml"],
  grokAgent: [".grok/config.toml"],
  opencodeGo: [".config/opencode/opencode.json", ".config/opencode/opencode.jsonc", ".config/opencode/config.json", ".opencode/opencode.json", ".opencode/opencode.jsonc"],
  kimiAgent: [".kimi-code/config.toml", ".kimi-code/tui.toml", ".kimi-code/mcp.json"],
  fuigoAgent: [".fuigo/config.toml", ".fuigo/managed_config.toml", ".fuigo/requirements.toml"],
};
export function cloudManagedTurnPaths(engine: string, home: string): string[] {
  return (CLOUD_MANAGED_TURN_PATHS[engine] ?? []).map(relative => `${home}/${relative}`);
}
