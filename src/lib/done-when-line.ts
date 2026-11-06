// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U4 S3: what the done-when line under a hand-off row paints (server/done-when.ts bounds and checks it; components/DoneWhenLine.tsx paints it).

/** The line as painted, or "" when there is none: the server bounds and checks it; a row that is somehow longer is not painted. */
export function doneWhenText(text?: string): string {
  const line = typeof text === "string" ? text.trim() : "";
  return line && [...line].length <= 280 ? line : "";
}

/** A hand-off row with a done-when line shows whatever the "Tool calls" setting is: the line is the hand-off's own promise, not tool noise. */
export function hasDoneWhenLine(text?: string): boolean { return doneWhenText(text) !== ""; }
