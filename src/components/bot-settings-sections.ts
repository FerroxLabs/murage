export const BOT_SETTINGS_SECTIONS = [
  { id: "overview", label: "Overview", keywords: "profile avatar role chief leader individual imported team setup" },
  { id: "identity", label: "Identity & instructions", keywords: "name title description personality persona job" },
  { id: "skills", label: "Skills", keywords: "library learned tools knowledge skill enable review" },
  { id: "memory", label: "Memory", keywords: "notebook managed recall sources notes" },
  { id: "routines", label: "Routines", keywords: "schedule calendar automation recurring" },
  { id: "access", label: "Access", keywords: "computer browser connected apps accounts working folder workspace cloud" },
  { id: "model", label: "Model", keywords: "provider engine effort selection default" },
  { id: "permissions", label: "Permissions", keywords: "auto approval review safety contacting peers" },
  { id: "voice", label: "Voice & alerts", keywords: "speech notifications sound speak replies" },
  { id: "history", label: "History", keywords: "tasks conversations threads" },
  { id: "usage", label: "Usage", keywords: "cost tokens turns billing spend" },
] as const;
export type BotSettingsSection = typeof BOT_SETTINGS_SECTIONS[number]["id"];
export function filterBotSettingsSections(query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return BOT_SETTINGS_SECTIONS.filter(section => words.every(word => `${section.label} ${section.keywords}`.toLowerCase().includes(word)));
}
export const settingsRoleLabel = (role: string) => role === "chief" ? "Chief of Staff" : role === "leader" ? "Team leader" : role === "individual" ? "Individual bot" : "Team member";
export function activeSettingsRole(bot: { chiefOfStaff?: boolean; chiefScope?: string; individual?: boolean }) {
  return bot.chiefOfStaff ? bot.chiefScope === "workspace" ? "chief" : "leader" : bot.individual ? "individual" : "member";
}
