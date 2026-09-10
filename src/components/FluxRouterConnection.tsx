import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Route } from "lucide-react";

export const FLUX_SIGNUP_URL = "https://fluxrouter.ai/auth/sign-up";
export interface FluxRouterConnectionProps {
  configured: boolean | null;
  conflict?: boolean;
  choices?: Array<{ id: string; label: string; enabled: boolean }>;
  onSelect?: (id: string) => Promise<void>;
  onSave: (key: string) => Promise<void>;
  onTest: () => Promise<{ modelCount: number; error?: string }>;
  onDisconnect: () => Promise<void>;
  children?: ReactNode;
}

const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const button = `min-h-11 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50 ${focus}`;

export function FluxRouterConnection({ configured, conflict = false, choices = [], onSelect, onSave, onTest, onDisconnect, children }: FluxRouterConnectionProps) {
  const selectionRequired = conflict || configured === false && choices.length > 0;
  const showSavedChoices = selectionRequired || choices.length > 1;
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "disconnect" | "select" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { const element = input.current; return () => { if (element) element.value = ""; }; }, [editing, configured]);
  const act = async (kind: "save" | "test" | "disconnect") => {
    if (running.current || configured === null) return;
    const key = kind === "save" ? input.current?.value.trim() ?? "" : "";
    if (kind === "save" && !key) { setInvalid(true); setError("Paste your Flux Router key to connect."); input.current?.focus(); return; }
    running.current = true; setBusy(kind); setError(""); setNotice(""); setInvalid(false);
    try {
      if (kind === "save") {
        await onSave(key);
        if (input.current) input.current.value = "";
        setEditing(false); setNotice("Key saved. Test the connection to check its model catalog.");
      } else if (kind === "test") {
        const result = await onTest();
        if (result.error) setError("The model catalog could not be checked. Check your key or try again later.");
        else setNotice(`Catalog check passed: ${result.modelCount.toLocaleString()} chat models listed. No model request was sent.`);
      } else {
        await onDisconnect(); setDisconnecting(false); setEditing(false); setNotice("Flux Router disconnected.");
      }
    } catch {
      setError(kind === "test" ? "Could not check the model catalog. Try again when Flux Router is available." : "The connection could not be changed. Refresh connections and try again.");
    } finally { running.current = false; setBusy(null); }
  };
  const cancelEdit = () => { if (input.current) input.current.value = ""; setEditing(false); setError(""); setInvalid(false); };
  const selectExisting = async (id: string) => {
    if (running.current || !onSelect) return;
    running.current = true; setBusy("select"); setError(""); setNotice("");
    try { await onSelect(id); setNotice("Flux Router connection selected. Test its model catalog when you are ready."); }
    catch { setError("The connection could not be selected. Refresh connections and try again."); }
    finally { running.current = false; setBusy(null); }
  };
  return <section id="flux-router-connection" aria-labelledby="flux-router-heading" className="min-w-0 rounded-xl border border-accent/40 bg-panel p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2"><Route size={20} className="shrink-0 text-accent" aria-hidden="true" /><h3 id="flux-router-heading" className="text-[16px] font-semibold text-ink">Flux Router</h3></div>
      <span className="text-[12px] text-ink-secondary">{configured === null ? "Loading connection…" : selectionRequired ? "Choose a saved connection" : configured ? "Connected · key saved" : "Not connected"}</span>
    </div>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">One key for Flux Router models. Choose a Flux model when you want to use it; model requests use your Flux Router balance.</p>
    {showSavedChoices && <div className="mt-4 space-y-3 text-[13px] text-ink"><p>{conflict ? "Different Flux Router keys are saved. Choose the connection to use for Flux models. Saved keys are never displayed." : "Choose a saved connection to use for Flux models. You do not need to enter its key again."}</p><div className="flex flex-wrap gap-2">{choices.map(choice => <button key={choice.id} type="button" className={`${button} break-words text-left`} disabled={Boolean(busy) || !onSelect} onClick={() => void selectExisting(choice.id)}>Use {choice.label}{choice.enabled ? "" : " (currently disabled)"}</button>)}</div></div>}
    {!selectionRequired && (!configured || editing) && <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void act("save"); }}>
      <label className="block text-[13px] text-ink">{configured ? "New Flux Router key" : "Flux Router key"}<input ref={input} name="flux-router-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096} disabled={Boolean(busy) || configured === null} aria-invalid={invalid || undefined} aria-describedby={invalid ? "flux-router-error" : undefined} onInput={() => { if (invalid) setInvalid(false); }} placeholder="Paste your Flux Router key…" className={`mt-1.5 min-h-11 w-full min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink ${focus}`} /></label>
      <div className="flex flex-wrap gap-2"><button type="submit" disabled={Boolean(busy) || configured === null} className={`${button} font-medium`}>{busy === "save" ? "Saving…" : configured ? "Replace key" : "Connect"}</button>{editing && <button type="button" disabled={Boolean(busy)} className={button} onClick={cancelEdit}>Cancel</button>}</div>
    </form>}
    {configured && !selectionRequired && !editing && <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" className={button} disabled={Boolean(busy) || disconnecting} onClick={() => { setEditing(true); setNotice(""); setError(""); }}>Replace key</button>
      <button type="button" className={button} disabled={Boolean(busy) || disconnecting} onClick={() => void act("test")}>{busy === "test" ? "Testing catalog…" : "Test connection"}</button>
      <button type="button" className={button} disabled={Boolean(busy) || disconnecting} onClick={() => { setDisconnecting(true); setNotice(""); setError(""); }}>Disconnect</button>
    </div>}
    {disconnecting && <div className="mt-3 rounded-lg bg-card p-3 text-[13px] text-ink"><p>Disconnect Flux Router? Bots using Flux models will need another model connection.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={Boolean(busy)} onClick={() => void act("disconnect")}>{busy === "disconnect" ? "Disconnecting…" : "Disconnect Flux Router"}</button><button type="button" className={button} disabled={Boolean(busy)} onClick={() => setDisconnecting(false)}>Keep connected</button></div></div>}
    <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary">Test connection checks the model catalog only. It does not send a model request or verify that a model can answer.</p>
    <a href={FLUX_SIGNUP_URL} target="_blank" rel="noopener noreferrer" className={`mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg text-[13px] font-medium text-accent hover:underline ${focus}`}>Sign up for Flux Router<ExternalLink size={13} aria-hidden="true" /></a>
    {notice && <p role="status" className="mt-2 text-[12px] leading-relaxed text-success">{notice}</p>}
    {error && <p id="flux-router-error" role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">{error}</p>}
    {children}
  </section>;
}
