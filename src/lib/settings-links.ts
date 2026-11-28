// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 L1: deep links. A refusal or a Fix names the control that fixes it by `settingRef` (shared/setting-ref.ts,
// core L0); this turns a ref into the address that opens it, an address back into a ref's parts, and an id into the one
// path text every message uses (lib/settings-path-lint.ts keeps every other file from spelling a path).
//
//   - An id resolves by EXACT match against the index (and a published card alias). No prefix match; a page with no
//     fragment is a miss, and arrival says so rather than landing on a guess.
//   - Only the four known parameters (bot, account, device, item) survive; anything else is dropped.
//   - Nothing here writes: every function is a pure read of the index. Opening dispatches only navigation actions.
import { SETTINGS_ADDRESS_PREFIX, parseSettingsAddress, settingsAddressFor, type SettingsAddress } from "./settings-address";
import { SETTINGS_CARD_ALIASES } from "./settings-card-registry";
import { SETTINGS_INDEX, type SettingsIndexEntry } from "./settings-index";
import { settingsPageLabel } from "./settings-sections";

/** The fields of shared/setting-ref.ts's SettingRef a link carries (structural, so the contract file stays the owner). */
export interface SettingRefParts { id: string; bot?: string; account?: string; device?: string; item?: string }

export const SETTING_LINK_PARAMS = ["bot", "account", "device", "item"] as const;
export type SettingLinkParam = (typeof SETTING_LINK_PARAMS)[number];
export type SettingLinkParams = Partial<Record<SettingLinkParam, string>>;

const PARAM_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

/** The index entry for an id, exactly. A published card alias counts as its card's id; anything else is a miss. */
export function resolveSettingId(id: string, index: readonly SettingsIndexEntry[] = SETTINGS_INDEX): SettingsIndexEntry | null {
  if (typeof id !== "string" || !id) return null;
  const direct = index.find((entry) => entry.id === id);
  if (direct) return direct;
  if (!Object.hasOwn(SETTINGS_CARD_ALIASES, id)) return null;
  const anchor = SETTINGS_CARD_ALIASES[id];
  return index.find((entry) => entry.anchor === anchor) ?? null;
}

/** The address that opens a ref, or null when its id is not a control (the caller then shows the refusal without a link). */
export function settingRefAddress(ref: SettingRefParts, index: readonly SettingsIndexEntry[] = SETTINGS_INDEX): string | null {
  const entry = resolveSettingId(ref.id, index);
  if (!entry) return null;
  const botId = entry.scope === "bot" && ref.bot && PARAM_VALUE.test(ref.bot) ? ref.bot : undefined;
  const base = settingsAddressFor(entry, botId);
  const query: string[] = [];
  for (const key of SETTING_LINK_PARAMS) {
    const value = ref[key];
    if (typeof value !== "string" || !PARAM_VALUE.test(value)) continue;
    if (key === "bot" && botId) continue; // a bot entry carries its bot in the path
    query.push(`${key}=${encodeURIComponent(value)}`);
  }
  return query.length ? `${base}?${query.join("&")}` : base;
}

/** The known parameters on a Settings link; unknown or malformed ones are dropped, never guessed. */
export function parseSettingLinkParams(href: unknown): SettingLinkParams {
  if (typeof href !== "string" || href.length > 600) return {};
  const query = /\?([^#]*)/.exec(href)?.[1];
  if (!query) return {};
  const out: SettingLinkParams = {};
  for (const pair of query.split("&")) {
    const [rawKey, rawValue = ""] = pair.split("=");
    if (!(SETTING_LINK_PARAMS as readonly string[]).includes(rawKey)) continue;
    let value: string;
    try { value = decodeURIComponent(rawValue); } catch { continue; }
    if (PARAM_VALUE.test(value)) out[rawKey as SettingLinkParam] = value;
  }
  return out;
}

export type SettingArrival =
  | { kind: "control"; entry: SettingsIndexEntry }
  | { kind: "page"; section: string; reason: "no-fragment" | "unknown-control" }
  | { kind: "miss" };

/** Where an address arrives. By exact control id only: a signpost with no fragment, or an id the index does not know,
 *  lands on its page and says so; it is never counted as a control. */
export function settingArrival(href: unknown, index: readonly SettingsIndexEntry[] = SETTINGS_INDEX): SettingArrival {
  const address: SettingsAddress | null = parseSettingsAddress(href);
  if (!address) return { kind: "miss" };
  if (!address.name) return { kind: "page", section: address.section, reason: "no-fragment" };
  const id = address.scope === "app" ? `${address.section}.${address.name}` : `bot.${address.section}.${address.name}`;
  const entry = resolveSettingId(id, index);
  return entry && entry.scope === address.scope ? { kind: "control", entry } : { kind: "page", section: address.section, reason: "unknown-control" };
}

/** One path text for an id: "Settings", the page, then the control, joined once. The only place a path is spelled. */
export function settingPathText(id: string, index: readonly SettingsIndexEntry[] = SETTINGS_INDEX): string | null {
  const entry = resolveSettingId(id, index);
  if (!entry) return null;
  const page = entry.scope === "app" ? settingsPageLabel(entry.section) : entry.section;
  return ["Settings", page, entry.label()].join(" → ");
}

export { SETTINGS_ADDRESS_PREFIX };
