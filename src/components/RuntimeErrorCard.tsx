import { useId, type ReactNode } from "react";
import { AlertTriangle, Hourglass, MonitorX, RefreshCw, Settings2 } from "lucide-react";
import { classifyLocalResourceConflict, classifyLocalSetupFailure, engineErrorCategory, type LocalResourceConflict, type LocalSetupFailure } from "../../shared/provider-error";
import { t } from "@/lib/i18n";
import { isProviderSafetyBlock } from "../../shared/provider-safety";
import { DiagnosticDetails,type IncidentMessageSelection } from "./DiagnosticDetails";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Plain-text diagnostics only. No provider HTML or automatic retry. */
export function RuntimeErrorCard({ message, details, errorKind, localFailure, diagnostic: tracking, turnId, incident, setup, onRetry, onOpenProviderSettings }: {
  message: string; details?: string; errorKind?: string; localFailure?: string; setup?: ReactNode;
  diagnostic?: unknown; turnId?: string; incident?:IncidentMessageSelection;
  onRetry?: () => void; onOpenProviderSettings: () => void;
}) {
  const titleId = useId();
  const conflict = setup ? undefined : classifyLocalResourceConflict(message, details);
  if (conflict) return <ResourceBusyCard conflict={conflict} message={message} diagnostic={tracking} turnId={turnId} incident={incident} onRetry={onRetry} />;
  const local = setup ? undefined : classifyLocalSetupFailure(message, details, localFailure);
  if (local) return <LocalSetupFailureCard failure={local} message={message} details={details} diagnostic={tracking} turnId={turnId} incident={incident} onRetry={onRetry} />;
  const safetyBlocked = !setup && (isProviderSafetyBlock(message) || isProviderSafetyBlock(details ?? ""));
  const generic = /^(?:internal error|unknown error|ACP request failed|request failed)[.!]?$/i.test(message.trim());
  // Fixed copy for the kind the driver reported (Fuigo's error_kind), led
  // before the engine's own message; an unknown kind keeps the plain card.
  // Read from the structured field only — the details begin with the engine's
  // own message, which must never be able to choose this copy.
  const category = engineErrorCategory(errorKind);
  const explanation = category ? t(`runtimeError.engineKind.${category}`) : undefined;
  const diagnostic = details || message;
  return <div className="flex justify-start">
    <section role="alert" aria-labelledby={titleId} className="w-full max-w-[42rem] rounded-xl border border-danger/30 bg-card p-4 text-ink shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger" aria-hidden="true"><AlertTriangle size={19} /></span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="break-words text-[16px] font-semibold leading-snug">{setup ? "This engine needs setup" : safetyBlocked ? "The provider blocked this request" : "This request hit a problem"}</h3>
          <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-secondary">{explanation ?? (generic
            ? "The engine reported an error without explaining what went wrong. Any available diagnostic information is below."
            : message)}</p>
          {explanation && !generic && <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-secondary">{message}</p>}
        </div>
      </div>
      {setup || <p className="mt-3 rounded-lg bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink-secondary">{safetyBlocked
        ? "The provider's safety checks stopped this request. Review your request before sending a new message. Changing Murage permissions will not remove the provider's restriction."
        : "Review the details, then retry or choose another configured model in Provider settings."}</p>}
      {!safetyBlocked && <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onOpenProviderSettings} className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-2 text-[13px] font-medium text-ink " + focus}><Settings2 size={15} aria-hidden="true" /> Provider settings</button>
        {onRetry && !setup && <button type="button" onClick={onRetry} className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised " + focus}><RefreshCw size={14} aria-hidden="true" /> Retry</button>}
      </div>}
      <details className="mt-3 text-[11px] text-ink-secondary">
        <summary className={"w-fit cursor-pointer rounded py-1 " + focus}>Technical details</summary>
        <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px]">{diagnostic}</pre>
        {generic && diagnostic === message && <p className="mt-2">No additional error details were supplied by the engine.</p>}
        <DiagnosticDetails diagnostic={tracking} turnId={turnId} incident={incident} />
      </details>
    </section>
  </div>;
}

/** Another thread on this device holds the browser, computer or working folder
 * this thread needs. The only useful action is to wait or stop that thread and
 * retry, so the card offers no provider, account or model settings. */
function ResourceBusyCard({ conflict, message, diagnostic, turnId, incident, onRetry }: {
  conflict: LocalResourceConflict; message: string; onRetry?: () => void;
  diagnostic?: unknown; turnId?: string; incident?:IncidentMessageSelection;
}) {
  const titleId = useId();
  return <div className="flex justify-start">
    <section role="alert" aria-labelledby={titleId} data-runtime-error="resource-busy" className="w-full max-w-[42rem] rounded-xl border border-warning/35 bg-card p-4 text-ink shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning" aria-hidden="true"><Hourglass size={18} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t("runtimeError.busy.label")}</p>
          <h3 id={titleId} className="mt-1 break-words text-[16px] font-semibold leading-snug">{t(`runtimeError.busy.${conflict.resource}.title`)}</h3>
        </div>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{t("runtimeError.busy.summary")}</p>
      <div className="mt-3 rounded-lg bg-inset px-3 py-2.5">
        <p className="text-[12px] font-semibold text-ink">{t("runtimeError.busy.continue")}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t(onRetry ? "runtimeError.busy.resolution" : "runtimeError.busy.resolutionSend")}</p>
      </div>
      {onRetry && <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised " + focus}><RefreshCw size={14} aria-hidden="true" /> {t("runtimeError.busy.retry")}</button>
      </div>}
      <details className="mt-3 text-[11px] text-ink-secondary">
        <summary className={"w-fit cursor-pointer rounded py-1 " + focus}>{t("runtimeError.busy.details")}</summary>
        <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px]">{message}</pre>
        <DiagnosticDetails diagnostic={diagnostic} turnId={turnId} incident={incident} />
      </details>
    </section>
  </div>;
}

/** This device's browser, computer or working folder could not be set up for
 * the turn. Not a provider failure, so no Provider settings action and no
 * "choose another configured model" advice: the message names what to fix,
 * and Retry is the way on. */
function LocalSetupFailureCard({ failure, message, details, diagnostic, turnId, incident, onRetry }: {
  failure: LocalSetupFailure; message: string; details?: string; onRetry?: () => void;
  diagnostic?: unknown; turnId?: string; incident?:IncidentMessageSelection;
}) {
  const titleId = useId();
  return <div className="flex justify-start">
    <section role="alert" aria-labelledby={titleId} data-runtime-error="local-setup" data-local-failure={failure} className="w-full max-w-[42rem] rounded-xl border border-danger/30 bg-card p-4 text-ink shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger" aria-hidden="true"><MonitorX size={18} /></span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="break-words text-[16px] font-semibold leading-snug">{t(`runtimeError.local.${failure}.title`)}</h3>
          <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-secondary">{message}</p>
        </div>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{t("runtimeError.local.summary")}</p>
      <div className="mt-3 rounded-lg bg-inset px-3 py-2.5">
        <p className="text-[12px] font-semibold text-ink">{t("runtimeError.local.continue")}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t(`runtimeError.local.${failure}.resolution`)}</p>
      </div>
      {onRetry && <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised " + focus}><RefreshCw size={14} aria-hidden="true" /> {t("runtimeError.busy.retry")}</button>
      </div>}
      <details className="mt-3 text-[11px] text-ink-secondary">
        <summary className={"w-fit cursor-pointer rounded py-1 " + focus}>{t("runtimeError.busy.details")}</summary>
        <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px]">{details || message}</pre>
        <DiagnosticDetails diagnostic={diagnostic} turnId={turnId} incident={incident} />
      </details>
    </section>
  </div>;
}
