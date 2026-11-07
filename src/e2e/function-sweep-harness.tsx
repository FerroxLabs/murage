// FUNCTION-SWEEP-1018 harnesses. Needs you: the real Inbox in door mode beside the rail badge's own count
// (usePendingApprovals, the hook the badge reads), so a spec can hold the badge and the tabs side by side. Today: the
// real Needs block in Calm (capped, "and N more", "Show less"), wired the way TodayView wires it, with its count from the
// same badge hook. `window.emitInboxChanged` is the store's own `inbox.changed` hand-off. Test-only.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { Inbox } from "@/components/Inbox";
import { NeedsBlock } from "@/components/today/NeedsBlock";
import { todayQuickAnswer } from "@/components/today/today-quick";
import { needsPageSummary } from "@/components/needs/NeedsYouPage";
import { usePendingApprovals } from "@/components/usePendingApprovals";
import { emitInboxChanged, onInboxChanged } from "@/lib/inbox-changed";
import { NEEDS_LINE_CAP, needsLines, withoutAnswered, type NeedsLine } from "@/lib/today-needs";
import type { InboxPage } from "../../shared/inbox";

declare global { interface Window { emitInboxChanged?: () => void; opened?: unknown } }
window.emitInboxChanged = () => emitInboxChanged(1);

function Badge() {
  const { decisions } = usePendingApprovals(true, true);
  return <p data-sweep-badge>{decisions ?? "?"}</p>;
}

export function SweepNeedsHarness() {
  type View = NonNullable<Parameters<typeof Inbox>[0]["initialView"]>;
  // The page's tab, kept the way the store keeps `needsYouTab` (setNeedsYouTab, and showNeedsYou asking for decisions).
  const [tab, setTab] = useState<View>((new URLSearchParams(location.search).get("view") ?? "decisions") as View);
  return <>
    <Badge />
    <button type="button" data-sweep-door onClick={() => setTab("decisions")}>Rail door</button>
    <Inbox door initialView={tab} onViewChange={setTab} onOpen={(link) => { window.opened = link; }} />
  </>;
}

export function SweepTodayHarness() {
  const { decisions: count } = usePendingApprovals(true, true);
  const [page, setPage] = useState<InboxPage | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const [said, setSaid] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    const read = () => { void (api("/api/inbox?view=decisions&pageSize=25") as Promise<InboxPage>).then(setPage); };
    read();
    return onInboxChanged(read);
  }, [count]);
  if (!page) return null;
  const summary = needsPageSummary(page, Date.now(), () => { window.opened = "door"; });
  const kept = withoutAnswered(summary.rows, count, answered, summary.rowsCount);
  const lines = needsLines({ now: Date.now(), count: kept.count, rows: kept.rows, restore: [], reconnectApps: [], handoffs: [], routines: [], runs: [], bots: [], botNames: { sable: "Sable", orion: "Orion" }, cap: NEEDS_LINE_CAP });
  return <>
    <p data-sweep-badge>{count ?? "?"}</p>
    <NeedsBlock needs={lines} count={kept.count} mode="calm" expanded={expanded} onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)}
      onOpenLine={(line: NeedsLine) => { window.opened = line.id; }} onOpenDoor={() => { window.opened = "door"; }}
      quickAnswer={todayQuickAnswer} onAnswered={(line) => setAnswered((current) => new Set(current).add(line.id))}
      said={said} onSaid={(line, text) => setSaid((current) => ({ ...current, [line.id]: text }))} />
  </>;
}
