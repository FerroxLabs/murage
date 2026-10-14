// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The light rows under a team for bots from other teams shared with it
// (SPEC-X 13.2): "Iris · shared from Design", with "working" or "2
// waiting". A row opens the owner's work thread for that team, creating it
// on first use (POST /api/bots/:id/work-threads). The rows come from the
// harness's `sharedRows`, which only the owner's surfaces carry, so the
// desktop and the paired phone show them and nothing else does.
import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { sharedRowLabel, sharedRowStatus, sharedRowsForSection, workThreadRequest, type SharedRow } from "@/lib/shared-teams";
import { startConversationPrefetch } from "@/lib/conversation-cache-host";
import { MESSAGE_PAGE_SIZE } from "@/lib/scrollback";

export function SharedRowButton({ bot, row, selected, onOpen, onPrefetch, onPrefetchCancel }: {
  bot: Pick<Bot, "id" | "name" | "section">;
  row: SharedRow;
  selected: boolean;
  onOpen: () => void;
  /** The pointer or focus is resting on the row: fetch its first page. */
  onPrefetch?: () => void;
  /** It moved on: cancel that fetch. */
  onPrefetchCancel?: () => void;
}) {
  const status = sharedRowStatus(row);
  return (
    <button
      type="button"
      data-shared-row={`${bot.id}:${row.teamId ?? row.teamName}`}
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onPointerLeave={onPrefetchCancel}
      onFocus={onPrefetch}
      onBlur={onPrefetchCancel}
      aria-current={selected || undefined}
      className={cn(
        "flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13px] text-ink-secondary transition-colors hover:bg-raised/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
        selected && "bg-raised text-ink",
      )}
    >
      <Users size={13} className="shrink-0 opacity-70" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{sharedRowLabel(bot.name, bot.section?.trim() ?? "")}</span>
      {status && <span className={cn("shrink-0 text-[11.5px]", row.working ? "text-success" : "text-ink-secondary")}>{status}</span>}
    </button>
  );
}

export function SidebarSharedRows({ section, onNavigate }: { section: string; onNavigate?: () => void }) {
  const { state, dispatch } = useStore();
  const [error, setError] = useState<string | null>(null);
  // A row's work thread, once it exists, is prefetched while the pointer or
  // focus rests on it; one at a time, cancelled when it moves on.
  const prefetching = useRef<(() => void) | null>(null);
  const stopPrefetch = () => {
    prefetching.current?.();
    prefetching.current = null;
  };
  useEffect(() => stopPrefetch, []);
  const rows = sharedRowsForSection(state.bots, section);
  if (!rows.length) return null;
  const open = async (bot: Bot, row: SharedRow) => {
    setError(null);
    try {
      const threadId = row.threadId ?? (await api(`/api/bots/${bot.id}/work-threads`, { method: "POST", body: JSON.stringify(workThreadRequest(row)) })).threadId;
      dispatch({ type: "select", id: bot.id });
      if (threadId && threadId !== bot.threadId) dispatch({ type: "switchTask", botId: bot.id, threadId });
      onNavigate?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <div className="flex flex-col gap-0.5" data-sidebar-shared-rows={section}>
      {rows.map(({ bot, row }) => (
        <SharedRowButton key={`${bot.id}:${row.teamId ?? row.teamName}`} bot={bot} row={row}
          selected={state.activeView === "chat" && state.selectedId === bot.id && row.threadId !== null && bot.threadId === row.threadId}
          onOpen={() => void open(bot, row)}
          onPrefetch={() => {
            stopPrefetch();
            if (row.threadId && row.threadId !== bot.threadId) {
              prefetching.current = startConversationPrefetch(api, { ownerId: bot.id, threadId: row.threadId, pageSize: MESSAGE_PAGE_SIZE });
            }
          }}
          onPrefetchCancel={stopPrefetch} />
      ))}
      {error && <p role="status" className="px-3 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
