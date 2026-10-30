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
import { HealthCard, healthDestination } from "@/components/HealthCard";
import { useEngineHealthAnswer, useEngineReading } from "@/components/today/use-engine-health";
import { t } from "@/lib/i18n";
import { StatusDot } from "../StatusDot";
import { OpenBotListButton } from "@/components/OpenBotListButton";
import type { EngineHealthRow, FluxHealthState, HealthPageProps, HealthStatus } from "../shell-contract";

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

export function HealthPage(_props: HealthPageProps) {
  const { dispatch } = useStore();
  const server = useEngineHealthAnswer();
  const status = useHealthStatus();
  return (
    <main aria-labelledby="health-page-title" className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app px-6 py-6 text-ink">
      {/* Phones only (OpenBotListButton.tsx): the way back to the rail drawer. */}
      <div className="md:hidden"><OpenBotListButton /></div>
      <h1 id="health-page-title" className="flex items-center gap-2 text-[20px] font-semibold">
        <StatusDot level={status.level} />{t("ux.l2a.health.title")}
      </h1>
      <p role="status" className="mt-1 text-[14px] text-ink-secondary">{status.line}</p>
      {server && server.engines.length > 0 && (
        <ul aria-label={t("ux.l2a.health.engines")} className="mt-4 max-w-2xl divide-y divide-hairline/40 rounded-xl border border-hairline/50 bg-panel">
          {server.engines.map((engine) => (
            <li key={engine.id} className="flex items-center gap-3 px-4 py-3 text-[14px]">
              <StatusDot level={engine.state === "ready" ? "ok" : engine.state === "limit" || engine.state === "off" ? "watch" : "act"} />
              <span className="min-w-0 flex-1"><span className="font-medium">{engine.label}</span><span className="block text-[13px] text-ink-secondary">{engine.line}</span></span>
              {engine.state !== "ready" && (
                <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}
                  className="min-h-11 rounded-lg border border-hairline/50 px-3 text-[13px] font-medium hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {t("ux.l2a.health.openEngines")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 max-w-2xl">
        <HealthCard onNavigate={(action) => { const to = healthDestination(action); if (to) dispatch({ type: "toggleAppSettings", open: true, section: to.section, ...(to.anchor ? { anchor: to.anchor } : {}) }); }} />
      </div>
    </main>
  );
}
