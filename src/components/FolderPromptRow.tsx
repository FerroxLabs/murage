// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// macOS is holding the turn at its own folder prompt (shared/mac-folder-prompt.ts). Information only: there is no
// request here to answer, so the row has no buttons, and Stop stays where it always is.
export function FolderPromptRow({ text }: { text: string }) {
  return (
    <div className="flex justify-start">
      <div role="status" data-testid="folder-prompt" className="min-w-0 max-w-[42rem] rounded-xl border border-hairline/50 bg-card px-3 py-2 text-[13px] text-ink-secondary">{text}</div>
    </div>
  );
}
