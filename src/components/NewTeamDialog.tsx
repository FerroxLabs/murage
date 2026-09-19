// "New Team" from the sidebar's + menu: a name, the bots, an optional lead and
// optional instructions, in one dialog. The rules and the create sequence live
// in lib/new-team.ts; this draws them and owns the draft.
import { useEffect, useMemo, useRef, useState } from "react";

import { botRole, botRolePatch, type RoleBot } from "@/lib/bot-role";
import { cn } from "@/lib/cn";
import {
  LEADERSHIP_BLOCKED_HINT,
  TEAM_NAME_MAX,
  createTeam,
  defaultTeamLead,
  existingTeamNames,
  leadershipPromotionBlocked,
  newTeamProblem,
  teamCandidates,
} from "@/lib/new-team";
import { saveSectionContext } from "@/lib/section-context-client";
import { api, useStore, type Bot } from "@/state/store";
import { BotPickerList } from "./BotPickerList";

export interface NewTeamDraftState {
  name: string;
  picked: Set<string>;
  /** undefined until the person chooses; the default lead applies until then */
  lead: string | undefined;
  instructions: string;
}

/** A bot's second line: which team it is in now, and that ticking moves it. */
export function newTeamBotDetail(bot: RoleBot, picked: boolean): string | undefined {
  const current = bot.section?.trim();
  if (!current) return undefined;
  const where = botRole(bot) === "leader" ? `Leads ${current}` : `Now in ${current}`;
  return picked ? `${where}. Moves to this team.` : where;
}

export interface NewTeamDialogBodyProps {
  bots: Bot[];
  existing: string[];
  canLead: (bot: Bot) => boolean;
  draft: NewTeamDraftState;
  busy: boolean;
  error: string | null;
  onName: (name: string) => void;
  onToggle: (id: string) => void;
  onLead: (id: string) => void;
  onInstructions: (text: string) => void;
  onCreate: () => void;
  onClose: () => void;
}

/** Rendering only, so the markup can be asserted without a store or a DOM. */
export function NewTeamDialogBody({
  bots, existing, canLead, draft, busy, error, onName, onToggle, onLead, onInstructions, onCreate, onClose,
}: NewTeamDialogBodyProps) {
  const chosen = bots.filter((bot) => draft.picked.has(bot.id));
  const problem = newTeamProblem({ name: draft.name, botIds: [...draft.picked] }, bots, existing);
  const lead = draft.lead ?? defaultTeamLead([...draft.picked], bots);
  const cannotLead = chosen.filter((bot) => botRole(bot) !== "leader" && !canLead(bot));
  const leadBlocked = Boolean(lead) && cannotLead.some((bot) => bot.id === lead);
  const disabled = busy || problem !== null || leadBlocked;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-team-title"
      aria-describedby="new-team-help"
      className="max-h-[calc(var(--vvh,100dvh)-24px)] w-[380px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
    >
      <div id="new-team-title" className="text-[15px] font-semibold text-ink">New Team</div>
      <p id="new-team-help" className="mb-3 mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
        A team is a group of bots that work together. It gets its own heading in the sidebar.
      </p>
      <input
        autoFocus
        aria-label="Team name"
        maxLength={TEAM_NAME_MAX}
        value={draft.name}
        onChange={(e) => onName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !disabled) onCreate();
        }}
        placeholder="Team name (for example, Operations)"
        className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
      />
      <div className="mb-1 text-[12px] font-medium text-ink-secondary">Bots in this team</div>
      <BotPickerList
        bots={bots}
        picked={draft.picked}
        onToggle={onToggle}
        emptyHint="Create a bot first. Teams are made of bots."
        detail={newTeamBotDetail}
      />
      {chosen.length > 0 && (
        <label className="mt-3 block">
          <span className="mb-1 block text-[12px] font-medium text-ink-secondary">Team lead (optional)</span>
          <select
            aria-label="Team lead"
            value={lead}
            onChange={(e) => onLead(e.target.value)}
            className="w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink focus:outline-none"
          >
            <option value="">No lead</option>
            {chosen.map((bot) => (
              <option key={bot.id} value={bot.id} disabled={cannotLead.includes(bot)}>
                {cannotLead.includes(bot) ? `${bot.name} (can't lead yet)` : bot.name}
              </option>
            ))}
          </select>
          {cannotLead.length > 0 && (
            <span className="mt-1 block text-[12px] leading-relaxed text-ink-secondary">
              {cannotLead.map((bot) => bot.name).join(", ")} can't lead yet. {LEADERSHIP_BLOCKED_HINT}.
            </span>
          )}
        </label>
      )}
      <label className="mt-3 block">
        <span className="mb-1 block text-[12px] font-medium text-ink-secondary">Team instructions (optional)</span>
        <textarea
          aria-label="Team instructions"
          value={draft.instructions}
          onChange={(e) => onInstructions(e.target.value)}
          rows={3}
          placeholder="What should every bot on this team know?"
          className="w-full resize-y rounded-lg bg-raised/70 px-3 py-2 text-[14px] leading-relaxed text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </label>
      <div role="status" aria-live="polite" className={cn("mt-2 min-h-[1.25rem] text-[12.5px] leading-relaxed", error ? "text-danger" : "text-ink-secondary")}>
        {error ?? problem ?? ""}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-[14px] text-ink-secondary hover:bg-raised/70 hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={disabled}
          className="flex-1 rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Creating…" : `Create Team${chosen.length ? ` · ${chosen.length} ${chosen.length === 1 ? "bot" : "bots"}` : ""}`}
        </button>
      </div>
    </div>
  );
}

export function NewTeamDialog({ onClose, onDone }: { onClose: () => void; onDone: (feedback: { error: boolean; text: string }) => void }) {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<NewTeamDraftState>({ name: "", picked: new Set(), lead: undefined, instructions: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const bots = useMemo(() => teamCandidates(state.bots), [state.bots]);
  const existing = useMemo(() => existingTeamNames(state.bots, state.groups), [state.bots, state.groups]);
  const canLead = (bot: Bot) => {
    const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
    return !leadershipPromotionBlocked(botRole(bot), engine?.capabilities?.agentsMcp === true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await createTeam(
      {
        name: draft.name,
        botIds: bots.filter((bot) => draft.picked.has(bot.id)).map((bot) => bot.id),
        leadId: draft.lead ?? defaultTeamLead([...draft.picked], bots),
        instructions: draft.instructions,
      },
      bots,
      {
        request: (path, init) => api(path, init),
        applyBots: (filed) => {
          for (const bot of filed) dispatch({ type: "botPatched", bot });
        },
        setRole: (botId, role) => dispatch({ type: "updateBot", botId, patch: botRolePatch(role) }),
        saveInstructions: (section, text) => saveSectionContext(section, text, api),
      },
    );
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      // Nothing was filed, so the draft stays for another try.
      setError(result.error);
      return;
    }
    onDone(result.error ? { error: true, text: result.error } : { error: false, text: result.text });
    onClose();
  };

  return (
    <div
      className="fixed inset-x-0 top-0 z-40 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && !busyRef.current && onClose()}
    >
      <NewTeamDialogBody
        bots={bots}
        existing={existing}
        canLead={canLead}
        draft={draft}
        busy={busy}
        error={error}
        onName={(name) => { setError(null); setDraft((d) => ({ ...d, name })); }}
        onToggle={(id) => {
          setError(null);
          setDraft((d) => {
            const picked = new Set(d.picked);
            if (picked.has(id)) picked.delete(id);
            else picked.add(id);
            // A lead who is no longer on the team is no lead.
            const lead = d.lead && !picked.has(d.lead) ? undefined : d.lead;
            return { ...d, picked, lead };
          });
        }}
        onLead={(lead) => setDraft((d) => ({ ...d, lead }))}
        onInstructions={(instructions) => setDraft((d) => ({ ...d, instructions }))}
        onCreate={() => void create()}
        onClose={onClose}
      />
    </div>
  );
}
