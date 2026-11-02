// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The backups row on the closing first-run card loads on first use: the
// backup schedule code it brings (backups-section-ui and the capture-failure
// words) stays out of first paint. The row's own first render is empty and
// its schedule read starts once it mounts, so the wait for the chunk shows
// the same empty space, and a failed load stays inside the card.
import { Suspense } from "react";

import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";

const Chunk = retryableLazy(() => import("./FirstRunBackupsRow").then((module) => ({ default: module.FirstRunBackupsRow })));

export function LazyFirstRunBackupsRow() {
  return (
    <LazyBoundary inline onRetry={Chunk.retry}>
      <Suspense fallback={null}>
        <Chunk.Component />
      </Suspense>
    </LazyBoundary>
  );
}
