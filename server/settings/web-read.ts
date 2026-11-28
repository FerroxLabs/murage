// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** T1: Murage's Read web pages switch (`webRead.enabled`, default on) and the
 * Web search row switch. Pure decisions only: the caller (agents proxy, the
 * internal routes) supplies the config and acts on the answer.
 * Owner: sv10-tools. Consumer of the refusal's `settingRef`: core L0. */

/** Structurally the shape core L0 freezes in shared/setting-ref.ts. */
export type ToolSettingRef = { id: string; bot?: string; code: string };
export type ToolRefusal = { ok: false; error: string; code: string; settingRef: ToolSettingRef };
export type ToolAdmitted = { ok: true };

export const WEB_READ_SETTING_ID = "tools.web-read";
export const WEB_SEARCH_SETTING_ID = "tools.web-search";

type WebReadConfig = { webRead?: { enabled?: boolean }; webSearch?: { provider?: string } };

/** The stored Read web pages switch (`webRead.enabled`, top level so v1.0.20 strips it). The Tools page and the Web search card both write this one bit. */
export function webReadSwitchOn(cfg: WebReadConfig): boolean { return cfg.webRead?.enabled !== false; }
export function webSearchEnabled(cfg: WebReadConfig): boolean { return cfg.webSearch?.provider !== "off"; }
/** THE predicate for "can Murage read a new page": Web search not Off AND the stored switch on. The route, the proxy switches, the launch list,
 * the status, the prompt and the Tools row all ask this; none of them re-derives it. Mirrored for the page in src/lib/tools-page.ts (rowAppOn). */
export function webReadEnabled(cfg: WebReadConfig): boolean { return webSearchEnabled(cfg) && webReadSwitchOn(cfg); }

/** The call a bot is making on Murage's reader. A call that names a saved
 * handle is a continuation (the next range of a page already fetched); any
 * other call fetches a new page and is new work. */
export type WebReadCall = { handle?: unknown; url?: unknown };

export function webReadRefusal(botId?: string): ToolRefusal {
  return { ok: false, code: "web-read-off", settingRef: { id: WEB_READ_SETTING_ID, ...(botId ? { bot: botId } : {}), code: "web-read-off" },
    error: "Murage's page reader is switched off in Settings (Tools, Read web pages). Nothing was fetched. Tell the owner, who can switch it back on there." };
}
/** Reading is off because Web search is Off (dev/1022 settings-truth rule): the setting to change is Web search, not Read web pages. */
export function webReadOffBySearchRefusal(botId?: string): ToolRefusal {
  return { ok: false, code: "web-search-off", settingRef: { id: WEB_SEARCH_SETTING_ID, ...(botId ? { bot: botId } : {}), code: "web-search-off" },
    error: "Web search is switched off in Settings (Tools, Web search), which also turns page reading off. Nothing was fetched. Tell the owner, who can switch it back on there." };
}
export function webSearchRefusal(botId?: string): ToolRefusal {
  return { ok: false, code: "web-search-off", settingRef: { id: WEB_SEARCH_SETTING_ID, ...(botId ? { bot: botId } : {}), code: "web-search-off" },
    error: "Web search is switched off in Settings (Tools, Web search). Nothing was searched. Tell the owner, who can switch it back on there." };
}

/** A continuation stays allowed after the switch goes off, and only under the
 * three checks the saved document itself enforces (same bot and thread, a handle
 * not yet expired: web-documents.ts scope + expiry). Anything that fetches is
 * refused while the switch is off. */
export function gateWebRead(cfg: WebReadConfig, call: WebReadCall, botId?: string): ToolAdmitted | ToolRefusal {
  if (webReadEnabled(cfg)) return { ok: true };
  // The HTTP route (server/index.ts web-read) is the authority and refuses saved handles too while reading is off (dev/1022 ruling,
  // pinned by web-read-api.test.ts); this proxy-side check lets a continuation reach it and does not promise it will finish.
  if (typeof call.handle === "string" && call.handle && call.url === undefined) return { ok: true };
  return webSearchEnabled(cfg) ? webReadRefusal(botId) : webReadOffBySearchRefusal(botId);
}
export function gateWebSearch(cfg: WebReadConfig, botId?: string): ToolAdmitted | ToolRefusal {
  return webSearchEnabled(cfg) ? { ok: true } : webSearchRefusal(botId);
}

export { webSearchSwitch, type SearchSwitchPatch } from "../../shared/web-search-switch.ts";

import type { SettingsV10Router } from "./v10-router.ts";

// Seat registration hook (core registrar calls this); routes are added by later rows.
export function registerWebReadRoutes(router: SettingsV10Router): void {
  router.add("tools", () => false);
}
