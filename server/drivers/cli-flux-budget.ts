import { registerBusyloopPayloadSite, fluxRouteFor } from "../../shared/flux-route.ts";
import { claudeRefusal, cliRefusal, fluxResponseDecision, refusalResetAt } from "./flux-busyloop-readers.ts";
import { classifyFluxRefusal } from "../../shared/flux-refusal.ts";
import type { ProviderErrorInfo } from "../../shared/provider-error.ts";
import { markBudgetReached } from "../voice/voice-routes.ts";

/** Only called for CLI error frames, with the credential captured for this turn. */
export function cliFluxBudget(error: unknown, route: { key: string; baseUrl: string } | null): ProviderErrorInfo | undefined {
  if (!route || !fluxRouteFor(route.baseUrl).routed) return undefined;
  const frame = error && typeof error === "object" ? error as { message?: unknown } : undefined;
  const decision = typeof frame?.message === "string" ? claudeRefusal(registerBusyloopPayloadSite("classify", frame.message)) : undefined;
  if (decision && decision.action !== "PASS") {
    const status = Number(/API Error:\s*(\d{3})/.exec(frame!.message as string)![1]);
    let body: unknown;
    try { body = registerBusyloopPayloadSite("read", JSON.parse((frame!.message as string).slice((frame!.message as string).indexOf("{")))); } catch { /* lost body */ }
    const resetsAt = refusalResetAt(decision, body);
    return { kind: status === 401 ? "authentication" : status === 403 ? "permission" : status === 402 ? "payment" : status === 429 ? "rate-limit" : "unavailable", httpStatus: status, provider: "flux-router", fluxDecision: decision, ...(resetsAt !== undefined ? { fluxResetsAt: resetsAt } : {}) };
  }
  let status = 0;
  const envelopes: unknown[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6 || value == null) return;
    if (typeof value === "string") {
      const text = value.slice(0, 16384);
      const match = /(?:API Error:|HTTP(?: error:| status)?|unexpected status)\s*(402)\b/i.exec(text);
      if (match) status = 402;
      try { visit(registerBusyloopPayloadSite("read", JSON.parse(text)), depth + 1); } catch {
        const start = text.indexOf("{");
        if (start >= 0) { try { visit(registerBusyloopPayloadSite("read", JSON.parse(text.slice(start))), depth + 1); } catch { /* not a JSON envelope */ } }
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
  const wire = cliRefusal(registerBusyloopPayloadSite("classify", error));
  const legacyBudget = !envelopes.some(value => classifyFluxRefusal(0, value) === "premium")
    && (status === 402 || envelopes.some(value => classifyFluxRefusal(0, value) === "budget"));
  if (legacyBudget) markBudgetReached({ via: "flux", label: "Flux", baseUrl: route.baseUrl, key: route.key, model: "" });
  const result = wire.decision.action === "PASS" && legacyBudget ? fluxResponseDecision(registerBusyloopPayloadSite("classify", {endpoint:"resp",status:402,body:wire.body})) : wire.decision;
  if (result.action === "PASS") return undefined;
  const httpStatus = wire.status || (legacyBudget ? 402 : 0);
  const resetsAt = refusalResetAt(result, wire.body);
  return {kind:httpStatus === 401 ? "authentication" : httpStatus === 403 ? "permission" : httpStatus === 402 ? "payment" : httpStatus === 429 ? "rate-limit" : "unavailable", provider:"flux-router", fluxDecision:result, httpStatus, ...(resetsAt !== undefined ? {fluxResetsAt:resetsAt} : {}), ...(legacyBudget ? {fluxBudget:true} : {})};
}
