// SPDX-License-Identifier: AGPL-3.0-or-later
// Whether the action check (spec 3.1, T23) can run for a bot, for the settings screen and the prompt. Availability comes from the
// resolved connection, never from the setting's name (D3): Flux when it is live (connected and its no-retain header deployed),
// otherwise the bot's own engine, said once in settings; with neither, unavailable with a reason, and the bot asks each step.
import { FLUX_NO_RETAIN_DEPLOYED, pickCheckerInstance, resolveCheckerConnection, type CheckerConnectionInput } from "./browser-action-checker-connection.ts";
export { FLUX_NO_RETAIN_DEPLOYED };
export type CheckerReasonKey = "browserExt.checker.reasonNoFlux" | "browserExt.checker.reasonNoRetain" | "browserExt.checker.reasonNoBotEngine" | "browserExt.checker.reasonUnavailable";
export interface CheckerAvailability {
  checkerAvailable: boolean;
  checkerReason?: CheckerReasonKey;
  /** Which engine will run the check, when one will. */
  checkerSource?: "flux" | "bot";
  /** The owner chose Flux but it is not live, so the bot's own engine runs the check. */
  checkerFallback?: boolean;
}

/** Availability from the actual connection: the same resolution the checker uses at dispatch. */
export function checkerAvailabilityFor(input: { check: "flux" | "bot"; instances: CheckerConnectionInput["instances"]; botInstanceId?: string; readKey?: () => string | null; models?: CheckerConnectionInput["models"]; noRetainDeployed?: boolean; fluxConnected?: boolean }): CheckerAvailability {
  const connection = resolveCheckerConnection({ switch: input.check, instances: input.instances, ...(input.botInstanceId ? { botInstanceId: input.botInstanceId } : {}), ...(input.readKey ? { readKey: input.readKey } : {}), ...(input.models ? { models: input.models } : {}), ...(input.noRetainDeployed !== undefined ? { noRetainDeployed: input.noRetainDeployed } : {}) });
  if (connection) return { checkerAvailable: true, checkerSource: connection.source, ...(connection.fallback ? { checkerFallback: true } : {}) };
  if (input.check === "bot") return { checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoBotEngine" };
  const flux = input.fluxConnected ?? Boolean((input.readKey ?? (() => null))());
  if (!flux) return { checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoFlux" };
  if (!(input.noRetainDeployed ?? FLUX_NO_RETAIN_DEPLOYED)) return { checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoRetain" };
  return { checkerAvailable: false, checkerReason: "browserExt.checker.reasonUnavailable" };
}

/** Same answer without the engine list. Pass `botEngineUsable` (from `pickCheckerInstance`) so the bot's own engine counts. Left out,
 * the engine is unknown and counts as unusable (fails closed): only a live Flux connection is available. Callers that have the
 * instance list use checkerAvailabilityFor instead. */
export function checkerAvailability(input: { check: "flux" | "bot"; fluxConnected: boolean; noRetainDeployed?: boolean; botEngineUsable?: boolean }): CheckerAvailability {
  const live = input.noRetainDeployed ?? FLUX_NO_RETAIN_DEPLOYED;
  if (input.check === "flux" && input.fluxConnected && live) return { checkerAvailable: true, checkerSource: "flux" };
  if (input.botEngineUsable) return { checkerAvailable: true, checkerSource: "bot", ...(input.check === "flux" ? { checkerFallback: true } : {}) };
  if (input.check === "bot") return { checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoBotEngine" };
  if (!input.fluxConnected) return { checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoFlux" };
  return { checkerAvailable: false, checkerReason: "browserExt.checker.reasonNoRetain" };
}
export { pickCheckerInstance };
