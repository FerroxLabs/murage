// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The backups row on the closing first-run card loads on first use. Only the
// row's words do: the backup step itself runs in useFirstRunBackupRun, which
// the closing card calls from always-loaded code, so the step starts on mount
// whether or not this chunk ever arrives. The row's own first render is
// empty, so the wait for the chunk shows the same empty space, and a failed
// load stays inside the card.
import { Suspense } from "react";

import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import type { FirstRunBackupRun } from "./first-run-backup-run";

const Chunk = retryableLazy(() => import("./FirstRunBackupsRow").then((module) => ({ default: module.FirstRunBackupsRow })));

export function LazyFirstRunBackupsRow({ backup }: { backup: FirstRunBackupRun }) {
  return (
    <LazyBoundary inline onRetry={Chunk.retry}>
      <Suspense fallback={null}>
        <Chunk.Component backup={backup} />
      </Suspense>
    </LazyBoundary>
  );
}
