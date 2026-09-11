// Workspace pane (F4-T3): the bot-linked rail beside the chat.
//
// On a wide screen it is a resizable column to the right of the conversation
// holding the current conversation's files, a strip of preview/editor tabs and
// the open document; the chat keeps at least WORKSPACE_PANE_MIN_CHAT_WIDTH.
// Below `md` it covers the chat and offers Back to chat instead of squeezing
// four columns into a phone. Expand gives a document the whole column.
//
// Every file is named by the identity the server issued — a scope (bot +
// conversation) and a validated relative path — never by an absolute path.
// A tab keeps its own scope, so a file opened from another bot's Files view
// never changes the selected conversation. Tab rules (single click reuses the
// clean preview tab; edit or Keep open makes a tab persistent; a dirty tab is
// never replaced or closed without asking) live in src/lib/workspace-pane.ts.
//
// Editing goes through F4-T4's MarkdownEditor and F4-T2's DocumentSession.
// One session and controller exist per edit tab for as long as the tab is
// open, whichever tab is showing, so switching tabs never loses typing, and a
// late save receipt can only settle the document it was issued for. External
// changes are noticed by probing the file's revision from its folder listing
// (a stat, not a 2 MiB re-read) and handed to the session, which reloads a
// clean document and raises a conflict for a dirty one. Nothing here writes
// a file except an explicit Save or Save a copy.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, FileText, Folder, Maximize2, Minimize2, Pencil, Pin, RefreshCw, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { useNarrowViewport } from "@/lib/media-query";
import { useDesktopSurface } from "@/lib/use-surface";
import {
  canSaveEntry, entryNotice, formatFileSize, rootStateNotice, saveWorkspaceVersion, workspaceCrumbs, workspaceNativeAction, workspaceUrl,
  type ApiCall, type WorkspaceNativeAction,
} from "@/lib/files-view";
import {
  WORKSPACE_PANE_MIN_WIDTH, WORKSPACE_PANE_WIDTH_KEY,
  activeWorkspaceTab, clampWorkspaceWidth, copyPath, documentKindForPath, fileName, probeWorkspaceRevision, readWorkspaceFile, tabIdentity, tabKey,
  workspaceApi, writeWorkspaceFile,
  type WorkspacePaneAction, type WorkspacePaneState, type WorkspaceTab,
} from "@/lib/workspace-pane";
import {
  createDocumentSessionStore, hasUnsavedChanges, openDocumentSession, saveFailureFrom,
  type DocumentSessionStore,
} from "@/lib/document-session";
import { createIndexedDbDraftBackend, createMarkdownDraftStore, type MarkdownDraftStore } from "@/lib/markdown-drafts";
import { MarkdownEditor, MarkdownEditorController } from "./MarkdownEditor";
import { ChatMarkdown } from "./ChatMarkdown";
import { artifactPreviewHtml, openFiles } from "./Files";
import { MEDIA_ROUTES, type MediaResolveResponse } from "../../shared/media-assets";
import {
  WORKSPACE_FILES_ROUTES, isWorkspaceRelativePath,
  type WorkspaceEntry, type WorkspaceListResponse, type WorkspaceReadResult, type WorkspaceRootInfo, type WorkspaceScopeRef, type WorkspaceSearchResponse,
} from "../../shared/workspace-files";

const button = "min-h-9 rounded-lg border border-hairline/50 bg-control px-2.5 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";
const iconButton = "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";
const field = "min-h-9 min-w-0 rounded-lg border border-hairline/50 bg-inset px-2.5 py-1.5 text-[12.5px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const quiet = "rounded underline underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

/** How often an open document asks whether its file changed on disk. */
export const WORKSPACE_PANE_PROBE_MS = 5_000;

const reasonText = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;
const scopeKeyOf = (scope: WorkspaceScopeRef | null) => (scope ? `${scope.botId}\n${scope.threadId}` : "");

export type WorkspacePaneDispatch = (action: WorkspacePaneAction) => void;

// ── Store-connected pane ─────────────────────────────────────────────────

/** The pane for the selected conversation. Renders nothing while closed or
 * off the desktop; the store keeps the tabs either way. */
export function WorkspacePane({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const desktop = useDesktopSurface();
  const pane = state.workspacePane;
  const send = useCallback<WorkspacePaneDispatch>(action => dispatch({ type: "workspacePane", action }), [dispatch]);
  const labelForScope = useCallback((scope: WorkspaceScopeRef) => scopeLabel(state.bots, scope), [state.bots]);
  const drafts = useMemo(() => createMarkdownDraftStore(createIndexedDbDraftBackend()), []);
  const reveal = window.muragebox?.revealWorkspace;
  if (desktop !== true || !pane.open) return null;
  return (
    <WorkspacePaneSurface
      scope={{ botId: bot.id, threadId: bot.threadId }}
      pane={pane}
      dispatch={send}
      labelForScope={labelForScope}
      drafts={drafts}
      onOpenFiles={scope => openFiles({ botId: scope.botId, threadId: scope.threadId })}
      onRevealFolder={reveal ? scope => reveal(scope.botId, scope.threadId) : undefined}
    />
  );
}

/** "Bot · task" for a scope, from the bots the store knows. */
export function scopeLabel(bots: ReadonlyArray<{ id: string; name: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string; title: string }> }>, scope: WorkspaceScopeRef): string {
  const bot = bots.find(item => item.id === scope.botId);
  if (!bot) return scope.botId;
  const title = bot.tasks?.find(item => item.threadId === scope.threadId)?.title || t("workspacePane.currentTask");
  return t("workspacePane.scope", { bot: bot.name, task: title });
}

// ── Surface ──────────────────────────────────────────────────────────────

export interface WorkspacePaneSurfaceProps {
  /** The selected conversation: whose files the rail lists. */
  scope: WorkspaceScopeRef | null;
  pane: WorkspacePaneState;
  dispatch: WorkspacePaneDispatch;
  labelForScope: (scope: WorkspaceScopeRef) => string;
  api?: ApiCall;
  drafts?: MarkdownDraftStore | null;
  nativeAction?: WorkspaceNativeAction;
  onOpenFiles?: (scope: WorkspaceScopeRef) => void;
  onRevealFolder?: (scope: WorkspaceScopeRef) => Promise<void> | void;
  /** Override the viewport answer (tests and fixtures). */
  narrow?: boolean;
  probeMs?: number;
}

interface EditorEntry {
  key: string;
  session: DocumentSessionStore;
  controller: MarkdownEditorController;
  unsubscribe: () => void;
}

export function WorkspacePaneSurface({
  scope, pane, dispatch, labelForScope, api = workspaceApi, drafts = null, nativeAction = workspaceNativeAction(), onOpenFiles, onRevealFolder, narrow: narrowOverride, probeMs = WORKSPACE_PANE_PROBE_MS,
}: WorkspacePaneSurfaceProps) {
  const viewportNarrow = useNarrowViewport();
  const narrow = narrowOverride ?? viewportNarrow;
  const aside = useRef<HTMLElement>(null);
  const [filesShown, setFilesShown] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const editors = useRef(new Map<string, EditorEntry>());
  const active = activeWorkspaceTab(pane);

  // One editor per edit tab, alive for as long as the tab is; disposal flushes
  // its draft. A tab that went back to Preview (only possible when clean) or
  // was closed drops its editor here, and the whole registry goes with the pane.
  useEffect(() => {
    for (const [id, entry] of editors.current) {
      const tab = pane.tabs.find(item => item.id === id);
      if (tab && tab.mode === "edit" && tabKey(tab) === entry.key) continue;
      editors.current.delete(id);
      entry.unsubscribe();
      void entry.controller.dispose();
    }
  }, [pane.tabs]);
  useEffect(() => () => {
    for (const entry of editors.current.values()) { entry.unsubscribe(); void entry.controller.dispose(); }
    editors.current.clear();
  }, []);

  const editorFor = useCallback((tab: WorkspaceTab, read: WorkspaceReadResult): EditorEntry => {
    const existing = editors.current.get(tab.id);
    if (existing && existing.key === tabKey(tab)) return existing;
    existing?.unsubscribe();
    if (existing) void existing.controller.dispose();
    const session = createDocumentSessionStore(openDocumentSession(read));
    const identity = tabIdentity(tab);
    const controller = new MarkdownEditorController({
      session,
      save: request => writeWorkspaceFile(api, request),
      readDisk: () => readWorkspaceFile(api, identity.scope, identity.relativePath),
      drafts,
      connect: false,
    });
    // The tab's dirty flag is what the reducer reads before replacing or
    // closing it, so it follows the session, not the other way round.
    let dirty = false;
    const unsubscribe = session.subscribe(() => {
      const next = hasUnsavedChanges(session.getState());
      if (next !== dirty) { dirty = next; dispatch({ type: "setDirty", id: tab.id, dirty: next }); }
    });
    const entry: EditorEntry = { key: tabKey(tab), session, controller, unsubscribe };
    editors.current.set(tab.id, entry);
    // A tab reopened after the pane was closed may still say dirty from its
    // last editor; the new session starts clean and says so. A preserved
    // draft, once restored below, marks it dirty again through the listener.
    dispatch({ type: "setDirty", id: tab.id, dirty: false });
    controller.connect();
    void controller.restoreDraft();
    return entry;
  }, [api, drafts, dispatch]);

  // Width: persisted per browser as a convenience; the store holds the truth.
  useEffect(() => {
    try { window.localStorage.setItem(WORKSPACE_PANE_WIDTH_KEY, String(pane.width)); } catch { /* storage blocked: the width is still applied */ }
  }, [pane.width]);
  const containerWidth = () => aside.current?.parentElement?.clientWidth;
  const setWidth = (width: number) => dispatch({ type: "setWidth", width, containerWidth: containerWidth() });
  useEffect(() => {
    // The chat may have lost width since the rail was sized (a window shrank,
    // a sidebar opened); keep the conversation usable.
    const container = aside.current?.parentElement;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = container.clientWidth;
      if (width > 0 && clampWorkspaceWidth(pane.width, width) !== pane.width) dispatch({ type: "setWidth", width: pane.width, containerWidth: width });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [pane.width, dispatch]);

  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: pane.width };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // The rail is on the right: dragging left makes it wider.
    setWidth(state.startWidth + (state.startX - event.clientX));
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onHandleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") setWidth(pane.width + step);
    else if (event.key === "ArrowRight") setWidth(pane.width - step);
    else if (event.key === "Home") setWidth(WORKSPACE_PANE_MIN_WIDTH);
    else if (event.key === "End") setWidth(Number.MAX_SAFE_INTEGER);
    else return;
    event.preventDefault();
  };

  const wide = !narrow;
  const fills = narrow || pane.expanded;
  const closeQuestion = pane.closeRequest ? pane.tabs.find(tab => tab.id === pane.closeRequest) : undefined;
  const scopeText = scope ? labelForScope(scope) : "";
  const maxWidth = containerWidth();
  return (
    <aside
      ref={aside}
      data-testid="workspace-pane"
      data-layout={narrow ? "compact" : pane.expanded ? "expanded" : "rail"}
      role="region"
      aria-label={t("workspacePane.region")}
      // Below md the pane and the chat take turns; the hidden one stays
      // mounted so a half-typed draft and a scrolled transcript both survive
      // the switch. Above md `compactView` means nothing.
      hidden={narrow && pane.compactView !== "workspace"}
      className={cn(
        "relative flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel text-ink",
        fills ? "flex-1" : "shrink-0",
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-l-0",
      )}
      style={wide && !pane.expanded ? { width: pane.width } : undefined}
    >
      {wide && !pane.expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("workspacePane.resize")}
          aria-valuemin={WORKSPACE_PANE_MIN_WIDTH}
          aria-valuemax={maxWidth ? clampWorkspaceWidth(Number.MAX_SAFE_INTEGER, maxWidth) : undefined}
          aria-valuenow={pane.width}
          title={t("workspacePane.resizeHint")}
          tabIndex={0}
          data-testid="workspace-pane-resize"
          className="absolute inset-y-0 -left-1 z-[1] w-2 cursor-col-resize touch-none hover:bg-accent/30 focus-visible:bg-accent/40 focus-visible:outline-none"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onKeyDown={onHandleKey}
        />
      )}
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline/40 px-3 py-2">
        {narrow && (
          <button type="button" className={cn(button, "inline-flex items-center gap-1.5")} data-testid="workspace-pane-back" onClick={() => dispatch({ type: "setCompactView", view: "chat" })}>
            <ArrowLeft size={14} /> {t("workspacePane.backToChat")}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold">{t("workspacePane.title")}</h2>
          {scopeText && <p data-testid="workspace-pane-scope" className="truncate text-[12px] text-ink-secondary" title={scopeText}>{scopeText}</p>}
        </div>
        {wide && (
          <button
            type="button"
            className={iconButton}
            aria-pressed={pane.expanded}
            aria-label={pane.expanded ? t("workspacePane.collapse") : t("workspacePane.expand")}
            title={pane.expanded ? t("workspacePane.collapse") : t("workspacePane.expand")}
            data-testid="workspace-pane-expand"
            onClick={() => dispatch({ type: "setExpanded", expanded: !pane.expanded })}
          >
            {pane.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        )}
        <button type="button" className={iconButton} aria-label={t("workspacePane.close")} title={t("workspacePane.close")} data-testid="workspace-pane-close" onClick={() => dispatch({ type: "setOpen", open: false })}>
          <X size={16} />
        </button>
      </header>

      <section aria-labelledby="workspace-pane-files" className={cn("flex shrink-0 flex-col border-b border-hairline/40", filesShown && "max-h-[45%]")}>
        <div className="flex items-center gap-1 px-2 py-1">
          <button type="button" className={cn(iconButton, "size-7")} aria-expanded={filesShown} aria-controls="workspace-pane-tree" aria-label={filesShown ? t("workspacePane.hideFiles") : t("workspacePane.showFiles")} onClick={() => setFilesShown(shown => !shown)}>
            {filesShown ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <h3 id="workspace-pane-files" className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{t("workspacePane.files")}</h3>
          <button type="button" className={cn(iconButton, "size-7")} aria-label={t("workspacePane.refresh")} title={t("workspacePane.refresh")} disabled={!scope} onClick={() => setRefreshToken(value => value + 1)}>
            <RefreshCw size={13} />
          </button>
          {onOpenFiles && scope && (
            <button type="button" className={cn(button, "min-h-7 px-2 py-1 text-[12px]")} onClick={() => onOpenFiles(scope)}>{t("workspacePane.openFiles")}</button>
          )}
        </div>
        <div id="workspace-pane-tree" hidden={!filesShown} className="min-h-0 overflow-y-auto px-2 pb-2">
          <WorkspaceTree scope={scope} api={api} refreshToken={refreshToken} onRevealFolder={onRevealFolder} onOpen={(entry, mode, pin) => scope && dispatch({ type: "open", scope, relativePath: entry.relativePath, mode, pin })} />
        </div>
      </section>

      <TabStrip pane={pane} dispatch={dispatch} currentScope={scope} labelForScope={labelForScope} />

      {closeQuestion && (
        <div role="alertdialog" aria-labelledby="workspace-pane-close-title" aria-describedby="workspace-pane-close-body" data-testid="workspace-pane-close-question" className="mx-3 mt-2 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
          <p id="workspace-pane-close-title" className="font-medium">{t("workspacePane.closeUnsaved.title")}</p>
          <p id="workspace-pane-close-body" className="text-ink-secondary">{t("workspacePane.closeUnsaved.body", { name: fileName(closeQuestion.relativePath) })}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => dispatch({ type: "cancelClose" })}>{t("workspacePane.closeUnsaved.cancel")}</button>
            <button type="button" className={button} onClick={() => dispatch({ type: "close", id: closeQuestion.id, force: true })}>{t("workspacePane.closeUnsaved.confirm")}</button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {active
          ? <WorkspaceDocument key={active.id} tab={active} api={api} dispatch={dispatch} editorFor={editorFor} editors={editors} nativeAction={nativeAction} onOpenFiles={onOpenFiles} probeMs={probeMs} />
          : <p className="px-4 py-6 text-[13px] text-ink-secondary" data-testid="workspace-pane-empty">{t("workspacePane.noTabs")}</p>}
      </div>
    </aside>
  );
}

// ── Tree ─────────────────────────────────────────────────────────────────

interface Listing { entries: WorkspaceEntry[]; cursor?: string; incomplete: boolean }
interface Found extends Listing { query: string; scanned: number }
interface Place { key: string; directory: string; query: string }

export function WorkspaceTree({ scope, api, refreshToken, onOpen, onRevealFolder }: {
  scope: WorkspaceScopeRef | null;
  api: ApiCall;
  refreshToken: number;
  onOpen: (entry: WorkspaceEntry, mode: "preview" | "edit", pin?: boolean) => void;
  onRevealFolder?: (scope: WorkspaceScopeRef) => Promise<void> | void;
}) {
  const scopeKey = scopeKeyOf(scope);
  const [placeState, setPlace] = useState<Place>({ key: scopeKey, directory: "", query: "" });
  // Another conversation always starts at its own root, with no search.
  const place = placeState.key === scopeKey ? placeState : { key: scopeKey, directory: "", query: "" };
  const [root, setRoot] = useState<WorkspaceRootInfo | null>(null);
  const [listing, setListing] = useState<Listing | null>(null), [found, setFound] = useState<Found | null>(null);
  const [draft, setDraft] = useState(""), [loading, setLoading] = useState(false), [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setError(null);
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
    })().catch(reason => { if (live()) { setListing(null); setFound(null); setError(reasonText(reason, t("workspacePane.loadError"))); } })
      .finally(() => { if (live()) setLoading(false); });
    return () => controller.abort();
    // `scope` is identified by scopeKey; a new object for the same scope must not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, place.directory, place.query, refreshToken]);

  const navigate = (directory: string) => { setDraft(""); setPlace({ key: scopeKey, directory, query: "" }); };
  const loadMore = async () => {
    if (!scope || more) return;
    const current = generation.current;
    setMore(true);
    try {
      if (found?.cursor) {
        const result = await api(workspaceUrl(WORKSPACE_FILES_ROUTES.search, scope, { query: found.query, cursor: found.cursor })) as WorkspaceSearchResponse;
        if (current === generation.current) setFound(previous => previous && { ...previous, entries: [...previous.entries, ...result.entries], cursor: result.cursor, incomplete: result.incomplete, scanned: previous.scanned + result.scanned });
      } else if (listing?.cursor) {
        const result = await api(workspaceUrl(WORKSPACE_FILES_ROUTES.list, scope, { directory: place.directory || undefined, cursor: listing.cursor })) as WorkspaceListResponse;
        if (current === generation.current) setListing(previous => previous && { entries: [...previous.entries, ...result.entries], cursor: result.cursor, incomplete: result.incomplete });
      }
    } catch (reason) { if (current === generation.current) setError(reasonText(reason, t("workspacePane.loadError"))); }
    finally { setMore(false); }
  };

  if (!scope) return <p className="px-1 py-2 text-[12.5px] text-ink-secondary">{t("workspacePane.noScope")}</p>;
  const ready = root?.state === "ready";
  const notice = root ? rootStateNotice(root.state) : undefined;
  const crumbs = workspaceCrumbs(place.directory, root?.label || t("filesWorkspace.root"));
  const entries = found ? found.entries : listing?.entries ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      {ready && root.displayPath && (
        <p data-testid="workspace-pane-root" className="truncate px-1 text-[11.5px] text-ink-secondary" title={root.displayPath}>
          {root.managed ? t("filesWorkspace.managed") : t("filesWorkspace.customFolder")} · {t("workspacePane.location", { path: root.displayPath })}{" "}
          {onRevealFolder && <button type="button" className={quiet} onClick={() => void onRevealFolder(scope)}>{t("filesWorkspace.showFolder")}</button>}
        </p>
      )}
      {notice && <p data-testid="workspace-pane-state" data-state={root?.state} className="rounded-md bg-inset px-2 py-1.5 text-[12.5px]">{t(notice)}</p>}
      {error && <p role="alert" className="px-1 text-[12.5px] text-danger">{error}</p>}
      {loading && <p role="status" className="px-1 text-[12px] text-ink-secondary">{t("workspacePane.loading")}</p>}
      {ready && (
        <>
          <form role="search" aria-label={t("workspacePane.searchLabel")} className="flex gap-1.5" onSubmit={event => { event.preventDefault(); const query = draft.trim(); if (query) setPlace({ key: scopeKey, directory: place.directory, query }); }}>
            <input type="search" aria-label={t("workspacePane.searchLabel")} className={cn(field, "flex-1")} value={draft} maxLength={200} placeholder={t("workspacePane.searchPlaceholder")} onChange={event => setDraft(event.target.value)} />
            <button className={button} disabled={loading || !draft.trim()}>{t("workspacePane.searchButton")}</button>
          </form>
          {found
            ? <div className="flex flex-wrap items-center justify-between gap-1 text-[12px]"><span className="min-w-0 break-words">{t("workspacePane.searchResults", { query: found.query })}</span><button type="button" className={quiet} onClick={() => navigate(place.directory)}>{t("workspacePane.backToFolders")}</button></div>
            : <nav aria-label={t("workspacePane.breadcrumb")} className="flex flex-wrap items-center gap-1 text-[12px]">
              {crumbs.map((crumb, index) => <span key={crumb.path || "/"} className="flex min-w-0 items-center gap-1">
                {index > 0 && <span aria-hidden="true" className="text-ink-secondary">/</span>}
                {index === crumbs.length - 1 ? <span aria-current="location" className="break-all font-medium">{crumb.label}</span> : <button type="button" className={cn(quiet, "break-all")} onClick={() => navigate(crumb.path)}>{crumb.label}</button>}
              </span>)}
            </nav>}
          {entries.length > 0 && (
            <ul aria-label={found ? t("workspacePane.resultsList") : t("workspacePane.folderList", { folder: crumbs.at(-1)!.label })} className="divide-y divide-hairline/30 rounded-md border border-hairline/40">
              {entries.map(entry => <TreeRow key={entry.relativePath} entry={entry} showPath={Boolean(found)} onFolder={() => navigate(entry.relativePath)} onOpen={(mode, pin) => onOpen(entry, mode, pin)} />)}
            </ul>
          )}
          {!loading && !entries.length && (listing || found) && <p className="px-1 py-1 text-[12.5px] text-ink-secondary">{found ? t("workspacePane.searchEmpty") : place.directory ? t("workspacePane.folderEmpty") : t("workspacePane.rootEmpty")}</p>}
          {found?.cursor && <p className="px-1 text-[12px] text-ink-secondary">{t("workspacePane.searchPartial", { scanned: found.scanned.toLocaleString() })}</p>}
          {found && !found.cursor && found.incomplete && <p className="px-1 text-[12px] text-ink-secondary">{t("workspacePane.searchSkipped")}</p>}
          {listing && !listing.cursor && listing.incomplete && <p className="px-1 text-[12px] text-ink-secondary">{t("workspacePane.folderTruncated")}</p>}
          {(found?.cursor || (!found && listing?.cursor)) && <button type="button" className={cn(button, "self-start")} disabled={more} onClick={() => void loadMore()}>{found ? t("workspacePane.searchContinue") : t("workspacePane.showMore")}</button>}
        </>
      )}
    </div>
  );
}

function TreeRow({ entry, showPath, onFolder, onOpen }: {
  entry: WorkspaceEntry; showPath: boolean; onFolder: () => void; onOpen: (mode: "preview" | "edit", pin?: boolean) => void;
}) {
  const folder = entry.kind === "directory" && entry.state === "local";
  const openable = canSaveEntry(entry);
  const note = entryNotice(entry);
  const markdown = openable && documentKindForPath(entry.relativePath) === "markdown";
  return (
    <li data-workspace-path={entry.relativePath} data-kind={entry.kind} className="flex items-center gap-1 px-1.5 py-1">
      {folder ? (
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12.5px] hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" aria-label={t("workspacePane.openFolder", { name: entry.name })} onClick={onFolder}>
          <Folder size={14} className="shrink-0 text-ink-secondary" /><span className="truncate font-medium">{entry.name}/</span>
        </button>
      ) : openable ? (
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12.5px] hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" aria-label={t("workspacePane.openPreview", { name: entry.name })} title={`${entry.relativePath} · ${formatFileSize(entry.bytes ?? 0)}`} onClick={() => onOpen("preview")}>
          <FileText size={14} className="shrink-0 text-ink-secondary" />
          <span className="min-w-0 truncate">{showPath ? entry.relativePath : entry.name}</span>
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate px-1 text-[12.5px] text-ink-secondary" title={note ? t(note) : undefined}>{showPath ? entry.relativePath : entry.name}{note && <span className="ml-1 text-[11px]">· {t(note)}</span>}</span>
      )}
      {openable && (
        <>
          {markdown && <button type="button" className={cn(iconButton, "size-7")} aria-label={t("workspacePane.openEdit", { name: entry.name })} title={t("workspacePane.edit")} onClick={() => onOpen("edit")}><Pencil size={13} /></button>}
          <button type="button" className={cn(iconButton, "size-7")} aria-label={`${t("workspacePane.keepOpen")}: ${entry.name}`} title={t("workspacePane.keepOpen")} onClick={() => onOpen("preview", true)}><Pin size={13} /></button>
        </>
      )}
    </li>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────

function TabStrip({ pane, dispatch, currentScope, labelForScope }: {
  pane: WorkspacePaneState; dispatch: WorkspacePaneDispatch; currentScope: WorkspaceScopeRef | null; labelForScope: (scope: WorkspaceScopeRef) => string;
}) {
  if (!pane.tabs.length) return null;
  return (
    <div role="tablist" aria-label={t("workspacePane.tabs")} data-testid="workspace-pane-tabs" className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline/40 px-2 py-1.5">
      {pane.tabs.map(tab => {
        const name = fileName(tab.relativePath);
        const activeTab = tab.id === pane.activeTabId;
        const foreign = !currentScope || tab.scope.botId !== currentScope.botId || tab.scope.threadId !== currentScope.threadId;
        const label = tab.dirty ? t("workspacePane.unsavedTab", { name }) : tab.mode === "preview" && !tab.pinned ? t("workspacePane.previewTab", { name }) : name;
        return (
          <div key={tab.id} data-testid="workspace-tab" data-tab-id={tab.id} data-dirty={tab.dirty || undefined} data-preview={tab.mode === "preview" && !tab.pinned ? "true" : undefined} className={cn("flex max-w-[220px] shrink-0 items-center rounded-md border text-[12.5px]", activeTab ? "border-hairline/60 bg-raised text-ink" : "border-transparent text-ink-secondary hover:bg-raised/60")}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab}
              aria-label={foreign ? `${label} — ${t("workspacePane.fromConversation", { scope: labelForScope(tab.scope) })}` : label}
              title={foreign ? `${tab.relativePath} — ${t("workspacePane.fromConversation", { scope: labelForScope(tab.scope) })}` : tab.relativePath}
              className={cn("flex min-w-0 items-center gap-1.5 px-2 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus", tab.mode === "preview" && !tab.pinned && "italic")}
              onClick={() => dispatch({ type: "activate", id: tab.id })}
            >
              {tab.mode === "edit" && <Pencil size={11} className="shrink-0" aria-hidden="true" />}
              <span className="truncate">{name}</span>
              {tab.dirty && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />}
            </button>
            <button type="button" className={cn(iconButton, "size-6")} aria-label={t("workspacePane.closeTab", { name })} onClick={() => dispatch({ type: "close", id: tab.id })}><X size={12} /></button>
          </div>
        );
      })}
    </div>
  );
}

// ── Document ─────────────────────────────────────────────────────────────

type Load =
  | { status: "loading" }
  | { status: "ready"; read: WorkspaceReadResult }
  | { status: "editor"; entry: EditorEntry; read: WorkspaceReadResult }
  | { status: "binary"; entry: WorkspaceEntry | null }
  | { status: "image"; url: string | null; entry: WorkspaceEntry | null }
  | { status: "error"; code: string | null; message: string };

const READ_ERROR_KEY: Record<string, LocaleKey> = {
  "too-large": "workspacePane.readError.tooLarge",
  "unsupported-encoding": "workspacePane.readError.encoding",
  "not-found": "workspacePane.readError.missing",
  "scope-unavailable": "workspacePane.readError.scope",
  "no-dedicated-workspace": "workspacePane.readError.scope",
  "remote-workspace": "workspacePane.readError.scope",
  "unavailable": "workspacePane.readError.scope",
};

export function readErrorMessage(code: string | null, name: string, message?: string): string {
  const key = code ? READ_ERROR_KEY[code] : undefined;
  if (key) return t(key);
  return message || t("workspacePane.readError", { name });
}

function WorkspaceDocument({ tab, api, dispatch, editorFor, editors, nativeAction, onOpenFiles, probeMs }: {
  tab: WorkspaceTab; api: ApiCall; dispatch: WorkspacePaneDispatch;
  editorFor: (tab: WorkspaceTab, read: WorkspaceReadResult) => EditorEntry;
  editors: { current: Map<string, EditorEntry> };
  nativeAction?: WorkspaceNativeAction; onOpenFiles?: (scope: WorkspaceScopeRef) => void; probeMs: number;
}) {
  const name = fileName(tab.relativePath);
  const kind = documentKindForPath(tab.relativePath);
  const identity = tabIdentity(tab);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [rendered, setRendered] = useState(true);
  const [copyName, setCopyName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  // Load, or adopt the editor this tab already has.
  useEffect(() => {
    const current = ++generation.current;
    const live = () => current === generation.current;
    const existing = editors.current.get(tab.id);
    if (tab.mode === "edit" && existing && existing.key === tabKey(tab)) {
      const state = existing.session.getState();
      setLoad({ status: "editor", entry: existing, read: { ...identity, revision: state.baseRevision, encoding: "utf-8", bom: state.bom, newline: state.newline, bytes: 0, modifiedAt: 0, content: state.savedContent } });
      return;
    }
    const controller = new AbortController();
    setLoad({ status: "loading" });
    void (async () => {
      if (kind === "binary" || kind === "image") {
        // No text read for these: the folder listing supplies the identity
        // that Open in app / Show in folder and the image route need.
        const probe = await probeWorkspaceRevision(api, identity.scope, identity.relativePath, controller.signal);
        if (!live()) return;
        const entry = probe.state === "found" && canSaveEntry(probe.entry) ? probe.entry : null;
        if (probe.state === "missing") setMissing(true);
        if (kind === "binary" || !entry?.revision) { setLoad(kind === "binary" ? { status: "binary", entry } : { status: "image", url: null, entry }); return; }
        try {
          const resolved = await api(MEDIA_ROUTES.resolve, { method: "POST", body: JSON.stringify({ ref: { source: "workspace", scope: identity.scope, relativePath: identity.relativePath, revision: entry.revision } }), signal: controller.signal }) as MediaResolveResponse;
          if (live()) setLoad({ status: "image", url: resolved.asset?.kind === "image" && resolved.asset.availability === "ready" && typeof resolved.url === "string" ? resolved.url : null, entry });
        } catch { if (live()) setLoad({ status: "image", url: null, entry }); }
        return;
      }
      try {
        const read = await readWorkspaceFile(api, identity.scope, identity.relativePath, controller.signal);
        if (!live()) return;
        setMissing(false);
        if (tab.mode === "edit" && kind === "markdown") setLoad({ status: "editor", entry: editorFor(tab, read), read });
        else setLoad({ status: "ready", read });
      } catch (reason) {
        if (!live() || controller.signal.aborted) return;
        const failure = saveFailureFrom(reason);
        setLoad({ status: "error", code: failure.code, message: readErrorMessage(failure.code, name, failure.message) });
      }
    })();
    return () => controller.abort();
    // The tab is keyed by id; mode and identity are what can change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.mode, tab.scope.botId, tab.scope.threadId, tab.relativePath]);

  // Notice external changes: probe the folder for the file's revision, and
  // only when it moved, read the file and hand it over. The session decides
  // between a quiet reload and a conflict; a preview simply shows the new text.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (load.status !== "ready" && load.status !== "editor") return;
    let stopped = false, inFlight = false;
    const probe = async () => {
      if (stopped || inFlight || typeof document !== "undefined" && document.hidden) return;
      inFlight = true;
      try {
        const current = loadRef.current;
        if (current.status !== "ready" && current.status !== "editor") return;
        const known = current.status === "editor" ? current.entry.session.getState().baseRevision : current.read.revision;
        const result = await probeWorkspaceRevision(api, identity.scope, identity.relativePath);
        if (stopped) return;
        if (result.state === "missing") { setMissing(true); return; }
        if (result.state !== "found" || !result.entry.revision) return;
        setMissing(false);
        if (result.entry.revision === known) return;
        const read = await readWorkspaceFile(api, identity.scope, identity.relativePath);
        if (stopped) return;
        const latest = loadRef.current;
        if (latest.status === "editor") {
          latest.entry.controller.observeDisk({ revision: read.revision, content: read.content, bom: read.bom, newline: read.newline });
        } else if (latest.status === "ready" && latest.read.revision !== read.revision) {
          setLoad({ status: "ready", read });
          setNotice(t("workspacePane.reloaded"));
        }
      } catch { /* a failed probe claims nothing; the next one asks again */ }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => { void probe(); }, probeMs);
    const onFocus = () => { void probe(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.status, tab.id, probeMs]);

  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); } catch (reason) { setError(reasonText(reason, t("workspacePane.actionError"))); } finally { setBusy(false); }
  };
  const read = load.status === "ready" || load.status === "editor" ? load.read : null;
  const currentText = () => (load.status === "editor" ? load.entry.session.getState().draft : read?.content ?? "");
  const currentBom = () => (load.status === "editor" ? load.entry.session.getState().bom : read?.bom ?? false);
  const diskRevision = load.status === "editor" ? load.entry.session.getState().baseRevision : read?.revision ?? null;
  const dirty = tab.dirty;
  const entryForVersion = (): WorkspaceEntry | null => diskRevision && read
    ? { name, relativePath: tab.relativePath, kind: "file", state: "local", bytes: read.bytes, modifiedAt: read.modifiedAt, revision: diskRevision }
    : null;

  const saveVersion = () => act(async () => {
    const entry = entryForVersion();
    if (!entry) return;
    const saved = await saveWorkspaceVersion(api, identity.scope, entry);
    setNotice(t("workspacePane.savedVersion", { name: saved.artifact.name }));
  });
  const saveCopy = (path: string) => act(async () => {
    const relativePath = path.trim();
    if (!isWorkspaceRelativePath(relativePath)) { setError(t("workspacePane.saveCopyInvalid")); return; }
    try {
      await writeWorkspaceFile(api, { scope: identity.scope, relativePath, baseRevision: null, requestId: globalThis.crypto?.randomUUID?.() ?? `copy-${Date.now()}`, content: currentText(), bom: currentBom() });
    } catch (reason) {
      if (saveFailureFrom(reason).code === "already-exists") { setError(t("workspacePane.saveCopyExists", { path: relativePath })); return; }
      throw reason;
    }
    setCopyName(null);
    setNotice(t("workspacePane.savedCopy", { path: relativePath }));
    dispatch({ type: "open", scope: identity.scope, relativePath, mode: "preview", pin: true });
  });
  const download = () => {
    const text = currentText();
    const blob = new Blob([currentBom() ? "﻿" + text : text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const native = (action: "open" | "reveal") => act(async () => {
    if (!nativeAction) return;
    const entry = entryForVersion() ?? ((load.status === "binary" || load.status === "image") ? load.entry : null);
    if (!entry) throw new Error(t("filesWorkspace.nativeUnavailable"));
    await nativeAction(identity.scope, entry, action);
  });

  const markdown = kind === "markdown";
  const canSaveCopy = markdown && (read !== null || load.status === "editor");
  return (
    <article data-testid="workspace-document" data-tab-id={tab.id} data-mode={tab.mode} aria-label={tab.relativePath} className="flex min-h-full flex-col gap-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-medium" title={tab.relativePath}>{tab.relativePath}</h3>
        {markdown && (
          <div role="group" aria-label={t("workspacePane.viewLabel")} className="inline-flex overflow-hidden rounded-lg border border-hairline/50 bg-control">
            <button type="button" className={cn("min-h-8 px-2.5 text-[12.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus", tab.mode === "preview" ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised-hover")} aria-pressed={tab.mode === "preview"} disabled={dirty} title={dirty ? t("markdownEditor.status.dirty") : undefined} onClick={() => dispatch({ type: "setMode", id: tab.id, mode: "preview" })}>{t("workspacePane.preview")}</button>
            <button type="button" data-testid="workspace-document-edit" className={cn("min-h-8 px-2.5 text-[12.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus", tab.mode === "edit" ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised-hover")} aria-pressed={tab.mode === "edit"} disabled={load.status === "error" || load.status === "loading"} onClick={() => dispatch({ type: "setMode", id: tab.id, mode: "edit" })}>{t("workspacePane.edit")}</button>
          </div>
        )}
        {!tab.pinned && tab.mode === "preview" && <button type="button" className={button} onClick={() => dispatch({ type: "pin", id: tab.id })}>{t("workspacePane.keepOpen")}</button>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {read && <button type="button" className={button} disabled={busy || dirty || !diskRevision} title={dirty ? t("markdownEditor.status.dirty") : t("workspacePane.workingFileNote")} onClick={() => void saveVersion()}>{t("workspacePane.saveVersion")}</button>}
        {canSaveCopy && <button type="button" className={button} disabled={busy} aria-expanded={copyName !== null} onClick={() => setCopyName(current => (current === null ? copyPath(tab.relativePath) : null))}>{t("workspacePane.saveCopy")}</button>}
        {(read || load.status === "editor") && <button type="button" className={button} disabled={busy} onClick={download}>{t("workspacePane.download")}</button>}
        {nativeAction && (load.status === "ready" || load.status === "editor" || ((load.status === "binary" || load.status === "image") && load.entry !== null)) && (
          <>
            <button type="button" data-native-action="open" className={button} disabled={busy} onClick={() => void native("open")}>{t("filesWorkspace.openInApp")}</button>
            <button type="button" data-native-action="reveal" className={button} disabled={busy} onClick={() => void native("reveal")}>{t("filesWorkspace.showInFolder")}</button>
          </>
        )}
        {onOpenFiles && <button type="button" className={button} onClick={() => onOpenFiles(identity.scope)}>{t("workspacePane.previewInFiles")}</button>}
      </div>
      {copyName !== null && (
        <form className="flex flex-wrap items-center gap-1.5" onSubmit={event => { event.preventDefault(); void saveCopy(copyName); }}>
          <label className="min-w-0 flex-1 text-[12px]">{t("workspacePane.saveCopyPrompt")}<input className={cn(field, "mt-1 w-full font-mono")} value={copyName} maxLength={2048} onChange={event => setCopyName(event.target.value)} /></label>
          <button className={button} disabled={busy || !copyName.trim()}>{t("workspacePane.saveCopy")}</button>
          <button type="button" className={button} onClick={() => setCopyName(null)}>{t("workspacePane.closeUnsaved.cancel")}</button>
        </form>
      )}
      {read && read.bytes > 0 && <p className="text-[11.5px] text-ink-secondary">{t("workspacePane.workingFile", { size: formatFileSize(read.bytes), modified: read.modifiedAt ? new Date(read.modifiedAt).toLocaleString() : "—" })} · {t("workspacePane.workingFileNote")}</p>}
      {notice && <p role="status" data-testid="workspace-document-notice" className="text-[12.5px] text-ink-secondary">{notice}</p>}
      {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
      {missing && <p role="alert" data-testid="workspace-document-missing" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px]">{t("workspacePane.missingOnDisk")}</p>}

      {load.status === "loading" && <p role="status" className="text-[12.5px] text-ink-secondary">{t("workspacePane.opening", { name })}</p>}
      {load.status === "error" && <p role="alert" data-testid="workspace-document-error" data-code={load.code ?? undefined} className="text-[13px] text-danger">{load.message}</p>}
      {load.status === "binary" && <p className="text-[13px] text-ink-secondary">{t("workspacePane.binary")}</p>}
      {load.status === "image" && (load.url
        ? <img src={load.url} alt={t("workspacePane.imageLabel", { name })} className="max-h-[70vh] max-w-full self-start rounded-lg border border-hairline/40 bg-inset object-contain" />
        : <p className="text-[13px] text-ink-secondary">{t("workspacePane.imageUnavailable")}</p>)}
      {load.status === "editor" && <MarkdownEditor controller={load.entry.controller} title={tab.relativePath} />}
      {load.status === "ready" && kind === "markdown" && (
        <>
          <div role="group" aria-label={t("workspacePane.viewLabel")} className="inline-flex self-start overflow-hidden rounded-lg border border-hairline/50 bg-control text-[12px]">
            <button type="button" className={cn("min-h-7 px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus", rendered ? "bg-raised text-ink" : "text-ink-secondary")} aria-pressed={rendered} onClick={() => setRendered(true)}>{t("workspacePane.rendered")}</button>
            <button type="button" className={cn("min-h-7 px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus", !rendered ? "bg-raised text-ink" : "text-ink-secondary")} aria-pressed={!rendered} onClick={() => setRendered(false)}>{t("workspacePane.source")}</button>
          </div>
          {rendered
            ? <div data-testid="workspace-markdown-preview" className="rounded-lg border border-hairline/40 bg-inset px-4 py-3 text-[14px]"><ChatMarkdown text={load.read.content} scope={identity.scope} /></div>
            : <pre data-testid="workspace-source-preview" className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px]">{load.read.content}</pre>}
        </>
      )}
      {load.status === "ready" && kind === "html" && (
        <>
          <p className="text-[12px] text-ink-secondary">{t("workspacePane.htmlNote")}</p>
          <iframe title={t("workspacePane.htmlFrame", { name })} sandbox="" referrerPolicy="no-referrer" srcDoc={artifactPreviewHtml(load.read.content)} className="h-[420px] w-full rounded-lg bg-white" />
        </>
      )}
      {load.status === "ready" && kind === "text" && (
        <pre data-testid="workspace-text-preview" className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px]">{load.read.content}</pre>
      )}
    </article>
  );
}
