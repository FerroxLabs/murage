// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (a Masterclass customer's two cards): a Fuigo or Flux refusal that is not a limit gets ONE card, never the
// "request hit a problem" card beside a made-up "at its limit until" card. The server sets the reason
// (limit-continuation.ts gatewayBusy); the copy is fixed per reason and names no time the server did not send.
import { useId } from "react";
import { ArrowUpRight, Hourglass, RefreshCw } from "lucide-react";
import { localeCode, t } from "@/lib/i18n";
import { opensPurchasePages } from "@/lib/native-shell";
import { FLUX_BILLING_PAGE } from "../../shared/flux-links";

export type GatewayBusyReason = "busy" | "credit" | "unresolved" | "hold" | "freeCap" | "hourly";
const REASONS: ReadonlySet<string> = new Set(["busy", "credit", "unresolved", "hold", "freeCap", "hourly"]);
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function gatewayBusyReason(value: unknown): GatewayBusyReason | undefined {
  return typeof value === "string" && REASONS.has(value) ? value as GatewayBusyReason : undefined;
}

/** Add credit is offered for the two credit reasons, and only where the app may open purchase pages (never the store apps). */
export function gatewayBusyOffersCredit(reason: GatewayBusyReason, purchasePages: boolean): boolean {
  return purchasePages && (reason === "credit" || reason === "hold" || reason === "freeCap");
}

/** FLUX-BURN-COPY-1018: the hourly gate's reset time the server carried, in the app's language. */
export function gatewayBusyResetTime(at: number): string {
  return new Date(at).toLocaleTimeString(localeCode(), { hour: "numeric", minute: "2-digit" });
}

export function GatewayBusyCard({ engine, reason, resetsAt, onRetry }: { engine: string; reason: GatewayBusyReason; resetsAt?: number; onRetry?: () => void }) {
  const titleId = useId();
  const name = engine.trim().slice(0, 80) || "Fuigo";
  const credit = gatewayBusyOffersCredit(reason, opensPurchasePages());
  // Only the hourly gate names a time, and only one the server sent (never a guessed hour).
  const until = reason === "hourly" && typeof resetsAt === "number" && Number.isFinite(resetsAt) ? gatewayBusyResetTime(resetsAt) : null;
  return <div className="flex justify-start">
    <section role="status" aria-labelledby={titleId} data-gateway-busy={reason} className="w-full max-w-[42rem] rounded-xl border border-warning/35 bg-card p-4 text-ink shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning" aria-hidden="true"><Hourglass size={19} /></span>
        <p id={titleId} className="min-w-0 flex-1 break-words text-[15px] font-semibold leading-snug">{until ? t("gatewayBusy.hourly.until", { time: until }) : t(`gatewayBusy.${reason}.title`, { engine: name })}</p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {credit && <a href={FLUX_BILLING_PAGE} target="_blank" rel="noopener noreferrer" data-gateway-credit className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink " + focus}>{t("gatewayBusy.addCredit")} <ArrowUpRight size={14} aria-hidden="true" /></a>}
        {onRetry && <button type="button" onClick={onRetry} data-gateway-send-again className={"inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-2 text-[13px] font-medium text-ink " + focus}><RefreshCw size={14} aria-hidden="true" /> {t("gatewayBusy.sendAgain")}</button>}
      </div>
    </section>
  </div>;
}
