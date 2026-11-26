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

/** Settings v10 (SHELL-SEAT): the 17 app pages of the new rail, in rail order. Each has one loader line and one file, so no
 *  page lane edits this registry. `messaging` and `rules` are the v10 names of the Channels and Bot defaults pages. The
 *  rail, the old ids and their aliases move onto these in F2; until then the table above still drives the shell. */
export const SETTINGS_V10_PAGE_IDS = [
  "overview", "providers", "engines", "models", "usage", "tools", "connections", "computer", "messaging",
  "companion", "bots", "rules", "skills", "memory", "general", "backups", "about",
] as const;
export type SettingsV10Page = (typeof SETTINGS_V10_PAGE_IDS)[number];

/** v10 page id -> its lazy page file. One entry per line, in rail order. */
export const SETTINGS_V10_PAGE_LOADERS: Record<SettingsV10Page, PageLoader> = {
  overview: () => import("./pages/OverviewPage"),
  providers: () => import("./pages/ProvidersPage"),
  engines: () => import("./pages/EnginesPage"),
  models: () => import("./pages/ModelsPage"),
  usage: () => import("./pages/UsagePage"),
  tools: () => import("./pages/ToolsPage"),
  connections: () => import("./pages/ConnectionsPage"),
  computer: () => import("./pages/ComputerPage"),
  messaging: () => import("./pages/ChannelsPage"),
  companion: () => import("./pages/CompanionPage"),
  bots: () => import("./pages/BotsPage"),
  rules: () => import("./pages/BotDefaultsPage"),
  skills: () => import("./pages/SkillsPage"),
  memory: () => import("./pages/MemoryPage"),
  general: () => import("./pages/GeneralPage"),
  backups: () => import("./pages/BackupsPage"),
  about: () => import("./pages/AboutPage"),
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
