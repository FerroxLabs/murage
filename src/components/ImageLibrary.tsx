// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Settings > Image generation: saved prompt blocks and reference packs, every
// scope. Loaded on first use (ImageSettings.tsx), so it adds nothing to the
// first paint. The owner reads a block, saves a new version of it, adds a
// workspace block, and deletes blocks and packs (soft: past renders keep the
// version they used).
import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";

export interface LibraryBlock { id: string; name: string; version: number; chars: number; scope: "workspace" | "bot"; botId?: string; botName?: string }
export interface LibraryPack { id: string; name: string; version: number; count: number; scope: "workspace" | "bot"; botId?: string; botName?: string }
export interface LibrarySnapshot { blocks: LibraryBlock[]; packs: LibraryPack[] }

const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const button = `min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink disabled:opacity-50 ${focus}`;
const field = `mt-1.5 w-full min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink ${focus}`;

/** "Workspace" or the bot's name. Pure, for tests. */
export function libraryScopeLabel(item: { scope: "workspace" | "bot"; botName?: string }): string {
  return item.scope === "workspace" ? t("imageLibrary.scope.workspace") : item.botName ?? t("imageLibrary.scope.bot");
}
/** One row's facts. Pure, for tests. */
export function libraryBlockLine(block: LibraryBlock): string {
  return t("imageLibrary.block.line", { scope: libraryScopeLabel(block), version: block.version, chars: block.chars.toLocaleString("en-US") });
}
export function libraryPackLine(pack: LibraryPack): string {
  return t(pack.count === 1 ? "imageLibrary.pack.lineOne" : "imageLibrary.pack.line", { scope: libraryScopeLabel(pack), version: pack.version, count: pack.count });
}

export default function ImageLibrary() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [open, setOpen] = useState<{ id: string; text: string } | null>(null);
  const [draft, setDraft] = useState({ name: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const run = async (work: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const done = await work();
      const next: LibrarySnapshot = await api("/api/images/library");
      if (mounted.current) { setSnapshot(next); if (done) setNotice(done); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("imageLibrary.error"));
    } finally { if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void run(async () => {}); return () => { mounted.current = false; }; }, []);
  const view = async (block: LibraryBlock) => {
    await run(async () => { const read: { block: { text: string } } = await api(`/api/images/prompt-blocks/${block.id}`); if (mounted.current) setOpen({ id: block.id, text: read.block.text }); });
  };
  const saveVersion = (block: LibraryBlock, text: string) => run(async () => {
    const saved: { block: { id: string; version: number; text: string } } = await api("/api/images/prompt-blocks", { method: "POST", body: JSON.stringify({ name: block.name, text, ...(block.botId ? { botId: block.botId } : {}) }) });
    if (mounted.current) setOpen({ id: saved.block.id, text: saved.block.text });
    return t("imageLibrary.block.saved", { name: block.name, version: saved.block.version });
  });
  const addBlock = () => run(async () => {
    const saved: { block: { version: number } } = await api("/api/images/prompt-blocks", { method: "POST", body: JSON.stringify(draft) });
    if (mounted.current) setDraft({ name: "", text: "" });
    return t("imageLibrary.block.saved", { name: draft.name, version: saved.block.version });
  });
  const remove = (path: string, name: string) => run(async () => {
    await api(path, { method: "DELETE" });
    if (mounted.current) setOpen(null);
    return t("imageLibrary.deleted", { name });
  });
  return <ImageLibraryView snapshot={snapshot} open={open} draft={draft} busy={busy} error={error} notice={notice}
    onView={block => void view(block)} onClose={() => setOpen(null)} onEdit={text => setOpen(current => current ? { ...current, text } : current)}
    onSaveVersion={(block, text) => void saveVersion(block, text)} onDraft={setDraft} onAdd={() => void addBlock()}
    onDeleteBlock={block => void remove(`/api/images/prompt-blocks/${block.id}`, block.name)} onDeletePack={pack => void remove(`/api/images/reference-packs/${pack.id}`, pack.name)} />;
}

export interface ImageLibraryViewProps {
  snapshot: LibrarySnapshot | null; open: { id: string; text: string } | null; draft: { name: string; text: string };
  busy: boolean; error: string; notice: string;
  onView: (block: LibraryBlock) => void; onClose: () => void; onEdit: (text: string) => void; onSaveVersion: (block: LibraryBlock, text: string) => void;
  onDraft: (draft: { name: string; text: string }) => void; onAdd: () => void; onDeleteBlock: (block: LibraryBlock) => void; onDeletePack: (pack: LibraryPack) => void;
}

/** Pure presentation of the library, for tests. */
export function ImageLibraryView({ snapshot, open, draft, busy, error, notice, onView, onClose, onEdit, onSaveVersion, onDraft, onAdd, onDeleteBlock, onDeletePack }: ImageLibraryViewProps) {
  return <div data-image-library className="mt-4 min-w-0 border-t border-hairline/40 pt-4">
    <h4 className="text-[13px] font-medium text-ink">{t("imageLibrary.blocks.title")}</h4>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("imageLibrary.blocks.intro")}</p>
    {snapshot && !snapshot.blocks.length && <p className="mt-2 text-[12px] text-ink-secondary">{t("imageLibrary.blocks.empty")}</p>}
    <ul className="mt-2 space-y-2">
      {snapshot?.blocks.map(block => <li key={block.id} className="min-w-0 rounded-lg border border-hairline/40 p-2">
        <p className="break-words text-[13px] text-ink">{block.name}</p>
        <p className="text-[12px] text-ink-secondary">{libraryBlockLine(block)}</p>
        {open?.id === block.id ? <>
          <label className="mt-2 block text-[12px] text-ink">{t("imageLibrary.block.text")}
            <textarea value={open.text} onChange={event => onEdit(event.target.value)} rows={8} className={field} />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy || !open.text.trim()} onClick={() => onSaveVersion(block, open.text)}>{t("imageLibrary.block.saveVersion")}</button>
            <button type="button" className={button} disabled={busy} onClick={onClose}>{t("imageLibrary.close")}</button>
          </div>
        </> : <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={button} disabled={busy} onClick={() => onView(block)}>{t("imageLibrary.block.view")}</button>
          <button type="button" className={button} disabled={busy} onClick={() => onDeleteBlock(block)}>{t("imageLibrary.delete")}</button>
        </div>}
      </li>)}
    </ul>
    <details className="mt-3">
      <summary className="min-h-11 cursor-pointer py-2 text-[12px] text-ink">{t("imageLibrary.block.new")}</summary>
      <label className="mt-2 block text-[12px] text-ink">{t("imageLibrary.block.name")}
        <input value={draft.name} onChange={event => onDraft({ ...draft, name: event.target.value })} className={field} placeholder="brand-lock" />
      </label>
      <label className="mt-2 block text-[12px] text-ink">{t("imageLibrary.block.text")}
        <textarea value={draft.text} onChange={event => onDraft({ ...draft, text: event.target.value })} rows={6} className={field} />
      </label>
      <button type="button" className={`mt-2 ${button}`} disabled={busy || !draft.name.trim() || !draft.text.trim()} onClick={onAdd}>{t("imageLibrary.block.add")}</button>
    </details>
    <h4 className="mt-4 text-[13px] font-medium text-ink">{t("imageLibrary.packs.title")}</h4>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("imageLibrary.packs.intro")}</p>
    {snapshot && !snapshot.packs.length && <p className="mt-2 text-[12px] text-ink-secondary">{t("imageLibrary.packs.empty")}</p>}
    <ul className="mt-2 space-y-2">
      {snapshot?.packs.map(pack => <li key={pack.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline/40 p-2">
        <div className="min-w-0"><p className="break-words text-[13px] text-ink">{pack.name}</p><p className="text-[12px] text-ink-secondary">{libraryPackLine(pack)}</p></div>
        <button type="button" className={button} disabled={busy} onClick={() => onDeletePack(pack)}>{t("imageLibrary.delete")}</button>
      </li>)}
    </ul>
    {busy && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("imageLibrary.busy")}</p>}
    {notice && <p role="status" className="mt-2 text-[12px] text-success">{notice}</p>}
    {error && <p role="alert" className="mt-2 break-words text-[12px] text-danger">{error}</p>}
  </div>;
}
