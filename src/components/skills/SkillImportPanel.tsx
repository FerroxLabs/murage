// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Import a skill: drop a file, folder or zip, or paste a link. It is read,
// checked by Skill Guard, and lands in Your skills switched on for no bot.
// Rendered in place inside Settings (never a separate top-layer dialog).
import { ChevronLeft, Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { VerdictBadge } from "./VerdictBadge";
import { findingLines, importSkill, refusalOf, type ImportInput, type SkillDetail } from "@/lib/skills-api";

const MAX_FILE_BYTES = 256 * 1024;
type Picked = { files: Array<{ path: string; content: string }>; skipped: string[] };

/** A file's text, or null when it is not text (or too big to be a skill file). */
async function textOf(file: File): Promise<string | null> {
  if (file.size > MAX_FILE_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function readEntries(entry: FileSystemEntry, prefix: string, out: Array<{ path: string; file: File }>): Promise<void> {
  if (out.length > 200) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ path: `${prefix}${entry.name}`, file });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await readEntries(child, `${prefix}${entry.name}/`, out);
  }
}

async function picked(list: Array<{ path: string; file: File }>): Promise<Picked> {
  const files: Picked["files"] = [];
  const skipped: string[] = [];
  for (const { path, file } of list) {
    if (/(^|\/)\.DS_Store$|(^|\/)__MACOSX\//.test(path)) continue;
    const text = await textOf(file);
    if (text === null) skipped.push(path);
    else files.push({ path, content: text });
  }
  return { files, skipped };
}

/** What was dropped or chosen, as an import request. */
export async function importInputFrom(list: Array<{ path: string; file: File }>, folder: boolean): Promise<ImportInput | { error: string }> {
  if (!list.length) return { error: "Nothing was dropped." };
  if (list.length === 1 && /\.zip$/i.test(list[0]!.file.name)) return { zip: await base64Of(list[0]!.file), label: list[0]!.file.name };
  if (list.length === 1 && !folder) {
    const text = await textOf(list[0]!.file);
    if (text === null) return { error: "That file isn't a skill. Drop a skill's SKILL.md, its folder, or a zip of it." };
    return { files: [{ path: "SKILL.md", content: text }], kind: "file", label: list[0]!.file.name };
  }
  const read = await picked(list);
  return { files: read.files, skipped: read.skipped, kind: "folder", label: list[0]!.path.split("/")[0] };
}

type State = { kind: "idle" } | { kind: "checking" } | { kind: "done"; skill: SkillDetail } | { kind: "exists"; input: ImportInput; message: string };

export function SkillImportPanel({ onBack, onOpen }: { onBack(): void; onOpen(ref: string): void }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const send = async (input: ImportInput | { error: string }) => {
    if ("error" in input) return setError(input.error);
    setError("");
    setState({ kind: "checking" });
    try {
      const { skill } = await importSkill(input);
      setState({ kind: "done", skill });
    } catch (cause) {
      const refusal = refusalOf(cause);
      if (refusal.code === "exists") return setState({ kind: "exists", input, message: refusal.message });
      setState({ kind: "idle" });
      setError(refusal.message || "That couldn't be imported.");
    }
  };

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const items = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => Boolean(entry));
    if (items.length === 1 && items[0]!.isDirectory) {
      const list: Array<{ path: string; file: File }> = [];
      await readEntries(items[0]!, "", list);
      return send(await importInputFrom(list, true));
    }
    return send(await importInputFrom([...event.dataTransfer.files].map((file) => ({ path: file.name, file })), false));
  };

  return (
    <div className="mt-1">
      <button type="button" onClick={onBack} className="-ml-1.5 flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
        <ChevronLeft size={14} aria-hidden="true" />
        All skills
      </button>
      <h3 className="mt-2 text-[15px] font-medium text-ink">Import a skill</h3>
      <p className="mt-0.5 text-[12.5px] text-ink-secondary">It's checked for red flags first, and switched on for no bot until you choose.</p>

      {state.kind === "checking" ? (
        <p role="status" className="mt-4 text-[13px] text-ink">Checking…</p>
      ) : state.kind === "done" ? (
        <div className="mt-4 rounded-lg bg-inset p-3">
          <div className="text-[13px] font-medium text-ink">{state.skill.name} is in your skills.</div>
          <div className="mt-1"><VerdictBadge verdict={state.skill.verdict} spelled /></div>
          {findingLines(state.skill.scan).length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-[12px] text-ink-secondary">{findingLines(state.skill.scan).map((line) => <li key={line}>{line}</li>)}</ul>
          )}
          {state.skill.skipped.length > 0 && <p className="mt-1 text-[11.5px] text-ink-secondary">Not kept (not text): {state.skill.skipped.join(", ")}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => onOpen(state.skill.ref)} className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white">Open it</button>
            <button type="button" onClick={() => setState({ kind: "idle" })} className="rounded-lg bg-control px-3 py-1.5 text-[12.5px] font-medium text-ink">Import another</button>
          </div>
        </div>
      ) : state.kind === "exists" ? (
        <div role="alertdialog" aria-label="Replace this skill?" className="mt-4 rounded-lg border border-warning/40 bg-card p-3 text-[12.5px] text-ink">
          <div className="font-medium">{state.message} Replace it?</div>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void send({ ...state.input, replace: true } as ImportInput)} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white">Replace</button>
            <button type="button" onClick={() => setState({ kind: "idle" })} className="rounded-lg bg-control px-3 py-1.5 font-medium text-ink">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div
            onDragOver={(event) => { event.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => void onDrop(event)}
            className={`mt-4 flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center ${over ? "border-accent bg-accent/5" : "border-hairline/60"}`}
          >
            <Upload size={20} className="text-ink-secondary" aria-hidden="true" />
            <div className="text-[13px] text-ink">Drop a skill's file, folder or zip here</div>
            <div className="flex gap-2">
              <button type="button" onClick={() => fileInput.current?.click()} className="rounded-lg bg-control px-3 py-1.5 text-[12.5px] font-medium text-ink">Choose a file…</button>
              <button type="button" onClick={() => folderInput.current?.click()} className="rounded-lg bg-control px-3 py-1.5 text-[12.5px] font-medium text-ink">Choose a folder…</button>
            </div>
            <input ref={fileInput} type="file" accept=".md,.zip,text/markdown,application/zip" hidden aria-label="Choose a skill file or zip"
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importInputFrom([{ path: file.name, file }], false).then(send); }} />
            <input ref={folderInput} type="file" hidden aria-label="Choose a skill folder" {...{ webkitdirectory: "" }}
              onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) void importInputFrom(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })), true).then(send); }} />
          </div>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => { event.preventDefault(); if (link.trim()) void send({ link: link.trim() }); }}
          >
            <input
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="or paste a link to a skill on GitHub"
              aria-label="Link to a skill"
              className="min-h-10 min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 text-[13px] text-ink placeholder:text-ink-secondary"
            />
            <button type="submit" disabled={!link.trim()} className="rounded-lg bg-control px-3 text-[12.5px] font-medium text-ink disabled:opacity-50">Import</button>
          </form>
        </>
      )}
      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
