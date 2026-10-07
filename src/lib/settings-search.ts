// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words that find each Settings page: the Settings search box, and the
// command palette's Settings group ("images" jumps to Settings > Images).
// Apart from lib/settings-sections.ts so the words stay out of the first
// paint: the modal is a lazy chunk, and the palette loads this when it opens.
//
// A card that moves takes its words with it (NAV-OVERHAUL.md 3.2), and each
// page is also found by its label and its group's name.
import {
  SETTINGS_SECTIONS,
  settingsGroupLabel,
  settingsSectionLabel,
  type AppSettingsSection,
  type SettingsSectionEntry,
} from "./settings-sections";

// `keywords` by name: the copy rules know these are matched against what a
// person types and never shown (copy-rules.test.ts).
const ENTRIES: ReadonlyArray<{ id: AppSettingsSection; keywords: readonly string[] }> = [
  { id: "general", keywords: ["profile", "name", "email", "skin", "theme", "appearance", "dark", "light", "sidebar", "density", "rail", "compact", "notifications", "sound", "sounds", "mute", "chime", "quiet hours", "privacy", "previews", "startup", "background", "tray", "login", "sign in", "language", "translation", "analytics"] },
  { id: "aboutMe", keywords: ["about me", "profile", "who i am", "my name", "myself", "time zone", "preferences", "every bot"] },
  { id: "botDefaults", keywords: ["new bots", "effort", "default", "defaults", "tool calls", "tools", "autonomy", "project autonomy", "channel turns", "turn", "timeout", "quiet", "starter profiles", "starter", "crew"] },
  { id: "houseRules", keywords: ["house rules", "constitution", "soul", "rules", "principles", "guidance", "values", "tone", "every bot"] },
  { id: "skills", keywords: ["skills", "skill", "import", "scan", "library", "instructions", "safety"] },
  { id: "memory", keywords: ["memory", "learning", "learned", "remember", "forget", "facts", "notes", "what it knows", "history", "review"] },
  { id: "models", keywords: ["models", "providers", "keys", "api key", "catalog", "flux", "pricing", "openai", "anthropic", "gemini", "google", "paste", "paste keys", "env", "add keys", "replace keys", "local models"] },
  { id: "engines", keywords: ["models", "claude", "grok", "providers", "cli", "flux", "flux router", "router", "opencode", "keys", "accounts"] },
  { id: "images", keywords: ["images", "image", "picture", "pictures", "photo", "photos", "gpt image", "image generation", "generate", "draw", "reference", "references", "reference packs", "packs", "prompt blocks", "blocks", "library"] },
  { id: "webSearch", keywords: ["search", "web search", "web", "internet", "tavily", "exa", "brave", "look up"] },
  { id: "voice", keywords: ["voice", "transcription", "transcribe", "assemblyai", "voice notes", "speech", "dictation", "narration"] },
  { id: "connections", keywords: ["connected apps", "apps", "connections", "integrations", "mcp", "mcp servers", "gmail", "notion", "keys", "api"] },
  { id: "computer", keywords: ["computer", "vm", "virtual", "desktop", "local vm", "vps", "server", "ssh", "box", "cloud computer", "browser", "browser profiles", "sign-in", "browser access", "other agents", "extension"] },
  { id: "channels", keywords: ["telegram", "botfather", "pair", "slack", "discord", "whatsapp", "messaging", "channels"] },
  { id: "companion", keywords: ["companion", "phone", "pair", "mobile", "devices", "tablet", "laptop", "browser", "webui", "qr", "code", "tailscale", "remote access"] },
  { id: "backups", keywords: ["backup", "restore", "recovery", "schedule", "s3", "off-site", "remote", "restic", "age", "key", "recovery key", "age key", "encryption key"] },
  { id: "usage", keywords: ["tokens", "cost", "billing"] },
  { id: "about", keywords: ["help", "updates", "update", "version", "app version", "about", "what's new", "whats new", "release notes", "announcements", "news", "notices", "diagnostics", "logs", "support", "setup", "first run", "get set up", "walkthrough", "keyboard", "shortcuts"] },
  { id: "experimental", keywords: ["early", "preview", "labs", "teach", "teach a skill", "skill recorder", "built-in browser"] },
];

export const SETTINGS_KEYWORDS = Object.fromEntries(ENTRIES.map((entry) => [entry.id, entry.keywords])) as Readonly<Record<AppSettingsSection, readonly string[]>>;

/** True when `query` (already trimmed and lower-cased) finds this section. */
export function settingsSectionMatches(section: Pick<SettingsSectionEntry, "id" | "group">, query: string): boolean {
  if (!query) return true;
  return [settingsSectionLabel(section.id), settingsGroupLabel(section.group), ...SETTINGS_KEYWORDS[section.id]]
    .some((part) => part.toLowerCase().includes(query));
}

/** The desktop sections the settings search box keeps for `query`. */
export function settingsSearchResults(query: string): AppSettingsSection[] {
  const q = query.trim().toLowerCase();
  return SETTINGS_SECTIONS.filter((entry) => settingsSectionMatches(entry, q)).map((entry) => entry.id);
}
