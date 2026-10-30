// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The body of L2A's Health stand-in (health-stub.tsx), loaded on first use so
// the Health card stays out of the first paint (scripts/check-bundle-budget.mjs).
import { useStore } from "@/state/store";
import { HealthCard, healthDestination } from "@/components/HealthCard";
import { useEngineHealthAnswer } from "@/components/today/use-engine-health";
import { t } from "@/lib/i18n";
import { StatusDot } from "../StatusDot";
import { OpenBotListButton } from "@/components/OpenBotListButton";
import type { HealthPageProps } from "../shell-contract";
import { useHealthStatus } from "./health-stub";

export function HealthPageBody(_props: HealthPageProps) {
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
