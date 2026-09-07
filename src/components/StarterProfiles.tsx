import { useEffect, useRef, useState } from "react";
import { api, useStore, type Bot, type Group } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { getDraft, getDraftAttachments, restoreComposerDraft } from "@/lib/drafts";
import { starterFirstTaskDraft } from "@/lib/starter-first-task";

interface Profile {
  id: string; name: string; summary: string; outcomes: string[]; members: number;
  agents: { key: string; name: string }[]; routines: { key: string; name: string }[]; connectionsRequired: boolean;
}
interface Preview {
  archiveSha256: string; reviewHash: string; missingDependencies: string[];
  summary: { name: string; agents: number; routines: number } | null;
  scan: { blocked: boolean; reviewRequired: boolean; findings: { path: string; rule: string }[] };
}
interface Imported { profileId: string; bots: Bot[]; groups: Group[]; routines: Routine[] }
export function StarterProfiles() {
  const { dispatch } = useStore();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [selected, setSelected] = useState<Profile | null>(null);
  const [routineKeys, setRoutineKeys] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [imported, setImported] = useState<Imported | null>(null);
  const [busy, setBusy] = useState<"loading" | "preview" | "import" | null>("loading");
  const [error, setError] = useState("");
  const gate = useRef(false);
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  const load = async () => {
    setBusy("loading"); setError("");
    try { const value = await api("/api/starter-profiles", { method: "POST", body: JSON.stringify({ action: "catalog" }) }); setProfiles(value.profiles); }
    catch { setError("Could not load starter profiles. Try again."); }
    finally { setBusy(null); }
  };
  useEffect(() => { void load(); }, []);
  const choose = (profile: Profile) => {
    setSelected(profile); setRoutineKeys([]); setPreview(null); setAcknowledged(false); setImported(null); setError("");
  };
  const selection = () => ({ agents: selected?.agents.map(agent => agent.key) ?? [], skills: [], instructions: [], routines: routineKeys });
  const inspect = async () => {
    if (!selected || gate.current) return;
    gate.current = true; setBusy("preview"); setError(""); setPreview(null); setAcknowledged(false);
    try { setPreview(await api("/api/starter-profiles", { method: "POST", body: JSON.stringify({ action: "preview", profileId: selected.id, selection: selection() }) })); }
    catch { setError("Could not review this starter profile. Try reviewing it again."); }
    finally { gate.current = false; setBusy(null); }
  };
  const install = async () => {
    if (!selected || !preview?.summary || preview.scan.blocked || preview.missingDependencies.length || (preview.scan.reviewRequired && !acknowledged) || gate.current || imported) return;
    gate.current = true; setBusy("import"); setError("");
    try {
      const result = await api("/api/starter-profiles", { method: "POST", body: JSON.stringify({
        action: "import", profileId: selected.id, selection: selection(), archiveSha256: preview.archiveSha256, reviewHash: preview.reviewHash, acknowledgeWarnings: acknowledged,
      }) }) as { bots: Bot[]; groups?: Group[]; routines?: Routine[] };
      for (const bot of result.bots) dispatch({ type: "botAdded", bot });
      for (const group of result.groups ?? []) dispatch({ type: "groupPatched", group });
      for (const routine of result.routines ?? []) dispatch({ type: "routinePatched", routine });
      setImported({ profileId: selected.id, bots: result.bots, groups: result.groups ?? [], routines: result.routines ?? [] });
      setPreview(null);
    } catch (cause) {
      setPreview(null); setAcknowledged(false);
      setError((cause as { status?: number }).status === 409
        ? "This review changed or was already imported. Check your workspace, then review the profile again."
        : "Could not confirm the import. Check your workspace, then review again before retrying.");
    } finally { gate.current = false; setBusy(null); }
  };
  const openFirstTask = () => {
    const bot = imported?.bots[0];
    if (!bot || !imported) return;
    const id = "bot:" + bot.id + ":" + bot.threadId;
    try {
      const storage = window.localStorage;
      // Draft helpers intentionally swallow storage errors. Check raw reads
      // first so an unreadable/malformed drawer is never treated as empty.
      for (const key of ["murage-drafts", "murage-draft-attachments"]) {
        const raw = storage.getItem(key);
        if (raw !== null) {
          const value = JSON.parse(raw);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unreadable drafts");
          if (Object.hasOwn(value, id) && (key === "murage-drafts" ? typeof value[id] !== "string" : !Array.isArray(value[id]))) throw new Error("Unreadable draft");
        }
      }
      const existing = getDraft(storage, id);
      const attachments = getDraftAttachments(storage, id);
      const rawAttachments = JSON.parse(storage.getItem("murage-draft-attachments") ?? "{}")[id];
      const text = starterFirstTaskDraft(imported.profileId, existing, Math.max(attachments.length, rawAttachments?.length ?? 0));
      if (text !== null) {
        restoreComposerDraft(id, { text, attachments: [] });
        if (getDraft(storage, id) !== text) throw new Error("Draft did not persist");
      }
      dispatch({ type: "select", id: bot.id });
      dispatch({ type: "toggleAppSettings", open: false });
    } catch {
      setError("The first-task draft could not be saved safely. Your bots are imported. Open the bot from the sidebar and add your notes in the normal composer.");
    }
  };
  return <section aria-labelledby="starter-profiles-title" className="rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="starter-profiles-title" className="text-[15px] font-medium text-ink">Starter profiles</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">Choose a starting team, review it, then import a separate copy. Your current Chief stays unchanged; new bots receive no Chief role or permissions.</p>
    {busy === "loading" && <p role="status" className="mt-3 text-[12px] text-ink-secondary">Loading starter profiles…</p>}
    {profiles && <div aria-label="Available starter profiles" className="mt-3 grid gap-2">
      {profiles.map(profile => <button key={profile.id} type="button" aria-pressed={selected?.id === profile.id} disabled={Boolean(busy)}
        onClick={() => choose(profile)} className={"rounded-lg border p-3 text-left disabled:opacity-50 " + (selected?.id === profile.id ? "border-accent bg-accent/5 " : "border-hairline/50 bg-inset ") + focus}>
        <span className="block text-[13px] font-semibold text-ink">{profile.name}</span>
        <span className="mt-1 block text-[12px] leading-relaxed text-ink-secondary">{profile.summary}</span>
        <span className="mt-2 block text-[11px] text-ink-secondary">{profile.members} bots · {profile.connectionsRequired ? "Review connection requirements" : "No connected accounts required to begin"}</span>
      </button>)}
    </div>}
    {selected && !imported && <div className="mt-3 rounded-lg bg-inset p-3 text-[12px]">
      <h4 className="font-semibold text-ink">{selected.name}</h4>
      <ul className="mt-1 list-inside list-disc space-y-1 text-ink-secondary">{selected.outcomes.map((outcome, index) => <li key={index}>{outcome}</li>)}</ul>
      <p className="mt-2 text-ink-secondary">Includes: {selected.agents.map(agent => agent.name).join(", ")}.</p>
      <fieldset className="mt-3"><legend className="font-semibold text-ink">Optional routines</legend>
        <p className="mt-1 text-ink-secondary">None are selected automatically. Imported routines stay paused until you enable them.</p>
        {selected.routines.map(routine => <label key={routine.key} className="mt-1 flex min-h-11 items-center gap-2 text-ink">
          <input type="checkbox" disabled={Boolean(busy)} checked={routineKeys.includes(routine.key)} className={focus}
            onChange={event => { setRoutineKeys(current => event.target.checked ? [...current, routine.key] : current.filter(key => key !== routine.key)); setPreview(null); setAcknowledged(false); setError(""); }} />
          {routine.name}
        </label>)}
        {!selected.routines.length && <p className="mt-1 text-ink-secondary">No suggested routines in this profile.</p>}
      </fieldset>
      {preview && <div aria-label="Starter import review" className="mt-3 border-t border-hairline/50 pt-3">
        {preview.scan.blocked ? <p role="alert" className="text-danger">This profile failed content checks and cannot be imported.</p> : <>
          {preview.summary && <p className="text-ink">{preview.summary.agents} new bots and {preview.summary.routines} paused routines selected.</p>}
          {preview.missingDependencies.length > 0 && <p role="alert" className="mt-1 text-danger">This selection has missing dependencies. Choose another profile or retry the review.</p>}
          <p className="mt-1 text-ink-secondary">This is a separate copy. Existing bots, drafts and permissions are not replaced.</p>
          {preview.scan.findings.length > 0 && <ul className="mt-2 text-ink-secondary">{preview.scan.findings.map((finding, index) => <li key={index} className="break-words">{finding.path}: {finding.rule}</li>)}</ul>}
          {preview.scan.reviewRequired && <label className="mt-2 flex items-start gap-2 text-ink"><input type="checkbox" checked={acknowledged} disabled={Boolean(busy)} className={focus} onChange={event => setAcknowledged(event.target.checked)} />I reviewed the warnings and want to import this profile.</label>}
        </>}
      </div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={Boolean(busy)} onClick={() => void inspect()} className={"min-h-11 rounded-lg bg-control px-3 font-medium text-ink disabled:opacity-50 " + focus}>{busy === "preview" ? "Reviewing…" : "Review profile"}</button>
        {preview && <button type="button" disabled={Boolean(busy) || preview.scan.blocked || !preview.summary || preview.missingDependencies.length > 0 || (preview.scan.reviewRequired && !acknowledged)}
          onClick={() => void install()} className={"min-h-11 rounded-lg bg-accent px-3 font-medium text-accent-ink disabled:opacity-50 " + focus}>{busy === "import" ? "Importing…" : "Import starter profile"}</button>}
      </div>
    </div>}
    {imported && <div role="status" className="mt-3 rounded-lg bg-inset p-3 text-[12px]">
      <p className="font-semibold text-ink">{imported.bots.length} bots imported. No task has been sent.</p>
      <p className="mt-1 leading-relaxed text-ink-secondary">Open the first task, add your own notes in the normal composer, review the draft, then press Send. Existing drafts and attachments are kept. Engine setup may still be needed.</p>
      <button type="button" onClick={openFirstTask} disabled={!imported.bots.length} className={"mt-3 min-h-11 rounded-lg bg-control px-3 font-medium text-ink disabled:opacity-50 " + focus}>Open first task</button>
    </div>}
    {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    {!profiles && !busy && <button type="button" onClick={() => void load()} className={"mt-3 min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink " + focus}>Retry loading profiles</button>}
  </section>;
}
