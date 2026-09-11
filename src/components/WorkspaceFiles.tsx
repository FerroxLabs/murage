// Workspace view of Files (R3-T2). Lists the files in one conversation's
// server-resolved workspace as they are right now, one folder at a time, and
// lets the owner save an exact version of a file into Files. Nothing here is a
// saved copy, and nothing here claims who wrote a file.
import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import {
  canSaveEntry, entryNotice, formatFileSize, isHtmlPath, rootStateNotice, saveWorkspaceVersion, workspaceCrumbs, workspaceNativeAction, workspaceUrl,
  type SavedVersionResult, type WorkspaceNativeAction,
} from "@/lib/files-view";
import {
  WORKSPACE_FILES_ROUTES,
  type WorkspaceEntry, type WorkspaceListResponse, type WorkspaceReadResult, type WorkspaceRootInfo, type WorkspaceScopeRef, type WorkspaceSearchResponse,
} from "../../shared/workspace-files";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const field = "min-h-10 min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const quiet = "rounded underline underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

interface Listing { entries: WorkspaceEntry[]; cursor?: string; incomplete: boolean }
interface Found extends Listing { query: string; scanned: number }
interface Viewing { entry: WorkspaceEntry; result?: WorkspaceReadResult; error?: string }
interface Place { key: string; directory: string; query: string }

const reasonText = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;
const statusOf = (reason: unknown) => (reason as { status?: unknown } | null)?.status;

export function WorkspaceFiles({ scope, scopeLabel, refreshToken, renderHtml, onSaved, onRevealFolder, onNativeAction = workspaceNativeAction() }: {
  scope: WorkspaceScopeRef | null;
  /** "Bot · task" the owner chose; shown so the browsed workspace is explicit. */
  scopeLabel: string;
  /** Bumped by the Files Refresh button, which reloads both views. */
  refreshToken: number;
  renderHtml: (content: string) => string;
  onSaved: (result: SavedVersionResult) => void;
  onRevealFolder?: (scope: WorkspaceScopeRef) => void;
  /** Open in app / Show in folder for one live file (F4-T5). Defaults to the
   * desktop bridge and is absent in a browser, where the buttons do not show. */
  onNativeAction?: WorkspaceNativeAction;
}) {
  const scopeKey = scope ? `${scope.botId}\n${scope.threadId}` : "";
  // A different conversation always starts at its own root, with no search.
  const [placeState, setPlace] = useState<Place>({ key: scopeKey, directory: "", query: "" });
  const place = placeState.key === scopeKey ? placeState : { key: scopeKey, directory: "", query: "" };
  const [root, setRoot] = useState<WorkspaceRootInfo | null>(null);
  const [listing, setListing] = useState<Listing | null>(null), [found, setFound] = useState<Found | null>(null);
  const [draft, setDraft] = useState(""), [loading, setLoading] = useState(false), [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null), [viewing, setViewing] = useState<Viewing | null>(null);
  const gate = useRef(false), generation = useRef(0), viewPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    const current = ++generation.current;
    setViewing(null); setError(null);
    if (!scope) { setRoot(null); setListing(null); setFound(null); setLoading(false); return; }
    const controller = new AbortController(), signal = controller.signal;
    const live = () => !signal.aborted && current === generation.current;
    setLoading(true);
    void (async () => {
      const info = await api(workspaceUrl(WORKSPACE_FILES_ROUTES.root, scope), { signal }) as WorkspaceRootInfo;
      if (!live()) return;
      setRoot(info);
      if (info.state !== "ready") { setListing(null); setFound(null); return; }
      if (place.query) {
        const result = await api(workspaceUrl(WORKSPACE_FILES_ROUTES.search, scope, { query: place.query }), { signal }) as WorkspaceSearchResponse;
        if (live()) { setListing(null); setFound({ query: result.query, entries: result.entries, cursor: result.cursor, incomplete: result.incomplete, scanned: result.scanned }); }
      } else {
        const result = await api(workspaceUrl(WORKSPACE_FILES_ROUTES.list, scope, { directory: place.directory || undefined }), { signal }) as WorkspaceListResponse;
        if (live()) { setFound(null); setListing({ entries: result.entries, cursor: result.cursor, incomplete: result.incomplete }); }
      }
    })().catch(reason => { if (live()) { setListing(null); setFound(null); setError(reasonText(reason, t("filesWorkspace.loadError"))); } })
      .finally(() => { if (live()) setLoading(false); });
    return () => controller.abort();
    // `scope` is identified by scopeKey; a new object for the same scope must not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, place.directory, place.query, refreshToken]);
  useEffect(() => { if (viewing) viewPanel.current?.scrollIntoView({ block: "nearest" }); }, [viewing]);

  const navigate = (directory: string) => { setDraft(""); setPlace({ key: scopeKey, directory, query: "" }); };
  const act = async (action: (current: number) => Promise<void>) => {
    if (gate.current) return; gate.current = true; setActing(true); setError(null);
    try { await action(generation.current); } finally { gate.current = false; setActing(false); }
  };
  const more = () => act(async current => {
    if (!scope) return;
    try {
      if (found?.cursor) {
        const result = await api(workspaceUrl(WORKSPACE_FILES_ROUTES.search, scope, { query: found.query, cursor: found.cursor })) as WorkspaceSearchResponse;
        if (current === generation.current) setFound(previous => previous && { ...previous, entries: [...previous.entries, ...result.entries], cursor: result.cursor, incomplete: result.incomplete, scanned: previous.scanned + result.scanned });
      } else if (listing?.cursor) {
        const result = await api(workspaceUrl(WORKSPACE_FILES_ROUTES.list, scope, { directory: place.directory || undefined, cursor: listing.cursor })) as WorkspaceListResponse;
        if (current === generation.current) setListing(previous => previous && { entries: [...previous.entries, ...result.entries], cursor: result.cursor, incomplete: result.incomplete });
      }
    } catch (reason) { if (current === generation.current) setError(reasonText(reason, t("filesWorkspace.loadError"))); }
  });
  const view = (entry: WorkspaceEntry) => act(async current => {
    if (!scope) return;
    setViewing({ entry });
    try {
      const result = await api(workspaceUrl(WORKSPACE_FILES_ROUTES.read, scope, { path: entry.relativePath })) as WorkspaceReadResult;
      if (current === generation.current) setViewing({ entry: { ...entry, revision: result.revision, bytes: result.bytes, modifiedAt: result.modifiedAt }, result });
    } catch (reason) {
      if (current !== generation.current) return;
      setViewing({ entry, error: statusOf(reason) === 501 ? t("filesWorkspace.viewUnavailable") : `${reasonText(reason, t("filesWorkspace.viewError"))} ${t("filesWorkspace.viewSaveHint")}` });
    }
  });
  const save = (entry: WorkspaceEntry) => act(async current => {
    if (!scope) return;
    try { const result = await saveWorkspaceVersion(api, scope, entry); if (current === generation.current) onSaved(result); }
    catch (reason) { if (current === generation.current) setError(reasonText(reason, t("filesWorkspace.saveError"))); }
  });
  // The main process decides what may be opened, asks before a browser
  // opens HTML/SVG and refuses with a sentence the owner can act on; that
  // sentence is shown as is.
  const native = (entry: WorkspaceEntry, action: "open" | "reveal") => act(async current => {
    if (!scope || !onNativeAction) return;
    try { await onNativeAction(scope, entry, action); }
    catch (reason) { if (current === generation.current) setError(reasonText(reason, t("filesWorkspace.nativeError"))); }
  });

  const busy = loading || acting;
  const crumbs = workspaceCrumbs(place.directory, root?.label || t("filesWorkspace.root"));
  const entries = found ? found.entries : listing?.entries ?? [];
  const notice = root ? rootStateNotice(root.state) : undefined;
  const ready = root?.state === "ready";
  return <section aria-labelledby="files-workspace-title" data-testid="files-workspace" className="mt-4 rounded-xl border border-hairline/50 p-3 sm:p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 id="files-workspace-title" className="text-[16px] font-semibold">{t("filesWorkspace.title")}</h2>
      <span className="text-[12px] text-ink-secondary">{t("filesWorkspace.subtitle")}</span>
    </div>
    {!scope && <p className="mt-2 text-[13px] text-ink-secondary">{t("filesWorkspace.chooseBot")}</p>}
    {scope && <p data-testid="files-effective-root" className="mt-2 break-words text-[12px] text-ink-secondary">
      {t("filesWorkspace.browsing", { scope: scopeLabel })}{ready && <> · {root.managed ? t("filesWorkspace.managed") : t("filesWorkspace.customFolder")}</>}
    </p>}
    {scope && ready && root.displayPath && <p className="mt-1 break-all text-[12px] text-ink-secondary">
      {t("filesWorkspace.location", { path: root.displayPath })}{" "}
      {onRevealFolder && <button type="button" className={quiet} onClick={() => onRevealFolder(scope)}>{t("filesWorkspace.showFolder")}</button>}
    </p>}
    {notice && <p data-testid="files-workspace-state" data-state={root?.state} className="mt-3 rounded-lg bg-inset p-3 text-[13px]">{t(notice)}</p>}
    {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    {scope && loading && <p role="status" className="mt-3 text-[12px] text-ink-secondary">{t("filesWorkspace.loading")}</p>}
    {scope && ready && <>
      <form role="search" aria-label={t("filesWorkspace.searchLabel")} className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); const query = draft.trim(); if (query) setPlace({ key: scopeKey, directory: place.directory, query }); }}>
        <label htmlFor="files-workspace-search" className="sr-only">{t("filesWorkspace.searchLabel")}</label>
        <input id="files-workspace-search" type="search" className={`${field} flex-1`} value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} placeholder={t("filesWorkspace.searchPlaceholder")} />
        <button className={button} disabled={busy || !draft.trim()}>{t("filesWorkspace.searchButton")}</button>
      </form>
      {found
        ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]"><p className="min-w-0 break-words">{t("filesWorkspace.searchResults", { query: found.query })}</p><button type="button" className={button} onClick={() => navigate(place.directory)}>{t("filesWorkspace.backToFolders")}</button></div>
        : <nav aria-label={t("filesWorkspace.breadcrumb")} className="mt-3 flex flex-wrap items-center gap-1 text-[13px]">
          {crumbs.map((crumb, index) => <span key={crumb.path || "/"} className="flex min-w-0 items-center gap-1">
            {index > 0 && <span aria-hidden="true" className="text-ink-secondary">/</span>}
            {index === crumbs.length - 1 ? <span aria-current="location" className="break-all font-medium">{crumb.label}</span> : <button type="button" className={`${quiet} break-all`} onClick={() => navigate(crumb.path)}>{crumb.label}</button>}
          </span>)}
        </nav>}
      {entries.length > 0 && <ul aria-label={found ? t("filesWorkspace.resultsList") : t("filesWorkspace.folderList", { folder: crumbs.at(-1)!.label })} className="mt-2 max-h-[28rem] divide-y divide-hairline/40 overflow-y-auto rounded-lg border border-hairline/40">
        {entries.map(entry => <WorkspaceRow key={entry.relativePath} entry={entry} showPath={Boolean(found)} busy={busy} onOpen={() => navigate(entry.relativePath)} onView={() => void view(entry)} onSave={() => void save(entry)} onNative={onNativeAction ? action => void native(entry, action) : undefined} />)}
      </ul>}
      {!loading && !entries.length && (listing || found) && <p className="mt-3 text-[13px] text-ink-secondary">{found ? t("filesWorkspace.searchEmpty") : place.directory ? t("filesWorkspace.folderEmpty") : t("filesWorkspace.rootEmpty")}</p>}
      {found?.cursor && <p className="mt-2 text-[12px] text-ink-secondary">{t("filesWorkspace.searchPartial", { scanned: found.scanned.toLocaleString() })}</p>}
      {found && !found.cursor && found.incomplete && <p className="mt-2 text-[12px] text-ink-secondary">{t("filesWorkspace.searchSkipped")}</p>}
      {listing && !listing.cursor && listing.incomplete && <p className="mt-2 text-[12px] text-ink-secondary">{t("filesWorkspace.folderTruncated")}</p>}
      {(found?.cursor || (!found && listing?.cursor)) && <button type="button" className={`${button} mt-2`} disabled={busy} onClick={() => void more()}>{found ? t("filesWorkspace.searchContinue") : t("filesWorkspace.showMore")}</button>}
    </>}
    {viewing && <section ref={viewPanel} role="region" aria-label={t("filesWorkspace.viewRegion")} className="mt-3 rounded-xl border border-hairline p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-all text-[14px] font-medium">{viewing.entry.relativePath}</h3>
        <div className="flex flex-wrap gap-2">
          {canSaveEntry(viewing.entry) && <button type="button" className={button} disabled={busy} onClick={() => void save(viewing.entry)}>{t("filesWorkspace.saveThisVersion")}</button>}
          {onNativeAction && canSaveEntry(viewing.entry) && <NativeButtons entry={viewing.entry} busy={busy} onNative={action => void native(viewing.entry, action)} />}
          <button type="button" className={button} onClick={() => setViewing(null)}>{t("filesWorkspace.closeView")}</button>
        </div>
      </div>
      <p className="my-2 text-[12px] text-ink-secondary">{t("filesWorkspace.viewNote")}</p>
      {!viewing.result && !viewing.error && <p role="status" className="text-[12px] text-ink-secondary">{t("filesWorkspace.viewOpening")}</p>}
      {viewing.error && <p role="alert" className="text-[13px] text-danger">{viewing.error}</p>}
      {viewing.result && (isHtmlPath(viewing.entry.relativePath)
        ? <iframe title={t("filesWorkspace.viewFrame", { name: viewing.entry.name })} sandbox="" referrerPolicy="no-referrer" srcDoc={renderHtml(viewing.result.content)} className="h-[360px] w-full rounded-lg bg-white" />
        : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-[12px]">{viewing.result.content}</pre>)}
    </section>}
  </section>;
}

export function WorkspaceRow({ entry, showPath, busy, onOpen, onView, onSave, onNative }: {
  entry: WorkspaceEntry; showPath: boolean; busy: boolean; onOpen: () => void; onView: () => void; onSave: () => void;
  /** Absent outside the desktop shell: no native buttons are shown. */
  onNative?: (action: "open" | "reveal") => void;
}) {
  const note = entryNotice(entry), folder = entry.kind === "directory" && entry.state === "local";
  const meta = folder ? t("filesWorkspace.folder")
    : canSaveEntry(entry) ? t("filesWorkspace.fileMeta", { size: formatFileSize(entry.bytes ?? 0), modified: entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : "—" })
    : undefined;
  return <li data-workspace-path={entry.relativePath} data-kind={entry.kind} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
    <div className="min-w-0 flex-1">
      {folder
        ? <button type="button" className={`${quiet} break-all text-left text-[13px] font-medium`} aria-label={t("filesWorkspace.openFolder", { name: entry.name })} onClick={onOpen}>{entry.name}/</button>
        : <p className="break-all text-[13px] font-medium">{entry.name}</p>}
      {showPath && <p className="break-all text-[12px] text-ink-secondary">{entry.relativePath}</p>}
      {meta && <p className="text-[12px] text-ink-secondary">{meta}</p>}
      {note && <p className="text-[12px] text-ink-secondary">{t(note)}</p>}
    </div>
    {canSaveEntry(entry) && <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={busy} aria-label={t("filesWorkspace.viewCurrentNamed", { name: entry.name })} onClick={onView}>{t("filesWorkspace.viewCurrent")}</button>
      <button type="button" className={button} disabled={busy} aria-label={t("filesWorkspace.saveVersionNamed", { name: entry.name })} onClick={onSave}>{t("filesWorkspace.saveVersion")}</button>
      {onNative && <NativeButtons entry={entry} busy={busy} onNative={onNative} />}
    </div>}
  </li>;
}

/** Open in app / Show in folder (F4-T5). Only the desktop shell offers
 * these; the main process, not this component, decides which file types
 * open and warns before a browser is involved. */
function NativeButtons({ entry, busy, onNative }: { entry: WorkspaceEntry; busy: boolean; onNative: (action: "open" | "reveal") => void }) {
  return <>
    <button type="button" data-native-action="open" className={button} disabled={busy} aria-label={t("filesWorkspace.openInAppNamed", { name: entry.name })} onClick={() => onNative("open")}>{t("filesWorkspace.openInApp")}</button>
    <button type="button" data-native-action="reveal" className={button} disabled={busy} aria-label={t("filesWorkspace.showInFolderNamed", { name: entry.name })} onClick={() => onNative("reveal")}>{t("filesWorkspace.showInFolder")}</button>
  </>;
}
