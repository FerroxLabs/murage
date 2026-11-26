// C13 · owner: core M0 (producer: server/memory/forget.ts fence) → find A8/M1, botpages B6 (consumers).
export interface ActiveExpectedHead { familyId: string; recordId: string; version: number; state: "active" }
export interface ArchivedExpectedHead { familyId: string; sequence: number; memberRecordId: string; memberVersion: number; state: "archived" }
/** A record outside any checkpoint family: its newest version is the head (v7). */
export interface RecordExpectedHead { recordId: string; version: number; state: "record" }
export type ExpectedHead = RecordExpectedHead | ActiveExpectedHead | ArchivedExpectedHead;
export const MEMORY_CHANGED = "MEMORY_CHANGED" as const;
/** 409 body when the displayed head moved on; nothing was written. */
export interface MemoryChangedConflict { error: typeof MEMORY_CHANGED }
