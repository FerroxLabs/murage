// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The slot NeedsBlock draws beside a Today Decide row that is a waiting request (NEEDSYOU-INLINE-APPROVE). Only a
// lazy reference lives here: TodayQuickAnswer, the card read and the door's answer buttons load on first use.
import { Suspense } from "react";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import type { NeedsLine } from "@/lib/today-needs";

const Chunk = retryableLazy(() => import("./TodayQuickAnswer").then((module) => ({ default: module.TodayQuickAnswer })));

export interface TodayQuickSlot {
  /** the id of the row's line */
  labelledBy: string;
  settled: () => void;
  said: (text: string) => void;
}

export function todayQuickAnswer(line: NeedsLine, slot: TodayQuickSlot) {
  if (!line.request) return null;
  return (
    <LazyBoundary inline onRetry={Chunk.retry}>
      <Suspense fallback={null}>
        <Chunk.Component request={line.request} labelledBy={slot.labelledBy} onSettled={slot.settled} onSaid={slot.said} />
      </Suspense>
    </LazyBoundary>
  );
}
