// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A close or goal sign-off that had not finished when a backup was made is restore-held (restore-fence.ts): its
// summary request was expired by the restore, and an expired request is NOT completion. Only an explicit owner
// action after the restore releases it: pressing Close again finishes the close; Resume abandons a held close
// and lets a held goal sign-off finish.
import type { DatabaseSync } from "node:sqlite";

import { currentProjectClose, insertProjectActivity } from "./project-records.ts";
import { releaseRestoreHold, releaseRestoreHolds, sqlRowRestoreHeld } from "./restore-fence.ts";

export const projectCloseHeld = (db: DatabaseSync, groupId: string, closeSeq: number) => sqlRowRestoreHeld(db, "project_close", `${groupId}:${closeSeq}`);
export const goalCloseHeld = (db: DatabaseSync, groupId: string, goalId: string) => sqlRowRestoreHeld(db, "goal_close", `${groupId}:${goalId}`);

/** The owner pressed Close again on a close the restore held: that press authorizes finishing it. */
export function releaseHeldCloseForClose(db: DatabaseSync, groupId: string): boolean {
  const step = currentProjectClose(db, groupId);
  return !!step && step.step < 3 && releaseRestoreHold(db, "project_close", `${groupId}:${step.closeSeq}`);
}

/** The owner resumed the project. A close the restore held is abandoned (the project is not closing any more);
 * a goal sign-off the restore held is released and finishes. */
export function releaseHeldClosesForResume(db: DatabaseSync, groupId: string, now: number): void {
  const step = currentProjectClose(db, groupId);
  if (step && step.step < 3 && releaseRestoreHold(db, "project_close", `${groupId}:${step.closeSeq}`)) {
    insertProjectActivity(db, { groupId, kind: "close", actor: "owner", at: now, requestId: step.summaryRequestId ?? undefined, detail: { ...step, step: 3, abandoned: true } });
  }
  releaseRestoreHolds(db, "goal_close", `${groupId}:`);
}
