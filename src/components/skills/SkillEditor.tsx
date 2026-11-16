// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Edit one of your skills: its name, what it's for, and its instructions.
// The instructions use the shared rich Markdown editor (toolbar, "/" menu,
// the app's Markdown extensions), as the workspace editor does; a skill whose
// formatting that editor can't keep exactly opens as plain text instead.
// The header block a bot reads is rebuilt on the server from these fields
// and is never shown here.
import { ChevronLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { RichMarkdownEditor } from "../editor/RichMarkdownEditor";
import { BOX_SAVE_ROW } from "../ui/BoxShell";
import { analyzeMarkdownFidelity } from "@/lib/markdown-fidelity";
import { duplicateSkill, refusalOf, saveSkill, setSkillForBot, skillBody, type SkillDetail } from "@/lib/skills-api";

/** Whether the instructions open in the rich editor. Unlike a workspace
 *  file, a skill is saved through its fields rather than byte for byte, so
 *  a round trip that only tidies the Markdown (list markers, spacing, line
 *  endings) is fine; formatting the editor would drop is not. */
export function richEditable(body: string): boolean {
  const { reasons } = analyzeMarkdownFidelity(body);
  return reasons.every((reason) => reason === "round-trip-changed" || reason === "mixed-newlines");
}

export const BUILT_IN_COPY_NOTE = "Built-in skills can't be changed, so this edits your own copy.";

const FIELD = "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const LABEL = "text-[12px] font-medium text-ink";
const BUTTON = "rounded-lg px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50";
export interface SkillEditorProps {
  skill: SkillDetail;
  /** Shown above the fields, e.g. that a built-in is being edited as a copy. */
  note?: string;
  /** Library presentation; Settings retains its existing layout and labels. */
  library?: boolean;
  saveLabel?: string;
  /** Delay making the library copy until the owner actually saves. */
  copyOnSave?: boolean;
  onDirtyChange?(dirty: boolean): void;
  onBusyChange?(busy: boolean): void;
  onCancel(): void;
  onSaved(result: { skill: SkillDetail; needsLook: string[]; failed?: string[]; stillOnOriginal?: string[] }): void;
}

export function SkillEditor({ skill, note, library, saveLabel = "Save", copyOnSave, onDirtyChange, onBusyChange, onCancel, onSaved }: SkillEditorProps) {
  const initialBody = useMemo(() => skillBody(skill.text), [skill.text]);
  const rich = useMemo(() => richEditable(initialBody), [initialBody]);
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const body = useRef(initialBody);
  const saveRef = useRef(skill.ref);
  const inFlight = useRef(false);
  const [plain, setPlain] = useState(initialBody);
  const [richBody, setRichBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    onDirtyChange?.(name !== skill.name || description !== skill.description || (rich ? richBody : plain) !== initialBody);
  }, [name, description, rich, richBody, plain, initialBody, skill.name, skill.description, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const save = async () => {
    if (inFlight.current) return;
    if (!description.trim()) return setError("Say what this skill is for.");
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (copyOnSave && saveRef.current === skill.ref) saveRef.current = (await duplicateSkill(skill.ref)).skill.ref;
      const saved = await saveSkill(saveRef.current, { displayName: name.trim(), description: description.trim(), body: rich ? body.current : plain });
      const failed = [...(saved.failed ?? [])];
      const stillOnOriginal: string[] = [];
      // A new collection ref has no users yet. Move only the bots that used
      // the original, through the same owner/Skill Guard PUT as Settings.
      // Install first: a refusal must leave the working original enabled.
      if (copyOnSave) {
        for (const bot of skill.bots.filter((entry) => entry.enabled)) {
          // The library API can already migrate assignments as part of Save,
          // including leaving a reviewed/blocked copy off. Respect that result.
          if (failed.includes(bot.botName) || saved.skill.usedBy.some((user) => user.botId === bot.botId)) continue;
          try {
            await setSkillForBot(saved.skill.ref, bot.botId, true);
            await setSkillForBot(skill.ref, bot.botId, false);
          } catch (cause) {
            stillOnOriginal.push(bot.botName);
            if (refusalOf(cause).code !== "needs-review") failed.push(bot.botName);
          }
        }
      }
      onSaved({ skill: saved.skill, needsLook: saved.needsLook ?? [], failed: [...new Set(failed)], stillOnOriginal });
    } catch (cause) {
      setError(refusalOf(cause).message || "That couldn't be saved.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className={library ? "flex h-full min-h-0 flex-col" : "mt-1"}>
      <div className={library ? "thin-scroll min-h-0 flex-1 overflow-y-auto px-[var(--skill-pad)] pb-5 pt-3" : undefined}>
        <button type="button" disabled={library && busy} onClick={onCancel} className="-ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
          <ChevronLeft size={14} aria-hidden="true" />
          Back to the skill
        </button>
        <h3 className="mt-2 text-[15px] font-medium text-ink">Edit {skill.name}</h3>
        {note && <p role="note" className="mt-1 rounded-lg bg-accent/10 px-3 py-2 text-[12.5px] text-ink">{note}</p>}

        <label className="mt-3 block">
          <span className={LABEL}>Name</span>
          <input disabled={library && busy} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className={`${FIELD} mt-1 min-h-10`} />
        </label>
        <label className="mt-3 block">
          <span className={LABEL}>What it's for</span>
          <textarea disabled={library && busy} value={description} onChange={(event) => setDescription(event.target.value)} rows={library ? 2 : 3} maxLength={1024} className={`${FIELD} mt-1 resize-y`} />
        </label>
        <div className="mt-3">
          <div className={LABEL} id="skill-editor-instructions">What it tells the bot</div>
          <div className="mt-1">
            {rich ? (
              <RichMarkdownEditor value={initialBody} readOnly={library && busy} ariaLabel="Instructions" className="max-h-[480px]" onChange={(markdown) => { body.current = markdown; if (onDirtyChange) setRichBody(markdown); }} />
            ) : (
              <>
                <p className="mb-1 text-[11.5px] text-ink-secondary">This skill uses formatting the editor can't show, so it opens as plain text.</p>
                <textarea disabled={library && busy} aria-labelledby="skill-editor-instructions" value={plain} onChange={(event) => setPlain(event.target.value)} spellCheck={false} className={`${FIELD} min-h-64 resize-y font-mono text-[12.5px] leading-relaxed`} />
              </>
            )}
          </div>
        </div>
        {library && <p className="mt-1 text-[11.5px] text-ink-secondary">Type / on a new line for headings, lists, tables and more.</p>}
        {!library && <p className="mt-2 text-[11.5px] text-ink-secondary">Saving checks it again. Bots that use it get the new version.</p>}
      </div>
      <div className={library ? "shrink-0 border-t border-hairline/50 bg-panel px-[var(--skill-pad)] py-3" : `${BOX_SAVE_ROW} mt-1 bg-panel`}>
        {error && <div role="alert" className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        <div className={library ? "flex flex-wrap items-center gap-2" : "flex gap-2"}>
          <button type="button" disabled={busy} onClick={() => void save()} className={`${BUTTON} bg-accent ${library ? "min-h-[34px] text-accent-ink" : "text-white"} focus-visible:outline-2 focus-visible:outline-focus`}>{busy ? "Saving…" : saveLabel}</button>
          <button type="button" disabled={busy} onClick={onCancel} className={`${BUTTON} bg-control text-ink focus-visible:outline-2 focus-visible:outline-focus`}>Cancel</button>
          {library && <span className="min-w-40 flex-1 text-[11.5px] leading-snug text-ink-secondary">Saving checks it again. Bots that use it get the new version.</span>}
        </div>
      </div>
    </div>
  );
}
