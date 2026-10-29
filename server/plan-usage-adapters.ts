// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plan usage direct readers (GAP-PLAN-LIMITS rev 1.2, section 7.1): build-owned and EMPTY.
//
// A direct reader would read a subscription credential and call a provider's usage endpoint
// with it (Claude OAuth usage, Codex `wham/usage` from an idle credential file, Grok Build
// `cli-chat-proxy`, or a connected-plan bearer). Each one needs affirmative, recorded provider
// permission for Murage, the exact endpoint and use, the credential class and the deployment,
// with evidence, reviewer, date, scope and a review deadline, and its own bounded design. None
// has that, so none is registered and none is implemented: there is no dormant transport to
// switch on. No setting, environment variable, runtime download or Refresh changes this list;
// only a later reviewed release can add an entry.

/** One build-owned qualification record (section 4, AdapterQualification). */
export interface AdapterQualification {
  readonly adapter: string;
  readonly version: string;
  readonly endpoint: string;
  readonly credentialClass: string;
  readonly deploymentScope: string;
  readonly evidenceReference: string;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly reviewDeadline: string;
}

/** The direct readers this release registers: none. */
export const DIRECT_USAGE_ADAPTERS: readonly AdapterQualification[] = Object.freeze([]);

/** Engines that report plan usage natively over a connection Murage already owns. */
export const NATIVE_PLAN_USAGE_ENGINES: readonly string[] = Object.freeze(["codex"]);

/** What plan reporting a turn's actual route gets (section 3). Every engine and route gets a row: nothing is
 * left to fall through to "unlimited". */
export type PlanReporting =
  /** Windows the engine reports over its own running process. */
  | "native"
  /** Limits and resets the engine reported on a refusal; plan usage reads as not available. */
  | "observed"
  /** Pay-per-use (an API key, a metered route): no plan window exists to show. */
  | "pay-per-use"
  /** A proven local model: no subscription reset. */
  | "local"
  /** A service with no plan (the Computer). */
  | "service";

export const PLAN_USAGE_MATRIX: ReadonlyArray<{ readonly route: import("../shared/plan-usage.ts").PlanRouteKind; readonly reporting: PlanReporting; readonly why: string }> = Object.freeze([
  { route: "native-plan", reporting: "native", why: "an engine that reports plan windows natively (Codex) on a process Murage already runs; any other engine reports limits on refusal only" },
  { route: "connected-plan", reporting: "observed", why: "a connected ChatGPT or SuperGrok plan: its gateway's observed limit and pause, never a token callback" },
  { route: "api", reporting: "pay-per-use", why: "an API key bills each use, so there is no plan window; request limits stay visible as throttles" },
  { route: "flux", reporting: "observed", why: "Flux route and refusal facts until Flux publishes a verified allowance contract" },
  { route: "local", reporting: "local", why: "a proven local model has no subscription reset" },
  { route: "service", reporting: "service", why: "a service with no subscription plan" },
]);

/** The reporting a route gets. `native` only for an engine listed as a native reporter. */
export function planReportingFor(engineKind: string, route: import("../shared/plan-usage.ts").PlanRouteKind): PlanReporting {
  if (route === "native-plan") return NATIVE_PLAN_USAGE_ENGINES.includes(engineKind) ? "native" : "observed";
  return PLAN_USAGE_MATRIX.find((row) => row.route === route)!.reporting;
}

/** True when the route is paid per use: no plan window, so plan usage reads as not applicable (never as unlimited). */
export const billsEachUse = (route: import("../shared/plan-usage.ts").PlanRouteKind): boolean => planReportingFor("", route) === "pay-per-use";
