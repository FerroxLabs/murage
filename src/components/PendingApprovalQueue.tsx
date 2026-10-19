// Every pending card in the conversation's visible branch, in the composer
// panel and on the phone (AMEND-13 Rule 83). A count beside the first card is
// not a list: the owner sees "N requests waiting", picks any request by its own
// id, and answers it with that card's own controls.
import { useEffect, useReducer, useRef, useState } from "react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { nextSelection, queueStatusWords, requestsWaiting, selectRequest, type QueueSelection, type QueueStatus } from "@/lib/approval-queue";
import { PendingApprovalActions, PendingApprovalPanel, approvalLabel, type Pending } from "./PendingApproval";

export interface QueueEntry {
  requestId: string;
  /** the bot or channel member that asked */
  who: string;
  /** the routine whose run raised it, where there is one */
  routine?: string;
  /** what it asks, in the card's own words */
  action: string;
  status: QueueStatus;
}

export function approvalQueueEntries(
  list: readonly Pending[],
  opts: { whoFor: (pending: Pending) => string; routineFor?: (pending: Pending) => string | undefined; statusFor?: (requestId: string) => QueueStatus },
): QueueEntry[] {
  return list.map((pending) => {
    const routine = opts.routineFor?.(pending);
    return {
      requestId: pending.requestId,
      who: opts.whoFor(pending),
      ...(routine ? { routine } : {}),
      action: approvalLabel(pending),
      status: opts.statusFor?.(pending.requestId) ?? "waiting",
    };
  });
}

/** The ordered, selectable list (Rule 83a). Choosing a row selects that
 * request; it never answers one. */
export function ApprovalQueueList({
  entries,
  selectedId,
  onSelect,
  notice,
}: {
  entries: readonly QueueEntry[];
  selectedId?: string;
  onSelect: (requestId: string) => void;
  /** said once when the selected request settled somewhere else */
  notice?: string;
}) {
  return (
    <div className="shrink-0 border-b border-hairline/50 px-4 pb-2 pt-3">
      <p className="text-[12px] font-medium text-ink" aria-live="polite">
        {notice ? `${notice} ` : ""}
        {requestsWaiting(entries.length)}
      </p>
      <div role="listbox" aria-label="Requests waiting" className="mt-1.5 flex max-h-36 flex-col gap-1 overflow-y-auto overscroll-contain">
        {entries.map((entry, index) => (
          <button
            key={entry.requestId}
            type="button"
            role="option"
            aria-selected={entry.requestId === selectedId}
            data-request-id={entry.requestId}
            onClick={() => onSelect(entry.requestId)}
            className={cn(
              "flex w-full flex-wrap items-baseline gap-x-2 rounded-lg px-2 py-1 text-left text-[12.5px]",
              entry.requestId === selectedId ? "bg-accent/10 text-ink" : "text-ink-secondary hover:bg-control",
            )}
          >
            <span className="tabular-nums">{index + 1}.</span>
            <span className="font-medium text-ink">{entry.who}</span>
            {entry.routine && <span>Routine: {entry.routine}</span>}
            <span className="min-w-0 flex-1 truncate">{entry.action}</span>
            <span className={cn("text-[11.5px]", entry.status === "failed" ? "text-danger" : "text-ink-secondary")}>{queueStatusWords(entry.status)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The queue that takes over the composer while requests wait. Each card keeps
 * its own controls mounted (hidden unless selected) so an answer in flight
 * holds only its own card, survives the owner looking at another one, and a
 * failed answer stays with its retry (Rule 83b). A card leaves only when the
 * server's patch settles it. Mount this keyed by thread: a thread change starts
 * a fresh list and nothing selected or pressed carries into it.
 */
export function PendingApprovalQueue({
  approvals,
  threadId,
  botFor,
  whoFor,
  routineFor,
  onCancelTurn,
}: {
  approvals: readonly Pending[];
  threadId: string;
  /** who asked, from the card's own sender, never the busy member */
  botFor: (pending: Pending) => Bot | undefined;
  whoFor: (pending: Pending) => string;
  routineFor?: (pending: Pending) => string | undefined;
  onCancelTurn: () => void;
}) {
  const selection = useRef<QueueSelection>({ order: [] });
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const previous = selection.current;
  selection.current = nextSelection(previous, approvals);
  const selectedId = selection.current.id;
  const [statuses, setStatuses] = useState<Record<string, QueueStatus>>({});
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // The selected request left without this panel's answer: it settled on
  // another device or surface. Say so, beside the new count.
  const shownId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const before = shownId.current;
    shownId.current = selectedId;
    if (!before || before === selectedId) return;
    if (approvals.some((pending) => pending.requestId === before)) {
      setNotice(undefined);
      return;
    }
    setNotice(statuses[before] === "sending" ? undefined : "Answered elsewhere.");
  }, [approvals, selectedId, statuses]);

  // statuses of cards that are gone are dropped
  useEffect(() => {
    setStatuses((prev) => {
      const live = Object.fromEntries(Object.entries(prev).filter(([id]) => approvals.some((pending) => pending.requestId === id)));
      return Object.keys(live).length === Object.keys(prev).length ? prev : live;
    });
  }, [approvals]);

  const selected = approvals.find((pending) => pending.requestId === selectedId);
  if (!selected) return null;
  const entries = approvalQueueEntries(approvals, { whoFor, routineFor, statusFor: (id) => statuses[id] ?? "waiting" });
  return (
    <div className="mb-2 flex max-h-[70dvh] flex-col overflow-hidden rounded-2xl border border-accent/40 bg-card">
      {approvals.length > 1 ? (
        <ApprovalQueueList
          entries={entries}
          selectedId={selectedId}
          notice={notice}
          onSelect={(id) => {
            selection.current = selectRequest(selection.current, approvals, id);
            setNotice(undefined);
            rerender();
          }}
        />
      ) : (
        <span className="sr-only" aria-live="polite">{notice ? `${notice} ` : ""}{requestsWaiting(approvals.length)}</span>
      )}
      <PendingApprovalPanel pending={selected} count={approvals.length} index={approvals.indexOf(selected)} />
      {approvals.map((pending) => (
        <div key={pending.requestId} hidden={pending.requestId !== selectedId} data-request-actions={pending.requestId}>
          <PendingApprovalActions
            pending={pending}
            threadId={threadId}
            bot={botFor(pending)}
            onCancelTurn={onCancelTurn}
            onStatus={(status) =>
              setStatuses((prev) => (prev[pending.requestId] === status ? prev : { ...prev, [pending.requestId]: status }))
            }
          />
        </div>
      ))}
    </div>
  );
}
