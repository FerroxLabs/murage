// Where each Settings page is mounted (SETTINGS-SHELL-CONTRACT-1019.md). Settings v10: the rail is these 17 ids, each an
// existing page file with content. A page builder adds ONE line to SETTINGS_V10_PAGE_LOADERS (one entry per line, rail
// order), writes the page as the default export of src/components/settings/pages/<Page>Page.tsx taking SettingsPageProps,
// and never edits SettingsModal.tsx. Providers and Engines are not pages: they are the first two cards of Models &
// engines, reached through SECTION_ALIASES (lib/settings-pages.ts).
import { Suspense, type ComponentType } from "react";
import type { SettingsPageProps } from "@/lib/settings-page-contract";
import type { SettingsPage } from "@/lib/settings-pages";
import { LazyBoundary, retryableLazy } from "../LazyBoundary";

type PageLoader = () => Promise<{ default: ComponentType<SettingsPageProps> }>;

export const SETTINGS_V10_PAGE_IDS = [
  "overview", "models", "webSearch", "usage", "tools", "connections", "computer", "messaging", "calls",
  "companion", "bots", "rules", "skills", "memory", "general", "backups", "about",
] as const satisfies readonly SettingsPage[];
export type SettingsV10Page = (typeof SETTINGS_V10_PAGE_IDS)[number];

/** page id -> its lazy page file. One entry per line, in rail order. */
export const SETTINGS_V10_PAGE_LOADERS: Record<SettingsV10Page, PageLoader> = {
  overview: () => import("./pages/OverviewPage"),
  models: () => import("./pages/ModelsPage"),
  webSearch: () => import("./pages/SearchImagesDictationPage"),
  usage: () => import("./pages/UsagePage"),
  tools: () => import("./pages/ToolsPage"),
  connections: () => import("./pages/ConnectionsPage"),
  computer: () => import("./pages/ComputerPage"),
  messaging: () => import("./pages/ChannelsPage"),
  calls: () => import("./pages/CallsPage"),
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
  const load = SETTINGS_V10_PAGE_LOADERS[page];
  if (!load) return null;
  let each = mounted.get(page);
  if (!each) { each = retryableLazy(load); mounted.set(page, each); }
  return each;
}

/** True when the page has a file of its own; false means the modal still renders its legacy block. */
export const hasPageFile = (page: SettingsPage): boolean => Boolean(SETTINGS_V10_PAGE_LOADERS[page]);

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
