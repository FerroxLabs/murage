// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Bots > Advanced (U4 S1): how many threads one bot works on at once. Empty means the default, which is this computer's
// guard sized from its memory (server/thread-cap.ts). A saved number only ever narrows it. A change applies to the next start.
import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";

export const THREADS_PER_BOT_MIN = 1;
export const THREADS_PER_BOT_MAX = 16;

/** Empty clears the saved number (null); otherwise a whole number from 1 to 16. */
export function parseThreadsPerBot(raw: string): { ok: true; value: number | null } | { ok: false } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false };
  const value = Number(text);
  return value >= THREADS_PER_BOT_MIN && value <= THREADS_PER_BOT_MAX ? { ok: true, value } : { ok: false };
}

export function ThreadsPerBotSetting() {
  const { state, dispatch } = useStore();
  const threads = state.config?.threads;
  const confirmed = threads?.perBot ?? null;
  const [value, setValue] = useState(confirmed === null ? "" : String(confirmed));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!dirty) setValue(confirmed === null ? "" : String(confirmed));
  }, [confirmed, dirty]);

  if (!threads) return null;
  const guard = threads.homeGuard;

  const save = async () => {
    if (!dirty || inFlight.current) return;
    const parsed = parseThreadsPerBot(value);
    if (!parsed.ok) { setError(t("settings.threads.range")); return; }
    inFlight.current = true;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { threadsPerBot: parsed.value } }) });
      dispatch({ type: "configStatus", config });
      setDirty(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.threads.saveFailed"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <Card title={t("settings.threads.title")} subtitle={t("settings.threads.subtitle", { guard })}>
      <div className="flex flex-col gap-2">
        <label htmlFor="threads-per-bot" className="text-[13px] font-medium text-ink">{t("settings.threads.label")}</label>
        <div className={`flex max-w-[220px] items-center rounded-lg border bg-inset ${error ? "border-danger/60" : "border-hairline/40 focus-within:border-hairline"}`}>
          <input
            id="threads-per-bot"
            type="number"
            min={THREADS_PER_BOT_MIN}
            max={THREADS_PER_BOT_MAX}
            step={1}
            inputMode="numeric"
            placeholder={String(guard)}
            value={value}
            disabled={saving}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "threads-per-bot-error threads-per-bot-help" : "threads-per-bot-help"}
            onChange={(event) => { setValue(event.target.value); setDirty(true); setError(""); }}
            onBlur={() => void save()}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[14px] tabular-nums text-ink focus:outline-none"
          />
        </div>
        <p id="threads-per-bot-help" className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.threads.help", { guard })}</p>
        {error ? <p id="threads-per-bot-error" role="alert" className="text-[12px] text-danger">{error}</p> : null}
      </div>
    </Card>
  );
}
