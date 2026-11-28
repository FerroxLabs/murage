// C16 · owner: tools T1/T2/G4 (producer) → access R0 (consumer).
export interface ToolTruth { toolId: string; on: boolean; reason?: string }
export type ToolTruthForBot = (botId: string) => ToolTruth[];
