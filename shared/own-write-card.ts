// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export type OwnWriteState = "waiting" | "approved" | "applying" | "applied" | "declined" | "expired" | "unknown";
export interface OwnWriteCardData {
  version: 1; holdId: string; stateRevision: number; state: OwnWriteState;
  tool: string; bodyHash: string; ref: string; detail: string; restored?: boolean;
}
export const OWN_WRITE_COPY = {
  title: "Review this change", allow: "Allow", deny: "Don't allow", waiting: "Waiting for you",
  approved: "Approved", applying: "Making this change", applied: "Change made", declined: "Not allowed",
  expired: "Expired", unknown: "Check the result before trying again", restored: "This request came from a backup. Ask your bot to try again.",
  unavailable: "This change could not be made. Ask your bot to try again.",
} as const;
