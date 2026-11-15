// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { FileText, Pencil } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { fetchSkill, revertSkill } from "@/lib/skillsLibrary";
import { findingLines, refusalOf, type SkillDetail, type SkillScan } from "@/lib/skills-api";
import { useFocusTrap } from "@/lib/focus-trap";
import { SkillReaderView } from "../skills/SkillReader";
import { SkillEditor } from "../skills/SkillEditor";
import { BotsPicker, SKILL_FOCUS, type LibraryBot } from "./BotsPicker";

export interface SkillDetailPaneProps {
  skillId: string;
  bots: LibraryBot[];
  compact: boolean;
  onChanged(replacementId?: string): void;
  /** Browser resets must ask the mounted draft owner before changing selection. */
  onNavigationGuardChange?(guard: ((leave: () => void) => void) | null): void;
}

type LibraryFile = { path: string; size?: number; content?: string };
/** Accept the existing Settings detail and the contract's enriched library detail. */
type LibraryDetail = Omit<SkillDetail, "files" | "bots"> & {
  id?: string;
  mine?: boolean;
  originalRef?: string;
  files: (string | LibraryFile)[];
  bots: (SkillDetail["bots"][number] | LibraryBot)[];
};
const SOFT = `min-h-9 rounded-full bg-control px-4 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50 ${SKILL_FOCUS}`;
const noop = () => {};

function DiscardConfirmation({ onKeep, onDiscard }: { onKeep(): void; onDiscard(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(dialog, true, {
    name: "discard-skill-edits", kind: "dialog", initialFocus: "[data-keep-editing]", onEscape: onKeep,
  });
  return <div className="absolute inset-0 z-40 flex items-center justify-center bg-panel/95 p-4">
    <div ref={dialog} role="alertdialog" data-box-exempt="inline confirm inside a section" aria-modal="true" aria-label="Discard unsaved edits?" tabIndex={-1} className="max-w-sm rounded-xl border border-hairline bg-card p-4 shadow-xl">
      <h3 className="text-[14px] font-semibold">Discard unsaved edits?</h3>
      <p className="mt-2 text-[13px] text-ink-secondary">Your changes haven’t been saved.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" data-keep-editing className={SOFT} onClick={onKeep}>Keep editing</button>
        <button type="button" className={SOFT} onClick={onDiscard}>Discard edits</button>
      </div>
    </div>
  </div>;
}

export function SkillDetailPane({ skillId, bots, compact, onChanged, onNavigationGuardChange }: SkillDetailPaneProps) {
  const [activeId, setActiveId] = useState(skillId);
  const [selectionId, setSelectionId] = useState(skillId);
  const [detail, setDetail] = useState<LibraryDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saveWarning, setSaveWarning] = useState("");
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [fileOpen, setFileOpen] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertScan, setRevertScan] = useState<SkillScan | null>(null);
  const [discard, setDiscard] = useState(false);
  const [keepId, setKeepId] = useState<string | null>(null);
  const pane = useRef<HTMLElement>(null);
  const leaveAfterDiscard = useRef<(() => void) | null>(null);
  const request = useRef(0);
  const latestId = useRef(activeId);
  latestId.current = activeId;
  const editButton = useRef<HTMLButtonElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    pane.current?.style.setProperty("--skill-pad", compact ? "18px" : "28px");
  }, [compact]);

  // Own Escape above the parent library layer while a draft/save is at risk.
  // Nested editor menus still get the key first through the shared layer stack.
  useFocusTrap(pane, editing && (dirty || saving), {
    name: "skill-draft", holdFocus: false, initialFocus: null,
    onEscape: () => {
      if (saving) return;
      leaveAfterDiscard.current = () => pane.current?.closest('[role="dialog"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      setDiscard(true);
    },
  });
  useLayoutEffect(() => {
    if (!onNavigationGuardChange || !editing || (!dirty && !saving)) return;
    onNavigationGuardChange(leave => {
      if (saving || discard) return;
      leaveAfterDiscard.current = leave;
      setDiscard(true);
    });
    return () => onNavigationGuardChange(null);
  }, [onNavigationGuardChange, editing, dirty, saving, discard]);

  // The library owns Close, its tabs and the mousedown backdrop. Capture at
  // that boundary before React can unmount this pane; replay the exact exit
  // only after an explicit discard. No parent or Settings behavior changes.
  useEffect(() => {
    if (!editing || (!dirty && !saving)) return;
    const section = pane.current;
    const dialog = section?.closest('[role="dialog"]');
    const backdrop = dialog?.parentElement;
    if (!section || !dialog) return;
    const hold = (event: Event, resume: () => void) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (saving || discard) return;
      leaveAfterDiscard.current = resume;
      setDiscard(true);
    };
    const click = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button, a[href], [role="tab"]') : null;
      if (target && !section.contains(target)) hold(event, () => { if (target.isConnected) target.click(); });
    };
    const outside = (event: Event) => {
      if (event.target === backdrop) hold(event, () => backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    };
    dialog.addEventListener("click", click, true);
    backdrop?.addEventListener("mousedown", outside, true);
    return () => {
      dialog.removeEventListener("click", click, true);
      backdrop?.removeEventListener("mousedown", outside, true);
    };
  }, [editing, dirty, saving, discard]);
  useEffect(() => {
    if (editing || !leaveAfterDiscard.current) return;
    const resume = leaveAfterDiscard.current;
    leaveAfterDiscard.current = null;
    resume();
  }, [editing]);

  // Keep the editor mounted while its owner decides whether to leave it.
  useEffect(() => {
    if (skillId === selectionId || skillId === keepId || saving || reverting) return;
    if (skillId === activeId) { setSelectionId(skillId); return; }
    if (editing && dirty) setDiscard(true);
    else { setSelectionId(skillId); setActiveId(skillId); setNotice(""); setSaveWarning(""); setCopiedFrom(null); }
  }, [skillId, selectionId, keepId, activeId, editing, dirty, saving, reverting]);
  useEffect(() => { if (skillId !== keepId) setKeepId(null); }, [skillId, keepId]);

  const load = useCallback(async () => {
    if (latestId.current !== activeId) return;
    const ticket = ++request.current;
    try {
      const next = await fetchSkill(activeId);
      if (ticket === request.current && latestId.current === activeId) { setDetail(next as unknown as LibraryDetail); setError(""); }
    } catch (cause) {
      if (ticket === request.current && latestId.current === activeId) setError(refusalOf(cause).message || "This skill couldn't be read.");
    }
  }, [activeId]);
  useEffect(() => {
    setDetail(null); setError(""); setRevertScan(null); setEditing(false); setDirty(false); setDiscard(false); setTab(0); setFileOpen("");
    void load();
    return () => { ++request.current; };
  }, [load]);
  useEffect(() => {
    if (!editing || !dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [editing, dirty]);
  useEffect(() => {
    if (editing) document.querySelector<HTMLInputElement>(`[data-skill-editor="${id}"] input`)?.focus();
    else editButton.current?.focus();
  }, [editing, id]);

  const changed = async () => { onChanged(); await load(); };
  const back = () => {
    if (dirty) setDiscard(true);
    else { setEditing(false); editButton.current?.focus(); }
  };
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: number;
    if (event.key === "ArrowRight") next = (tab + 1) % 3;
    else if (event.key === "ArrowLeft") next = (tab + 2) % 3;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 2;
    else return;
    event.preventDefault(); setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  const revert = async (scan?: SkillScan) => {
    if (reverting) return;
    setReverting(true); setError("");
    try {
      const result = scan ? await revertSkill(activeId, scan.contentHash) : await revertSkill(activeId);
      setRevertScan(null); setCopiedFrom(null);
      setNotice("Your bots now use the library original.");
      onChanged(result.id);
      if (result.id !== activeId) setActiveId(result.id);
      else await load();
    }
    catch (cause) {
      const refusal = refusalOf(cause);
      if (refusal.code === "needs-review" && refusal.scan) setRevertScan(refusal.scan);
      else setError(refusal.message || "The original couldn't be restored. Try again.");
    }
    finally { setReverting(false); }
  };

  const files: LibraryFile[] = detail?.files.map((file) => typeof file === "string" ? { path: file } : file) ?? [];
  const reader: SkillDetail | null = detail ? {
    ...detail,
    files: files.map((file) => file.path),
    bots: detail.bots.map((bot) => "botId" in bot ? bot : { botId: bot.id, botName: bot.name, enabled: true, canUseSkills: true }),
  } : null;
  const using = reader?.bots.filter((bot) => bot.enabled) ?? [];
  const mine = detail?.mine ?? detail?.kind === "collection";
  const hasOriginal = mine && Boolean(detail?.originalRef || detail?.source.startsWith("Copied from"));
  const labels = ["Instructions", `Files (${files.length})`, `Bots using it (${using.length})`];
  const currentFile = files.find((file) => file.path === fileOpen);
  const allBots = [...bots, ...using.filter((bot) => !bots.some((entry) => entry.id === bot.botId)).map((bot) => ({ id: bot.botId, name: bot.botName }))];

  return <section ref={pane} aria-label="Skill details" data-skill-editor={id} data-compact={compact} data-editing={editing} className={`relative flex h-full min-h-0 min-w-0 flex-1 flex-col text-ink ${compact ? "[&_.rme-prose]:!pl-[22px]" : ""}`}>
    {compact && <style>{`[data-skills-browser][data-compact="true"]:has([data-skill-editor][data-editing="true"]) > section[aria-label="Skills"] { display: none; }`}</style>}
    {!detail || !reader ? <div className="px-[var(--skill-pad)] py-5">
      {error ? <><p role="alert">{error}</p><button type="button" onClick={() => void load()} className={`${SOFT} mt-3`}>Try again</button></> : <p role="status" className="text-[13px] text-ink-secondary">Loading skill…</p>}
    </div> : editing ? <SkillEditor key={reader.ref} skill={reader} library copyOnSave={!mine} note={mine ? "You are editing your copy. Bots that use it get the new version from their next message." : "Library skills can’t be changed, so saving makes your own copy. The original stays in the library and you can go back to it any time."} saveLabel={mine ? "Save" : "Save as my copy"} onDirtyChange={setDirty} onBusyChange={setSaving} onCancel={back} onSaved={({ skill, needsLook, failed = [], stillOnOriginal = [] }) => {
      if (!mine) setCopiedFrom(reader.ref);
      setEditing(false); setDirty(false); setSaving(false); setTab(0);
      setSaveWarning(failed.length ? `Saved your copy. Couldn’t update ${failed.join(", ")}. Check the bots using it before trying again.` : "");
      const notices = [
        skill.verdict === "blocked" ? "Saved your copy. It’s blocked by the skill check and can’t be used by bots." : "",
        stillOnOriginal.length ? `${stillOnOriginal.join(", ")} still ${stillOnOriginal.length === 1 ? "uses" : "use"} the original. Check Bots using it before trying again.` : "",
        needsLook.length && skill.verdict !== "blocked" ? `Saved. Switched off on ${needsLook.join(", ")} until you confirm it.` : "",
      ].filter(Boolean);
      setNotice(notices.join(" ") || (failed.length ? "" : "Saved. This is your copy. Your bots use it in place of the library original."));
      onChanged(skill.ref);
      // The save response may be a summary; reload the copy for its text and files.
      if (skill.ref !== activeId) setActiveId(skill.ref);
      else void load();
    }} /> : <>
      <header className="shrink-0 px-[var(--skill-pad)] pt-[18px]">
        <h2 className={`${compact ? "text-[16px]" : "text-[19px]"} break-words font-semibold leading-tight tracking-[-0.01em]`}>{reader.name}</h2>
        <p className={`${compact ? "line-clamp-1" : "line-clamp-2"} mt-1 text-[13px] leading-normal text-ink-secondary`}>{reader.description}</p>
        <p className="mt-1 text-[12px] text-ink-secondary">{mine ? "Your copy" : "From the Murage library"} · {files.length} {files.length === 1 ? "file" : "files"} · {using.length ? `on ${using.length} ${using.length === 1 ? "bot" : "bots"}` : "not on any bot yet"}</p>
        <div className="my-3 flex flex-wrap items-center gap-2">
          <BotsPicker key={activeId} disabled={reverting} skillId={activeId} skill={reader} originalSkillId={mine ? detail.originalRef || copiedFrom || undefined : undefined} bots={allBots} onChanged={changed} />
          <button ref={editButton} type="button" disabled={reverting} className={`${SOFT} flex items-center gap-1.5`} onClick={() => { setEditing(true); setNotice(""); setSaveWarning(""); setCopiedFrom(null); }}><Pencil size={14} aria-hidden="true" />Edit</button>
        </div>
        <div role="tablist" aria-label="About this skill" className="flex gap-1 border-b border-hairline/50">
          {labels.map((label, index) => <button key={index} id={`${id}-tab-${index}`} role="tab" type="button" aria-selected={tab === index} aria-controls={`${id}-panel-${index}`} tabIndex={tab === index ? 0 : -1} onKeyDown={moveTab} onClick={() => setTab(index)} className={`-mb-px min-h-9 min-w-0 border-b-2 px-3 text-[13px] ${SKILL_FOCUS} ${tab === index ? "border-accent font-medium text-ink" : "border-transparent text-ink-secondary hover:text-ink"}`}>{label}</button>)}
        </div>
      </header>
      <div role="tabpanel" tabIndex={0} id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} className={`thin-scroll min-h-0 flex-1 overflow-y-auto px-[var(--skill-pad)] pb-6 pt-4 ${SKILL_FOCUS}`}>
        {error && <p role="alert" className="mb-3 text-[12.5px] text-danger">{error}</p>}
        {saveWarning && <p role="alert" className="mb-3 text-[12.5px] text-danger">{saveWarning}</p>}
        {notice && <p role="status" className="mb-3 text-[12.5px] text-ink-secondary">{notice}</p>}
        {tab === 0 && <>
          {hasOriginal && <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-accent-soft px-3 py-2 text-[12.5px] leading-normal"><span className="min-w-0 flex-1">This is your copy. Bots using it get your saved instructions.</span><button type="button" disabled={reverting} onClick={() => void revert()} className={`${SOFT} !min-h-[30px] !px-3 !text-[12.5px]`}>{reverting ? "Going back…" : "Go back to the original"}</button></div>}
          {revertScan && <div role="alertdialog" data-box-exempt="inline confirm inside a section" aria-label="Use the original anyway?" className="mb-4 rounded-lg border border-warning/40 bg-card p-3 text-[12.5px]"><p className="font-medium">Use the original anyway?</p><p className="mt-1 text-ink-secondary">The skill check found:</p><ul className="my-2 list-disc pl-4">{findingLines(revertScan).map((line) => <li key={line}>{line}</li>)}</ul><div className="flex flex-wrap gap-2"><button type="button" disabled={reverting} className={SOFT} onClick={() => void revert(revertScan)}>Use it anyway</button><button type="button" disabled={reverting} className={SOFT} onClick={() => setRevertScan(null)}>Cancel</button></div></div>}
          <SkillReaderView skill={reader} instructionsOnly mode={{ kind: "settings" }} busy={false} pending={null} error="" showAll onBack={noop} onSwitch={noop} onConfirm={noop} onCancel={noop} onDelete={noop} onShowAll={noop} />
        </>}
        {tab === 1 && <>
          <p className="mb-3 text-[12.5px] leading-normal text-ink-secondary">Everything that comes with this skill. Read SKILL.md in Instructions. {files.some((file) => file.path !== "SKILL.md" && file.content === undefined) ? "Extra files are listed here; their contents aren’t available." : "Click an extra file to read it."}</p>
          <ul className="space-y-1.5">{files.map((file) => <li key={file.path}><button type="button" aria-expanded={fileOpen === file.path} onClick={() => { if (file.path === "SKILL.md") { setTab(0); document.getElementById(`${id}-tab-0`)?.focus(); } else setFileOpen(fileOpen === file.path ? "" : file.path); }} className={`flex w-full items-center gap-2 rounded-lg border border-hairline/50 px-3 py-2.5 text-left hover:bg-control ${SKILL_FOCUS}`}><FileText size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block break-all font-mono text-[12.5px]">{file.path}</span><span className="block text-[11.5px] text-ink-secondary">{file.path === "SKILL.md" ? "The instructions the bot follows" : "Extra file the skill refers to"}</span></span>{file.size !== undefined && <span className="text-[12px] text-ink-secondary">{file.size < 1024 ? `${file.size} B` : `${Math.ceil(file.size / 1024)} KB`}</span>}<span className="rounded-full bg-control px-3 py-1 text-[12.5px]">{fileOpen === file.path ? "Hide" : file.path !== "SKILL.md" && file.content === undefined ? "Details" : "Read"}</span></button></li>)}</ul>
          {currentFile && <section aria-label="File contents" className="mt-3"><h3 className="mb-1 break-all text-[12px] text-ink-secondary">{currentFile.path}</h3><pre className="whitespace-pre-wrap break-words rounded-lg border border-hairline/50 bg-inset p-3 font-mono text-[12.5px] leading-relaxed">{currentFile.content ?? "This file comes with the skill. Its contents aren’t available here."}</pre></section>}
        </>}
        {tab === 2 && <><p className="mb-2 text-[12.5px] leading-normal text-ink-secondary">{using.length ? `${using.length} ${using.length === 1 ? "bot uses" : "bots use"} this skill. Changes apply from the bot’s next message.` : "No bot uses this skill yet. Add it to a bot and that bot can use it from its next message."}</p><BotsPicker key={`${activeId}-list`} disabled={reverting} view="list" skillId={activeId} skill={reader} originalSkillId={mine ? detail.originalRef || copiedFrom || undefined : undefined} bots={allBots} onChanged={changed} /></>}
      </div>
    </>}
    {discard && <DiscardConfirmation
      onKeep={() => { leaveAfterDiscard.current = null; setKeepId(skillId); setDiscard(false); }}
      onDiscard={() => {
        setKeepId(null); setDiscard(false); setEditing(false); setDirty(false);
        if (skillId !== selectionId) { setSelectionId(skillId); setActiveId(skillId); setCopiedFrom(null); }
      }}
    />}
  </section>;
}
