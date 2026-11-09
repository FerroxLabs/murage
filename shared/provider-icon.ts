// The provider marks an engine can show in place of its driver's own mark (upstream #4067).
// Only marks Murage draws in src/components/ProviderIcons.tsx PresetProviderMark.
export const PROVIDER_ICON_PRESETS = [
  "openai", "anthropic", "google", "azure", "aws", "xai", "deepseek",
  "meta", "mistral", "qwen", "moonshot", "cohere", "openrouter",
] as const;

export type ProviderIconPreset = typeof PROVIDER_ICON_PRESETS[number];

export type ProviderIcon = { kind: "preset"; preset: ProviderIconPreset };
