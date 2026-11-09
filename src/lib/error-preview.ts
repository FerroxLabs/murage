// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one-line reading of a failed turn, for the sidebar and every other
// one-line surface. The transcript shows a failed turn as a card with
// reviewed copy (ProviderErrorCard, RuntimeErrorCard) and keeps the engine's
// own words under Technical details. The sidebar used to show the raw
// activity name instead: "error: API error (status 429 Too Many Requests):
// api_error: …". A preview is one plain sentence chosen the same way the card
// chooses its heading, and never the engine's text.
import { t } from "@/lib/i18n";
import { engineErrorCategory, isWordedLocalFailure, type ProviderErrorInfo } from "../../shared/provider-error";
import { serviceIdentity, type ServiceIdentity } from "../../shared/provider-service";
import { isProviderSafetyBlock } from "../../shared/provider-safety";
import { plainTurnError } from "../../shared/turn-error-code";

const PROVIDER_CATEGORIES = ["credits", "spend-cap", "payment", "authentication", "permission", "rate-limit", "unavailable"] as const;
export type ProviderErrorCategory = typeof PROVIDER_CATEGORIES[number] | "unknown";

/** The card's category for a structured provider error (ProviderErrorCard). */
export function providerErrorCategory(info: ProviderErrorInfo): ProviderErrorCategory {
  return (PROVIDER_CATEGORIES as readonly string[]).includes(info.kind) ? info.kind as ProviderErrorCategory : "unknown";
}

/** Which reviewed copy a named error uses where it differs from the generic one (ERRORS-NAME-THE-SERVICE): a payment, a refused
 * sign-in or a refused key, or a reply with no category. Every other category keeps its copy with the service named in it. */
export function namedProviderVariant(info: ProviderErrorInfo, service: ServiceIdentity): "payment" | "fluxPayment" | "signIn" | "key" | "unknown" | undefined {
  const category = providerErrorCategory(info);
  // A provider label with no server stamp (a message from an earlier build) keeps the generic copy: it names no plan to top up.
  if (category === "payment") return !info.engine && !info.connection ? undefined : service.account === "flux" ? "fluxPayment" : "payment";
  if (category === "authentication" && service.account !== "flux") return service.account === "own-key" ? "key" : "signIn";
  return category === "unknown" ? "unknown" : undefined;
}

/** The card's heading for a structured provider error. Names the service when the server stamped which one it was. */
export function providerErrorTitle(info: ProviderErrorInfo): string {
  const service = serviceIdentity(info);
  if (service) {
    const variant = namedProviderVariant(info, service);
    if (variant) return t(`providerError.named.${variant}.title`, { service: service.name });
    return t(`providerError.${providerErrorCategory(info)}.title`, { provider: service.name });
  }
  const provider = info.provider === "flux-router" ? "Flux Router" : t("providerError.provider");
  return t(`providerError.${providerErrorCategory(info)}.title`, { provider });
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** A plain sentence for a failed-turn activity, or undefined when the
 *  activity is not a failed turn. */
export function errorPreview(tool: { name: string; setup?: boolean; errorKind?: string; errorDetails?: string; providerError?: ProviderErrorInfo; localFailure?: string; localFailureEngine?: string; /** a sidebar line's reading of the details (shared/sidebar-line.ts) */ blocked?: true } | undefined | null): string | undefined {
  if (!tool || !tool.name.startsWith("error:")) return undefined;
  if (tool.providerError) return sentence(providerErrorTitle(tool.providerError));
  if (isWordedLocalFailure(tool.localFailure)) {
    return sentence(t(`runtimeError.local.${tool.localFailure}.title`, { engine: tool.localFailureEngine || "Engine" }));
  }
  if (tool.setup) return "This engine needs setup.";
  const message = tool.name.slice(6).trim();
  if (tool.blocked || isProviderSafetyBlock(message) || isProviderSafetyBlock(tool.errorDetails ?? "")) return t("ux.lcopyb.errorPreview.blocked");
  const category = engineErrorCategory(tool.errorKind);
  if (category) return t(`runtimeError.engineKind.${category}`);
  // an internal code reads as its plain sentence, never as the code
  const coded = plainTurnError(message);
  if (coded) return coded.split(/(?<=\.)\s/)[0];
  return "This request hit a problem.";
}
