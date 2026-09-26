// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Team settings: rename a team, change who is on it and who leads it, and
// delete it. Opened from a team heading's menu in the sidebar and from a
// channel's details. The rules and the calls live in lib/team-manage.ts; the
// harness (server/team-sections.ts) has the last word on every change.
//
// Same modal contract as ChannelDetailsPanel: focus lands on the field the
// person asked for, Escape closes, Tab stays inside, and focus goes back to
// whatever opened it. Delete asks inline, never with a browser confirm().
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

import { botRole } from "@/lib/bot-role";
import { cn } from "@/lib/cn";
import { LEADERSHIP_BLOCKED_HINT, TEAM_NAME_MAX, existingTeamNames, leadershipPromotionBlocked, teamCandidates } from "@/lib/new-team";
import {
  OPEN_TEAM_SETTINGS_EVENT,
  loadTeam,
  removeTeam,
  saveTeamMembers,
  saveTeamName,
  teamCandidateDetail,
  teamDeleteSummary,
  teamMembersChange,
  teamMembersSavedNote,
  teamChangePatches,
  toggledMembers,
  teamRenameProblem,
  type OpenTeamSettingsDetail,
  type TeamChanges,
  type TeamDeleteChoice,
  type TeamSettingsFocus,
  type TeamView,
} from "@/lib/team-manage";
import { api, useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";

const CARD = "rounded-xl border border-hairline/40 bg-panel/60 p-3.5";
const LABEL = "text-[13px] font-semibold text-ink";
const NOTE = "mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary";
const FIELD =
  "min-h-11 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none";
const BUTTON =
  "min-h-11 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:brightness-110 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const PRIMARY =
  "min-h-11 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const DANGER =
  "min-h-11 rounded-lg bg-danger px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export interface TeamSettingsDialogBodyProps {
  team: TeamView;
  /** every bot the members list offers: visible, never the Chief of Staff */
  candidates: Bot[];
  existing: string[];
  canLead: (bot: Bot) => boolean;
  name: string;
  picked: Set<string>;
  /** "" for no lead */
  lead: string;
  confirmingDelete: boolean;
  deleteChoice: TeamDeleteChoice;
  busy: boolean;
  status: { error: boolean; text: string } | null;
  onName: (name: string) => void;
  onSaveName: () => void;
  onToggle: (id: string) => void;
  onLead: (id: string) => void;
  onSaveMembers: () => void;
  onAskDelete: () => void;
  onDeleteChoice: (choice: TeamDeleteChoice) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClose: () => void;
}

/** Rendering only, so the markup can be asserted without a store or a DOM. */
export function TeamSettingsDialogBody(props: TeamSettingsDialogBodyProps) {
  const { team, candidates, existing, canLead, name, picked, lead, confirmingDelete, deleteChoice, busy, status } = props;
  const renameProblem = teamRenameProblem(name, team.name, existing);
  const unchangedName = name.trim() === team.name;
  const change = teamMembersChange(team, picked, lead);
  const chosen = candidates.filter((bot) => picked.has(bot.id));
  const cannotLead = chosen.filter((bot) => botRole(bot) !== "leader" && !canLead(bot));
  const leadBlocked = Boolean(lead) && cannotLead.some((bot) => bot.id === lead);
  const archivedMembers = team.members.filter((bot) => bot.archived).length;
  const teamChannel = team.channels.find((channel) => channel.name.trim().toLocaleLowerCase() === team.name.toLocaleLowerCase());
  const noun = team.members.length ? "team" : "section";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="team-settings-title"
      className="flex max-h-[min(760px,calc(var(--vvh,100dvh)-1.5rem))] w-[min(560px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3 border-b border-hairline/40 px-4 py-3">
        <div className="min-w-0">
          <div id="team-settings-title" className="truncate text-[15px] font-semibold text-ink">
            {team.name}
          </div>
          <div className="truncate text-[12.5px] text-ink-secondary">Team settings</div>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close team settings"
          title="Close"
          className={cn(BUTTON, "flex size-11 shrink-0 items-center justify-center p-0")}
        >
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <section className={CARD} aria-labelledby="team-settings-name">
          <h3 id="team-settings-name" className={LABEL}>
            Name
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              data-team-focus="rename"
              aria-label="Team name"
              maxLength={TEAM_NAME_MAX}
              value={name}
              onChange={(event) => props.onName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !renameProblem && !busy) props.onSaveName();
              }}
              className={cn(FIELD, "min-w-0 flex-1 basis-48")}
            />
            <button type="button" onClick={props.onSaveName} disabled={busy || Boolean(renameProblem)} className={PRIMARY}>
              Save name
            </button>
          </div>
          <p className={NOTE}>
            {!unchangedName && renameProblem
              ? renameProblem
              : `Its bots, channels, instructions and team memory keep working under the new name.${teamChannel ? ` Its channel ${teamChannel.name} is renamed too.` : ""}`}
          </p>
        </section>

        <section className={CARD} aria-labelledby="team-settings-members">
          <h3 id="team-settings-members" className={LABEL}>
            Bots on this team
          </h3>
          <p className={NOTE}>Bots on a team can ask and hand work to each other. Bots you remove stay, without a team.</p>
          <div className="mt-2 flex max-h-72 flex-col gap-0.5 overflow-y-auto" role="group" aria-label="Bots on this team">
            {candidates.length === 0 && <p className={NOTE}>Create a bot first. Teams are made of bots.</p>}
            {candidates.map((bot, index) => {
              const on = picked.has(bot.id);
              const detail = teamCandidateDetail(bot, team.name, on);
              return (
                <button
                  key={bot.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={bot.name}
                  aria-describedby={detail ? `team-member-detail-${index}` : undefined}
                  data-team-focus={index === 0 ? "members" : undefined}
                  onClick={() => props.onToggle(bot.id)}
                  className="flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <BotAvatar bot={bot} state="happy" size={28} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[14px] text-ink">{bot.name}</span>
                    {detail && (
                      <span id={`team-member-detail-${index}`} className="truncate text-[12px] text-ink-secondary">
                        {detail}
                      </span>
                    )}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
                      on ? "border-accent bg-accent text-white" : "border-hairline/60",
                    )}
                  >
                    {on && <Check size={12} />}
                  </span>
                </button>
              );
            })}
          </div>
          {archivedMembers > 0 && (
            <p className={NOTE}>
              {archivedMembers} archived {archivedMembers === 1 ? "bot stays" : "bots stay"} on this team. Restore{" "}
              {archivedMembers === 1 ? "it" : "them"} from Archived bots to change that.
            </p>
          )}
          <label className="mt-3 block">
            <span className="mb-1 block text-[12.5px] font-medium text-ink-secondary">Team lead</span>
            <select aria-label="Team lead" value={lead} onChange={(event) => props.onLead(event.target.value)} className={FIELD}>
              <option value="">No lead</option>
              {chosen.map((bot) => (
                <option key={bot.id} value={bot.id} disabled={cannotLead.includes(bot)}>
                  {cannotLead.includes(bot) ? `${bot.name} (can't lead yet)` : bot.name}
                </option>
              ))}
            </select>
            <span className={cn(NOTE, "block")}>
              {cannotLead.length > 0
                ? `${cannotLead.map((bot) => bot.name).join(", ")} can't lead yet. ${LEADERSHIP_BLOCKED_HINT}.`
                : "The lead coordinates the team and is the one the Chief of Staff hands work to."}
            </span>
          </label>
          <div className="mt-3">
            <button type="button" onClick={props.onSaveMembers} disabled={busy || !change || leadBlocked} className={PRIMARY}>
              Save members
            </button>
          </div>
        </section>

        <section className={CARD} aria-labelledby="team-settings-delete">
          <h3 id="team-settings-delete" className={LABEL}>
            Delete {noun}
          </h3>
          {!confirmingDelete ? (
            <>
              <p className={NOTE}>Removes the heading from the sidebar. No bot, channel or conversation is deleted.</p>
              <button type="button" data-team-focus="delete-ask" onClick={props.onAskDelete} disabled={busy} className={cn(BUTTON, "mt-2 text-danger")}>
                Delete {noun}
              </button>
            </>
          ) : (
            <div className="mt-2 rounded-lg border border-danger/40 bg-danger/5 p-3">
              <fieldset>
                <legend className="text-[13px] font-medium text-ink">What should happen to its bots and channels?</legend>
                <div role="radiogroup" aria-label="What happens to its bots" className="mt-2 flex flex-col gap-1">
                  {(
                    [
                      ["keep", "Keep them as bots without a team"],
                      ["archive", "Archive them"],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13.5px] text-ink hover:bg-raised/50">
                      <input
                        type="radio"
                        name="team-delete-choice"
                        value={value}
                        checked={deleteChoice === value}
                        onChange={() => props.onDeleteChoice(value)}
                        className="size-4 accent-[var(--color-accent)]"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12.5px] leading-relaxed text-ink-secondary">
                {teamDeleteSummary(team, deleteChoice).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" data-team-focus="delete" onClick={props.onCancelDelete} disabled={busy} className={BUTTON}>
                  Cancel
                </button>
                <button type="button" onClick={props.onConfirmDelete} disabled={busy} className={DANGER}>
                  Delete {team.name}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      <div
        role="status"
        aria-live="polite"
        className={cn(
          "min-h-[2.25rem] border-t border-hairline/40 px-4 py-2 text-[12.5px] leading-relaxed",
          status?.error ? "text-danger" : "text-ink-secondary",
        )}
      >
        {busy ? "Saving…" : status?.text ?? ""}
      </div>
    </div>
  );
}

/** The dialog with its state. `onRenamed` lets the sidebar carry the
 * heading's place and open/closed state over to the new name. */
export function TeamSettingsDialog({
  section,
  focus,
  onClose,
  onRenamed,
}: {
  section: string;
  focus: TeamSettingsFocus;
  onClose: () => void;
  onRenamed?: (from: string, to: string) => void;
}) {
  const { state, dispatch } = useStore();
  const [team, setTeam] = useState<TeamView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(section);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [lead, setLead] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(focus === "delete");
  const [deleteChoice, setDeleteChoice] = useState<TeamDeleteChoice>("keep");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const focusedOnce = useRef(false);

  const adopt = useCallback((next: TeamView) => {
    setTeam(next);
    setName(next.name);
    setPicked(new Set(next.members.filter((bot) => !bot.archived && !bot.chief).map((bot) => bot.id)));
    setLead(next.leadId ?? "");
  }, []);

  useEffect(() => {
    let live = true;
    loadTeam(section, api).then(
      (next) => live && adopt(next),
      (cause) => live && setLoadError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      live = false;
    };
  }, [section, adopt]);

  const candidates = useMemo(() => {
    const members = new Set(team?.members.map((bot) => bot.id) ?? []);
    // Members first, then everyone else who could join.
    return teamCandidates(state.bots).sort((a, b) => Number(members.has(b.id)) - Number(members.has(a.id)));
  }, [state.bots, team]);
  const existing = useMemo(() => existingTeamNames(state.bots, state.groups), [state.bots, state.groups]);
  const canLead = (bot: Bot) => {
    const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
    return !leadershipPromotionBlocked(botRole(bot), engine?.capabilities?.agentsMcp === true);
  };

  // Focus the part the person asked for, once the team has loaded.
  useEffect(() => {
    if (!team || focusedOnce.current) return;
    focusedOnce.current = true;
    const target = dialogRef.current?.querySelector<HTMLElement>(`[data-team-focus="${focus}"]`);
    (target ?? dialogRef.current?.querySelector<HTMLElement>("button"))?.focus();
  }, [team, focus]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (confirmingDelete) setConfirmingDelete(false);
        else onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      ];
      if (!controls.length) return event.preventDefault();
      const first = controls[0];
      const last = controls[controls.length - 1];
      // A save disables the button that had focus, which drops focus to the
      // page; Tab brings it back inside rather than to the sidebar behind.
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // On the window, so Escape and Tab still work after focus fell out.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmingDelete, onClose, team]);

  // Read after mount, not during render: a panel that closed to open this
  // one has put focus back on its own opener by then.
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const botsRef = useRef(state.bots);
  botsRef.current = state.bots;
  const applyChanges = (changed: TeamChanges) => {
    const patches = teamChangePatches(changed);
    for (const { id, patch } of patches.bots) {
      const current = botsRef.current.find((bot) => bot.id === id);
      if (current) dispatch({ type: "botPatched", bot: { ...current, ...patch } });
    }
    for (const { id, patch } of patches.groups) dispatch({ type: "groupPatched", group: { id, ...patch } });
  };

  // A refusal because the team changed underneath: show what it is now.
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setStatus(null);
    try {
      await work();
    } catch (cause) {
      const error = cause as Error & { status?: number };
      setStatus({ error: true, text: error.message });
      if (error.status === 409 && team) loadTeam(team.name, api).then(adopt, () => {});
    } finally {
      setBusy(false);
    }
  };

  const saveName = () =>
    team &&
    run(async () => {
      const { team: next, changed } = await saveTeamName(team, name, api);
      applyChanges(changed);
      onRenamed?.(team.name, next.name);
      adopt(next);
      setStatus({ error: false, text: `Renamed to ${next.name}.` });
    });

  const saveMembers = () => {
    const change = team && teamMembersChange(team, picked, lead);
    if (!team || !change) return;
    return run(async () => {
      const { team: next, changed } = await saveTeamMembers(team, change, api);
      applyChanges(changed);
      if (!next) {
        setStatus({ error: false, text: `${team.name} has no bots or channels left, so its heading is gone.` });
        onClose();
        return;
      }
      adopt(next);
      // Says what changed, so a save is never reported without one.
      setStatus({ error: false, text: teamMembersSavedNote(change, (id) => candidates.find((bot) => bot.id === id)?.name ?? team.members.find((bot) => bot.id === id)?.name) });
    });
  };

  const confirmDelete = () =>
    team &&
    run(async () => {
      applyChanges((await removeTeam(team, deleteChoice, api)).changed);
      onClose();
    });

  return (
    <div
      ref={dialogRef}
      className="fixed inset-x-0 top-0 z-40 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/40 p-3"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      {team ? (
        <TeamSettingsDialogBody
          team={team}
          candidates={candidates}
          existing={existing}
          canLead={canLead}
          name={name}
          picked={picked}
          lead={lead}
          confirmingDelete={confirmingDelete}
          deleteChoice={deleteChoice}
          busy={busy}
          status={status}
          onName={(next) => {
            setStatus(null);
            setName(next);
          }}
          onSaveName={() => void saveName()}
          onToggle={(id) => {
            // Worked out from the rendered state, with no state setter inside
            // another's updater (React may run an updater twice).
            setStatus(null);
            const next = toggledMembers(picked, id);
            setPicked(next);
            if (lead && !next.has(lead)) setLead("");
          }}
          onLead={setLead}
          onSaveMembers={() => void saveMembers()}
          onAskDelete={() => {
            setConfirmingDelete(true);
            // The panel replaces the button that had focus; Cancel is the
            // choice that changes nothing, so it gets focus.
            window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>('[data-team-focus="delete"]')?.focus(), 0);
          }}
          onDeleteChoice={setDeleteChoice}
          onConfirmDelete={() => void confirmDelete()}
          onCancelDelete={() => {
            setConfirmingDelete(false);
            window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>('[data-team-focus="delete-ask"]')?.focus(), 0);
          }}
          onClose={onClose}
        />
      ) : (
        <div role="dialog" aria-modal="true" aria-label="Team settings" className="rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
          <p className={cn("text-[13px]", loadError ? "text-danger" : "text-ink-secondary")} role="status">
            {loadError ?? "Loading the team…"}
          </p>
          <button type="button" onClick={onClose} className={cn(BUTTON, "mt-3")}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

/** Mounted once (in the sidebar): opens team settings when anything asks
 * through openTeamSettings(). */
export function TeamSettingsHost({ onRenamed }: { onRenamed?: (from: string, to: string) => void }) {
  const [open, setOpen] = useState<OpenTeamSettingsDetail | null>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<OpenTeamSettingsDetail>).detail;
      if (!detail || typeof detail.section !== "string" || !detail.section.trim() || detail.section.length > 200) return;
      setOpen({ section: detail.section, focus: detail.focus === "rename" || detail.focus === "delete" ? detail.focus : "members" });
    };
    window.addEventListener(OPEN_TEAM_SETTINGS_EVENT, listener);
    return () => window.removeEventListener(OPEN_TEAM_SETTINGS_EVENT, listener);
  }, []);
  if (!open) return null;
  // Portalled to the page: on a phone the sidebar is a transformed drawer,
  // and a fixed overlay inside it would cover only the drawer.
  return createPortal(
    <TeamSettingsDialog
      key={`${open.section}:${open.focus}`}
      section={open.section}
      focus={open.focus}
      onClose={() => setOpen(null)}
      onRenamed={onRenamed}
    />,
    document.body,
  );
}
