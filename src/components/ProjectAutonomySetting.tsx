// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useState } from "react";
import { Switch } from "./SettingsPrimitives";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { projectSurfaceEnabled } from "@/lib/project-client";
export function ProjectAutonomySetting() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  if (!projectSurfaceEnabled(state.config)) return null;
  const enabled = state.config?.features?.projectsAutonomy === true;
  async function toggle(flag: "projectsAutonomy" | "projectsParallelCards" = "projectsAutonomy") {
    if (saving) return;
    setSaving(true); setReason(null);
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { [flag]: !(flag === "projectsAutonomy" ? enabled : state.config?.features?.projectsParallelCards !== false) } }) });
      dispatch({ type: "configStatus", config });
    } catch (error) { setReason(error instanceof Error ? error.message : t("projects.autonomy.saveFailed")); }
    finally { setSaving(false); }
  }
  return <section className="rounded-xl border border-hairline/40 p-4">
    <div className="flex min-h-11 items-center justify-between gap-3 text-[14px] text-ink">
      <span id="projects-autonomy-label">{t("projects.autonomy.label")}</span>
      <Switch aria-labelledby="projects-autonomy-label" checked={enabled} disabled={saving} onClick={() => void toggle()} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
    </div>
    <p className="text-[12px] text-ink-secondary">{t("projects.autonomy.hint")}</p>
    <div className="flex min-h-11 items-center justify-between gap-3 text-[14px] text-ink">
      <span aria-hidden="true">{t("projects.autonomy.parallel")}</span>
      <Switch aria-label={t("projects.autonomy.parallel")} checked={state.config?.features?.projectsParallelCards !== false} disabled={saving} onClick={() => void toggle("projectsParallelCards")} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
    </div>
    <p className="text-[12px] text-ink-secondary">{t("projects.autonomy.parallelHint")}</p>
    {reason && <p role="status" className="text-[13px] text-ink-secondary">{reason}</p>}
  </section>;
}
