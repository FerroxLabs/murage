import { useId } from "react";
import { AlertTriangle, ArrowUpRight, RefreshCw, Settings2 } from "lucide-react";
import { providerErrorPresentation, type ProviderErrorInfo } from "../../shared/provider-error";

/** Structured provider errors use reviewed copy, never backend HTML/JSON or
 * a URL supplied in an error message. Retry remains an explicit user action. */
export function ProviderErrorCard({ info, onRetry, onOpenProviderSettings }: {
  info: ProviderErrorInfo;
  onRetry?: () => void;
  onOpenProviderSettings: () => void;
}) {
  const titleId = useId();
  const presentation = providerErrorPresentation(info);
  const hasHttpStatus = Number.isInteger(info.httpStatus) && info.httpStatus >= 100 && info.httpStatus <= 599;
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return <div className="flex justify-start">
    <section role="alert" aria-labelledby={titleId} className="w-full max-w-[42rem] rounded-xl border border-danger/30 bg-card p-4 text-ink shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger" aria-hidden="true"><AlertTriangle size={19} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{info.provider === "flux-router" ? "Flux Router" : "Model provider"}</p>
          <h3 id={titleId} className="mt-1 break-words text-[16px] font-semibold leading-snug">{presentation.title}</h3>
        </div>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{presentation.summary}</p>
      <div className="mt-3 rounded-lg bg-inset px-3 py-2.5">
        <p className="text-[12px] font-semibold text-ink">How to continue</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{presentation.resolution}</p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {presentation.billingUrl && <a href={presentation.billingUrl} target="_blank" rel="noopener noreferrer"
          className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink " + focus}>
          Add Flux credits <ArrowUpRight size={15} aria-hidden="true" />
        </a>}
        <button type="button" onClick={onOpenProviderSettings}
          className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised " + focus}>
          <Settings2 size={15} aria-hidden="true" /> Provider settings
        </button>
        {onRetry && <button type="button" onClick={onRetry}
          className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised hover:text-ink " + focus}>
          <RefreshCw size={14} aria-hidden="true" /> Retry
        </button>}
      </div>
      {hasHttpStatus && <details className="mt-3 text-[11px] text-ink-secondary">
        <summary className={"w-fit cursor-pointer rounded py-1 " + focus}>Technical details</summary>
        <p className="mt-1">Provider response: HTTP {info.httpStatus}</p>
      </details>}
    </section>
  </div>;
}
