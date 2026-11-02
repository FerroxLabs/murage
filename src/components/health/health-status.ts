// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Health level (Sean 10-30, 11-01), for the dot on the You menu and your name, Today's tag, and the Health screen.
// It reads the engines and the level the owner's Inbox read carries, so it adds no poll of its own. Red means the owner
// must act, and then Needs you has the item. A note that needs nothing adds no colour at all.
import { useStore } from "@/state/store";
import { useEngineReading } from "@/components/today/use-engine-health";
import { t } from "@/lib/i18n";
import type { HealthIssueLevel } from "../../../shared/health-levels";
import type { EngineHealthRow, FluxHealthState, HealthStatus } from "@/components/shell/shell-contract";

/** The level from the engine reading alone: a signed-out or missing engine, or Flux used up, is the owner's to fix. */
export function healthFromEngines(engine: EngineHealthRow | null, flux: FluxHealthState, answered: boolean): HealthStatus {
  if (flux === "allowance-used-up") return { level: "act", line: t("ux.l2a.tag.fluxUsedUp") };
  if (flux === "key-problem") return { level: "act", line: t("ux.l2a.tag.fluxKey") };
  if (engine?.state === "signed-out") return { level: "act", line: t("ux.l2a.tag.signedOut", { engine: engine.label }) };
  if (engine?.state === "missing") return { level: "act", line: t("ux.l2a.tag.missing", { engine: engine.label }) };
  if (engine?.state === "limit" || engine?.state === "off") return { level: "watch", line: t(engine.state === "limit" ? "ux.l2a.tag.limit" : "ux.l2a.tag.off", { engine: engine.label }) };
  if (engine?.state === "checking") return { level: "unknown", line: t("ux.l2a.tag.checking", { engine: engine.label }) };
  if (!engine && !answered) return { level: "unknown", line: t("ux.l2a.health.unknown") };
  return { level: "ok", line: t("ux.l2a.health.ok") };
}

/** The engines and the checks together. An engine's own words win at the same level; a note leaves the level alone. */
export function healthWithChecks(engines: HealthStatus, checks: HealthIssueLevel | null | undefined): HealthStatus {
  if (engines.level === "act") return engines;
  if (checks === "act") return { level: "act", line: t("ux.l2b.health.lineAct") };
  if (engines.level === "watch") return engines;
  if (checks === "watch") return { level: "watch", line: t("ux.l2b.health.lineWatch") };
  return engines;
}

/** `checks`: the level from the owner's Inbox read (NeedsSummary.healthLevel); absent on a read that did not prove the owner. */
export function useHealthStatus(checks?: HealthIssueLevel | null): HealthStatus {
  const { state } = useStore();
  const reading = useEngineReading();
  return healthWithChecks(healthFromEngines(reading.engine, reading.flux, reading.fromServer || state.instances.length > 0), checks);
}
