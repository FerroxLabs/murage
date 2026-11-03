// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the workspace pane does while it is closed, kept in the always-loaded
// code: it makes sure the conversation's task is loaded and keeps one drafts
// store for the conversation view's lifetime, open or not. The open pane
// itself (WorkspacePaneOpen) loads on first use.
import { useMemo } from "react";

import { useStore, type Bot } from "@/state/store";
import { useEnsureTask } from "@/lib/use-ensure-task";
import { useDesktopSurface } from "@/lib/use-surface";
import { createIndexedDbDraftBackend, createMarkdownDraftStore, type MarkdownDraftStore } from "@/lib/markdown-drafts";

export function useWorkspacePaneGate(bot: Bot): { open: boolean; drafts: MarkdownDraftStore } {
  const { state } = useStore();
  const desktop = useDesktopSurface();
  const pane = state.workspacePane;
  useEnsureTask("bot", pane.filesRequest?.botId ?? bot.id, pane.filesRequest?.threadId ?? state.bots.find(item => item.id === pane.filesRequest?.botId)?.threadId ?? bot.threadId);
  const drafts = useMemo(() => createMarkdownDraftStore(createIndexedDbDraftBackend()), []);
  return { open: desktop === true && pane.open, drafts };
}
