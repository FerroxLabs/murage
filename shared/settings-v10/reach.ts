// C7 · owner: access R0 (producer: server/settings/reach.ts) → botpages B1, find L1, access A4 (consumers).
import type { SettingRef } from "../setting-ref.ts";
export type ReachState = "blocked" | "asks" | "works";
export interface ReachRow { kind: "tool" | "app"; id: string; label: string; account?: string; state: ReachState; firstBlocker?: { message: string; settingRef: SettingRef } }
export interface BotReach { botId: string; rows: ReachRow[] }
