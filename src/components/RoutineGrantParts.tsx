// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 Rule 82 on the pending card (composer panel and the phone, which
// is the same page): every operation in call order with its app, account,
// recipients and current arguments; the routine's choice in plain words with
// any recipient as its own named part; and "Saved for [Routine name]" once the
// server has saved it. Calls show no card body: they read the request aloud.
import type { ApprovalActionRow, RoutineGrantOffer } from "../../shared/approval-grant-request";
import { cn } from "@/lib/cn";
import {
  alsoRememberWords,
  argumentsText,
  freshRecipientWords,
  grantRowWords,
  notRememberedWords,
  routineChoiceWords,
  separateStopChoices,
} from "@/lib/routine-grant-words";

/** Every operation of the request in call order (Rule 82). The list scrolls;
 * a title above it never stands in for a row. */
export function GrantRequestRows({
  rows,
  remembered,
  routineName,
}: {
  rows: readonly ApprovalActionRow[];
  /** what the routine (or bot) already remembers, to say why a new recipient still asks */
  remembered?: readonly string[];
  routineName?: string;
}) {
  if (!rows.length) return null;
  return (
    <div className="mt-2">
      {routineName && <p className="text-[12px] text-ink-secondary">Routine: <span className="text-ink">{routineName}</span></p>}
      <p className="text-[12px] text-ink-secondary">{rows.length === 1 ? "1 action" : `${rows.length} actions, in the order they run`}</p>
      <ol aria-label="Actions in this request" className="mt-1 flex max-h-56 flex-col gap-1.5 overflow-y-auto overscroll-contain">
        {rows.map((row) => {
          const fresh = freshRecipientWords(row, remembered, routineName ?? "This bot");
          // the same words a call reads aloud (spokenGrantRows)
          const words = grantRowWords(row);
          return (
            <li key={row.index} data-action-row={row.index} className="rounded-lg bg-panel px-3 py-2 text-[12.5px]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="tabular-nums text-ink-secondary">{row.index + 1}.</span>
                <span className="font-medium text-ink">{words.title}</span>
                <span className="text-[11.5px] text-ink-secondary">{words.place}</span>
              </div>
              {words.to && (
                <div className="mt-0.5 break-words text-[12px] text-ink">{words.to}</div>
              )}
              {row.findings.map((finding, index) => (
                <div key={index} className="mt-0.5 break-words text-[12px] text-warning">{finding.what}</div>
              ))}
              {fresh && <div className="mt-0.5 break-words text-[12px] text-warning">{fresh}</div>}
              <details className="mt-1">
                <summary className="cursor-pointer text-[11.5px] text-ink-secondary">Show the details it sends</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink">{argumentsText(row.arguments)}</pre>
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** What "Always allow for this routine" would remember, or why it is not
 * offered (Rules 81c, 82a, 82b, 82c). Each recipient the owner may also
 * remember is its own checkbox, unticked: remembering the actions never
 * remembers a recipient. */
export function RoutineGrantChoice({
  offer,
  rows,
  chosen,
  onToggle,
}: {
  offer: RoutineGrantOffer;
  rows: readonly ApprovalActionRow[];
  chosen: readonly string[];
  onToggle: (key: string, on: boolean) => void;
}) {
  const words = routineChoiceWords(offer, rows);
  const notRemembered = notRememberedWords(offer.notRemembered);
  if (!words) {
    return (
      <p data-routine-choice="closed" className="w-full text-[12.5px] text-ink-secondary">
        {offer.reason ?? "This request can only be allowed once."}
      </p>
    );
  }
  return (
    <div data-routine-choice="open" className="w-full rounded-lg border border-hairline/50 px-3 py-2 text-[12.5px] text-ink">
      <p className="text-[11px] uppercase tracking-[0.12em] text-ink-secondary">Always allow for this routine</p>
      {words.lines.map((line) => <p key={line} className="mt-1">{line}</p>)}
      {separateStopChoices(offer).map((stop) => (
        <label key={stop.key} className="mt-1.5 flex items-start gap-2">
          <input
            type="checkbox"
            checked={chosen.includes(stop.key)}
            onChange={(event) => onToggle(stop.key, event.target.checked)}
            className="mt-0.5"
          />
          <span>{alsoRememberWords(stop)}</span>
        </label>
      ))}
      {notRemembered && <p className={cn("mt-1.5 text-warning")}>{notRemembered}</p>}
    </div>
  );
}

/** "Saved for [Routine name]" and what was saved, after the server saved it
 * (Rule 82d). */
export function RoutineSavedNotice({ title, items, onDismiss }: { title: string; items: readonly string[]; onDismiss: () => void }) {
  return (
    <div role="status" className="mb-2 flex items-start justify-between gap-3 rounded-2xl border border-hairline/50 bg-card px-4 py-2 text-[12.5px] text-ink">
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <ul className="mt-0.5 list-disc pl-4 text-ink-secondary">
          {items.map((item) => <li key={item} className="break-words">{item}</li>)}
        </ul>
      </div>
      <button type="button" onClick={onDismiss} className="shrink-0 rounded-lg px-2 py-1 text-[11.5px] text-ink-secondary hover:bg-control hover:text-ink">
        Close
      </button>
    </div>
  );
}
