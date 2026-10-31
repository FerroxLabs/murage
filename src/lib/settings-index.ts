// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S2: one index over every Settings control, the app's cards and every bot's rows. Built from two
// sources: SETTINGS_CARDS (lib/settings-card-registry.ts, the app cards, unchanged in shape) and BOT_SETTINGS_CARDS
// below (one entry per per-bot control, `scope: "bot"`, anchored on its row in components/SettingsPanel.tsx).
// The ranker in lib/settings-search.ts searches this index; nothing here matches or ranks.
//
// `words` are matched against what a person types and never shown: they keep the words people use ("mcp", "api",
// "token", "ollama") even where a label says something plainer.
//
// Loaded with the modal and the palette, never on the first paint (the words).
import { PHONE_CARD_COPY } from "../../shared/phone-copy";
import { BOT_SETTINGS_SECTIONS, DESKTOP_ONLY_BOT_SETTINGS, type BotSettingsSection } from "@/components/bot-settings-sections";
import { SETTINGS_STUB_COPY } from "@/components/SettingsStub";
import { t } from "./i18n";
import { PEER_CONTACT_LABEL } from "./permission-mode";
import { SETTINGS_CARDS, cardLabel } from "./settings-card-registry";
import type { SettingsCard, SettingsCardSurface } from "./settings-cards";
import type { SettingsPage } from "./settings-pages";

/** A feature an entry depends on. The entry is always indexed and listed (section 5: never hide silently); its
 *  reason line is one more field the ranker reads, last. */
export interface SettingsGate {
  feature: "flux-email" | "off-by-choice";
  reason: () => string;
}

interface IndexFields {
  /** Unique across the whole index: "general.profile" (app) or "bot.access.folder" (bot). */
  id: string;
  /** DOM id on the control's row (bot) or the card's heading (app); unique within its window. */
  anchor: string;
  /** Under the page's one Advanced fold. Bot sections have none. */
  advanced: boolean;
  surface: SettingsCardSurface;
  /** What a person might type: matched, never shown. */
  words: readonly string[];
  /** The visible name, read when searched so a language change follows. */
  label: () => string;
  gate?: SettingsGate;
}

export interface AppIndexEntry extends IndexFields {
  scope: "app";
  section: SettingsPage;
  card: SettingsCard;
}

export interface BotIndexEntry extends IndexFields {
  scope: "bot";
  section: BotSettingsSection;
}

export type SettingsIndexEntry = AppIndexEntry | BotIndexEntry;

const OFF_BY_CHOICE = (letsBots: string): SettingsGate => ({ feature: "off-by-choice", reason: () => SETTINGS_STUB_COPY.off(letsBots) });
const FLUX_EMAIL: SettingsGate = { feature: "flux-email", reason: () => SETTINGS_STUB_COPY.needsAccount("your Chief") };

/** Gates on app cards, by card id: their card renders a stub while the feature is off (S1). */
const APP_GATES: Readonly<Record<string, SettingsGate>> = {
  "connections.bot-email": FLUX_EMAIL,
  "skills.recorder": OFF_BY_CHOICE("learn a skill from a recording or /learn"),
  "companion.browser": OFF_BY_CHOICE("use a browser tab you can watch and take over"),
};

const sectionLabel = (section: BotSettingsSection) => BOT_SETTINGS_SECTIONS.find((entry) => entry.id === section)!.label;

// `keywords` by name: the copy rules know these are matched against what a person types and never shown.
const bot = (section: BotSettingsSection, name: string, label: () => string, spec: { keywords: readonly string[]; surface?: SettingsCardSurface; gate?: SettingsGate }): BotIndexEntry => ({
  id: `bot.${section}.${name}`,
  scope: "bot",
  section,
  anchor: `bot-setting-${name}`,
  advanced: false,
  surface: spec.surface ?? (DESKTOP_ONLY_BOT_SETTINGS.has(section) ? "desktop" : "any"),
  words: spec.keywords,
  label,
  ...(spec.gate ? { gate: spec.gate } : {}),
});

/** Every per-bot control, in the order the bot window shows its sections. Labels are the rows' own visible names. */
export const BOT_SETTINGS_CARDS: readonly BotIndexEntry[] = [
  bot("overview", "setup", () => "What is this bot for?", { keywords: ["purpose", "setup", "set up", "job", "what it does", "help with", "intake", "starter skills"] }),
  bot("overview", "role", () => "Role", { keywords: ["role", "chief", "chief of staff", "leader", "lead", "member", "reports to", "org chart", "team"] }),
  bot("identity", "avatar", () => t("settings.appearance.title"), { keywords: ["appearance", "avatar", "picture", "photo", "image", "mascot", "look", "face", "color", "colour", "expression", "upload"] }),
  bot("identity", "name", () => t("settings.bot.identity.name"), { keywords: ["name", "rename", "call it"] }),
  bot("identity", "title", () => t("settings.bot.identity.title"), { keywords: ["title", "job title", "position"] }),
  bot("identity", "instructions", () => t("settings.bot.identity.instructions"), { keywords: ["instructions", "description", "prompt", "system prompt", "about", "job", "tell it", "brief"] }),
  bot("identity", "personality", () => t("settings.bot.identity.personality"), { keywords: ["personality", "persona", "tone", "style", "character", "vibe", "snarky"] }),
  bot("shapes", "shapes", () => "What shapes this bot", { keywords: ["what it reads", "house rules", "team brief", "instructions order", "read order", "locked", "prompt", "system prompt", "guide"] }),
  bot("skills", "skills", () => sectionLabel("skills"), { keywords: ["skills", "skill", "add a skill", "enable", "disable", "learned skills", "library", "tools", "knowledge"] }),
  bot("learning", "learning", () => sectionLabel("learning"), { keywords: ["learning", "lessons", "feedback", "teach", "undo", "learn", "nudge", "suggestions"] }),
  bot("memory", "memory", () => t("settings.bot.memory.title"), { keywords: ["memory", "managed memory", "open memory", "remember", "recall", "facts", "forget", "sources", "delete", "erase", "wipe", "remove"] }),
  bot("memory", "notebook", () => t("settings.bot.notebook.title"), { keywords: ["notebook", "notes", "legacy notebook", "memory.md"] }),
  bot("routines", "routines", () => sectionLabel("routines"), { keywords: ["routines", "routine", "schedule", "recurring", "automation", "paused", "calendar", "cron"] }),
  bot("teams", "teams", () => sectionLabel("teams"), { keywords: ["teams", "shared", "sharing", "team notes", "client", "general notes", "copy"] }),
  bot("access", "apps", () => t("settings.bot.apps.title"), { keywords: ["connected apps", "apps", "integrations", "gmail", "notion", "mcp", "connections", "accounts", "api"] }),
  bot("access", "app-access", () => "App access and approvals", { keywords: ["app access", "access limits", "connected account", "manager", "limits"] }),
  bot("access", "phone", () => PHONE_CARD_COPY.title, { keywords: ["phone", "mobile", "iphone", "android", "phone tools", "sms", "texts", "paired phone"] }),
  bot("access", "phone-for-bots", () => t("settings.bot.phoneForBots.title"), { keywords: ["phone", "mobile", "pair", "pair my phone", "iphone", "android"] }),
  bot("access", "browser", () => t("settings.bot.browser.title"), { keywords: ["browser", "web", "built-in browser", "browse", "chrome", "websites"] }),
  bot("access", "computer", () => t("settings.bot.computer.title"), { keywords: ["computer", "vm", "virtual machine", "cloud", "cloud computer", "local", "this computer", "vps", "server", "sandbox", "box", "where it runs", "ssh"], surface: "desktop" }),
  bot("access", "folder", () => t("settings.bot.folder.title"), { keywords: ["working folder", "folder", "directory", "workspace", "files", "path", "project folder", "cwd"] }),
  bot("access", "sites", () => t("publish.sites.title"), { keywords: ["published sites", "website", "websites", "sites", "publish", "take down", "online", "web page"] }),
  bot("email", "email", () => sectionLabel("email"), { keywords: ["email", "mail", "inbox", "address", "email address", "trusted contacts", "never email", "pause sending", "send", "agentmail"], gate: FLUX_EMAIL }),
  bot("model", "model", () => t("settings.bot.model.title"), { keywords: ["model", "engine", "ai", "provider", "llm", "claude", "gpt", "codex", "grok", "gemini", "fuigo", "openai"] }),
  bot("model", "backup", () => t("slik.backupTitle"), { keywords: ["backup model", "fallback", "at its limit", "runs out", "limit", "switch engine"], surface: "desktop" }),
  bot("model", "effort", () => t("settings.bot.effort.title"), { keywords: ["effort", "thinking", "reasoning", "depth", "think harder"] }),
  bot("permissions", "level", () => "Approvals", { keywords: ["approval", "approvals", "approve", "ask", "auto", "full access", "no limits", "permission", "permissions", "autonomy", "level", "trust"] }),
  bot("permissions", "can-talk", () => t("canTalk.label"), { keywords: ["who can talk", "talk to", "can talk to", "contacts", "messages from", "who can message"] }),
  bot("permissions", "peers", () => PEER_CONTACT_LABEL, { keywords: ["peers", "other bots", "contacting peers", "coordinate", "ask before contacting"] }),
  bot("permissions", "images", () => t("botImages.title"), { keywords: ["images", "image", "image generation", "pictures", "draw", "generate", "photo"] }),
  bot("permissions", "always-allowed", () => "Always allowed", { keywords: ["always allow", "always allowed", "remembered approvals", "allowed commands", "grants", "remove"] }),
  bot("permissions", "review", () => t("settings.bot.review.title"), { keywords: ["review", "auto review", "shadow", "enforce", "routine approvals", "check"] }),
  bot("voice", "voice", () => "Voice", { keywords: ["voice", "speech", "speak", "read aloud", "read replies aloud", "elevenlabs", "tts", "talk"] }),
  bot("voice", "notifications", () => t("settings.bot.notifications.title"), { keywords: ["notifications", "notify", "alerts", "alert", "sound", "ping", "badge"] }),
  bot("history", "history", () => sectionLabel("history"), { keywords: ["history", "conversations", "threads", "tasks", "past chats", "older"] }),
  bot("usage", "usage", () => t("usageCard.title"), { keywords: ["usage", "cost", "spend", "tokens", "billing", "this month", "turns"] }),
];

/** The app cards as index entries; the card itself rides along for the openers that take a SettingsCard. */
export const APP_SETTINGS_ENTRIES: readonly AppIndexEntry[] = SETTINGS_CARDS.map((card) => ({
  id: card.id,
  scope: "app",
  section: card.section,
  anchor: card.anchor,
  advanced: card.advanced,
  surface: card.surface,
  words: card.words,
  label: () => cardLabel(card),
  card,
  ...(APP_GATES[card.id] ? { gate: APP_GATES[card.id] } : {}),
}));

/** One index, app first, then every bot control. Registry order is the ranker's tie-break. */
export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [...APP_SETTINGS_ENTRIES, ...BOT_SETTINGS_CARDS];

/** Index invariants, for the gate test: unique ids, unique anchors per window, words on every entry, ids shaped
 *  section.name, a bot entry's id names its own section, and every gate's card exists. Returns the problems found. */
export function settingsIndexProblems(entries: readonly SettingsIndexEntry[] = SETTINGS_INDEX): string[] {
  const problems: string[] = [], ids = new Set<string>(), anchors = { app: new Set<string>(), bot: new Set<string>() };
  for (const entry of entries) {
    if (ids.has(entry.id)) problems.push(`duplicate id ${entry.id}`);
    if (anchors[entry.scope].has(entry.anchor)) problems.push(`duplicate ${entry.scope} anchor ${entry.anchor}`);
    if (!entry.words.length) problems.push(`${entry.id} has no words`);
    if (!/^[a-z][a-zA-Z0-9-]*(\.[a-z0-9-]+)+$/.test(entry.id)) problems.push(`${entry.id} is not section.name`);
    if (entry.scope === "bot" && !entry.id.startsWith(`bot.${entry.section}.`)) problems.push(`${entry.id} is not in bot.${entry.section}`);
    if (!entry.label().trim()) problems.push(`${entry.id} has no label`);
    ids.add(entry.id);
    anchors[entry.scope].add(entry.anchor);
  }
  for (const id of Object.keys(APP_GATES)) if (!entries.some((entry) => entry.id === id)) problems.push(`gate for missing card ${id}`);
  return problems;
}
