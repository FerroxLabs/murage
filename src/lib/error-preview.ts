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
import { engineErrorCategory, type ProviderErrorInfo } from "../../shared/provider-error";
import { isProviderSafetyBlock } from "../../shared/provider-safety";

const PROVIDER_CATEGORIES = ["credits", "spend-cap", "payment", "authentication", "permission", "rate-limit", "unavailable"] as const;
export type ProviderErrorCategory = typeof PROVIDER_CATEGORIES[number] | "unknown";

/** The card's category for a structured provider error (ProviderErrorCard). */
export function providerErrorCategory(info: ProviderErrorInfo): ProviderErrorCategory {
  return (PROVIDER_CATEGORIES as readonly string[]).includes(info.kind) ? info.kind as ProviderErrorCategory : "unknown";
}

/** The card's heading for a structured provider error. */
export function providerErrorTitle(info: ProviderErrorInfo): string {
  const provider = info.provider === "flux-router" ? "Flux Router" : t("providerError.provider");
  return t(`providerError.${providerErrorCategory(info)}.title`, { provider });
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** A plain sentence for a failed-turn activity, or undefined when the
 *  activity is not a failed turn. */
export function errorPreview(tool: { name: string; setup?: boolean; errorKind?: string; errorDetails?: string; providerError?: ProviderErrorInfo } | undefined | null): string | undefined {
  if (!tool || !tool.name.startsWith("error:")) return undefined;
  if (tool.providerError) return sentence(providerErrorTitle(tool.providerError));
  if (tool.setup) return "This engine needs setup.";
  const message = tool.name.slice(6).trim();
  if (isProviderSafetyBlock(message) || isProviderSafetyBlock(tool.errorDetails ?? "")) return "The provider blocked this request.";
  const category = engineErrorCategory(tool.errorKind);
  if (category) return t(`runtimeError.engineKind.${category}`);
  return "This request hit a problem.";
}
