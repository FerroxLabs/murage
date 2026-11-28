// Settings v10 L0 (owner: core): the setting that fixes each refusal, beside the refusal's message (C8, shared/setting-ref.ts).
// Every code the handlers emit has one entry; refusal-refs.test.ts proves each id exists in the settings-controls manifest.
import { SETTING_REF_KEY, type SettingRef } from "../../shared/setting-ref.ts";

export const REFUSAL_SETTING_REFS: Readonly<Record<string, { id: string }>> = {
  // the owner-code gate (server/browser-owner-policy.ts OWNER_CODE_LABELS)
  full_access: { id: "bot.permissions.level" },
  allow_request: { id: "bot.access.app-access" },
  folder_trust: { id: "bot.access.folder" },
  restore_release: { id: "about.version" },
  delete: { id: "bot.history.history" },
  bot_reach: { id: "bot.access.apps" },
  new_skill: { id: "skills.library" },
  mcp_server: { id: "connections.mcp" },
  traffic_moved: { id: "computer.browser" },
  computer_viewer: { id: "bot.access.computer" },
  computer_command: { id: "bot.access.computer" },
  bot_widen: { id: "bot.permissions.level" },
  device_remove: { id: "companion.pairing" },
  config_change: { id: "general.mode" },
  take_down_site: { id: "bot.access.sites" },
  fresh_door: { id: "general.mode" },
  publish_allow: { id: "bot.access.sites" },
  other: { id: "general.mode" },
  // the lane's own 409s
  MEMORY_CHANGED: { id: "bot.memory.memory" },
  PLAN_CHANGED: { id: "bot.permissions.review" },
  SETTING_CHANGED: { id: "general.mode" },
};

/** The ref for a refusal code, or undefined when the code has none (the page then shows the message alone). */
export function settingRefFor(code: string, scope: Pick<SettingRef, "bot" | "account" | "device" | "item"> = {}): SettingRef | undefined {
  const entry = Object.hasOwn(REFUSAL_SETTING_REFS, code) ? REFUSAL_SETTING_REFS[code] : undefined;
  return entry ? { id: entry.id, ...scope, code } : undefined;
}

/** A refusal body: the message, the code and the ref that fixes it. */
export function refusalBody(code: string, error: string, scope: Pick<SettingRef, "bot" | "account" | "device" | "item"> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ref = settingRefFor(code, scope);
  return { ...extra, error, code, ...(ref ? { [SETTING_REF_KEY]: ref } : {}) };
}
