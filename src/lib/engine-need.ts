// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An engine problem as a Needs you item (Sean 11-01): when the Health level is red because of an engine or Flux, Needs
// you must show why, or the dot stands alone. A live reading, so it goes by itself the moment the problem clears.
// An engine that already has its sign-in row (signed-out-engines.ts) is not said twice, and first run owns the screen.
import { t } from "@/lib/i18n";
import type { EngineHealthRow, FluxHealthState } from "@/components/shell/shell-contract";

export interface EngineNeed { key: string; title: string; detail: string; label: string; section: "engines" | "models" }

export function engineNeed(reading: { engine: EngineHealthRow | null; flux: FluxHealthState }, signedOutRows: ReadonlyArray<{ id: string }>, firstRun: boolean): EngineNeed | null {
  if (firstRun) return null;
  const { engine, flux } = reading;
  if (flux === "allowance-used-up") return { key: "flux-used-up", title: t("ux.l2a.tag.fluxUsedUp"), detail: t("ux.l2b.health.need.fluxUsedUp"), label: t("ux.l2b.health.go.flux"), section: "models" };
  if (flux === "key-problem") return { key: "flux-key", title: t("ux.l2a.tag.fluxKey"), detail: t("ux.l2b.health.need.fluxKey"), label: t("ux.l2b.health.go.flux"), section: "models" };
  if (engine?.state === "missing") return { key: `engine:${engine.id}`, title: t("ux.l2a.tag.missing", { engine: engine.label }), detail: t("ux.l2b.health.need.engine"), label: t("ux.l2a.health.openEngines"), section: "engines" };
  if (engine?.state === "signed-out" && !signedOutRows.some((row) => row.id === engine.id)) return { key: `engine:${engine.id}`, title: t("ux.l2a.tag.signedOut", { engine: engine.label }), detail: t("ux.l2b.health.need.engine"), label: t("ux.l2a.health.openEngines"), section: "engines" };
  return null;
}
