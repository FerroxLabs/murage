// C5 · owner: roster (producer: ConfirmClearsAppChoices + openArchiveReview in src/lib/archive-review.ts)
//      → botpages B2/B3, shell Sidebar (consumers).
export type ArchiveReviewOutcome = "archived" | "cancelled" | "conflict";
export interface ArchiveReviewBot { id: string; name: string; accessRevision: number; savedChoices: string[]; /** A policy is saved even when it names no apps (restricted with none, or a revision above 0). Absent = read from savedChoices alone. */ hasSavedPolicy?: boolean }
export type OpenArchiveReview = (bot: ArchiveReviewBot) => Promise<ArchiveReviewOutcome>;
export interface ConfirmClearsAppChoicesProps { bots: ArchiveReviewBot[]; action: "archive" | "deleteTeamKeep" | "deleteTeamArchive"; onConfirm: () => void; onCancel: () => void }
