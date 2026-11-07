import { classifyFluxRefusal } from "../../shared/flux-refusal.ts";
import type { ProviderErrorInfo } from "../../shared/provider-error.ts";
import { markBudgetReached } from "../voice/voice-routes.ts";

/** Only called for CLI error frames, with the credential captured for this turn. */
export function cliFluxBudget(error: unknown, route: { key: string; baseUrl: string } | null): ProviderErrorInfo | undefined {
  if (!route) return undefined;
  let status = 0;
  const envelopes: unknown[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6 || value == null) return;
    if (typeof value === "string") {
      const text = value.slice(0, 16384);
      const match = /(?:API Error:|HTTP(?: error:| status)?|unexpected status)\s*(402)\b/i.exec(text);
      if (match) status = 402;
      try { visit(JSON.parse(text), depth + 1); } catch {
        const start = text.indexOf("{");
        if (start >= 0) { try { visit(JSON.parse(text.slice(start)), depth + 1); } catch { /* not a JSON envelope */ } }
      }
      envelopes.push(text);
    } else if (typeof value === "object") {
      envelopes.push(value);
      if (value instanceof Error) visit(value.message, depth + 1);
      for (const [key, child] of Object.entries(value)) {
        if (["http_status", "status", "statusCode", "httpStatusCode"].includes(key) && child === 402) status = 402;
        if (["error", "data", "body", "message", "codexErrorInfo", "httpConnectionFailed"].includes(key)) visit(child, depth + 1);
      }
    }
  };
  visit(error);
  if (envelopes.some(value => classifyFluxRefusal(0, value) === "premium")) return undefined;
  if (status !== 402 && !envelopes.some(value => classifyFluxRefusal(0, value) === "budget")) return undefined;
  markBudgetReached({ via: "flux", label: "Flux", baseUrl: route.baseUrl, key: route.key, model: "" });
  return { kind: "payment", httpStatus: 402, provider: "flux-router", fluxBudget: true };
}
