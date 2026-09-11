// Settings → Models → Local models (0.1.52 LM2, spec V1–V3 and A1–A3).
//
// The section is ALWAYS rendered. Before this, the local-model feature was
// invisible whenever nothing happened to answer on a fixed loopback port, so
// the only way to learn it existed was to already have a server running on the
// exact port Murage guessed. Now the empty state says which addresses were
// checked and offers the one action that fixes it.
//
// Every state here has exactly one primary action and a plain-language outcome;
// the seven probe checks live behind a disclosure. See src/lib/local-models-view.ts
// for the copy and the state → action mapping, which is where the tests hold it.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Plus, RefreshCw } from "lucide-react";

import { api } from "@/state/store";
import {
  LOCAL_SERVER_KIND_LABELS,
  LOCAL_SERVER_KINDS,
  LOCAL_MODELS_ROUTES,
  type LocalModelsListResponse,
  type LocalModelView,
  type LocalServerKind,
  type LocalServerView,
  type LocalToolTestResponse,
  type OllamaContextCopyResult,
  type RemoveLocalServerResponse,
} from "../../shared/local-models";
import {
  checkLine,
  contextLine,
  LOCAL_MODELS_FOOTER,
  enginesLine,
  LOCAL_MODELS_INTRO,
  LOCAL_MODELS_TITLE,
  lookedLine,
  nextActionFor,
  OPEN_LOCAL_MODELS_EVENT,
  OPEN_MODEL_PICKER_EVENT,
  serverStatusLine,
  surfacesLine,
  testOutcomeLine,
  type LocalModelAction,
} from "@/lib/local-models-view";

const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const button = `min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink disabled:opacity-50 ${focus}`;
const primary = `min-h-11 rounded-lg bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-50 ${focus}`;
const input = `min-h-11 min-w-0 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink ${focus}`;

/** The server-side error body, or a sentence a person can act on. */
function failureMessage(cause: unknown, action: string): string {
  const body = (cause as { body?: { error?: unknown } } | undefined)?.body;
  if (body && typeof body.error === "string" && body.error) return body.error;
  const message = cause instanceof Error ? cause.message : "";
  if (/\b40[34]\b/.test(message)) return `${LOCAL_MODELS_TITLE} settings are only available in the desktop app.`;
  return `Could not ${action}. Check the server and try again.`;
}

function AddServerForm({ onAdded, onCancel }: { onAdded: (server: LocalServerView) => void; onCancel: () => void }) {
  const address = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LocalServerKind | "auto">("auto");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { address.current?.focus(); }, []);
  const submit = async () => {
    if (busy) return;
    const typed = address.current?.value.trim() ?? "";
    if (!typed) { setError("Enter the address the server answers on."); return; }
    setBusy(true); setError("");
    try {
      const result: { server: LocalServerView } = await api(LOCAL_MODELS_ROUTES.servers, {
        method: "POST",
        body: JSON.stringify({ address: typed, kind, ...(name.trim() ? { name: name.trim() } : {}), ...(apiKey ? { apiKey } : {}) }),
      });
      setApiKey("");
      onAdded(result.server);
    } catch (cause) {
      setError(failureMessage(cause, "add this server"));
    } finally { setBusy(false); }
  };
  return <form className="mt-3 space-y-3 rounded-lg border border-hairline/40 bg-inset/40 p-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label className="block text-[13px]">Address
      <input ref={address} aria-label="Server address" defaultValue="" maxLength={2048} autoComplete="off" spellCheck={false} disabled={busy}
        placeholder="192.168.1.20:8080" className={`${input} mt-1.5`} />
    </label>
    <p className="text-[11px] leading-relaxed text-ink-secondary">This computer, your home network or your tailnet can use a plain address. Anything else has to be https.</p>
    <label className="block text-[13px]">Name <span className="text-ink-secondary">(optional)</span>
      <input aria-label="Server name (optional)" value={name} onChange={event => setName(event.target.value)} maxLength={60} disabled={busy}
        placeholder="For example: seanbeast" className={`${input} mt-1.5`} />
    </label>
    <label className="block text-[13px]">Server type
      <select aria-label="Server type" value={kind} onChange={event => setKind(event.target.value as LocalServerKind | "auto")} disabled={busy} className={`${input} mt-1.5`}>
        <option value="auto">Detect automatically</option>
        {LOCAL_SERVER_KINDS.map(entry => <option key={entry} value={entry}>{LOCAL_SERVER_KIND_LABELS[entry]}</option>)}
      </select>
    </label>
    <label className="block text-[13px]">API key <span className="text-ink-secondary">(only if your server needs one)</span>
      <input type="password" aria-label="Server API key (optional)" value={apiKey} onChange={event => setApiKey(event.target.value)} maxLength={512} autoComplete="off" spellCheck={false} disabled={busy}
        placeholder="Leave empty for a server with no key" className={`${input} mt-1.5`} />
    </label>
    <p className="text-[11px] leading-relaxed text-ink-secondary">The key is stored on this computer and is only ever sent to this address.</p>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={busy} className={primary}>{busy ? "Adding…" : "Add server"}</button>
      <button type="button" disabled={busy} onClick={onCancel} className={button}>Cancel</button>
    </div>
  </form>;
}

function EditServerForm({ server, onSaved, onCancel }: { server: LocalServerView; onSaved: (server: LocalServerView) => void; onCancel: () => void }) {
  const [name, setName] = useState(server.name);
  const [address, setAddress] = useState(server.address);
  const [kind, setKind] = useState<LocalServerKind>(server.kind);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result: { server: LocalServerView } = await api(LOCAL_MODELS_ROUTES.server(server.id), {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), address: address.trim(), kind, ...(clearKey ? { apiKey: null } : apiKey ? { apiKey } : {}) }),
      });
      setApiKey("");
      onSaved(result.server);
    } catch (cause) {
      setError(failureMessage(cause, "save this server"));
    } finally { setBusy(false); }
  };
  return <form className="mt-3 space-y-3 rounded-lg border border-hairline/40 bg-inset/40 p-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label className="block text-[13px]">Name<input aria-label={`Name for ${server.label}`} value={name} onChange={event => setName(event.target.value)} maxLength={60} disabled={busy} className={`${input} mt-1.5`} /></label>
    <label className="block text-[13px]">Address<input aria-label={`Address for ${server.label}`} value={address} onChange={event => setAddress(event.target.value)} maxLength={2048} autoComplete="off" spellCheck={false} disabled={busy} className={`${input} mt-1.5`} /></label>
    <label className="block text-[13px]">Server type
      <select aria-label={`Server type for ${server.label}`} value={kind} onChange={event => setKind(event.target.value as LocalServerKind)} disabled={busy} className={`${input} mt-1.5`}>
        {LOCAL_SERVER_KINDS.map(entry => <option key={entry} value={entry}>{LOCAL_SERVER_KIND_LABELS[entry]}</option>)}
      </select>
    </label>
    <label className="block text-[13px]">{server.hasKey ? "Replace the API key" : "API key"} <span className="text-ink-secondary">(optional)</span>
      <input type="password" aria-label={`API key for ${server.label}`} value={apiKey} onChange={event => { setApiKey(event.target.value); setClearKey(false); }} maxLength={512} autoComplete="off" spellCheck={false} disabled={busy || clearKey}
        placeholder={server.hasKey ? "A key is saved · paste a replacement" : "Leave empty for a server with no key"} className={`${input} mt-1.5`} />
    </label>
    {server.hasKey && <label className="flex min-h-11 items-center gap-2 text-[12px]"><input type="checkbox" aria-label={`Remove the saved key for ${server.label}`} checked={clearKey} disabled={busy} onChange={event => setClearKey(event.target.checked)} className={`size-4 accent-accent ${focus}`} />Remove the saved key</label>}
    <p className="text-[11px] leading-relaxed text-ink-secondary">Changing the address or the key removes the engine entries Murage wrote for this server. The next turn writes fresh ones.</p>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={busy} className={primary}>{busy ? "Saving…" : "Save changes"}</button>
      <button type="button" disabled={busy} onClick={onCancel} className={button}>Cancel</button>
    </div>
  </form>;
}

function ModelCard({ server, model, onTested, onRefresh }: {
  server: LocalServerView;
  model: LocalModelView;
  onTested: (serverId: string, model: string, result: LocalToolTestResponse) => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const action: LocalModelAction = nextActionFor(server, model);
  const test = model.test;
  const run = async () => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (action.kind === "test") {
        const result: LocalToolTestResponse = await api(LOCAL_MODELS_ROUTES.test(server.id), { method: "POST", body: JSON.stringify({ model: model.model }) });
        onTested(server.id, model.model, result);
        return;
      }
      // "Check again" always asks the address / model list again (its help text
      // says so) — never the seven-check tool test, whatever the last test was.
      if (action.kind === "retest") { onRefresh(); return; }
      if (action.kind === "use") {
        window.dispatchEvent(new CustomEvent(OPEN_MODEL_PICKER_EVENT, { detail: { model: model.id } }));
        setNotice(`The model menu of every open bot now shows ${model.model}. Close Settings and choose it in the bot you want.`);
        return;
      }
      if (action.kind === "copy-flag" && action.value) {
        await navigator.clipboard.writeText(action.value);
        setNotice(`Copied: ${action.value}`);
        return;
      }
      if (action.kind === "ollama-context-copy") {
        const result: OllamaContextCopyResult = await api(LOCAL_MODELS_ROUTES.ollamaContextCopy(server.id), { method: "POST", body: JSON.stringify({ model: model.model }) });
        setNotice(result.status === "created"
          ? `Created ${result.model} with a ${Math.round(result.numCtx / 1024)}K context. Test it to confirm.`
          : `This Ollama version could not make the copy. Run: ${result.command}`);
        onRefresh();
        return;
      }
      if (action.kind === "pick-other-model") {
        setNotice("Pick another model on this server above and test it.");
      }
    } catch (cause) {
      setError(failureMessage(cause, "run this action"));
    } finally { setBusy(false); }
  };
  return <div className="border-t border-hairline/30 py-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="min-w-0 break-all text-[13px] text-ink">{model.model}</p>
      {model.loaded && <span className="text-[11px] text-ink-secondary">In memory now</span>}
    </div>
    <p className="mt-1 text-[11px] text-ink-secondary">{contextLine(model)}</p>
    {enginesLine(model) && <p className="mt-1 text-[11px] text-ink-secondary">{enginesLine(model)}</p>}
    {test && <p className={`mt-1 flex items-start gap-1 text-[12px] ${test.outcome === "tools-work" ? "text-success" : test.outcome === "tools-partial" ? "text-warning" : "text-danger"}`}>
      {test.outcome === "tools-work" ? <CheckCircle2 size={13} className="mt-[2px] shrink-0" /> : <AlertTriangle size={13} className="mt-[2px] shrink-0" />}
      <span>{testOutcomeLine(test)}</span>
    </p>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} onClick={() => void run()} className={primary}>{busy ? "Working…" : action.label}</button>
      {test && <button type="button" disabled={busy} onClick={() => { setBusy(true); setError(""); setNotice(""); api(LOCAL_MODELS_ROUTES.test(server.id), { method: "POST", body: JSON.stringify({ model: model.model }) }).then((result: LocalToolTestResponse) => onTested(server.id, model.model, result)).catch((cause: unknown) => setError(failureMessage(cause, "test this model"))).finally(() => setBusy(false)); }} className={button}>Test again</button>}
    </div>
    <p className="mt-1 text-[11px] leading-relaxed text-ink-secondary">{action.help}</p>
    {notice && <p role="status" className="mt-1 text-[12px] text-success">{notice}</p>}
    {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
    {test && <details className="mt-2"><summary className={`min-h-11 cursor-pointer py-3 text-[12px] text-ink-secondary ${focus}`}>What the test checked</summary>
      <div className="space-y-1 pb-2">
        <p className="text-[11px] text-ink-secondary">{surfacesLine(test)}</p>
        {test.checks.map(check => <p key={check.name} className="break-words text-[11px] text-ink-secondary">{checkLine(check)}</p>)}
        <p className="text-[11px] text-ink-secondary">Tested {new Date(test.testedAt).toLocaleString()} · {Math.round(test.durationMs / 100) / 10}s</p>
      </div>
    </details>}
  </div>;
}

function ServerCard({ server, now, onChanged, onTested }: {
  server: LocalServerView;
  now: number;
  onChanged: () => void;
  onTested: (serverId: string, model: string, result: LocalToolTestResponse) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cleanup, setCleanup] = useState<string>("");
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result: RemoveLocalServerResponse = await api(LOCAL_MODELS_ROUTES.server(server.id), { method: "DELETE" });
      const refused = result.cleanup.filter(entry => entry.status === "refused");
      setCleanup(refused.length ? `Removed. ${refused.length} engine configuration${refused.length === 1 ? "" : "s"} could not be cleaned up and were left untouched.` : "");
      setRemoving(false);
      onChanged();
    } catch (cause) {
      setError(failureMessage(cause, "remove this server"));
    } finally { setBusy(false); }
  };
  return <section aria-label={`${server.label} local model server`} className="min-w-0 rounded-xl border border-hairline/40 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h4 className="break-words text-[14px] font-medium text-ink">{server.label}</h4>
        <p className="break-all text-[11px] text-ink-secondary">{server.address}</p>
      </div>
      <span className={`shrink-0 text-[12px] ${server.status === "running" ? "text-success" : "text-warning"}`}>{server.status === "running" ? "Running" : "Not answering"}</span>
    </div>
    <p className="mt-1 text-[12px] text-ink-secondary">{serverStatusLine(server, now)}{server.source === "added" ? " · added by you" : " · found automatically"}{server.hasKey ? " · key saved" : ""}</p>
    {server.status !== "running" && <p className="mt-2 text-[12px] text-ink-secondary">Nothing answered at this address. Start the server, then check again.</p>}
    {server.status === "running" && server.models.length === 0 && <p className="mt-2 text-[12px] text-ink-secondary">This server answered but listed no model Murage can address. Load a model on it, then check again.</p>}
    {server.models.map(model => <ModelCard key={model.id} server={server} model={model} onTested={onTested} onRefresh={onChanged} />)}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={onChanged} className={button}>Check again</button>
      {server.editable && <>
        <button type="button" disabled={busy} onClick={() => { setEditing(value => !value); setRemoving(false); }} aria-expanded={editing} className={button}>Edit {server.name}</button>
        <button type="button" disabled={busy} onClick={() => { setRemoving(true); setEditing(false); }} className={button}>Remove {server.name}</button>
      </>}
    </div>
    {!server.editable && <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">Murage found this one on its own, so there is nothing to edit or remove. Stop the server to make it disappear.</p>}
    {editing && <EditServerForm server={server} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />}
    {removing && <div className="mt-3 rounded-lg bg-card p-3 text-[12px]">
      <p>Remove {server.name}? The engine entries Murage wrote for it are removed too. Bots pointed at its models will need another model.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void remove()} className={primary}>Remove this server</button>
        <button type="button" disabled={busy} onClick={() => setRemoving(false)} className={button}>Cancel</button>
      </div>
    </div>}
    {cleanup && <p role="status" className="mt-2 text-[12px] text-warning">{cleanup}</p>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </section>;
}

export function LocalModelsSettings() {
  const [snapshot, setSnapshot] = useState<LocalModelsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    if (running.current) return;
    running.current = true; setLoading(true); setError("");
    try {
      const result: LocalModelsListResponse = await api(LOCAL_MODELS_ROUTES.list);
      if (mounted.current) { setSnapshot(result); setNow(Date.now()); }
    } catch (cause) {
      if (mounted.current) setError(failureMessage(cause, `load ${LOCAL_MODELS_TITLE.toLowerCase()}`));
    } finally {
      running.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    // Brought here from the picker's "No local server detected" row or from an
    // Engines row: land on the section and on the action, not near it.
    const open = () => {
      root.current?.scrollIntoView({ block: "start" });
      addButton.current?.focus();
    };
    window.addEventListener(OPEN_LOCAL_MODELS_EVENT, open);
    return () => { mounted.current = false; window.removeEventListener(OPEN_LOCAL_MODELS_EVENT, open); };
  }, [reload]);

  const onTested = (serverId: string, model: string, result: LocalToolTestResponse) => {
    setSnapshot(current => current && {
      ...current,
      servers: current.servers.map(server => server.id !== serverId ? server : {
        ...server,
        models: server.models.map(row => row.model !== model ? row : { ...row, test: result.test, engines: result.engines }),
      }),
    });
  };

  const servers = snapshot?.servers ?? [];
  return <section ref={root} id="local-models" aria-labelledby="local-models-heading" className="min-w-0 rounded-xl border border-hairline/40 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="local-models-heading" className="text-[15px] font-medium text-ink">{LOCAL_MODELS_TITLE}</h3>
      <button type="button" disabled={loading} onClick={() => void reload()} aria-label={`Check for ${LOCAL_MODELS_TITLE.toLowerCase()} again`} className={button}>
        <RefreshCw size={13} className={loading ? "animate-spin" : ""} aria-hidden />
      </button>
    </div>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{LOCAL_MODELS_INTRO}</p>
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    {loading && !snapshot && <p role="status" className="mt-3 text-[13px] text-ink-secondary">Checking this computer for model servers…</p>}
    {snapshot && servers.length === 0 && <div className="mt-3 rounded-lg border border-hairline/40 bg-inset/40 p-3">
      <p className="text-[13px] text-ink">No model server is running on this computer.</p>
      <p className="mt-1 break-words text-[12px] leading-relaxed text-ink-secondary">{lookedLine(snapshot.looked)}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Start one of those, or add a server running somewhere else on your network.</p>
    </div>}
    <div className="mt-3 space-y-4">
      {servers.map(server => <ServerCard key={server.id} server={server} now={now} onChanged={() => void reload()} onTested={onTested} />)}
    </div>
    <div className="mt-3">
      <button ref={addButton} type="button" disabled={adding} onClick={() => setAdding(true)} aria-expanded={adding} className={`${primary} inline-flex items-center gap-1.5`}>
        <Plus size={13} aria-hidden />Add a server
      </button>
      {adding && <AddServerForm onAdded={() => { setAdding(false); void reload(); }} onCancel={() => setAdding(false)} />}
    </div>
    <p className="mt-3 text-[11px] leading-relaxed text-ink-secondary">{LOCAL_MODELS_FOOTER}</p>
  </section>;
}
