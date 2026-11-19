// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "How would you like to be notified?" (NOTIFY-EVERYWHERE-1019, section 3.1): one card in the first-run sequence on a new desktop
// install. The contract the first-run step depends on is exactly: `<NotifyChooser onDone onError? />`, where onDone gets
// `{ outcome: "saved" | "kept-inside" }`, plus `shouldShowNotifyChooser` from "@/lib/notify-surfaces". All decisions live in
// "@/lib/notify-chooser"; this file only draws them. No timers and no animation loops: the card rests.
import { useEffect, useId, useState } from "react";
import { t } from "@/lib/i18n";
import { notifySurfacesBridge, type NotifyCapabilities } from "@/lib/notify-surfaces";
import { chooserRows, initialPicks, keepInside, osFamily, saveChooser, type ChooserOutcome, type ChooserRow, type Picks } from "@/lib/notify-chooser";

export interface NotifyChooserProps {
  onDone: (result: ChooserOutcome) => void;
  onError?: (message: string) => void;
}

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const OS_NAME = { mac: "notifyChooser.os.mac", windows: "notifyChooser.os.windows", linux: "notifyChooser.os.linux" } as const;

export function NotifyChooser({ onDone, onError }: NotifyChooserProps) {
  const bridge = notifySurfacesBridge();
  const [rows, setRows] = useState<ChooserRow[] | null>(null);
  const [caps, setCaps] = useState<NotifyCapabilities | null>(null);
  const [picks, setPicks] = useState<Picks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleId = useId();

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void Promise.all([bridge.get(), bridge.capabilities()]).then(([state, capabilities]) => {
      if (!alive) return;
      const list = chooserRows(capabilities);
      setCaps(capabilities); setRows(list); setPicks(initialPicks(state, list));
    }).catch(() => { if (alive) fail(t("notifyChooser.errorLoad")); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fail = (message: string) => { setError(message); onError?.(message); };
  const run = async (action: () => Promise<ChooserOutcome>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { onDone(await action()); } catch { fail(t("notifyChooser.errorSave")); } finally { setBusy(false); }
  };

  if (!bridge) return null;
  if (!rows || !picks || !caps) return <section aria-labelledby={titleId} className="rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id={titleId} className="text-[15px] font-medium text-ink">{t("notifyChooser.title")}</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("notifyChooser.intro")}</p>
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </section>;
  const deps = { bridge, platform: caps.platform };
  const family = osFamily(caps.platform);
  const ticked = rows.filter(row => picks[row.id]).length;
  return <section aria-labelledby={titleId} className="rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id={titleId} className="text-[15px] font-medium text-ink">{t("notifyChooser.title")}</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("notifyChooser.intro")}</p>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("notifyChooser.suits", { osName: t(OS_NAME[family]) })}</p>
    <ul className="mt-3 grid gap-2">
      {rows.map(row => {
        const id = `notify-chooser-${row.id}`;
        const off = !row.available || row.needsSettings || busy;
        return <li key={row.id} className="rounded-lg bg-inset p-3">
          <label htmlFor={id} className="flex min-h-11 items-start gap-3 text-[13px] text-ink">
            <input id={id} type="checkbox" checked={picks[row.id]} disabled={off} aria-describedby={`${id}-note`}
              onChange={event => setPicks({ ...picks, [row.id]: event.target.checked })} className={"mt-1 h-4 w-4 shrink-0 " + focus} />
            <span className="min-w-0"><span className="block font-medium">{t(row.label)}</span>
              <span id={`${id}-note`} className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">
                {t(row.note)}
                {row.reason ? <span className="block">{t("notifyChooser.notHere")} {t(row.reason)}</span> : null}
                {row.needsSettings ? <span className="block">{t("notifyChooser.setInSettings")}</span> : null}
                {row.id === "notify" && family === "linux" ? <span className="block">{t("notifyChooser.linuxLockNote")}</span> : null}
              </span></span>
          </label>
        </li>;
      })}
    </ul>
    <p className="mt-3 text-[11px] leading-relaxed text-ink-secondary">{t("notifyChooser.sharingLine")}</p>
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
      <button type="button" disabled={busy} onClick={() => void run(() => keepInside(deps, rows))}
        className={"min-h-11 rounded-lg border border-hairline/50 bg-control px-3 text-[13px] text-ink disabled:opacity-50 " + focus}>{t("notifyChooser.keepInside")}</button>
      <button type="button" disabled={busy} aria-label={t("notifyChooser.continueCount", { count: ticked })} onClick={() => void run(() => saveChooser(deps, rows, picks))}
        className={"min-h-11 rounded-lg bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-50 " + focus}>{busy ? t("notifyChooser.saving") : t("notifyChooser.continue")}</button>
    </div>
  </section>;
}
