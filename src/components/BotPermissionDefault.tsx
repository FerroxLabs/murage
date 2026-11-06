import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { api, useStoreActions, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { FULL_ACCESS_DESKTOP_ONLY, isDesktopOnlyMode, permissionModeOf, type PermissionMode } from "@/lib/permission-mode";
import { Switch } from "./SettingsPrimitives";
import { LevelExamples } from "./approval/LevelExamples";
import { LevelConfirmCard } from "./approval/LevelConfirmCard";
import { LevelStatusLine } from "./approval/LevelStatusLine";
import type { LevelChange } from "./approval/use-level-change";
import { fromWire, type ChangedThread, type LevelPreview } from "@/lib/level-change";

export const FULL_ACCESS_CHANNEL_OPTION = "Also skip approvals for my messages from Telegram, Slack and Discord. Reading keys still asks.";
export const NO_LIMITS_TERMS_NOTE = "No limits changed. This bot keeps asking as it did until you accept.";
export const FULL_ACCESS_SETUP_OPTION = "Also approve setup requests: installing skills, proposing routines and trusting folders";

type FullAccessOption = "fullAccessChannelMessages" | "fullAccessSetupRequests";

const MODES: ReadonlyArray<{ mode: PermissionMode; label: string }> = [
  { mode: "ask", label: "Ask" },
  { mode: "auto", label: "Auto" },
  { mode: "full", label: "Full access" },
  { mode: "unlimited", label: "No limits" },
];

function modeDetail(mode: PermissionMode, onThisComputer: boolean): string {
  // UX-TRUST-MOMENTS-1012 section 8 rows 16, 17 and 10: what each level
  // still asks about, and routines keep their own level (T10)
  if (mode === "unlimited") {
    return onThisComputer
      ? t("ux.lcopyb.level.unlimitedHere")
      : t("ux.lcopyb.level.unlimited");
  }
  if (mode === "full") {
    return onThisComputer
      ? t("ux.lcopyb.level.fullHere")
      : t("ux.lcopyb.level.full");
  }
  if (mode === "auto") {
    return onThisComputer
      ? `Keeps going on this computer. ${t("ux.l1.level.autoDetail")}`
      : `Keeps going on its own. ${t("ux.l1.level.autoDetail")}`;
  }
  return onThisComputer
    ? "Approve each action on this computer yourself."
    : "Approve each action yourself.";
}

/** Bot Settings' approval default: the level new conversations start at, and
 * Full access's two extras. Choosing goes through `onChoose`; a higher pick to
 * Full access or No limits shows the confirm card in place of the example
 * table (UX-TRUST-MOMENTS-1012 3.3). The server enforces every rule. */
export function BotPermissionDefault({
  bot,
  botId,
  botName,
  onThisComputer,
  desktop,
  change,
  termsPending = false,
  onReviewTerms,
  onChoose,
  onOption,
}: {
  botId?: string;
  botName?: string;
  bot: Pick<Bot, "autoApprove" | "fullAccess" | "noLimits" | "fullAccessChannelMessages" | "fullAccessSetupRequests" | "fullAccessAcknowledgedAt" | "noLimitsAcknowledgedAt">;
  /** the bot drives this computer (changes the wording only) */
  onThisComputer: boolean;
  /** this renderer is the desktop app (useDesktopSurface): false on a phone
   * or the browser door, where Full access and its options are refused */
  desktop?: boolean;
  /** the level change in progress (useLevelChange); absent, the menu only reports the pick */
  change?: LevelChange;
  /** the owner has not accepted No limits as it now stands */
  termsPending?: boolean;
  onReviewTerms?: () => void;
  onChoose: (mode: PermissionMode) => void;
  onOption: (key: FullAccessOption, value: boolean) => void;
}) {
  const current = permissionModeOf(bot);
  const full = current === "full" || current === "unlimited";
  const remote = desktop === false;
  const card = change?.card;
  const options: ReadonlyArray<{ key: FullAccessOption; label: string; hint: string }> = [
    { key: "fullAccessChannelMessages", label: FULL_ACCESS_CHANNEL_OPTION, hint: t("ux.lcopyb.level.channelHint") },
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
              disabled={unavailable || change?.busy}
              title={unavailable ? FULL_ACCESS_DESKTOP_ONLY : undefined}
              onClick={() => current !== mode && onChoose(mode)}
              className={cn(
                "min-h-11 flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed",
                current === mode ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink disabled:hover:text-ink-secondary",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-[12.5px] text-ink-secondary">{modeDetail(current, onThisComputer)}</div>
      {change?.line && <LevelStatusLine line={change.line} undoing={change.undoing} onUndo={() => void change.undo()} onReview={change.review} />}
      {card && change
        ? <div className="mt-3 rounded-lg bg-inset px-3 py-2">
            <LevelConfirmCard
              bot={botName ?? ""}
              target={card.target}
              keep={fromWire(card.preview.botLevel)}
              effect={{ kind: "default", conversations: card.preview.eligible.length, routines: card.preview.routines }}
              onThisComputer={change.drivesComputer}
              notice={card.notice}
              error={card.error}
              busy={change.busy}
              onKeep={change.keep}
              onUse={() => void change.use(true)}
              onOnlyNew={() => void change.use(false)}
            />
          </div>
        : <LevelExamples current={current} only={remote ? current : undefined} className="mt-3 rounded-lg bg-inset px-3 py-2" />}
      {desktop === true && botId && <OpenConversationPermissions key={botId} botId={botId} mode={current} reviewAsk={change?.reviewAsk ?? 0}
        acknowledged={current === "unlimited" ? bot.noLimitsAcknowledgedAt !== undefined : current !== "full" || bot.fullAccessAcknowledgedAt !== undefined || bot.noLimitsAcknowledgedAt !== undefined}
        onConfirmLevel={() => onChoose(current)} />}
      {remote && <div className="mt-1 text-[12.5px] text-ink-secondary">{FULL_ACCESS_DESKTOP_ONLY}</div>}
      {desktop === true && termsPending && current === "unlimited" && (
        <div className="mt-2 flex items-center justify-between gap-3 text-[12.5px] text-ink-secondary">
          <span>{NO_LIMITS_TERMS_NOTE}</span>
          <button type="button" onClick={onReviewTerms} className="shrink-0 rounded-md px-2 py-1 font-medium text-ink hover:bg-raised">Review</button>
        </div>
      )}
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

type BulkPreview = Pick<LevelPreview, "rosterId" | "targetLevel" | "botRev" | "eligible" | "skipped">;

export async function applyPermissionPreviewOnce(applying: { current: boolean }, operation: () => Promise<void>) {
  if (applying.current) return;
  applying.current = true;
  try { await operation(); }
  finally { applying.current = false; }
}

/** "Apply to my open conversations": brings them up to the level the bot is
 * already on (afterRev is the preview's own revision: nothing was written),
 * and the door behind [Review conversations] on the F14 line. */
export function OpenConversationPermissions({ botId, mode, acknowledged, reviewAsk = 0, onConfirmLevel }: { botId: string; mode: PermissionMode; acknowledged: boolean; reviewAsk?: number; onConfirmLevel: () => void }) {
  const { flushBotPatches } = useStoreActions();
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const applying = useRef(false);
  const path = `/api/bots/${botId}/permissions/refresh`;
  useEffect(() => {
    let current = true;
    setMessage("");
    setConfirm(false);
    setPreview(null);
    // Compare saved levels, never an optimistic downgrade and its rollback.
    void flushBotPatches(botId).then(() => api(path, { method: "POST", body: JSON.stringify({ scope: "open" }) })).then(value => {
      if (current) setPreview(value as BulkPreview);
    }, () => { if (current) setPreview(null); });
    return () => { current = false; };
  }, [path, botId, mode, flushBotPatches]);
  const review = async () => {
    if (!acknowledged) { onConfirmLevel(); return; }
    setBusy(true); setMessage("");
    try { setPreview(await api(path, { method: "POST", body: JSON.stringify({ scope: "open" }) }) as BulkPreview); setConfirm(true); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const reviewRef = useRef(review);
  reviewRef.current = review;
  useEffect(() => { if (reviewAsk > 0) void reviewRef.current(); }, [reviewAsk]);
  const apply = async () => {
    if (!preview) return;
    await applyPermissionPreviewOnce(applying, async () => {
      setBusy(true); setMessage("");
      try {
        const result = await api(path, { method: "POST", body: JSON.stringify({ scope: "open", rosterId: preview.rosterId, targetLevel: preview.targetLevel, afterRev: preview.botRev }) }) as { changed: ChangedThread[] };
        setMessage(`${result.changed.length} conversations now use this approval level.`); setPreview(null); setConfirm(false);
      } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); setConfirm(false); }
      finally { setBusy(false); }
    });
  };
  const label = preview && ({ ask: "Ask", auto: "Auto", full: "Full access", "no-limits": "No limits" }[preview.targetLevel]);
  return <div className="mt-3 text-[13px]">
    {!!preview?.eligible.length && !confirm && <button type="button" disabled={busy} onClick={() => void review()}>Apply to my open conversations</button>}
    {confirm && preview && <div role="dialog" data-box-exempt="inline confirm inside a section" aria-label="Apply approval level">
      <p>Raise {preview.eligible.length} conversations to {label}. Conversations already at a higher level keep it.</p>
      <p>{preview.skipped.length} conversations keep their current level. Busy conversations can be reviewed again later.</p>
      <p>Rooms: Follows the bot default.</p>
      <button type="button" disabled={busy || !preview.eligible.length} onClick={() => void apply()}>Apply to {preview.eligible.length} conversations</button>
      <button type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
