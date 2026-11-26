// C12 · owner: core J0 (producer: server/settings/journal.ts) → access, devices, shell X2, roster (consumers).
export type JournalActor = { kind: "owner" } | { kind: "bot"; botId: string } | { kind: "murage" } | { kind: "otherProgram"; name?: string };
export interface JournalWrite {
  /** Client change id: the journal upserts by it. */
  changeId: string;
  /** Derived from the authenticated request or turn, never from a body. */
  actor: JournalActor;
  /** Writer-table key (a writer missing from the table fails J0's test). */
  writer: string;
  settingId: string;
  bot?: string;
  /** Recorded only when the writer table marks the value recordable; never secret values. */
  before?: unknown;
  after?: unknown;
}
export interface JournalRow extends JournalWrite { at: number }
export type JournalLookup = { state: "saved"; row: JournalRow } | { state: "notSaved" } | { state: "couldNotCheck" };
export const JOURNAL_RETENTION_DAYS = 90;
