// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rows moved out of SettingsModal.tsx by the Settings page builders (1.0.19); behavior unchanged.
import { copyVersionText } from "@/lib/about-version";
import { openKeyboardShortcuts,openWhatsNew } from "@/lib/app-events";
import { cloudCardHidden } from "@/lib/cloud-settings";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { UpdateActionButton, updatesStatusLine } from "../../SettingsModal";
import { sourceCodeLink,sourceVersionLabel } from "@/lib/source-code";
import { useUpdaterState } from "@/lib/updater";
import { useDesktopSurface } from "@/lib/use-surface";
import { APP_VERSION, changelogUrl } from "@/lib/whats-new";
import { useStore } from "@/state/store";
import { useState } from "react";
import { Card } from "../../SettingsPrimitives";
import { ComputerOnlyStub } from "../../SettingsStub";

/** Health in Settings: one quiet line to the Health screen, the one place issues are shown. */
export function SettingsHealthRow() {
  const { dispatch } = useStore();
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline/50 bg-panel p-4 text-[13px]">
    <div className="min-w-0"><h2 className="text-[15px] font-semibold text-ink">{t("ux.l2a.health.title")}</h2><p className="mt-1 text-ink-secondary">{t("ux.l2b.health.settingsLine")}</p></div>
    <button type="button" data-setting-control="health-heading" className="min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" onClick={() => dispatch({ type: "showHealth" })}>{t("ux.l2b.health.openHealth")}</button>
  </div>;
}

/** Writes a redacted diagnostics file to a location the user picks. The
 * report holds versions, configured-or-not booleans and the server.log tail —
 * never credential values (the desktop shell does not read secret fields). */
export function DiagnosticsRow() {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const bridge = typeof window === "undefined" ? undefined : window.muragebox;

  const exportDiagnostics = async () => {
    if (!bridge?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await bridge.exportDiagnostics();
      if (path) setResult({ kind: "success", message: `Saved to ${path}` });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  if (!bridge?.exportDiagnostics) return <ComputerOnlyStub anchor="diagnostics-heading" />;

  return (
    <Card
      title="Diagnostics"
      subtitle="Versions, configuration on/off state and a redacted server log tail. Review the file before sharing it."
    >
      <div className="flex min-w-0 flex-col items-end gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          data-setting-control="diagnostics-heading" aria-label="Export diagnostics to a text file"
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {exporting ? "Exporting…" : "Export Diagnostics…"}
        </button>
        {result ? (
          <span
            role={result.kind === "error" ? "alert" : "status"}
            className={`max-w-64 break-all text-right text-[12px] ${result.kind === "error" ? "text-danger" : "text-success"}`}
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

/** The version row inside Version and updates: which Murage this is and a line to paste into a support message. The release date
 * is left out: no build records one the app can read, and a guessed date would be worse than none. */
const secondaryButton = "min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function AboutVersionCard() {
  const s = useUpdaterState();
  const desktop = useDesktopSurface();
  const { dispatch } = useStore();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const version = s?.currentVersion || APP_VERSION;
  const copy = () => {
    const line = copyVersionText(version, window.muragebox?.platform, window.muragebox?.arch);
    void copyText(line).then((ok) => {
      setCopyFailed(!ok);
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <section className="space-y-3" aria-label={t("settings.l1.card.about.version")}>
      <p className="select-text text-[13px] font-medium text-ink">{t("settings.about.versionTitle", { version })}</p>
      <div className="flex flex-wrap items-center gap-2">
        {desktop === true && (
          <button
            type="button"
            onClick={() => {
              dispatch({ type: "toggleAppSettings", open: false });
              openWhatsNew();
            }}
            className={secondaryButton}
          >
            {t("settings.about.whatsNewOpen")}
          </button>
        )}
        <button type="button" data-setting-control="about-version-heading" onClick={copy} className={secondaryButton}>
          {copyFailed ? t("copy.failed") : copied ? t("settings.about.versionCopied") : t("settings.about.versionCopy")}
        </button>
      </div>
      <span role="status" className="sr-only">{copied ? t("settings.about.versionCopied") : ""}</span>
    </section>
  );
}

/** Opens the page What's new showed after the last update. */
export function WhatsNewRow() {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  if (desktop !== true) return (
    <Card title={t("settings.about.whatsNewTitle")} subtitle={t("settings.about.whatsNewNote")}>
      <p className="mb-3 text-[13px] text-ink">{t("settings.about.versionTitle", { version: APP_VERSION })}</p>
      {/* One literal mark per card (settings-card-registry test): the desktop button below carries it; this link spreads the same attribute. */}
      <a {...{ "data-setting-control": "whats-new-heading" }} href={changelogUrl()} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center ${secondaryButton}`}>
        {t("settings.about.whatsNewOpen")}
      </a>
    </Card>
  );
  return (
    <Card title={t("settings.about.whatsNewTitle")} subtitle={t("settings.about.whatsNewNote")}>
      <button
        data-setting-control="whats-new-heading"
        type="button"
        onClick={() => {
          dispatch({ type: "toggleAppSettings", open: false });
          openWhatsNew();
        }}
        className="min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {t("settings.about.whatsNewOpen")}
      </button>
    </Card>
  );
}

/** The source offer the GNU AGPL (section 13) asks for. Shown on every
 * surface, the browser door included: whoever uses Murage over a network is
 * told where the source of this version is. */
export function SourceCodeRow() {
  return (
    <section className="space-y-2 pt-4" aria-label={t("settings.about.sourceTitle")}>
      <p className="text-[13px] text-ink-secondary">{sourceVersionLabel(APP_VERSION)}.</p>
      <a
        href={sourceCodeLink()}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {t("settings.about.sourceOpen")}
      </a>
    </section>
  );
}

export function ShortcutsRow() {
  const { dispatch } = useStore();
  return (
    <Card title={t("settings.about.shortcutsTitle")} subtitle={t("settings.about.shortcutsNote")}>
      <button
        data-setting-control="shortcuts-heading"
        type="button"
        onClick={() => {
          dispatch({ type: "toggleAppSettings", open: false });
          openKeyboardShortcuts();
        }}
        className="min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {t("settings.about.shortcutsOpen")}
      </button>
    </Card>
  );
}

/** The update row inside Version and updates: where the update stands and the one action. A Cloud window has no updater, so it
 *  shows the this-computer stub (S1). */
export function UpdatesCard() {
  const s = useUpdaterState();
  return (
    <section className="space-y-3" aria-label={t("settings.l1.card.about.updates")}>
      {typeof window !== "undefined" && window.muragebox?.updater && <p className="text-[13px] text-ink-secondary">{updatesStatusLine(s)}</p>}
      {typeof window === "undefined" || !window.muragebox?.updater ? <ComputerOnlyStub anchor="updates-heading" inline /> : cloudCardHidden("updates-heading") ? <ComputerOnlyStub anchor="updates-heading" inline /> : <UpdateActionButton state={s} />}
    </section>
  );
}
