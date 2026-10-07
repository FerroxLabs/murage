import { botRole, BOT_ROLE_TITLE, type BotRole, type RoleBot } from "@/lib/bot-role";

export const BOT_SETTINGS_SECTIONS = [
  { id: "overview", label: "Overview", keywords: "profile role chief leader individual imported team setup" },
  { id: "identity", label: "Identity & instructions", keywords: "appearance avatar image picture photo upload shape mascot expression color flux generate name title description personality persona job" },
  { id: "shapes", label: "What shapes this bot", keywords: "what it reads house rules team brief guide prompt system instructions order locked" },
  { id: "skills", label: "Skills", keywords: "library learned tools knowledge skill enable review" },
  { id: "learning", label: "Learning", keywords: "learn lessons feedback nudge teach undo suggestions" },
  { id: "memory", label: "Memory", keywords: "notebook managed recall sources notes" },
  { id: "routines", label: "Routines", keywords: "schedule calendar automation recurring" },
  { id: "teams", label: "Teams", keywords: "shared team sharing copy client general notes" },
  { id: "access", label: "Access", keywords: "computer browser connected apps accounts working folder workspace cloud sites published website online take down" },
  { id: "model", label: "Model", keywords: "provider engine effort selection default" },
  { id: "permissions", label: "Permissions", keywords: "auto approval review safety contacting peers full access ask telegram slack discord setup images image generation" },
  { id: "voice", label: "Voice & alerts", keywords: "speech notifications sound speak replies" },
  { id: "history", label: "History", keywords: "tasks conversations threads" },
  { id: "usage", label: "Usage", keywords: "cost tokens turns billing spend" },
] as const;
/** The row that carries the "new things learned" count: the Learning screen, where what the bot learned is read, edited and undone. */
export const LEARNING_BADGE_SECTION: BotSettingsSection = "learning";
export type BotSettingsSection = typeof BOT_SETTINGS_SECTIONS[number]["id"];
/** A section's name in this bot's window: "What shapes" names the bot. */
export function botSettingsSectionLabel(section: typeof BOT_SETTINGS_SECTIONS[number], botName: string): string {
  return section.id === "shapes" ? `What shapes ${botName}` : section.label;
}
/** Sections that read or change desktop-only routes: not offered elsewhere. */
export const DESKTOP_ONLY_BOT_SETTINGS: ReadonlySet<BotSettingsSection> = new Set(["shapes", "teams", "learning"]);
export function filterBotSettingsSections(query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return BOT_SETTINGS_SECTIONS.filter(section => words.every(word => `${section.label} ${section.keywords}`.toLowerCase().includes(word)));
}
export const settingsRoleLabel = (role: string) => BOT_ROLE_TITLE[role as BotRole] ?? BOT_ROLE_TITLE.member;
/** The role this bot holds right now. `botRole()` is the one reader of the
 *  three org-chart fields; an imported package's `sourceRole` is metadata
 *  about where the bot came from and never decides leadership. */
export function activeSettingsRole(bot: RoleBot): BotRole {
  return botRole(bot);
}
