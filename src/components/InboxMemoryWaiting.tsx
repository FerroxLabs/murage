// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a bot would like to remember, as one card per bot in the Inbox
// (PROPOSAL-v2 section 3, item 0.4). "Sable would like to remember 11 things",
// with Keep all N for the everyday ones and Review for the rest. The count is
// per item. Counts and names only come in with the Inbox answer; the words of a
// memory are read when Keep all is pressed, and the press sends the exact list.
import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import {
  applyInboxWaiting, applyWaitingSummary, batchSentence, cardTitle, errorSentence, keepAllLabel, keepAllTargets, keepTogetherLine, memoryAction, newActionId, requestExpand,
  type ItemResult, type ReviewSubject, type SubjectKind,
} from "@/lib/memory-review";
import type { InboxMemoryWaiting as Row } from "../../shared/inbox";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const BUTTON = `min-h-11 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover ${FOCUS}`;
const PRIMARY = `min-h-11 rounded-lg border border-accent bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 ${FOCUS}`;

export function InboxMemoryWaiting({ rows, onSettled, onOpenMemory }: { rows: readonly Row[]; onSettled: () => void; onOpenMemory?: (subject: ReviewSubject) => void }) {
  // The card's own line after Keep all, with its Undo. Only the pressed card changes; the others stay as they are.
  const [said, setSaid] = useState<Record<string, { message: string; undo?: () => void }>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { applyInboxWaiting(rows); }, [rows]);

  const keepAll = async (row: Row) => {
    const key = `${row.kind}:${row.id}`;
    if (pending.has(key)) return;
    setPending(current => new Set(current).add(key));
    try {
      const list = await memoryAction(api, { action: "waiting-list", subjectType: row.kind, subjectId: row.id, tab: "waiting" });
      const targets = keepAllTargets(list.items);
      if (!targets.length) { if (mounted.current) setSaid(current => ({ ...current, [key]: { message: "Each of these needs you one by one." } })); return; }
      const actionId = newActionId();
      const done = await memoryAction(api, { action: "review-keep-all", actionId, items: targets });
      applyWaitingSummary(done.summary);
      const results = done.results as ItemResult[];
      const kept = results.filter(item => item.status === "kept");
      if (!mounted.current) return;
      setSaid(current => ({ ...current, [key]: { message: batchSentence(results), ...(kept.length ? { undo: () => void undo(key, actionId, kept) } : {}) } }));
      onSettled();
    } catch (cause) {
      if (mounted.current) setSaid(current => ({ ...current, [key]: { message: errorSentence(cause) } }));
    } finally { if (mounted.current) setPending(current => { const next = new Set(current); next.delete(key); return next; }); }
  };
  const undo = async (key: string, keepActionId: string, kept: ReadonlyArray<ItemResult>) => {
    try {
      let last: any;
      for (const item of kept) last = await memoryAction(api, { action: "review-undo", actionId: newActionId(), keepActionId, id: item.id, version: item.version });
      if (last?.summary) applyWaitingSummary(last.summary);
      if (mounted.current) setSaid(current => ({ ...current, [key]: { message: "Back in Needs you." } }));
      onSettled();
    } catch (cause) { if (mounted.current) setSaid(current => ({ ...current, [key]: { message: errorSentence(cause) } })); }
  };

  return <ul className="space-y-2" aria-label="Memories waiting for you">
    {rows.map(row => {
      const key = `${row.kind}:${row.id}`, line = said[key];
      return <li key={key} className="rounded-xl border border-hairline/50 bg-raised/30 p-4 text-[13px]" data-memory-card={key}>
        <p className="font-medium text-ink">{cardTitle(row.name, row.waiting)}</p>
        <p className="mt-1 min-h-[18px] text-ink-secondary">{keepTogetherLine(row.everyday, row.waiting)}</p>
        <div className="mt-3 flex flex-wrap gap-2 max-sm:[&>button]:flex-1">
          {row.everyday > 0 && <button type="button" className={PRIMARY} aria-busy={pending.has(key) || undefined} onClick={() => void keepAll(row)}>{keepAllLabel(row.everyday)}</button>}
          {onOpenMemory && <button type="button" className={BUTTON} onClick={() => { requestExpand({ kind: row.kind as SubjectKind, id: row.id, name: row.name }); onOpenMemory({ kind: row.kind as SubjectKind, id: row.id, name: row.name }); }}>Review</button>}
        </div>
        <div role="status" aria-live="polite" className="mt-2 flex min-h-[20px] flex-wrap items-center gap-2 text-ink-secondary">
          {line && <><span>{line.message}</span>{line.undo && <button type="button" className={BUTTON} onClick={line.undo}>Undo</button>}</>}
        </div>
      </li>;
    })}
  </ul>;
}
