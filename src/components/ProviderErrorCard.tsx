import { useId, useState } from "react";
import { AlertTriangle, ArrowUpRight, RefreshCw, Settings2 } from "lucide-react";
import { PROVIDER_SAID_MAX, providerErrorPresentation, providerSaidNote, XAI_BILLING_PAGE, type ProviderErrorInfo } from "../../shared/provider-error";
import { serviceIdentity, type ServiceIdentity } from "../../shared/provider-service";
import { t } from "@/lib/i18n";
import { namedProviderVariant, providerErrorCategory, providerErrorTitle, type ProviderErrorCategory } from "@/lib/error-preview";
import { DiagnosticDetails,type IncidentMessageSelection } from "./DiagnosticDetails";
import { parseRuntimeErrorDiagnostic } from "../../shared/error-diagnostic";
import { opensPurchasePages } from "@/lib/native-shell";
import { offersFuigo, runFuigoTap } from "./engine/UseFuigoInstead";
import type { FuigoWall } from "./engine/SignInWall";

/** The one fix the card leads with (ERRORS-NAME-THE-SERVICE): the provider's billing page for a payment or credit reply, the
 * sign-in or key in Models & engines for a refused sign-in, else moving this bot to Fuigo when Fuigo can answer now, else
 * Models & engines. Retry is always the secondary action. */
export type ProviderErrorLead = { kind: "billing"; url: string; label: string } | { kind: "settings" } | { kind: "fuigo" };

export function providerErrorLead(info: ProviderErrorInfo, service: ServiceIdentity | undefined, wall: FuigoWall | undefined, purchases: boolean): ProviderErrorLead {
  const category: ProviderErrorCategory = providerErrorCategory(info);
  const presentation = providerErrorPresentation(info);
  // spend-cap never leads to billing: buying something does not lift it
  if (purchases && (category === "payment" || category === "credits")) {
    if (providerSaidNote(info) === "xai-spend-limit") return { kind: "billing", url: XAI_BILLING_PAGE, label: t("providerError.said.openXaiBilling") };
    const url = service?.billingUrl ?? presentation.billingUrl;
    if (url) return { kind: "billing", url, label: service?.account === "flux" || (!service && info.provider === "flux-router") ? t("providerError.addCredits") : t("providerError.openBilling", { service: service?.name ?? "" }) };
  }
  if (category === "authentication") return { kind: "settings" };
  // Fuigo answers through Flux, so moving a bot whose Flux plan refused it would change nothing.
  if (wall && service?.account !== "flux" && offersFuigo(wall.bot, wall.instances)) return { kind: "fuigo" };
  return { kind: "settings" };
}

/** Structured provider errors use reviewed copy, never backend HTML/JSON or
 * a URL supplied in an error message. Retry remains an explicit user action. */
export function ProviderErrorCard({ info, details, diagnostic, turnId, incident, onRetry, retryLabel, onOpenProviderSettings, fuigoWall, botName }: {
  info: ProviderErrorInfo;
  details?: string;
  diagnostic?: unknown; turnId?: string; incident?:IncidentMessageSelection;
  onRetry?: () => void;
  retryLabel?: string;
  onOpenProviderSettings: () => void;
  /** The bot and the engine list, so the card can offer "Switch <bot> to Fuigo" when Fuigo can answer now. */
  fuigoWall?: FuigoWall;
  botName?: string;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const service = serviceIdentity(info);
  const variant = service ? namedProviderVariant(info, service) : undefined;
  // The same category and heading the sidebar preview uses (lib/error-preview.ts).
  const category = providerErrorCategory(info);
  const lead = providerErrorLead(info, service, botName ? fuigoWall : undefined, opensPurchasePages());
  const params = { service: service?.name ?? "" };
  // Scope B: what the provider itself said, shown as plain text; a sentence Murage knows gets its plain line as the heading.
  const saidNote = providerSaidNote(info);
  const said = typeof info.providerSaid === "string" && info.providerSaid.trim() ? [...info.providerSaid].slice(0, PROVIDER_SAID_MAX).join("") : undefined;
  const team = typeof info.providerTeam === "string" && /^[0-9a-f-]{36}$/.test(info.providerTeam) ? info.providerTeam : undefined;
  const summary = saidNote ? t("providerError.said.xaiSpendLimit.summary") : variant === "payment" || variant === "fluxPayment" ? t(`providerError.named.${variant}.summary`, params) : t(`providerError.${category}.summary`);
  const resolution = saidNote ? t("providerError.said.xaiSpendLimit.resolution") : variant && variant !== "unknown" ? t(`providerError.named.${variant}.resolution`, params) : t(`providerError.${category}.resolution`);
  const hasHttpStatus = Number.isInteger(info.httpStatus) && info.httpStatus >= 100 && info.httpStatus <= 599;
  const parsedDiagnostic = parseRuntimeErrorDiagnostic(diagnostic);
  const hasDiagnostic = parsedDiagnostic?.turnId === turnId && parsedDiagnostic !== undefined;
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  const primary = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-50 " + focus;
  const quiet = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised " + focus;
  const tap = async () => {
    if (!fuigoWall) return;
    setBusy(true); setNote("");
    try { setNote(await runFuigoTap(fuigoWall.bot)); } finally { setBusy(false); }
  };
  return <div className="flex justify-start">
    <section role="alert" aria-labelledby={titleId} data-provider-lead={lead.kind} className="w-full max-w-[42rem] rounded-xl border border-danger/30 bg-card p-4 text-ink shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger" aria-hidden="true"><AlertTriangle size={19} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{service?.name ?? (info.provider === "flux-router" ? "Flux Router" : t("providerError.label"))}</p>
          <h3 id={titleId} className="mt-1 break-words text-[16px] font-semibold leading-snug">{saidNote ? t("providerError.said.xaiSpendLimit.title") : providerErrorTitle(info)}</h3>
        </div>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{summary}{service?.account ? <> {t(`providerError.account.${service.account}`, params)}</> : null}</p>
      <div className="mt-3 rounded-lg bg-inset px-3 py-2.5">
        <p className="text-[12px] font-semibold text-ink">{t("providerError.continue")}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{resolution}</p>
      </div>
      {(said || team) && <div data-provider-said className="mt-3 rounded-lg border border-hairline/50 px-3 py-2.5">
        <p className="text-[12px] font-semibold text-ink">{service ? t("providerError.said.heading", params) : t("providerError.said.headingUnnamed")}</p>
        {said && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-secondary">{said}</p>}
        {team && <p className="mt-1 break-all text-[12px] text-ink-secondary">{t("providerError.said.team", { team })}</p>}
      </div>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {lead.kind === "billing" && <a href={lead.url} target="_blank" rel="noopener noreferrer" data-provider-primary className={primary}>
          {lead.label} <ArrowUpRight size={15} aria-hidden="true" />
        </a>}
        {lead.kind === "fuigo" && <button type="button" data-provider-primary disabled={busy} onClick={() => void tap()} className={primary}>
          {t("providerError.switchToFuigo", { bot: botName ?? "" })}
        </button>}
        <button type="button" onClick={onOpenProviderSettings} {...(lead.kind === "settings" ? { "data-provider-primary": "" } : {})} className={lead.kind === "settings" && service ? primary : quiet}>
          <Settings2 size={15} aria-hidden="true" /> {t("providerError.settings")}
        </button>
        {onRetry && <button type="button" onClick={onRetry}
          className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised hover:text-ink " + focus}>
          <RefreshCw size={14} aria-hidden="true" /> {retryLabel ?? t("providerError.retry")}
        </button>}
      </div>
      {note ? <p role="status" className="mt-2 text-[12px] text-ink-secondary">{note}</p> : null}
      {(hasHttpStatus || details || hasDiagnostic) && <details className="mt-3 text-[11px] text-ink-secondary">
        <summary className={"w-fit cursor-pointer rounded py-1 " + focus}>{t("providerError.details")}</summary>
        {hasHttpStatus && <p className="mt-1">{t("providerError.status", { status: info.httpStatus })}</p>}
        {details && <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px]">{details}</pre>}
        <DiagnosticDetails diagnostic={diagnostic} turnId={turnId} incident={incident} />
      </details>}
    </section>
  </div>;
}
