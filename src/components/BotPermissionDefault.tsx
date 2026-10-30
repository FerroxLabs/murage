import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, useStoreActions, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { FULL_ACCESS_DESKTOP_ONLY, isDesktopOnlyMode, permissionModeOf, type PermissionMode } from "@/lib/permission-mode";
import { Switch } from "./SettingsPrimitives";

export const FULL_ACCESS_CHANNEL_OPTION = "Also skip approvals for my messages from Telegram, Slack and Discord";
export const FULL_ACCESS_SETUP_OPTION = "Also approve setup requests: installing skills, proposing routines and trusting folders";

type FullAccessOption = "fullAccessChannelMessages" | "fullAccessSetupRequests";

const MODES: ReadonlyArray<{ mode: PermissionMode; label: string }> = [
  { mode: "ask", label: "Ask" },
  { mode: "auto", label: "Auto" },
  { mode: "full", label: "Full access" },
  { mode: "unlimited", label: "No limits" },
];

function modeDetail(mode: PermissionMode, onThisComputer: boolean): string {
  if (mode === "unlimited") {
    return onThisComputer
      ? "Runs everything without asking, except reading your keys and passwords and commands Murage recognizes as able to wipe your computer, which ask first. That includes this computer. Webhook turns still ask. Routines use this level unless a routine has its own."
      : "Runs everything without asking, except reading your keys and passwords and commands Murage recognizes as able to wipe your computer, which ask first. Webhook turns still ask. Routines use this level unless a routine has its own.";
  }
  if (mode === "full") {
    return onThisComputer
      ? "Keeps going without asking, including on this computer and before contacting other bots, but stops before deleting outside its folder, paying, messaging someone new, or reading your keys. Webhook turns still ask. Routines use this level unless a routine has its own."
      : "Keeps going without asking, including before contacting other bots, but stops before deleting outside its folder, paying, messaging someone new, or reading your keys. Webhook turns still ask. Routines use this level unless a routine has its own.";
  }
  if (mode === "auto") {
    return onThisComputer
      ? "Keeps going on this computer; you'll still be asked about anything destructive, and about questions it asks you."
      : "Keeps going on its own; you'll still be asked about anything destructive, and about questions it asks you.";
  }
  return onThisComputer
    ? "Approve each action on this computer yourself."
    : "Approve each action yourself.";
}

/** Bot Settings' approval default: the level new conversations start at, and
 * Full access's two extras. Choosing goes through `onChoose`, which shows the
 * same warnings as the composer; the server enforces every rule. */
export function BotPermissionDefault({
  bot,
  botId,
  onThisComputer,
  desktop,
  requested,
  onChoose,
  onOption,
}: {
  botId?: string;
  bot: Pick<Bot, "autoApprove" | "fullAccess" | "noLimits" | "fullAccessChannelMessages" | "fullAccessSetupRequests" | "fullAccessAcknowledgedAt" | "noLimitsAcknowledgedAt">;
  /** the bot drives this computer (changes the wording only) */
  onThisComputer: boolean;
  /** this renderer is the desktop app (useDesktopSurface): false on a phone
   * or the browser door, where Full access and its options are refused */
  desktop?: boolean;
  requested?: { current: { botId: string; mode: PermissionMode } | null };
  onChoose: (mode: PermissionMode) => void;
  onOption: (key: FullAccessOption, value: boolean) => void;
}) {
  const current = permissionModeOf(bot);
  const full = current === "full" || current === "unlimited";
  const remote = desktop === false;
  const options: ReadonlyArray<{ key: FullAccessOption; label: string; hint: string }> = [
    { key: "fullAccessChannelMessages", label: FULL_ACCESS_CHANNEL_OPTION, hint: "On unless you turn it off. Group chats, other people and webhooks still ask. Routines use their own level." },
    { key: "fullAccessSetupRequests", label: FULL_ACCESS_SETUP_OPTION, hint: "Connecting an app still asks, because you sign in to it yourself." },
  ];
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Approvals</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        New conversations start at this level. You can change it for one conversation from the message box.
      </div>
      <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5" role="radiogroup" aria-label="Default approval level">
        {MODES.map(({ mode, label }) => {
          // Not offered where the server would refuse it (server/full-access.ts).
          const unavailable = remote && isDesktopOnlyMode(mode);
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={current === mode}
              disabled={unavailable}
              title={unavailable ? FULL_ACCESS_DESKTOP_ONLY : undefined}
              onClick={() => current !== mode && onChoose(mode)}
              className={cn(
                "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed",
                current === mode ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink disabled:hover:text-ink-secondary",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-[12.5px] text-ink-secondary">{modeDetail(current, onThisComputer)}</div>
      {desktop === true && botId && <OpenConversationPermissions key={botId} botId={botId} requested={requested} mode={current}
        acknowledged={current === "unlimited" ? bot.noLimitsAcknowledgedAt !== undefined : current !== "full" || bot.fullAccessAcknowledgedAt !== undefined || bot.noLimitsAcknowledgedAt !== undefined}
        onConfirmLevel={() => onChoose(current)} />}
      {remote && <div className="mt-1 text-[12.5px] text-ink-secondary">{FULL_ACCESS_DESKTOP_ONLY}</div>}
      <div className="mt-3 flex flex-col gap-2">
        {!full && <div className="text-[12px] text-ink-secondary">Only used when the default is Full access or No limits.</div>}
        {options.map(({ key, label, hint }) => (
          <div key={key} className="flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
            <div className="min-w-0">
              <div className={cn("text-[13px]", full ? "text-ink" : "text-ink-secondary")}>{label}</div>
              <div className="mt-0.5 text-[11.5px] text-ink-secondary">{hint}</div>
            </div>
            <Switch
              checked={key === "fullAccessChannelMessages" ? bot[key] !== false : bot[key] === true}
              disabled={!full || remote}
              aria-label={label}
              onClick={() => onOption(key, key === "fullAccessChannelMessages" ? bot[key] === false : bot[key] !== true)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

type BulkPreview = { previewId: string; targetLevel: "ask" | "auto" | "full" | "no-limits"; eligible: Array<{ threadId: string; from: BulkPreview["targetLevel"] }>; skipped: Array<{ threadId: string; reason: string }> };

export type PermissionOfferState = { mode: PermissionMode; pending: boolean };
export function permissionOfferReducer(state: PermissionOfferState, action: { type: "saved"; mode: PermissionMode; requested?: PermissionMode } | { type: "dismiss" }): PermissionOfferState {
  if (action.type === "dismiss") return { ...state, pending: false };
  if (action.mode === state.mode) return state;
  return {
    mode: action.mode,
    pending: action.requested === action.mode && isDesktopOnlyMode(action.mode) && MODES.findIndex(item => item.mode === action.mode) > MODES.findIndex(item => item.mode === state.mode),
  };
}

export function summarizePermissionPreview(preview: BulkPreview | null) {
  return preview && { targetLevel: preview.targetLevel, count: preview.eligible.length, allAtAsk: preview.eligible.every(chat => chat.from === "ask") };
}

export function permissionOfferCopy(state: PermissionOfferState, preview: ReturnType<typeof summarizePermissionPreview>, acknowledged: boolean) {
  // Wait for a preview of the saved level after an optimistic default change.
  if (!state.pending || !acknowledged || !preview?.count || preview.targetLevel !== (state.mode === "unlimited" ? "no-limits" : state.mode)) return null;
  const count = preview.count;
  const label = { ask: "Ask", auto: "Auto", full: "Full access", "no-limits": "No limits" }[preview.targetLevel];
  return {
    message: `${count} open ${count === 1 ? "chat is" : "chats are"} still ${preview.allAtAsk ? "at Ask" : "at a lower approval level"}. Apply ${label} to ${count === 1 ? "it" : "them"} too?`,
    applyLabel: `Apply to ${count} ${count === 1 ? "chat" : "chats"}`,
  };
}

export function PermissionOffer({ copy, busy, onReview, onDismiss }: {
  copy: ReturnType<typeof permissionOfferCopy>;
  busy: boolean;
  onReview: () => void;
  onDismiss: () => void;
}) {
  return <div role="status" aria-live="polite" aria-atomic="true">
    {copy && <div className="rounded-lg bg-inset p-3">
      <p>{copy.message}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={onReview} className="rounded-lg bg-accent px-3 py-2 font-medium text-white hover:brightness-110">{copy.applyLabel}</button>
        <button type="button" disabled={busy} onClick={onDismiss} className="rounded-lg px-3 py-2 text-ink-secondary hover:text-ink">Not now</button>
      </div>
    </div>}
  </div>;
}

export async function applyPermissionPreviewOnce(applying: { current: boolean }, operation: () => Promise<void>) {
  if (applying.current) return;
  applying.current = true;
  try { await operation(); }
  finally { applying.current = false; }
}

export function OpenConversationPermissions({ botId, requested, mode, acknowledged, onConfirmLevel }: { botId: string; requested?: { current: { botId: string; mode: PermissionMode } | null }; mode: PermissionMode; acknowledged: boolean; onConfirmLevel: () => void }) {
  const { flushBotPatches } = useStoreActions();
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [offer, dispatchOffer] = useReducer(permissionOfferReducer, { mode, pending: false });
  const applying = useRef(false);
  const path = `/api/bots/${botId}/permissions/refresh`;
  useEffect(() => {
    let current = true;
    dispatchOffer({ type: "dismiss" });
    setMessage("");
    setConfirm(false);
    setPreview(null);
    // Compare saved levels, never an optimistic downgrade and its rollback.
    const request = requested?.current;
    void flushBotPatches(botId).then(() => api(path, { method: "POST", body: JSON.stringify({ scope: "open" }) })).then(value => {
      if (!current) return;
      const saved = value as BulkPreview;
      setPreview(saved);
      dispatchOffer({ type: "saved", mode: saved.targetLevel === "no-limits" ? "unlimited" : saved.targetLevel, requested: request?.botId === botId ? request.mode : undefined });
      if (requested && requested.current === request) requested.current = null;
    }, () => { if (current) setPreview(null); });
    return () => { current = false; };
  }, [path, botId, mode, flushBotPatches, requested]);
  const review = async () => {
    if (!acknowledged) { onConfirmLevel(); return; }
    setBusy(true); setMessage("");
    try { setPreview(await api(path, { method: "POST", body: JSON.stringify({ scope: "open" }) }) as BulkPreview); setConfirm(true); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    await applyPermissionPreviewOnce(applying, async () => {
      setBusy(true); setMessage("");
      try {
        const result = await api(path, { method: "POST", body: JSON.stringify({ scope: "open", previewId: preview.previewId }) }) as { changed: number };
        setMessage(`${result.changed} conversations now use this approval level.`); setPreview(null); setConfirm(false); dispatchOffer({ type: "dismiss" });
      } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setConfirm(false); }
      finally { setBusy(false); }
    });
  };
  const label = preview && ({ ask: "Ask", auto: "Auto", full: "Full access", "no-limits": "No limits" }[preview.targetLevel]);
  const summary = useMemo(() => summarizePermissionPreview(preview), [preview]);
  const offerCopy = permissionOfferCopy({ ...offer, mode }, summary, acknowledged);
  return <div className="mt-3 text-[13px]">
    <PermissionOffer copy={confirm ? null : offerCopy} busy={busy} onReview={() => void review()} onDismiss={() => dispatchOffer({ type: "dismiss" })} />
    {!!preview?.eligible.length && !confirm && !offerCopy && <button type="button" disabled={busy} onClick={() => void review()}>Apply to my open conversations</button>}
    {confirm && preview && <div role="dialog" aria-label="Apply approval level">
      <p>Raise {preview.eligible.length} conversations to {label}. Conversations already at a higher level keep it.</p>
      <p>{preview.skipped.length} conversations keep their current level. Busy conversations can be reviewed again later.</p>
      <p>Rooms: Follows the bot default.</p>
      <button type="button" disabled={busy || !preview.eligible.length} onClick={() => void apply()}>Apply to {preview.eligible.length} conversations</button>
      <button type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
