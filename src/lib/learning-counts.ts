// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The numbers the owner can read in Settings (design section 12a): "This month:
// learned N, remembers M" for the Learning screen, one short sentence for the
// Overview, and a small count on the settings list for what is new since the
// owner last looked. A count, never a nag: opening the section clears it, and
// a bot that has learned nothing says nothing.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { REMEMBERED_EVENT } from "../../shared/learned-chip";

type Request = (path: string, init?: RequestInit) => Promise<any>;

export interface LearningCounts { month: string; lessons: number; memories: number; wins: number; undone: number }
export interface LearningCountsAnswer { counts: LearningCounts; unseen: number }

export const countsPath = (botId: string, since?: number) =>
  `/api/bots/${encodeURIComponent(botId)}/learning/counts${since === undefined ? "" : `?since=${Math.trunc(since)}`}`;

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export async function fetchLearningCounts(request: Request, botId: string, since?: number): Promise<LearningCountsAnswer> {
  const answer = await request(countsPath(botId, since));
  const raw = answer?.counts ?? {};
  return {
    counts: { month: typeof raw.month === "string" ? raw.month : "", lessons: count(raw.lessons), memories: count(raw.memories), wins: count(raw.wins), undone: count(raw.undone) },
    unseen: count(answer?.unseen),
  };
}

/** "This month: learned 3, remembers 5". */
export const monthLine = (counts: Pick<LearningCounts, "lessons" | "memories">): string =>
  t("learningCounts.month" as LocaleKey, { learned: counts.lessons, remembered: counts.memories });

/** The Overview's short form, or null when there is nothing to say yet. */
export function overviewSentence(counts: Pick<LearningCounts, "lessons" | "memories">): string | null {
  const total = counts.lessons + counts.memories;
  if (total <= 0) return null;
  return total === 1 ? t("learningCounts.overview.one" as LocaleKey) : t("learningCounts.overview.many" as LocaleKey, { count: total });
}

/** The badge text, or null for zero. */
export const badgeText = (unseen: number): string | null => (unseen > 0 ? (unseen > 99 ? "99+" : String(unseen)) : null);
export const badgeLabel = (unseen: number): string | null => (unseen > 0 ? t("learningBadge.label" as LocaleKey, { count: unseen }) : null);

// ── when the owner last looked ───────────────────────────────────────────
const seenKey = (botId: string) => `murage.learning.seen.${botId}`;
/** The first time a bot is asked about, now is the baseline: the badge counts what comes after, never the past. */
export function readSeen(botId: string, now = Date.now()): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(seenKey(botId)));
    if (Number.isSafeInteger(stored) && stored > 0) return stored;
    globalThis.localStorage?.setItem(seenKey(botId), String(now));
  } catch { /* storage can be blocked; then the badge starts from now each time */ }
  return now;
}
export function writeSeen(botId: string, now = Date.now()): void {
  try { globalThis.localStorage?.setItem(seenKey(botId), String(now)); } catch { /* a convenience only */ }
}

/** What is new in this bot's learning since the owner last opened it. `looking`: the section is open now. */
export function useLearningBadge(botId: string, looking: boolean): number {
  const [unseen, setUnseen] = useState(0);
  const read = useCallback(() => {
    fetchLearningCounts(api, botId, readSeen(botId)).then(answer => setUnseen(answer.unseen), () => { /* no number is the honest fallback */ });
  }, [botId]);
  useEffect(() => { setUnseen(0); if (looking) { writeSeen(botId); return; } read(); }, [botId, looking, read]);
  useEffect(() => {
    const onRemembered = (event: Event) => {
      if ((event as CustomEvent).detail?.botId !== botId) return;
      if (looking) writeSeen(botId); else read();
    };
    window.addEventListener(REMEMBERED_EVENT, onRemembered);
    return () => window.removeEventListener(REMEMBERED_EVENT, onRemembered);
  }, [botId, looking, read]);
  return looking ? 0 : unseen;
}
