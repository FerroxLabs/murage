import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { countText, workerSentence } from "@/lib/memory-words";
import type { SemanticIndexStatus } from "@/lib/memory-learning";
import { semanticPhrase } from "@/lib/memory-learning-text";
export interface MemoryHealthStatus {
  captured: { sources: number; lastAt: number | null };
  processed: { sources: number; lastAt: number | null };
  retrieved: { queries: number; hits: number; lastAt: number | null; available?: boolean };
  supplied: { turns: number; references: number; lastAt: number | null };
  synthesis: { state: "not-configured" | "disabled" | "configured" | "budget-limited"; reason: string | null };
}
const tx = (key: string, params?: Record<string, string | number>) => t(`memoryHealth.${key}` as LocaleKey, params);
const lastActivity = (at: number | null) => at === null ? tx("noActivity") : tx("lastActivity", { when: new Date(at).toLocaleString() });

/** A fold that opens and closes with a button (aria-expanded), not a <details>. The body stays in the page, hidden, so it is found by search and by assistive tools. */
export function Disclosure({ label, children, defaultOpen = false, className = "", onOpenChange }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(defaultOpen), region = useId();
  return <div className={`rounded-lg border border-hairline/40 p-3 ${className}`}>
    <button type="button" aria-expanded={open} aria-controls={region} onClick={() => { setOpen(!open); onOpenChange?.(!open); }} className="flex min-h-10 w-full items-center justify-between gap-2 text-left text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
      <span>{label}</span><ChevronDown size={14} aria-hidden className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    <div id={region} hidden={!open}>{children}</div>
  </div>;
}

type HealthStatus = {
  health?: MemoryHealthStatus; workerError: string | null;
  backlog: { pending: number; leased: number; deferred: number; failed: number; more?: Record<string, boolean> };
  runtime?: { indexing?: boolean; error?: string | null } | null;
  semantic?: SemanticIndexStatus | null;
};
function HealthBody({ status }: { status: HealthStatus }) {
  const health = status.health;
  return <div className="mt-3 space-y-2 text-[12px] text-ink-secondary">
    {status.semantic && <p>{semanticPhrase(status.semantic)}</p>}
    <p>{tx("scope")}</p>
    {!health ? <p role="status">{tx("unavailable")}</p> : <>
      <dl className="space-y-2">
        <div><dt className="font-medium text-ink">{tx("captured")}</dt><dd>{tx("capturedBody", { count: health.captured.sources })} {lastActivity(health.captured.lastAt)}</dd></div>
        <div><dt className="font-medium text-ink">{tx("processed")}</dt><dd>{tx("processedBody", { count: health.processed.sources })} {lastActivity(health.processed.lastAt)}</dd></div>
        <div><dt className="font-medium text-ink">{tx("retrieved")}</dt><dd>{health.retrieved.available === false ? tx("retrievedNone") : <>{tx("retrievedBody", { queries: health.retrieved.queries, hits: health.retrieved.hits })} {lastActivity(health.retrieved.lastAt)}</>}</dd></div>
        <div><dt className="font-medium text-ink">{tx("supplied")}</dt><dd>{tx("suppliedBody", { references: health.supplied.references, turns: health.supplied.turns })} {lastActivity(health.supplied.lastAt)}</dd></div>
      </dl>
      <p>{tx("synthesis", { state: health.synthesis.state === "configured" ? tx("synthesis.configured") : health.synthesis.state === "not-configured" ? tx("synthesis.notConfigured") : health.synthesis.state === "budget-limited" ? tx("synthesis.budgetLimited") : tx("synthesis.disabled") })}{health.synthesis.reason && ` ${health.synthesis.reason}`}</p>
    </>}
    <p>{tx("backlog", { pending: countText(status.backlog.pending, status.backlog.more?.pending), leased: countText(status.backlog.leased, status.backlog.more?.leased), deferred: countText(status.backlog.deferred, status.backlog.more?.deferred), failed: countText(status.backlog.failed, status.backlog.more?.failed) })}</p>
    {(status.workerError || status.runtime?.error) && <p role="status" className="break-words text-ink-secondary">{workerSentence(status.workerError || status.runtime?.error)}</p>}
    {status.runtime?.indexing && <p>{tx("indexing")}</p>}
  </div>;
}
/** Health of memory. On the Memory page it sits open inside Advanced (`open`); in a bot's compact view it is a fold. */
export function MemoryHealth({ status, open = false }: { status: HealthStatus; open?: boolean }) {
  if (open) return <section aria-label={tx("ariaLabel")} className="rounded-lg border border-hairline/40 p-3"><h3 id="memory-health-heading" className="text-[14px] font-medium">{tx("heading")}</h3><HealthBody status={status} /></section>;
  return <Disclosure label={tx("disclosure")}><HealthBody status={status} /></Disclosure>;
}
