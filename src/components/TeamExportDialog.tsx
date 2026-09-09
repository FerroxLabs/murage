import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { downloadSelectedBotPackage, downloadSelectedBotPackageZip, type ZipExportSelection } from "@/lib/team-files";

interface Options {
  bots: { id: string; key: string; name: string; title?: string; description?: string; role?: "individual" | "member" | "leader" | "chief"; team?: string; playbookKeys: string[]; requiredApps?: { label: string; reason: string }[] }[];
  groups?: { id: string; name: string; memberIds: string[] }[];
  playbooks: { key: string; name: string; summary?: string; instructions?: string }[];
  routines: { id: string; key: string | null; name: string; botId: string; supported: boolean; prompt?: string; schedule?: { type: string; time?: string; everyMinutes?: number; at?: number } }[];
  skills?: { id: string; botId: string; name: string; license?: string; dependencies: null }[];
}
interface Preview { name: string; members: number; previewHash: string; markdown?: string; files?: { path: string; bytes: number; sha256: string; content?: string }[]; reviewWarnings?: string[]; scan: { blocked: boolean; reviewRequired: boolean; findings: { path: string; rule: string; line?: number }[] } }
export function TeamExportDialog({ onClose, onExported, initialBotIds = [] }: { onClose: () => void; onExported: (result: { name: string; members: number }) => void; initialBotIds?: string[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [format, setFormat] = useState<"markdown" | "zip">("zip");
  const [selection, setSelection] = useState<ZipExportSelection>({ botIds: [...initialBotIds], playbookKeys: [], routineIds: [], skillIds: [] });
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<"loading" | "preview" | "download" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(false);
  const load = async (nextFormat = format) => {
    setBusy("loading"); setError(null);
    try {
      const loaded = await api(nextFormat === "zip" ? "/api/packages/export" : "/api/teams/export", { method: "POST", body: JSON.stringify({ ...(nextFormat === "markdown" ? { format: "package" } : {}), action: "options" }) }) as Options;
      setOptions(loaded);
      setSelection(current => ({ ...current, botIds: current.botIds.filter(id => loaded.bots.some(bot => bot.id === id)) }));
    }
    catch (error) { setError(error instanceof Error ? error.message : "Could not load export options."); }
    finally { setBusy(null); }
  };
  useEffect(() => { dialog.current?.showModal(); void load(); }, []);
  const changeFormat = (nextFormat: "markdown" | "zip") => {
    if (busy || nextFormat === format) return;
    setFormat(nextFormat); setOptions(null); setSelection(current => ({ ...current, skillIds: [] }));
    setPreview(null); setAcknowledged(false); void load(nextFormat);
  };
  const requestSelection = () => format === "zip" ? selection : { botIds: selection.botIds, playbookKeys: selection.playbookKeys, routineIds: selection.routineIds };
  const toggle = (field: keyof ZipExportSelection, value: string) => {
    setSelection(current => {
      const next = { ...current, [field]: current[field].includes(value) ? current[field].filter(item => item !== value) : [...current[field], value] };
      if (field === "botIds") {
        next.skillIds = next.skillIds.filter(id => options?.skills?.some(skill => skill.id === id && next.botIds.includes(skill.botId)));
        next.routineIds = next.routineIds.filter(id => options?.routines.some(routine => routine.id === id && next.botIds.includes(routine.botId)));
        next.playbookKeys = next.playbookKeys.filter(key => options?.bots.some(bot => next.botIds.includes(bot.id) && bot.playbookKeys.includes(key)));
      }
      return next;
    });
    setPreview(null); setAcknowledged(false); setError(null);
  };
  const inspect = async () => {
    if (gate.current) return; gate.current = true;
    setBusy("preview"); setError(null); setPreview(null); setAcknowledged(false);
    try { setPreview(await api(format === "zip" ? "/api/packages/export" : "/api/teams/export", { method: "POST", body: JSON.stringify({ ...(format === "markdown" ? { format: "package" } : {}), action: "preview", selection: requestSelection() }) })); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not preview this selection."); }
    finally { gate.current = false; setBusy(null); }
  };
  const download = async () => {
    if (!preview || preview.scan.blocked || ((preview.scan.reviewRequired || preview.reviewWarnings?.length) && !acknowledged) || gate.current) return;
    gate.current = true; setBusy("download"); setError(null);
    try {
      const result = format === "zip"
        ? await downloadSelectedBotPackageZip(selection, preview.previewHash, acknowledged, { name: preview.name, members: preview.members })
        : await downloadSelectedBotPackage(requestSelection(), preview.previewHash, acknowledged);
      onExported(result); onClose();
    }
    catch (error) {
      setPreview(null); setAcknowledged(false);
      setError(`${error instanceof Error ? error.message : "Download failed."} Preview the selection again before downloading.`);
    } finally { gate.current = false; setBusy(null); }
  };
  const check = (field: keyof ZipExportSelection, id: string, label: string, disabled = false) => <label key={id} className="flex items-start gap-2 py-1.5 text-[13px] text-ink">
    <input type="checkbox" checked={selection[field].includes(id)} disabled={Boolean(busy) || disabled} onChange={() => toggle(field, id)} className="mt-0.5" />
    <span className="min-w-0 break-words">{label}</span>
  </label>;
  const selectedBots = options?.bots.filter(bot => selection.botIds.includes(bot.id)) ?? [];
  const selectedPlaybooks = options?.playbooks.filter(playbook => selectedBots.some(bot => bot.playbookKeys.includes(playbook.key))) ?? [];
  const selectedRoutines = options?.routines.filter(routine => selection.botIds.includes(routine.botId)) ?? [];
  const visibleBots = options?.bots.filter(bot => `${bot.name} ${bot.title ?? ""} ${bot.team ?? "General"}`.toLowerCase().includes(search.toLowerCase().trim())) ?? [];
  const teams = [...new Set(visibleBots.map(bot => bot.team || "General"))];
  const roleLabel = (role: Options["bots"][number]["role"]) => role === "chief" ? "Chief of Staff" : role === "leader" ? "Team leader" : role === "individual" ? "Individual bot" : "Team member";
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="team-export-title"
    className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[680px] overflow-y-auto rounded-xl border border-hairline/50 bg-panel p-5 text-ink backdrop:bg-black/60">
    <h2 id="team-export-title" className="text-[18px] font-semibold">Export bots and teams</h2>
    <p className="mt-1 text-[12px] text-ink-secondary">{selection.botIds.length} bots selected. Choose the instructions and assets to share.</p>
    <fieldset className="mt-3 flex flex-wrap gap-4 text-[13px]"><legend className="mb-1 text-[12px] font-medium text-ink-secondary">File format</legend>
      <label className="flex items-center gap-2"><input type="radio" name="export-format" checked={format === "zip"} disabled={Boolean(busy)} onChange={() => changeFormat("zip")} />ZIP package (.zip)</label>
      <label className="flex items-center gap-2"><input type="radio" name="export-format" checked={format === "markdown"} disabled={Boolean(busy)} onChange={() => changeFormat("markdown")} />Markdown (.md)</label>
    </fieldset>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{format === "zip"
      ? "Importable package with selected bot definitions, team relationships, playbooks, routines and skill files. Skills are never selected automatically."
      : "Readable, importable bot definitions, playbooks and routines. Skill files are excluded; switching formats clears skill selections. External agent systems must interpret the text themselves."}</p>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Credentials, conversations, private memory and permissions are excluded. Routines import paused and skills disabled. Roles are retained as intended setup; Chief and leader authority require explicit assignment after import.</p>
    {busy === "loading" && <p role="status" className="mt-3">Loading export options…</p>}
    {options && <div className="mt-4 space-y-3">
      <section aria-label="Choose bots">
        <label className="block text-[12px] font-medium" htmlFor="export-bot-search">Find a bot or team</label>
        <input id="export-bot-search" type="search" value={search} onChange={event => setSearch(event.target.value)} className="mt-1 w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px]" />
        <div className="mt-2 max-h-60 space-y-3 overflow-y-auto rounded-lg border border-hairline p-3">
          {teams.map(team => <fieldset key={team}><legend className="text-[13px] font-semibold">{team}</legend>
            <button type="button" disabled={Boolean(busy)} onClick={() => {
              setSelection(current => ({ ...current, botIds: [...new Set([...current.botIds, ...options.bots.filter(bot => (bot.team || "General") === team).map(bot => bot.id)])] }));
              setPreview(null); setAcknowledged(false);
            }} className="my-1 text-[12px] text-accent underline disabled:opacity-50">Select team</button>
            {visibleBots.filter(bot => (bot.team || "General") === team).map(bot => <div key={bot.id} className="py-1">
              {check("botIds", bot.id, bot.name)}<p className="ml-6 text-[12px] text-ink-secondary">{roleLabel(bot.role)}{bot.title ? ` · ${bot.title}` : ""}</p>
            </div>)}
          </fieldset>)}
          {!visibleBots.length && <p className="text-[12px] text-ink-secondary">No matching bots.</p>}
        </div>
      </section>
      {selectedBots.length > 0 && <section aria-label="Selected bot instructions"><h3 className="text-[13px] font-semibold">Selected instructions</h3>
        {selectedBots.map(bot => <details key={bot.id} className="mt-2 rounded-lg bg-inset p-2 text-[12px]"><summary className="cursor-pointer">{bot.name} · {roleLabel(bot.role)}</summary>
          <p className="mt-2 whitespace-pre-wrap break-words text-ink-secondary">{bot.description || "No custom instructions."}</p>
          {bot.requiredApps?.map(app => <p key={app.label} className="mt-2 text-ink-secondary">Requires separate setup: {app.label} — {app.reason}</p>)}
        </details>)}
      </section>}
      <fieldset><legend className="text-[13px] font-semibold">Playbooks</legend>{selectedPlaybooks.length ? selectedPlaybooks.map(playbook => <div key={playbook.key}>
        {check("playbookKeys", playbook.key, playbook.name)}
        <p className="ml-6 text-[12px] text-ink-secondary">{playbook.summary}</p>
        {selection.playbookKeys.includes(playbook.key) && playbook.instructions && <details className="ml-6 text-[12px]"><summary className="cursor-pointer">Review playbook instructions</summary><p className="mt-1 whitespace-pre-wrap break-words">{playbook.instructions}</p></details>}
      </div>) : <p className="text-[12px] text-ink-secondary">No playbooks for the selected bots.</p>}</fieldset>
      {format === "zip" && <fieldset><legend className="text-[13px] font-semibold">Skill files</legend>
        {!selection.botIds.length ? <p className="text-[12px] text-ink-secondary">Select a bot to choose its skills.</p>
          : options.skills?.some(skill => selection.botIds.includes(skill.botId))
            ? options.skills.filter(skill => selection.botIds.includes(skill.botId)).map(skill => check("skillIds", skill.id, skill.name + " — " + (options.bots.find(bot => bot.id === skill.botId)?.name ?? "Selected bot") + " · " + (skill.license || "License unspecified")))
            : <p className="text-[12px] text-ink-secondary">No installed skill files for the selected bots.</p>}
      </fieldset>}
      <fieldset><legend className="text-[13px] font-semibold">Routines · import paused</legend>{selectedRoutines.length ? selectedRoutines.map(routine => <div key={routine.id}>
        {check("routineIds", routine.id, `${routine.name}${routine.supported ? "" : " — not supported for export"}`, !routine.supported)}
        {selection.routineIds.includes(routine.id) && <details className="ml-6 text-[12px]"><summary className="cursor-pointer">Review routine</summary>
          <p className="mt-1 text-ink-secondary">{routine.schedule?.type === "daily" ? `Daily at ${routine.schedule.time}` : routine.schedule?.type === "interval" ? `Every ${routine.schedule.everyMinutes} minutes` : "Scheduled once"}</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{routine.prompt}</p>
        </details>}
      </div>) : <p className="text-[12px] text-ink-secondary">No routines for the selected bots.</p>}</fieldset>
    </div>}
    {preview && <section className="mt-4 rounded-lg bg-inset p-3" aria-label="Export review">
      <p className="text-[13px] font-medium">{preview.members} bots selected for export</p>
      <p className="mt-1 text-[12px] text-ink-secondary">Included: bot instructions, {selection.playbookKeys.length} playbooks, {selection.routineIds.length} paused routines{format === "zip" ? `, ${selection.skillIds.length} selected skills` : "; no skill files"}. Rooms include selected members only.</p>
      {options?.groups?.filter(group => group.memberIds.some(id => selection.botIds.includes(id))).map(group => <p key={group.id} className="mt-1 text-[12px] text-ink-secondary">Room: {group.name} — {group.memberIds.filter(id => selection.botIds.includes(id)).length} selected members{group.memberIds.some(id => !selection.botIds.includes(id)) ? "; other members omitted" : ""}.</p>)}
      <p className="mt-1 text-[12px] text-ink-secondary">Excluded: unselected assets, credentials, conversations, private memory, permission grants and engine sessions. Apps and unexported skill dependencies need separate setup.</p>
      <p className="mt-1 text-[12px] text-ink-secondary">The scan checks known patterns. Review the contents; it cannot guarantee they are safe or free of secrets.</p>
      {preview.scan.blocked && <p role="alert" className="mt-2 text-[13px] text-danger">Export blocked. Remove the flagged contents before previewing again.</p>}
      {preview.scan.findings.length > 0 && <ul className="mt-2 space-y-1 text-[12px] text-ink-secondary">{preview.scan.findings.map((finding, i) => <li key={i} className="break-words">{finding.path}: {finding.rule}{finding.line ? ` (line ${finding.line})` : ""}</li>)}</ul>}
      {!preview.scan.blocked && preview.markdown && <details className="mt-3 text-[12px]">
        <summary className="cursor-pointer font-medium">Review exported text</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel p-2 text-[11px] text-ink-secondary">{preview.markdown}</pre>
      </details>}
      {!preview.scan.blocked && preview.files && <details className="mt-3 text-[12px]">
        <summary className="cursor-pointer font-medium">Review included files ({preview.files.length})</summary>
        <ul className="mt-2 space-y-2">{preview.files.map(file => <li key={file.path} className="min-w-0 rounded-lg bg-panel p-2">
          <p className="break-all font-medium">{file.path}</p><p className="text-ink-secondary">{file.bytes.toLocaleString()} bytes</p>
          <details className="mt-1"><summary className="cursor-pointer text-ink-secondary">File hash</summary><code className="block break-all text-[10px]">{file.sha256}</code></details>
          {file.content !== undefined && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] text-ink-secondary">{file.content}</pre>}
        </li>)}</ul>
      </details>}
      {!preview.scan.blocked && Boolean(preview.reviewWarnings?.length) && <ul aria-label="Dependency review warnings" className="mt-3 space-y-1 text-[12px] text-ink-secondary">{preview.reviewWarnings!.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}</ul>}
      {(preview.scan.reviewRequired || Boolean(preview.reviewWarnings?.length)) && !preview.scan.blocked && <label className="mt-3 flex items-start gap-2 text-[12px]"><input type="checkbox" checked={acknowledged} disabled={Boolean(busy)} onChange={event => setAcknowledged(event.target.checked)} />I reviewed the warnings and want to export this selection.</label>}
    </section>}
    {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button type="button" disabled={Boolean(busy)} onClick={onClose} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary disabled:opacity-50">Cancel</button>
      {!options && !busy && <button type="button" onClick={() => void load()} className="rounded-lg bg-control px-3 py-2 text-[13px]">Retry</button>}
      {options && <button type="button" disabled={Boolean(busy) || !selection.botIds.length} onClick={() => void inspect()} className="rounded-lg bg-control px-3 py-2 text-[13px] disabled:opacity-50">{busy === "preview" ? "Checking contents…" : "Preview selection"}</button>}
      {preview && <button type="button" disabled={Boolean(busy) || preview.scan.blocked || ((preview.scan.reviewRequired || Boolean(preview.reviewWarnings?.length)) && !acknowledged)} onClick={() => void download()} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-50">{busy === "download" ? "Downloading…" : format === "zip" ? "Download ZIP package" : "Download package"}</button>}
    </div>
  </dialog>;
}
