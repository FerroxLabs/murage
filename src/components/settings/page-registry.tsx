// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where each Settings page is mounted (SETTINGS-SHELL-CONTRACT-1019.md). A page builder adds ONE line to
// SETTINGS_PAGE_LOADERS (alphabetical by page id, so builders never touch the same line), writes the page as the
// default export of src/components/settings/pages/<Page>Page.tsx taking SettingsPageProps, and deletes that page's
// legacy block from SettingsModal.tsx (the `section === "<id>"` block) in the same commit. A page with no loader
// still renders its legacy block, so the shell ships whole and pages arrive one at a time.
import { Suspense, type ComponentType } from "react";
import type { SettingsPageProps } from "@/lib/settings-page-contract";
import type { SettingsPage } from "@/lib/settings-pages";
import { LazyBoundary, retryableLazy } from "../LazyBoundary";

type PageLoader = () => Promise<{ default: ComponentType<SettingsPageProps> }>;

/** page id -> its lazy page file. Keep one entry per line, alphabetical. */
export const SETTINGS_PAGE_LOADERS: Partial<Record<SettingsPage, PageLoader>> = {
  botDefaults: () => import("./pages/BotDefaultsPage"),
  calls: () => import("./pages/CallsPage"),
  general: () => import("./pages/GeneralPage"),
  memory: () => import("./pages/MemoryPage"),
  models: () => import("./pages/ModelsPage"),
  skills: () => import("./pages/SkillsPage"),
  webSearch: () => import("./pages/SearchImagesDictationPage"),
  about: () => import("./pages/AboutPage"),
  backups: () => import("./pages/BackupsPage"),
  companion: () => import("./pages/CompanionPage"),
  computer: () => import("./pages/ComputerPage"),
  connections: () => import("./pages/ConnectionsPage"),
  usage: () => import("./pages/UsagePage"),
};

const mounted = new Map<SettingsPage, ReturnType<typeof retryableLazy<ComponentType<SettingsPageProps>>>>();

function mountFor(page: SettingsPage) {
  const load = SETTINGS_PAGE_LOADERS[page];
  if (!load) return null;
  let each = mounted.get(page);
  if (!each) { each = retryableLazy(load); mounted.set(page, each); }
  return each;
}

/** True when the page has a file of its own; false means the modal still renders its legacy block. */
export const hasPageFile = (page: SettingsPage): boolean => Boolean(SETTINGS_PAGE_LOADERS[page]);

/** The page's mount point: its own lazy chunk, its own retry, one loading line. */
export function SettingsPageMount(props: SettingsPageProps) {
  const each = mountFor(props.page);
  if (!each) return null;
  return (
    <LazyBoundary inline onRetry={each.retry}>
      <Suspense fallback={<p role="status" className="text-[13px] text-ink-secondary">…</p>}>
        <each.Component {...props} />
      </Suspense>
    </LazyBoundary>
  );
}
