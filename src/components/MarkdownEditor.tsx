// Workspace Markdown editor (F4-T4).
//
// The `.md` file on disk is canonical. This surface edits it through a
// DocumentSession (save state machine) and never writes by itself:
// - Rich mode uses the pinned Tiptap 3.31.3 editor with `contentType:
//   'markdown'`, and only when the fidelity gate proves the file round-trips
//   byte for byte. Everything else opens in Source mode, which edits the
//   exact text. Frontmatter, BOM, CRLF and surrounding blank lines are opaque
//   parts the rich editor never sees.
// - Programmatic reloads (external change, conflict reload, discard, draft
//   restore) call `setContent(..., { emitUpdate: false })`, so a refresh can
//   never look like an edit and can never trigger a save or a draft.
// - Opening, viewing, switching modes and closing write nothing. Only an
//   explicit Save sends a write, and only when the text differs from disk.
// - Unsaved text is preserved as a recoverable draft (IndexedDB, U-07),
//   labelled separately from "File saved", with a visible error when the
//   draft bound or browser storage refuses it. Drafts are cleared once the
//   document holds no unsaved text (saved, discarded or reloaded).
//
// F4-T3 mounts this inside the workspace pane and supplies the transport.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { FileRevision, SaveReceipt, WorkspaceReadResult, WorkspaceWriteRequest } from "../../shared/workspace-files";
import {
  acknowledgeSave,
  beginSave,
  closeDocument,
  discardDraft,
  editDocument,
  failSave,
  hasUnsavedChanges,
  observeExternalChange,
  resolveConflict,
  restoreDraft,
  saveFailureFrom,
  setDocumentMode,
  type ConflictChoice,
  type DocumentErrorCode,
  type DocumentSessionState,
  type DocumentSessionStore,
  type ObservedDiskState,
  type SaveRefusal,
} from "@/lib/document-session";
import {
  MARKDOWN_DRAFT_MAX_BYTES,
  MARKDOWN_DRAFT_MAX_COUNT,
  type MarkdownDraftErrorCode,
  type MarkdownDraftStore,
} from "@/lib/markdown-drafts";
import {
  MARKDOWN_RICH_EDIT_MAX_BYTES,
  analyzeMarkdownFidelity,
  composeMarkdownDocument,
  createMarkdownExtensions,
  type MarkdownDocumentParts,
  type MarkdownFidelityReason,
  type MarkdownFidelityReport,
} from "@/lib/markdown-fidelity";

export const MARKDOWN_DRAFT_DELAY_MS = 800;

export type DraftStatus = "idle" | "pending" | "preserved" | "failed";

export interface MarkdownEditorView {
  /** Why rich mode is unavailable for the current text; empty when it is. */
  richBlockedBy: MarkdownFidelityReason[];
  unsupportedSyntax: string[];
  draftStatus: DraftStatus;
  draftError: MarkdownDraftErrorCode | null;
  /** A preserved draft was restored into this session. */
  recoveredDraftAt: number | null;
  /** The last save attempt was refused before any request left. */
  saveRefused: SaveRefusal | null;
}

export interface MarkdownEditorSnapshot {
  session: DocumentSessionState;
  view: MarkdownEditorView;
}

export type ScheduleTimer = (callback: () => void, delayMs: number) => () => void;

export interface MarkdownEditorControllerOptions {
  session: DocumentSessionStore;
  /** POST WorkspaceWriteRequest; resolve a SaveReceipt or throw
   * (WorkspaceFileRequestError / error body / TypeError for network). */
  save: (request: WorkspaceWriteRequest) => Promise<SaveReceipt>;
  /** Fresh disk read, used when a rejected save must show the disk text. */
  readDisk?: () => Promise<WorkspaceReadResult>;
  drafts?: MarkdownDraftStore | null;
  createRequestId?: () => string;
  draftDelayMs?: number;
  schedule?: ScheduleTimer;
  /** `auto` opens rich only when the fidelity gate allows it. */
  initialMode?: "auto" | "source";
}

const defaultSchedule: ScheduleTimer = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

function defaultRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type SaveResult =
  | { status: "saved"; stillDirty: boolean }
  | { status: "refused"; refused: SaveRefusal }
  | { status: "failed"; code: DocumentErrorCode }
  | { status: "conflict" }
  | { status: "ignored" };

/** Framework-free coordinator between one DocumentSession, an optional
 * Tiptap editor and the draft store. React only renders its snapshot. */
export class MarkdownEditorController {
  private readonly options: MarkdownEditorControllerOptions;
  private readonly session: DocumentSessionStore;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeSession: () => void;
  private view: MarkdownEditorView = {
    richBlockedBy: [],
    unsupportedSyntax: [],
    draftStatus: "idle",
    draftError: null,
    recoveredDraftAt: null,
    saveRefused: null,
  };
  private snapshot: MarkdownEditorSnapshot;
  private editor: Editor | null = null;
  private detachEditorListener: (() => void) | null = null;
  /** Parts of the text currently loaded in the rich editor. */
  private richParts: MarkdownDocumentParts | null = null;
  /** The draft text the rich editor currently represents. */
  private editorDraft: string | null = null;
  private cancelDraftTimer: (() => void) | null = null;
  private scheduledDraftRevision: number | null = null;
  /** Draft revision last sent to the store (preserved or refused). */
  private attemptedDraftRevision: number | null = null;
  /** A draft for this document may be stored: one was requested or found.
   * Set when the request leaves, not when it lands, so a document that goes
   * clean while a preserve is in flight still clears it afterwards. */
  private draftMayExist = false;
  private disposed = false;

  constructor(options: MarkdownEditorControllerOptions) {
    this.options = options;
    this.session = options.session;
    this.snapshot = { session: this.session.getState(), view: this.view };
    if ((options.initialMode ?? "auto") === "auto") this.setMode("rich");
    else this.analyze(this.session.getState().draft);
    this.snapshot = { session: this.session.getState(), view: this.view };
    this.unsubscribeSession = this.session.subscribe(() => this.onSessionChange());
  }

  // ---- subscription -------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MarkdownEditorSnapshot => this.snapshot;

  private emit(): void {
    const session = this.session.getState();
    if (this.snapshot.session === session && this.snapshot.view === this.view) return;
    this.snapshot = { session, view: this.view };
    // Copy first: a listener may subscribe another listener while running.
    for (const listener of Array.from(this.listeners)) listener();
  }

  private setView(patch: Partial<MarkdownEditorView>): void {
    const next = { ...this.view, ...patch };
    const changed = (Object.keys(patch) as (keyof MarkdownEditorView)[]).some(key => next[key] !== this.view[key]);
    if (!changed) return;
    this.view = next;
    this.emit();
  }

  private onSessionChange(): void {
    // `syncEditor` may itself switch to Source mode, so read state after it.
    this.syncEditor();
    this.scheduleDraft(this.session.getState());
    this.emit();
  }

  // ---- rich editor --------------------------------------------------------

  /** The Markdown body the rich editor should load, or null in Source mode. */
  richBody(): string | null {
    const state = this.session.getState();
    if (state.mode !== "rich") return null;
    const report = this.analyze(state.draft);
    if (!report.richEditable || !report.parts) return null;
    this.richParts = report.parts;
    this.editorDraft = state.draft;
    return report.parts.body;
  }

  attachRichEditor(editor: Editor): void {
    if (this.editor === editor) return;
    this.detachRichEditor();
    this.editor = editor;
    const onUpdate = () => this.onRichUpdate(editor);
    // Destruction is tracked here, not read from `editor.isDestroyed`: that
    // getter is true for an editor that exists but is not mounted yet, and a
    // reload arriving in that window must still reach it.
    const onDestroy = () => this.detachRichEditor(editor);
    editor.on("update", onUpdate);
    editor.on("destroy", onDestroy);
    this.detachEditorListener = () => {
      editor.off("update", onUpdate);
      editor.off("destroy", onDestroy);
    };
    this.syncEditor();
  }

  detachRichEditor(editor?: Editor): void {
    if (editor && editor !== this.editor) return;
    this.detachEditorListener?.();
    this.detachEditorListener = null;
    this.editor = null;
  }

  private onRichUpdate(editor: Editor): void {
    if (editor !== this.editor || !this.richParts) return;
    const draft = composeMarkdownDocument(this.richParts, editor.getMarkdown());
    this.editorDraft = draft;
    this.session.update(state => (state.mode === "rich" ? editDocument(state, draft) : state));
  }

  /** Bring the rich editor in line with a draft it did not produce. */
  private syncEditor(): void {
    const state = this.session.getState();
    const editor = this.editor;
    if (!editor || state.mode !== "rich" || state.draft === this.editorDraft) return;
    const report = this.analyze(state.draft);
    if (!report.richEditable || !report.parts) {
      // The new text (a reload, a restored draft) cannot be edited richly
      // without changing it: continue in Source mode on the exact text.
      this.session.update(current => setDocumentMode(current, "source"));
      return;
    }
    this.richParts = report.parts;
    this.editorDraft = state.draft;
    editor.commands.setContent(report.parts.body, { emitUpdate: false, contentType: "markdown" });
  }

  private analyze(text: string): MarkdownFidelityReport {
    const report = analyzeMarkdownFidelity(text);
    this.setView({ richBlockedBy: report.reasons, unsupportedSyntax: report.unsupportedTokenClasses });
    return report;
  }

  // ---- user actions -------------------------------------------------------

  /** Returns false when rich mode is refused for the current text. */
  setMode(mode: "rich" | "source"): boolean {
    if (mode === "rich") {
      const report = this.analyze(this.session.getState().draft);
      if (!report.richEditable) {
        this.session.update(current => setDocumentMode(current, "source"));
        return false;
      }
      // The next rich surface loads the current draft via `richBody()`.
      this.editorDraft = null;
    }
    this.session.update(current => setDocumentMode(current, mode));
    return true;
  }

  editSource(text: string): void {
    this.session.update(state => (state.mode === "source" ? editDocument(state, text) : state));
  }

  async save(): Promise<SaveResult> {
    const requestId = (this.options.createRequestId ?? defaultRequestId)();
    // Each transition is computed from the current state and applied in the
    // same synchronous step, so nothing can interleave between them.
    const begun = beginSave(this.session.getState(), requestId);
    if (!begun.ok) {
      this.setView({ saveRefused: begun.refused });
      return { status: "refused", refused: begun.refused };
    }
    this.session.update(() => begun.state);
    this.setView({ saveRefused: null });
    let receipt: SaveReceipt;
    try {
      receipt = await this.options.save(begun.request);
    } catch (error) {
      const failure = saveFailureFrom(error);
      const settled = failSave(this.session.getState(), requestId, failure);
      this.session.update(() => settled.state);
      if (settled.outcome === "conflict") {
        void this.loadDiskForConflict();
        return { status: "conflict" };
      }
      return settled.outcome === "failed" ? { status: "failed", code: failure.code } : { status: "ignored" };
    }
    const acknowledged = acknowledgeSave(this.session.getState(), receipt);
    this.session.update(() => acknowledged.state);
    if (acknowledged.outcome !== "saved") return { status: "ignored" };
    return { status: "saved", stillDirty: hasUnsavedChanges(this.session.getState()) };
  }

  /** A newer disk state was observed (watch event followed by a read). */
  observeDisk(disk: ObservedDiskState): void {
    this.session.update(state => observeExternalChange(state, disk).state);
  }

  /** Returns true once no conflict remains. */
  async resolveConflict(choice: ConflictChoice): Promise<boolean> {
    let result = resolveConflict(this.session.getState(), choice);
    if (!result.ok && result.refused === "needs-disk-read") {
      await this.loadDiskForConflict();
      // Reading the disk can settle the conflict by itself (it already holds
      // exactly this draft); otherwise it supplies the text to choose from.
      if (!this.session.getState().conflict) return true;
      result = resolveConflict(this.session.getState(), choice);
    }
    if (!result.ok) return result.refused === "no-conflict";
    const next = result.state;
    this.session.update(() => next);
    return true;
  }

  discard(): boolean {
    const discarded = discardDraft(this.session.getState());
    this.session.update(() => discarded.state);
    return discarded.ok;
  }

  /** Offer a preserved draft for this document, if one exists. */
  async restoreDraft(): Promise<boolean> {
    const drafts = this.options.drafts;
    if (!drafts || this.disposed) return false;
    const loaded = await drafts.load(this.session.getState().identity);
    if (this.disposed) return false;
    if (!loaded.ok) {
      this.setView({ draftStatus: "failed", draftError: loaded.code });
      return false;
    }
    const record = loaded.record;
    if (!record) return false;
    this.draftMayExist = true;
    const result = restoreDraft(this.session.getState(), {
      baseRevision: record.baseRevision as FileRevision,
      content: record.content,
      draftRevision: record.draftRevision,
      ...(record.mode ? { mode: record.mode } : {}),
    });
    if (!result.restored) {
      // A stored draft equal to the file holds nothing to recover.
      if (!hasUnsavedChanges(this.session.getState())) void this.clearDraft();
      return false;
    }
    // The restored text is what the store already holds.
    this.attemptedDraftRevision = result.state.draftRevision;
    this.view = { ...this.view, recoveredDraftAt: record.updatedAt, draftStatus: "preserved", draftError: null };
    this.session.update(() => result.state);
    this.emit();
    return true;
  }

  /** Flush a pending draft, stop listening and refuse further edits. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const flush = this.cancelDraftTimer ? this.preserveDraft() : Promise.resolve();
    this.cancelDraftTimer?.();
    this.cancelDraftTimer = null;
    this.detachRichEditor();
    this.unsubscribeSession();
    this.session.update(closeDocument);
    this.listeners.clear();
    await flush;
  }

  // ---- drafts -------------------------------------------------------------

  private scheduleDraft(state: DocumentSessionState): void {
    if (!this.options.drafts || this.disposed) return;
    if (!hasUnsavedChanges(state)) {
      this.cancelDraftTimer?.();
      this.cancelDraftTimer = null;
      this.scheduledDraftRevision = null;
      // Whatever was preserved or requested for this document is obsolete.
      if (this.draftMayExist) void this.clearDraft(state.draftRevision);
      else if (this.view.draftStatus === "pending") this.setView({ draftStatus: "idle" });
      return;
    }
    if (this.attemptedDraftRevision === state.draftRevision) return;
    if (this.cancelDraftTimer && this.scheduledDraftRevision === state.draftRevision) return;
    this.cancelDraftTimer?.();
    this.scheduledDraftRevision = state.draftRevision;
    this.setView({ draftStatus: "pending" });
    this.cancelDraftTimer = (this.options.schedule ?? defaultSchedule)(() => {
      this.cancelDraftTimer = null;
      this.scheduledDraftRevision = null;
      void this.preserveDraft();
    }, this.options.draftDelayMs ?? MARKDOWN_DRAFT_DELAY_MS);
  }

  private async preserveDraft(): Promise<void> {
    const drafts = this.options.drafts;
    const state = this.session.getState();
    if (!drafts || !hasUnsavedChanges(state)) return;
    this.attemptedDraftRevision = state.draftRevision;
    this.draftMayExist = true;
    const result = await drafts.preserve(state.identity, {
      baseRevision: state.baseRevision,
      content: state.draft,
      draftRevision: state.draftRevision,
      mode: state.mode,
    });
    if (this.disposed) return;
    const current = this.session.getState();
    // Report only on text that is still unsaved; a newer revision has its
    // own pending preserve, and a clean document has already been cleared.
    if (!hasUnsavedChanges(current)) return;
    if (!result.ok) {
      this.setView({ draftStatus: "failed", draftError: result.code });
    } else if (current.draftRevision === result.record.draftRevision) {
      this.setView({ draftStatus: "preserved", draftError: null });
    } else {
      this.setView({ draftError: null });
    }
  }

  private async clearDraft(upToDraftRevision?: number): Promise<void> {
    const drafts = this.options.drafts;
    if (!drafts) return;
    this.draftMayExist = false;
    this.attemptedDraftRevision = null;
    const result = await drafts.clear(this.session.getState().identity, upToDraftRevision === undefined ? {} : { upToDraftRevision });
    if (this.disposed) return;
    if (!result.ok) this.setView({ draftStatus: "failed", draftError: result.code });
    else if (!hasUnsavedChanges(this.session.getState())) this.setView({ draftStatus: "idle", draftError: null, recoveredDraftAt: null });
  }

  private async loadDiskForConflict(): Promise<void> {
    const readDisk = this.options.readDisk;
    if (!readDisk || this.disposed) return;
    try {
      const read = await readDisk();
      if (this.disposed) return;
      this.observeDisk({ revision: read.revision, content: read.content, bom: read.bom, newline: read.newline });
    } catch {
      // The conflict stays visible with `disk: null`; the choice waits for a
      // successful read rather than guessing the disk text.
    }
  }
}

/** Create one controller per mounted document and dispose it on unmount.
 * Disposal is deferred one task so a StrictMode unmount/remount of the same
 * component does not close the document it is about to show again. */
export function useMarkdownEditorController(options: MarkdownEditorControllerOptions): MarkdownEditorController {
  const [controller] = useState(() => new MarkdownEditorController(options));
  const cancelDispose = useRef<(() => void) | null>(null);
  useEffect(() => {
    cancelDispose.current?.();
    cancelDispose.current = null;
    void controller.restoreDraft();
    return () => {
      const handle = setTimeout(() => { void controller.dispose(); }, 0);
      cancelDispose.current = () => clearTimeout(handle);
    };
  }, [controller]);
  return controller;
}

// ---- presentation -----------------------------------------------------------

const button = "min-h-9 rounded-lg border border-hairline/50 bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";
const segment = "min-h-9 px-3 py-1.5 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";

const RICH_OFF_KEY: Record<MarkdownFidelityReason, LocaleKey> = {
  "too-large": "markdownEditor.richOff.tooLarge",
  "mixed-newlines": "markdownEditor.richOff.mixedNewlines",
  "unsupported-syntax": "markdownEditor.richOff.unsupportedSyntax",
  "round-trip-changed": "markdownEditor.richOff.roundTripChanged",
  "parse-failed": "markdownEditor.richOff.parseFailed",
};

const DRAFT_ERROR_KEY: Record<MarkdownDraftErrorCode, LocaleKey> = {
  "draft-count-exceeded": "markdownEditor.draftError.countExceeded",
  "draft-bytes-exceeded": "markdownEditor.draftError.bytesExceeded",
  "storage-quota": "markdownEditor.draftError.storageQuota",
  "storage-unavailable": "markdownEditor.draftError.storageUnavailable",
};

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

export function richOffMessage(view: MarkdownEditorView): string | null {
  const reason = view.richBlockedBy[0];
  if (!reason) return null;
  return t(RICH_OFF_KEY[reason], { size: formatSize(MARKDOWN_RICH_EDIT_MAX_BYTES), syntax: view.unsupportedSyntax.join(", ") });
}

export function draftErrorMessage(code: MarkdownDraftErrorCode): string {
  return t(DRAFT_ERROR_KEY[code], { count: MARKDOWN_DRAFT_MAX_COUNT, size: formatSize(MARKDOWN_DRAFT_MAX_BYTES) });
}

export function saveErrorMessage(code: DocumentErrorCode, message?: string): string {
  switch (code) {
    case "bot-writing": return t("markdownEditor.saveError.botWriting");
    case "too-large": return t("markdownEditor.saveError.tooLarge");
    case "not-found": return t("markdownEditor.saveError.notFound");
    case "network": return t("markdownEditor.saveError.network");
    case "quota-exceeded": return t("markdownEditor.saveError.diskFull");
    default: return message ? t("markdownEditor.saveError.withDetail", { detail: message }) : t("markdownEditor.saveError.generic");
  }
}

/** File state only. "Draft preserved" is a separate line, never this one. */
export function fileStatusMessage(session: DocumentSessionState): string {
  switch (session.status) {
    case "saving": return t("markdownEditor.status.saving");
    case "dirty": return t("markdownEditor.status.dirty");
    case "conflict": return t("markdownEditor.status.conflict");
    case "error": return t("markdownEditor.status.notSaved");
    default: return session.lastSave ? t("markdownEditor.status.saved") : t("markdownEditor.status.clean");
  }
}

export function draftStatusMessage(view: MarkdownEditorView): string | null {
  if (view.draftStatus !== "preserved") return null;
  return view.recoveredDraftAt !== null ? t("markdownEditor.draft.recovered") : t("markdownEditor.draft.preserved");
}

function RichSurface({ controller, documentKey, readOnly }: { controller: MarkdownEditorController; documentKey: string; readOnly: boolean }) {
  // Computed once per mount: later changes arrive through the controller as
  // `setContent(..., { emitUpdate: false })`, never by recreating the editor.
  const initialBody = useMemo(() => controller.richBody() ?? "", [controller, documentKey]);
  const editor = useEditor({
    immediatelyRender: typeof window !== "undefined",
    extensions: createMarkdownExtensions(),
    content: initialBody,
    contentType: "markdown",
    injectCSS: false,
    editable: !readOnly,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t("markdownEditor.richLabel"),
        class: "min-h-64 px-4 py-3 text-[14px] leading-relaxed text-ink outline-none",
      },
    },
    onCreate: ({ editor: created }) => controller.attachRichEditor(created),
  }, [controller, documentKey]);
  // `editor.isDestroyed` is also true before EditorContent mounts the view,
  // so it is not a usable guard here; the controller tracks `destroy` itself.
  useEffect(() => {
    if (editor) controller.attachRichEditor(editor);
    return () => { if (editor) controller.detachRichEditor(editor); };
  }, [controller, editor]);
  useEffect(() => {
    // `setEditable(value, false)` does not emit an update, so it is not an edit.
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);
  return (
    <EditorContent
      editor={editor}
      className={[
        "min-h-64 rounded-lg border border-hairline/50 bg-inset",
        "[&_h1]:mb-3 [&_h1]:text-[22px] [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-[18px] [&_h2]:font-semibold",
        "[&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-[15px] [&_h3]:font-semibold [&_p]:my-2",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6",
        "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-1 [&_li[data-checked]]:flex [&_li[data-checked]]:gap-2",
        "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-hairline [&_blockquote]:pl-3 [&_blockquote]:text-ink-secondary",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-panel [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[12.5px]",
        "[&_code]:font-mono [&_a]:text-accent-text [&_a]:underline [&_hr]:my-4 [&_hr]:border-hairline",
      ].join(" ")}
    />
  );
}

export function MarkdownEditor({ controller, title }: { controller: MarkdownEditorController; title?: string }) {
  const { session, view } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [comparing, setComparing] = useState(false);
  const busy = session.status === "saving";
  const readOnly = session.closed;
  const unsaved = hasUnsavedChanges(session);
  const richOff = richOffMessage(view);
  const draftMessage = draftStatusMessage(view);
  const conflict = session.conflict;
  const documentKey = `${session.identity.scope.botId}/${session.identity.scope.threadId}/${session.identity.relativePath}`;
  const actionsDisabled = !unsaved || busy || readOnly || conflict !== null;

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={title ?? session.identity.relativePath}>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t("markdownEditor.modeLabel")} className="inline-flex overflow-hidden rounded-lg border border-hairline/50 bg-control">
          <button
            type="button"
            className={`${segment} ${session.mode === "rich" ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised-hover"}`}
            aria-pressed={session.mode === "rich"}
            disabled={richOff !== null || busy}
            title={richOff ?? undefined}
            onClick={() => controller.setMode("rich")}
          >
            {t("markdownEditor.modeRich")}
          </button>
          <button
            type="button"
            className={`${segment} ${session.mode === "source" ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised-hover"}`}
            aria-pressed={session.mode === "source"}
            onClick={() => controller.setMode("source")}
          >
            {t("markdownEditor.modeSource")}
          </button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className={button} disabled={actionsDisabled} onClick={() => controller.discard()}>
            {t("markdownEditor.discard")}
          </button>
          <button type="button" className={button} disabled={actionsDisabled} onClick={() => { void controller.save(); }}>
            {busy ? t("markdownEditor.saving") : t("markdownEditor.save")}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-secondary">
        <span role="status" aria-live="polite" data-testid="markdown-file-status">{fileStatusMessage(session)}</span>
        {draftMessage ? <span role="status" aria-live="polite" data-testid="markdown-draft-status">{draftMessage}</span> : null}
      </div>

      {richOff && session.mode === "source" ? (
        <p className="text-[12px] text-ink-secondary" data-testid="markdown-rich-off">{richOff}</p>
      ) : null}

      {view.draftError ? (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger" data-testid="markdown-draft-error">
          {draftErrorMessage(view.draftError)}
        </p>
      ) : null}

      {session.error ? (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger" data-testid="markdown-save-error">
          {saveErrorMessage(session.error.code, session.error.message)}
        </p>
      ) : null}

      {conflict ? (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] text-ink" data-testid="markdown-conflict">
          <p className="font-medium">{conflict.source === "draft-restore" ? t("markdownEditor.conflict.draftTitle") : t("markdownEditor.conflict.title")}</p>
          <p className="text-ink-secondary">{t("markdownEditor.conflict.body")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => { void controller.resolveConflict("reload"); }}>
              {t("markdownEditor.conflict.useDisk")}
            </button>
            <button type="button" className={button} onClick={() => { void controller.resolveConflict("keep-mine"); }}>
              {t("markdownEditor.conflict.keepMine")}
            </button>
            {conflict.disk ? (
              <button type="button" className={button} aria-expanded={comparing} onClick={() => setComparing(open => !open)}>
                {t("markdownEditor.conflict.compare")}
              </button>
            ) : null}
          </div>
          {comparing && conflict.disk ? (
            <div className="grid min-w-0 gap-2 md:grid-cols-2">
              <figure className="min-w-0">
                <figcaption className="mb-1 text-[12px] text-ink-secondary">{t("markdownEditor.conflict.mine")}</figcaption>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-inset p-2 font-mono text-[12px]">{session.draft}</pre>
              </figure>
              <figure className="min-w-0">
                <figcaption className="mb-1 text-[12px] text-ink-secondary">{t("markdownEditor.conflict.disk")}</figcaption>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-inset p-2 font-mono text-[12px]">{conflict.disk.content}</pre>
              </figure>
            </div>
          ) : null}
        </div>
      ) : null}

      {session.mode === "rich" ? (
        <RichSurface controller={controller} documentKey={documentKey} readOnly={readOnly} />
      ) : (
        <textarea
          aria-label={t("markdownEditor.sourceLabel")}
          className="min-h-64 w-full resize-y rounded-lg border border-hairline/50 bg-inset px-3 py-2 font-mono text-[13px] leading-relaxed text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          spellCheck={false}
          readOnly={readOnly}
          value={session.draft}
          onChange={event => controller.editSource(event.target.value)}
        />
      )}
    </section>
  );
}
