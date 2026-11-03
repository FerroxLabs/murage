// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "@/state/store";

/** DELEGATION-HOLD F5: the server's row for a reply that ran without remembered context (memory/dispatch.ts turnRefusedLine
 * "without-memory"). It is a notice, not a tool run, so a direct chat and a room show it as a quiet sentence with
 * Settings > Tool calls off, the same as the sidebar preview. */
export function isWithoutMemoryNote(message: Pick<Message, "kind" | "memoryNote" | "tool">): boolean {
  return message.kind === "activity" && message.memoryNote === "without-memory" && Boolean(message.tool?.name);
}

export function WithoutMemoryNoteRow({ text }: { text: string }) {
  return (
    <div className="flex justify-start">
      <div role="status" data-testid="without-memory-note" className="min-w-0 max-w-full rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  );
}
