// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot settings > Teams (SPEC-X 13.1): which other teams can request this
// bot's work, what that means, the notes and skills that ride every team, a
// copy for one team, and what the bot is doing for other teams now. Desktop
// only: every route it reads is the owner's (server/sharing-routes.ts).
// Loaded on first open, behind SettingsPanel's lazy boundary.
import { useCallback, useEffect, useState } from "react";
import { api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { Switch } from "./SettingsPrimitives";
import {
  SHARING_COPY,
  allTeamsLine,
  cannotShareLine,
  copyMadeLine,
  generalNotesHeading,
  generalNotesHint,
  homeTeamLine,
  honestLimitLine,
  howItWorksLine,
  learnedSkillsHeading,
  noLearnedSkillsLine,
  notesAfterConflict,
  runningChoiceLine,
  sharingLoadLine,
  teamsLosingRunningWork,
  type SharingView,
} from "@/lib/shared-teams";

const CARD = "rounded-xl bg-card p-4";
const HEADING = "text-[15px] font-medium text-ink";
const NOTE = "mt-1 text-[13px] leading-relaxed text-ink-secondary";
const BUTTON = "min-h-10 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:brightness-110 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const PRIMARY = "min-h-10 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export type Mode = "none" | "list" | "all";
export interface TeamsSectionBodyProps {
  name: string;
  view: SharingView;
  mode: Mode;
  picked: ReadonlySet<string>;
  /** `newer`: the notes someone else saved while the owner edited (409). */
  notes: { text: string; saved: string; newer?: string } | null;
  copyTeam: string;
  busy: boolean;
  status: { error: boolean; text: string } | null;
  /** Teams whose running job a pending change would end: Let it finish or Stop it now. */
  losing: string[];
  onMode: (mode: Mode) => void;
  onToggleTeam: (teamId: string) => void;
  onSave: (running?: "finish" | "stop") => void;
  onCancelChange: () => void;
  onSkill: (name: string, revision: string, everyTeam: boolean) => void;
  onNotes: (text: string) => void;
  onSaveNotes: () => void;
  onCopyTeam: (teamId: string) => void;
  onMakeCopy: () => void;
}

/** Rendering only, so each state can be asserted without a store or a DOM. */
export function TeamsSectionBody(props: TeamsSectionBodyProps) {
  const { name, view, mode, picked, notes, busy, status, losing } = props;
  const others = view.teams.filter(team => team.selectable);
  const changed = mode !== view.sharedWith.mode || mode === "list" && (picked.size !== view.sharedWith.teams.length || view.sharedWith.teams.some(team => !picked.has(team.id)));
  const on = view.sharedWith.mode !== "none";
  const load = sharingLoadLine(view.load);
  const modes: Array<[Mode, string]> = [["none", SHARING_COPY.none], ["list", SHARING_COPY.list], ["all", SHARING_COPY.all]];
  return (
    <div className="space-y-4" data-teams-section>
      <section className={CARD}>
        <h3 className={HEADING}>{homeTeamLine(name, view.home.name)}</h3>
        <p className={NOTE}>{SHARING_COPY.homeNote}</p>
      </section>

      {!view.shareable ? (
        <p className={cn(CARD, "text-[13px] text-ink-secondary")}>{cannotShareLine(name)}</p>
      ) : (
        <section className={CARD} aria-labelledby="teams-shared-with">
          <h3 id="teams-shared-with" className={HEADING}>Shared with</h3>
          {!view.enabled && <p className={NOTE} role="note">{SHARING_COPY.turnedOff}</p>}
          {!others.length ? <p className={NOTE}>{SHARING_COPY.noTeams}</p> : (
            <>
              <div role="radiogroup" aria-label="Shared with" className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
                {modes.map(([value, label]) => (
                  <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={busy || !view.enabled && value !== "none"}
                    onClick={() => props.onMode(value)}
                    className={cn("min-h-9 flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:opacity-40", mode === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}>
                    {label}
                  </button>
                ))}
              </div>
              {mode === "list" && (
                <fieldset className="mt-3 space-y-1" disabled={busy}>
                  <legend className="sr-only">Teams that can ask {name} for work</legend>
                  {others.map(team => (
                    <label key={team.id} className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-[13px] text-ink hover:bg-inset">
                      <input type="checkbox" checked={picked.has(team.id)} onChange={() => props.onToggleTeam(team.id)} className="size-4 shrink-0 accent-accent" />
                      {team.name}
                    </label>
                  ))}
                </fieldset>
              )}
              {mode === "all" && <p className={NOTE}>{allTeamsLine(others.map(team => team.name))}</p>}
              {losing.length > 0 ? (
                <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3" role="group" aria-label="A job is running">
                  {losing.map(team => <p key={team} className="text-[13px] text-ink">{runningChoiceLine(name, team)}</p>)}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className={PRIMARY} disabled={busy} onClick={() => props.onSave("finish")}>{SHARING_COPY.letFinish}</button>
                    <button type="button" className={BUTTON} disabled={busy} onClick={() => props.onSave("stop")}>{SHARING_COPY.stopNow}</button>
                    <button type="button" className={BUTTON} disabled={busy} onClick={props.onCancelChange}>Keep it shared</button>
                  </div>
                </div>
              ) : changed && (
                <div className="mt-3 flex gap-2">
                  <button type="button" className={PRIMARY} disabled={busy || mode === "list" && picked.size === 0} onClick={() => props.onSave()}>Save</button>
                  <button type="button" className={BUTTON} disabled={busy} onClick={props.onCancelChange}>Cancel</button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {view.shareable && (
        <section className={CARD} aria-labelledby="teams-how">
          <h3 id="teams-how" className={HEADING}>How it works</h3>
          <p className={NOTE}>{howItWorksLine(name)}</p>
          <p className={NOTE}>{SHARING_COPY.limits}</p>
          {on && <p className={cn(NOTE, "text-ink")}>{honestLimitLine(name)}</p>}
          {others.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="teams-copy-team">Team for the copy</label>
              <select id="teams-copy-team" value={props.copyTeam} disabled={busy} onChange={event => props.onCopyTeam(event.target.value)}
                className="min-h-10 rounded-lg border border-hairline/50 bg-inset px-2 text-[13px] text-ink">
                {others.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
              <button type="button" className={BUTTON} disabled={busy || !props.copyTeam} onClick={props.onMakeCopy}>{SHARING_COPY.makeCopy}</button>
            </div>
          )}
        </section>
      )}

      {load && <p className={cn(CARD, "text-[13px] text-ink")} role="status">{load}</p>}

      <section className={CARD} aria-labelledby="teams-skills">
        <h3 id="teams-skills" className={HEADING}>{learnedSkillsHeading(name)}</h3>
        {!view.skills.length ? <p className={NOTE}>{noLearnedSkillsLine(name)}</p> : (
          <ul className="mt-2 space-y-1">
            {view.skills.map(skill => (
              <li key={skill.name} className="flex min-h-10 items-center justify-between gap-3 text-[13px] text-ink">
                <span className="min-w-0 truncate">{skill.name}</span>
                <span className="flex shrink-0 items-center gap-2 text-ink-secondary">
                  {SHARING_COPY.useEveryTeam}
                  <Switch checked={skill.everyTeam} disabled={busy} aria-label={`${SHARING_COPY.useEveryTeam}: ${skill.name}`} onClick={() => props.onSkill(skill.name, skill.revision, !skill.everyTeam)} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={CARD} aria-labelledby="teams-general-notes">
        <h3 id="teams-general-notes" className={HEADING}>{generalNotesHeading}</h3>
        <p className={NOTE}>{generalNotesHint(name)}</p>
        {notes && (
          <>
            <textarea aria-labelledby="teams-general-notes" value={notes.text} disabled={busy} maxLength={16384} rows={6} onChange={event => props.onNotes(event.target.value)}
              className="mt-2 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" />
            {notes.text !== notes.saved && <button type="button" className={cn(PRIMARY, "mt-2")} disabled={busy} onClick={props.onSaveNotes}>Save notes</button>}
            {notes.newer !== undefined && notes.newer !== notes.text && (
              <div className="mt-3" data-newer-notes>
                <p className="text-[12px] font-medium text-ink-secondary">{SHARING_COPY.newerNotes}</p>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-inset px-3 py-2 text-[13px] text-ink">{notes.newer}</pre>
              </div>
            )}
          </>
        )}
      </section>

      {status && <p role="status" className={cn("text-[13px]", status.error ? "text-danger" : "text-ink-secondary")}>{status.text}</p>}
    </div>
  );
}

/** The Teams section for one bot: reads the owner's routes and keeps the
 * choice local until Save. */
export default function BotTeamsSection({ bot }: { bot: Bot }) {
  const [view, setView] = useState<SharingView | null>(null);
  const [mode, setMode] = useState<Mode>("none");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<{ text: string; saved: string; revision: string; newer?: string } | null>(null);
  const [copyTeam, setCopyTeam] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [losing, setLosing] = useState<string[]>([]);

  const adopt = useCallback((next: SharingView) => {
    setView(next);
    setMode(next.sharedWith.mode);
    setPicked(new Set(next.sharedWith.teams.map(team => team.id)));
    setLosing([]);
    setCopyTeam(current => current && next.teams.some(team => team.id === current && team.selectable) ? current : next.teams.find(team => team.selectable)?.id ?? "");
  }, []);
  const load = useCallback(async () => {
    try {
      const [sharing, general] = await Promise.all([api(`/api/bots/${bot.id}/sharing`), api(`/api/bots/${bot.id}/general-notes`)]);
      adopt(sharing as SharingView);
      setNotes({ text: general.text, saved: general.text, revision: general.revision });
    } catch (error) {
      setStatus({ error: true, text: error instanceof Error ? error.message : String(error) });
    }
  }, [adopt, bot.id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setStatus(null);
    try { await work(); } catch (error) { setStatus({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  if (!view) return <p role="status" className="text-[13px] text-ink-secondary">{status?.text ?? "Loading teams…"}</p>;
  const save = (running?: "finish" | "stop") => {
    const next = { mode, teamIds: [...picked] };
    const ending = teamsLosingRunningWork(view, next);
    if (ending.length && !running) { setLosing(ending); return; }
    void run(async () => {
      await api(`/api/bots/${bot.id}/sharing`, { method: "PATCH", body: JSON.stringify({ mode, ...(mode === "list" ? { teamIds: next.teamIds } : {}), ...(running ? { running } : {}) }) });
      adopt(await api(`/api/bots/${bot.id}/sharing`));
      setStatus({ error: false, text: SHARING_COPY.notesSaved });
    });
  };
  return (
    <TeamsSectionBody
      name={bot.name}
      view={view}
      mode={mode}
      picked={picked}
      notes={notes}
      copyTeam={copyTeam}
      busy={busy}
      status={status}
      losing={losing}
      onMode={next => { setMode(next); setLosing([]); }}
      onToggleTeam={id => { setLosing([]); setPicked(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }}
      onSave={save}
      onCancelChange={() => adopt(view)}
      onSkill={(name, revision, everyTeam) => void run(async () => {
        await api(`/api/bots/${bot.id}/sharing/skills`, { method: "POST", body: JSON.stringify({ name, revision, everyTeam }) });
        adopt(await api(`/api/bots/${bot.id}/sharing`));
      })}
      onNotes={text => setNotes(current => current && { ...current, text })}
      onSaveNotes={() => notes && void run(async () => {
        const response = await fetchNotes(bot.id, notes.text, notes.revision);
        if (response.changed) { setNotes(notesAfterConflict(notes.text, response)); setStatus({ error: true, text: SHARING_COPY.notesChanged }); return; }
        setNotes({ text: response.text, saved: response.text, revision: response.revision });
        setStatus({ error: false, text: SHARING_COPY.notesSaved });
      })}
      onCopyTeam={setCopyTeam}
      onMakeCopy={() => void run(async () => {
        const made = await api(`/api/bots/${bot.id}/sharing/copy`, { method: "POST", body: JSON.stringify({ teamId: copyTeam }) });
        setStatus({ error: false, text: copyMadeLine(made?.bot?.name ?? bot.name) });
      })}
    />
  );
}

/** PUT the notes; a 409 "changed" answer carries the newer notes. */
async function fetchNotes(botId: string, text: string, expectedRevision: string): Promise<{ changed: boolean; text: string; revision: string }> {
  try {
    const saved = await api(`/api/bots/${botId}/general-notes`, { method: "PUT", body: JSON.stringify({ text, expectedRevision }) });
    return { changed: false, text: saved.text, revision: saved.revision };
  } catch (error) {
    const newer = await api(`/api/bots/${botId}/general-notes`);
    if (newer.revision !== expectedRevision) return { changed: true, text: newer.text, revision: newer.revision };
    throw error;
  }
}
