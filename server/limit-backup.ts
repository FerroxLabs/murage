// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-I I4: which engines may take over when one hits its limit, and
// what each one bills. Never two sign-ins of one subscription (that only
// rotates the same plan); an own key on the same provider, or another
// provider, is fine. A routine continues on a backup only when the owner
// said so for routines and it runs on a plan or key the owner already pays
// for: never on Flux credit, never on a billing nobody can name.

import type { ModelSelection } from "./contracts.ts";
import { fluxIdIsRoutable } from "./flux-surface.ts";

export type EngineBilling = "own-subscription" | "own-key" | "flux" | "unknown";

export interface BillingFacts {
  /** the engine the selection runs on */
  driverKind?: string;
  /** the selection's account connection preset, when it names one that exists */
  preset?: string;
}

const SIGN_IN_PRESETS = new Set(["chatgpt", "supergrok"]);
const SUBSCRIPTION_CLIS = new Set(["claudeAgent", "codex"]);

export function engineBilling(selection: ModelSelection, facts: BillingFacts): EngineBilling {
  if (selection.connectionId) {
    if (!facts.preset) return "unknown";
    if (facts.preset === "flux") return "flux";
    if (SIGN_IN_PRESETS.has(facts.preset)) return "own-subscription";
    return "own-key";
  }
  if (!facts.driverKind) return "unknown";
  if (fluxIdIsRoutable(selection.model, facts.driverKind)) return "flux";
  // Fuigo signed in is metered Murage/Flux use (default-engine.ts)
  if (facts.driverKind === "fuigoAgent") return "flux";
  if (SUBSCRIPTION_CLIS.has(facts.driverKind)) return "own-subscription";
  return "unknown";
}

/** The subscription a selection draws on, when it is a plan sign-in. */
function subscriptionOf(selection: ModelSelection, facts: BillingFacts): string | null {
  if (engineBilling(selection, facts) !== "own-subscription") return null;
  if (selection.connectionId) return facts.preset === "chatgpt" ? "openai" : facts.preset === "supergrok" ? "xai" : null;
  if (facts.driverKind === "claudeAgent") return "anthropic";
  if (facts.driverKind === "codex") return "openai";
  return null;
}

export function limitBackupAllowed(from: ModelSelection, fromFacts: BillingFacts, to: ModelSelection, toFacts: BillingFacts): boolean {
  if (from.instanceId === to.instanceId && from.model === to.model && (from.connectionId ?? "") === (to.connectionId ?? "")) return false;
  const a = subscriptionOf(from, fromFacts), b = subscriptionOf(to, toFacts);
  return !(a && b && a === b);
}

/** A routine may continue on this backup: "also for routines", and own plan or own key. */
export function routineBackupBilling(billing: EngineBilling): boolean {
  return billing === "own-subscription" || billing === "own-key";
}

export function billingLabel(billing: EngineBilling): string {
  return billing === "own-subscription" ? "your plan" : billing === "own-key" ? "your key" : billing === "flux" ? "Flux credit" : "billing unknown";
}
