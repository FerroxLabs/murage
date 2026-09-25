import type { Bot } from "@/state/store";
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
      ? "Does anything without asking, except reading your keys and passwords. That includes this computer. Webhook and routine turns still ask."
      : "Does anything without asking, except reading your keys and passwords. Webhook and routine turns still ask.";
  }
  if (mode === "full") {
    return onThisComputer
      ? "Keeps going without asking, including on this computer and before contacting other bots, but stops before deleting outside its folder, paying, messaging someone new, or reading your keys. Webhook and routine turns still ask."
      : "Keeps going without asking, including before contacting other bots, but stops before deleting outside its folder, paying, messaging someone new, or reading your keys. Webhook and routine turns still ask.";
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
  onThisComputer,
  desktop,
  onChoose,
  onOption,
}: {
  bot: Pick<Bot, "autoApprove" | "fullAccess" | "noLimits" | "fullAccessChannelMessages" | "fullAccessSetupRequests">;
  /** the bot drives this computer (changes the wording only) */
  onThisComputer: boolean;
  /** this renderer is the desktop app (useDesktopSurface): false on a phone
   * or the browser door, where Full access and its options are refused */
  desktop?: boolean;
  onChoose: (mode: PermissionMode) => void;
  onOption: (key: FullAccessOption, value: boolean) => void;
}) {
  const current = permissionModeOf(bot);
  const full = current === "full" || current === "unlimited";
  const remote = desktop === false;
  const options: ReadonlyArray<{ key: FullAccessOption; label: string; hint: string }> = [
    { key: "fullAccessChannelMessages", label: FULL_ACCESS_CHANNEL_OPTION, hint: "Messages from anyone else and webhooks still ask. Routines use their own level." },
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
              checked={bot[key] === true}
              disabled={!full || remote}
              aria-label={label}
              onClick={() => onOption(key, bot[key] !== true)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
