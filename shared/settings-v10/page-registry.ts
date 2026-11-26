// C9 · owner: shell (producer: page-registry.tsx) → every page lane, find A1/J1 (consumers).
export type SettingsRail = "app" | "bot";
export interface PageSlot { id: string; rail: SettingsRail; group: string; title: string; phone: boolean }
/** Named Overview section slot; renders nothing until a component registers for the id (e.g. "overview.changed"). */
export type OverviewSectionId = "overview.changed" | (string & {});
