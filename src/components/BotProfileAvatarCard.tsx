import { useRef, useState } from "react";
import { useBotSettingsDraft } from "./bot-settings-drafts";
import { Check, ImagePlus, Loader2, Sparkles, Trash2 } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { AVATAR_COPY, avatarGeneratorPlan, type AvatarGeneratorPlan } from "@/lib/avatar-generation";
import { cn } from "@/lib/cn";
import {
  PICKABLE_STATES,
  EMBER_COLORS,
  EMBER_COLOR_NAMES,
  type EmberMotion,
  type EmberState,
} from "@/lib/mascot";
import {
  BOT_AVATAR_CROPS,
  botAvatarUrlFromStoredPath,
  type BotAvatarCrop,
} from "../../shared/bot-avatar";
import { BotAvatar, EmberAvatar } from "./Avatar";

type AvatarPatch = Partial<
  Pick<Bot, "avatarCrop" | "avatarUrl" | "color" | "mascotExpression">
>;

const CROP_LABEL = {
  mascot: "Mascot",
  circle: "Circle",
  rounded: "Rounded",
  square: "Square",
} satisfies Record<BotAvatarCrop, string>;

export function BotProfileAvatarCard({
  bot,
  activeState,
  mascotMotion,
  onPatch,
}: {
  bot: Bot;
  activeState: EmberState;
  mascotMotion: { kind: Exclude<EmberMotion, "none">; nonce: number } | null;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const { state, dispatch, flushBotPatches } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [imageKey, setImageKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [direction, setDirection] = useState("");
  const [generating, setGenerating] = useState(false);
  useBotSettingsDraft("Appearance", Boolean(imageKey.trim() || direction.trim()), savingKey || uploading || generating);
  const [error, setError] = useState<string | null>(null);
  const crop = bot.avatarCrop ?? "mascot";
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const [lastAttemptFailed, setLastAttemptFailed] = useState(false);
  // `state.config` is null until GET /api/config answers. Both facts stay null
  // until then rather than defaulting to "no key", so a machine that has a Flux
  // key never shows another provider's name for a frame. See providerFor.
  const config = state.config;
  const plan = avatarGeneratorPlan({
    flux: config ? config.flux?.configured === true : null,
    openAiImageKey: config ? config.imageGen?.configured === true : null,
    lastAttemptFailed,
  });

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await imageAttachmentFromFile(file);
      if (!saved) throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an avatar");
      const latestCrop = cropRef.current;
      onPatch({ avatarUrl, avatarCrop: latestCrop === "mascot" ? "circle" : latestCrop });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeImage = () => {
    setError(null);
    onPatch({ avatarUrl: null, avatarCrop: "mascot" });
  };

  const saveImageKey = async () => {
    const key = imageKey.trim();
    if (!key) return;
    setSavingKey(true);
    setError(null);
    try {
      const status: ConfigStatus = window.muragebox?.setCredential
        ? await window.muragebox.setCredential("openaiImageApiKey", key)
        : await api("/api/config", {
            method: "PUT",
            body: JSON.stringify({ imageGen: { key } }),
          });
      dispatch({ type: "configStatus", config: status });
      setImageKey("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingKey(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      // Generation reads the bot's identity and crop server-side. Commit any
      // debounced profile edits first, then feed the generated avatar back
      // through the same serialized mutation lane as upload/remove.
      const cropAtStart = cropRef.current;
      await flushBotPatches(bot.id);
      const result: { avatarUrl: string; bot: Bot } = await api(`/api/bots/${bot.id}/avatar/generate`, {
        method: "POST",
        body: JSON.stringify({ prompt: direction.trim() }),
      });
      const latestCrop = cropRef.current;
      onPatch({
        avatarUrl: result.avatarUrl,
        avatarCrop:
          latestCrop === cropAtStart
            ? (result.bot.avatarCrop ?? "circle")
            : latestCrop,
      });
      setLastAttemptFailed(false);
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : String(generateError));
      // A failed attempt is what un-hides the OpenAI key drawer on a Flux
      // workspace. Flux answers 402 for an account that is not on a paid plan,
      // and this panel is the only place an OpenAI image key can be entered.
      setLastAttemptFailed(true);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
      <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
        <span className="rounded-lg bg-control px-3 py-1.5 text-[14px] font-medium text-ink">Avatar</span>
        <button
          onClick={() => onPatch({ avatarCrop: "mascot", color: "orange", mascotExpression: null })}
          className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          Reset mascot
        </button>
      </div>

      <div className="p-3">
        <div className="flex justify-center py-3">
          <BotAvatar
            bot={bot}
            state={activeState}
            size={112}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
        </div>

        <div className="mt-2 flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="sr-only"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || generating}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            Upload image
          </button>
          {bot.avatarUrl && (
            <button
              type="button"
              onClick={removeImage}
              disabled={uploading || generating}
              aria-label="Remove custom avatar image"
              title="Remove custom image"
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[11.5px] text-ink-secondary">PNG, JPEG, GIF, or WebP · up to 10 MB</div>

        <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
          Shape
        </div>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-hairline/40">
          {BOT_AVATAR_CROPS.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={crop === candidate}
              onClick={() => onPatch({ avatarCrop: candidate })}
              className={cn(
                "py-1.5 text-[12.5px]",
                index > 0 && "border-l border-hairline/40",
                crop === candidate ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {CROP_LABEL[candidate]}
            </button>
          ))}
        </div>

        {crop === "mascot" && (
          <>
            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Expression
            </div>
            <div className="grid grid-cols-5 gap-2">
              {PICKABLE_STATES.map((expression) => (
                <button
                  key={expression}
                  type="button"
                  aria-pressed={activeState === expression}
                  onClick={() => onPatch({ mascotExpression: expression })}
                  className={cn(
                    "flex h-[58px] items-center justify-center rounded-xl bg-inset transition-colors hover:bg-control",
                    activeState === expression && "ring-2 ring-accent-border",
                  )}
                  title={expression}
                  aria-label={`Use ${expression} expression`}
                >
                  <EmberAvatar color={bot.color} state={expression} size={42} animated={false} />
                </button>
              ))}
            </div>

            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Color
            </div>
            <div className="flex flex-wrap gap-2.5">
              {EMBER_COLOR_NAMES.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-pressed={bot.color === color}
                  onClick={() => onPatch({ color })}
                  className={cn(
                    "size-10 rounded-full border-2 border-transparent transition-transform hover:scale-110",
                    bot.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                  )}
                  style={{ backgroundColor: EMBER_COLORS[color] }}
                  title={color}
                  aria-label={`Use ${color} mascot color`}
                />
              ))}
            </div>
          </>
        )}

        <AvatarGenerateSection
          plan={plan}
          direction={direction}
          onDirection={setDirection}
          directionPlaceholder={`Optional direction, e.g. \u201Ca calm navigator inspired by ${bot.title || bot.name}\u201D`}
          generating={generating}
          uploading={uploading}
          onGenerate={() => void generate()}
          imageKey={imageKey}
          onImageKey={setImageKey}
          savingKey={savingKey}
          onSaveKey={() => void saveImageKey()}
          onOpenSettings={() => dispatch({ type: "toggleAppSettings", open: true, section: "models" })}
        />

        {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
      </div>
    </div>
  );
}

export interface AvatarGenerateSectionProps {
  plan: AvatarGeneratorPlan;
  direction: string;
  onDirection: (value: string) => void;
  directionPlaceholder: string;
  generating: boolean;
  uploading: boolean;
  onGenerate: () => void;
  imageKey: string;
  onImageKey: (value: string) => void;
  savingKey: boolean;
  onSaveKey: () => void;
  /** Opens Settings at Connections, where the single Flux key field lives. */
  onOpenSettings: () => void;
}

/**
 * Rendering only, so every state of the panel can be asserted without a store
 * or a DOM — the same split FluxInviteBody and SkillsBody use. Which state it
 * is in is `avatarGeneratorPlan`'s answer, never a condition written here.
 */
export function AvatarGenerateSection({
  plan,
  direction,
  onDirection,
  directionPlaceholder,
  generating,
  uploading,
  onGenerate,
  imageKey,
  onImageKey,
  savingKey,
  onSaveKey,
  onOpenSettings,
}: AvatarGenerateSectionProps) {
  const keyField = (placeholder: string, label: string, background: string) => (
    <div className="flex gap-2">
      <input
        type="password"
        value={imageKey}
        onChange={(event) => onImageKey(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && onSaveKey()}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        className={cn(
          "min-w-0 flex-1 rounded-lg border border-hairline/40 px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none",
          background,
        )}
      />
      <button
        type="button"
        onClick={onSaveKey}
        disabled={savingKey || !imageKey.trim()}
        className="flex w-[72px] items-center justify-center gap-1.5 rounded-lg bg-control text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
      >
        {savingKey ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} /> Save</>}
      </button>
    </div>
  );

  return (
    <div className="mt-5 border-t border-hairline/40 pt-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <Sparkles size={14} className="text-accent" /> {plan.heading}
      </div>
      <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">{plan.body}</div>
      {plan.fluxHint && (
        <div className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
          {plan.fluxHint}{" "}
          <button
            type="button"
            onClick={onOpenSettings}
            className="text-accent underline underline-offset-2 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            {AVATAR_COPY.fluxHintAction}
          </button>
        </div>
      )}

      {plan.showKeyField && (
        <div className="mt-3">
          {keyField("Paste OpenAI image API key", "OpenAI image API key", "bg-inset")}
          <div className="mt-1.5 text-[11px] text-ink-secondary">Stored in the operating system's encrypted credential store in the installed app.</div>
        </div>
      )}

      {plan.canGenerate && (
        <div className="mt-3">
          <textarea
            value={direction}
            onChange={(event) => onDirection(event.target.value.slice(0, 400))}
            maxLength={400}
            placeholder={directionPlaceholder}
            aria-label="Avatar generation direction"
            className="min-h-[72px] w-full resize-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11px] tabular-nums text-ink-secondary">{direction.length}/400</span>
            <button
              type="button"
              onClick={onGenerate}
              disabled={generating || uploading}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {generating ? "Generating\u2026" : "Generate avatar"}
            </button>
          </div>
        </div>
      )}

      {plan.showKeyDrawer && (
        <details className="mt-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2">
          <summary className="cursor-pointer text-[11.5px] text-ink-secondary">{AVATAR_COPY.keyDrawerLabel}</summary>
          <div className="mt-2">{keyField("Paste replacement key", "Replacement OpenAI image API key", "bg-card")}</div>
        </details>
      )}
    </div>
  );
}
