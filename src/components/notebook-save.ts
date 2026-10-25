// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Save is on only once a load has returned the notebook's revision, and never after a failed load: the server refuses a save without one,
 * and a blind save could replace words the bot wrote (U33). */
export function notebookCanSave(state: { saving: boolean; dirty: boolean; revision: string | undefined }): boolean {
  return !state.saving && state.dirty && typeof state.revision === "string" && state.revision.length > 0;
}
/** The PUT body: always carries the revision this editor loaded. */
export function notebookSaveBody(text: string, revision: string): { text: string; baseRevision: string } {
  return { text, baseRevision: revision };
}
