// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Overview section slots (Settings v10 C9, owned by the shell). The Overview page draws <OverviewSection id="..."/> and
// never imports the component behind an id; the lane that owns a section replaces the body of the file named here (J1 fills
// ChangedRecently.tsx for "overview.changed"), so it never edits the Overview page and the slot needs no registration call
// at import time. An id with no loader, or whose file renders nothing, shows nothing, so a page ships before its sections do.
import { Suspense, type ComponentType } from "react";
import { LazyBoundary, retryableLazy } from "../LazyBoundary";

type SectionLoader = () => Promise<{ default: ComponentType }>;

/** slot id -> its lazy section file. One entry per line. */
export const OVERVIEW_SECTION_LOADERS: Readonly<Record<string, SectionLoader>> = {
  "overview.changed": () => import("./ChangedRecently"),
};

const mounted = new Map<string, ReturnType<typeof retryableLazy<ComponentType>>>();

export function OverviewSection({ id }: { id: string }) {
  const load = Object.prototype.hasOwnProperty.call(OVERVIEW_SECTION_LOADERS, id) ? OVERVIEW_SECTION_LOADERS[id] : undefined;
  if (!load) return null;
  let each = mounted.get(id);
  if (!each) { each = retryableLazy(load); mounted.set(id, each); }
  return (
    <LazyBoundary inline onRetry={each.retry}>
      <Suspense fallback={null}><each.Component /></Suspense>
    </LazyBoundary>
  );
}
