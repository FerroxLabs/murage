// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Read one skill: what it tells a bot, what Skill Guard found, and which
// bots use it. Shared by Settings → Skills (a switch per bot) and the bot
// window (one Add button). A skill that needs a look is switched on only
// after its findings are shown and the owner says "Use it anyway"; a
// Blocked skill has no switch and no Add button at all.
import { ChevronDown, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ChatMarkdown } from "../ChatMarkdown";
import { Switch } from "../SettingsPrimitives";
import { VerdictBadge } from "./VerdictBadge";
import { deleteCollectionSkill, findingLines, readSkill, refusalOf, setSkillForBot, type SkillDetail } from "@/lib/skills-api";

/** Long skills render this much until "Show all". */
export const READER_PREVIEW_CHARS = 60_000;
export const BLOCKED_LINE = "This skill was blocked by the safety check and can't be switched on.";

/** The instructions without their header block (name, description and
 *  other settings), which the reader already shows in words above. */
export function skillBody(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").replace(/^\s+/, "");
}

export type ReaderMode = { kind: "settings" } | { kind: "bot"; botId: string };
export type Pending = { kind: "enable"; botId: string } | { kind: "delete"; bots: string[] } | null;

export interface SkillReaderViewProps {
  skill: SkillDetail;
  mode: ReaderMode;
  busy: boolean;
  pending: Pending;
  error: string;
  showAll: boolean;
  onBack(): void;
  onSwitch(botId: string, on: boolean): void;
  onConfirm(): void;
  onCancel(): void;
  onDelete(): void;
  onShowAll(): void;
}

const LINK = "-ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink";
const BUTTON = "rounded-lg px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50";

export function SkillReaderView(props: SkillReaderViewProps) {
  const { skill, mode, busy, pending } = props;
  const [evidence, setEvidence] = useState(false);
  const findings = findingLines(skill.scan);
  const blocked = skill.verdict === "blocked";
  const inBot = mode.kind === "bot" ? skill.bots.find((bot) => bot.botId === mode.botId) : undefined;
  const body = skillBody(skill.text);
  const text = props.showAll || body.length <= READER_PREVIEW_CHARS ? body : body.slice(0, READER_PREVIEW_CHARS);

  return (
    <div className="mt-1">
      <button type="button" onClick={props.onBack} className={LINK}>
        <ChevronLeft size={14} aria-hidden="true" />
        All skills
      </button>

      <div className="mt-2 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-medium text-ink">{skill.name}</h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{skill.description}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <VerdictBadge verdict={skill.verdict} builtIn={skill.kind === "library"} />
            {skill.kind !== "library" && <span className="text-[11.5px] text-ink-secondary">{skill.source}</span>}
          </div>
        </div>
        {mode.kind === "bot" && !blocked && (
          inBot?.enabled ? (
            <span className="shrink-0 pt-1 text-[12px] text-success">Added</span>
          ) : (
            <button type="button" disabled={busy || inBot?.canUseSkills === false} onClick={() => props.onSwitch(mode.botId, true)} className={`${BUTTON} shrink-0 bg-accent text-white`}>
              Add
            </button>
          )
        )}
      </div>

      {/* What Skill Guard found, in plain words */}
      {blocked ? (
        <div role="note" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {BLOCKED_LINE}
          {findings.length > 0 && <ul className="mt-1 list-disc pl-4">{findings.map((line) => <li key={line}>{line}</li>)}</ul>}
        </div>
      ) : findings.length > 0 ? (
        <div className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          <div className="font-medium">Worth a look before you use it:</div>
          <ul className="mt-1 list-disc pl-4">{findings.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      ) : null}
      {skill.scan.findings.length > 0 && (
        <button type="button" onClick={() => setEvidence((open) => !open)} className={`${LINK} mt-1`} aria-expanded={evidence}>
          {evidence ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          Show the lines
        </button>
      )}
      {evidence && (
        <ul className="mt-1 space-y-1 rounded-lg bg-inset p-2 font-mono text-[11px] text-ink-secondary">
          {skill.scan.findings.map((finding, index) => (
            <li key={`${finding.rule}-${index}`}>
              <span className="text-ink">{finding.file}</span>: {finding.evidence}
            </li>
          ))}
        </ul>
      )}

      {pending?.kind === "enable" && (
        <div role="alertdialog" aria-label="Use this skill anyway?" className="mt-3 rounded-lg border border-warning/40 bg-card p-3 text-[12.5px] text-ink">
          <div className="font-medium">Use {skill.name} anyway?</div>
          <p className="mt-1 text-ink-secondary">The safety check found:</p>
          <ul className="mt-1 list-disc pl-4 text-ink-secondary">{findings.map((line) => <li key={line}>{line}</li>)}</ul>
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={busy} onClick={props.onConfirm} className={`${BUTTON} bg-warning text-white`}>Use it anyway</button>
            <button type="button" disabled={busy} onClick={props.onCancel} className={`${BUTTON} bg-control text-ink`}>Cancel</button>
          </div>
        </div>
      )}
      {pending?.kind === "delete" && (
        <div role="alertdialog" aria-label="Delete this skill?" className="mt-3 rounded-lg border border-danger/40 bg-card p-3 text-[12.5px] text-ink">
          <div className="font-medium">Delete {skill.name}?</div>
          <p className="mt-1 text-ink-secondary">{pending.bots.length ? `${pending.bots.join(", ")} ${pending.bots.length === 1 ? "uses" : "use"} it. It will be removed from ${pending.bots.length === 1 ? "that bot" : "them"} too.` : "It will be removed from your skills."}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={busy} onClick={props.onConfirm} className={`${BUTTON} bg-danger text-white`}>Delete</button>
            <button type="button" disabled={busy} onClick={props.onCancel} className={`${BUTTON} bg-control text-ink`}>Cancel</button>
          </div>
        </div>
      )}
      {props.error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{props.error}</div>}

      {mode.kind === "settings" && (
        <div className="mt-4">
          <div className="text-[12px] font-medium text-ink">Use with</div>
          {skill.bots.length === 0 ? (
            <p className="mt-1 text-[12px] text-ink-secondary">You have no bots yet.</p>
          ) : (
            <ul className="mt-1 divide-y divide-hairline/40">
              {skill.bots.map((bot) => (
                <li key={bot.botId} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">{bot.botName}</div>
                    {!bot.canUseSkills && <div className="text-[11px] text-ink-secondary">This bot's engine can't use skills.</div>}
                  </div>
                  {!blocked && (
                    <Switch
                      checked={bot.enabled}
                      aria-label={`${bot.enabled ? "Stop using" : "Use"} ${skill.name} with ${bot.botName}`}
                      disabled={busy || (!bot.canUseSkills && !bot.enabled)}
                      onClick={() => props.onSwitch(bot.botId, !bot.enabled)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 text-[12px] font-medium text-ink">What it tells the bot</div>
      <div className="mt-1 max-h-[480px] overflow-y-auto rounded-lg bg-inset p-3 text-[13px] leading-relaxed text-ink">
        {body.trim() ? <ChatMarkdown text={text} /> : <span className="text-ink-secondary">This skill is empty.</span>}
      </div>
      {text.length < body.length && (
        <button type="button" onClick={props.onShowAll} className={`${LINK} mt-1`}>Show all</button>
      )}
      {skill.files.length > 1 && (
        <div className="mt-3 text-[11.5px] text-ink-secondary">
          Also carries: {skill.files.filter((file) => file !== "SKILL.md").join(", ")}
          {mode.kind === "bot" || skill.kind === "collection" ? ". A bot gets its instructions; the other files stay here." : ""}
        </div>
      )}

      {mode.kind === "settings" && skill.kind === "collection" && (
        <button type="button" disabled={busy} onClick={props.onDelete} className="mt-4 flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-danger hover:bg-danger/10 disabled:opacity-50">
          <Trash2 size={13} aria-hidden="true" />
          Delete
        </button>
      )}
    </div>
  );
}

/** The reader with its requests: loads the skill, switches it per bot
 *  (asking first when it needs a look), and deletes imported skills. */
export function SkillReader({ skillRef, mode, onBack, onChanged }: { skillRef: string; mode: ReaderMode; onBack(): void; onChanged?(): void }) {
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setSkill(await readSkill(skillRef));
      setLoadError("");
    } catch (cause) {
      setLoadError(refusalOf(cause).message || "This skill couldn't be read.");
    }
  }, [skillRef]);
  useEffect(() => {
    setSkill(null);
    setPending(null);
    setError("");
    setShowAll(false);
    void load();
  }, [load]);

  /** `leaving`: the work ends on another screen (a delete), so nothing here
   *  is reloaded. */
  const run = async (work: () => Promise<unknown>, leaving = false) => {
    setBusy(true);
    setError("");
    try {
      await work();
      onChanged?.();
      if (leaving) return onBack();
      await load();
    } catch (cause) {
      const refusal = refusalOf(cause);
      if (refusal.code === "in-use" && refusal.bots) setPending({ kind: "delete", bots: refusal.bots });
      else setError(refusal.message);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="mt-1">
        <button type="button" onClick={onBack} className={LINK}><ChevronLeft size={14} aria-hidden="true" />All skills</button>
        <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{loadError}</div>
      </div>
    );
  }
  if (!skill) return <p className="mt-3 text-[12px] text-ink-secondary">Loading…</p>;

  return (
    <SkillReaderView
      skill={skill}
      mode={mode}
      busy={busy}
      pending={pending}
      error={error}
      showAll={showAll}
      onBack={onBack}
      onShowAll={() => setShowAll(true)}
      onSwitch={(botId, on) => {
        if (on && skill.verdict === "review") return setPending({ kind: "enable", botId });
        void run(() => setSkillForBot(skill.ref, botId, on));
      }}
      onConfirm={() => {
        const current = pending;
        setPending(null);
        if (current?.kind === "enable") void run(() => setSkillForBot(skill.ref, current.botId, true, skill.scan.contentHash));
        if (current?.kind === "delete") void run(() => deleteCollectionSkill(skill.name, true), true);
      }}
      onCancel={() => setPending(null)}
      onDelete={() => void run(() => deleteCollectionSkill(skill.name), true)}
    />
  );
}
