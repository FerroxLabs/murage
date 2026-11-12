import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { announceTranscriptionStatus } from "@/lib/transcription-status";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

function useTranscriptionKey() {
  const bridge = window.muragebox?.transcription;
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

/** The voice card on Search, images and dictation: where transcription stands, and where its key lives. The key itself is
 *  one field on the Skills page (TranscriptionKey), next to Teach a skill, and is mounted nowhere else. */
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
  const { configured } = useTranscriptionKey();
  const { state, dispatch } = useStore();
  return (
    <div>
      <VoiceNotesStatus route={state.config?.tts?.routes?.transcribe} />
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>AssemblyAI transcription</span>
        {configured && <span className="text-[11px] text-success">Connected</span>}
      </div>
      <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
        Live narration for recorded skills. Audio is sent to AssemblyAI while recording; the API key is protected by your operating system.
      </p>
      <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
        {configured ? t("settings.l4.voiceKey.change") : t("settings.l4.voiceKey.where")}
        {" "}
        <button
          type="button"
          data-setting-control="voice-settings-heading"
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "skills", anchor: "voice-key-heading" })}
          className="font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {t("settings.l4.voiceKey.open")}
        </button>
      </p>
    </div>
  );
}

/** The one AssemblyAI key field (Skills page, next to Teach a skill). Same credential and the same Save, Clear and Enter
 *  behaviour as before; it only moved. */
export function TranscriptionKey() {
  const { bridge, configured, value, setValue, saving, error, clearing, save } = useTranscriptionKey();
  return (
    <div tabIndex={-1} className="rounded-xl bg-card p-4 outline-none">
      <div className="mb-2 text-[15px] font-medium text-ink">{t("settings.l4.voiceKey.title")}</div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void save()}
          placeholder={configured ? "••••••••  (paste to replace)" : "Paste your AssemblyAI API key"}
          data-setting-control="voice-key-heading"
          aria-label="AssemblyAI API key"
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
      <a
        href="https://www.assemblyai.com/dashboard"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
      >
        Open AssemblyAI dashboard <ExternalLink size={12} />
      </a>
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
      {!bridge && <div className="mt-1 text-[12px] text-warning">Available in the installed desktop app.</div>}
    </div>
  );
}
