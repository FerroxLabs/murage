// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > General > Time zone (1.0.8). The zone every bot works in for
// dates, times and calendar work (server/owner-time-zone.ts). It follows this
// computer until the owner picks one, so it works with no setup; a pick stays
// put when the computer travels. One control: a field that searches the
// zones as you type.
import { useEffect, useMemo, useState } from "react";

import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

export interface OwnerTimeZone {
  timeZone: string;
  chosen: boolean;
  computerTimeZone: string;
  /** False on a Cloud home: its zone is always the owner's pick, there is no computer to follow. Absent means true. */
  canFollowComputer?: boolean;
  /** On a save: false when the zone saved but daily routines' next times could not be written yet (retried before
   *  they run). */
  routinesMoved?: boolean;
}

/** What Enter or leaving the field does with what is typed. Typing a zone and committing it always saves it, the
 *  zone this computer is in included: that pins it before a trip. Leaving the field untouched saves nothing. */
export function commitChoice(draft: string, loaded: OwnerTimeZone, edited: boolean, zones: readonly string[]): { kind: "save"; zone: string } | { kind: "keep"; zone: string } | { kind: "unknown" } {
  const zone = matchZone(draft, zones);
  if (!zone) return { kind: "unknown" };
  if (zone === loaded.timeZone && (loaded.chosen || !edited)) return { kind: "keep", zone };
  return { kind: "save", zone };
}

/** The card's words and controls for a loaded state: a Cloud home has no computer to follow, so it never offers to. */
export function timeZoneView(loaded: OwnerTimeZone | null): { note: "settings.timeZone.note" | "settings.timeZone.noteHome"; line: "settings.timeZone.chosen" | "settings.timeZone.following" | "settings.timeZone.home"; offerFollow: boolean } {
  const home = loaded?.canFollowComputer === false;
  return {
    note: home ? "settings.timeZone.noteHome" : "settings.timeZone.note",
    line: home ? "settings.timeZone.home" : loaded?.chosen ? "settings.timeZone.chosen" : "settings.timeZone.following",
    offerFollow: !home && loaded?.chosen === true,
  };
}

/** Every zone this runtime knows, UTC included. */
export function zoneChoices(): string[] {
  let zones: string[] = [];
  try { zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { zones = []; }
  return zones.includes("UTC") ? zones : [...zones, "UTC"];
}

/** The zone a typed value means: an exact name in any case, or the one zone
 *  whose city matches ("chicago", "new york"). Null when it names none or several. */
export function matchZone(input: string, zones: readonly string[]): string | null {
  const wanted = input.trim().toLowerCase().replace(/\s+/g, "_");
  if (!wanted) return null;
  const exact = zones.find((zone) => zone.toLowerCase() === wanted);
  if (exact) return exact;
  const byCity = zones.filter((zone) => zone.toLowerCase().split("/").pop() === wanted);
  return byCity.length === 1 ? byCity[0]! : null;
}

/** "3:40 pm, UTC-05:00" in that zone, for the line under the field. */
export function zoneNow(timeZone: string, at: Date = new Date()): string {
  try {
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(at).toLowerCase();
    const offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    return `${time}, ${offset.replace("GMT", "UTC") || "UTC"}`;
  } catch {
    return "";
  }
}

const BUTTON = "min-h-9 rounded-lg px-3 py-1.5 text-[12.5px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";

export function TimeZoneSettings() {
  const zones = useMemo(zoneChoices, []);
  const [loaded, setLoaded] = useState<OwnerTimeZone | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    (api("/api/owner/timezone") as Promise<OwnerTimeZone>)
      .then((state) => { if (live) { setLoaded(state); setDraft(state.timeZone); } })
      .catch(() => { if (live) setLoadError(t("settings.timeZone.loadError")); });
    return () => { live = false; };
  }, []);

  const save = async (timeZone: string | null) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const state = (await api("/api/owner/timezone", { method: "PUT", body: JSON.stringify({ timeZone }) })) as OwnerTimeZone;
      setLoaded(state);
      setDraft(state.timeZone);
      setEdited(false);
      setNotice(t(state.routinesMoved === false ? "settings.timeZone.savedRoutinesPending" : "settings.timeZone.saved"));
    } catch {
      setError(t("settings.timeZone.saveError"));
    } finally {
      setBusy(false);
    }
  };

  const commit = () => {
    if (!loaded) return;
    const choice = commitChoice(draft, loaded, edited, zones);
    if (choice.kind === "unknown") { setError(t("settings.timeZone.unknown")); return; }
    if (choice.kind === "keep") { setDraft(choice.zone); setEdited(false); setError(""); return; }
    void save(choice.zone);
  };

  const view = timeZoneView(loaded);
  return (
    <Card title={t("settings.timeZone.title")} subtitle={t(view.note)}>
      {loadError && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{loadError}</div>}
      {!loaded && !loadError && <p className="text-[12.5px] text-ink-secondary">{t("settings.timeZone.loading")}</p>}
      {loaded && (
        <div className="flex flex-col gap-2">
          <input
            type="search"
            list="owner-time-zones"
            aria-label={t("settings.timeZone.label")}
            placeholder={t("settings.timeZone.placeholder")}
            value={draft}
            disabled={busy}
            onChange={(event) => { setDraft(event.target.value); setEdited(true); setError(""); setNotice(""); }}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}
            className="w-full max-w-[360px] rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <datalist id="owner-time-zones">
            {zones.map((zone) => <option key={zone} value={zone} />)}
          </datalist>
          <p className="text-[12px] text-ink-secondary">
            {t(view.line, { zone: loaded.timeZone, now: zoneNow(loaded.timeZone) })}
          </p>
          {view.offerFollow && (
            <div>
              <button type="button" disabled={busy} onClick={() => void save(null)} className={`${BUTTON} bg-control text-ink`}>
                {t("settings.timeZone.follow", { zone: loaded.computerTimeZone })}
              </button>
            </div>
          )}
          {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
          {notice && !error && <p role="status" className="text-[12px] text-ink-secondary">{notice}</p>}
        </div>
      )}
    </Card>
  );
}
