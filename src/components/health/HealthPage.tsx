// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Health screen's door (Sean 10-30, 11-01): its own page off the You menu and a quiet link on Needs you. The body
// loads on first use, like every other view's page, so Health stays out of the first paint.
import { Suspense, type ReactNode } from "react";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import type { HealthPageProps } from "@/components/shell/shell-contract";
import { HealthFrame, HealthLoading, useHealthEscape } from "./HealthExit";

const Body = retryableLazy(() => import("./HealthPageBody").then((module) => ({ default: module.HealthPageBody })));

// Esc, the header and its Back and close live here, outside the lazy body, so Health can be left while its body is
// still loading or after it failed to load (Sean 11-02: never stuck on Health). The spinner and the retry are drawn
// inside Health's own frame, under the header, never as an overlay that covers it.
export function HealthPage(props: HealthPageProps) {
  useHealthEscape(props.onLeave);
  const frame = (content: ReactNode) => <HealthFrame onLeave={props.onLeave}>{content}</HealthFrame>;
  return (
    <LazyBoundary inline onRetry={Body.retry} onDismiss={props.onLeave} frame={frame}>
      <Suspense fallback={frame(<HealthLoading />)}><Body.Component {...props} /></Suspense>
    </LazyBoundary>
  );
}
