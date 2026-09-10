import { useEffect, useRef, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";

type FileChoice = { relativePath: string; name: string; directory: boolean };
/** A bounded file choice inside an existing working folder. This only proposes
 * a routine; the existing conversation card owns final confirmation. */
export function RoutineWatchPicker({ bots, onClose }: { bots: Bot[]; onClose: () => void }) {
  const { dispatch } = useStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitGate = useRef(false);
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [directory, setDirectory] = useState("");
  const [choices, setChoices] = useState<FileChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [everyMinutes, setEveryMinutes] = useState(15);
  const [days, setDays] = useState(7);
  const [maxChecks, setMaxChecks] = useState(100);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setChoices([]); setSelected(""); setError(""); setLoading(true);
    if (!botId) { setLoading(false); return; }
    api(`/api/bots/${encodeURIComponent(botId)}/watch-files?directory=${encodeURIComponent(directory)}`)
      .then(value => { if (active) { setChoices(value.entries); setTruncated(value.truncated); } })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "This working folder is unavailable."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [botId, directory]);
  const propose = async () => {
    if (submitGate.current || !selected) return;
    submitGate.current = true; setWorking(true); setError("");
    try {
      const result = await api(`/api/bots/${encodeURIComponent(botId)}/watch-proposal`, { method: "POST", body: JSON.stringify({
        relativePath: selected, everyMinutes, expiresAt: new Date(Date.now() + days * 86400000).toISOString(), maxChecks,
      }) });
      dispatch({ type: "select", id: result.botId, threadId: result.threadId });
      dispatch({ type: "focusMessage", threadId: result.threadId, messageId: result.messageId });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not prepare this watch."); }
    finally { submitGate.current = false; setWorking(false); }
  };
  const field = "min-h-11 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  return <dialog ref={dialog} aria-labelledby="watch-picker-title" onCancel={onClose} onClose={onClose}
    className="m-auto max-h-[90dvh] w-[min(540px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-hairline bg-panel p-5 text-ink shadow-2xl backdrop:bg-black/60">
    <h2 id="watch-picker-title" className="text-[18px] font-semibold">Watch a file</h2>
    <p className="mt-2 text-[13px] text-ink-secondary">Choose a file in a bot’s working folder. Review and confirm the watch in chat before checks begin.</p>
    <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void propose(); }}>
      <label className="block text-[13px]">Working folder for
        <select autoFocus className={`${field} mt-1`} value={botId} disabled={working} onChange={event => { setBotId(event.target.value); setDirectory(""); }}>
          {bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
        </select>
      </label>
      <fieldset className="rounded-lg border border-hairline/50 p-3" disabled={working}>
        <legend className="px-1 text-[13px]">Choose an existing file</legend>
        <div className="mb-2 break-all text-[12px] text-ink-secondary">{directory || "Working folder"}</div>
        {directory && <button type="button" className="mb-2 min-h-11 rounded-lg border border-hairline/50 px-3 text-[13px]" onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>Up one folder</button>}
        <div className="max-h-52 space-y-1 overflow-y-auto">
          {choices.map(choice => choice.directory ? <button key={choice.relativePath} type="button" className="block min-h-11 w-full break-all rounded-lg px-2 py-2 text-left text-[13px] hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setDirectory(choice.relativePath)}>{choice.name}/</button>
            : <label key={choice.relativePath} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-[13px] hover:bg-raised"><input type="radio" name="watch-file" value={choice.relativePath} checked={selected === choice.relativePath} onChange={() => setSelected(choice.relativePath)} /><span className="min-w-0 break-all">{choice.name}</span></label>)}
          {loading && <p role="status" className="text-[13px] text-ink-secondary">Loading files…</p>}
          {!loading && !choices.length && !error && <p className="text-[13px] text-ink-secondary">No supported files here. Choose a regular file up to 1 MB; private setup files are excluded.</p>}
        </div>
        {truncated && <p className="mt-2 text-[12px] text-ink-secondary">This folder has more entries than can be shown. Choose a smaller subfolder.</p>}
      </fieldset>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="text-[13px]">Every (minutes)<input className={`${field} mt-1`} type="number" min={5} max={1440} value={everyMinutes} onChange={event => setEveryMinutes(Number(event.target.value))} required /></label>
        <label className="text-[13px]">Expires after (days)<input className={`${field} mt-1`} type="number" min={1} max={365} value={days} onChange={event => setDays(Number(event.target.value))} required /></label>
        <label className="text-[13px]">Maximum checks<input className={`${field} mt-1`} type="number" min={1} max={10000} value={maxChecks} onChange={event => setMaxChecks(Number(event.target.value))} required /></label>
      </div>
      <p className="text-[12px] text-ink-secondary">Read-only. No agent runs or provider charges. Only changes appear in Inbox; quiet hours follow notification settings.</p>
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-11 rounded-lg border border-hairline/50 px-4 text-[13px]">Cancel</button><button type="submit" disabled={!selected || loading || working} className="min-h-11 rounded-lg bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-50">{working ? "Preparing…" : "Review in chat"}</button></div>
    </form>
  </dialog>;
}
