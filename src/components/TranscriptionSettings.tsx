import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { showOwnTranscriptionKey } from "@/lib/own-transcription-key";
import { TRANSCRIPTION_STATUS_EVENT, announceTranscriptionStatus } from "@/lib/transcription-status";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

function useTranscriptionKey() {
  const bridge = typeof window === "undefined" ? undefined : window.muragebox?.transcription;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearing = configured === true && !value.trim();

  useEffect(() => {
    let alive = true;
    bridge?.status()
      .then((status) => alive && setConfigured(status.configured))
      .catch(() => alive && setConfigured(false));
    return () => { alive = false; };
  }, [bridge]);

  const save = async () => {
    if (!bridge || saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    try {
      const status = await bridge.setKey(value.trim());
      setConfigured(status.configured);
      setValue("");
      announceTranscriptionStatus(status.configured);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return { bridge, configured, value, setValue, saving, error, clearing, save };
}

/** The voice card on Search, images and dictation: where transcription stands. It names no vendor and asks for no key
 *  (Sean 11-06); a key saved by an older version is its own Advanced card (OwnTranscriptionKeyCard), shown only when used. */
export function VoiceNotesStatus({ route }: { route?: string | null }) {
  // /api/config -> tts.describeVoice -> describeVoiceRoutes uses the same
  // connection selection as POST /api/voice/transcribe. This is configuration,
  // not a health probe; tts.ready describes speech OUT, not transcription.
  const service = route === "flux" ? "Flux" : route === "groq" ? "Groq" : route === "openai" ? "OpenAI" : null;
  return <section className="mb-4 space-y-1.5 border-b border-hairline/40 pb-4">
    <h3 className="text-[13px] font-medium text-ink">{t("settings.l4.voiceNotes.title")}</h3>
    <p role="status" className="text-[12px] leading-relaxed text-ink-secondary">
      {service ? t("settings.l4.voiceNotes.configured", { service }) : route === null ? t("settings.l4.voiceNotes.notConfigured") : t("settings.l4.voiceNotes.unknown")}
    </p>
    <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.l4.voiceNotes.attachments")}</p>
  </section>;
}

export function TranscriptionSettings() {
  const { state } = useStore();
  return <div data-setting-control="voice-settings-heading" tabIndex={-1} className="outline-none"><VoiceNotesStatus route={state.config?.tts?.routes?.transcribe} /></div>;
}

/** Whether a key is saved in this computer's protected store; follows Save and Clear. Null until known. */
function useTranscriptionKeySaved(): boolean | null {
  const bridge = typeof window === "undefined" ? undefined : window.muragebox?.transcription;
  const [saved, setSaved] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const onStatus = (event: CustomEvent<{ configured: boolean }>) => setSaved(event.detail.configured);
    window.addEventListener(TRANSCRIPTION_STATUS_EVENT, onStatus);
    bridge?.status()
      .then((status) => alive && setSaved(status.configured))
      .catch(() => alive && setSaved(false));
    return () => { alive = false; window.removeEventListener(TRANSCRIPTION_STATUS_EVENT, onStatus); };
  }, [bridge]);
  return saved;
}

/** The Advanced card on Search, images and dictation. Renders nothing unless a key saved earlier is in use. */
export function OwnTranscriptionKeyCard() {
  const { state } = useStore();
  return <OwnTranscriptionKey route={state.config?.tts?.routes?.transcribe} keySaved={useTranscriptionKeySaved()} />;
}

/** Nothing when Flux or any engine transcribes, while unknown, or with no saved key; otherwise the plain field. The stored
 *  key is never touched here; only the person's own Clear removes it. */
export function OwnTranscriptionKey({ route, keySaved }: { route?: string | null; keySaved: boolean | null }) {
  return showOwnTranscriptionKey(route, keySaved) ? <OwnTranscriptionKeyField /> : null;
}

function OwnTranscriptionKeyField() {
  const { bridge, configured, value, setValue, saving, error, clearing, save } = useTranscriptionKey();
  return (
    <div tabIndex={-1} className="rounded-xl bg-card p-4 outline-none">
      <div className="mb-2 text-[15px] font-medium text-ink">Your own transcription key, optional</div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void save()}
          placeholder="••••••••  (paste to replace)"
          data-setting-control="voice-key-heading"
          aria-label="Your own transcription key"
          autoComplete="off"
          disabled={!bridge}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!bridge || saving || (!value.trim() && !configured)}
          title={clearing ? "Remove the saved key" : "Save"}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50",
            clearing ? "text-danger" : "text-ink",
          )}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? "Clear" : <><Check size={13} />Save</>}
        </button>
      </div>
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
