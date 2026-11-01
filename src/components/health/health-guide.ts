// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every Health issue answers three plain questions (Sean 11-01): what happened, does it matter, what can I do. The
// answer to the last one is a button that goes to the right place, a button that does the fix, or a plain "nothing to
// do", never a dead end (House rule 4). Keyed by the same titles as shared/health-levels.ts; a test checks the two
// tables and shared/sentinel-view.ts HEALTH_TITLES list the same issues, and that every detector's title is here.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { NextAction } from "../../../shared/sentinel-view";

export type HealthGuideAction =
  /** A button that opens the place to act. */
  | { kind: "go"; to: Exclude<NextAction, "none"> }
  /** A button that asks Murage to try the deleted conversations again (only while a retry can change something). */
  | { kind: "retry-deletions" }
  /** No button: the sentence says there is nothing to do. */
  | { kind: "none" };

export interface HealthGuide {
  title: LocaleKey;
  happened: LocaleKey;
  matters: LocaleKey;
  canDo: LocaleKey;
  action: HealthGuideAction;
}

const guide = (slug: string, action: HealthGuideAction, shared?: { matters?: string; canDo?: string }): HealthGuide => ({
  title: `ux.l2b.health.issue.${slug}.title` as LocaleKey,
  happened: `ux.l2b.health.issue.${slug}.happened` as LocaleKey,
  matters: `ux.l2b.health.issue.${shared?.matters ?? slug}.matters` as LocaleKey,
  canDo: `ux.l2b.health.issue.${shared?.canDo ?? slug}.canDo` as LocaleKey,
  action,
});

const none = { kind: "none" } as const;
/** Figures that have not come in yet: every source has the same answer. */
const reading = (slug: string) => guide(slug, none, { matters: "coverage", canDo: "coverage" });

export const HEALTH_GUIDES: Readonly<Record<string, HealthGuide>> = Object.freeze({
  "health.backup.not-protected": guide("backupNotProtected", { kind: "go", to: "backups" }),
  "health.backup.overdue": guide("backupOverdue", { kind: "go", to: "backups" }),
  "health.backup.capture-stalled": guide("backupStalled", { kind: "go", to: "backups" }),
  "health.io-pressure.sustained-writes": guide("ioPressure", { kind: "go", to: "manage-storage" }),
  "health.extraction.unusable-replies": guide("extraction", { kind: "go", to: "memory-settings" }),
  "health.dispatch.exhausted-turns": guide("dispatch", { kind: "go", to: "engines" }),
  "health.engine-holds.home-held": guide("engineHolds", none),
  "health.deletion.still-pending": guide("deletion", { kind: "retry-deletions" }),
  "health.send-fence.rebuilding": guide("sendFence", none),
  "health.resets.loop": guide("resets", none),
  "health.isolation-noise.fallback": guide("isolationNoise", none),
  "health.coverage.producer-silent-server": reading("silentServer"),
  "health.coverage.producer-silent-desktop": reading("silentDesktop"),
  "health.coverage.stats-stale": reading("statsStale"),
  "health.coverage.scan-failing": reading("scanFailing"),
  "health.coverage.source-unavailable-server": reading("sourceServer"),
  "health.coverage.source-unavailable-desktop": reading("sourceDesktop"),
  "health.coverage.source-unavailable-backup": reading("sourceBackup"),
  "health.coverage.source-unavailable-db-stats": reading("sourceDbStats"),
});

/** A title a newer checker sent and this build does not know. */
export const HEALTH_GUIDE_FALLBACK: HealthGuide = guide("unknown", none);

export function healthGuide(titleKey: string | null | undefined): HealthGuide {
  return (titleKey && Object.hasOwn(HEALTH_GUIDES, titleKey) ? HEALTH_GUIDES[titleKey] : undefined) ?? HEALTH_GUIDE_FALLBACK;
}

const GO_LABELS: Readonly<Record<Exclude<NextAction, "none">, LocaleKey>> = {
  backups: "ux.l2b.health.go.backups",
  "manage-storage": "ux.l2b.health.go.storage",
  "memory-settings": "ux.l2b.health.go.memory",
  engines: "ux.l2a.health.openEngines",
};

export const goLabel = (to: Exclude<NextAction, "none">): string => t(GO_LABELS[to]);

/** Every page a Health button opens is desktop only (lib/settings-sections.ts), and a phone sent there lands on General,
 * so a phone shows the words and no button. */
export const settingsPagesHere = (desktop: boolean | undefined): boolean => desktop !== false;

/** Where a "go" button opens: existing Settings pages only. */
export function healthDestination(to: NextAction): { section: "backups" | "storage" | "memory" | "engines" } | null {
  switch (to) {
    case "backups": return { section: "backups" };
    case "manage-storage": return { section: "storage" };
    case "memory-settings": return { section: "memory" };
    case "engines": return { section: "engines" };
    default: return null;
  }
}

/** "5 of these, last seen 2 days ago": one line for every fold, the count only when there is more than one. */
export function foldTimeLine(issues: number, age: string): string {
  return issues > 1 ? t("ux.l2b.health.foldMany", { n: issues, age }) : t("ux.l2b.health.foldOne", { age });
}
