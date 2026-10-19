export type PlanId = "starter" | "pro" | "max";
export interface Plan {
  id: PlanId;
  name: string;
  priceUsd: number;
  specs: string[];
  fluxCreditUsd: number;
}
// Prices and specs: pricing/DECISION.md (locked 2026-10-09). Flux credit amounts are config on the
// control-plane side too; this list is only what the page shows.
export const PLANS: readonly Plan[] = [
  { id: "starter", name: "Starter", priceUsd: 49, fluxCreditUsd: 10, specs: ["2 vCPU", "4 GB memory", "50 GB encrypted storage"] },
  { id: "pro", name: "Pro", priceUsd: 99, fluxCreditUsd: 20, specs: ["4 vCPU", "8 GB memory", "150 GB encrypted storage"] },
  { id: "max", name: "Max", priceUsd: 149, fluxCreditUsd: 40, specs: ["4 vCPU", "8 GB memory", "150 GB encrypted storage", "Priority support"] },
];
export const isPlanId = (v: unknown): v is PlanId => PLANS.some((p) => p.id === v);
