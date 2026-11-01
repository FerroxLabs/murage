// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L2A STAND-IN for L2B's Health page (src/components/health/HealthPage.tsx) and
// its status (src/components/health/health-status.ts). Sean 10-30: Health gets
// its own page off the You menu, with a status dot; Needs you shows a Health
// row only when the owner must act. Until L2B merges, the page is the engine
// list plus the existing Health card, and the level reads the engines only.
// L2B replaces the re-export lines in ../lane-slots.tsx.
import { useStore } from "@/state/store";
import { useEngineReading } from "@/components/today/use-engine-health";
import { t } from "@/lib/i18n";
import { Suspense } from "react";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import { LazyFallback } from "@/components/LazyFallback";
import type { EngineHealthRow, FluxHealthState, HealthPageProps, HealthStatus } from "../shell-contract";

// The page body loads on first use, like every other view's page.
const Body = retryableLazy(() => import("./health-page").then((module) => ({ default: module.HealthPageBody })));

/** The level from the engine reading alone: a signed-out or missing engine, or Flux used up, is the owner's to fix. */
export function healthFromEngines(engine: EngineHealthRow | null, flux: FluxHealthState, answered: boolean): HealthStatus {
  if (flux === "allowance-used-up") return { level: "act", line: t("ux.l2a.tag.fluxUsedUp") };
  if (flux === "key-problem") return { level: "act", line: t("ux.l2a.tag.fluxKey") };
  if (engine?.state === "signed-out") return { level: "act", line: t("ux.l2a.tag.signedOut", { engine: engine.label }) };
  if (engine?.state === "missing") return { level: "act", line: t("ux.l2a.tag.missing", { engine: engine.label }) };
  if (engine?.state === "limit" || engine?.state === "off") return { level: "watch", line: t(engine.state === "limit" ? "ux.l2a.tag.limit" : "ux.l2a.tag.off", { engine: engine.label }) };
  if (!engine && !answered) return { level: "unknown", line: t("ux.l2a.health.unknown") };
  return { level: "ok", line: t("ux.l2a.health.ok") };
}

export function useHealthStatus(): HealthStatus {
  const { state } = useStore();
  const reading = useEngineReading();
  return healthFromEngines(reading.engine, reading.flux, reading.fromServer || state.instances.length > 0);
}

export function HealthPage(props: HealthPageProps) {
  return <LazyBoundary onRetry={Body.retry}><Suspense fallback={<LazyFallback />}><Body.Component {...props} /></Suspense></LazyBoundary>;
}
