// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Health screen's door (Sean 10-30, 11-01): its own page off the You menu and a quiet link on Needs you. The body
// loads on first use, like every other view's page, so Health stays out of the first paint.
import { Suspense } from "react";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import { LazyFallback } from "@/components/LazyFallback";
import type { HealthPageProps } from "@/components/shell/shell-contract";

const Body = retryableLazy(() => import("./HealthPageBody").then((module) => ({ default: module.HealthPageBody })));

export function HealthPage(props: HealthPageProps) {
  return <LazyBoundary onRetry={Body.retry}><Suspense fallback={<LazyFallback />}><Body.Component {...props} /></Suspense></LazyBoundary>;
}
