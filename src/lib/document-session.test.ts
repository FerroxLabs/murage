// F4-T2: DocumentSession save state machine. Every race here is one the
// workspace editor design names; each test observes the draft, the saved base
// and the write request, not a status label alone.
import { describe, expect, it } from "vitest";
import type { FileRevision, SaveReceipt, WorkspaceReadResult } from "../../shared/workspace-files";
import {
  SUPERSEDED_REVISIONS_KEPT,
  WorkspaceFileRequestError,
  acknowledgeSave,
  beginSave,
  closeDocument,
  createDocumentSessionStore,
  discardDraft,
  documentKey,
  editDocument,
  failSave,
  hasUnsavedChanges,
  observeExternalChange,
  openDocumentSession,
  resolveConflict,
  restoreDraft,
  saveCopyRequest,
  saveFailureFrom,
  type DocumentSessionState,
} from "./document-session";

const rev = (name: string) => `rev-${name}-00000000` as FileRevision;

function read(over: Partial<WorkspaceReadResult> = {}): WorkspaceReadResult {
  return {
    scope: { botId: "bot-a", threadId: "thread-1" },
    relativePath: "outputs/report.md",
    revision: rev("r0"),
    encoding: "utf-8",
    bom: false,
    newline: "lf",
    bytes: 8,
    modifiedAt: 1,
    content: "# Report",
    ...over,
  };
}

function receiptFor(state: DocumentSessionState, over: Partial<SaveReceipt> = {}): SaveReceipt {
  const pending = state.saving!;
  return {
    requestId: pending.requestId,
    scope: { ...state.identity.scope },
    relativePath: state.identity.relativePath,
    previousRevision: pending.baseRevision,
    revision: rev("r1"),
    bytes: pending.content.length,
    savedAt: 1_000,
    draftRevision: pending.draftRevision,
    ...over,
  };
}

function startSave(state: DocumentSessionState, requestId = "req-1") {
  const begun = beginSave(state, requestId);
  if (!begun.ok) throw new Error(`save refused: ${begun.refused}`);
  return begun;
}

describe("opening and editing", () => {
  it("opens clean in Source mode and a no-op edit is not a revision", () => {
    const state = openDocumentSession(read());
    expect(state).toMatchObject({ status: "clean", mode: "source", draft: "# Report", draftRevision: 0, baseRevision: rev("r0") });
    expect(editDocument(state, "# Report")).toBe(state);
  });

  it("goes dirty on an edit and clean again when the edit is undone", () => {
    const dirty = editDocument(openDocumentSession(read()), "# Report!");
    expect(dirty).toMatchObject({ status: "dirty", draftRevision: 1 });
    expect(hasUnsavedChanges(dirty)).toBe(true);
    const back = editDocument(dirty, "# Report");
    expect(back).toMatchObject({ status: "clean", draftRevision: 2 });
  });

  it("keys a document by scope and relative path", () => {
    const a = openDocumentSession(read()).identity;
    const b = openDocumentSession(read({ scope: { botId: "bot-a", threadId: "thread-2" } })).identity;
    expect(documentKey(a)).not.toBe(documentKey(b));
    expect(documentKey(a)).toBe(documentKey({ scope: { botId: "bot-a", threadId: "thread-1" }, relativePath: "outputs/report.md" }));
  });
});

describe("beginSave", () => {
  it("never produces a write for a document that was only viewed", () => {
    const state = openDocumentSession(read());
    expect(beginSave(state, "req-1")).toEqual({ ok: false, state, refused: "unchanged" });
  });

  it("captures the draft, draft revision, base revision, identity and BOM before the request leaves", () => {
    const state = editDocument(openDocumentSession(read({ bom: true })), "# Report\n\nbody");
    const begun = startSave(state);
    expect(begun.request).toEqual({
      scope: { botId: "bot-a", threadId: "thread-1" },
      relativePath: "outputs/report.md",
      baseRevision: rev("r0"),
      requestId: "req-1",
      content: "# Report\n\nbody",
      bom: true,
      draftRevision: 1,
    });
    expect(begun.state).toMatchObject({ status: "saving", saving: { requestId: "req-1", draftRevision: 1, baseRevision: rev("r0") } });
    // The request is a copy: later typing cannot change what was submitted.
    const typed = editDocument(begun.state, "# Report\n\nbody more");
    expect(begun.request.content).toBe("# Report\n\nbody");
    expect(typed.saving?.content).toBe("# Report\n\nbody");
  });

  it("refuses a second save in flight, a save during conflict, a closed document and an oversized draft", () => {
    const saving = startSave(editDocument(openDocumentSession(read()), "x")).state;
    expect(beginSave(editDocument(saving, "xy"), "req-2")).toMatchObject({ ok: false, refused: "in-flight" });
    const conflict = observeExternalChange(editDocument(openDocumentSession(read()), "mine"), { revision: rev("r9"), content: "theirs", bom: false }).state;
    expect(beginSave(conflict, "req-2")).toMatchObject({ ok: false, refused: "conflict" });
    expect(beginSave(closeDocument(editDocument(openDocumentSession(read()), "x")), "req-2")).toMatchObject({ ok: false, refused: "closed" });
    const huge = editDocument(openDocumentSession(read()), "a".repeat(2 * 1024 * 1024 + 1));
    expect(beginSave(huge, "req-2")).toMatchObject({ ok: false, refused: "too-large" });
  });
});

describe("acknowledgements", () => {
  it("marks only the submitted draft saved when typing continued during the request", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "# Report v1"));
    const typing = editDocument(begun.state, "# Report v1 and more");
    const acked = acknowledgeSave(typing, receiptFor(typing, { artifactId: "art-1" }));
    expect(acked.outcome).toBe("saved");
    expect(acked.state).toMatchObject({
      status: "dirty",
      draft: "# Report v1 and more",
      savedContent: "# Report v1",
      baseRevision: rev("r1"),
      savedDraftRevision: 1,
      draftRevision: 2,
      saving: null,
      lastSave: { requestId: "req-1", revision: rev("r1"), draftRevision: 1, savedAt: 1_000, artifactId: "art-1" },
    });
    // The next save is conditioned on the acknowledged revision.
    expect(startSave(acked.state, "req-2").request).toMatchObject({ baseRevision: rev("r1"), draftRevision: 2, content: "# Report v1 and more" });
  });

  it("goes clean when nothing was typed during the request", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "# Report v1"));
    expect(acknowledgeSave(begun.state, receiptFor(begun.state)).state).toMatchObject({ status: "clean", savedContent: "# Report v1", baseRevision: rev("r1") });
  });

  it("ignores a late receipt for another request, another tab or another draft revision", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"), "req-2");
    const other = openDocumentSession(read({ relativePath: "outputs/other.md" }));
    const otherBegun = startSave(editDocument(other, "other"), "req-2");
    for (const receipt of [
      receiptFor(begun.state, { requestId: "req-1" }),
      receiptFor(begun.state, { scope: { botId: "bot-a", threadId: "thread-2" } }),
      receiptFor(begun.state, { relativePath: "outputs/other.md" }),
      receiptFor(begun.state, { draftRevision: 0 }),
      // Same request id, but it belongs to the other document's tab.
      receiptFor(otherBegun.state),
    ]) {
      const result = acknowledgeSave(begun.state, receipt);
      expect(result.outcome).toBe("ignored");
      expect(result.state).toBe(begun.state);
    }
    expect(acknowledgeSave(openDocumentSession(read()), receiptFor(begun.state)).outcome).toBe("ignored");
  });

  it("still settles a pending save after the tab closed, and nothing more", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
    const closed = closeDocument(begun.state);
    const acked = acknowledgeSave(closed, receiptFor(closed));
    expect(acked.state).toMatchObject({ closed: true, status: "clean", baseRevision: rev("r1") });
    expect(editDocument(acked.state, "more")).toBe(acked.state);
  });
});

describe("failures", () => {
  it("keeps the draft and never announces success", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
    const failed = failSave(begun.state, "req-1", { code: "write-failed", message: "disk full" });
    expect(failed.outcome).toBe("failed");
    expect(failed.state).toMatchObject({
      status: "error",
      draft: "mine",
      savedContent: "# Report",
      baseRevision: rev("r0"),
      lastSave: null,
      error: { code: "write-failed", message: "disk full", retryable: true },
    });
    expect(failSave(begun.state, "req-other", { code: "write-failed" }).outcome).toBe("ignored");
    // A retry is allowed and conditioned on the unchanged base.
    expect(startSave(failed.state, "req-2").request.baseRevision).toBe(rev("r0"));
    expect(failSave(startSave(editDocument(openDocumentSession(read()), "x")).state, "req-1", { code: "private-file" }).state.error)
      .toEqual({ code: "private-file", retryable: false });
  });

  it("turns a revision conflict into a conflict that needs the disk text before it can be resolved", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
    const rejected = failSave(begun.state, "req-1", { code: "revision-conflict", currentRevision: rev("r5") });
    expect(rejected).toMatchObject({ outcome: "conflict", effect: "conflict" });
    expect(rejected.state).toMatchObject({ status: "conflict", draft: "mine", conflict: { source: "save-rejected", currentRevision: rev("r5"), disk: null } });
    expect(resolveConflict(rejected.state, "reload")).toMatchObject({ ok: false, refused: "needs-disk-read" });
    const withDisk = observeExternalChange(rejected.state, { revision: rev("r5"), content: "theirs", bom: false });
    expect(withDisk.state).toMatchObject({ status: "conflict", draft: "mine", conflict: { source: "save-rejected", disk: { content: "theirs" } } });
  });

  it("adopts the disk when an unknown-outcome save turns out to have committed", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
    const failed = failSave(begun.state, "req-1", { code: "network" }).state;
    const observed = observeExternalChange(failed, { revision: rev("r1"), content: "mine", bom: false });
    expect(observed).toMatchObject({ effect: "none", state: { status: "clean", baseRevision: rev("r1"), savedContent: "mine", error: null } });
  });
});

describe("external changes", () => {
  it("reloads without an edit while clean", () => {
    const state = openDocumentSession(read());
    const changed = observeExternalChange(state, { revision: rev("r2"), content: "# Report by bot", bom: false, newline: "lf" });
    expect(changed.effect).toBe("reload");
    expect(changed.state).toMatchObject({ status: "clean", draft: "# Report by bot", savedContent: "# Report by bot", baseRevision: rev("r2") });
    expect(beginSave(changed.state, "req-1")).toMatchObject({ ok: false, refused: "unchanged" });
    expect(observeExternalChange(state, { revision: rev("r0"), content: "# Report", bom: false })).toEqual({ state, effect: "none" });
  });

  it("raises a conflict that keeps both texts while dirty; there is no last-writer-wins", () => {
    const dirty = editDocument(openDocumentSession(read()), "mine");
    const changed = observeExternalChange(dirty, { revision: rev("r2"), content: "theirs", bom: false });
    expect(changed.effect).toBe("conflict");
    expect(changed.state).toMatchObject({
      status: "conflict",
      draft: "mine",
      savedContent: "# Report",
      baseRevision: rev("r0"),
      conflict: { source: "external-change", currentRevision: rev("r2"), disk: { content: "theirs" } },
    });
    // Typing continues in conflict; saving waits for an explicit choice.
    const typed = editDocument(changed.state, "mine, still");
    expect(beginSave(typed, "req-1")).toMatchObject({ ok: false, refused: "conflict" });

    const reloaded = resolveConflict(typed, "reload");
    expect(reloaded).toMatchObject({ ok: true, effect: "reload", state: { status: "clean", draft: "theirs", baseRevision: rev("r2") } });

    const kept = resolveConflict(typed, "keep-mine");
    expect(kept).toMatchObject({ ok: true, effect: "none", state: { status: "dirty", draft: "mine, still", savedContent: "theirs", baseRevision: rev("r2") } });
    if (!kept.ok) throw new Error("unreachable");
    expect(startSave(kept.state).request).toMatchObject({ baseRevision: rev("r2"), content: "mine, still" });
    expect(resolveConflict(dirty, "reload")).toMatchObject({ ok: false, refused: "no-conflict" });
  });

  it("defers a change seen during a save and settles it against the new base", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
    const during = observeExternalChange(begun.state, { revision: rev("r3"), content: "bot wrote after us", bom: false });
    expect(during.effect).toBe("deferred");
    expect(during.state.draft).toBe("mine");
    const acked = acknowledgeSave(during.state, receiptFor(during.state));
    // The save landed (r1); the bot's later write (r3) replaces a clean doc.
    expect(acked).toMatchObject({ outcome: "saved", effect: "reload", state: { status: "clean", draft: "bot wrote after us", baseRevision: rev("r3") } });
  });

  it("turns a change seen during a save into a conflict when typing continued", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
    const typing = editDocument(begun.state, "mine and more");
    const during = observeExternalChange(typing, { revision: rev("r3"), content: "bot wrote after us", bom: false }).state;
    const acked = acknowledgeSave(during, receiptFor(during));
    expect(acked).toMatchObject({ outcome: "saved", effect: "conflict", state: { status: "conflict", draft: "mine and more", savedContent: "mine", baseRevision: rev("r1") } });
  });

  it("ignores a stale watch read of the replaced revision or of the write itself", () => {
    for (const stale of [
      { revision: rev("r0"), content: "# Report", bom: false },
      { revision: rev("r1"), content: "mine", bom: false },
    ]) {
      const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
      const during = observeExternalChange(begun.state, stale).state;
      const acked = acknowledgeSave(during, receiptFor(during));
      expect(acked).toMatchObject({ effect: "none", state: { status: "clean", draft: "mine", savedContent: "mine", baseRevision: rev("r1"), pendingExternal: null } });
    }
  });

  // Regression (fix round 1): the same stale read arriving just after the
  // receipt used to reload the pre-save text and move the base back to the
  // dead revision, so the next save was rejected and "keep mine" overwrote it.
  it("ignores the replaced revision when its stale read lands after the receipt", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
    const acked = acknowledgeSave(begun.state, receiptFor(begun.state)).state;
    const late = observeExternalChange(acked, { revision: rev("r0"), content: "# Report", bom: false });
    expect(late.effect).toBe("none");
    expect(late.state).toBe(acked);
    expect(late.state).toMatchObject({ status: "clean", draft: "mine", savedContent: "mine", baseRevision: rev("r1"), lastSave: { revision: rev("r1") } });
    // The next save stays conditioned on the revision this session wrote.
    expect(startSave(editDocument(late.state, "mine 2"), "req-2").request.baseRevision).toBe(rev("r1"));
    // While dirty the same stale read is not a conflict either.
    expect(observeExternalChange(editDocument(late.state, "mine 2"), { revision: rev("r0"), content: "# Report", bom: false }).effect).toBe("none");
    // A genuinely new revision still reloads, and "File saved" no longer
    // describes what is on screen.
    expect(observeExternalChange(acked, { revision: rev("r5"), content: "theirs", bom: false })).toMatchObject({ effect: "reload", state: { draft: "theirs", baseRevision: rev("r5"), lastSave: null } });
  });

  it("ignores a late read of a revision left behind by a reload or a conflict choice", () => {
    const reloaded = observeExternalChange(openDocumentSession(read()), { revision: rev("r2"), content: "theirs", bom: false }).state;
    expect(observeExternalChange(reloaded, { revision: rev("r0"), content: "# Report", bom: false })).toMatchObject({ effect: "none", state: { draft: "theirs", baseRevision: rev("r2") } });
    const conflicted = observeExternalChange(editDocument(reloaded, "mine"), { revision: rev("r3"), content: "newer", bom: false }).state;
    const kept = resolveConflict(conflicted, "keep-mine");
    if (!kept.ok) throw new Error("keep-mine refused");
    for (const stale of [rev("r0"), rev("r2")]) {
      expect(observeExternalChange(kept.state, { revision: stale, content: "old", bom: false })).toMatchObject({ effect: "none", state: { status: "dirty", draft: "mine", baseRevision: rev("r3"), conflict: null } });
    }
  });

  it("remembers a bounded number of superseded revisions", () => {
    let state = openDocumentSession(read());
    for (let index = 1; index <= SUPERSEDED_REVISIONS_KEPT + 5; index += 1) {
      state = observeExternalChange(state, { revision: rev(`x${index}`), content: `v${index}`, bom: false }).state;
    }
    expect(state.supersededRevisions).toHaveLength(SUPERSEDED_REVISIONS_KEPT);
    expect(state.supersededRevisions.at(-1)).toBe(rev(`x${SUPERSEDED_REVISIONS_KEPT + 4}`));
    expect(state.supersededRevisions).not.toContain(state.baseRevision);
  });

  it("fills a rejected save's conflict from a read that shows the base revision", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
    const rejected = failSave(begun.state, "req-1", { code: "revision-conflict" }).state;
    expect(rejected.conflict).toMatchObject({ source: "save-rejected", disk: null });
    const filled = observeExternalChange(rejected, { revision: rev("r0"), content: "# Report", bom: false });
    expect(filled).toMatchObject({ effect: "conflict", state: { draft: "mine", conflict: { currentRevision: rev("r0"), disk: { content: "# Report" } } } });
    expect(resolveConflict(filled.state, "keep-mine").ok).toBe(true);
  });

  it("settles a change deferred behind a failed save", () => {
    const begun = startSave(editDocument(openDocumentSession(read()), "mine"));
    const during = observeExternalChange(begun.state, { revision: rev("r4"), content: "theirs", bom: false }).state;
    const failed = failSave(during, "req-1", { code: "bot-writing" });
    expect(failed).toMatchObject({ outcome: "failed", effect: "conflict", state: { status: "conflict", draft: "mine", conflict: { disk: { content: "theirs" } } } });
    const rejected = failSave(during, "req-1", { code: "revision-conflict" });
    expect(rejected.state.conflict).toMatchObject({ source: "save-rejected", currentRevision: rev("r4"), disk: { content: "theirs" } });
  });

  it("ignores changes after close", () => {
    const closed = closeDocument(openDocumentSession(read()));
    expect(observeExternalChange(closed, { revision: rev("r9"), content: "x", bom: false }).state).toBe(closed);
  });
});

describe("drafts, discard and copies", () => {
  it("restores a preserved draft on the same base as a dirty document", () => {
    const restored = restoreDraft(openDocumentSession(read()), { baseRevision: rev("r0"), content: "draft", draftRevision: 7, mode: "rich" });
    expect(restored).toMatchObject({ restored: true, effect: "reload", state: { status: "dirty", draft: "draft", draftRevision: 8, mode: "rich", savedContent: "# Report" } });
  });

  it("restores a draft based on an older revision as a conflict holding both", () => {
    const restored = restoreDraft(openDocumentSession(read({ revision: rev("r6"), content: "newer disk" })), { baseRevision: rev("r0"), content: "old draft", draftRevision: 3 });
    expect(restored.state).toMatchObject({
      status: "conflict",
      draft: "old draft",
      conflict: { source: "draft-restore", currentRevision: rev("r6"), disk: { content: "newer disk", revision: rev("r6") } },
    });
  });

  it("does not restore over unsaved work or a draft equal to disk", () => {
    const dirty = editDocument(openDocumentSession(read()), "typing");
    expect(restoreDraft(dirty, { baseRevision: rev("r0"), content: "draft", draftRevision: 1 })).toMatchObject({ restored: false, state: dirty });
    const clean = openDocumentSession(read());
    expect(restoreDraft(clean, { baseRevision: rev("r0"), content: "# Report", draftRevision: 1 }).restored).toBe(false);
  });

  it("discards back to the saved text, but not while a save is in flight or in conflict", () => {
    const dirty = editDocument(openDocumentSession(read()), "typing");
    expect(discardDraft(dirty)).toMatchObject({ ok: true, effect: "reload", state: { status: "clean", draft: "# Report" } });
    expect(discardDraft(startSave(dirty).state)).toMatchObject({ ok: false, effect: "none" });
  });

  it("builds an exclusive-create copy request without settling the session", () => {
    const dirty = editDocument(openDocumentSession(read({ bom: true })), "typing");
    expect(saveCopyRequest(dirty, "outputs/report copy.md", "copy-1")).toEqual({
      scope: { botId: "bot-a", threadId: "thread-1" },
      relativePath: "outputs/report copy.md",
      baseRevision: null,
      requestId: "copy-1",
      content: "typing",
      bom: true,
      draftRevision: 1,
    });
  });
});

describe("transport errors and store", () => {
  it("maps transport errors and error bodies to failures", () => {
    expect(saveFailureFrom(new WorkspaceFileRequestError("revision-conflict", "changed", rev("r2")))).toEqual({ code: "revision-conflict", message: "changed", currentRevision: rev("r2") });
    expect(saveFailureFrom({ code: "bot-writing", error: "Bot is writing" })).toEqual({ code: "bot-writing", message: "Bot is writing" });
    expect(saveFailureFrom({ code: "made-up" })).toEqual({ code: "unknown" });
    expect(saveFailureFrom(new TypeError("Failed to fetch"))).toEqual({ code: "network", message: "Failed to fetch" });
    expect(saveFailureFrom(new Error("boom"))).toEqual({ code: "unknown", message: "boom" });
  });

  it("notifies subscribers only when the state object changes", () => {
    const store = createDocumentSessionStore(openDocumentSession(read()));
    let calls = 0;
    const unsubscribe = store.subscribe(() => { calls += 1; });
    store.update(state => editDocument(state, "# Report"));
    expect(calls).toBe(0);
    store.update(state => editDocument(state, "changed"));
    expect(calls).toBe(1);
    expect(store.getState().draft).toBe("changed");
    unsubscribe();
    store.update(state => editDocument(state, "again"));
    expect(calls).toBe(1);
  });
});
