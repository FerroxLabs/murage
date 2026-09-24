// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One "Topic" dropdown beside the skills search box: All topics, then the
// library's biggest topics with their counts. Shared by Settings → Skills and
// the bot window's picker.
import { ChevronDown } from "lucide-react";

/** "software-engineering" → "Software engineering". */
export function topicLabel(term: string): string {
  const words = term.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : term;
}

export function TopicSelect({ topics, value, onChange }: { topics: Array<{ name: string; count: number }>; value: string; onChange(topic: string): void }) {
  return (
    <label className="relative flex shrink-0 items-center rounded-lg border border-hairline/50 bg-inset">
      <span className="sr-only">Topic</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Topic"
        className="min-h-10 max-w-[13rem] appearance-none bg-transparent pl-3 pr-8 text-[13px] text-ink focus:outline-none"
      >
        <option value="">All topics</option>
        {topics.map((topic) => (
          <option key={topic.name} value={topic.name}>{`${topicLabel(topic.name)} (${topic.count})`}</option>
        ))}
        {value && !topics.some((topic) => topic.name === value) && <option value={value}>{topicLabel(value)}</option>}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 text-ink-secondary" aria-hidden="true" />
    </label>
  );
}
