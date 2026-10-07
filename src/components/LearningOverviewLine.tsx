// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One muted line on the bot's Overview: "Learned 14 things this month".
// Hidden while loading, when the harness cannot say, and when the count is zero.
import { useEffect, useState } from "react";

import { api } from "@/state/store";
import { fetchLearningCounts, overviewSentence } from "@/lib/learning-counts";

/** The line, or null: the whole decision, apart from the fetch. */
export function overviewLineText(counts: { lessons: number; memories: number } | null): string | null {
  return counts ? overviewSentence(counts) : null;
}

export function OverviewLine({ text }: { text: string | null }) {
  return text ? <p data-testid="learning-overview-line" className="text-[12.5px] leading-snug text-ink-secondary">{text}</p> : null;
}

export function LearningOverviewLine({ botId }: { botId: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setText(null);
    fetchLearningCounts(api, botId).then(answer => { if (live) setText(overviewLineText(answer.counts)); }, () => { if (live) setText(null); });
    return () => { live = false; };
  }, [botId]);
  return <OverviewLine text={text} />;
}
