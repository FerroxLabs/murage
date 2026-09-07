export class RestoreReviewRequiredError extends Error {
  name = "RestoreReviewRequiredError";
  code = "RESTORE_REVIEW_REQUIRED";
  constructor() {
    super("This restored Murage installation requires recovery review before startup.");
  }
}
