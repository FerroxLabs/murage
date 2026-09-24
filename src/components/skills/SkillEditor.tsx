// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Edit one of your skills: its name, what it's for, and its instructions.
// The instructions use the same rich Markdown editing as the workspace
// editor (TipTap with the app's Markdown extensions); a skill whose
// formatting that editor can't keep exactly opens as plain text instead.
// The header block a bot reads is rebuilt on the server from these fields
// and is never shown here.
import { EditorContent, useEditor } from "@tiptap/react";
import { ChevronLeft } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { richEditorContent } from "../MarkdownEditor";
import { analyzeMarkdownFidelity, createMarkdownExtensions } from "@/lib/markdown-fidelity";
import { refusalOf, saveSkill, skillBody, type SkillDetail } from "@/lib/skills-api";

export const BUILT_IN_COPY_NOTE = "Built-in skills can't be changed, so this edits your own copy.";

const FIELD = "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const LABEL = "text-[12px] font-medium text-ink";
const BUTTON = "rounded-lg px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50";
const RICH = [
  "max-h-[480px] min-h-48 overflow-y-auto rounded-lg border border-hairline/50 bg-inset",
  "[&_h1]:mb-3 [&_h1]:text-[20px] [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-[16px] [&_h2]:font-semibold",
  "[&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-[14px] [&_h3]:font-semibold [&_p]:my-2",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-hairline [&_blockquote]:pl-3 [&_blockquote]:text-ink-secondary",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-panel [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[12.5px]",
  "[&_code]:font-mono [&_a]:text-accent-text [&_a]:underline [&_hr]:my-4 [&_hr]:border-hairline",
].join(" ");

function RichInstructions({ initial, onChange }: { initial: string; onChange(markdown: string): void }) {
  const content = useMemo(() => richEditorContent(initial), [initial]);
  const editor = useEditor({
    immediatelyRender: typeof window !== "undefined",
    extensions: createMarkdownExtensions(),
    ...content,
    injectCSS: false,
    editorProps: {
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": "Instructions", class: "min-h-48 px-3 py-2 text-[13px] leading-relaxed text-ink outline-none" },
    },
    onUpdate: ({ editor: current }) => onChange(current.getMarkdown()),
  });
  return <EditorContent editor={editor} className={RICH} />;
}

export interface SkillEditorProps {
  skill: SkillDetail;
  /** Shown above the fields, e.g. that a built-in is being edited as a copy. */
  note?: string;
  onCancel(): void;
  onSaved(result: { skill: SkillDetail; needsLook: string[] }): void;
}

export function SkillEditor({ skill, note, onCancel, onSaved }: SkillEditorProps) {
  const initialBody = useMemo(() => skillBody(skill.text), [skill.text]);
  const rich = useMemo(() => analyzeMarkdownFidelity(initialBody).richEditable, [initialBody]);
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const body = useRef(initialBody);
  const [plain, setPlain] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!description.trim()) return setError("Say what this skill is for.");
    setBusy(true);
    setError("");
    try {
      const saved = await saveSkill(skill.ref, { displayName: name.trim(), description: description.trim(), body: rich ? body.current : plain });
      onSaved({ skill: saved.skill, needsLook: saved.needsLook ?? [] });
    } catch (cause) {
      setError(refusalOf(cause).message || "That couldn't be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1">
      <button type="button" onClick={onCancel} className="-ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
        <ChevronLeft size={14} aria-hidden="true" />
        Back to the skill
      </button>
      <h3 className="mt-2 text-[15px] font-medium text-ink">Edit {skill.name}</h3>
      {note && <p role="note" className="mt-1 rounded-lg bg-accent/10 px-3 py-2 text-[12.5px] text-ink">{note}</p>}

      <label className="mt-3 block">
        <span className={LABEL}>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className={`${FIELD} mt-1 min-h-10`} />
      </label>
      <label className="mt-3 block">
        <span className={LABEL}>What it's for</span>
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={1024} className={`${FIELD} mt-1 resize-y`} />
      </label>
      <div className="mt-3">
        <div className={LABEL} id="skill-editor-instructions">What it tells the bot</div>
        <div className="mt-1">
          {rich ? (
            <RichInstructions initial={initialBody} onChange={(markdown) => { body.current = markdown; }} />
          ) : (
            <>
              <p className="mb-1 text-[11.5px] text-ink-secondary">This skill uses formatting the editor can't show, so it opens as plain text.</p>
              <textarea aria-labelledby="skill-editor-instructions" value={plain} onChange={(event) => setPlain(event.target.value)} spellCheck={false} className={`${FIELD} min-h-64 resize-y font-mono text-[12.5px] leading-relaxed`} />
            </>
          )}
        </div>
      </div>
      <p className="mt-2 text-[11.5px] text-ink-secondary">Saving checks it again. Bots that use it get the new version.</p>
      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void save()} className={`${BUTTON} bg-accent text-white`}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" disabled={busy} onClick={onCancel} className={`${BUTTON} bg-control text-ink`}>Cancel</button>
      </div>
    </div>
  );
}
