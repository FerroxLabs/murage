import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "@/lib/live-events";
import { t } from "@/lib/i18n";
import { activeSavedFilters, type SavedFilters, type SavedVersionResult } from "@/lib/files-view";
import type { Artifact, ArtifactKind, ArtifactPage, ArtifactPreview } from "../../shared/artifacts";
import type { WorkspaceScopeRef } from "../../shared/workspace-files";
import { ArtifactImageMedia } from "./ImageMedia";
import { WorkspaceFiles, type WorkspaceOpenInPane } from "./WorkspaceFiles";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const field = "min-h-10 min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
export interface FilesBot { id: string; name: string; threadId: string; tasks?: { threadId: string; title: string }[] }
type NativeAction = (artifact: Artifact, action: "open" | "reveal") => void | Promise<void>;
export interface FilesOpenDetail { botId?: string; threadId?: string; artifactId?: string }
export function openFiles(detail: FilesOpenDetail = {}) { window.dispatchEvent(new CustomEvent("murage:open-files", { detail })); }
export function artifactNativeAction() {
  const bridge = window.muragebox as (NonNullable<Window["muragebox"]> & { artifactAction?: (id: string, action: "open" | "reveal") => Promise<void> }) | undefined;
  return typeof bridge?.artifactAction === "function" ? (artifact: Artifact, action: "open" | "reveal") => bridge.artifactAction!(artifact.id, action) : undefined;
}
export async function downloadSavedArtifact(artifact: Artifact) {
  await ensureDesktopSurfaceSecret();
  const response = await fetch(`/api/artifacts/${artifact.id}/download`, { headers: { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? "The saved copy could not be downloaded."); }
  const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
  link.href = url; link.download = artifact.filename; document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** This prelude precedes untrusted HTML. The iframe also has an opaque origin
 * and no sandbox allowances; scripts and remote resources stay disabled. */
export function artifactPreviewHtml(content: string) {
  // Template contents remain inert while parsing. Strip navigation as well as
  // active elements; CSP alone does not reliably block a frame navigating itself.
  const template = document.createElement("template"); template.innerHTML = content;
  template.content.querySelectorAll("script,iframe,frame,object,embed,base,meta,link,template").forEach(node => node.remove());
  for (const node of template.content.querySelectorAll("*")) for (const attribute of [...node.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || ["href", "xlink:href", "srcset", "ping", "action", "formaction", "srcdoc", "target", "background", "poster"].includes(name)
      || (name === "src" && !(node.tagName === "IMG" && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(attribute.value)))) node.removeAttribute(attribute.name);
  }
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer">${template.innerHTML}`;
}

export function ArtifactCard({ artifact, busy, onPreview, onDownload, onSource, onNativeAction, onOpenHere }: {
  artifact: Artifact; busy?: boolean; onPreview: () => void; onDownload: () => void;
  onSource?: () => void; onNativeAction?: NativeAction;
  /** Open the WORKING file this saved version came from, beside the chat
   * (F4-T3). Offered only while the original is still current: the pane
   * shows the live file, not the saved bytes. */
  onOpenHere?: () => void;
}) {
  const available = artifact.savedState === "available";
  const native = (action: "open" | "reveal") => {
    if (action === "open" && artifact.kind === "html" && !window.confirm("Open this HTML file outside the protected preview? It may run scripts or access the network.")) return;
    void onNativeAction?.(artifact, action);
  };
  return <article data-artifact-id={artifact.id} className="rounded-xl border border-hairline/50 bg-inset p-4">
    <p className="text-[12px] text-ink-secondary">{artifact.botName} · {artifact.kind === "other" ? "File" : artifact.kind.toUpperCase()} · {new Date(artifact.createdAt).toLocaleString()}</p>
    <h3 className="mt-2 break-words text-[15px] font-medium">{artifact.name}</h3>
    <p className="mt-1 text-[12px] text-ink-secondary">{artifact.bytes.toLocaleString()} bytes · Saved copy</p>
    {artifact.sourceState !== "current" && <p className="mt-2 text-[12px] text-ink-secondary">{artifact.sourceState === "missing" ? "Original file is missing." : artifact.sourceState === "changed" ? "Original file has changed." : "Original location is unavailable."} The saved version is retained.</p>}
    {!available && <p role="status" className="mt-2 text-[12px] text-danger">Saved copy is unavailable. Register the original again if it is still available.</p>}
    {!artifact.sourceConversationAvailable && <p className="mt-2 text-[12px] text-ink-secondary">The source conversation is no longer available. The file remains saved.</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {artifact.kind !== "other" && <button className={button} disabled={busy || !available} onClick={onPreview}>Preview</button>}
      {onOpenHere && artifact.sourceState === "current" && <button className={button} data-pane-action="open-here" aria-label={t("workspacePane.openHereNamed", { name: artifact.relativePath })} onClick={onOpenHere}>{t("workspacePane.openHere")}</button>}
      <button className={button} disabled={busy || !available} onClick={onDownload}>Download</button>
      {onSource && artifact.sourceConversationAvailable && <button className={button} onClick={onSource}>Source conversation</button>}
      {onNativeAction && <><button className={button} disabled={busy || !available} onClick={() => native("open")}>Open in app</button><button className={button} disabled={busy || !available} onClick={() => native("reveal")}>Show in folder</button></>}
    </div>
    {artifact.kind === "other" && <p className="mt-2 text-[12px] text-ink-secondary">Preview is unavailable for this format. Download to review it.</p>}
  </article>;
}

export function Files({ bots, initialBotId = "", initialThreadId = "", initialArtifactId, onClose, onSource, onNativeAction, onRevealFolder, onOpenInPane, onShowPane }: {
  bots: FilesBot[]; initialBotId?: string; initialThreadId?: string; initialArtifactId?: string; onClose?: () => void;
  onSource?: (artifact: Artifact) => void; onNativeAction?: NativeAction;
  onRevealFolder?: (scope: WorkspaceScopeRef) => void;
  /** Open one workspace file beside the chat (F4-T3); absent in a plain browser. */
  onOpenInPane?: WorkspaceOpenInPane;
  /** Show the workspace pane for the browsed conversation without opening a file. */
  onShowPane?: (scope: WorkspaceScopeRef) => void;
}) {
  const [botId, setBotId] = useState(initialBotId), [threadId, setThreadId] = useState(initialThreadId);
  const [query, setQuery] = useState(""), [draft, setDraft] = useState(""), [kind, setKind] = useState<ArtifactKind | "">("");
  const [since, setSince] = useState(""), [until, setUntil] = useState("");
  // The bot/task pickers say which workspace is browsed AND, by default,
  // which conversation's saved versions are listed. "All saved files" widens
  // the saved list only; it never changes the workspace being browsed, so the
  // two halves of this surface can never disagree about where you are.
  const [savedEveryBot, setSavedEveryBot] = useState(false);
  const [page, setPage] = useState(0), [revision, setRevision] = useState(0);
  const [result, setResult] = useState<ArtifactPage | null>(null), [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [relativePath, setRelativePath] = useState(""), [name, setName] = useState("");
  const gate = useRef(false);
  const previewPanel = useRef<HTMLElement>(null);
  const bot = bots.find(bot => bot.id === botId), targetThread = threadId || bot?.threadId;
  // A scope is a bot plus one conversation. Without both there is no root to
  // resolve, so the workspace half says so rather than guessing a folder.
  const scope: WorkspaceScopeRef | null = bot && targetThread ? { botId: bot.id, threadId: targetThread } : null;
  const taskTitle = bot?.tasks?.find(task => task.threadId === threadId)?.title;
  const scopeLabel = bot ? (threadId ? `${bot.name} · ${taskTitle ?? t("filesWorkspace.currentTask")}` : bot.name) : "";
  const savedBotId = savedEveryBot ? "" : botId, savedThreadId = savedEveryBot ? "" : threadId;
  const savedFilters: SavedFilters = { botId: savedBotId, threadId: savedThreadId, kind, since, until, query };
  const filterLabels = activeSavedFilters(savedFilters, bots);
  useEffect(() => {
    if (!initialArtifactId) return;
    const controller = new AbortController();
    void api(`/api/artifacts/${encodeURIComponent(initialArtifactId)}/preview`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setPreview(value as ArtifactPreview);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "This saved file could not be opened."); });
    return () => controller.abort();
  }, [initialArtifactId]);
  useEffect(() => { if (preview) previewPanel.current?.scrollIntoView({ block: "start" }); }, [preview]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: "25", query });
    if (savedBotId) params.set("botId", savedBotId); if (savedThreadId) params.set("threadId", savedThreadId); if (kind) params.set("kind", kind);
    if (since) params.set("since", String(new Date(`${since}T00:00:00`).getTime()));
    if (until) params.set("until", String(new Date(`${until}T23:59:59.999`).getTime()));
    void api(`/api/artifacts?${params}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setResult(value as ArtifactPage); })
      .catch(reason => { if (!controller.signal.aborted) { setResult(null); setError(reason instanceof Error ? reason.message : "Files could not load."); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [savedBotId, savedThreadId, kind, since, until, query, page, revision]);
  const act = async (action: () => Promise<void>) => {
    if (gate.current) return; gate.current = true; setBusy(true); setError(null);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The file action failed."); }
    finally { gate.current = false; setBusy(false); }
  };
  const download = (artifact: Artifact) => act(() => downloadSavedArtifact(artifact));
  // One Refresh reloads both halves: the saved query re-runs and the bumped
  // token makes the workspace half re-read the folder from disk.
  const refresh = () => { setNotice(null); setRevision(value => value + 1); };
  const savedFromWorkspace = (saved: SavedVersionResult) => {
    setError(null);
    setNotice(t(saved.pinnedRevision ? "filesWorkspace.saved" : "filesWorkspace.savedUnpinned", { name: saved.artifact.name }));
    setPage(0); setRevision(value => value + 1);
  };
  return <section className="mx-auto h-full w-full max-w-5xl overflow-y-auto bg-panel p-4 text-ink sm:p-6" aria-labelledby="files-title">
    <header className="flex flex-wrap items-center justify-between gap-2"><h1 id="files-title" className="text-[22px] font-semibold">Files</h1><div className="flex flex-wrap gap-2">{onShowPane && scope && <button className={button} data-pane-action="show" onClick={() => onShowPane(scope)}>{t("workspacePane.showPane")}</button>}<button className={button} disabled={busy} onClick={refresh}>Refresh</button>{onClose && <button className={button} onClick={onClose}>Close Files</button>}</div></header>
    <p className="mt-2 text-[13px] text-ink-secondary">The files in a bot's working folder, and the verified copies Murage has saved. Refresh reloads both. A path mentioned in chat is not automatically a saved file.</p>
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <label className="text-[12px]">Bot<select className={`${field} mt-1 w-full`} value={botId} onChange={event => { setBotId(event.target.value); setThreadId(""); setPage(0); setSavedEveryBot(false); setNotice(null); }}><option value="">All bots</option>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
      <label className="text-[12px]">Task<select className={`${field} mt-1 w-full`} value={threadId} disabled={!bot} onChange={event => { setThreadId(event.target.value); setPage(0); setSavedEveryBot(false); setNotice(null); }}><option value="">All tasks</option>{bot?.tasks?.map(task => <option key={task.threadId} value={task.threadId}>{task.title}</option>)}</select></label>
    </div>
    {notice && <p role="status" className="mt-3 text-[13px] text-ink-secondary">{notice}</p>}
    <WorkspaceFiles scope={scope} scopeLabel={scopeLabel} refreshToken={revision} renderHtml={artifactPreviewHtml} onSaved={savedFromWorkspace} onRevealFolder={onRevealFolder} onOpenInPane={onOpenInPane} />
    <section aria-labelledby="files-saved-title" className="mt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="files-saved-title" className="text-[16px] font-semibold">{t("filesWorkspace.savedTitle")}</h2>
        <span className="text-[12px] text-ink-secondary">{t("filesWorkspace.savedSubtitle")}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="text-[12px]">Type<select className={`${field} mt-1 w-full`} value={kind} onChange={event => { setKind(event.target.value as ArtifactKind | ""); setPage(0); }}><option value="">All types</option><option value="html">HTML reports</option><option value="text">Text and data</option><option value="image">Images</option><option value="other">Other files</option></select></label>
        <label className="text-[12px]">From<input className={`${field} mt-1 w-full`} type="date" value={since} onChange={event => { setSince(event.target.value); setPage(0); }} /></label>
        <label className="text-[12px]">Until<input className={`${field} mt-1 w-full`} type="date" value={until} onChange={event => { setUntil(event.target.value); setPage(0); }} /></label>
      </div>
      <form className="mt-3 flex gap-2" role="search" onSubmit={event => { event.preventDefault(); setQuery(draft.trim()); setPage(0); }}><label htmlFor="files-search" className="sr-only">Search files</label><input id="files-search" type="search" className={`${field} flex-1`} value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} placeholder="Search file names" /><button className={button} disabled={busy}>Search</button></form>
      {/* An empty saved list can never hide why it is empty: every filter
          still narrowing it is named here, next to the way out. */}
      <div data-testid="files-saved-filters" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-secondary">
        <p className="min-w-0 break-words">{filterLabels.length ? t("filesWorkspace.activeFilters", { filters: filterLabels.join(" · ") }) : t("filesWorkspace.noFilters")}</p>
        {filterLabels.length > 0 && <button type="button" className={button} onClick={() => { setSavedEveryBot(true); setKind(""); setSince(""); setUntil(""); setQuery(""); setDraft(""); setPage(0); setNotice(null); }}>{t("filesWorkspace.allSavedFiles")}</button>}
      </div>
      <details className="my-4 rounded-lg border border-hairline/50 p-3 text-[13px]"><summary className="cursor-pointer font-medium">Save an existing workspace file</summary><p className="mt-2 text-[12px] text-ink-secondary">For engines without automatic registration, enter the exact relative path. Murage verifies the file before saving a copy. Maximum 25 MiB per file and 512 MiB total; files are never automatically removed.</p>
        <form className="mt-3 flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void act(async () => { await api("/api/artifacts/register", { method: "POST", body: JSON.stringify({ botId, threadId: targetThread, relativePath, ...(name.trim() ? { name: name.trim() } : {}) }) }); setRelativePath(""); setName(""); setPage(0); setRevision(value => value + 1); }); }}>
          <label>Relative file path<input className={`${field} mt-1 w-full`} value={relativePath} maxLength={2048} onChange={event => setRelativePath(event.target.value)} placeholder="reports/weekly.html" /></label>
          <label>Friendly name (optional)<input className={`${field} mt-1 w-full`} value={name} maxLength={200} onChange={event => setName(event.target.value)} /></label>
          {!bot && <p className="text-[12px] text-ink-secondary">Choose a bot above to select its workspace.</p>}
          <button className={`${button} self-start`} disabled={busy || !bot || !targetThread || !relativePath}>Verify and save file</button>
        </form>
      </details>
      {error && <p role="alert" className="my-3 text-[13px] text-danger">{error}</p>}
      {busy && <p role="status" className="my-3 text-[12px] text-ink-secondary">Checking files…</p>}
      {result && !result.items.length && !busy && <p className="py-6 text-[13px] text-ink-secondary">No saved files match these filters.</p>}
      <div className="space-y-3">{result?.items.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} busy={busy} onPreview={() => void act(async () => setPreview(await api(`/api/artifacts/${artifact.id}/preview`) as ArtifactPreview))} onDownload={() => void download(artifact)} onSource={onSource ? () => onSource(artifact) : undefined} onNativeAction={onNativeAction} onOpenHere={onOpenInPane ? () => onOpenInPane({ botId: artifact.botId, threadId: artifact.threadId }, artifact.relativePath, "preview") : undefined} />)}</div>
      {result && <footer className="mt-4 flex items-center justify-between gap-3"><button className={button} disabled={busy || !page} onClick={() => setPage(value => value - 1)}>Previous</button><span className="text-[12px]">Page {page + 1} · {result.total} files</span><button className={button} disabled={busy || (page + 1) * result.pageSize >= result.total} onClick={() => setPage(value => value + 1)}>Next</button></footer>}
    </section>
    {preview && <section ref={previewPanel} role="region" aria-label="File preview" className="mt-5 rounded-xl border border-hairline p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="break-words text-[15px] font-medium">{preview.artifact.name}</h2><div className="flex gap-2"><button className={button} disabled={busy} onClick={() => void download(preview.artifact)}>Download saved copy</button><button className={button} onClick={() => setPreview(null)}>Close preview</button></div></div>
      {preview.mode === "html" && <><p className="my-2 text-[12px] text-ink-secondary">Protected preview: scripts, external resources and app access are blocked.</p><iframe title={`Preview ${preview.artifact.name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={artifactPreviewHtml(preview.content ?? "")} className="h-[420px] w-full rounded-lg bg-white" /></>}
      {preview.mode === "text" && <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-[12px]">{preview.content}</pre>}
      {preview.mode === "image" && <ArtifactImageMedia artifact={preview.artifact} content={preview.content} />}
      {preview.mode === "download" && <p className="mt-3 text-[13px] text-ink-secondary">Preview is unavailable for this format or size. Download the saved copy to review it.</p>}
    </section>}
  </section>;
}
