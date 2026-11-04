// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The workspace pane loads the first time it opens, so its editor, file rail
// and previews stay out of first paint. While closed it does what it always
// did (useWorkspacePaneGate). While the chunk arrives the pane's place shows
// the app's spinner, without covering the chat, and a failed load stays
// inside the pane.
import { Suspense } from "react";

import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import { Loader2 } from "lucide-react";
import type { Bot } from "@/state/store";
import { useWorkspacePaneGate } from "./workspace-pane-gate";

const Chunk = retryableLazy(() => import("./WorkspacePane").then((module) => ({ default: module.WorkspacePaneOpen })));

/** The spinner LazyFallback uses, in the pane's place rather than over the app. */
function PaneLoading() {
  return (
    <div role="status" aria-label="Loading" className="hidden shrink-0 items-center justify-center px-6 md:flex">
      <Loader2 size={20} className="animate-spin text-ink-secondary" aria-hidden="true" />
    </div>
  );
}

export function LazyWorkspacePane({ bot }: { bot: Bot }) {
  const { open, drafts } = useWorkspacePaneGate(bot);
  if (!open) return null;
  return (
    <LazyBoundary inline onRetry={Chunk.retry}>
      <Suspense fallback={<PaneLoading />}>
        <Chunk.Component bot={bot} drafts={drafts} />
      </Suspense>
    </LazyBoundary>
  );
}
