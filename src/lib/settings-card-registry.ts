// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every Settings card, once (SETTINGS-LANES.md L1 step 4). Search lists these
// cards and rows, never pages; an opener resolves an alias to {section,
// anchor} and opens the page's Advanced first when the anchor's card is
// `advanced`. Words moved here from lib/settings-search.ts: a card that moves
// takes its words with it.
//
// Lane blocks: L1 seeded every card that exists today. L2, L4, L5 and L6
// replace or append inside their own block and nowhere else, and flip
// `advanced` when their page gains its Advanced section.
//
// Loaded with the modal and the palette, never on the first paint (the words).
import { t } from "./i18n";
import type { LocaleKey } from "@/locales";
import type { SettingsCard } from "./settings-cards";

// `keywords` by name: the copy rules know these are matched against what a person types and never shown.
const card = (id: string, section: SettingsCard["section"], anchor: string, spec: { keywords: readonly string[]; advanced?: boolean; surface?: SettingsCard["surface"] }): SettingsCard => ({
  id: `${section}.${id}`,
  section,
  advanced: spec.advanced ?? false,
  surface: spec.surface ?? "desktop",
  words: spec.keywords,
  anchor,
});

// ---- General (L4 owns the page; L1 seeds) ----
const GENERAL: SettingsCard[] = [
  card("profile", "general", "profile-heading", { keywords: ["profile", "name", "email"], surface: "any" }),
  card("appearance", "general", "appearance-heading", { keywords: ["skin", "theme", "appearance", "dark", "light"], surface: "any" }),
  card("sidebar-density", "general", "sidebar-density-heading", { keywords: ["sidebar", "density", "rail", "compact"], advanced: true }),
  card("language", "general", "language-heading", { keywords: ["language", "translation"] }),
  card("time-zone", "general", "time-zone-heading", { keywords: ["time zone", "timezone", "zone", "clock", "daylight saving", "dst", "calendar times"] }),
  card("notifications", "general", "notifications-heading", { keywords: ["notifications", "sound", "sounds", "mute", "chime", "quiet hours", "privacy", "previews"] }),
  card("startup", "general", "startup-heading", { keywords: ["startup", "background", "tray", "login", "sign in"], advanced: true }),
  card("analytics", "general", "analytics-heading", { keywords: ["analytics"], surface: "any", advanced: true }),
  card("about-me", "general", "about-me-heading", { keywords: ["about me", "profile", "who i am", "my name", "myself", "time zone", "preferences", "every bot"] }),
];

// ---- Bots (L4) ----
const BOT_DEFAULTS: SettingsCard[] = [
  card("new-bot-effort", "botDefaults", "new-bot-effort-heading", { keywords: ["new bots", "effort", "default", "defaults"], advanced: true }),
  card("tool-calls", "botDefaults", "tool-calls-heading", { keywords: ["tool calls", "tools", "show tool calls"], advanced: true }),
  card("project-autonomy", "botDefaults", "project-autonomy-heading", { keywords: ["autonomy", "project autonomy", "projects"], advanced: true }),
  card("channel-turns", "botDefaults", "room-turn-timeout", { keywords: ["channel turns", "turn", "timeout", "quiet"], advanced: true }),
  card("room-routing", "botDefaults", "room-routing-label", { keywords: ["routing", "who answers", "channels", "rooms"], advanced: true }),
  card("starter-profiles", "botDefaults", "starter-profiles-heading", { keywords: ["starter profiles", "starter", "crew"] }),
  card("house-rules", "botDefaults", "house-rules-heading", { keywords: ["house rules", "constitution", "soul", "rules", "principles", "guidance", "values", "tone", "every bot"] }),
];

// ---- Skills (L1) ----
const SKILLS: SettingsCard[] = [
  card("recorder", "skills", "skill-recorder-heading", { keywords: ["teach", "teach a skill", "skill recorder", "record", "workflow", "learn", "early", "experimental"] }),
  card("library", "skills", "skills-settings-title", { keywords: ["skills", "skill", "import", "library", "instructions"] }),
  card("scan-rules", "skills", "skill-scan-rules-heading", { keywords: ["scan", "scan rules", "import check"], advanced: true }),
];

// ---- Memory (L2) ----
const MEMORY: SettingsCard[] = [
  card("overview", "memory", "memory-heading", { keywords: ["memory", "learning", "learned", "remember", "forget", "facts", "notes", "what it knows", "history", "review", "smart search", "switch"] }),
  card("how-it-learns", "memory", "memory-how-heading", { keywords: ["learn as we talk", "review before using", "learn from chats", "learn from channels", "facts", "procedures"] }),
  card("bots", "memory", "memory-bots-heading", { keywords: ["bots", "pause", "each bot", "paused"] }),
  card("learned", "memory", "memory-learned-heading", { keywords: ["what it learned", "keep", "undo", "history", "skipped", "try again"] }),
  card("people", "memory", "memory-people-heading", { keywords: ["people", "humans", "who is who", "link"] }),
  card("import", "memory", "memory-import-heading", { keywords: ["import", "notes", "notebook", "memory.md", "bring in"] }),
  card("mode", "memory", "memory-mode-heading", { keywords: ["memory mode", "capture only", "paused", "off", "learn facts", "how you like things done", "procedures"], advanced: true }),
  card("limit", "memory", "memory-limit-heading", { keywords: ["monthly limit", "learning limit", "ceiling", "tokens", "usage", "spend", "flux balance"], advanced: true }),
  card("connection", "memory", "memory-connection-heading", { keywords: ["learning connection", "flux fast", "connection", "extractor"], advanced: true }),
  card("audience", "memory", "memory-audience-heading", { keywords: ["audience", "audience access", "folder memory", "share"], advanced: true }),
  card("procedures", "memory", "memory-procedures-heading", { keywords: ["procedure reviews", "procedures", "evaluation", "test run", "improvements"], advanced: true }),
  card("reindex", "memory", "memory-reindex-heading", { keywords: ["rebuild search index", "reindex", "rebuild", "search index", "smart search", "search is missing", "indexing", "embeddings"], advanced: true }),
  card("health", "memory", "memory-health-heading", { keywords: ["health", "smart search", "index", "indexed", "backlog", "queued", "storage", "reclaim", "exclude", "excluded conversations", "policy history"], advanced: true }),
];

// ---- Models & engines (L4) ----
const MODELS: SettingsCard[] = [
  card("providers", "models", "models-heading", { keywords: ["models", "providers", "keys", "api key", "catalog", "flux", "pricing", "openai", "anthropic", "gemini", "google", "local models"] }),
  card("engines", "models", "engines-heading", { keywords: ["models", "claude", "grok", "providers", "cli", "flux", "flux router", "router", "opencode", "keys", "accounts", "engines"] }),
  card("paste-keys", "models", "paste-any-keys", { keywords: ["paste", "paste keys", "env", "add keys", "add a key", "replace keys"] }),
  card("existing-keys", "models", "existing-keys-heading", { keywords: ["existing keys", "default keys", "opencode", "default connections"] }),
  card("catalogs", "models", "model-catalogs-heading", { keywords: ["model catalogs", "catalog", "model list", "search models", "context", "chat models"], advanced: true }),
  card("local-servers", "models", "local-models-heading", { keywords: ["local models", "local servers", "ollama", "llama", "lm studio", "model server", "vllm"], advanced: true }),
  card("claude-accounts", "models", "claude-accounts-heading", { keywords: ["claude accounts", "several claude accounts", "second account", "config directory", "work account"], advanced: true }),
  card("command-lines", "models", "engine-command-lines-heading", { keywords: ["command line", "set cli", "cli", "binary", "path", "reset", "wrapper"], advanced: true }),
];

// ---- Tools (L4) ----
const TOOLS: SettingsCard[] = [
  card("search", "webSearch", "search-settings-heading", { keywords: ["search", "web search", "web", "internet", "tavily", "exa", "brave", "look up"] }),
  card("images", "webSearch", "image-settings-heading", { keywords: ["images", "image", "picture", "pictures", "photo", "photos", "gpt image", "image generation", "generate", "draw", "reference", "references", "reference packs", "packs", "prompt blocks", "blocks", "library"] }),
  card("voice", "webSearch", "voice-settings-heading", { keywords: ["voice", "transcription", "transcribe", "assemblyai", "voice notes", "speech", "dictation", "narration"] }),
  card("provider-keys", "webSearch", "search-keys-heading", { keywords: ["search keys", "provider keys", "tavily", "exa", "firecrawl", "api key", "web search key"], advanced: true }),
  card("daily-check", "webSearch", "image-daily-check-heading", { keywords: ["daily check", "image check", "daily image check", "probe", "test image model"], advanced: true }),
  card("voice-key", "webSearch", "voice-key-heading", { keywords: ["assemblyai key", "transcription key", "voice key", "api key"], advanced: true }),
];

// ---- Connected apps and Messaging apps (L1) ----
const REACH: SettingsCard[] = [
  card("apps", "connections", "connections-heading", { keywords: ["connected apps", "apps", "connections", "integrations", "gmail", "notion", "keys", "api"] }),
  card("mcp", "connections", "mcp-servers-heading", { keywords: ["mcp", "mcp servers", "servers"], advanced: true }),
  card("telegram", "channels", "telegram-settings-title", { keywords: ["telegram", "botfather", "pair", "messaging", "channels"] }),
  card("slack", "channels", "slack-settings-title", { keywords: ["slack", "messaging", "channels"] }),
  card("discord", "channels", "discord-settings-title", { keywords: ["discord", "messaging", "channels"] }),
  card("whatsapp", "channels", "whatsapp-settings-title", { keywords: ["whatsapp", "messaging", "channels"] }),
  card("slack-setup", "channels", "slack-app-setup-heading", { keywords: ["slack", "private app", "socket mode", "tokens"], advanced: true }),
  card("discord-setup", "channels", "discord-app-setup-heading", { keywords: ["discord", "private app", "application"], advanced: true }),
  card("allow-lists", "channels", "whatsapp-allow-heading", { keywords: ["allow list", "allowed", "who can message", "contacts", "whatsapp"], advanced: true }),
  card("whatsapp-groups", "channels", "whatsapp-groups-heading", { keywords: ["groups", "whatsapp groups", "group chats"], advanced: true }),
];

// ---- Devices (L4) ----
const DEVICES: SettingsCard[] = [
  card("browser", "companion", "browser-settings-heading", { keywords: ["built-in browser", "browser", "browser switch", "browser access"] }),
  card("pairing", "companion", "companion-heading", { keywords: ["companion", "phone", "pair", "mobile", "devices", "tablet", "laptop", "browser", "webui", "qr", "code", "tailscale", "remote access"] }),
  card("script-access", "companion", "script-access-heading", { keywords: ["script access", "scripts", "script"], advanced: true }),
  card("vps", "companion", "vps-heading", { keywords: ["vps", "remote computer", "server", "ssh", "box", "cloud computer", "remote"], advanced: true }),
  card("computer", "companion", "computer-settings-heading", { keywords: ["computer", "vm", "virtual", "desktop", "local vm", "vps", "server", "ssh", "box", "cloud computer", "browser", "browser profiles", "sign-in", "browser access", "other agents", "extension"] }),
];

// ---- Backups (L5) ----
const BACKUPS: SettingsCard[] = [
  card("backups", "backups", "backups-heading", { keywords: ["backup", "restore", "recovery", "schedule", "s3", "off-site", "remote", "restic", "age", "key", "recovery key", "age key", "encryption key"] }),
  card("storage", "backups", "storage-heading", { keywords: ["storage", "disk", "disk space", "free space", "space", "attachments", "full", "out of space"] }),
];

// ---- Usage (L6) ----
const USAGE: SettingsCard[] = [
  card("by-bot", "usage", "usage-heading", { keywords: ["usage", "tokens", "cost", "billing", "replies", "by bot", "export"], surface: "any" }),
  card("learning", "usage", "usage-learning-heading", { keywords: ["learning", "memory learning", "limit", "learning limit", "monthly limit", "tokens read", "tokens written"] }),
];

// ---- About & updates (L4 owns the page; L1 seeds) ----
const ABOUT: SettingsCard[] = [
  card("version", "about", "about-version-heading", { keywords: ["about & updates", "copy version", "version", "app version", "about", "help"], surface: "any" }),
  card("updates", "about", "updates-heading", { keywords: ["updates", "update", "version"], surface: "any" }),
  card("whats-new", "about", "whats-new-heading", { keywords: ["what's new", "whats new", "release notes"], surface: "any" }),
  card("announcements", "about", "announcements-heading", { keywords: ["announcements", "news", "notices"], advanced: true }),
  card("diagnostics", "about", "diagnostics-heading", { keywords: ["diagnostics", "logs", "support"], surface: "any", advanced: true }),
  card("setup", "about", "setup-heading", { keywords: ["setup", "first run", "get set up", "walkthrough"] }),
  card("shortcuts", "about", "shortcuts-heading", { keywords: ["keyboard", "shortcuts"], surface: "any" }),
  card("previous-version", "about", "previous-version-heading", { keywords: ["previous version", "go back", "downgrade", "older version", "reinstall", "roll back"] }),
];

export const SETTINGS_CARDS: readonly SettingsCard[] = [
  ...GENERAL, ...BOT_DEFAULTS, ...SKILLS, ...MEMORY, ...MODELS, ...TOOLS, ...REACH, ...DEVICES, ...BACKUPS, ...USAGE, ...ABOUT,
];

/** Anchors a card owes the DOM that the lane owning that page has not rendered yet. Each lane deletes its entries as
 *  it renders the ids; L7's gate asserts the map is empty. (A search "Open" on one of these lands on its page.) */
export const ANCHORS_OWED: Readonly<Record<string, string>> = {};

/** What a card is called in search results and the palette. */
export function cardLabel(card: Pick<SettingsCard, "id">): string {
  return t(`settings.l1.card.${card.id}` as LocaleKey);
}
