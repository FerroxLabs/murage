// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { Suspense } from "react";
import type { Group, Bot } from "@/state/store";
import type { ProjectRead } from "@/lib/project-client";
import type { ProjectTab } from "@/lib/project-tab";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { LazyFallback } from "./LazyFallback";
const Board = retryableLazy(() => import("./ProjectBoard"));
const Overview = retryableLazy(() => import("./ProjectGoalView"));
const Activity = retryableLazy(() => import("./ProjectActivity"));
const Files = retryableLazy(() => import("./ProjectFilesView"));
const Memory = retryableLazy(() => import("./ProjectMemoryView"));
export function ProjectViewBody({ tab, group, members, project }: { tab: ProjectTab; group: Group; members: Bot[]; project: ProjectRead | null }) {
  const view = tab === "board" ? Board : tab === "overview" ? Overview : tab === "activity" ? Activity : tab === "files" ? Files : Memory;
  const body = tab === "files" ? <Files.Component group={group} members={members} /> : tab === "memory" ? <Memory.Component group={group} /> : tab === "board" ? <Board.Component group={group} members={members} project={project} /> : tab === "overview" ? <Overview.Component group={group} members={members} project={project} /> : <Activity.Component group={group} members={members} project={project} />;
  return <LazyBoundary key={tab} inline onRetry={view.retry}><Suspense fallback={<LazyFallback />}>{body}</Suspense></LazyBoundary>;
}
