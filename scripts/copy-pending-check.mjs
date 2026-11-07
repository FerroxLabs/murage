// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Release gate (release.yml, prepare): copy-lint/pending-review.json must be empty at the release cut.
// Node built-ins only: the prepare job runs before any install.
import { releasePendingProblems } from "./copy-lint.mjs";

const problems = releasePendingProblems();
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error("::error::every shipped string needs a review record before a release (scripts/copy-review.mjs)");
  process.exit(1);
}
console.log("ok: no string is waiting for a review record");
