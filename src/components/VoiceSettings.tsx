// Per-bot voice profile. The key is shared; the voice and autoplay choice
// belong to the selected bot.
//
// The voice list comes from the harness, which holds the key; the
// renderer never talks to ElevenLabs itself.
import { useEffect, useState } from "react";
import { Check, Loader2, Square, Volume2 } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { cn } from "@/lib/cn";
import { Switch } from "./SettingsPrimitives";
import { tryButtonState, VoiceOptions, type PickerVoice } from "./VoiceOptions";
import { useBotSettingsDraft } from "./bot-settings-drafts";
import { systemVoiceOffer } from "../../shared/system-voices";

const SAMPLE = "Morning. Overnight the tests went green, and I left two notes for you in the thread.";

export function VoiceSettings({
  bot,
  onPatch,
}: {
  bot: Bot;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "voiceProvider" | "speakReplies">>) => void;
}) {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const switching = false;
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<PickerVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  useBotSettingsDraft("Voice settings", Boolean(key.trim()), saving || switching);

  const { capabilities } = useDesktopCapabilities();
  // Built-in voices are offered where the desktop contract says they exist,
  // never inferred from a user agent. The list of such platforms is shared
  // with the harness (shared/system-voices.ts): this gate said "darwin" while
  // the harness had been driving Windows' System.Speech for releases, so a
  // Windows owner could not switch on an engine that already worked.
  const hostPlatform = capabilities.host.platform;
  // Each bot picks its own voice service; without a choice it uses the
  // workspace's. So a room of bots can mix xAI, OpenAI and ElevenLabs.
  const provider = bot.voiceProvider ?? tts?.provider ?? "elevenlabs";
  const xaiAvailable = Boolean(tts?.available?.xai);
  // xAI's voices are in the Flux list; their own engine is for an owner
  // with an xAI key of their own, or a bot already saved on it.
  const xaiKey = Boolean(tts?.xaiKey);
  // Hosted voices: Flux, or the owner's own OpenAI key (same voices).
  const hostedVia = tts?.routes?.speech ?? null;
  const fluxAvailable = Boolean(hostedVia);
  const hostedLabel = hostedVia === "openai" ? "OpenAI" : "Flux";
  // Gate AND wording come from the shared module, which is where they can be
  // executed by a test: a node-environment suite cannot render this component,
  // so a rule written inline here could only ever be checked by grepping the
  // file for a string. shared/system-voices.test.ts runs this instead.
  const offer = systemVoiceOffer(hostPlatform, provider);
  const systemVoicesAvailable = offer.available;
  // whether THIS bot's service can speak (the workspace's `configured`
  // describes the workspace's own service)
  const configured =
    provider === "flux" ? fluxAvailable : provider === "xai" ? xaiAvailable : provider === "system" ? systemVoicesAvailable : Boolean(tts?.available?.elevenlabs ?? tts?.configured);

  useEffect(() => {
    if (!configured) {
      setVoices([]);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    api(`/api/tts/voices?provider=${provider}`)
      .then((r: { voices?: typeof voices; error?: string }) => {
        if (!alive) return;
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setLoadingVoices(false));
    return () => {
      alive = false;
    };
  }, [configured, provider]);

  const setProvider = (next: "flux" | "xai" | "elevenlabs" | "system") => {
    if (next === provider || switching || (next === "system" && !systemVoicesAvailable) || (next === "flux" && !fluxAvailable) || (next === "xai" && !xaiAvailable)) return;
    setError(null);
    // this bot's choice, saved on the bot; its old voice belonged to
    // the other service, so it is cleared and the new service's default
    // speaks until one is picked
    onPatch({ voiceProvider: next, voice: "" });
  };

  const saveKey = () => {
    const nextKey = key.trim();
    if (!nextKey) return Promise.resolve();
    setSaving(true);
    setError(null);
    const request = window.muragebox?.setCredential
      ? window.muragebox.setCredential("ttsKey", nextKey)
      : api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { key: nextKey } }) });
    return request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKey("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  if (!tts) return null;

  const selectedVoice = bot.voice ?? "";
  const ready = configured && Boolean(selectedVoice || tts.voice);
  // Try gives feedback: Loading while the clip is made, Stop while it plays.
  const speech = useSpeech();
  const previewId = `voice-preview:${bot.id}`;
  const [tried, setTried] = useState(false);
  const previewStatus = speech.messageId === previewId ? speech.status : "idle";
  const previewing = previewStatus !== "idle";
  // A failed clip resets the speaker without saying whose it was, so the
  // error shows only after this button was the last thing pressed.
  const previewError = tried && speech.status === "idle" ? speech.error : undefined;

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Voice</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Give this bot a voice for calls and spoken replies. Each bot has its own voice;
        {offer.sentence}
      </div>

      {(fluxAvailable || xaiAvailable || provider === "flux" || provider === "xai" || systemVoicesAvailable || provider === "system") && (
        <div className="mt-4">
          <div className="mb-2 text-[13px] text-ink-secondary">Voice engine</div>
          <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label="Voice engine">
            {([
              { value: "flux", label: hostedLabel, available: fluxAvailable, hint: "Add a Flux key, or an OpenAI key, in Settings to use these voices." },
              { value: "xai", label: "xAI", available: xaiAvailable, hint: "Connect an xAI key in Settings, Models, to use xAI's voices." },
              { value: "elevenlabs", label: "ElevenLabs", available: true, hint: undefined },
              { value: "system", label: offer.label, available: offer.available, hint: offer.unavailableHint },
            ] as const)
              .filter((option) => (option.value !== "system" || systemVoicesAvailable || provider === "system") && (option.value !== "xai" || xaiKey || provider === "xai"))
              .map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={provider === option.value}
                disabled={switching || !option.available}
                title={!option.available ? option.hint : undefined}
                onClick={() => setProvider(option.value)}
                className={cn(
                  "rounded-lg px-3.5 py-1.5 text-[12.5px] transition-colors disabled:opacity-50",
                  provider === option.value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {provider === "flux" && (
        <div className="mt-3 text-[12.5px] text-ink-secondary">
          {fluxAvailable
            ? hostedVia === "openai"
              ? "Speaks through your own OpenAI key, billed by OpenAI. No other key needed."
              : "Speaks through your Flux account, billed per character. No other key needed."
            : "Add a Flux key, or an OpenAI key, in Settings to use these voices."}
        </div>
      )}

      {provider === "xai" && (
        <div className="mt-3 text-[12.5px] text-ink-secondary">
          {xaiKey
            ? "Speaks with xAI's voices through your own xAI key, billed by xAI. 28 voices."
            : xaiAvailable
              ? "Speaks with xAI's voices through your Flux account. They are also in the Flux list."
              : "Connect an xAI key in Settings, Models, to use xAI's voices."}
        </div>
      )}

      {provider === "elevenlabs" && (
        <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span>ElevenLabs key</span>
          {configured && <span className="text-[11px] text-success">Connected</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
            placeholder={configured ? "••••••••  (paste to replace)" : "Paste your ElevenLabs API key"}
            aria-label="ElevenLabs key"
            autoComplete="off"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <button
            onClick={() => void saveKey()}
            disabled={saving || !key.trim()}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
          </button>
        </div>
        {!configured && (
          <a
            href="https://elevenlabs.io/app/settings/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-block text-[12px] font-medium text-accent hover:underline"
          >
            Get a key from ElevenLabs
          </a>
        )}
        </div>
      )}

      {configured && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">Voice</div>
          <div className="flex gap-2">
            <select
              value={selectedVoice}
              onChange={(e) => onPatch({ voice: e.target.value })}
              aria-label={`${bot.name}'s voice`}
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
            >
              <option value="">
                {loadingVoices
                  ? "Loading voices…"
                  : tts.voice
                    ? "Workspace default"
                    : "Pick a voice"}
              </option>
              {selectedVoice && !voices.some((voice) => voice.id === selectedVoice) && (
                <option value={selectedVoice}>Current voice</option>
              )}
              <VoiceOptions voices={voices} />
            </select>
            <button
              onClick={() => { if (previewing) { speaker.stop(); return; } setTried(true); void speaker.speak(SAMPLE, { voiceId: bot.voice, botId: bot.id, messageId: previewId }); }}
              disabled={!ready}
              title={!ready ? "Pick a voice first" : previewing ? "Stop" : "Hear this voice"}
              aria-label={tryButtonState(previewStatus).label}
              aria-busy={previewStatus === "preparing"}
              className={cn(
                "flex w-[84px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-50",
                previewing ? "bg-accent/15 text-accent-text hover:bg-accent/25" : "bg-control text-ink hover:bg-raised-hover",
              )}
            >
              {previewStatus === "preparing" ? <><Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> {tryButtonState(previewStatus).text}</>
                : previewStatus === "speaking" ? <><Square size={12} fill="currentColor" /> {tryButtonState(previewStatus).text}</>
                : <><Volume2 size={14} /> {tryButtonState(previewStatus).text}</>}
            </button>
          </div>
          {previewError && <div role="alert" className="mt-1.5 text-[11.5px] text-danger">{previewError}</div>}
          {voices.some((v) => v.gender) && (
            <div className="mt-1.5 text-[11.5px] text-ink-secondary">Grouped by how each voice sounds.</div>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">Read replies aloud</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
            Speak this bot's answers as they arrive, even from another chat.
          </div>
        </div>
        <Switch
          checked={Boolean(bot.speakReplies)}
          aria-label="Read this bot's replies aloud"
          onClick={() => onPatch({ speakReplies: !bot.speakReplies })}
        />
      </div>

      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
