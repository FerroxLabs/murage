import { Check, Hand, ShieldCheck, ShieldOff, Zap } from "lucide-react";
import { FULL_ACCESS_DESKTOP_ONLY, NO_LIMITS_DESKTOP_ONLY, isDesktopOnlyMode, type PermissionMode } from "@/lib/permission-mode";

export const PERMISSION_MODES: ReadonlyArray<{ mode: PermissionMode; label: string; chip: string; detail: string }> = [
  { mode: "ask", label: "Ask for approval", chip: "Ask", detail: "Ask before actions that need your permission" },
  { mode: "auto", label: "Auto mode", chip: "Auto", detail: "Keep going automatically; destructive and sensitive actions still ask" },
  {
    mode: "full",
    label: "Full access",
    chip: "Full access",
    detail: "Keeps going without asking, but stops before deleting outside its folder, paying, messaging someone new, or reading your keys",
  },
  {
    mode: "unlimited",
    label: "No limits",
    chip: "No limits",
    detail: "Does anything without asking, except reading your keys and passwords.",
  },
];

export const PermissionModeIcon = ({ mode, size, className }: { mode: PermissionMode; size: number; className: string }) =>
  mode === "unlimited" ? <Zap size={size} className={className} /> : mode === "full" ? <ShieldOff size={size} className={className} /> : mode === "auto" ? <ShieldCheck size={size} className={className} /> : <Hand size={size} className={className} />;

/** The composer chip's menu. Full access is the desktop app's decision alone
 * (server/full-access.ts), so away from it the choice is shown but not
 * offered, with the reason in its place. */
export function PermissionModeMenu({
  botName,
  current,
  desktop,
  onPick,
}: {
  botName: string;
  current: PermissionMode;
  /** useDesktopSurface(): false on a phone or the browser door */
  desktop: boolean | undefined;
  onPick: (mode: PermissionMode) => void;
}) {
  return (
    <div
      role="menu"
      aria-label={`Permission mode for ${botName}`}
      className="absolute bottom-full left-0 z-30 mb-2 w-80 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
    >
      <div className="border-b border-hairline/20 px-4 py-3 text-[13px] font-medium text-ink-secondary">
        How should {botName}’s actions be approved?
      </div>
      <div className="flex flex-col py-1">
        {PERMISSION_MODES.map((entry) => {
          const unavailable = desktop === false && isDesktopOnlyMode(entry.mode);
          return (
            <button
              key={entry.mode}
              type="button"
              role="menuitemradio"
              aria-checked={current === entry.mode}
              disabled={unavailable}
              onClick={() => onPick(entry.mode)}
              className="flex items-start gap-3 px-4 py-3 text-left hover:bg-raised-hover disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <PermissionModeIcon mode={entry.mode} size={16} className="mt-0.5 shrink-0 opacity-70" />
              <div className="flex w-full flex-col gap-0.5">
                <div className={unavailable ? "flex items-center justify-between text-[14px] text-ink-secondary" : "flex items-center justify-between text-[14px] text-ink"}>
                  {entry.label}
                  {current === entry.mode && <Check size={14} />}
                </div>
                <div className="text-[13px] text-ink-secondary">{unavailable ? (entry.mode === "unlimited" ? NO_LIMITS_DESKTOP_ONLY : FULL_ACCESS_DESKTOP_ONLY) : entry.detail}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
