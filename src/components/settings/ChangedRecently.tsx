// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Overview "Changed recently" section (slot "overview.changed", seated by the shell in overview-sections.tsx; Settings v10
// J1). Draws the rows of lib/changed-recently.ts: who, what it was and is, and Set back only where the view says it exists.
// Stores nothing. The rows come from the one hook below; until core's journal read route (J0) feeds it, it is empty and
// the section renders nothing, as the shell slot requires.
import type { ChangedRecentlyView } from "@/lib/changed-recently";

export interface ChangedRecentlyWords { title: string; setBack: string; was: string; now: string }
export const CHANGED_RECENTLY_WORDS: ChangedRecentlyWords = { title: "Changed recently", setBack: "Set back", was: "Was", now: "Now" };

/** The journal rows as views. Empty until core J0 publishes a read route; the one place to connect it. */
export function useChangedRecently(): ChangedRecentlyView[] {
  return [];
}

export function ChangedRecentlyList({ rows, onSetBack, words = CHANGED_RECENTLY_WORDS, label = (id) => id }: {
  rows: readonly ChangedRecentlyView[];
  onSetBack?: (row: ChangedRecentlyView) => void;
  words?: ChangedRecentlyWords;
  /** A setting id in words. */
  label?: (settingId: string) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="overview-changed-title" data-testid="overview-changed">
      <h2 id="overview-changed-title">{words.title}</h2>
      <ul>
        {rows.map((row) => (
          <li key={row.changeId} data-change-id={row.changeId}>
            <span>{label(row.settingId)}</span>{" "}
            <span>{row.who}</span>
            {row.was !== null ? <span>{" "}{words.was} {row.was}</span> : null}
            {row.now !== null ? <span>{" "}{words.now} {row.now}</span> : null}
            {row.note ? <span>{" "}{row.note}</span> : null}
            {row.setBack.available && onSetBack ? (
              <>
                {row.setBack.says ? <span>{" "}{row.setBack.says}</span> : null}
                <button type="button" onClick={() => onSetBack(row)}>{words.setBack}</button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ChangedRecently() {
  return <ChangedRecentlyList rows={useChangedRecently()} />;
}
