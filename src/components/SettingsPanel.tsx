// Settings v10 B0: the bot settings panel now lives in one file per bot page under ./bot-pages/.
// This file only re-exports, so every importer keeps working.
export { BotPanel as SettingsPanel, SettingsSection } from "./bot-pages";
