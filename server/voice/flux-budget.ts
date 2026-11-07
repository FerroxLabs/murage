import { classifyFluxRefusal } from "../../shared/flux-refusal.ts";
import { markBudgetReached } from "./voice-routes.ts";
/** Typed across tool adapters, even when the engine consumes a failed tool and continues. */
export class FluxBudgetReached extends Error {
  readonly providerError = { provider: "flux-router", fluxBudget: true, kind: "payment", httpStatus: 402 } as const;
  constructor() { super("This Flux key has reached its budget."); }
}
export function checkFluxBudget(status: number, body: unknown, baseUrl: string, key: string): void {
  if (classifyFluxRefusal(status, body) !== "budget") return;
  markBudgetReached({ via: "flux", label: "Flux", baseUrl: baseUrl.replace(/\/+$/, ""), key, model: "" });
  throw new FluxBudgetReached();
}
