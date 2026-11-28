// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 Tools page model (A3, owner: sv10-tools). Pure data: the 21 rows in page order, which of them have an
// app-wide switch here, which have a per-bot switch, and the reader list per engine generated from
// shared/web-read-routing.ts so the page can never promise a reader exclusion the routing table does not make.
import { WEB_READ_ROUTING, engineLimitText } from "../../shared/web-read-routing";
import { toolTruthFor } from "../../server/settings/tools-off";

export type ToolGroup = "web" | "builtin" | "always" | "mine";
export type PerBotToolId = "web_search" | "web_read" | "images" | "voice_notes" | "past_chats" | "routines";
export interface ToolRow {
  id: string;
  group: ToolGroup;
  /** App-wide switch on this page (Web search, Read web pages). */
  appSwitch?: "webSearch" | "webRead";
  /** Per-bot switch (server/settings/tools-off.ts PER_BOT_TOOLS). */
  perBot?: PerBotToolId;
  /** Where the row's own settings live, when not on this page. */
  opensPage?: string;
}

export const TOOL_ROWS: readonly ToolRow[] = [
  { id: "web-search", group: "web", appSwitch: "webSearch", perBot: "web_search" },
  { id: "web-read", group: "web", appSwitch: "webRead", perBot: "web_read" },
  { id: "images", group: "web", perBot: "images" },
  { id: "voice-notes", group: "web", perBot: "voice_notes" },
  { id: "browser", group: "web", opensPage: "computer" },
  { id: "computer", group: "web", opensPage: "computer" },
  { id: "files-shell", group: "always" },
  { id: "memory", group: "builtin", opensPage: "memory" },
  { id: "past-chats", group: "builtin", perBot: "past_chats" },
  { id: "routines", group: "builtin", perBot: "routines" },
  { id: "talk-to-bots", group: "always" },
  { id: "skills", group: "builtin", opensPage: "skills" },
  { id: "publish-site", group: "always" },
  { id: "projects-channels", group: "builtin", opensPage: "rules" },
  { id: "connected-apps", group: "mine", opensPage: "connections" },
  { id: "bot-email", group: "mine", opensPage: "connections" },
  { id: "custom-tools", group: "mine", opensPage: "connections" },
  { id: "messaging", group: "mine", opensPage: "messaging" },
  { id: "phone-tools", group: "mine", opensPage: "companion" },
  { id: "calls", group: "mine", opensPage: "companion" },
  { id: "other-programs", group: "mine", opensPage: "companion" },
];

/** Is the row's app-wide switch on? undefined for a row with no switch on this page. */
export function rowAppOn(row: ToolRow, cfg: { webSearch?: { provider?: string }; webRead?: { enabled?: boolean } } | undefined): boolean | undefined {
  if (row.appSwitch === "webSearch") return (cfg?.webSearch?.provider ?? "engine") !== "off";
  // the server's one reading predicate (server/settings/web-read.ts webReadEnabled): Web search Off also turns reading off
  if (row.appSwitch === "webRead") return (cfg?.webSearch?.provider ?? "engine") !== "off" && cfg?.webRead?.enabled !== false;
  return undefined;
}

/** How many bots cannot use this row's tool. Asks the same truth table the server answers a call with (G4: one source for the page and the server). */
export function botsOffCount(row: ToolRow, bots: ReadonlyArray<{ id?: string; toolsOff?: readonly string[]; hidden?: boolean }>, cfg?: Parameters<typeof toolTruthFor>[0]): number {
  const tool = row.perBot;
  if (!tool) return 0;
  return bots.filter(bot => !bot.hidden && toolTruthFor(cfg ?? {}, bot).find(entry => entry.toolId === tool)?.on === false).length;
}

/** The reader list for the Web search sheet: every engine in the routing table, whether Murage's reader switch is enforced there. */
export function readerRows(): Array<{ driver: string; enforced: boolean; route: string; limit?: string }> {
  return Object.entries(WEB_READ_ROUTING).map(([driver, row]) => ({ driver, enforced: !row.limitation, route: row.route, ...(engineLimitText(driver, "settings") ? { limit: engineLimitText(driver, "settings") as string } : {}) }));
}
