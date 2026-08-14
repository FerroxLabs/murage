// Voice, in App Settings.
//
// The provider list comes from the harness so this panel never has to know
// which voices exist — same reason the model picker reads /api/instances
// rather than hardcoding a fleet. Picking a provider is free; a hosted one
// stays inert (and says so) until its key is accepted, and until then the
// local voice keeps speaking rather than the app going quiet.
import { useEffect, useState } from "react";
import { Check, Loader2, Volume2 } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { listLocalVoices, speaker, type LocalVoice } from "@/lib/tts";
import { useLocalVoiceProgress } from "@/lib/tts/useSpeech";
import { cn } from "@/lib/cn";

const SAMPLE = "Morning. Overnight the tests went green, and I left two notes for you in the thread.";

export function VoiceSettings() {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;
  const download = useLocalVoiceProgress();

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<LocalVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  const providerId = tts?.provider ?? "kokoro";
  const provider = tts?.providers.find((p) => p.id === providerId);
  const local = provider?.runsOn === "client";
  // a hosted provider chosen but not yet keyed is not the one that speaks
  const inert = Boolean(provider?.needsKey) && !tts?.configured;

  // Local voices are metadata and resolve instantly; hosted ones are a
  // round trip through the harness, which holds the key.
  useEffect(() => {
    let alive = true;
    if (local) {
      setVoices(listLocalVoices());
      return;
    }
    if (inert) {
      setVoices([]);
      return;
    }
    setLoadingVoices(true);
    api("/api/tts/voices")
      .then((r: { voices?: LocalVoice[]; error?: string }) => {
        if (!alive) return;
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setLoadingVoices(false));
    return () => {
      alive = false;
    };
  }, [local, inert, providerId, tts?.configured]);

  const save = (patch: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    return api("/api/config", { method: "PUT", body: JSON.stringify({ tts: patch }) })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKey("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  if (!tts) return null;

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Voice</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Used by the speaker button on any message, per-bot auto-speak, and calls.
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {tts.providers.map((p) => (
          <button
            key={p.id}
            onClick={() => void save({ provider: p.id, voice: "" })}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-left transition-colors",
              p.id === providerId
                ? "border-accent/60 bg-raised/60"
                : "border-hairline/40 hover:bg-raised/40",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  p.id === tts.effectiveProvider ? "bg-success" : "bg-raised-hover",
                )}
              />
              <span className="text-[14px] text-ink">{p.displayName}</span>
              {!p.needsKey && (
                <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
                  Free
                </span>
              )}
            </div>
            <div className="mt-0.5 pl-3.5 text-[12px] leading-[1.45] text-ink-secondary">{p.blurb}</div>
          </button>
        ))}
      </div>

      {provider?.needsKey && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
            <span className={cn("size-1.5 rounded-full", tts.configured ? "bg-success" : "bg-raised-hover")} />
            <span>{provider.displayName} key</span>
            {tts.configured && <span className="text-[11px] text-success">Connected</span>}
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && void save({ provider: providerId, key: key.trim() })}
              placeholder={tts.configured ? "••••••••  (paste to replace)" : "Paste your API key"}
              aria-label={`${provider.displayName} key`}
              autoComplete="off"
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              onClick={() => key.trim() && void save({ provider: providerId, key: key.trim() })}
              disabled={saving || !key.trim()}
              className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
            </button>
          </div>
          {inert && (
            <div className="mt-1.5 text-[12px] text-warning">
              Until this key is saved, the local voice does the speaking.
            </div>
          )}
        </div>
      )}

      {(voices.length > 0 || loadingVoices) && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">Voice</div>
          <div className="flex gap-2">
            <select
              value={tts.voice}
              onChange={(e) => void save({ voice: e.target.value })}
              aria-label="Voice"
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
            >
              <option value="">{loadingVoices ? "Loading voices…" : "Default"}</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.description ? ` — ${v.description}` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => void speaker.speak(SAMPLE)}
              title="Hear this voice"
              aria-label="Hear this voice"
              className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              <Volume2 size={14} /> Try
            </button>
          </div>
        </div>
      )}

      {local && download?.status === "downloading" && (
        <div className="mt-3 text-[12px] text-ink-secondary">
          Downloading the voice… {download.percent}% — one time, then it works offline.
        </div>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
