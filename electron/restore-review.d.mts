export const RESTORE_REVIEW_FILE: "restore-review.json";
export { RestoreReviewRequiredError } from "./restore-errors.mjs";
export function readRestoreReview(dataDir: string): Record<string, unknown> | null;
export function assertRestoreReviewed(dataDir: string): void;
