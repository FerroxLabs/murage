import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { downloadSelectedBotPackage, type TeamExportSelection } from "@/lib/team-files";

interface Options {
  bots: { id: string; key: string; name: string; playbookKeys: string[] }[];
  playbooks: { key: string; name: string }[];
  routines: { id: string; key: string; name: string; botId: string; supported: boolean }[];
}
interface Preview { name: string; members: number; previewHash: string; markdown?: string; scan: { blocked: boolean; reviewRequired: boolean; findings: { path: string; rule: string; line?: number }[] } }
export function TeamExportDialog({ onClose, onExported }: { onClose: () => void; onExported: (result: { name: string; members: number }) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [selection, setSelection] = useState<TeamExportSelection>({ botIds: [], playbookKeys: [], routineIds: [] });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<"loading" | "preview" | "download" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(false);
  const load = async () => {
    setBusy("loading"); setError(null);
    try { setOptions(await api("/api/teams/export", { method: "POST", body: JSON.stringify({ format: "package", action: "options" }) })); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not load export options."); }
    finally { setBusy(null); }
  };
  useEffect(() => { dialog.current?.showModal(); void load(); }, []);
  const toggle = (field: keyof TeamExportSelection, value: string) => {
    setSelection(current => ({ ...current, [field]: current[field].includes(value) ? current[field].filter(item => item !== value) : [...current[field], value] }));
    setPreview(null); setAcknowledged(false); setError(null);
  };
  const inspect = async () => {
    if (gate.current) return; gate.current = true;
    setBusy("preview"); setError(null); setPreview(null); setAcknowledged(false);
    try { setPreview(await api("/api/teams/export", { method: "POST", body: JSON.stringify({ format: "package", action: "preview", selection }) })); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not preview this selection."); }
    finally { gate.current = false; setBusy(null); }
  };
  const download = async () => {
    if (!preview || preview.scan.blocked || (preview.scan.reviewRequired && !acknowledged) || gate.current) return;
    gate.current = true; setBusy("download"); setError(null);
    try { const result = await downloadSelectedBotPackage(selection, preview.previewHash, acknowledged); onExported(result); onClose(); }
    catch (error) {
      setPreview(null); setAcknowledged(false);
      setError(`${error instanceof Error ? error.message : "Download failed."} Preview the selection again before downloading.`);
    } finally { gate.current = false; setBusy(null); }
  };
  const check = (field: keyof TeamExportSelection, id: string, label: string, disabled = false) => <label key={id} className="flex items-start gap-2 py-1.5 text-[13px] text-ink">
    <input type="checkbox" checked={selection[field].includes(id)} disabled={Boolean(busy) || disabled} onChange={() => toggle(field, id)} className="mt-0.5" />
    <span>{label}</span>
  </label>;
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="team-export-title"
    className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[560px] overflow-y-auto rounded-xl border border-hairline/50 bg-panel p-5 text-ink backdrop:bg-black/60">
    <h2 id="team-export-title" className="text-[18px] font-semibold">Export selected contents</h2>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Choose bots, playbooks and routines. Routines export paused. File-based skill bundles are not included in this export.</p>
    {busy === "loading" && <p role="status" className="mt-3">Loading export options…</p>}
    {options && <div className="mt-4 space-y-3">
      <fieldset><legend className="text-[13px] font-semibold">Bots</legend>{options.bots.map(bot => check("botIds", bot.id, bot.name))}</fieldset>
      <fieldset><legend className="text-[13px] font-semibold">Playbooks</legend>{options.playbooks.length ? options.playbooks.map(playbook => check("playbookKeys", playbook.key, playbook.name)) : <p className="text-[12px] text-ink-secondary">No playbooks available.</p>}</fieldset>
      <fieldset><legend className="text-[13px] font-semibold">Routines</legend>{options.routines.length ? options.routines.map(routine => check("routineIds", routine.id, `${routine.name}${routine.supported ? "" : " — not supported for export"}`, !routine.supported)) : <p className="text-[12px] text-ink-secondary">No routines available.</p>}</fieldset>
    </div>}
    {preview && <section className="mt-4 rounded-lg bg-inset p-3" aria-label="Export review">
      <p className="text-[13px] font-medium">{preview.members} bots selected for export</p>
      <p className="mt-1 text-[12px] text-ink-secondary">The scan checks known patterns. Review the contents; it cannot guarantee they are safe or free of secrets.</p>
      {preview.scan.blocked && <p role="alert" className="mt-2 text-[13px] text-danger">Export blocked. Remove the flagged contents before previewing again.</p>}
      {preview.scan.findings.length > 0 && <ul className="mt-2 space-y-1 text-[12px] text-ink-secondary">{preview.scan.findings.map((finding, i) => <li key={i} className="break-words">{finding.path}: {finding.rule}{finding.line ? ` (line ${finding.line})` : ""}</li>)}</ul>}
      {!preview.scan.blocked && preview.markdown && <details className="mt-3 text-[12px]">
        <summary className="cursor-pointer font-medium">Review exported text</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel p-2 text-[11px] text-ink-secondary">{preview.markdown}</pre>
      </details>}
      {preview.scan.reviewRequired && !preview.scan.blocked && <label className="mt-3 flex items-start gap-2 text-[12px]"><input type="checkbox" checked={acknowledged} disabled={Boolean(busy)} onChange={event => setAcknowledged(event.target.checked)} />I reviewed the warnings and want to export this selection.</label>}
    </section>}
    {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button type="button" disabled={Boolean(busy)} onClick={onClose} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary disabled:opacity-50">Cancel</button>
      {!options && !busy && <button type="button" onClick={() => void load()} className="rounded-lg bg-control px-3 py-2 text-[13px]">Retry</button>}
      {options && <button type="button" disabled={Boolean(busy) || !selection.botIds.length} onClick={() => void inspect()} className="rounded-lg bg-control px-3 py-2 text-[13px] disabled:opacity-50">{busy === "preview" ? "Checking contents…" : "Preview selection"}</button>}
      {preview && <button type="button" disabled={Boolean(busy) || preview.scan.blocked || (preview.scan.reviewRequired && !acknowledged)} onClick={() => void download()} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50">{busy === "download" ? "Downloading…" : "Download package"}</button>}
    </div>
  </dialog>;
}
