import { Suspense, type ReactNode } from "react";
import { Check, Hand, ShieldCheck, ShieldOff, Zap } from "lucide-react";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { isDesktopOnlyMode, type PermissionMode } from "@/lib/permission-mode";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { levelName } from "@/lib/fold-words";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";

// The level table opens from a fold most menus never open, so it stays off the first paint.
const LevelExamplesChunk = retryableLazy(() => import("@/components/approval/LevelExamples").then((module) => ({ default: module.LevelExamples })));

/** The four levels, named exactly Ask, Auto, Full access, No limits (the
 * frozen names). `detail` is read from the catalogue when it is used, not
 * when this module loads, so it follows the locale in force. */
const level = (mode: PermissionMode, detailKey: LocaleKey) => ({
  mode, label: levelName(mode), chip: levelName(mode),
  get detail() { return t(detailKey); },
});
export const PERMISSION_MODES: ReadonlyArray<{ mode: PermissionMode; label: string; chip: string; readonly detail: string }> = [
  level("ask", "ux.l1.level.askDetail"),
  // UX-TRUST-MOMENTS-1012 section 8 rows 16, 17: a send to someone it knows goes ahead at Auto
  level("auto", "ux.l1.level.autoDetail"),
  level("full", "ux.l1.level.fullDetail"),
  level("unlimited", "ux.l1.level.unlimitedDetail"),
];

/** The engines whose headless mode has no way to ask before acting. At every
 *  level Murage runs them with file edits only (see sendTurn in
 *  server/drivers/antigravity.ts), so they get no shell, teammates, memory or
 *  connected apps, rather than let them act with nobody asked. */
const ENGINES_THAT_CANNOT_ASK = new Set(["antigravityAgent"]);
export const engineCannotAsk = (driverKind: string | undefined): boolean => Boolean(driverKind && ENGINES_THAT_CANNOT_ASK.has(driverKind));
/** An engine that brings its own tools (OpenClaw, the one driver with
 *  `ownTools`). At Ask its turn runs read-only with commands denied
 *  (server/drivers/acp/openclaw.ts); at the other levels Murage sends no
 *  directive, so the owner's own OpenClaw command settings apply. */
export const ownApprovalsNote = (engine: string) => t("permissionMenu.ownTools", { engine });
const cannotAskNote = (engine: string) => t("permissionMenu.cannotAsk", { engine });

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
  engineCannotAsk: cannotAskEngine,
  engineOwnApprovals,
  scope,
  footer,
  botDefault,
}: {
  /** 3.1: the bot's default level for new conversations, for the header line */
  botDefault?: PermissionMode;
  botName: string;
  /** Below the levels: this chat's Refresh permissions (1.0.4 SL-K K3), desktop only. */
  footer?: ReactNode;
  /** The composer's menu: in a routine's own conversation it sets that
   * routine's level; anywhere else, only this conversation's. Absent says
   * nothing about it. */
  scope?: { routine?: string };
  /** The engine's name when it cannot ask before acting (engineCannotAsk). */
  engineCannotAsk?: string;
  /** The engine's name when it runs on its own tools and approvals. */
  engineOwnApprovals?: string;
  current: PermissionMode;
  /** useDesktopSurface(): false on a phone or the browser door */
  desktop: boolean | undefined;
  onPick: (mode: PermissionMode) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  return (
    <div
      role="menu"
      aria-label={`Permission mode for ${botName}`}
      className="absolute bottom-full left-0 z-30 mb-2 max-h-[80vh] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-hairline/40 bg-raised shadow-lg"
    >
      <div className="border-b border-hairline/20 px-4 py-3 text-[13px] font-medium text-ink-secondary">
        {scope?.routine ? `How should runs of ${scope.routine} be approved?` : <>How should {botName}’s actions be approved?</>}
        {scope && (
          <div className="mt-1 text-[12px] font-normal">
            {scope.routine
              ? `Changes the level of the routine ${scope.routine}. Every run of it works here.`
              : t("ux.l1.level.chipHeader", { bot: botName, level: levelName(botDefault ?? current) })}
          </div>
        )}
      </div>
      {engineOwnApprovals && <div className="border-b border-hairline/20 px-4 py-2 text-[13px] text-warning">{ownApprovalsNote(engineOwnApprovals)}</div>}
      <div className="flex flex-col py-1">
        {PERMISSION_MODES.map((entry) => {
          // 3.4: away from the desktop, Full access and No limits are listed
          // greyed; a tap says where they are set, nothing else
          const unavailable = desktop === false && isDesktopOnlyMode(entry.mode);
          return (
            <button
              key={entry.mode}
              type="button"
              role="menuitemradio"
              aria-checked={current === entry.mode}
              aria-disabled={unavailable || undefined}
              data-level-option={entry.mode}
              onClick={() => (unavailable ? setNotice(t("ux.l1.level.onComputer")) : onPick(entry.mode))}
              className={cn("flex min-h-11 items-start gap-3 px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent", unavailable ? "cursor-not-allowed" : "hover:bg-raised-hover")}
            >
              <PermissionModeIcon mode={entry.mode} size={16} className="mt-0.5 shrink-0 opacity-70" />
              <div className="flex w-full flex-col gap-0.5">
                <div className={unavailable ? "flex items-center justify-between text-[14px] text-ink-secondary" : "flex items-center justify-between text-[14px] text-ink"}>
                  {entry.label}
                  {current === entry.mode && <Check size={14} />}
                </div>
                <div className="text-[13px] text-ink-secondary">{unavailable ? t("ux.l1.level.onComputer") : entry.detail}</div>
                {!unavailable && cannotAskEngine && (
                  <div className="text-[13px] text-warning">{cannotAskNote(cannotAskEngine)}</div>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {desktop === false && <p className="px-4 pb-2 text-[12px] text-ink-secondary" data-level-lock>{t("ux.l1.level.lockLine")}</p>}
      <p role="status" className="px-4 text-[12.5px] text-ink empty:hidden">{notice}</p>
      <details className="border-t border-hairline/20 px-4 py-2" data-level-table onToggle={(event) => setTableOpen(event.currentTarget.open)}>
        <summary className="flex min-h-11 cursor-pointer items-center text-[13px] text-ink-secondary hover:text-ink">{t("ux.l1.level.tableToggle")}</summary>
        {tableOpen && <LazyBoundary inline onRetry={LevelExamplesChunk.retry} onDismiss={() => setTableOpen(false)}><Suspense fallback={null}><LevelExamplesChunk.Component current={current} only={desktop === false ? current : undefined} className="max-h-72 overflow-y-auto pb-1" /></Suspense></LazyBoundary>}
      </details>
      {footer}
    </div>
  );
}
