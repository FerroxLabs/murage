// C15b · owner: botpages B6 (producer: shared voice interface, VoiceSettings.tsx) → tools A3 (consumer).
export interface VoiceSettingsProps { botId?: string; scope: "app" | "bot"; onChanged?: () => void }
