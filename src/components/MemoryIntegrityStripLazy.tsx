// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The memory strip loads on first use: its feed, the upgrade reducer and the
// strip words stay out of first paint. The strip is silent until its first
// health reading says there is something to tell, and the feed only starts
// looking once the strip subscribes, so the wait for the chunk shows the same
// silence. A failed load stays inside the strip's own row.
import { Suspense } from "react";

import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";

const Chunk = retryableLazy(() => import("./MemoryIntegrityStrip").then((module) => ({ default: module.MemoryIntegrityStrip })));

export function LazyMemoryIntegrityStrip() {
  return (
    <LazyBoundary inline onRetry={Chunk.retry}>
      <Suspense fallback={null}>
        <Chunk.Component />
      </Suspense>
    </LazyBoundary>
  );
}
