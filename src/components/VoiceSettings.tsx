// Per-bot voice profile. The key is shared; the voice and autoplay choice
// belong to the selected bot.
//
// The voice list comes from the harness, which holds the key; the
// renderer never talks to ElevenLabs itself.
import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { replyController, useReplySpeech } from "@/lib/tts/reply-speech";
import { knownComputer } from "@/lib/surface";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { cleanupEnabled, setCleanupEnabled } from "@/lib/dictation-cleanup";
import { Switch } from "./SettingsPrimitives";
import { VoicePicker } from "./VoicePicker";
import { FLUX_ELEVEN_NOTE, needsAdding, voicesUrl, isVoicePreview, previewMessageId, markAssigned, rowPreview, type FluxElevenStatus, type PickerVoice } from "./voice-picker-model";
import { useBotSettingsDraft } from "./bot-settings-drafts";
import { systemVoiceOffer } from "../../shared/system-voices";
import { opensPurchasePages } from "@/lib/native-shell";

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
  const spokenReplies = useReplySpeech();

  const [cleanUp, setCleanUp] = useState(() => cleanupEnabled());
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const switching = false;
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<PickerVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  // The list failing to load is said next to the picker, with a way to try again; an empty list would read as "no voices".
  const [voicesFailed, setVoicesFailed] = useState(false);
  const [voiceReload, setVoiceReload] = useState(0);
  // Flux's ElevenLabs voices: "notOnKey" when Flux said this key may not use
  // them; the list leaves them out and says so under the picker.
  const [fluxEleven, setFluxEleven] = useState<FluxElevenStatus | undefined>(undefined);
  // "Check again": the next list read asks Flux's voice list now
  const recheckNext = useRef(false);
  // An own ElevenLabs key searches its account and the Voice Library on the
  // server; the words wait 300 ms so typing is not a request per letter.
  const [voiceQuery, setVoiceQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  // A Voice Library voice being added to the owner's account, and why it was not
  const [addingVoice, setAddingVoice] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  // Every pick, service change or new bot moves this on, so a slow add never
  // overwrites a choice made after it.
  const pickGeneration = useRef(0);
  useEffect(() => () => { pickGeneration.current += 1; }, [bot.id]);
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

  const serverSearch = provider === "elevenlabs";
  const voiceSearch = serverSearch ? searchedQuery : "";
  useEffect(() => {
    const timer = setTimeout(() => setSearchedQuery(voiceQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [voiceQuery]);
  // another service's list never shows under this one while it loads
  useEffect(() => {
    setVoices([]);
    setAddError(null);
    pickGeneration.current += 1;
  }, [provider]);

  useEffect(() => {
    if (!configured) {
      setVoices([]);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    setVoicesFailed(false);
    const recheck = recheckNext.current;
    recheckNext.current = false;
    api(voicesUrl(provider, { recheck, query: voiceSearch }))
      .then((r: { voices?: typeof voices; error?: string; fluxEleven?: FluxElevenStatus }) => {
        if (!alive) return;
        setVoices(r.voices ?? []);
        setFluxEleven(r.fluxEleven);
        if (r.error) setError(r.error);
      })
      .catch(() => { if (alive) { setVoices([]); setVoicesFailed(true); } })
      .finally(() => alive && setLoadingVoices(false));
    return () => {
      alive = false;
    };
  }, [configured, provider, voiceReload, voiceSearch]);

  // Picking a Voice Library voice adds it to the owner's ElevenLabs account
  // (a voice slot there), then picks the id the account gives it.
  const pickVoice = (voiceId: string) => {
    setAddError(null);
    const voice = voices.find((v) => v.id === voiceId);
    // one add at a time; the pending one stays the choice
    if (serverSearch && needsAdding(voice) && addingVoice) return;
    const generation = ++pickGeneration.current;
    if (!serverSearch || !needsAdding(voice)) return onPatch({ voice: voiceId });
    setAddingVoice(voice.id);
    api("/api/tts/voices/add", {
      method: "POST",
      body: JSON.stringify({ publicOwnerId: voice.publicOwnerId, voiceId: voice.id, name: voice.label }),
    })
      .then((r: { voiceId: string }) => {
        if (generation !== pickGeneration.current) return;
        onPatch({ voice: r.voiceId });
        setVoiceReload((n) => n + 1);
      })
      .catch((e: Error) => { if (generation === pickGeneration.current) setAddError(e.message); })
      .finally(() => setAddingVoice(null));
  };

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

  // Every row of the picker plays its own sample. The speaker plays one thing
  // at a time, so starting one stops the last; each row reads its own state
  // (Loading, Stop, or what went wrong) from the speaker's.
  const speech = useSpeech();
  const preview = (voiceId: string) => rowPreview(speech, previewMessageId(bot.id, voiceId));
  const togglePreview = (voiceId: string) => {
    const state = preview(voiceId).state;
    if (state === "loading" || state === "playing") return speaker.stop();
    void speaker.speak(SAMPLE, { voiceId: voiceId || undefined, botId: bot.id, messageId: previewMessageId(bot.id, voiceId) });
  };
  // A sample of an ElevenLabs voice that Flux refused: the list is read
  // again, so voices this key may not use leave it and the note says why.
  const elevenPreviewFailed = Boolean(speech.error) && isVoicePreview(speech.messageId, bot.id)
    && voices.some((v) => v.provider === "elevenlabs" && previewMessageId(bot.id, v.id) === speech.messageId);
  useEffect(() => {
    if (elevenPreviewFailed) setVoiceReload((n) => n + 1);
  }, [elevenPreviewFailed]);
  // Leaving the settings ends a sample still playing.
  useEffect(() => () => {
    if (isVoicePreview(speaker.state.messageId, bot.id)) speaker.stop();
  }, [bot.id]);

  if (!tts) return null;

  // The voice the app assigned is a Flux-list voice: where this bot speaks
  // another way, it is not shown as chosen.
  const assigned = bot.voiceAssigned && provider === "flux" ? bot.voice : undefined;
  const selectedVoice = bot.voiceAssigned && provider !== "flux" ? "" : (bot.voice ?? "");
  // Kept at the top of the list: the workspace's voice, and a saved voice the
  // list no longer has.
  const pinned: PickerVoice[] = [
    ...(tts.voice ? [{ id: "", label: "Workspace default", description: "The voice set for the whole workspace" }] : []),
    ...(selectedVoice && !loadingVoices && !voices.some((voice) => voice.id === selectedVoice) ? [{ id: selectedVoice, label: "Current voice", description: "Saved earlier, not in this list" }] : []),
  ];

  return (
    <div className="rounded-xl bg-card p-4">
      <p className="text-[13px] text-ink-secondary">{t("settings.fluxSpendLimits")}</p>
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
              ? "Speaks through your own OpenAI key. No other key needed."
              : "Speaks through your Flux account. No other key needed."
            : "Add a Flux key, or an OpenAI key, in Settings to use these voices."}
        </div>
      )}

      {provider === "xai" && (
        <div className="mt-3 text-[12.5px] text-ink-secondary">
          {xaiKey
            ? "Speaks with xAI's voices through your own xAI key. 28 voices."
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
        {!configured && opensPurchasePages() && (
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
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px] text-ink-secondary">
            <span>Voice</span>
            {!selectedVoice && !tts.voice && !loadingVoices && <span className="text-[12px]">Pick a voice</span>}
          </div>
          <VoicePicker
            voices={markAssigned(voices, assigned)}
            pinned={pinned}
            value={selectedVoice}
            onChange={pickVoice}
            onQueryChange={serverSearch ? setVoiceQuery : undefined}
            label={`${bot.name}'s voice`}
            loading={loadingVoices}
            preview={preview}
            onPreview={togglePreview}
          />
          {addingVoice && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-secondary" data-testid="voice-adding">
              <Loader2 size={12} className="animate-spin" aria-hidden />
              <span>Adding this voice to your ElevenLabs account</span>
            </div>
          )}
          {addError && !addingVoice && (
            <div role="alert" className="mt-1.5 text-[12px] text-danger" data-testid="voice-add-failed">{addError}</div>
          )}
          {voicesFailed && !loadingVoices && (
            <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-danger" data-testid="voices-load-failed">
              <span>Couldn't load the voice list.</span>
              <button type="button" className="underline hover:no-underline" onClick={() => setVoiceReload((n) => n + 1)}>Try again</button>
            </div>
          )}
          {provider === "flux" && fluxEleven && FLUX_ELEVEN_NOTE[fluxEleven] && !loadingVoices && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-ink-secondary" data-testid={`flux-eleven-${fluxEleven}`}>
              <span>{FLUX_ELEVEN_NOTE[fluxEleven]}</span>
              <button
                type="button"
                className="underline hover:no-underline"
                data-testid="flux-eleven-check-again"
                onClick={() => {
                  recheckNext.current = true;
                  setVoiceReload((n) => n + 1);
                }}
              >
                Check again
              </button>
            </div>
          )}
          {voices.some((v) => v.gender) && (
            <div className="mt-1.5 text-[11.5px] text-ink-secondary">Every voice speaks every language.</div>
          )}
        </div>
      )}

      {knownComputer() === true && <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">{t("ux.d24.label")}</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{t("ux.d24.help")}</div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">{t("ux.d24.disclosure")}</div>
        </div>
        <Switch checked={spokenReplies.enabled} aria-label={t("ux.d24.label")} onClick={() => replyController.setEnabled(!spokenReplies.enabled)} />
      </div>}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">Clean up dictation</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
            Clean up dictation on this device: removes ums, fixes punctuation and corrections. Undo anytime.
          </div>
        </div>
        <Switch
          checked={cleanUp}
          aria-label="Clean up dictation"
          onClick={() => {
            setCleanupEnabled(!cleanUp);
            setCleanUp(!cleanUp);
          }}
        />
      </div>

      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
