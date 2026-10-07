// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { Suspense } from "react";
import type { ProjectRead } from "@/lib/project-client";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
const SinceYouLeft = retryableLazy(() => import("./ProjectSinceYouLeft"));
export function ProjectSinceYouLeftLazy(props: { counts: ProjectRead["sinceYouLeft"]; onBoard: () => void; boardEnabled: boolean }) {
  return <LazyBoundary inline onRetry={SinceYouLeft.retry}><Suspense fallback={null}><SinceYouLeft.Component {...props} /></Suspense></LazyBoundary>;
}
