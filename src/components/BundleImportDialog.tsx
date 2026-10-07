import { useEffect, useRef, useState } from "react";
import { api, type Bot, type Group } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { t } from "@/lib/i18n";
import { ImportGuardFindings, OfficialMark, guardBlockedNote, type GuardScan, type OfficialStatus } from "./ImportGuardFindings";
import { ImportScanProgress } from "./ImportScanProgress";
import { isCheckStopped, useImportScan, withScanId } from "@/lib/importScan";

type Selection = { agents: string[]; skills: string[]; routines: string[]; instructions: string[] };
type Scan = GuardScan;
interface Options {
  archiveSha256: string; scan: Scan; official?: OfficialStatus;
  agents?: { key: string; name: string; skills?: string[] }[];
  skills?: { key: string; name: string; dependencies?: string[]; license?: string }[];
  routines?: { key: string; name: string; agent?: string }[];
  instructions?: { agent: string; path: string }[];
}
interface Preview {
  archiveSha256: string; reviewHash: string; scan: Scan; official?: OfficialStatus; missingDependencies: string[];
  summary: { name: string; agents: number; skills: number; routines: number; instructions: number; suggestedChief: string | null } | null;
  comparison?: {
    status: "new" | "compared" | "unavailable"; incomingRelease: string; previousRelease?: string;
    changes: { category: string; key: string; change: "added" | "changed" | "omitted" }[];
  };
}
export interface BundleImportResult { name: string; bots: Bot[]; groups: Group[]; routines: Routine[] }
const emptySelection = (): Selection => ({ agents: [], skills: [], routines: [], instructions: [] });

export function BundleImportDialog({ archivePath, fileName, onClose, onImported }: {
  archivePath: string; fileName: string; onClose: () => void; onImported: (result: BundleImportResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const gate = useRef(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<"loading" | "preview" | "import" | null>("loading");
  const [error, setError] = useState("");
  const check = useImportScan(busy !== null);
  const load = async () => {
    setBusy("loading"); setOptions(null); setPreview(null); setSelection(emptySelection()); setAcknowledged(false);
    const { scanId, signal } = check.begin();
    try { setOptions(await api(withScanId("/api/packages/import", scanId), { method: "POST", signal, body: JSON.stringify({ archivePath, action: "options" }) })); }
    catch (cause) { if (isCheckStopped(cause)) return; setError(cause instanceof Error ? cause.message : "Could not inspect this package."); }
    finally { setBusy(null); }
  };
  useEffect(() => { dialog.current?.showModal(); void load(); }, []);
  const toggle = (field: keyof Selection, key: string) => {
    setSelection(current => ({ ...current, [field]: current[field].includes(key) ? current[field].filter(value => value !== key) : [...current[field], key] }));
    setPreview(null); setAcknowledged(false); setError("");
  };
  const inspect = async () => {
    if (gate.current || !options || options.scan.blocked) return;
    gate.current = true; setBusy("preview"); setPreview(null); setAcknowledged(false); setError("");
    const { scanId, signal } = check.begin();
    try {
      const next = await api(withScanId("/api/packages/import", scanId), { method: "POST", signal, body: JSON.stringify({ archivePath, action: "preview", selection }) }) as Preview;
      if (next.archiveSha256 !== options.archiveSha256) {
        await load(); setError("The package changed. Choose its contents again and review a fresh preview.");
      } else setPreview(next);
    } catch (cause) { if (isCheckStopped(cause)) return; setError(cause instanceof Error ? cause.message : "Could not preview this selection."); }
    finally { gate.current = false; setBusy(null); }
  };
  const install = async () => {
    if (gate.current || !preview?.summary || preview.scan.blocked || preview.missingDependencies.length || (preview.scan.reviewRequired && !acknowledged)) return;
    gate.current = true; setBusy("import"); setError("");
    const { scanId, signal } = check.begin();
    try {
      const result = await api(withScanId("/api/packages/import", scanId), { method: "POST", signal, body: JSON.stringify({
        archivePath, action: "import", selection, archiveSha256: preview.archiveSha256, reviewHash: preview.reviewHash, acknowledgeWarnings: acknowledged,
      }) }) as { bots: Bot[]; groups?: Group[]; routines?: Routine[] };
      onImported({ name: preview.summary.name, bots: result.bots, groups: result.groups ?? [], routines: result.routines ?? [] });
    } catch (cause) {
      if (isCheckStopped(cause)) return;
      setPreview(null); setAcknowledged(false);
      if ((cause as { status?: number }).status === 409) {
        await load(); setError("The reviewed package changed or was already imported. Check the workspace, then choose contents and review again.");
      } else setError((cause instanceof Error ? cause.message : "Import failed.") + " Review the selection again before importing.");
    } finally { gate.current = false; setBusy(null); }
  };
  // Closing the dialog ends a check that is still reading the package.
  const closeDialog = () => { check.stop(); onClose(); };
  const scan = preview?.scan ?? options?.scan;
  const checkbox = (field: keyof Selection, key: string, name: string, detail?: string) => <label key={key} className="flex items-start gap-2 py-1.5 text-[13px]">
    <input type="checkbox" checked={selection[field].includes(key)} disabled={Boolean(busy)} onChange={() => toggle(field, key)} className="mt-0.5" />
    <span className="min-w-0 break-words">{name}{detail && <span className="mt-0.5 block text-[11px] text-ink-secondary">{detail}</span>}</span>
  </label>;
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); closeDialog(); }} aria-labelledby="bundle-import-title"
    className="m-auto max-h-[calc(100dvh-2rem-2*max(var(--inset-top),var(--inset-bottom)))] w-[calc(100%-2rem)] max-w-[580px] overflow-y-auto rounded-xl border border-hairline/50 bg-panel p-5 text-ink backdrop:bg-black/60">
    <h2 id="bundle-import-title" className="text-[18px] font-semibold">Import selected package contents</h2>
    <p className="mt-1 break-words text-[12px] text-ink-secondary">{fileName}</p>
    <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary">Imported bots receive fresh identities. Skills and routines stay disabled; connections, computer access and Chief roles are not granted.</p>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("importGuard.askNote")}</p>
    <OfficialMark status={preview?.official ?? options?.official} />
    {busy !== null && <ImportScanProgress progress={check.progress} />}
    {options && !options.scan.blocked && <div className="mt-4 space-y-3">
      <fieldset><legend className="text-[13px] font-semibold">Bots</legend>{options.agents?.map(agent => checkbox("agents", agent.key, agent.name, agent.skills?.length ? "Required skills: " + agent.skills.join(", ") : undefined))}</fieldset>
      <fieldset><legend className="text-[13px] font-semibold">Skills</legend>{options.skills?.length ? options.skills.map(skill => checkbox("skills", skill.key, skill.name, [skill.license, skill.dependencies?.length ? "Requires: " + skill.dependencies.join(", ") : ""].filter(Boolean).join(" · "))) : <p className="text-[12px] text-ink-secondary">No skills in this package.</p>}</fieldset>
      <fieldset><legend className="text-[13px] font-semibold">Instructions</legend>{options.instructions?.length ? options.instructions.map(instruction => checkbox("instructions", instruction.agent, (options.agents?.find(agent => agent.key === instruction.agent)?.name ?? instruction.agent) + " instructions")) : <p className="text-[12px] text-ink-secondary">No separate instruction files.</p>}</fieldset>
      <fieldset><legend className="text-[13px] font-semibold">Routines</legend>{options.routines?.length ? options.routines.map(routine => checkbox("routines", routine.key, routine.name, "Imports paused")) : <p className="text-[12px] text-ink-secondary">No routines in this package.</p>}</fieldset>
    </div>}
    {scan?.blocked && <p role="alert" className="mt-4 text-[13px] text-danger">{guardBlockedNote(scan)}</p>}
    {scan && !scan.blocked && scan.reviewRequired && <p className="mt-4 text-[12px] text-ink-secondary">{t("importGuard.reviewNote")}</p>}
    <ImportGuardFindings scan={scan} />
    {preview && !preview.scan.blocked && <section aria-label="Import review" className="mt-4 rounded-lg bg-inset p-3 text-[12px]">
      {preview.summary && <p>{preview.summary.agents} bots, {preview.summary.skills} disabled skills, {preview.summary.instructions} instruction files and {preview.summary.routines} paused routines.</p>}
      {preview.missingDependencies.length > 0 && <p role="alert" className="text-danger">Select the missing dependencies: {preview.missingDependencies.join(", ")}. Nothing will be added automatically.</p>}
      {preview.summary?.suggestedChief && <p className="mt-2 text-ink-secondary">The suggested Chief arrives as an ordinary bot. Your current Chief stays unchanged.</p>}
      {preview.comparison && preview.comparison.status !== "new" && <section aria-label="Package version comparison" className="mt-3 rounded-lg border border-hairline/50 bg-panel p-3">
        <h3 className="font-semibold">Package version comparison</h3>
        {preview.comparison.status === "compared" ? <>
          <p className="mt-1 break-words text-ink-secondary">Last imported selection: {preview.comparison.previousRelease ?? "Version unavailable"} · Selected package: {preview.comparison.incomingRelease}</p>
          <p className="mt-1 text-ink-secondary">This compares the last imported selection, not your current local edits.</p>
          {preview.comparison.changes.length > 0 ? <ul className="mt-2 space-y-1">
            {preview.comparison.changes.map((change, index) => <li key={index} className="break-words">
              <span className="font-medium">{change.change === "omitted" ? "Not included" : change.change === "added" ? "Added" : "Changed"}</span>
              {" · " + change.category + ": " + change.key}
            </li>)}
          </ul> : <p className="mt-2 text-ink-secondary">No differences from that saved selection were found.</p>}
        </> : <p className="mt-1 text-ink-secondary">The prior version lacks saved comparison data, so its changes cannot be shown.</p>}
        <p className="mt-2 font-medium">Imports a separate copy; existing bots and permissions stay unchanged.</p>
      </section>}
      <p className="mt-2 text-ink-secondary">{t("importGuard.scanNote")}</p>
      {preview.scan.reviewRequired && <label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={acknowledged} disabled={Boolean(busy)} onChange={event => setAcknowledged(event.target.checked)} />{t("importGuard.acknowledge")}</label>}
    </section>}
    {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button type="button" disabled={busy === "import"} onClick={closeDialog} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary disabled:opacity-50">{busy === "loading" || busy === "preview" ? t("importGuard.stopCheck") : "Cancel"}</button>
      {!options && !busy && <button type="button" onClick={() => { setError(""); void load(); }} className="rounded-lg bg-control px-3 py-2 text-[13px]">Retry</button>}
      {options && !options.scan.blocked && <button type="button" disabled={Boolean(busy) || !selection.agents.length} onClick={() => void inspect()} className="rounded-lg bg-control px-3 py-2 text-[13px] disabled:opacity-50">{busy === "preview" ? "Checking selection…" : "Preview selection"}</button>}
      {preview && !preview.scan.blocked && <button type="button" disabled={Boolean(busy) || !preview.summary || preview.missingDependencies.length > 0 || (preview.scan.reviewRequired && !acknowledged)} onClick={() => void install()} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50">{busy === "import" ? "Importing…" : "Import package"}</button>}
    </div>
  </dialog>;
}
