// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tells a change the editor made itself from one handed in from outside.
// The editor reports every edit through onChange and the parent hands the
// text back as `value` one render later. When edits come faster than renders
// (typing under load), `value` is an older edit than the latest, so a single
// "last emitted" slot mistook it for an outside change and replaced the
// document with the stale text, moving the caret to the start.

const KEEP = 64;

export interface EmittedValues {
  /** Record the Markdown the editor just produced. */
  note(markdown: string): void;
  /** True when `value` should replace the document: it is not the latest
   *  edit and not one of the recent edits still on their way back. */
  isOutside(value: string): boolean;
  /** An outside change was applied: older edits no longer count. */
  reset(markdown: string): void;
}

export function createEmittedValues(initial: string): EmittedValues {
  let latest = initial;
  let recent: string[] = [];
  return {
    note(markdown) {
      latest = markdown;
      recent.push(markdown);
      if (recent.length > KEEP) recent = recent.slice(-KEEP);
    },
    isOutside(value) {
      return value !== latest && !recent.includes(value);
    },
    reset(markdown) {
      latest = markdown;
      recent = [];
    },
  };
}
