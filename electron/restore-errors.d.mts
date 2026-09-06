export class RestoreReviewRequiredError extends Error {
  readonly name: "RestoreReviewRequiredError";
  readonly code: "RESTORE_REVIEW_REQUIRED";
}
