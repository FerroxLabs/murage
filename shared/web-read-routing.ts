// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Complete shipped-driver inventory. A configured exclusion is not a claim
 * about every upstream binary version. The live replay records those versions.
 * Residuals are surfaced in the conversation, not hidden in release notes. */
export const WEB_READ_ROUTING: Record<string, { route: string; limitation?: string }> = {
  claudeAgent: { route: '--disallowedTools WebFetch with agents mounted' },
  codex: { route: 'web_search disabled with agents mounted (includes page open)' },
  fuigoAgent: { route: 'FUIGO_WEB_FETCH=0' },
  geminiAgent: { route: 'scoped tools.exclude web_fetch' },
  droidAgent: { route: '--remove-tools FetchUrl with agents mounted, including GPT Sol' },
  qwenAgent: { route: '--exclude-tools=web_fetch' },
  copilotAgent: { route: '--excluded-tools=web_fetch with agents mounted' },
  opencodeGo: { route: 'native webfetch denied in inline config and every built-in agent' },
  'openai-compat': { route: 'Murage-owned chat tool catalog; no native page fetch' },
  grok: { route: 'Murage-owned chat tool catalog; no native page fetch' },
  minimax: { route: 'Murage-owned chat tool catalog; no native page fetch' },
  piAgent: { route: 'scoped built-in file/shell tools and mounted MCP; no native page fetch' },
  kimiAgent: { route: 'web_read mounted', limitation: 'Kimi Code ACP has no verified per-session fetch exclusion; legacy Python agent YAML exclusions do not establish Code ACP coverage.' },
  grokAgent: { route: '--deny WebFetch with agents mounted' },
  cursorAgent: { route: 'web_read mounted', limitation: 'Cursor ACP has no verified native reader exclusion independent of permission mode.' },
  hermesAgent: { route: 'managed agent.disabled_toolsets: web, browser with agents mounted' },
  clineAgent: { route: 'web_read mounted', limitation: 'Cline ACP has no verified native browser/page-fetch exclusion.' },
  museCode: { route: 'web_read mounted', limitation: 'Muse app-server has no verified native reader exclusion.' },
  antigravityAgent: { route: 'web_read mounted', limitation: 'Antigravity has no verified native reader exclusion at every permission level.' },
  customAcp: { route: 'web_read when the custom agent accepts MCP', limitation: 'Custom ACP controls and native tools are supplied by the external executable.' },
  openclawAgent: { route: 'gateway-owned tools', limitation: 'OpenClaw does not mount Murage MCP tools; its gateway reader cannot use Murage continuation.' },
  boxAgent: { route: 'remote box-owned tools', limitation: 'Box Agent does not mount Murage MCP tools; its remote reader cannot use Murage continuation.' },
};

export const ENGINE_LIMIT_PREFIX = "engine limit: web-read:";
const engineNames: Record<string, string> = { kimiAgent: "Kimi Code", cursorAgent: "Cursor", clineAgent: "Cline", museCode: "Muse Code", antigravityAgent: "Antigravity", openclawAgent: "OpenClaw", boxAgent: "Box Agent" };
export function engineLimitLine(driver: string) { return `${ENGINE_LIMIT_PREFIX}${driver}`; }
export function engineLimitText(driver: string, surface: "chat" | "settings" = "chat"): string | undefined {
  const row = WEB_READ_ROUTING[driver];
  if (row && !row.limitation) return undefined;
  const name = engineNames[driver];
  const first = driver === "customAcp"
    ? "This custom engine controls its own web tools, so long pages may come back cut short."
    : driver === "openclawAgent" || driver === "boxAgent"
      ? `${name} reads web pages with its own tools, not Murage's, so long pages may come back cut short.`
      : name ? `${name} can still use its own web reader, which may cut long pages short.`
        : "This engine has not been checked for full web page reads, so long pages may come back cut short.";
  return first + (surface === "settings"
    ? " For pages you need in full, choose Fuigo, Claude, Codex or Gemini above."
    : " For pages you need in full, switch this bot to Fuigo, Claude, Codex or Gemini.");
}
export function engineLimitNotice(name: string | undefined) {
  if (!name?.startsWith(ENGINE_LIMIT_PREFIX)) return undefined;
  const driver = name.slice(ENGINE_LIMIT_PREFIX.length), text = engineLimitText(driver);
  return text ? { driver, text } : undefined;
}
/** Legacy routing diagnostics. User-facing surfaces use engineLimitText. */
export function webReadRoutingNotice(driver: string) {
  const row = WEB_READ_ROUTING[driver];
  const reason = row?.limitation ?? (!row ? 'This engine has no declared page-reader routing contract.' : undefined);
  return reason ? `Complete web reads are not enforced for this engine. ${reason} Use an engine with enforced web_read routing for pages whose complete text is required.` : undefined;
}
