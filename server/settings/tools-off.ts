// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** T2: per-bot `toolsOff`. One field on the bot; absent means today's
 * behaviour. One tool is written at a time and a write is a pure function of
 * the stored list, so two quick toggles both stick when applied in order.
 * Owner: sv10-tools (field storage in server/store.ts is core's: wiring note). */
import { type ToolAdmitted, type ToolRefusal, type ToolSettingRef, gateWebRead, gateWebSearch, webReadEnabled } from "./web-read.ts";

export const PER_BOT_TOOLS = ["web_search", "web_read", "images", "voice_notes", "past_chats", "routines"] as const;
export type PerBotTool = typeof PER_BOT_TOOLS[number];

/** Which proxy tool names each switch governs. */
export const TOOL_NAMES: Record<PerBotTool, readonly string[]> = {
  web_search: ["web_search"],
  web_read: ["web_read"],
  images: ["list_image_models", "resolve_image_reference", "generate_image", "save_reference_pack", "list_reference_packs"],
  voice_notes: ["send_voice_note"],
  // Past chats is read by the memory recall path (core-owned), not a proxy tool: no name to hide here; core applies toolOffForBot there (wiring note).
  past_chats: [],
  routines: ["list_routines", "propose_routine", "propose_routine_action", "propose_outcome"],
};
export function toolForName(name: string): PerBotTool | undefined {
  return PER_BOT_TOOLS.find(tool => TOOL_NAMES[tool].includes(name));
}

type BotLike = { id?: string; toolsOff?: readonly string[] };
type Cfg = Parameters<typeof gateWebRead>[0];

export function toolOffForBot(bot: BotLike | null | undefined, tool: PerBotTool): boolean { return bot?.toolsOff?.includes(tool) === true; }

/** One tool, atomically: returns the whole next list from the stored one. Unknown tools are dropped, never stored. */
export function setToolOff(stored: readonly string[] | undefined, tool: PerBotTool, off: boolean): string[] {
  const kept = (stored ?? []).filter((t): t is PerBotTool => (PER_BOT_TOOLS as readonly string[]).includes(t) && t !== tool);
  const next = off ? [...kept, tool] : kept;
  return PER_BOT_TOOLS.filter(t => next.includes(t));
}

export function toolOffRefusal(bot: BotLike | null | undefined, tool: PerBotTool): ToolRefusal {
  const ref: ToolSettingRef = { id: `tools.${tool.replace(/_/g, "-")}.bots`, ...(bot?.id ? { bot: bot.id } : {}), code: "tool-off-for-bot" };
  return { ok: false, code: "tool-off-for-bot", settingRef: ref, error: "This tool is switched off for this bot in Settings (Tools, Which bots). Nothing was done. Tell the owner, who can switch it back on there." };
}

/** The check applied at all three points: when the list is built, when a warm
 * list is reused, and when the tool is called. The app-wide switches come
 * first, then the bot's own. A continuation of a page already read is
 * allowed (T1 rule); everything else is new work. */
export function admitTool(cfg: Cfg, bot: BotLike | null | undefined, name: string, args?: { handle?: unknown; url?: unknown }): ToolAdmitted | ToolRefusal {
  const tool = toolForName(name);
  if (!tool) return { ok: true };
  if (tool === "web_read") {
    const global = gateWebRead(cfg, args ?? {}, bot?.id);
    if (!global.ok) return global;
    if (toolOffForBot(bot, tool) && !(typeof args?.handle === "string" && args.handle && args.url === undefined)) return toolOffRefusal(bot, tool);
    return { ok: true };
  }
  if (tool === "web_search") {
    const global = gateWebSearch(cfg, bot?.id);
    if (!global.ok) return global;
  }
  return toolOffForBot(bot, tool) ? toolOffRefusal(bot, tool) : { ok: true };
}

/** Tools hidden from the list for this bot (list-build and warm-list reuse). */
export function hiddenToolNames(cfg: Cfg, bot: BotLike | null | undefined): Set<string> {
  const hidden = new Set<string>();
  for (const tool of PER_BOT_TOOLS) {
    for (const name of TOOL_NAMES[tool]) if (!admitTool(cfg, bot, name).ok) hidden.add(name);
  }
  return hidden;
}

/** Claude's native deny list gains WebSearch when search is off app-wide or for the bot. Applies at every level, No limits included (carried as turn.nativeDeny, not through the saved native lists). */
export function claudeSearchDeny(cfg: Cfg, bot: BotLike | null | undefined): string[] {
  return admitTool(cfg, bot, "web_search").ok ? [] : ["WebSearch"];
}

/** The body of `GET /api/internal/tool-switches?self=<bot>` (route mounted by core: wiring note). Only what the proxy needs. */
export function toolSwitchesFor(cfg: Cfg, bot: BotLike | null | undefined): { webRead: { enabled: boolean }; webSearch: { provider: string }; toolsOff: string[] } {
  return { webRead: { enabled: webReadEnabled(cfg) }, webSearch: { provider: cfg.webSearch?.provider ?? "engine" }, toolsOff: [...(bot?.toolsOff ?? [])] };
}

/** C16/G4: what the page and access R0 read per bot, from the same admit check the proxy uses, so the UI and the server cannot disagree.
 * `voiceReady` is the voice scope's own truth (server/tts/scope-read.ts); a voice note is on only when both agree. */
export function toolTruthFor(cfg: Cfg, bot: BotLike | null | undefined, extra: { voiceReady?: boolean } = {}): { toolId: PerBotTool; on: boolean; reason?: string }[] {
  return PER_BOT_TOOLS.map((tool) => {
    const probe = TOOL_NAMES[tool][0];
    const admitted = probe ? admitTool(cfg, bot, probe) : toolOffForBot(bot, tool) ? toolOffRefusal(bot, tool) : { ok: true as const };
    if (!admitted.ok) return { toolId: tool, on: false, reason: admitted.code };
    if (tool === "voice_notes" && extra.voiceReady === false) return { toolId: tool, on: false, reason: "voice-not-ready" };
    return { toolId: tool, on: true };
  });
}

import type { SettingsV10Router } from "./v10-router.ts";

// Seat registration hook (core registrar calls this); routes are added by later rows.
export function registerToolsOffRoutes(router: SettingsV10Router): void {
  router.add("tools", () => false);
}
