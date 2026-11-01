// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which surface a feedback item came from. Its own small module so App.tsx can
// name it without pulling the screen envelope into the first paint.
export type FeedbackSurface = "desktop" | "phone" | "cloud";

/** A surface that has not answered yet is not taken to be the desktop: it
 *  reads as the phone, the narrow side. */
export function feedbackSurface(desktop: boolean | undefined, cloud: boolean): FeedbackSurface {
  if (cloud) return "cloud";
  return desktop === true ? "desktop" : "phone";
}
