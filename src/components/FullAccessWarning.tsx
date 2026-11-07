import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { AlertTriangle } from "lucide-react";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

/** Shown once per bot, on the desktop, before Full access is switched on. */
export const FULL_ACCESS_WARNING =
  "This bot will not ask before running commands, editing files or contacting other bots.";

/** What Full access still stops at (server/stop-line.ts). */
export const FULL_ACCESS_STOP_LINE =
  "It still asks before deleting anything outside its folder, paying for anything, messaging someone new or posting in public, and reading your keys and passwords.";


/** Images follow the level now (server/image-approval.ts): made without a card in
 * the owner's own conversations and routines, with a record, unless the bot's Images setting says otherwise. */
export const FULL_ACCESS_IMAGES =
  "It also makes images without asking in your own conversations and routines, and leaves a record of each. Change that under Images in Bot settings.";

/** Which level the dialog switches on: a conversation's (the composer chip),
 * the bot's own (Bot settings), or one routine's. A routine run is judged at
 * the lower of its routine's level and the bot's own
 * (server/routine-permissions.ts), never at a conversation's. */
export type FullAccessScope = "conversation" | "bot" | { routine: string };

export function fullAccessScopeNote(scope: FullAccessScope): string {
  if (scope === "conversation") return "This is for this conversation only. Routines use the level in Bot settings, Permissions, unless a routine has its own.";
  if (scope === "bot") return "Routines keep their own level and never run above this one.";
  return `This is for the routine ${scope.routine} only.`;
}

export const FULL_ACCESS_ASKS_UNLESS_ALLOWED =
  "Your own messages from Telegram, Slack or Discord, and setup requests like installing skills, proposing routines or trusting folders, also still ask unless you allow them in Bot Settings.";

export const FULL_ACCESS_ON_THIS_COMPUTER =
  "On this computer that includes your own screen, mouse and keyboard.";

/** Shown once per bot before No limits is switched on (NOLIMITS v1 copy W; every pack has `noLimits.v1.warning`). */
export const NO_LIMITS_WARNING = t("noLimits.v1.warning");

/** The line above the warning when an owner who already had No limits reads the new terms (NOLIMITS-MEANS-IT section 6). */
export const NO_LIMITS_TERMS_LINE = "No limits changed. Read this once and it applies to every bot.";

export function FullAccessWarning({
  open,
  botName,
  level = "full",
  scope,
  onThisComputer,
  terms = false,
  openClaw = false,
  onCancel,
  onConfirm,
}: {
  /** the bot runs on OpenClaw, which runs commands without asking Murage (copy O) */
  openClaw?: boolean;
  open: boolean;
  botName: string;
  /** which level this confirms: Full access, or No limits above it */
  level?: "full" | "unlimited";
  /** what the switch covers; absent says nothing about it */
  scope?: FullAccessScope;
  /** the bot drives this computer, so the Auto-on-this-computer warning is
   * confirmed by this same dialog */
  onThisComputer: boolean;
  /** the owner is reading the new No limits terms, for every bot, not switching one on */
  terms?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Cancel is the default: this is the one switch that removes every stop.
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="overlay-inset fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="full-access-warning-title"
        aria-describedby="full-access-warning-body"
        className={`${BOX_FRAME} max-h-[calc(var(--vvh,100dvh)-3rem)] w-full max-w-[440px] rounded-2xl border border-hairline/50 bg-panel shadow-2xl`}
      >
        <BoxHead className="items-start justify-start px-5 pt-5">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
            <h2 id="full-access-warning-title" className="min-w-0 text-[15px] font-semibold text-ink">
              {terms ? "No limits" : level === "unlimited" ? `Give @${botName} no limits?` : `Give @${botName} full access?`}
            </h2>
        </BoxHead>
        <BoxBody className="pl-[50px] pr-5">
            <div id="full-access-warning-body" className="mt-1.5 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink-secondary">
              {terms && <p className="font-medium text-ink">{NO_LIMITS_TERMS_LINE}</p>}
              <p className="font-medium text-ink">{level === "unlimited" ? t("noLimits.v1.warning") : FULL_ACCESS_WARNING}</p>
              {level === "unlimited" && openClaw && <p>{t("noLimits.v1.openclaw")}</p>}
              {level === "unlimited" && <p>{t("noLimits.v1.windows")}</p>}
              {level === "full" && <p>{FULL_ACCESS_STOP_LINE}</p>}
              {onThisComputer && <p>{FULL_ACCESS_ON_THIS_COMPUTER}</p>}
              {scope && <p>{fullAccessScopeNote(scope)}</p>}
              <p>{t("ux.lcopyb.fullAccess.stillAsks")}</p>
              <p>{FULL_ACCESS_IMAGES}</p>
              <p>{FULL_ACCESS_ASKS_UNLESS_ALLOWED}</p>
              {terms
                ? <p>Not now changes nothing: your bots keep asking as they do today. You can review this later in Bot settings.</p>
                : <p>You are asked this once for this bot. Switch back to {level === "unlimited" ? "Full access, " : ""}Auto or Ask at any time.</p>}
            </div>
        </BoxBody>
        <BoxFoot className="px-5 pb-5 pt-4">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {terms ? "Not now" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110"
          >
            {terms ? "Accept" : level === "unlimited" ? "Turn on no limits" : "Turn on full access"}
          </button>
        </BoxFoot>
      </div>
    </div>
  );
}
