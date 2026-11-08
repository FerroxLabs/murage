// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The tool a row carries once its engine reports the step's end (index.ts item.completed). The whole tool object is rebuilt,
// so a mark the row had while it was open (1.0.18 U6 E15 `unrecorded`, set when its turn ended first) is cleared: the real
// outcome always wins. `spoken`, `summary` and a notice flag ride across, or the completed step would lose its narration.
import type { Message } from "./store.ts";
import { completedToolAction } from "./reply-action-guard.ts";

type Tool = NonNullable<Message["tool"]>;

export function completedToolRow(existing: Tool | undefined, ok: boolean, result: unknown, detail: string | undefined): Tool {
  return {
    name: existing?.name ?? "tool",
    action: completedToolAction(existing, ok, result),
    ok,
    spoken: existing?.spoken,
    summary: existing?.summary,
    // a failed tool that says only its name leaves the user guessing, so the engine's reason rides along to the chip
    errorDetails: ok ? undefined : detail,
    ...(existing?.notice ? { notice: true } : {}),
  };
}
