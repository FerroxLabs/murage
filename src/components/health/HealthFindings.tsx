// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The findings column of the Health page (designs/HEALTH-DOCTOR.md): one card per thing to fix, in the order
// health-findings.ts decides, each with exactly one fix and, where a bot can help, a quiet Ask your bot link.
import { useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import { StatusDot } from "@/components/shell/StatusDot";
import { answersRunning, askYourBot, backUpNow, recheckFlux, switchEngineOn } from "@/lib/health-actions";
import type { BackupScheduleBridge } from "@/components/backups-section-ui";
import type { NextAction } from "../../../shared/sentinel-view";
import type { FindingEntry, HealthFinding } from "./health-findings";
import { settingsPagesHere } from "./health-guide";
import { needButton } from "./HealthNeedCard";
import { HealthFoldRow } from "./HealthIssues";

const askLink = "min-h-10 rounded-md px-1 text-[13px] text-ink-secondary underline underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

/** The backup checks Back up now can clear on this computer (a backup that is not set up yet goes to Backups). */
export const BACKUP_NOW_TITLES: ReadonlySet<string> = new Set(["health.backup.overdue", "health.backup.capture-stalled"]);

/** A quiet link that opens the Chief's chat with the question in the composer, never sent. */
export function AskBotLink({ question }: { question: string }) {
  const { state, dispatch } = useStore();
  if (!state.bots.some((bot) => !bot.hidden)) return null;
  return <button type="button" className={askLink}
    onClick={() => { if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false }); askYourBot(question, state.bots, (id) => dispatch({ type: "select", id })); }}>
    {t("ux.l2a.health.askBot")}
  </button>;
}

/** A button that does the fix and says how it went in one line. */
function DoButton({ label, run }: { label: string; run: () => Promise<string> }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  return <>
    <button type="button" className={needButton} disabled={busy} onClick={() => { setBusy(true); setSaid(null); void run().then(setSaid).finally(() => setBusy(false)); }}>{label}</button>
    {said && <p role="status" className="mt-2 basis-full text-[13px] text-ink-secondary">{said}</p>}
  </>;
}

function FindingCard({ finding, desktop }: { finding: HealthFinding; desktop: boolean | undefined }) {
  const { state, dispatch } = useStore();
  const fix = finding.fix;
  const here = settingsPagesHere(desktop);
  return <li data-health-finding={finding.key}
    className={`rounded-xl border p-4 text-[13px] ${finding.level === "act" ? "border-danger/30 bg-danger/[0.06]" : "border-hairline/50 bg-panel"}`}>
    <p className="flex items-start gap-2 font-medium text-ink"><StatusDot level={finding.level} /><span className="min-w-0">{finding.title}</span></p>
    <p className="mt-1 text-ink-secondary">{finding.matters}</p>
    {/* Pages a go button opens are desktop only: the phone says the step in words instead. */}
    {(fix.kind === "step" || (fix.kind === "go" && !here)) && <p className="mt-2 text-ink">{t(fix.step)}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {fix.kind === "do" && desktop === true && <DoButton label={t("ux.l2a.health.switchOn")} run={() => switchEngineOn(fix.engineId, answersRunning(state), api)} />}
      {fix.kind === "do" && desktop !== true && <p className="text-ink">{t("ux.l2b.health.doc.engineOff.step")}</p>}
      {fix.kind === "go" && here && <button type="button" className={needButton} onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: fix.section })}>
        {t(fix.section === "models" ? "ux.l2b.health.go.flux" : "ux.l2a.health.openEngines")}
      </button>}
      {fix.kind === "step" && fix.then === "flux-recheck" && <DoButton label={t("ux.l2a.health.checkAgain")} run={() => recheckFlux(api)} />}
      {finding.ask && <AskBotLink question={finding.ask} />}
    </div>
  </li>;
}

/** Every finding, in order. A background check keeps its three plain answers (HealthFoldRow) and gains its one-tap fix. */
export function HealthFindingList({ entries, now, onGo, onChanged }: { entries: readonly FindingEntry[]; now: number; onGo: (to: NextAction) => void; onChanged: () => void }) {
  const desktop = useDesktopSurface();
  if (entries.length === 0) return null;
  const bridge = desktop === true ? window.muragebox?.backupSchedule as BackupScheduleBridge | undefined : undefined;
  return <ul aria-label={t("ux.l2a.health.findings")} className="space-y-2">
    {entries.map((entry) => entry.kind === "finding"
      ? <FindingCard key={entry.finding.key} finding={entry.finding} desktop={desktop} />
      : <HealthFoldRow key={entry.fold.titleKey} fold={entry.fold} now={now} onGo={onGo} onChanged={onChanged}
          fix={bridge?.runNow && BACKUP_NOW_TITLES.has(entry.fold.titleKey) ? <DoButton label={t("ux.l2a.health.backUpNow")} run={() => backUpNow(bridge)} /> : undefined}
          extra={entry.fold.titleKey.startsWith("health.extraction.") ? <div className="mt-2"><AskBotLink question={t("ux.l2b.health.ask.extraction")} /></div> : undefined} />)}
  </ul>;
}
