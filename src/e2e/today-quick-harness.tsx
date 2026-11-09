// NEEDSYOU-INLINE-APPROVE on Today: the real Needs you block over the real Inbox read, wired the way TodayView wires
// it (needsPageSummary -> withoutAnswered -> needsLines -> NeedsBlock with the lazy one-click slot). Test-only.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { NeedsBlock } from "@/components/today/NeedsBlock";
import { todayQuickAnswer } from "@/components/today/today-quick";
import { needsPageSummary } from "@/components/needs/NeedsYouPage";
import { needsLines, withoutAnswered, type NeedsLine } from "@/lib/today-needs";
import type { InboxPage } from "../../shared/inbox";

export function TodayQuickHarness() {
  const [page, setPage] = useState<InboxPage | null>(null);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [said, setSaid] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => { void (api("/api/inbox?view=decisions&pageSize=25") as Promise<InboxPage>).then(setPage); }, []);
  if (!page) return null;
  const summary = needsPageSummary(page, Date.now(), () => { (window as { opened?: string }).opened = "door"; });
  const owed = typeof page.decisions === "number" ? page.decisions : summary.rows.length;
  const kept = withoutAnswered(summary.rows, owed, answered, summary.rowsCount);
  const lines = needsLines({ now: Date.now(), count: kept.count, rows: kept.rows, restore: [], reconnectApps: [], handoffs: [], routines: [], runs: [], bots: [], botNames: { sable: "Sable" }, cap: Number.POSITIVE_INFINITY });
  return (
    <NeedsBlock needs={lines} count={kept.count} mode="all" expanded={false} onExpand={() => {}} onCollapse={() => {}}
      onOpenLine={(line: NeedsLine) => { (window as { opened?: string }).opened = line.id; }} onOpenDoor={() => {}}
      quickAnswer={todayQuickAnswer} onAnswered={(line) => setAnswered((current) => new Set(current).add(line.id))}
      said={said} onSaid={(line, text) => setSaid((current) => ({ ...current, [line.id]: text }))} />
  );
}
