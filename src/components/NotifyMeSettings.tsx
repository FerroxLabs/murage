// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings, "Notify me" (NOTIFY-EVERYWHERE-1019, section 3.3): every surface the chooser offers, as a switch, saved on this
// computer the moment it is flipped (one key per set). What to tell about, quiet hours and previews stay in the server-side
// card above it. Renders nothing in a web build (no bridge).
import { useEffect, useState } from "react";
import { Switch } from "./SettingsPrimitives";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { notifySurfacesBridge, type NotifyCapabilities, type NotifySurfaces } from "@/lib/notify-surfaces";
import { chooserRows, surfacesOnCount } from "@/lib/notify-chooser";
import { resolveNotificationPreferences } from "../../shared/notification-preferences";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
type FlagKey = "notifyActions" | "quietSummary" | "hideFullscreen" | "respectFocus" | "badgeMenu";
const FLAGS: readonly { key: FlagKey; label: Parameters<typeof t>[0]; help: Parameters<typeof t>[0] }[] = [
  { key: "notifyActions", label: "notifyMe.notifyActions", help: "notifyMe.notifyActions.help" },
  { key: "quietSummary", label: "notifyMe.quietSummary", help: "notifyMe.quietSummary.help" },
  { key: "hideFullscreen", label: "notifyMe.hideFullscreen", help: "notifyMe.hideFullscreen.help" },
  { key: "respectFocus", label: "notifyMe.respectFocus", help: "notifyMe.respectFocus.help" },
  { key: "badgeMenu", label: "notifyMe.badgeMenu", help: "notifyMe.badgeMenu.help" },
];

export function NotifyMeSettings() {
  const bridge = notifySurfacesBridge();
  const { state } = useStore();
  const [surfaces, setSurfaces] = useState<NotifySurfaces | null>(null);
  const [caps, setCaps] = useState<NotifyCapabilities | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void Promise.all([bridge.get(), bridge.capabilities()]).then(([s, c]) => { if (alive) { setSurfaces(s); setCaps(c); } }).catch(() => { if (alive) setError(t("notifyMe.errorLoad")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!bridge || !surfaces || !caps) return error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null;

  const change = async (action: () => Promise<NotifySurfaces>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { setSurfaces(await action()); } catch { setError(t("notifyMe.errorSave")); } finally { setBusy(false); }
  };
  const rows = chooserRows(caps, { includePill: true });
  const { on, of } = surfacesOnCount(surfaces, caps);
  const completionOn = resolveNotificationPreferences(state.config?.notifications).completion;
  return <section aria-labelledby="notify-me-title" className="mt-4 rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="notify-me-title" className="text-[15px] font-medium text-ink">{t("notifyMe.title")}</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("notifyMe.intro", { on, of })}</p>
    <ul className="mt-3">
      {rows.map(row => {
        const id = `notify-me-${row.id}`;
        const hidden = row.id === "receipt" && !completionOn;
        return <li key={row.id} className="flex min-h-11 items-start justify-between gap-3 py-1.5 text-[13px] text-ink">
          <span id={id}>{t(row.label)}
            <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">
              {hidden ? t("notifyMe.finishedOff") : t(row.note)}
              {row.reason ? <span className="block">{t("notifyChooser.notHere")} {t(row.reason)}</span> : null}
              {row.needsSettings && surfaces.shortcut ? <span className="block">{t("notifyMe.shortcutSet", { key: surfaces.shortcut })}</span> : null}
            </span></span>
          <Switch aria-labelledby={id} checked={surfaces.surfaces[row.id] === true} disabled={busy || !row.available || hidden || (row.needsSettings && !surfaces.shortcut)}
            onClick={() => void change(() => bridge.set(`surfaces.${row.id}`, surfaces.surfaces[row.id] !== true))} className={focus} />
        </li>;
      })}
    </ul>
    <details className="mt-3 rounded-lg bg-inset p-3">
      <summary className={"min-h-11 cursor-pointer text-[13px] font-medium text-ink " + focus}>{t("notifyMe.advanced")}</summary>
      {FLAGS.map(flag => {
        const id = `notify-me-flag-${flag.key}`;
        return <div key={flag.key} className="flex min-h-11 items-start justify-between gap-3 py-1.5 text-[13px] text-ink">
          <span id={id}>{t(flag.label)}<span className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">{t(flag.help)}</span></span>
          <Switch aria-labelledby={id} checked={surfaces[flag.key] === true} disabled={busy} onClick={() => void change(() => bridge.set(flag.key, surfaces[flag.key] !== true))} className={focus} />
        </div>;
      })}
      <label className="mt-2 block text-[12px] text-ink">{t("notifyMe.receiptMin")}
        <select value={surfaces.receiptMinMinutes} disabled={busy} onChange={event => void change(() => bridge.set("receiptMinMinutes", Number(event.target.value)))}
          className={"mt-1 block min-h-11 w-full rounded-lg border border-hairline/50 bg-control px-2 text-[13px] " + focus}>
          <option value={0}>{t("notifyMe.receiptMin.any")}</option><option value={2}>{t("notifyMe.receiptMin.two")}</option><option value={5}>{t("notifyMe.receiptMin.five")}</option>
        </select>
      </label>
      <label className="mt-2 block text-[12px] text-ink">{t("notifyMe.nudge")}
        <select value={surfaces.nudgeMinutes} disabled={busy} onChange={event => void change(() => bridge.set("nudgeMinutes", Number(event.target.value)))}
          className={"mt-1 block min-h-11 w-full rounded-lg border border-hairline/50 bg-control px-2 text-[13px] " + focus}>
          <option value={5}>{t("notifyMe.nudge.five")}</option><option value={15}>{t("notifyMe.nudge.fifteen")}</option><option value={0}>{t("notifyMe.nudge.never")}</option>
        </select>
      </label>
      <label className="mt-2 block text-[12px] text-ink">{t("notifyMe.badgeCount")}
        <select value={surfaces.badgeCount} disabled={busy} onChange={event => void change(() => bridge.set("badgeCount", event.target.value))}
          className={"mt-1 block min-h-11 w-full rounded-lg border border-hairline/50 bg-control px-2 text-[13px] " + focus}>
          <option value="needs-you">{t("notifyMe.badgeCount.needsYou")}</option><option value="unread">{t("notifyMe.badgeCount.unread")}</option>
        </select>
      </label>
    </details>
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    <div className="mt-3 flex justify-end">
      <button type="button" disabled={busy} onClick={() => void change(() => bridge.reset())}
        className={"min-h-11 rounded-lg border border-hairline/50 bg-control px-3 text-[13px] text-ink disabled:opacity-50 " + focus}>{t("notifyMe.reset")}</button>
    </div>
  </section>;
}
