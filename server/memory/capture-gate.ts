// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one rule for whether memory notes new things and recalls old ones, in a leaf module so the capture path (capture.ts) and the status the
// owner reads (the upgrade state and /api/memory/status) are computed by the same predicate and cannot disagree. A hold (the integrity pass
// set earlier memory aside) switches both off whatever the stored mode says; the owner's "paused" still captures.
export type StoredMemoryMode = "off" | "capture" | "active" | "paused";

/** Whether sources are captured now. */
export function memoryCaptures(mode: string | undefined | null, holdCode: string | null): boolean { return mode !== "off" && holdCode === null; }
/** Whether recall (and everything that reads earlier memory) is on now. */
export function memoryRecalls(mode: string | undefined | null, holdCode: string | null): boolean { return mode === "active" && holdCode === null; }
