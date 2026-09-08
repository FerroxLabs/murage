import { useState } from "react";
import { api, useStore } from "@/state/store";
import { memoryButtonClass } from "./MemoryReview";

type Selection = { kind: "bot"; botId: string; topic?: string } | { kind: "section"; section: string };
type Inventory = { selections: Selection[]; issues: Array<{ label: string; error: string }>; links: Array<{ id: string; selection: Selection; status: string }> };
const request = async (body: object) => api("/api/memory/action", { method: "POST", body: JSON.stringify(body) });

export function MemoryNotebookPicker({ botId, onPreview }: { botId?: string; onPreview: (preview: any) => void }) {
  const { state } = useStore();
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visible = (selection: Selection) => !botId || selection.kind === "bot" && selection.botId === botId;
  const label = (selection: Selection) => selection.kind === "bot"
    ? `${state.bots.find(bot => bot.id === selection.botId)?.name ?? selection.botId} · ${selection.topic ?? "MEMORY.md"}`
    : `Team brief · ${selection.section || "General"}`;
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Notebook request failed."); }
    finally { setBusy(false); }
  };
  const refresh = async () => { setInventory(await request({ action: "import-inventory" })); setSelected([]); };
  return <section aria-label="Notebook selection" className="space-y-3">
    <button type="button" className={memoryButtonClass} disabled={busy} onClick={() => void run(refresh)}>Find existing notebooks</button>
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    {inventory && <>
      <p className="text-[13px] text-ink-secondary">Choose up to 20 files per import. You will review their contents before importing; original files stay in place.</p>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {inventory.selections.filter(visible).map(selection => {
          const key = JSON.stringify(selection);
          return <label key={key} className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" checked={selected.includes(key)} disabled={busy || selected.length >= 20 && !selected.includes(key)}
              onChange={event => setSelected(previous => event.target.checked ? [...previous, key] : previous.filter(item => item !== key))} />
            <span className="min-w-0 break-words">{label(selection)}</span>
          </label>;
        })}
      </div>
      {inventory.issues.map((issue, index) => <p key={index} className="text-[13px] text-danger">{issue.label}: {issue.error}</p>)}
      <button type="button" className={memoryButtonClass} disabled={busy || !selected.length}
        onClick={() => void run(async () => onPreview(await request({ action: "import-preview", selections: selected.map(item => JSON.parse(item)) })))}>Preview selected notebooks</button>
      {inventory.links.filter(link => visible(link.selection)).map(link => <div key={link.id} role="group" aria-label={`Tracked notebook: ${label(link.selection)}`} className="rounded-lg border border-hairline/40 p-3 text-[13px]">
        <p className="break-words">{label(link.selection)}</p>
        <p>{link.status === "current" ? "Tracking file changes" : "Needs review: check the file and any pinned, edited, archived or forgotten memories before importing again."}</p>
        <button type="button" className={memoryButtonClass} disabled={busy} onClick={() => void run(async () => { await request({ action: "import-stop-tracking", id: link.id }); await refresh(); })}>Stop tracking</button>
      </div>)}
    </>}
  </section>;
}
