import { useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { canTalkMode, everyoneState, pickedIds, rowState, type CanTalkMode } from "@/lib/can-talk-to";

const MODES: CanTalkMode[] = ["team", "all", "list"];
const MODE_LABEL = { team: "canTalk.team", all: "canTalk.all", list: "canTalk.pick" } as const;
type Shown = "one-way" | "two-way" | "mixed";
const SHOWN_KEY = { "one-way": "canTalk.oneWay", "two-way": "canTalk.twoWay", mixed: "canTalk.mixed" } as const;

function DirectionToggle({ shown, disabled, reason, label, onChange }: { shown: Shown; disabled: boolean; reason?: string; label: string; onChange: (next: "one-way" | "two-way") => void }) {
  const next = shown === "two-way" ? "one-way" : "two-way";
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      title={reason}
      onClick={() => onChange(next)}
      className={cn("shrink-0 rounded-full border px-2.5 py-0.5 text-[12px] disabled:cursor-not-allowed disabled:opacity-50", shown === "one-way" ? "border-hairline/40 text-ink-secondary" : "border-accent/50 bg-accent/10 text-ink")}
    >
      {t(SHOWN_KEY[shown])}
    </button>
  );
}

const REASON = { "fixed-team": "canTalk.fixedTeam", "fixed-theirs": "canTalk.fixedTheirs" } as const;

/** Per-bot "Can talk to": My team / Everyone / Pick bots, with a One-way or
 * Two-way choice per picked bot. One control, no modal. Widening is a desktop
 * action; any surface may narrow back to My team. */
export function CanTalkToControl({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const desktop = useDesktopSurface();
  const [error, setError] = useState<string | null>(null);
  const mode = canTalkMode(bot);
  const others = state.bots.filter((o) => o.id !== bot.id && !o.hidden);
  const picked = pickedIds(bot, others);

  const save = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/message-allow`, { method: "PATCH", body: JSON.stringify(body) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const choose = (next: CanTalkMode) => {
    if (next === mode) return;
    void save(next === "team" ? { mode: "team" } : next === "all" ? { mode: "all" } : { mode: "list", botIds: picked });
  };
  const togglePick = (other: Bot) => {
    const ids = new Set(picked);
    if (ids.has(other.id)) ids.delete(other.id); else ids.add(other.id);
    void save({ mode: "list", botIds: [...ids] });
  };
  const setDirections = (targets: Bot[], direction: "one-way" | "two-way") => {
    const directions = Object.fromEntries(targets.filter((o) => rowState(bot, o).canChange).map((o) => [o.id, direction]));
    void save(mode === "all" ? { mode: "all", directions } : { mode: "list", botIds: picked, directions });
  };
  const everyone = everyoneState(bot, others);

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("canTalk.label")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("canTalk.hint", { name: bot.name })}</div>
      <div role="radiogroup" aria-label={t("canTalk.label")} className="mt-3 flex gap-1.5">
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            disabled={!desktop && m !== "team"}
            onClick={() => choose(m)}
            className={cn("flex-1 rounded-lg border px-3 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-60", mode === m ? "border-accent/50 bg-accent/10 text-ink" : "border-hairline/40 text-ink-secondary hover:bg-raised/50")}
          >
            {t(MODE_LABEL[m])}
          </button>
        ))}
      </div>
      {!desktop && <div className="mt-2 text-[12.5px] text-ink-secondary">{t("canTalk.desktopOnly")}</div>}
      {mode === "all" && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-ink-secondary">{t("canTalk.everyoneHint", { name: bot.name })}</span>
          <DirectionToggle
            shown={everyone.label}
            disabled={!desktop || !everyone.canChange}
            reason={!everyone.canChange ? t("canTalk.fixedTeam") : undefined}
            label={t("canTalk.direction", { name: bot.name, other: t("canTalk.all") })}
            onChange={(next) => setDirections(others, next)}
          />
        </div>
      )}
      {mode === "list" && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {others.length === 0 && <li className="text-[12.5px] text-ink-secondary">{t("canTalk.none")}</li>}
          {others.map((o) => {
            const row = rowState(bot, o);
            const isPicked = picked.includes(o.id);
            return (
              <li key={o.id} className="flex items-center justify-between gap-3">
                <label className="flex min-w-0 items-center gap-2 text-[13px] text-ink">
                  <input type="checkbox" checked={isPicked} disabled={!desktop} onChange={() => togglePick(o)} />
                  <span className="truncate">{o.name}</span>
                </label>
                {isPicked && (
                  <DirectionToggle
                    shown={row.label}
                    disabled={!desktop || !row.canChange}
                    reason={row.kind === "fixed-team" || row.kind === "fixed-theirs" ? t(REASON[row.kind], { other: o.name }) : undefined}
                    label={t("canTalk.direction", { name: bot.name, other: o.name })}
                    onChange={(next) => setDirections([o], next)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {mode !== "team" && <div className="mt-2 text-[12.5px] text-ink-secondary">{t("canTalk.directionHint")}</div>}
      {error && <div className="mt-2 text-[12.5px] text-warning">{error}</div>}
    </div>
  );
}
