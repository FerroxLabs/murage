// DocumentSession: the save state machine for one workspace Markdown file
// (F4-T2, workspace editor design "Save state machine").
//
//   clean -> dirty -> saving(draftRevision, baseRevision, requestId)
//         -> clean | dirty | conflict | error
//
// Rules this module enforces, so no UI can get them wrong:
// - The submitted draft, its draft revision, the base revision and the file
//   identity are captured before the save request leaves. A receipt settles
//   only the request it names (requestId + identity + draft revision); a late
//   receipt for another tab, another file or an older request is ignored.
// - An acknowledgement advances the saved base to the submitted draft only.
//   Typing that continued during the request stays dirty.
// - A failed save never marks anything saved and never discards the draft.
// - An external change while clean reloads (the editor must apply it without
//   emitting an edit). While dirty or saving it becomes a conflict that keeps
//   both the local draft and the disk revision. There is no last-writer-wins:
//   overwriting requires an explicit "keep mine" choice.
// - Viewing never writes: nothing here produces a write request unless the
//   draft differs from the disk content it is based on.
//
// The module is pure (state in, state out) plus a tiny subscribable store.
import {
  WORKSPACE_TEXT_MAX_BYTES,
  isWorkspaceFileErrorCode,
  type FileRevision,
  type SaveReceipt,
  type WorkspaceFileErrorCode,
  type WorkspaceNewline,
  type WorkspaceReadResult,
  type WorkspaceScopeRef,
  type WorkspaceWriteRequest,
} from "../../shared/workspace-files";

export type DocumentMode = "rich" | "source";
export type DocumentSaveStatus = "clean" | "dirty" | "saving" | "conflict" | "error";

export interface DocumentIdentity {
  scope: WorkspaceScopeRef;
  relativePath: string;
}

/** Stable key for one file in one scope (drafts, tab maps). */
export function documentKey(identity: DocumentIdentity): string {
  return JSON.stringify([identity.scope.botId, identity.scope.threadId, identity.relativePath]);
}

export function sameDocumentIdentity(a: DocumentIdentity, b: DocumentIdentity): boolean {
  return a.scope.botId === b.scope.botId && a.scope.threadId === b.scope.threadId && a.relativePath === b.relativePath;
}

export interface PendingSave {
  requestId: string;
  draftRevision: number;
  baseRevision: FileRevision;
  content: string;
  bom: boolean;
}

/** A disk state observed from outside this session (watch + read). */
export interface ObservedDiskState {
  revision: FileRevision;
  content: string;
  bom: boolean;
  newline?: WorkspaceNewline;
}

export interface DocumentConflict {
  source: "external-change" | "save-rejected" | "draft-restore";
  /** Revision now on disk; `null` when the server did not report one. */
  currentRevision: FileRevision | null;
  /** Disk content at `currentRevision`, once read. Required to resolve. */
  disk: ObservedDiskState | null;
}

export type DocumentErrorCode = WorkspaceFileErrorCode | "network" | "unknown";

export interface DocumentError {
  code: DocumentErrorCode;
  message?: string;
  /** The same save may succeed if tried again later. */
  retryable: boolean;
}

export interface LastSave {
  requestId: string;
  revision: FileRevision;
  draftRevision: number;
  savedAt: number;
  artifactId?: string;
}

export interface DocumentSessionState {
  identity: DocumentIdentity;
  closed: boolean;
  mode: DocumentMode;
  /** Disk revision the draft is based on. */
  baseRevision: FileRevision;
  /** Disk text at `baseRevision` (BOM removed). */
  savedContent: string;
  bom: boolean;
  newline: WorkspaceNewline;
  draft: string;
  /** Increments on every draft change, including programmatic reloads. */
  draftRevision: number;
  /** Draft revision whose content equals `savedContent`. */
  savedDraftRevision: number;
  status: DocumentSaveStatus;
  saving: PendingSave | null;
  /** An external change seen while a save was in flight; settled after it. */
  pendingExternal: ObservedDiskState | null;
  conflict: DocumentConflict | null;
  error: DocumentError | null;
  lastSave: LastSave | null;
}

/** What the editor surface must do after a transition. `reload` means: show
 * `state.draft` without emitting an edit (Tiptap `emitUpdate: false`). */
export type DocumentEffect = "none" | "reload" | "conflict" | "deferred";

export interface Transition {
  state: DocumentSessionState;
  effect: DocumentEffect;
}

function derive(state: DocumentSessionState): DocumentSessionState {
  const status: DocumentSaveStatus = state.conflict
    ? "conflict"
    : state.saving
      ? "saving"
      : state.error
        ? "error"
        // The session always writes back the BOM it read, so the BOM is never
        // an edit: text alone decides clean versus dirty.
        : state.draft === state.savedContent
          ? "clean"
          : "dirty";
  return status === state.status ? state : { ...state, status };
}

/** True when the draft differs from the disk text it is based on, whatever
 * else is happening (a dirty tab is never replaced or closed silently). */
export function hasUnsavedChanges(state: DocumentSessionState): boolean {
  return state.draft !== state.savedContent;
}

export function openDocumentSession(read: WorkspaceReadResult, options: { mode?: DocumentMode } = {}): DocumentSessionState {
  return derive({
    identity: { scope: { botId: read.scope.botId, threadId: read.scope.threadId }, relativePath: read.relativePath },
    closed: false,
    mode: options.mode ?? "source",
    baseRevision: read.revision,
    savedContent: read.content,
    bom: read.bom,
    newline: read.newline,
    draft: read.content,
    draftRevision: 0,
    savedDraftRevision: 0,
    status: "clean",
    saving: null,
    pendingExternal: null,
    conflict: null,
    error: null,
    lastSave: null,
  });
}

/** A user edit. Identical content is not a new revision. */
export function editDocument(state: DocumentSessionState, content: string): DocumentSessionState {
  if (state.closed || content === state.draft) return state;
  return derive({ ...state, draft: content, draftRevision: state.draftRevision + 1 });
}

export function setDocumentMode(state: DocumentSessionState, mode: DocumentMode): DocumentSessionState {
  return state.mode === mode ? state : { ...state, mode };
}

export type SaveRefusal = "closed" | "in-flight" | "conflict" | "unchanged" | "too-large";

export type BeginSaveResult =
  | { ok: true; state: DocumentSessionState; request: WorkspaceWriteRequest }
  | { ok: false; state: DocumentSessionState; refused: SaveRefusal };

/** Capture everything the acknowledgement will be checked against. */
export function beginSave(state: DocumentSessionState, requestId: string): BeginSaveResult {
  const refused: SaveRefusal | null = state.closed
    ? "closed"
    : state.saving
      ? "in-flight"
      : state.conflict
        ? "conflict"
        : !hasUnsavedChanges(state)
          ? "unchanged"
          : new TextEncoder().encode(state.draft).byteLength + (state.bom ? 3 : 0) > WORKSPACE_TEXT_MAX_BYTES
            ? "too-large"
            : null;
  if (refused) return { ok: false, state, refused };
  const saving: PendingSave = {
    requestId,
    draftRevision: state.draftRevision,
    baseRevision: state.baseRevision,
    content: state.draft,
    bom: state.bom,
  };
  const request: WorkspaceWriteRequest = {
    scope: { ...state.identity.scope },
    relativePath: state.identity.relativePath,
    baseRevision: saving.baseRevision,
    requestId,
    content: saving.content,
    bom: saving.bom,
    draftRevision: saving.draftRevision,
  };
  return { ok: true, state: derive({ ...state, saving, error: null }), request };
}

export type AcknowledgeOutcome = "saved" | "ignored";

/** Settle a successful write. Only the exact pending request is accepted. */
export function acknowledgeSave(state: DocumentSessionState, receipt: SaveReceipt): Transition & { outcome: AcknowledgeOutcome } {
  const pending = state.saving;
  if (
    !pending
    || receipt.requestId !== pending.requestId
    || !sameDocumentIdentity(receipt, state.identity)
    || (receipt.draftRevision !== undefined && receipt.draftRevision !== pending.draftRevision)
  ) {
    return { state, effect: "none", outcome: "ignored" };
  }
  // Watch reads are not ordered. One that saw the revision this write
  // replaced (or the write itself) is older news than the receipt; applying
  // it after the receipt would reload the pre-save text over the saved one.
  const observed = state.pendingExternal;
  const external = observed
    && observed.revision !== pending.baseRevision
    && observed.revision !== receipt.previousRevision
    && observed.revision !== receipt.revision
    ? observed
    : null;
  const next = derive({
    ...state,
    baseRevision: receipt.revision,
    savedContent: pending.content,
    bom: pending.bom,
    savedDraftRevision: pending.draftRevision,
    saving: null,
    pendingExternal: null,
    error: null,
    lastSave: {
      requestId: pending.requestId,
      revision: receipt.revision,
      draftRevision: pending.draftRevision,
      savedAt: receipt.savedAt,
      ...(receipt.artifactId ? { artifactId: receipt.artifactId } : {}),
    },
  });
  // A change observed during the request that is not this write happened
  // after it: settle it against the new base.
  if (external) {
    const settled = observeExternalChange(next, external);
    return { ...settled, outcome: "saved" };
  }
  return { state: next, effect: "none", outcome: "saved" };
}

export interface SaveFailure {
  code: DocumentErrorCode;
  message?: string;
  /** From a `revision-conflict` response body. */
  currentRevision?: FileRevision;
}

const RETRYABLE = new Set<DocumentErrorCode>(["bot-writing", "write-failed", "quota-exceeded", "network", "unknown"]);

export type FailOutcome = "failed" | "conflict" | "ignored";

/** Settle a failed write. The draft is always retained. */
export function failSave(state: DocumentSessionState, requestId: string, failure: SaveFailure): Transition & { outcome: FailOutcome } {
  const pending = state.saving;
  if (!pending || pending.requestId !== requestId) return { state, effect: "none", outcome: "ignored" };
  const external = state.pendingExternal;
  const cleared = { ...state, saving: null, pendingExternal: null };
  if (failure.code === "revision-conflict" || failure.code === "already-exists") {
    const currentRevision = failure.currentRevision ?? external?.revision ?? null;
    const disk = external && (currentRevision === null || external.revision === currentRevision) ? external : null;
    return {
      state: derive({ ...cleared, error: null, conflict: { source: "save-rejected", currentRevision: disk?.revision ?? currentRevision, disk } }),
      effect: "conflict",
      outcome: "conflict",
    };
  }
  let next = derive({
    ...cleared,
    error: { code: failure.code, ...(failure.message ? { message: failure.message } : {}), retryable: RETRYABLE.has(failure.code) },
  });
  if (external) {
    const settled = observeExternalChange(next, external);
    next = settled.state;
    if (settled.effect !== "none") return { state: next, effect: settled.effect, outcome: "failed" };
  }
  return { state: next, effect: "none", outcome: "failed" };
}

/** A newer disk state was observed (file watch followed by a read). */
export function observeExternalChange(state: DocumentSessionState, disk: ObservedDiskState): Transition {
  if (state.closed) return { state, effect: "none" };
  if (state.saving) {
    // It may be this very write landing before its receipt; decide after.
    return { state: { ...state, pendingExternal: disk }, effect: "deferred" };
  }
  if (disk.revision === state.baseRevision && !state.conflict) return { state, effect: "none" };
  // Disk already holds exactly this draft (an unknown-outcome save that did
  // commit, or the same edit made elsewhere): adopt it, nothing to resolve.
  if (disk.content === state.draft && disk.bom === state.bom) {
    return {
      state: derive({
        ...state,
        baseRevision: disk.revision,
        savedContent: disk.content,
        savedDraftRevision: state.draftRevision,
        newline: disk.newline ?? state.newline,
        conflict: null,
        error: null,
      }),
      effect: "none",
    };
  }
  if (!state.conflict && !hasUnsavedChanges(state)) {
    const draftRevision = state.draftRevision + 1;
    return {
      state: derive({
        ...state,
        baseRevision: disk.revision,
        savedContent: disk.content,
        bom: disk.bom,
        newline: disk.newline ?? state.newline,
        draft: disk.content,
        draftRevision,
        savedDraftRevision: draftRevision,
        error: null,
      }),
      effect: "reload",
    };
  }
  if (disk.revision === state.baseRevision) return { state, effect: "none" };
  const source = state.conflict?.source ?? "external-change";
  return {
    state: derive({ ...state, conflict: { source, currentRevision: disk.revision, disk } }),
    effect: "conflict",
  };
}

export type ConflictChoice = "reload" | "keep-mine";
export type ResolveResult =
  | (Transition & { ok: true })
  | { ok: false; state: DocumentSessionState; refused: "no-conflict" | "needs-disk-read" };

/** Explicit resolution. `reload` discards the draft for the disk version.
 * `keep-mine` rebases the draft onto the disk revision; it stays dirty and
 * the next save is conditioned on that revision. */
export function resolveConflict(state: DocumentSessionState, choice: ConflictChoice): ResolveResult {
  const conflict = state.conflict;
  if (!conflict) return { ok: false, state, refused: "no-conflict" };
  const disk = conflict.disk;
  if (!disk) return { ok: false, state, refused: "needs-disk-read" };
  if (choice === "reload") {
    const draftRevision = state.draftRevision + 1;
    return {
      ok: true,
      effect: "reload",
      state: derive({
        ...state,
        conflict: null,
        error: null,
        baseRevision: disk.revision,
        savedContent: disk.content,
        bom: disk.bom,
        newline: disk.newline ?? state.newline,
        draft: disk.content,
        draftRevision,
        savedDraftRevision: draftRevision,
      }),
    };
  }
  return {
    ok: true,
    effect: "none",
    state: derive({
      ...state,
      conflict: null,
      error: null,
      baseRevision: disk.revision,
      savedContent: disk.content,
      newline: disk.newline ?? state.newline,
    }),
  };
}

/** Throw away the draft and show the disk text again. */
export function discardDraft(state: DocumentSessionState): Transition & { ok: boolean } {
  if (state.closed || state.saving || state.conflict) return { state, effect: "none", ok: false };
  if (!hasUnsavedChanges(state)) return { state: derive({ ...state, error: null }), effect: "none", ok: true };
  const draftRevision = state.draftRevision + 1;
  return {
    ok: true,
    effect: "reload",
    state: derive({ ...state, draft: state.savedContent, draftRevision, savedDraftRevision: draftRevision, error: null }),
  };
}

export interface RecoverableDraft {
  baseRevision: FileRevision;
  content: string;
  draftRevision: number;
  mode?: DocumentMode;
}

/** Bring back a preserved draft after a crash or restart. A draft based on
 * an older revision is restored as a conflict: both versions stay visible. */
export function restoreDraft(state: DocumentSessionState, draft: RecoverableDraft): Transition & { restored: boolean } {
  if (state.closed || state.saving || state.conflict || hasUnsavedChanges(state)) return { state, effect: "none", restored: false };
  if (draft.content === state.savedContent) return { state, effect: "none", restored: false };
  const draftRevision = Math.max(state.draftRevision, draft.draftRevision) + 1;
  const base = { ...state, draft: draft.content, draftRevision, ...(draft.mode ? { mode: draft.mode } : {}) };
  if (draft.baseRevision === state.baseRevision) {
    return { state: derive(base), effect: "reload", restored: true };
  }
  return {
    state: derive({
      ...base,
      conflict: {
        source: "draft-restore",
        currentRevision: state.baseRevision,
        disk: { revision: state.baseRevision, content: state.savedContent, bom: state.bom, newline: state.newline },
      },
    }),
    effect: "reload",
    restored: true,
  };
}

/** Closing keeps settling the pending save (so a preserved draft can be
 * cleared) but refuses any further edit or save. */
export function closeDocument(state: DocumentSessionState): DocumentSessionState {
  return state.closed ? state : { ...state, closed: true };
}

/** Exclusive-create request for Save a copy. It does not settle this session. */
export function saveCopyRequest(state: DocumentSessionState, relativePath: string, requestId: string): WorkspaceWriteRequest {
  return {
    scope: { ...state.identity.scope },
    relativePath,
    baseRevision: null,
    requestId,
    content: state.draft,
    bom: state.bom,
    draftRevision: state.draftRevision,
  };
}

/** Error thrown by a workspace write transport for a non-2xx answer. */
export class WorkspaceFileRequestError extends Error {
  readonly code: DocumentErrorCode;
  readonly currentRevision?: FileRevision;
  constructor(code: DocumentErrorCode, message?: string, currentRevision?: FileRevision) {
    super(message ?? code);
    this.name = "WorkspaceFileRequestError";
    this.code = code;
    if (currentRevision) this.currentRevision = currentRevision;
  }
}

/** Map anything a save transport threw to a failure the machine understands. */
export function saveFailureFrom(error: unknown): SaveFailure {
  if (error instanceof WorkspaceFileRequestError) {
    return { code: error.code, message: error.message, ...(error.currentRevision ? { currentRevision: error.currentRevision } : {}) };
  }
  if (error && typeof error === "object" && "code" in error && isWorkspaceFileErrorCode((error as { code: unknown }).code)) {
    const body = error as { code: WorkspaceFileErrorCode; error?: unknown; currentRevision?: unknown };
    return {
      code: body.code,
      ...(typeof body.error === "string" ? { message: body.error } : {}),
      ...(typeof body.currentRevision === "string" ? { currentRevision: body.currentRevision as FileRevision } : {}),
    };
  }
  if (error instanceof TypeError) return { code: "network", message: error.message };
  return { code: "unknown", ...(error instanceof Error ? { message: error.message } : {}) };
}

export interface DocumentSessionStore {
  getState(): DocumentSessionState;
  subscribe(listener: () => void): () => void;
  /** Apply a transition. Listeners run only when the state object changed. */
  update(transition: (state: DocumentSessionState) => DocumentSessionState): DocumentSessionState;
}

export function createDocumentSessionStore(initial: DocumentSessionState): DocumentSessionStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(transition) {
      const next = transition(state);
      if (next !== state) {
        state = next;
        // Copy first: a listener may subscribe another listener while running.
        for (const listener of Array.from(listeners)) listener();
      }
      return state;
    },
  };
}
