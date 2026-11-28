// C3 · owner: access (producer) → roster, botpages, find (consumers).
// Read: botAccessPolicy(bot).revision (server/bot-access-role.ts): default 0, first save 1.
export interface SavedChoicesSummary { botId: string; revision: number; mode: "unrestricted" | "restricted"; grants: number; hasSavedPolicy: boolean }
/** Every access-clearing save (archive, team delete, Move) sends the reviewed revision per bot. */
export interface AccessRevisionBody { accessRevision: number }
export type AccessRevisionMap = Record<string, number>;
