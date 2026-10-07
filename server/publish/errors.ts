// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs

export type PublishErrorCode =
  | "outside" | "no-folder" | "symlink" | "not-a-file" | "no-index" | "too-many-files" | "too-large" | "bad-name" | "bad-id"
  | "reconnect" | "rate-limited" | "host-down" | "name-taken" | "not-found" | "not-live" | "declined" | "unanswered" | "cancelled" | "changed" | "not-yours";

/** An error whose text is fixed here and written for the owner. It never carries
 * an upstream response body or a credential. */
export class PublishError extends Error {
  readonly code: PublishErrorCode;
  constructor(code: PublishErrorCode, message: string) { super(message); this.name = "PublishError"; this.code = code; }
}
